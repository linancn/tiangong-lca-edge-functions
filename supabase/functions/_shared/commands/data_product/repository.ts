import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import type { ActorContext } from '../../command_runtime/actor_context.ts';
import type { CommandAuditPayload } from '../../command_runtime/audit_log.ts';
import {
  callDataProductPackagePreviewRpc,
  callDataProductPackageUnpublishRpc,
  callLciaResultBuildRequestRpc,
  callLciaResultPackagePublishRpc,
  callLciaScopeClosureCheckReadRpc,
  callLciaScopeClosureCheckRequestRpc,
  callLciaScopeClosureIssuesRpc,
  callLciaScopeClosureReportDownloadRpc,
  callTaskSummaryV2FeedRpc,
  type DataProductRpcResult,
} from '../../db_rpc/data_product_commands.ts';
import { createSupabaseServiceClient } from '../../supabase_client.ts';
import {
  enqueueCalculatorWorkerJob,
  type WorkerJobEnqueueOutcome,
} from '../../worker_jobs_cutover.ts';
import type {
  LciaResultPackageImpactMetadata,
  LciaResultPackageProcessMetadata,
} from './package_preview_projection.ts';
import type {
  DataProductBuildCreateRequest,
  DataProductClosureCheckCreateRequest,
  DataProductClosureCheckReadRequest,
  DataProductClosureIssuesRequest,
  DataProductClosureReportDownloadRequest,
  DataProductPackageBuildRequest,
  DataProductPackagePreviewRequest,
  DataProductPackagePublishRequest,
  DataProductPackageUnpublishRequest,
  DataProductPublicationListRequest,
  DataProductTaskFeedRequest,
} from './types.ts';

type RpcClient = Pick<SupabaseClient, 'rpc'>;

const ARTIFACT_JSON_CACHE_TTL_MS = 5 * 60 * 1000;
const ARTIFACT_JSON_CACHE_MAX_ENTRIES = 16;
const artifactJsonCache = new Map<string, { expiresAt: number; data: unknown }>();

export type DataProductPreviewMetadataRequest = {
  processes: Array<{ processId: string; processVersion: string }>;
  impactCategoryIds: string[];
};

export type DataProductPreviewMetadataResult =
  | {
      ok: true;
      data: {
        processes: LciaResultPackageProcessMetadata[];
        impacts: LciaResultPackageImpactMetadata[];
        warnings?: Array<{ code: string; message: string; details?: unknown }>;
      };
    }
  | {
      ok: false;
      code: string;
      status: number;
      message: string;
      details?: unknown;
    };

export type DataProductCommandRepository = {
  createBuild: (
    request: DataProductBuildCreateRequest,
    audit: CommandAuditPayload,
  ) => Promise<DataProductRpcResult>;
  createClosureCheck: (
    request: DataProductClosureCheckCreateRequest,
    audit: CommandAuditPayload,
  ) => Promise<DataProductRpcResult>;
  getClosureCheck: (request: DataProductClosureCheckReadRequest) => Promise<DataProductRpcResult>;
  listClosureIssues: (request: DataProductClosureIssuesRequest) => Promise<DataProductRpcResult>;
  createClosureReportDownload: (
    request: DataProductClosureReportDownloadRequest,
  ) => Promise<DataProductRpcResult>;
  listTaskFeed: (request: DataProductTaskFeedRequest) => Promise<DataProductRpcResult>;
  enqueuePackageBuild: (
    request: DataProductPackageBuildRequest,
    actor: ActorContext,
  ) => Promise<WorkerJobEnqueueOutcome>;
  previewPackage: (request: DataProductPackagePreviewRequest) => Promise<DataProductRpcResult>;
  fetchSnapshotArtifactUrl: (snapshotId: string) => Promise<
    | { ok: true; data: { snapshotId: string; artifactUrl: string } }
    | {
        ok: false;
        code: string;
        status: number;
        message: string;
        details?: unknown;
      }
  >;
  fetchJsonArtifact: <T>(
    artifactUrl: string,
  ) => Promise<{ ok: true; data: T } | { ok: false; error: string }>;
  fetchPreviewMetadata: (
    request: DataProductPreviewMetadataRequest,
  ) => Promise<DataProductPreviewMetadataResult>;
  publishPackage: (
    request: DataProductPackagePublishRequest,
    audit: CommandAuditPayload,
  ) => Promise<DataProductRpcResult>;
  unpublishPublication: (
    request: DataProductPackageUnpublishRequest,
    audit: CommandAuditPayload,
  ) => Promise<DataProductRpcResult>;
  listPublications: (request: DataProductPublicationListRequest) => Promise<DataProductRpcResult>;
};

