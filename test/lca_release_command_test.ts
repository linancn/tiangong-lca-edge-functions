import { assertEquals, assertMatch, assertThrows } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import {
  executeLcaReleaseCommand,
  lcaReleaseCommandRequestSchema,
} from '../supabase/functions/_shared/commands/lca_release/command.ts';
import {
  createLcaReleaseCommandRepository,
  lcaReleaseObjectKey,
  sha256Blob,
} from '../supabase/functions/_shared/commands/lca_release/repository.ts';
import type {
  LcaReleaseArtifactInput,
  LcaReleaseFinalizeArtifactsRequest,
} from '../supabase/functions/_shared/commands/lca_release/types.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RELEASE_RUN_ID = '22222222-2222-4222-8222-222222222222';
const PACKAGE_ID = '33333333-3333-4333-8333-333333333333';
const PLAN_HASH = 'a'.repeat(64);
const MANIFEST_HASH = 'b'.repeat(64);
const ARTIFACT_ID = '44444444-4444-4444-8444-444444444444';
const PACKAGE_BYTES = new TextEncoder().encode('deterministic release package');

type RpcResponse = { data: unknown; error: unknown };

class FakeSupabase {
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  rpcResults = new Map<string, RpcResponse>();
  signedUploadCalls: Array<{ bucket: string; objectKey: string; upsert: boolean }> = [];
  signedDownloadCalls: Array<{
    bucket: string;
    objectKey: string;
    expiresIn: number;
    download?: string | boolean;
  }> = [];
  downloadedObjects = new Map<string, Blob>();
  storageError: { message: string } | null = null;

  rpc(fn: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ fn, args: structuredClone(args) });
    return Promise.resolve(structuredClone(this.rpcResults.get(fn) ?? { data: null, error: null }));
  }

  storage = {
    from: (bucket: string) => ({
      createSignedUploadUrl: async (objectKey: string, options?: { upsert?: boolean }) => {
        this.signedUploadCalls.push({
          bucket,
          objectKey,
          upsert: options?.upsert === true,
        });
        if (this.storageError) return { data: null, error: this.storageError };
        return {
          data: {
            path: objectKey,
            token: `token:${objectKey}`,
            signedUrl: `https://upload.example/${bucket}/${objectKey}`,
          },
          error: null,
        };
      },
      download: async (objectKey: string) => {
        if (this.storageError) return { data: null, error: this.storageError };
        const data = this.downloadedObjects.get(`${bucket}/${objectKey}`);
        return data
          ? { data, error: null }
          : { data: null, error: { message: 'Object not found' } };
      },
      createSignedUrl: async (
        objectKey: string,
        expiresIn: number,
        options?: { download?: string | boolean },
      ) => {
        this.signedDownloadCalls.push({
          bucket,
          objectKey,
          expiresIn,
          ...(options?.download === undefined ? {} : { download: options.download }),
        });
        if (this.storageError) return { data: null, error: this.storageError };
        return {
          data: {
            signedUrl: `https://download.example/${bucket}/${objectKey}`,
          },
          error: null,
        };
      },
    }),
  };
}

function rpcSuccess(data: unknown): RpcResponse {
  return { data: { ok: true, data }, error: null };
}

function actorFor(supabase: FakeSupabase) {
  return {
    userId: USER_ID,
    accessToken: 'actor-access-token',
    supabase: supabase as unknown as SupabaseClient,
  };
}

function artifacts(sha256: string, byteSize: number): LcaReleaseArtifactInput[] {
  return [
    {
      profileId: 'unit-process-full-closure.v1',
      format: 'tidas',
      sha256,
      byteSize,
      mediaType: 'application/zip',
    },
    {
      profileId: 'unit-process-full-closure.v1',
      format: 'ilcd',
      sha256,
      byteSize,
      mediaType: 'application/zip',
    },
    {
      profileId: 'standalone-lifecyclemodel-result-full-closure.v1',
      format: 'tidas',
      sha256,
      byteSize,
      mediaType: 'application/zip',
    },
    {
      profileId: 'standalone-lifecyclemodel-result-full-closure.v1',
      format: 'ilcd',
      sha256,
      byteSize,
      mediaType: 'application/zip',
    },
  ];
}

