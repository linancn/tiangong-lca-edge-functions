import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import type { ActorContext } from '../../command_runtime/actor_context.ts';
import type { CommandAuditPayload } from '../../command_runtime/audit_log.ts';
import {
  callDataProductPackagePreviewRpc,
  callDataProductPackagePublishRpc,
  callDataProductPackageUnpublishRpc,
  callDataProductRunCreateRpc,
  type DataProductRpcResult,
} from '../../db_rpc/data_product_commands.ts';
import { createSupabaseServiceClient } from '../../supabase_client.ts';
import {
  enqueueCalculatorWorkerJob,
  type WorkerJobEnqueueOutcome,
} from '../../worker_jobs_cutover.ts';
import type {
  DataProductPackageBuildRequest,
  DataProductPackagePreviewRequest,
  DataProductPackagePublishRequest,
  DataProductPackageUnpublishRequest,
  DataProductRunCreateRequest,
} from './types.ts';

type RpcClient = Pick<SupabaseClient, 'rpc'>;

export type DataProductCommandRepository = {
  createRun: (
    request: DataProductRunCreateRequest,
    audit: CommandAuditPayload,
  ) => Promise<DataProductRpcResult>;
  enqueuePackageBuild: (
    request: DataProductPackageBuildRequest,
    actor: ActorContext,
  ) => Promise<WorkerJobEnqueueOutcome>;
  attachRunWorkerJob: (runId: string, workerJobId: string) => Promise<DataProductRpcResult>;
  previewPackage: (request: DataProductPackagePreviewRequest) => Promise<DataProductRpcResult>;
  publishPackage: (
    request: DataProductPackagePublishRequest,
    audit: CommandAuditPayload,
  ) => Promise<DataProductRpcResult>;
  unpublishPublication: (
    request: DataProductPackageUnpublishRequest,
    audit: CommandAuditPayload,
  ) => Promise<DataProductRpcResult>;
};

function requireExplicitActorClient(supabase: RpcClient | null | undefined): RpcClient {
  if (!supabase || typeof supabase.rpc !== 'function') {
    throw new Error('Data product command repository requires an explicit actor Supabase client');
  }

  return supabase;
}

function mapMutationError(error: {
  code?: string;
  message?: string;
  details?: unknown;
}): DataProductRpcResult {
  const code = error.code ?? 'DATA_PRODUCT_MUTATION_FAILED';
  const status = code === '42501' ? 403 : 400;

  return {
    ok: false,
    code: 'worker_job_attach_failed',
    status,
    message: error.message ?? 'Failed to attach worker job to data product run',
    details: error.details ?? null,
  };
}

export function createDataProductCommandRepository(
  actorSupabase: RpcClient,
  serviceSupabase: SupabaseClient = createSupabaseServiceClient(),
): DataProductCommandRepository {
  const actorClient = requireExplicitActorClient(actorSupabase);

  return {
    createRun: (request, audit) => callDataProductRunCreateRpc(actorClient, request, audit),
    enqueuePackageBuild: (request, actor) =>
      enqueueCalculatorWorkerJob(serviceSupabase, {
        jobKind: 'data_product.package_build',
        payload: {
          type: 'data_product_package_build',
          run_id: request.runId,
          requested_by: actor.userId,
          coverage_mode: request.sourceCommand.coverageMode,
          default_impact_category: request.sourceCommand.defaultImpactCategory ?? null,
          lcia_method_set: request.sourceCommand.lciaMethodSet,
        },
        payloadSchemaVersion: 'data_product.package_build.request.v1',
        subjectType: 'data_product_run',
        subjectId: request.runId,
        subjectVersion: null,
        requestedBy: actor.userId,
        requesterType: 'operator',
        idempotencyKey: request.idempotencyKey,
        requestHash: request.runId,
        queueKey: request.runId,
        visibility: 'operator',
      }),
    attachRunWorkerJob: async (runId, workerJobId) => {
      const { error } = await serviceSupabase
        .from('data_product_runs')
        .update({
          worker_job_id: workerJobId,
          status: 'queued',
        })
        .eq('id', runId);

      if (error) {
        return mapMutationError(error);
      }

      return { ok: true, data: null };
    },
    previewPackage: (request) => callDataProductPackagePreviewRpc(actorClient, request),
    publishPackage: (request, audit) =>
      callDataProductPackagePublishRpc(actorClient, request, audit),
    unpublishPublication: (request, audit) =>
      callDataProductPackageUnpublishRpc(actorClient, request, audit),
  };
}