function requireExplicitActorClient(supabase: RpcClient | null | undefined): RpcClient {
  if (!supabase || typeof supabase.rpc !== 'function') {
    throw new Error('Data product command repository requires an explicit actor Supabase client');
  }

  return supabase;
}

export function createDataProductCommandRepository(
  actorSupabase: RpcClient,
  serviceSupabase: SupabaseClient = createSupabaseServiceClient(),
): DataProductCommandRepository {
  const actorClient = requireExplicitActorClient(actorSupabase);

  return {
    createBuild: (request, audit) => callLciaResultBuildRequestRpc(actorClient, request, audit),
    createClosureCheck: (request, audit) =>
      callLciaScopeClosureCheckRequestRpc(actorClient, request, audit),
    getClosureCheck: (request) => callLciaScopeClosureCheckReadRpc(actorClient, request),
    listClosureIssues: (request) => callLciaScopeClosureIssuesRpc(actorClient, request),
    createClosureReportDownload: async (request) => {
      const artifact = await callLciaScopeClosureReportDownloadRpc(
        actorClient,
        request.closureCheckId,
      );
      if (!artifact.ok) return artifact;
      const details = artifact.data as Record<string, unknown>;
      const artifactId = stringValue(details.artifactId);
      const bucket = stringValue(details.bucket);
      const objectPath = stringValue(details.objectPath);
      const mediaType = stringValue(details.mediaType);
      // RPC JSON numbers are decoded as numbers. Do not coerce null (or a
      // string) here: Number(null) is zero and would turn an incomplete
      // descriptor into a seemingly valid empty artifact.
      const size =
        typeof details.size === 'number' && Number.isSafeInteger(details.size)
          ? details.size
          : null;
      const checksumSha256 = stringValue(details.checksumSha256);
      if (
        !artifactId ||
        !bucket ||
        !objectPath ||
        !mediaType ||
        size === null ||
        size < 0 ||
        !checksumSha256
      ) {
        return {
          ok: false,
          code: 'closure_report_descriptor_invalid',
          status: 502,
          message: 'Closure report descriptor is incomplete',
        };
      }
      const { data, error } = await serviceSupabase.storage
        .from(bucket)
        .createSignedUrl(objectPath, 900);
      if (error || !data?.signedUrl) {
        return {
          ok: false,
          code: 'closure_report_sign_failed',
          status: 502,
          message: 'Unable to create closure report download',
          details: error?.message ?? null,
        };
      }
      return {
        ok: true,
        data: {
          artifactId,
          mediaType,
          size,
          checksumSha256,
          signedDownloadUrl: data.signedUrl,
          expiresInSeconds: 900,
        },
      };
    },
    listTaskFeed: (request) => callTaskSummaryV2FeedRpc(actorClient, request),
    enqueuePackageBuild: (request, actor) =>
      enqueueCalculatorWorkerJob(serviceSupabase, {
        jobKind: request.workerJob.jobKind,
        payload: request.workerJob.payload,
        payloadSchemaVersion: request.workerJob.payloadSchemaVersion,
        subjectType: request.workerJob.subjectType,
        subjectId: request.workerJob.subjectId,
        subjectVersion: request.workerJob.subjectVersion ?? null,
        requestedBy: actor.userId,
        requesterType: request.workerJob.requesterType,
        idempotencyKey: request.idempotencyKey,
        requestHash: request.workerJob.requestHash ?? request.buildId,
        queueKey: request.workerJob.queueKey ?? request.buildId,
        visibility: request.workerJob.visibility ?? 'operator',
      }),
    previewPackage: (request) => callDataProductPackagePreviewRpc(actorClient, request),
    fetchSnapshotArtifactUrl: (snapshotId) => fetchSnapshotArtifactUrl(serviceSupabase, snapshotId),
    fetchJsonArtifact: (artifactUrl) => fetchArtifactJson(serviceSupabase, artifactUrl),
    fetchPreviewMetadata: (request) => fetchPreviewMetadata(serviceSupabase, request),
    publishPackage: (request, audit) =>
      callLciaResultPackagePublishRpc(actorClient, request, audit),
    unpublishPublication: (request, audit) =>
      callDataProductPackageUnpublishRpc(actorClient, request, audit),
    listPublications: (request) => listLciaResultPublications(serviceSupabase, request),
  };
}

