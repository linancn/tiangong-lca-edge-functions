import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import type { ActorContext } from '../../command_runtime/actor_context.ts';
import type { CommandAuditPayload } from '../../command_runtime/audit_log.ts';
import {
  callDataProductPackagePreviewRpc,
  callDataProductPackageUnpublishRpc,
  callLciaResultBuildRequestRpc,
  callLciaResultPackagePublishRpc,
  type DataProductRpcResult,
} from '../../db_rpc/data_product_commands.ts';
import { createSupabaseServiceClient } from '../../supabase_client.ts';
import {
  enqueueCalculatorWorkerJob,
  type WorkerJobEnqueueOutcome,
} from '../../worker_jobs_cutover.ts';
import type {
  DataProductBuildCreateRequest,
  DataProductPackageBuildRequest,
  DataProductPackagePreviewRequest,
  DataProductPackagePublishRequest,
  DataProductPackageUnpublishRequest,
} from './types.ts';

type RpcClient = Pick<SupabaseClient, 'rpc'>;

export type DataProductCommandRepository = {
  createBuild: (
    request: DataProductBuildCreateRequest,
    audit: CommandAuditPayload,
  ) => Promise<DataProductRpcResult>;
  enqueuePackageBuild: (
    request: DataProductPackageBuildRequest,
    actor: ActorContext,
  ) => Promise<WorkerJobEnqueueOutcome>;
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

export function createDataProductCommandRepository(
  actorSupabase: RpcClient,
  serviceSupabase: SupabaseClient = createSupabaseServiceClient(),
): DataProductCommandRepository {
  const actorClient = requireExplicitActorClient(actorSupabase);

  return {
    createBuild: (request, audit) => callLciaResultBuildRequestRpc(actorClient, request, audit),
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
    publishPackage: (request, audit) =>
      callLciaResultPackagePublishRpc(actorClient, request, audit),
    unpublishPublication: (request, audit) =>
      callDataProductPackageUnpublishRpc(actorClient, request, audit),
  };
}
