import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';
import { z } from 'zod';

import type { ActorContext } from '../command_runtime/actor_context.ts';
import type { CommandExecutionResult, CommandParseResult } from '../command_runtime/command.ts';
import {
  callWorkerJobCancelRpc,
  callWorkerJobListRpc,
  callWorkerJobReadRpc,
  type WorkerJobRpcResult,
} from '../db_rpc/worker_jobs.ts';
import { createSupabaseServiceClient } from '../supabase_client.ts';
import type { WorkerJobResult, WorkerJobStatus } from './dataset/types.ts';

const uuidSchema = z.string().uuid();
const workerJobStatuses = [
  'queued',
  'running',
  'waiting',
  'completed',
  'blocked',
  'stale',
  'failed',
  'cancelled',
] as const;

const readSchema = z
  .object({
    action: z.literal('read'),
    jobId: uuidSchema,
  })
  .strict();

const listSchema = z
  .object({
    action: z.literal('list').default('list'),
    subjectType: z.string().min(1).optional(),
    subjectId: uuidSchema.optional(),
    statuses: z.array(z.enum(workerJobStatuses)).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const cancelSchema = z
  .object({
    action: z.literal('cancel'),
    jobId: uuidSchema,
    reason: z.string().min(1).max(200).optional(),
  })
  .strict();

export const workerJobRequestSchema = z.union([readSchema, listSchema, cancelSchema]);

export type WorkerJobRequest = z.infer<typeof workerJobRequestSchema>;

function invalidPayload<T>(message: string, error: z.ZodError): CommandParseResult<T> {
  return {
    ok: false,
    message,
    details: error.flatten(),
  };
}

export function parseWorkerJobCommand(body: unknown): CommandParseResult<WorkerJobRequest> {
  const parsed = workerJobRequestSchema.safeParse(body);
  if (!parsed.success) {
    return invalidPayload('Invalid worker job payload', parsed.error);
  }

  return {
    ok: true,
    value: parsed.data,
  };
}

function isWorkerJobStatus(value: unknown): value is WorkerJobStatus {
  return workerJobStatuses.some((status) => status === value);
}

function normalizeWorkerJob(data: unknown): WorkerJobResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      status: 'failed',
      errorCode: 'invalid_worker_job_rpc_result',
      errorMessage: 'Worker job RPC returned an invalid response payload.',
    };
  }

  const candidate = data as Record<string, unknown>;
  return {
    ...candidate,
    status: isWorkerJobStatus(candidate.status) ? candidate.status : 'failed',
  } as WorkerJobResult;
}

function normalizeWorkerJobList(data: unknown): WorkerJobResult[] {
  return Array.isArray(data) ? data.map(normalizeWorkerJob) : [];
}

function ensureUserCanRead(
  job: WorkerJobResult,
  actor: ActorContext,
): CommandExecutionResult | null {
  if (job.requestedBy !== actor.userId) {
    return {
      ok: false,
      code: 'WORKER_JOB_NOT_FOUND',
      status: 404,
      message: 'Worker job not found',
    };
  }

  return null;
}

function rpcFailure(result: WorkerJobRpcResult): CommandExecutionResult {
  if (result.ok) {
    return {
      ok: false,
      code: 'WORKER_JOB_RPC_RESULT_INVALID',
      status: 502,
      message: 'Worker job RPC result was unexpectedly successful',
    };
  }

  return result;
}

export async function executeWorkerJobCommand(
  request: WorkerJobRequest,
  actor: ActorContext,
  serviceClient: SupabaseClient = createSupabaseServiceClient(),
): Promise<CommandExecutionResult> {
  if (request.action === 'list') {
    const result = await callWorkerJobListRpc(serviceClient, {
      requestedBy: actor.userId,
      subjectType: request.subjectType ?? null,
      subjectId: request.subjectId ?? null,
      statuses: request.statuses ?? null,
      visibility: 'user',
      limit: request.limit ?? 50,
      includeInternal: false,
    });
    if (!result.ok) {
      return rpcFailure(result);
    }

    return {
      ok: true,
      body: {
        ok: true,
        command: 'worker_jobs_list',
        data: normalizeWorkerJobList(result.data),
      },
    };
  }

  const readResult = await callWorkerJobReadRpc(serviceClient, {
    jobId: request.jobId,
    includeInternal: false,
  });
  if (!readResult.ok) {
    return rpcFailure(readResult);
  }

  const job = normalizeWorkerJob(readResult.data);
  const aclFailure = ensureUserCanRead(job, actor);
  if (aclFailure) {
    return aclFailure;
  }

  if (request.action === 'read') {
    return {
      ok: true,
      body: {
        ok: true,
        command: 'worker_jobs_read',
        data: job,
      },
    };
  }

  const cancelResult = await callWorkerJobCancelRpc(serviceClient, {
    jobId: request.jobId,
    cancelledBy: actor.userId,
    reason: request.reason ?? null,
  });
  if (!cancelResult.ok) {
    return rpcFailure(cancelResult);
  }

  return {
    ok: true,
    body: {
      ok: true,
      command: 'worker_jobs_cancel',
      data: normalizeWorkerJob(cancelResult.data),
    },
  };
}