async function listLciaResultPublications(
  supabase: SupabaseClient,
  request: DataProductPublicationListRequest,
): Promise<DataProductRpcResult> {
  const { data: publicationRows, error: publicationError } = await supabase
    .from('lcia_result_publications')
    .select(
      [
        'id',
        'package_id',
        'publication_series_key',
        'publication_channel',
        'visibility_scope',
        'is_current',
        'status',
        'display_default_impact_category',
        'published_at',
        'unpublished_at',
        'reason',
        'created_at',
        'updated_at',
      ].join(','),
    )
    .order('is_current', { ascending: false })
    .order('published_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(request.limit ?? 50);

  if (publicationError) {
    return {
      ok: false,
      code: 'lcia_result_publications_lookup_failed',
      status: 500,
      message: 'Failed to read LCIA result publications',
      details: publicationError.message,
    };
  }

  const publications = ((publicationRows ?? []) as unknown[]).filter(isRecord);
  const packageIds = uniqueStrings(
    publications
      .map((publication) => stringValue(publication.package_id))
      .filter((value): value is string => Boolean(value)),
  );
  const { data: packageRows, error: packageError } =
    packageIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .from('lcia_result_packages')
          .select(
            [
              'id',
              'build_worker_job_id',
              'package_version',
              'coverage_mode',
              'eligible_input_count',
              'included_input_count',
              'default_impact_category',
              'status',
              'created_at',
              'updated_at',
            ].join(','),
          )
          .in('id', packageIds);

  if (packageError) {
    return {
      ok: false,
      code: 'lcia_result_publication_packages_lookup_failed',
      status: 500,
      message: 'Failed to read LCIA result package metadata for publications',
      details: packageError.message,
    };
  }

  const packagesById = new Map<string, Record<string, unknown>>();
  for (const row of (packageRows ?? []) as unknown[]) {
    if (!isRecord(row)) {
      continue;
    }
    const packageId = stringValue(row.id);
    if (packageId) {
      packagesById.set(packageId, row);
    }
  }

  const workerJobIds = uniqueStrings(
    Array.from(packagesById.values())
      .map((row) => stringValue(row.build_worker_job_id))
      .filter((value): value is string => Boolean(value)),
  );
  const { data: workerRows, error: workerError } =
    workerJobIds.length === 0
      ? { data: [], error: null }
      : await supabase.from('worker_jobs').select('id,payload_json').in('id', workerJobIds);

  if (workerError) {
    return {
      ok: false,
      code: 'lcia_result_publication_worker_jobs_lookup_failed',
      status: 500,
      message: 'Failed to read LCIA result package worker metadata',
      details: workerError.message,
    };
  }

  const workerPayloadById = new Map<string, Record<string, unknown>>();
  for (const row of (workerRows ?? []) as unknown[]) {
    if (!isRecord(row)) {
      continue;
    }
    const workerJobId = stringValue(row.id);
    const payload = recordValue(row, 'payload_json');
    if (workerJobId && payload) {
      workerPayloadById.set(workerJobId, payload);
    }
  }

  return {
    ok: true,
    data: publications.map((publication) => {
      const packageId = stringValue(publication.package_id);
      const packageRow = packageId ? packagesById.get(packageId) : undefined;
      const workerPayload = packageRow
        ? workerPayloadById.get(stringValue(packageRow.build_worker_job_id) ?? '')
        : undefined;
      const packageName = firstStringValue(
        workerPayload?.name,
        workerPayload?.packageName,
        workerPayload?.package_name,
      );
      return {
        publicationId: stringValue(publication.id),
        packageId,
        packageName,
        packageVersion: stringValue(packageRow?.package_version),
        status: stringValue(publication.status),
        isCurrent: Boolean(publication.is_current),
        publicationSeriesKey: stringValue(publication.publication_series_key),
        publicationChannel: stringValue(publication.publication_channel),
        visibilityScope: stringValue(publication.visibility_scope),
        displayDefaultImpactCategory: stringValue(publication.display_default_impact_category),
        publishedAt: stringValue(publication.published_at),
        unpublishedAt: stringValue(publication.unpublished_at),
        reason: stringValue(publication.reason),
        eligibleInputCount: numberValue(packageRow?.eligible_input_count),
        includedInputCount: numberValue(packageRow?.included_input_count),
        packageStatus: stringValue(packageRow?.status),
      };
    }),
  };
}

async function fetchSnapshotArtifactUrl(
  supabase: SupabaseClient,
  snapshotId: string,
): Promise<
  | { ok: true; data: { snapshotId: string; artifactUrl: string } }
  | {
      ok: false;
      code: string;
      status: number;
      message: string;
      details?: unknown;
    }
> {
  const { data, error } = await supabase
    .from('lca_snapshot_artifacts')
    .select('snapshot_id,artifact_url,status,created_at')
    .eq('snapshot_id', snapshotId)
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return {
      ok: false,
      code: 'snapshot_artifact_lookup_failed',
      status: 500,
      message: 'Failed to read snapshot artifact metadata',
      details: error.message,
    };
  }

  if (!data?.artifact_url) {
    return {
      ok: false,
      code: 'snapshot_not_ready',
      status: 404,
      message: 'Snapshot artifact is not ready',
    };
  }

  return {
    ok: true,
    data: {
      snapshotId: String(data.snapshot_id),
      artifactUrl: String(data.artifact_url),
    },
  };
}

