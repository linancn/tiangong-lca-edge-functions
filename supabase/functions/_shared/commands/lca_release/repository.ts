import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import type { ActorContext } from '../../command_runtime/actor_context.ts';
import type { CommandAuditPayload } from '../../command_runtime/audit_log.ts';
import {
  callCurrentLcaReleaseRpc,
  callLcaReleaseApproveRpc,
  callLcaReleaseArtifactDownloadRpc,
  callLcaReleaseFinalizeArtifactsRpc,
  callLcaReleaseManagerAssertionRpc,
  callLcaReleasePrepareRpc,
  callLcaReleasePublishRpc,
  callLcaReleaseReadbackVerifyRpc,
  callLcaReleaseRunRpc,
  callLcaReleaseUnpublishRpc,
  callLciaResultCalculationBundleRpc,
  type LcaReleaseRpcClient,
  type LcaReleaseRpcResult,
} from '../../db_rpc/lca_release_commands.ts';
import { createSupabaseServiceClient } from '../../supabase_client.ts';
import type {
  LcaReleaseApproveRequest,
  LcaReleaseArtifactInput,
  LcaReleaseCommandFailure,
  LcaReleaseCreateArtifactUploadsRequest,
  LcaReleaseFinalizeArtifactsRequest,
  LcaReleasePrepareRequest,
  LcaReleasePublishRequest,
  LcaReleaseReadbackVerifyRequest,
  LcaReleaseUnpublishRequest,
  LcaReleaseUploadedArtifact,
} from './types.ts';

export const LCA_RELEASE_MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
export const LCA_RELEASE_SIGNED_URL_EXPIRES_IN_SECONDS = 15 * 60;
const DEFAULT_RELEASE_STORAGE_BUCKET = 'lca_results';
const RELEASE_STORAGE_PREFIX = 'lca-releases/v1';

export type LcaReleaseArtifactUpload = LcaReleaseUploadedArtifact & {
  token: string;
  signedUploadUrl: string | null;
};

export type LcaReleaseCommandRepository = {
  assertManager: () => Promise<LcaReleaseRpcResult>;
  prepare: (
    request: LcaReleasePrepareRequest,
    audit: CommandAuditPayload,
  ) => Promise<LcaReleaseRpcResult>;
  getRun: (releaseRunId: string) => Promise<LcaReleaseRpcResult>;
  getCurrent: () => Promise<LcaReleaseRpcResult>;
  createArtifactUploads: (
    request: LcaReleaseCreateArtifactUploadsRequest,
  ) => Promise<{ ok: true; data: LcaReleaseArtifactUpload[] } | LcaReleaseCommandFailure>;
  verifyArtifacts: (
    request: LcaReleaseFinalizeArtifactsRequest,
  ) => Promise<{ ok: true; data: LcaReleaseUploadedArtifact[] } | LcaReleaseCommandFailure>;
  finalizeArtifacts: (
    request: LcaReleaseFinalizeArtifactsRequest,
    audit: Record<string, unknown>,
  ) => Promise<LcaReleaseRpcResult>;
  approve: (
    request: LcaReleaseApproveRequest,
    audit: CommandAuditPayload,
  ) => Promise<LcaReleaseRpcResult>;
  publish: (
    request: LcaReleasePublishRequest,
    audit: CommandAuditPayload,
  ) => Promise<LcaReleaseRpcResult>;
  readbackVerify: (
    request: LcaReleaseReadbackVerifyRequest,
    audit: CommandAuditPayload,
  ) => Promise<LcaReleaseRpcResult>;
  unpublish: (
    request: LcaReleaseUnpublishRequest,
    audit: CommandAuditPayload,
  ) => Promise<LcaReleaseRpcResult>;
  getCalculationBundle: (packageId: string) => Promise<LcaReleaseRpcResult>;
  createArtifactDownload: (artifactId: string) => Promise<LcaReleaseRpcResult>;
};