Deno.test('lca release command schema requires all four profile and format pairs', () => {
  const valid = artifacts('c'.repeat(64), 123);
  assertEquals(
    lcaReleaseCommandRequestSchema.safeParse({
      action: 'create_artifact_uploads',
      releaseRunId: RELEASE_RUN_ID,
      publishPlanHash: PLAN_HASH,
      artifacts: valid,
    }).success,
    true,
  );

  const duplicate = [valid[0], valid[0], valid[2], valid[3]];
  assertEquals(
    lcaReleaseCommandRequestSchema.safeParse({
      action: 'create_artifact_uploads',
      releaseRunId: RELEASE_RUN_ID,
      publishPlanHash: PLAN_HASH,
      artifacts: duplicate,
    }).success,
    false,
  );
});

Deno.test('lca release command schema rejects oversized artifacts and unknown fields', () => {
  assertEquals(
    lcaReleaseCommandRequestSchema.safeParse({
      action: 'create_artifact_uploads',
      releaseRunId: RELEASE_RUN_ID,
      publishPlanHash: PLAN_HASH,
      artifacts: artifacts('c'.repeat(64), 50 * 1024 * 1024 + 1),
      storageBucket: 'client-selected-bucket',
    }).success,
    false,
  );
});

Deno.test(
  'create artifact uploads enforces actor RPC access and canonical storage paths',
  async () => {
    const actorSupabase = new FakeSupabase();
    const serviceSupabase = new FakeSupabase();
    actorSupabase.rpcResults.set(
      'assert_lca_release_manager',
      rpcSuccess({ userId: USER_ID, role: 'data_product_manager' }),
    );
    actorSupabase.rpcResults.set(
      'get_lca_release_run',
      rpcSuccess({ status: 'prepared', publishPlanHash: PLAN_HASH }),
    );
    const sha256 = await sha256Blob(new Blob([PACKAGE_BYTES]));
    const artifactInputs = artifacts(sha256, PACKAGE_BYTES.byteLength);
    const repository = createLcaReleaseCommandRepository(
      actorSupabase as never,
      serviceSupabase as never,
    );

    const result = await executeLcaReleaseCommand(
      {
        action: 'create_artifact_uploads',
        releaseRunId: RELEASE_RUN_ID,
        publishPlanHash: PLAN_HASH,
        artifacts: artifactInputs,
      },
      actorFor(actorSupabase),
      repository,
    );

    assertEquals(result.ok, true);
    assertEquals(
      actorSupabase.rpcCalls.map((call) => call.fn),
      ['assert_lca_release_manager', 'get_lca_release_run'],
    );
    assertEquals(serviceSupabase.signedUploadCalls.length, 4);
    assertEquals(serviceSupabase.signedUploadCalls[0], {
      bucket: 'lca_results',
      objectKey: lcaReleaseObjectKey(RELEASE_RUN_ID, PLAN_HASH, artifactInputs[0]),
      upsert: true,
    });
    assertMatch(serviceSupabase.signedUploadCalls[0].objectKey, new RegExp(`${sha256}\\.zip$`));
  },
);

Deno.test('create artifact uploads fails closed when actor is not a manager', async () => {
  const actorSupabase = new FakeSupabase();
  const serviceSupabase = new FakeSupabase();
  actorSupabase.rpcResults.set('assert_lca_release_manager', {
    data: {
      ok: false,
      code: 'not_data_product_manager',
      status: 403,
      message: 'Data product manager role is required',
    },
    error: null,
  });
  const result = await executeLcaReleaseCommand(
    {
      action: 'create_artifact_uploads',
      releaseRunId: RELEASE_RUN_ID,
      publishPlanHash: PLAN_HASH,
      artifacts: artifacts('c'.repeat(64), 12),
    },
    actorFor(actorSupabase),
    createLcaReleaseCommandRepository(actorSupabase as never, serviceSupabase as never),
  );

  assertEquals(result, {
    ok: false,
    code: 'not_data_product_manager',
    status: 403,
    message: 'Data product manager role is required',
  });
  assertEquals(serviceSupabase.signedUploadCalls, []);
});