async function fetchArtifactJson<T>(
  supabase: SupabaseClient,
  artifactUrl: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const cached = artifactJsonCache.get(artifactUrl);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return { ok: true, data: cached.data as T };
  }

  const storagePath = parseStoragePathFromArtifactUrl(artifactUrl);
  let storageError: string | null = null;
  if (storagePath) {
    const downloaded = await supabase.storage
      .from(storagePath.bucket)
      .download(storagePath.objectPath);
    if (!downloaded.error) {
      const parsed = parseArtifactJsonText<T>(await downloaded.data.text());
      if (parsed.ok) {
        rememberArtifactJson(artifactUrl, parsed.data);
      }
      return parsed;
    }
    storageError = `storage_download_failed:${downloaded.error.message}`;
  }

  const httpResult = await fetchJsonByHttp<T>(artifactUrl);
  if (httpResult.ok) {
    rememberArtifactJson(artifactUrl, httpResult.data);
  }
  if (!httpResult.ok && storageError) {
    return { ok: false, error: `${storageError};${httpResult.error}` };
  }
  return httpResult;
}

function rememberArtifactJson(artifactUrl: string, data: unknown): void {
  artifactJsonCache.set(artifactUrl, {
    data,
    expiresAt: Date.now() + ARTIFACT_JSON_CACHE_TTL_MS,
  });
  while (artifactJsonCache.size > ARTIFACT_JSON_CACHE_MAX_ENTRIES) {
    const firstKey = artifactJsonCache.keys().next().value;
    if (!firstKey) {
      break;
    }
    artifactJsonCache.delete(firstKey);
  }
}

async function fetchPreviewMetadata(
  supabase: SupabaseClient,
  request: DataProductPreviewMetadataRequest,
): Promise<DataProductPreviewMetadataResult> {
  const processRefs = uniqueProcessRefs(request.processes);
  const impactCategoryIds = uniqueStrings(request.impactCategoryIds);
  const warnings: Array<{ code: string; message: string; details?: unknown }> = [];

  const processesResult =
    processRefs.length === 0
      ? { ok: true as const, data: [] }
      : await fetchProcessMetadata(supabase, processRefs);
  if (!processesResult.ok) {
    warnings.push({
      code: processesResult.code,
      message: processesResult.message,
      details: processesResult.details,
    });
  }

  const impactsResult =
    impactCategoryIds.length === 0
      ? { ok: true as const, data: [] }
      : await fetchImpactMetadata(supabase, impactCategoryIds);
  if (!impactsResult.ok) {
    warnings.push({
      code: impactsResult.code,
      message: impactsResult.message,
      details: impactsResult.details,
    });
  }

  const processes = processesResult.ok ? processesResult.data : [];
  const impacts = impactsResult.ok ? impactsResult.data : [];

  if (warnings.length > 0 && processes.length === 0 && impacts.length === 0) {
    return {
      ok: false,
      code: warnings[0].code,
      status: 500,
      message: warnings[0].message,
      details: warnings,
    };
  }

  return {
    ok: true,
    data: {
      processes,
      impacts,
      ...(warnings.length > 0 ? { warnings } : {}),
    },
  };
}

async function fetchProcessMetadata(
  supabase: SupabaseClient,
  processRefs: Array<{ processId: string; processVersion: string }>,
): Promise<
  | { ok: true; data: LciaResultPackageProcessMetadata[] }
  | {
      ok: false;
      code: string;
      status: number;
      message: string;
      details?: unknown;
    }
