import { assertEquals, assertThrows } from 'jsr:@std/assert';

import {
  callWorkerJobCancelRpc,
  callWorkerJobEnqueueRpc,
  callWorkerJobListByConcurrencyKeyRpc,
  callWorkerJobListRpc,
  callWorkerJobReadManyRpc,
  callWorkerJobReadRpc,
  createServiceWorkerCapabilityRepository,
  WORKER_CAPABILITY_CONTRACT,
} from '../supabase/functions/_shared/capabilities/worker_jobs.ts';

const TEST_JOB_ID = '66666666-6666-4666-8666-666666666666';
const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';

class FakeRpcSupabase {
  calls: Array<{ fn: string; args: unknown }> = [];
  schemas: string[] = [];

  constructor(private readonly result: { data: unknown; error: unknown }) {}

  schema(schema: string) {
    this.schemas.push(schema);
    return this;
  }

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
  assertEquals(supabase.schemas, ['api']);
  assertEquals(supabase.calls, [
    {
      fn: 'worker_enqueue_job_v1',
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
      fn: 'worker_read_job_v1',
      args: {
        p_job_id: TEST_JOB_ID,
        p_include_internal: false,
      },
    },
  ]);
});

Deno.test('worker capability repository exposes the stable service-only contract', async () => {
  const supabase = new FakeRpcSupabase({ data: { ok: true, data: null }, error: null });
  const repository = createServiceWorkerCapabilityRepository(supabase as never);

  assertEquals(repository.access, 'service-only');
  assertEquals(WORKER_CAPABILITY_CONTRACT, {
    edgeFunction: 'app_worker_jobs',
    database: {
      schema: 'api',
      routine: {
        enqueue: 'worker_enqueue_job_v1',
        read: 'worker_read_job_v1',
        readMany: 'worker_read_jobs_by_ids_v1',
        listByConcurrencyKey: 'worker_list_jobs_by_concurrency_key_v1',
        list: 'worker_list_jobs_v1',
        cancel: 'worker_cancel_job_v1',
      },
    },
  });
});

Deno.test('callWorkerJobReadManyRpc performs one bounded deduplicated batch call', async () => {
  const secondJobId = '77777777-7777-4777-8777-777777777777';
  const supabase = new FakeRpcSupabase({ data: { ok: true, data: [] }, error: null });

  await callWorkerJobReadManyRpc(supabase as never, [TEST_JOB_ID, secondJobId, TEST_JOB_ID], true);

  assertEquals(supabase.calls, [
    {
      fn: 'worker_read_jobs_by_ids_v1',
      args: {
        p_job_ids: [TEST_JOB_ID, secondJobId],
        p_include_internal: true,
      },
    },
  ]);

  assertThrows(
    () =>
      callWorkerJobReadManyRpc(
        supabase as never,
        Array.from({ length: 201 }, (_, i) => `${i}`),
      ),
    Error,
    'limited to 200',
  );
});

Deno.test(
  'callWorkerJobListByConcurrencyKeyRpc forwards the bounded concurrency capability',
  async () => {
    const supabase = new FakeRpcSupabase({
      data: {
        ok: true,
        data: [{ id: TEST_JOB_ID, status: 'running' }],
      },
      error: null,
    });

    const result = await callWorkerJobListByConcurrencyKeyRpc(supabase as never, {
      jobKind: 'lca.build_snapshot',
      statuses: ['queued', 'running'],
      concurrencyKey: 'lca.build_snapshot:full-library:request-hash',
      includeInternal: true,
    });

    assertEquals(result.ok, true);
    assertEquals(supabase.calls, [
      {
        fn: 'worker_list_jobs_by_concurrency_key_v1',
        args: {
          p_job_kind: 'lca.build_snapshot',
          p_concurrency_key: 'lca.build_snapshot:full-library:request-hash',
          p_statuses: ['queued', 'running'],
          p_limit: 20,
          p_include_internal: true,
        },
      },
    ]);

    assertThrows(
      () =>
        callWorkerJobListByConcurrencyKeyRpc(supabase as never, {
          jobKind: 'lca.build_snapshot',
          concurrencyKey: 'too-wide',
          statuses: ['queued'],
          limit: 21,
        }),
      Error,
      'between 1 and 20',
    );
  },
);

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
      fn: 'worker_list_jobs_v1',
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
      fn: 'worker_cancel_job_v1',
      args: {
        p_job_id: TEST_JOB_ID,
        p_cancelled_by: TEST_USER_ID,
        p_reason: 'user_cancelled',
      },
    },
  ]);
});
