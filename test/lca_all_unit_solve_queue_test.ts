import { assert, assertEquals } from 'jsr:@std/assert';

import { ensureLcaAllUnitSolveQueued } from '../supabase/functions/_shared/lca_all_unit_solve_queue.ts';

type MockError = { code: string; message: string };
type MockCacheRow = {
  id: string;
  status: string;
  job_id: string | null;
  worker_job_id: string | null;
  result_id: string | null;
  hit_count: number;
};

type MockState = {
  cacheRow: MockCacheRow | null;
  selectError: MockError | null;
  updateError: MockError | null;
  insertError: MockError | null;
  rpcData: unknown;
  rpcError: MockError | null;
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  updateCalls: Array<{ table: string; patch: Record<string, unknown> }>;
  insertCalls: Array<{ table: string; row: Record<string, unknown> }>;
};

function createMockState(overrides: Partial<MockState> = {}): MockState {
  return {
    cacheRow: null,
    selectError: null,
    updateError: null,
    insertError: null,
    rpcData: {
      ok: true,
      data: {
        id: 'worker-job-1',
        payload: {
          job_id: 'lca-job-1',
          snapshot_id: 'snapshot-1',
        },
      },
    },
    rpcError: null,
    rpcCalls: [],
    updateCalls: [],
    insertCalls: [],
    ...overrides,
  };
}

function createSupabaseMock(state: MockState) {
  return {
    from(table: string) {
      return createTableBuilder(state, table);
    },
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: state.rpcData, error: state.rpcError });
    },
  };
}

function createTableBuilder(state: MockState, table: string) {
  return {
    select(_columns: string) {
      return this;
    },
    eq(_column: string, _value: unknown) {
      return this;
    },
    maybeSingle() {
      return Promise.resolve({ data: state.cacheRow, error: state.selectError });
    },
    update(patch: Record<string, unknown>) {
      state.updateCalls.push({ table, patch });
      return {
        eq: (_column: string, _value: unknown) =>
          Promise.resolve({ data: null, error: state.updateError }),
      };
    },
    insert(row: Record<string, unknown>) {
      state.insertCalls.push({ table, row });
      return Promise.resolve({ data: null, error: state.insertError });
    },
  };
}

Deno.test('ensureLcaAllUnitSolveQueued reuses pending cache worker job', async () => {
  const state = createMockState({
    cacheRow: {
      id: 'cache-1',
      status: 'running',
      job_id: 'lca-job-active',
      worker_job_id: 'worker-job-active',
      result_id: null,
      hit_count: 2,
    },
  });

  const result = await ensureLcaAllUnitSolveQueued(createSupabaseMock(state) as never, {
    scope: 'dev-v1',
    snapshotId: 'snapshot-1',
    userId: 'user-1',
  });

  assert(result.ok);
  assertEquals(result.mode, 'in_progress');
  assertEquals(result.job_id, 'lca-job-active');
  assertEquals(result.worker_job_id, 'worker-job-active');
  assertEquals(state.rpcCalls.length, 0);
  assertEquals(state.insertCalls.length, 0);
  assertEquals(state.updateCalls.length, 1);
  assertEquals(state.updateCalls[0].patch.hit_count, 3);
});

Deno.test(
  'ensureLcaAllUnitSolveQueued enqueues all-unit solve and inserts pending cache',
  async () => {
    const state = createMockState();

    const result = await ensureLcaAllUnitSolveQueued(createSupabaseMock(state) as never, {
      scope: 'dev-v1',
      snapshotId: 'snapshot-1',
      userId: 'user-1',
    });

    assert(result.ok);
    assertEquals(result.mode, 'queued');
    assertEquals(result.job_id, 'lca-job-1');
    assertEquals(result.worker_job_id, 'worker-job-1');
    assertEquals(state.rpcCalls.length, 1);
    assertEquals(state.insertCalls.length, 1);

    const rpcArgs = state.rpcCalls[0].args;
    assertEquals(rpcArgs.p_job_kind, 'lca.solve_all_unit');
    assertEquals(rpcArgs.p_payload_schema_version, 'lca.solve_all_unit.request.v1');
    assertEquals(rpcArgs.p_subject_type, 'lca_job');
    assertEquals(rpcArgs.p_subject_version, 'snapshot-1');
    assertEquals(rpcArgs.p_requested_by, 'user-1');
    assertEquals(rpcArgs.p_queue_key, 'snapshot-1');
    assertEquals(rpcArgs.p_request_hash, result.cache_key);

    const payload = rpcArgs.p_payload_json as Record<string, unknown>;
    assertEquals(payload.type, 'solve_all_unit');
    assertEquals(payload.snapshot_id, 'snapshot-1');
    assertEquals(payload.solve, { return_x: false, return_g: false, return_h: true });

    const inserted = state.insertCalls[0].row;
    assertEquals(inserted.scope, 'dev-v1');
    assertEquals(inserted.snapshot_id, 'snapshot-1');
    assertEquals(inserted.request_key, result.cache_key);
    assertEquals(inserted.status, 'pending');
    assertEquals(inserted.job_id, 'lca-job-1');
    assertEquals(inserted.worker_job_id, 'worker-job-1');
  },
);

Deno.test(
  'ensureLcaAllUnitSolveQueued requeues ready cache when latest query pointer is missing',
  async () => {
    const state = createMockState({
      cacheRow: {
        id: 'cache-ready',
        status: 'ready',
        job_id: 'old-lca-job',
        worker_job_id: 'old-worker-job',
        result_id: 'old-result',
        hit_count: 4,
      },
    });

    const result = await ensureLcaAllUnitSolveQueued(createSupabaseMock(state) as never, {
      scope: 'dev-v1',
      snapshotId: 'snapshot-1',
      userId: 'user-1',
    });

    assert(result.ok);
    assertEquals(result.mode, 'queued');
    assertEquals(state.rpcCalls.length, 1);
    assertEquals(state.insertCalls.length, 0);
    assertEquals(state.updateCalls.length, 2);
    assertEquals(state.updateCalls[1].patch.status, 'pending');
    assertEquals(state.updateCalls[1].patch.job_id, 'lca-job-1');
    assertEquals(state.updateCalls[1].patch.worker_job_id, 'worker-job-1');
  },
);

Deno.test(
  'ensureLcaAllUnitSolveQueued fails closed when worker jobs cutover is disabled',
  async () => {
    const state = createMockState();

    const result = await ensureLcaAllUnitSolveQueued(createSupabaseMock(state) as never, {
      scope: 'dev-v1',
      snapshotId: 'snapshot-1',
      userId: 'user-1',
      readEnv: (key) => (key === 'LCA_WORKER_JOBS_ENABLED' ? 'false' : undefined),
    });

    assertEquals(result, { ok: false, error: 'legacy_queue_disabled', status: 503 });
    assertEquals(state.rpcCalls.length, 0);
    assertEquals(state.insertCalls.length, 0);
  },
);