> {
  const processIds = uniqueStrings(processRefs.map((process) => process.processId));
  const processVersions = uniqueStrings(processRefs.map((process) => process.processVersion));
  const wantedKeys = new Set(
    processRefs.map((process) => processLookupKey(process.processId, process.processVersion)),
  );
  const { data, error } = await supabase
    .from('processes')
    .select('id,version,json,json_ordered')
    .in('id', processIds)
    .in('version', processVersions);

  if (error) {
    return {
      ok: false,
      code: 'preview_process_metadata_lookup_failed',
      status: 500,
      message: 'Failed to read process metadata for package preview',
      details: error.message,
    };
  }

  return {
    ok: true,
    data: (data ?? [])
      .map((row) => {
        const record = (isRecord(row) ? row : {}) as Record<string, unknown>;
        const processId = stringValue(record.id);
        const processVersion = stringValue(record.version);
        if (
          !processId ||
          !processVersion ||
          !wantedKeys.has(processLookupKey(processId, processVersion))
        ) {
          return null;
        }
        const processName =
          processNameFromDocument(record.json_ordered ?? record.json) ?? processId;
        return { processId, processVersion, processName };
      })
      .filter((metadata): metadata is LciaResultPackageProcessMetadata => Boolean(metadata)),
  };
}

async function fetchImpactMetadata(
  supabase: SupabaseClient,
  impactCategoryIds: string[],
): Promise<
  | { ok: true; data: LciaResultPackageImpactMetadata[] }
  | {
      ok: false;
      code: string;
      status: number;
      message: string;
      details?: unknown;
    }
> {
  const { data, error } = await supabase
    .from('lciamethods')
    .select('id,version,json,json_ordered')
    .in('id', impactCategoryIds)
    .order('version', { ascending: false });

  if (error) {
    return {
      ok: false,
      code: 'preview_impact_metadata_lookup_failed',
      status: 500,
      message: 'Failed to read LCIA method metadata for package preview',
      details: error.message,
    };
  }

  const wantedIds = new Set(impactCategoryIds);
  const byId = new Map<string, LciaResultPackageImpactMetadata>();
  for (const row of data ?? []) {
    const record = (isRecord(row) ? row : {}) as Record<string, unknown>;
    const impactCategoryId = stringValue(record.id);
    if (!impactCategoryId || !wantedIds.has(impactCategoryId) || byId.has(impactCategoryId)) {
      continue;
    }
    const document = record.json_ordered ?? record.json;
    byId.set(impactCategoryId, {
      impactCategoryId,
      impactVersion: stringValue(record.version),
      impactName: impactNameFromDocument(document),
      unit: impactUnitFromDocument(document),
    });
  }

  return { ok: true, data: Array.from(byId.values()) };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function uniqueProcessRefs(
  values: Array<{ processId: string; processVersion: string }>,
): Array<{ processId: string; processVersion: string }> {
  const seen = new Set<string>();
  const refs: Array<{ processId: string; processVersion: string }> = [];
  for (const value of values) {
    if (!value.processId || !value.processVersion) {
      continue;
    }
    const key = processLookupKey(value.processId, value.processVersion);
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(value);
    }
  }
  return refs;
}

