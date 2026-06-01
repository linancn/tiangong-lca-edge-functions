import { assertEquals } from 'jsr:@std/assert';

import {
  callWorkerJobCancelRpc,
  callWorkerJobEnqueueRpc,
  callWorkerJobListRpc,
  callWorkerJobReadRpc,
} from '../supabase/functions/_shared/db_rpc/worker_jobs.ts';

const TEST_JOB_ID = '66666666-6666-4666-8666-666666666666';
const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';

class FakeRpcSupabase {
  calls: Array<{ fn: string; args: unknown }> = [];

  constructor(private readonly result: { data: unknown; error: unknown }) {}

  rpc(fn: string, args: unknown) {
    this.calls.push({ fn, args: structuredClone(args) });
    return Promise.resolve(this.result);
  }
}

Deno.test('callWorkerJobEnqueueRpc forwards worker enqueue args', async () => {
  const supabase = new FakeRpcSupabase({
    data: {
      ok: true,
      data: {
        id: TEST_JOB_ID,
        status: 'queued',
      },
    },
    error: null,
  });

  const result = await callWorkerJobEnqueueRpc(supabase as never, {
    jobKind: 'review_submit.gate',
    payload: {
      datasetRevision: {
        table: 'processes',
        id: TEST_DATASET_ID,
        version: '01.00.000',
      },
    },
    payloadSchemaVersion: 'review_submit.gate.request.v1',
    subjectType: 'processes',
    subjectId: TEST_DATASET_ID,
    subjectVersion: '01.00.000',
    requestedBy: TEST_USER_ID,
    requesterType: 'user',
    idempotencyKey: 'review_submit.gate:processes:test',
    concurrencyKey: 'review_submit.gate:processes:test',
    priority: 100,
    visibility: 'user',
    maxAttempts: 3,
  });

  assertEquals(result, {
    ok: true,
    data: {
      id: TEST_JOB_ID,
      status: 'queued',
    },
  });
  assertEquals(supabase.calls, [
    {
      fn: 'worker_enqueue_job',
      args: {
        p_job_kind: 'review_submit.gate',
        p_payload_json: {
          datasetRevision: {
            table: 'processes',
            id: TEST_DATASET_ID,
            version: '01.00.000',
          },
        },
        p_payload_schema_version: 'review_submit.gate.request.v1',
        p_subject_type: 'processes',
        p_subject_id: TEST_DATASET_ID,
        p_subject_version: '01.00.000',
        p_requested_by: TEST_USER_ID,
        p_requester_type: 'user',
        p_team_id: null,
        p_idempotency_key: 'review_submit.gate:processes:test',
        p_request_hash: null,
        p_concurrency_key: 'review_submit.gate:processes:test',
        p_priority: 100,
        p_queue_key: null,
        p_run_after: null,
        p_visibility: 'user',
        p_max_attempts: 3,
        p_timeout_at: null,
        p_payload_ref: null,
        p_parent_job_id: null,
        p_root_job_id: null,
      },
    },
  ]);
});

Deno.test('callWorkerJobReadRpc unwraps worker read envelopes', async () => {
  const supabase = new FakeRpcSupabase({
    data: {
      ok: true,
      data: {
        id: TEST_JOB_ID,
        status: 'completed',
      },
    },
    error: null,
  });

  const result = await callWorkerJobReadRpc(supabase as never, {
    jobId: TEST_JOB_ID,
    includeInternal: false,
  });

  assertEquals(result, {
    ok: true,
    data: {
      id: TEST_JOB_ID,
      status: 'completed',
    },
  });
  assertEquals(supabase.calls, [
    {
      fn: 'worker_read_job',
      args: {
        p_job_id: TEST_JOB_ID,
        p_include_internal: false,
      },
    },
  ]);
});

Deno.test('callWorkerJobListRpc forwards task center list filters', async () => {
  const supabase = new FakeRpcSupabase({
    data: {
      ok: true,
      data: [],
    },
    error: null,
  });

  const result = await callWorkerJobListRpc(supabase as never, {
    requestedBy: TEST_USER_ID,
    subjectType: 'processes',
    subjectId: TEST_DATASET_ID,
    statuses: ['queued', 'running', 'blocked'],
    visibility: 'user',
    limit: 25,
  });

  assertEquals(result, {
    ok: true,
    data: [],
  });
  assertEquals(supabase.calls, [
    {
      fn: 'worker_list_jobs',
      args: {
        p_requested_by: TEST_USER_ID,
        p_subject_type: 'processes',
        p_subject_id: TEST_DATASET_ID,
        p_statuses: ['queued', 'running', 'blocked'],
        p_visibility: 'user',
        p_limit: 25,
        p_include_internal: false,
      },
    },
  ]);
});

Deno.test('callWorkerJobCancelRpc forwards cancel args', async () => {
  const supabase = new FakeRpcSupabase({
    data: {
      ok: true,
      data: {
        id: TEST_JOB_ID,
        status: 'cancelled',
      },
    },
    error: null,
  });

  const result = await callWorkerJobCancelRpc(supabase as never, {
    jobId: TEST_JOB_ID,
    cancelledBy: TEST_USER_ID,
    reason: 'user_cancelled',
  });

  assertEquals(result, {
    ok: true,
    data: {
      id: TEST_JOB_ID,
      status: 'cancelled',
    },
  });
  assertEquals(supabase.calls, [
    {
      fn: 'worker_cancel_job',
      args: {
        p_job_id: TEST_JOB_ID,
        p_cancelled_by: TEST_USER_ID,
        p_reason: 'user_cancelled',
      },
    },
  ]);
});