Deno.test(
  'finalize verifies exact bytes and rechecks live actor permission before service RPC',
  async () => {
    const actorSupabase = new FakeSupabase();
    const serviceSupabase = new FakeSupabase();
    actorSupabase.rpcResults.set(
      'assert_lca_release_manager',
      rpcSuccess({ userId: USER_ID, role: 'data_product_manager' }),
    );
    actorSupabase.rpcResults.set(
      'get_lca_release_run',
      rpcSuccess({ status: 'prepared', publishPlanHash: PLAN_HASH }),
    );
    serviceSupabase.rpcResults.set(
      'cmd_lca_release_artifacts_finalize_service',
      rpcSuccess({ status: 'ready_for_approval', artifactCount: 4 }),
    );
    const blob = new Blob([PACKAGE_BYTES]);
    const sha256 = await sha256Blob(blob);
    const uploaded = artifacts(sha256, blob.size).map((artifact) => ({
      ...artifact,
      storageBucket: 'lca_results',
      objectKey: lcaReleaseObjectKey(RELEASE_RUN_ID, PLAN_HASH, artifact),
    }));
    for (const artifact of uploaded) {
      serviceSupabase.downloadedObjects.set(
        `${artifact.storageBucket}/${artifact.objectKey}`,
        blob,
      );
    }
    const request: LcaReleaseFinalizeArtifactsRequest = {
      action: 'finalize_artifacts',
      releaseRunId: RELEASE_RUN_ID,
      publishPlanHash: PLAN_HASH,
      releaseManifest: { schemaVersion: 'tiangong.release-manifest.v1' },
      releaseManifestHash: MANIFEST_HASH,
      artifacts: uploaded,
    };

    const result = await executeLcaReleaseCommand(
      request,
      actorFor(actorSupabase),
      createLcaReleaseCommandRepository(actorSupabase as never, serviceSupabase as never),
    );

    assertEquals(result.ok, true);
    assertEquals(
      actorSupabase.rpcCalls.map((call) => call.fn),
      [
        'assert_lca_release_manager',
        'get_lca_release_run',
        'assert_lca_release_manager',
        'get_lca_release_run',
      ],
    );
    assertEquals(serviceSupabase.rpcCalls.length, 1);
    assertEquals(serviceSupabase.rpcCalls[0].fn, 'cmd_lca_release_artifacts_finalize_service');
    assertEquals(serviceSupabase.rpcCalls[0].args.p_audit, {
      requestedBy: USER_ID,
      edgeVerified: true,
      verifiedArtifactCount: 4,
    });
  },
);

Deno.test('finalize rejects object-key and content hash drift before service RPC', async () => {
  const actorSupabase = new FakeSupabase();
  const serviceSupabase = new FakeSupabase();
  actorSupabase.rpcResults.set(
    'assert_lca_release_manager',
    rpcSuccess({ userId: USER_ID, role: 'data_product_manager' }),
  );
  actorSupabase.rpcResults.set(
    'get_lca_release_run',
    rpcSuccess({ status: 'prepared', publishPlanHash: PLAN_HASH }),
  );
  const declared = artifacts('d'.repeat(64), PACKAGE_BYTES.byteLength).map((artifact) => ({
    ...artifact,
    storageBucket: 'lca_results',
    objectKey: lcaReleaseObjectKey(RELEASE_RUN_ID, PLAN_HASH, artifact),
  }));
  const request: LcaReleaseFinalizeArtifactsRequest = {
    action: 'finalize_artifacts',
    releaseRunId: RELEASE_RUN_ID,
    publishPlanHash: PLAN_HASH,
    releaseManifest: {},
    releaseManifestHash: MANIFEST_HASH,
    artifacts: declared,
  };
  for (const artifact of declared) {
    serviceSupabase.downloadedObjects.set(
      `${artifact.storageBucket}/${artifact.objectKey}`,
      new Blob([PACKAGE_BYTES]),
    );
  }

  const driftedPath = structuredClone(request);
  driftedPath.artifacts[0].objectKey = 'attacker/selected.zip';
  const pathResult = await executeLcaReleaseCommand(
    driftedPath,
    actorFor(actorSupabase),
    createLcaReleaseCommandRepository(actorSupabase as never, serviceSupabase as never),
  );
  assertEquals(pathResult.ok && true, false);
  if (!pathResult.ok) {
    assertEquals(pathResult.code, 'release_artifact_storage_ref_invalid');
  }

  const hashResult = await executeLcaReleaseCommand(
    request,
    actorFor(actorSupabase),
    createLcaReleaseCommandRepository(actorSupabase as never, serviceSupabase as never),
  );
  assertEquals(hashResult.ok && true, false);
  if (!hashResult.ok) {
    assertEquals(hashResult.code, 'release_artifact_hash_mismatch');
  }
  assertEquals(serviceSupabase.rpcCalls, []);
});

