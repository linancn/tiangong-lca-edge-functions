import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import type { CommandAuditPayload } from '../command_runtime/audit_log.ts';
import type {
  DataProductCommandFailure,
  DataProductPackagePreviewRequest,
  DataProductPackagePublishRequest,
  DataProductPackageUnpublishRequest,
  DataProductRunCreateRequest,
} from '../commands/data_product/types.ts';

type RpcClient = Pick<SupabaseClient, 'rpc'>;

export type DataProductRpcResult = { ok: true; data: unknown } | DataProductCommandFailure;

export type DataProductPublishedResultsRequest = {
  processId: string;
  processVersion: string;
  impactCategoryId?: string;
};

function mapRpcError(error: { code?: string; message?: string; details?: unknown }) {
  const code = error.code ?? 'RPC_ERROR';
  const status =
    code === '42501' ? 403 : code === 'PGRST116' ? 404 : code === 'AUTH_REQUIRED' ? 401 : 400;

  return {
    ok: false as const,
    code,
    status,
    message: error.message ?? 'Data product RPC failed',
    details: error.details ?? null,
  };
}

function isDataProductCommandFailure(data: unknown): data is DataProductCommandFailure {
  if (!data || typeof data !== 'object') {
    return false;
  }

  const candidate = data as Partial<DataProductCommandFailure> & { ok?: unknown };
  return (
    candidate.ok === false &&
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    typeof candidate.status === 'number'
  );
}

async function callDataProductRpc(
  supabase: RpcClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<DataProductRpcResult> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    return mapRpcError(error);
  }

  if (isDataProductCommandFailure(data)) {
    return data;
  }

  if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    (data as { ok?: unknown }).ok === true &&
    'data' in (data as Record<string, unknown>)
  ) {
    return {
      ok: true,
      data: (data as Record<string, unknown>).data,
    };
  }

  return {
    ok: true,
    data,
  };
}

export function buildDataProductRunCreateRpcArgs(
  request: DataProductRunCreateRequest,
  audit: CommandAuditPayload,
): Record<string, unknown> {
  return {
    p_name: request.name,
    p_processes: request.processes ?? null,
    p_coverage_mode: request.coverageMode,
    p_default_impact_category: request.defaultImpactCategory ?? null,
    p_lcia_method_set: request.lciaMethodSet,
    p_idempotency_key: request.idempotencyKey ?? null,
    p_audit: audit,
  };
}

export function buildDataProductPackagePreviewRpcArgs(
  request: DataProductPackagePreviewRequest,
): Record<string, unknown> {
  return {
    p_package_id: request.packageId,
  };
}

export function buildDataProductPackagePublishRpcArgs(
  request: DataProductPackagePublishRequest,
  audit: CommandAuditPayload,
): Record<string, unknown> {
  return {
    p_package_id: request.packageId,
    p_display_default_impact_category: request.displayDefaultImpactCategory ?? null,
    p_reason: request.reason ?? null,
    p_audit: audit,
  };
}

export function buildDataProductPackageUnpublishRpcArgs(
  request: DataProductPackageUnpublishRequest,
  audit: CommandAuditPayload,
): Record<string, unknown> {
  return {
    p_publication_id: request.publicationId,
    p_reason: request.reason ?? null,
    p_audit: audit,
  };
}

export function buildDataProductPublishedResultsRpcArgs(
  request: DataProductPublishedResultsRequest,
): Record<string, unknown> {
  return {
    p_process_id: request.processId,
    p_process_version: request.processVersion,
    p_impact_category_id: request.impactCategoryId ?? null,
  };
}

export function callDataProductRunCreateRpc(
  supabase: RpcClient,
  request: DataProductRunCreateRequest,
  audit: CommandAuditPayload,
) {
  return callDataProductRpc(
    supabase,
    'cmd_data_product_run_create',
    buildDataProductRunCreateRpcArgs(request, audit),
  );
}

export function callDataProductPackagePreviewRpc(
  supabase: RpcClient,
  request: DataProductPackagePreviewRequest,
) {
  return callDataProductRpc(
    supabase,
    'get_data_product_package_preview',
    buildDataProductPackagePreviewRpcArgs(request),
  );
}

export function callDataProductPackagePublishRpc(
  supabase: RpcClient,
  request: DataProductPackagePublishRequest,
  audit: CommandAuditPayload,
) {
  return callDataProductRpc(
    supabase,
    'cmd_data_product_package_publish',
    buildDataProductPackagePublishRpcArgs(request, audit),
  );
}

export function callDataProductPackageUnpublishRpc(
  supabase: RpcClient,
  request: DataProductPackageUnpublishRequest,
  audit: CommandAuditPayload,
) {
  return callDataProductRpc(
    supabase,
    'cmd_data_product_package_unpublish',
    buildDataProductPackageUnpublishRpcArgs(request, audit),
  );
}

export function callDataProductPublishedResultsRpc(
  supabase: RpcClient,
  request: DataProductPublishedResultsRequest,
) {
  return callDataProductRpc(
    supabase,
    'get_published_process_lcia_results',
    buildDataProductPublishedResultsRpcArgs(request),
  );
}