function processLookupKey(processId: string, processVersion: string): string {
  return `${processId}@${processVersion}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(value: unknown, field: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const fieldValue = value[field];
  return isRecord(fieldValue) ? fieldValue : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function firstStringValue(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value);
    if (text) {
      return text;
    }
  }
  return null;
}

function numberValue(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function localizedText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null;
  }

  if (Array.isArray(value)) {
    for (const lang of ['zh', 'zh-cn', 'en']) {
      const localized = value.find(
        (item) => isRecord(item) && String(item['@xml:lang'] ?? '').toLowerCase() === lang,
      );
      const text = localizedText(localized);
      if (text) {
        return text;
      }
    }
    for (const item of value) {
      const text = localizedText(item);
      if (text) {
        return text;
      }
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  for (const key of ['#text', 'text', 'value', '@value']) {
    const text = stringValue(value[key]);
    if (text) {
      return text;
    }
  }

  for (const key of [
    'baseName',
    'common:baseName',
    'shortName',
    'common:shortName',
    'name',
    'common:name',
    'description',
    'common:shortDescription',
  ]) {
    const text = localizedText(value[key]);
    if (text) {
      return text;
    }
  }

  return null;
}

function firstLocalizedText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = localizedText(value);
    if (text) {
      return text;
    }
  }
  return null;
}

function processNameFromDocument(document: unknown): string | null {
  const processDataSet =
    recordValue(document, 'processDataSet') ?? recordValue(document, 'process_dataset');
  const processInformation =
    recordValue(processDataSet, 'processInformation') ??
    recordValue(processDataSet, 'process_information');
  const dataSetInformation =
    recordValue(processInformation, 'dataSetInformation') ??
    recordValue(processInformation, 'data_set_information');
  const name = recordValue(dataSetInformation, 'name');

  return firstLocalizedText(
    name?.baseName,
    name?.['common:baseName'],
    name,
    dataSetInformation?.name,
    dataSetInformation?.['common:name'],
    dataSetInformation?.description,
  );
}

function lciaMethodDataSetFromDocument(document: unknown): Record<string, unknown> | null {
  if (!isRecord(document)) {
    return null;
  }
  return (
    recordValue(document, 'LCIAMethodDataSet') ??
    recordValue(document, 'lciaMethodDataSet') ??
    recordValue(document, 'lcia_method_data_set') ??
    document
  );
}

function lciaMethodDataSetInformation(document: unknown): Record<string, unknown> | null {
  const dataSet = lciaMethodDataSetFromDocument(document);
  const methodInformation =
    recordValue(dataSet, 'LCIAMethodInformation') ??
    recordValue(dataSet, 'lciaMethodInformation') ??
    recordValue(dataSet, 'methodInformation') ??
    dataSet;
  return (
    recordValue(methodInformation, 'dataSetInformation') ??
    recordValue(methodInformation, 'data_set_information') ??
    recordValue(dataSet, 'dataSetInformation') ??
    recordValue(dataSet, 'data_set_information')
  );
}

function impactNameFromDocument(document: unknown): string | null {
  const dataSet = lciaMethodDataSetFromDocument(document);
  const dataSetInformation = lciaMethodDataSetInformation(document);
  return firstLocalizedText(
    dataSetInformation?.name,
    dataSetInformation?.description,
    dataSet?.name,
    dataSet?.description,
    isRecord(document) ? document.description : null,
  );
}

function impactUnitFromDocument(document: unknown): string | null {
  const dataSet = lciaMethodDataSetFromDocument(document);
  const dataSetInformation = lciaMethodDataSetInformation(document);
  const dataSetReferenceQuantity = recordValue(dataSet, 'referenceQuantity');
  const dataSetInformationReferenceQuantity = recordValue(dataSetInformation, 'referenceQuantity');
  const rootReferenceQuantity = isRecord(document)
    ? recordValue(document, 'referenceQuantity')
    : null;

  return firstLocalizedText(
    dataSetInformationReferenceQuantity?.['common:shortDescription'],
    dataSetInformationReferenceQuantity?.shortDescription,
    dataSetReferenceQuantity?.['common:shortDescription'],
    dataSetReferenceQuantity?.shortDescription,
    rootReferenceQuantity?.['common:shortDescription'],
    rootReferenceQuantity?.shortDescription,
  );
}

function parseStoragePathFromArtifactUrl(
  artifactUrl: string,
): { bucket: string; objectPath: string } | null {
  try {
    const url = new URL(artifactUrl);
    if (url.protocol === 's3:') {
      const objectPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      return url.hostname && objectPath ? { bucket: url.hostname, objectPath } : null;
    }

    const marker = '/storage/v1/s3/';
    const markerIndex = url.pathname.indexOf(marker);
    if (markerIndex < 0) {
      return null;
    }
    const remainder = url.pathname.slice(markerIndex + marker.length);
    const splitIndex = remainder.indexOf('/');
    if (splitIndex <= 0 || splitIndex >= remainder.length - 1) {
      return null;
    }
    const bucket = decodeURIComponent(remainder.slice(0, splitIndex));
    const objectPath = decodeURIComponent(remainder.slice(splitIndex + 1));
    return bucket && objectPath ? { bucket, objectPath } : null;
  } catch (_error) {
    return null;
  }
}

async function fetchJsonByHttp<T>(
  url: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return { ok: false, error: `http_${response.status}` };
    }
    return { ok: true, data: (await response.json()) as T };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'fetch_failed',
    };
  }
}

function parseArtifactJsonText<T>(
  text: string,
): { ok: true; data: T } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `json_parse_failed:${error.message}` : 'json_parse_failed',
    };
  }
}