Deno.test(
  'prepare, approve, publish, readback, unpublish, and bundle reads use named RPCs',
  async () => {
    const actorSupabase = new FakeSupabase();
    const serviceSupabase = new FakeSupabase();
    for (const fn of [
      'cmd_lca_release_prepare',
      'cmd_lca_release_approve',
      'cmd_lca_release_publish',
      'cmd_lca_release_readback_verify',
      'cmd_lca_release_unpublish',
    ]) {
      actorSupabase.rpcResults.set(fn, rpcSuccess({ fn }));
    }
    const repository = createLcaReleaseCommandRepository(
      actorSupabase as never,
      serviceSupabase as never,
    );
    const actor = actorFor(actorSupabase);
    const hash = 'e'.repeat(64);

    const commands = [
      {
        action: 'prepare' as const,
        releaseRunId: RELEASE_RUN_ID,
        releaseVersion: '01.00.000',
        selectionManifestHash: hash,
        inputManifestHash: hash,
        calculationBundleRef: { manifest: 'storage/ref' },
        calculationBundleHash: hash,
        profileLockHash: hash,
        publishPlan: { schemaVersion: 'tiangong.release.publish-plan.v1' },
        publishPlanHash: PLAN_HASH,
        idempotencyKey: 'release:01.00.000',
      },
      {
        action: 'approve' as const,
        releaseRunId: RELEASE_RUN_ID,
        publishPlanHash: PLAN_HASH,
        reason: 'Reviewed',
      },
      {
        action: 'publish' as const,
        releaseRunId: RELEASE_RUN_ID,
        approvalId: '55555555-5555-4555-8555-555555555555',
        approvalHash: hash,
        publishPlanHash: PLAN_HASH,
        idempotencyKey: 'publish:01.00.000',
        credentialFingerprint: hash,
      },
      {
        action: 'readback_verify' as const,
        releaseRunId: RELEASE_RUN_ID,
        releaseManifestHash: MANIFEST_HASH,
        artifactHashes: [
          { artifactId: '60000000-0000-4000-8000-000000000001', sha256: hash },
          { artifactId: '60000000-0000-4000-8000-000000000002', sha256: hash },
          { artifactId: '60000000-0000-4000-8000-000000000003', sha256: hash },
          { artifactId: '60000000-0000-4000-8000-000000000004', sha256: hash },
        ],
      },
      {
        action: 'unpublish' as const,
        publicationId: '77777777-7777-4777-8777-777777777777',
        reason: 'Operator rollback',
      },
    ];
    for (const command of commands) {
      const result = await executeLcaReleaseCommand(command, actor, repository);
      assertEquals(result.ok, true);
    }
    assertEquals(
      actorSupabase.rpcCalls.map((call) => call.fn),
      [
        'cmd_lca_release_prepare',
        'cmd_lca_release_approve',
        'cmd_lca_release_publish',
        'cmd_lca_release_readback_verify',
        'cmd_lca_release_unpublish',
      ],
    );
  },
);

