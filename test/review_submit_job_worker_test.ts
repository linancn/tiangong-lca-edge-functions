import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import { processReviewSubmitJobs } from '../supabase/functions/_shared/review_submit_job_worker.ts';

const TEST_JOB_ID = '33333333-3333-4333-8333-333333333333';
const TEST_GATE_RUN_ID = '44444444-4444-4444-8444-444444444444';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';
const TEST_REVISION_CHECKSUM = 'a'.repeat(64);

type RpcResponse = {
  data: unknown;
  error: unknown;
};

class FakeWorkerSupabase {
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  constructor(private readonly responses: RpcResponse[]) {}

  rpc(fn: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ fn, args: structuredClone(args) });
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`Unexpected RPC call: ${fn}`);
    }
    return Promise.resolve(response);
  }
}

function jobPayload(gateStatus: string) {
  return {
    status: 'submitting',
    reviewSubmitJobId: TEST_JOB_ID,
    gateRunId: TEST_GATE_RUN_ID,
    datasetRevision: {
      table: 'processes',
      id: TEST_DATASET_ID,
      version: '01.00.000',
      revisionChecksum: TEST_REVISION_CHECKSUM,
    },
    gate: {
      status: gateStatus,
      gateRunId: TEST_GATE_RUN_ID,
      blockingReasons: gateStatus === 'blocked' ? [{ code: 'singular_risk_medium_or_high' }] : [],
    },
  };
}

Deno.test('processReviewSubmitJobs returns waiting_gate jobs without submitting', async () => {
  const supabase = new FakeWorkerSupabase([
    {
      data: {
        ok: true,
        data: [jobPayload('queued')],
      },
      error: null,
    },
    {
      data: {
        ok: true,
        data: { ...jobPayload('queued'), status: 'waiting_gate' },
      },
      error: null,
    },
  ]);

  const result = await processReviewSubmitJobs({
    supabase: supabase as unknown as SupabaseClient,
    batchSize: 1,
    staleSubmittingSeconds: 60,
  });

  assertEquals(result.claimed, 1);
  assertEquals(result.waiting, 1);
  assertEquals(result.submitted, 0);
  assertEquals(
    supabase.rpcCalls.map((call) => call.fn),
    ['cmd_dataset_review_submit_job_claim', 'cmd_dataset_review_submit_job_record_result'],
  );
  assertEquals(supabase.rpcCalls[1].args.p_status, 'waiting_gate');
});

Deno.test('processReviewSubmitJobs submits jobs whose gate already passed', async () => {
  const supabase = new FakeWorkerSupabase([
    {
      data: {
        ok: true,
        data: [jobPayload('passed')],
      },
      error: null,
    },
    {
      data: {
        ok: true,
        data: { ...jobPayload('passed'), status: 'submitted' },
      },
      error: null,
    },
  ]);

  const result = await processReviewSubmitJobs({
    supabase: supabase as unknown as SupabaseClient,
    batchSize: 1,
    staleSubmittingSeconds: 60,
  });

  assertEquals(result.claimed, 1);
  assertEquals(result.submitted, 1);
  assertEquals(
    supabase.rpcCalls.map((call) => call.fn),
    ['cmd_dataset_review_submit_job_claim', 'cmd_review_submit_from_job'],
  );
  assertEquals(supabase.rpcCalls[1].args.p_job_id, TEST_JOB_ID);
});

Deno.test('processReviewSubmitJobs records terminal blocked gate state', async () => {
  const supabase = new FakeWorkerSupabase([
    {
      data: {
        ok: true,
        data: [jobPayload('blocked')],
      },
      error: null,
    },
    {
      data: {
        ok: true,
        data: { ...jobPayload('blocked'), status: 'blocked' },
      },
      error: null,
    },
  ]);

  const result = await processReviewSubmitJobs({
    supabase: supabase as unknown as SupabaseClient,
    batchSize: 1,
    staleSubmittingSeconds: 60,
  });

  assertEquals(result.claimed, 1);
  assertEquals(result.blocked, 1);
  assertEquals(
    supabase.rpcCalls.map((call) => call.fn),
    ['cmd_dataset_review_submit_job_claim', 'cmd_dataset_review_submit_job_record_result'],
  );
  assertEquals(supabase.rpcCalls[1].args.p_status, 'blocked');
  assertEquals(supabase.rpcCalls[1].args.p_error_code, 'REVIEW_SUBMIT_GATE_BLOCKED');
});

Deno.test('processReviewSubmitJobs records malformed job payloads as terminal errors', async () => {
  const supabase = new FakeWorkerSupabase([
    {
      data: {
        ok: true,
        data: [
          {
            ...jobPayload('queued'),
            gate: null,
          },
        ],
      },
      error: null,
    },
    {
      data: {
        ok: true,
        data: { ...jobPayload('queued'), status: 'error' },
      },
      error: null,
    },
  ]);

  const result = await processReviewSubmitJobs({
    supabase: supabase as unknown as SupabaseClient,
    batchSize: 1,
    staleSubmittingSeconds: 60,
  });

  assertEquals(result.claimed, 1);
  assertEquals(result.failed, 1);
  assertEquals(
    supabase.rpcCalls.map((call) => call.fn),
    ['cmd_dataset_review_submit_job_claim', 'cmd_dataset_review_submit_job_record_result'],
  );
  assertEquals(supabase.rpcCalls[1].args.p_status, 'error');
  assertEquals(supabase.rpcCalls[1].args.p_error_code, 'INVALID_REVIEW_SUBMIT_JOB_GATE');
});
