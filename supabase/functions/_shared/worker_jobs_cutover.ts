import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import { callWorkerJobEnqueueRpc, type WorkerJobEnqueueRequest } from './db_rpc/worker_jobs.ts';

type EnvReader = (key: string) => string | undefined;

export type WorkerJobEnqueueOutcome =
  | { ok: true; workerJobId: string | null; data: unknown }
  | { ok: false; error: string; status: number; details?: unknown };

export function isWorkerJobsCutoverEnabled(
  envName: string,
  readEnv: EnvReader = (key) => Deno.env.get(key) ?? undefined,
): boolean {
  const value = (readEnv(envName) ?? readEnv('WORKER_JOBS_CUTOVER_ENABLED') ?? 'true')
    .trim()
    .toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off';
}

export function lcaWorkerJobKindForJobType(jobType: string): string | null {
  switch (jobType) {
    case 'solve_one':
      return 'lca.solve_one';
    case 'solve_batch':
      return 'lca.solve_batch';
    case 'solve_all_unit':
      return 'lca.solve_all_unit';
    case 'build_snapshot':
      return 'lca.build_snapshot';
    case 'analyze_contribution_path':
      return 'lca.contribution_path';
    default:
      return null;
  }
}

export function workerJobPayloadSchemaVersion(jobKind: string): string {
  return `${jobKind}.request.v1`;
}

export function workerJobIdFromRpcData(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return null;
  }
  const id = (data as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export async function enqueueCalculatorWorkerJob(
  supabase: SupabaseClient,
  request: WorkerJobEnqueueRequest,
): Promise<WorkerJobEnqueueOutcome> {
  const result = await callWorkerJobEnqueueRpc(supabase, request);
  if (!result.ok) {
    return {
      ok: false,
      error: result.code,
      status: result.status,
      details: result.details,
    };
  }

  const workerJobId = workerJobIdFromRpcData(result.data);
  if (!workerJobId) {
    return {
      ok: false,
      error: 'WORKER_JOB_ID_MISSING',
      status: 500,
      details: result.data,
    };
  }

  return {
    ok: true,
    workerJobId,
    data: result.data,
  };
}

export async function markRetainedLcaJobWorkerEnqueueFailed(
  supabase: SupabaseClient,
  args: {
    jobId: string;
    userId: string;
    nowIso: string;
    errorCode: string;
    errorMessage: string;
    details?: unknown;
  },
): Promise<void> {
  const diagnostics = {
    phase: 'worker_jobs_enqueue_failed',
    error_code: args.errorCode,
    error_message: args.errorMessage,
    details: args.details ?? null,
  };

  const { error: jobError } = await supabase
    .from('lca_jobs')
    .update({
      status: 'failed',
      diagnostics,
      finished_at: args.nowIso,
      updated_at: args.nowIso,
    })
    .eq('id', args.jobId)
    .eq('requested_by', args.userId);

  if (jobError) {
    console.error('mark lca job worker_jobs enqueue failure failed', {
      error: jobError.message,
      code: jobError.code,
      job_id: args.jobId,
      user_id: args.userId,
    });
  }

  const { error: cacheError } = await supabase
    .from('lca_result_cache')
    .update({
      status: 'failed',
      error_code: args.errorCode,
      error_message: args.errorMessage,
      updated_at: args.nowIso,
    })
    .eq('job_id', args.jobId);

  if (cacheError) {
    console.error('mark lca result cache worker_jobs enqueue failure failed', {
      error: cacheError.message,
      code: cacheError.code,
      job_id: args.jobId,
    });
  }
}