Deno.test(
  'calculation bundle read verifies its private manifest and signs every chunk',
  async () => {
    const actorSupabase = new FakeSupabase();
    const serviceSupabase = new FakeSupabase();
    const bundleContentHash = '1'.repeat(64);
    const chunkHash = '2'.repeat(64);
    const manifest = {
      schemaVersion: 'tiangong.calculation-bundle.v2',
      bundleContentHash,
      scope: { coverageMode: 'global_eligible', processCount: 1 },
      artifacts: [
        {
          kind: 'lci-results',
          path: 'chunks/lci-00000.jsonl.gz',
          mediaType: 'application/x-ndjson',
          compression: 'gzip',
          sha256: chunkHash,
          byteSize: 123,
          recordCount: 1,
        },
      ],
    };
    const manifestBlob = new Blob([JSON.stringify(manifest)]);
    const manifestSha256 = await sha256Blob(manifestBlob);
    const manifestObjectKey = `calculation-bundles/${RELEASE_RUN_ID}/${bundleContentHash}/calculation-bundle.json`;
    actorSupabase.rpcResults.set(
      'get_lcia_result_calculation_bundle',
      rpcSuccess({
        packageId: PACKAGE_ID,
        calculationBundle: {
          schemaVersion: 'tiangong.calculation-bundle.v2',
          calculationId: RELEASE_RUN_ID,
          bundleContentHash,
          manifestUrl: `https://example.supabase.co/storage/v1/s3/lca_results/${manifestObjectKey}`,
          manifestSha256,
          manifestByteSize: manifestBlob.size,
          artifactCount: 1,
        },
      }),
    );
    serviceSupabase.downloadedObjects.set(`lca_results/${manifestObjectKey}`, manifestBlob);

    const result = await executeLcaReleaseCommand(
      { action: 'get_calculation_bundle', packageId: PACKAGE_ID },
      actorFor(actorSupabase),
      createLcaReleaseCommandRepository(actorSupabase as never, serviceSupabase as never),
    );

    assertEquals(result.ok, true);
    assertEquals(serviceSupabase.signedDownloadCalls, [
      { bucket: 'lca_results', objectKey: manifestObjectKey, expiresIn: 900 },
      {
        bucket: 'lca_results',
        objectKey: `calculation-bundles/${RELEASE_RUN_ID}/${bundleContentHash}/chunks/lci-00000.jsonl.gz`,
        expiresIn: 900,
      },
    ]);
    if (result.ok) {
      const body = result.body as {
        data: {
          calculationBundle: {
            manifestUrl?: string;
            manifestDownload: Record<string, unknown>;
            artifacts: Array<Record<string, unknown> & { signedDownloadUrl: string }>;
          };
        };
      };
      assertEquals(
        body.data.calculationBundle.artifacts[0].signedDownloadUrl,
        'https://download.example/lca_results/' +
          `calculation-bundles/${RELEASE_RUN_ID}/${bundleContentHash}/chunks/lci-00000.jsonl.gz`,
      );
      assertEquals(body.data.calculationBundle.manifestUrl, undefined);
      assertEquals('storageBucket' in body.data.calculationBundle.manifestDownload, false);
      assertEquals('objectKey' in body.data.calculationBundle.manifestDownload, false);
      assertEquals('storageBucket' in body.data.calculationBundle.artifacts[0], false);
      assertEquals('objectKey' in body.data.calculationBundle.artifacts[0], false);
    }
  },
);