function failure(
  code: string,
  status: number,
  message: string,
  details?: unknown,
): LcaReleaseCommandFailure {
  return {
    ok: false,
    code,
    status,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function resolveLcaReleaseStorageBucket(): string {
  try {
    const configured = Deno.env.get('LCA_RELEASE_STORAGE_BUCKET')?.trim();
    if (configured) {
      return configured;
    }
    const shared = Deno.env.get('S3_BUCKET')?.trim();
    return shared || DEFAULT_RELEASE_STORAGE_BUCKET;
  } catch (_error) {
    return DEFAULT_RELEASE_STORAGE_BUCKET;
  }
}

export function lcaReleaseObjectKey(
  releaseRunId: string,
  publishPlanHash: string,
  artifact: LcaReleaseArtifactInput,
): string {
  return [
    RELEASE_STORAGE_PREFIX,
    releaseRunId,
    publishPlanHash,
    artifact.profileId,
    artifact.format,
    `${artifact.sha256}.zip`,
  ].join('/');
}

export async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createArtifactUploads(
  serviceSupabase: SupabaseClient,
  request: LcaReleaseCreateArtifactUploadsRequest,
): Promise<{ ok: true; data: LcaReleaseArtifactUpload[] } | LcaReleaseCommandFailure> {
  const bucket = resolveLcaReleaseStorageBucket();
  const uploads: LcaReleaseArtifactUpload[] = [];

  for (const artifact of request.artifacts) {
    const objectKey = lcaReleaseObjectKey(request.releaseRunId, request.publishPlanHash, artifact);
    const { data, error } = await serviceSupabase.storage
      .from(bucket)
      .createSignedUploadUrl(objectKey);
    if (error || !data?.token || !data.path) {
      return failure(
        'release_signed_upload_create_failed',
        502,
        'Failed to create a signed upload URL for a release artifact',
        {
          profileId: artifact.profileId,
          format: artifact.format,
          detail: error?.message ?? 'Signed upload response was incomplete',
        },
      );
    }
    if (data.path !== objectKey) {
      return failure(
        'release_signed_upload_path_mismatch',
        502,
        'Storage returned a signed upload path that differs from the canonical object key',
        { expected: objectKey, actual: data.path },
      );
    }
    uploads.push({
      ...artifact,
      storageBucket: bucket,
      objectKey,
      token: data.token,
      signedUploadUrl: data.signedUrl ?? null,
    });
  }

  return { ok: true, data: uploads };
}

async function verifyArtifacts(
  serviceSupabase: SupabaseClient,
  request: LcaReleaseFinalizeArtifactsRequest,
): Promise<{ ok: true; data: LcaReleaseUploadedArtifact[] } | LcaReleaseCommandFailure> {
  const bucket = resolveLcaReleaseStorageBucket();

  for (const artifact of request.artifacts) {
    const expectedObjectKey = lcaReleaseObjectKey(
      request.releaseRunId,
      request.publishPlanHash,
      artifact,
    );
    if (artifact.storageBucket !== bucket || artifact.objectKey !== expectedObjectKey) {
      return failure(
        'release_artifact_storage_ref_invalid',
        400,
        'Release artifact storage refs must match the canonical signed-upload destination',
        {
          profileId: artifact.profileId,
          format: artifact.format,
          expectedStorageBucket: bucket,
          expectedObjectKey,
        },
      );
    }

    const { data, error } = await serviceSupabase.storage.from(bucket).download(expectedObjectKey);
    if (error || !data) {
      return failure(
        'release_artifact_download_failed',
        502,
        'Failed to read an uploaded release artifact for verification',
        {
          profileId: artifact.profileId,
          format: artifact.format,
          detail: error?.message ?? 'Storage returned no artifact bytes',
        },
      );
    }
    if (data.size > LCA_RELEASE_MAX_ARTIFACT_BYTES || data.size !== artifact.byteSize) {
      return failure(
        'release_artifact_size_mismatch',
        409,
        'Uploaded release artifact byte size differs from the immutable manifest',
        {
          profileId: artifact.profileId,
          format: artifact.format,
          expected: artifact.byteSize,
          actual: data.size,
          maximum: LCA_RELEASE_MAX_ARTIFACT_BYTES,
        },
      );
    }
    const observedSha256 = await sha256Blob(data);
    if (observedSha256 !== artifact.sha256) {
      return failure(
        'release_artifact_hash_mismatch',
        409,
        'Uploaded release artifact SHA-256 differs from the immutable manifest',
        {
          profileId: artifact.profileId,
          format: artifact.format,
          expected: artifact.sha256,
          actual: observedSha256,
        },
      );
    }
  }

  return { ok: true, data: request.artifacts };
}

async function createArtifactDownload(
  actorSupabase: LcaReleaseRpcClient,
  serviceSupabase: SupabaseClient,
  artifactId: string,
): Promise<LcaReleaseRpcResult> {
  const metadata = await callLcaReleaseArtifactDownloadRpc(actorSupabase, artifactId);
  if (!metadata.ok) {
    return metadata;
  }
  const value = recordValue(metadata.data);
  const bucket = stringValue(value?.storageBucket);
  const objectKey = stringValue(value?.objectKey);
  if (!value || !bucket || !objectKey) {
    return failure(
      'release_artifact_storage_ref_missing',
      502,
      'Release artifact metadata does not contain a storage ref',
      metadata.data,
    );
  }
  const { data, error } = await serviceSupabase.storage
    .from(bucket)
    .createSignedUrl(objectKey, LCA_RELEASE_SIGNED_URL_EXPIRES_IN_SECONDS);
  if (error || !data?.signedUrl) {
    return failure(
      'release_artifact_signed_download_failed',
      502,
      'Failed to create a signed download URL for the release artifact',
      error?.message ?? null,
    );
  }
  return {
    ok: true,
    data: {
      ...value,
      signedDownloadUrl: data.signedUrl,
      signedDownloadExpiresInSeconds: LCA_RELEASE_SIGNED_URL_EXPIRES_IN_SECONDS,
    },
  };
}

function requireExplicitActorClient(client: LcaReleaseRpcClient | null | undefined) {
  if (!client || typeof client.rpc !== 'function') {
    throw new Error('LCA release repository requires an explicit actor Supabase client');
  }
  return client;
}

export function createLcaReleaseCommandRepository(
  actorSupabase: LcaReleaseRpcClient,
  serviceSupabase: SupabaseClient = createSupabaseServiceClient(),
): LcaReleaseCommandRepository {
  const actorClient = requireExplicitActorClient(actorSupabase);
  return {
    assertManager: () => callLcaReleaseManagerAssertionRpc(actorClient),
    prepare: (request, audit) => callLcaReleasePrepareRpc(actorClient, request, audit),
    getRun: (releaseRunId) => callLcaReleaseRunRpc(actorClient, releaseRunId),
    getCurrent: () => callCurrentLcaReleaseRpc(actorClient),
    createArtifactUploads: (request) => createArtifactUploads(serviceSupabase, request),
    verifyArtifacts: (request) => verifyArtifacts(serviceSupabase, request),
    finalizeArtifacts: (request, audit) =>
      callLcaReleaseFinalizeArtifactsRpc(serviceSupabase, request, audit),
    approve: (request, audit) => callLcaReleaseApproveRpc(actorClient, request, audit),
    publish: (request, audit) => callLcaReleasePublishRpc(actorClient, request, audit),
    readbackVerify: (request, audit) =>
      callLcaReleaseReadbackVerifyRpc(actorClient, request, audit),
    unpublish: (request, audit) => callLcaReleaseUnpublishRpc(actorClient, request, audit),
    getCalculationBundle: (packageId) => callLciaResultCalculationBundleRpc(actorClient, packageId),
    createArtifactDownload: (artifactId) =>
      createArtifactDownload(actorClient, serviceSupabase, artifactId),
  };
}

export function createPublicLcaReleaseRepository(
  serviceSupabase: SupabaseClient = createSupabaseServiceClient(),
): Pick<LcaReleaseCommandRepository, 'getRun' | 'getCurrent' | 'createArtifactDownload'> {
  return {
    getRun: (releaseRunId) => callLcaReleaseRunRpc(serviceSupabase, releaseRunId),
    getCurrent: () => callCurrentLcaReleaseRpc(serviceSupabase),
    createArtifactDownload: (artifactId) =>
      createArtifactDownload(serviceSupabase, serviceSupabase, artifactId),
  };
}

export function lcaReleaseRepositoryForActor(
  actor: ActorContext,
  serviceSupabase?: SupabaseClient,
) {
  return createLcaReleaseCommandRepository(actor.supabase, serviceSupabase);
}