Deno.test('calculation bundle read rejects path traversal and manifest hash drift', async () => {
  const actorSupabase = new FakeSupabase();
  const serviceSupabase = new FakeSupabase();
  const bundleContentHash = '3'.repeat(64);
  const manifest = {
    schemaVersion: 'tiangong.calculation-bundle.v1',
    bundleContentHash,
    artifacts: [
      {
        path: '../private-object',
        sha256: '4'.repeat(64),
        byteSize: 10,
      },
    ],
  };
  const manifestBlob = new Blob([JSON.stringify(manifest)]);
  const manifestObjectKey = 'calculation-bundles/unsafe/calculation-bundle.json';
  actorSupabase.rpcResults.set(
    'get_lcia_result_calculation_bundle',
    rpcSuccess({
      calculationBundle: {
        schemaVersion: 'tiangong.calculation-bundle.v1',
        manifestUrl: `https://example.supabase.co/storage/v1/s3/lca_results/${manifestObjectKey}`,
        manifestSha256: await sha256Blob(manifestBlob),
        manifestByteSize: manifestBlob.size,
        bundleContentHash,
        artifactCount: 1,
      },
    }),
  );
  serviceSupabase.downloadedObjects.set(`lca_results/${manifestObjectKey}`, manifestBlob);
  const repository = createLcaReleaseCommandRepository(
    actorSupabase as never,
    serviceSupabase as never,
  );

  const unsafe = await executeLcaReleaseCommand(
    { action: 'get_calculation_bundle', packageId: PACKAGE_ID },
    actorFor(actorSupabase),
    repository,
  );
  assertEquals(unsafe.ok, false);
  if (!unsafe.ok) {
    assertEquals(unsafe.code, 'calculation_bundle_artifact_ref_invalid');
  }

  actorSupabase.rpcResults.set(
    'get_lcia_result_calculation_bundle',
    rpcSuccess({
      calculationBundle: {
        schemaVersion: 'tiangong.calculation-bundle.v1',
        manifestUrl: `https://example.supabase.co/storage/v1/s3/lca_results/${manifestObjectKey}`,
        manifestSha256: '5'.repeat(64),
        manifestByteSize: manifestBlob.size,
        bundleContentHash,
        artifactCount: 1,
      },
    }),
  );
  const drift = await executeLcaReleaseCommand(
    { action: 'get_calculation_bundle', packageId: PACKAGE_ID },
    actorFor(actorSupabase),
    repository,
  );
  assertEquals(drift.ok, false);
  if (!drift.ok) {
    assertEquals(drift.code, 'calculation_bundle_manifest_hash_mismatch');
  }
});

Deno.test('artifact download signs only the actor-authorized DB storage ref', async () => {
  const actorSupabase = new FakeSupabase();
  const serviceSupabase = new FakeSupabase();
  actorSupabase.rpcResults.set(
    'get_lca_release_artifact_download',
    rpcSuccess({
      artifactId: ARTIFACT_ID,
      releaseRunId: RELEASE_RUN_ID,
      profileId: 'standalone-lifecyclemodel-result-full-closure.v1',
      format: 'ilcd',
      storageBucket: 'lca_results',
      objectKey: 'lca-releases/v1/readable.zip',
      sha256: 'f'.repeat(64),
    }),
  );
  actorSupabase.rpcResults.set(
    'get_lca_release_run',
    rpcSuccess({ releaseRunId: RELEASE_RUN_ID, releaseVersion: '01.00.000' }),
  );
  const result = await executeLcaReleaseCommand(
    { action: 'create_artifact_download', artifactId: ARTIFACT_ID },
    actorFor(actorSupabase),
    createLcaReleaseCommandRepository(actorSupabase as never, serviceSupabase as never),
  );
  assertEquals(result.ok, true);
  assertEquals(serviceSupabase.signedDownloadCalls, [
    {
      bucket: 'lca_results',
      objectKey: 'lca-releases/v1/readable.zip',
      expiresIn: 900,
      download: 'tiangong-lca-01.00.000-model-result.ilcd.zip',
    },
  ]);
  if (result.ok) {
    const body = result.body as { data: Record<string, unknown> };
    assertEquals(body.data.storageBucket, undefined);
    assertEquals(body.data.objectKey, undefined);
    assertEquals(body.data.downloadFilename, 'tiangong-lca-01.00.000-model-result.ilcd.zip');
    assertEquals(
      body.data.signedDownloadUrl,
      'https://download.example/lca_results/lca-releases/v1/readable.zip',
    );
  }
});

Deno.test('LCA release repository requires an explicit actor client', () => {
  assertThrows(
    () => createLcaReleaseCommandRepository(undefined as never, {} as never),
    Error,
    'LCA release repository requires an explicit actor Supabase client',
  );
});
