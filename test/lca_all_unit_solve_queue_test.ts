import { assert, assertEquals } from 'jsr:@std/assert';

import type {
  LcaResultCacheEntry,
  LcaResultFamilyCapabilityRepository,
} from '../supabase/functions/_shared/capabilities/lca_result_family.ts';
import { ensureLcaAllUnitSolveQueued } from '../supabase/functions/_shared/lca_all_unit_solve_queue.ts';
import { buildCalculationEvidenceV2 } from './lca_calculation_evidence_fixture.ts';

const SNAPSHOT_ID = '10000000-0000-4000-8000-000000000001';
const USER_ID = '20000000-0000-4000-8000-000000000001';
const CACHE_ID = '30000000-0000-4000-8000-000000000001';
const LEGACY_JOB_ID = '40000000-0000-4000-8000-000000000001';
const WORKER_JOB_ID = '50000000-0000-4000-8000-000000000001';
const RESULT_ID = '60000000-0000-4000-8000-000000000001';
const NOW = '2026-08-03T00:00:00.000Z';

type WorkerState = {
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
};

function workerClient(state: WorkerState) {
  const rpc = (fn: string, args: Record<string, unknown>) => {
    state.rpcCalls.push({ fn, args });
    return Promise.resolve({
      data: {
        ok: true,
        data: { id: WORKER_JOB_ID, payload: { job_id: LEGACY_JOB_ID } },
      },
      error: null,
    });
  };
  return {
    schema(schema: string) {
      assertEquals(schema, 'api');
      return { rpc };
    },
  };
}

function cache(overrides: Partial<LcaResultCacheEntry> = {}): LcaResultCacheEntry {
  return {
    cacheId: CACHE_ID,
    scope: 'dev-v1',
    snapshotId: SNAPSHOT_ID,
    requestKey: 'request-key',
    status: 'pending',
    legacyJobId: LEGACY_JOB_ID,
    workerJobId: WORKER_JOB_ID,
    resultId: null,
    hitCount: 1,
    lastAccessedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function resultRepository(options: {
  existing?: LcaResultCacheEntry | null;
  admitted?: LcaResultCacheEntry;
  outcome?: 'accepted' | 'reused';
  calls: Array<{ method: string; value?: unknown }>;
}): LcaResultFamilyCapabilityRepository {
  return {
    access: 'service-only',
    readCache: async (request) => {
      options.calls.push({ method: 'read', value: request });
      return { ok: true, data: options.existing ?? null };
    },
    touchCache: async (cacheId) => {
      options.calls.push({ method: 'touch', value: cacheId });
      return { ok: true, data: null };
    },
    admitCache: async (request) => {
      options.calls.push({ method: 'admit', value: request });
      return {
        ok: true,
        data: {
          outcome: options.outcome ?? 'accepted',
          cache:
            options.admitted ??
            cache({
              requestKey: request.requestKey,
              legacyJobId: request.legacyJobId,
              workerJobId: request.workerJobId ?? null,
            }),
        },
      };
    },
    readJobProjection: async () => ({ ok: true, data: null }),
    readResultProjection: async () => ({ ok: true, data: null }),
    readLatestSingleSolve: async () => ({ ok: true, data: null }),
    reconcileCache: async () => {
      throw new Error('unexpected reconcile');
    },
    readLatestAllUnit: async () => ({ ok: true, data: null }),
  };
}

Deno.test('all-unit active binding performs read then touch only', async () => {
  const worker = { rpcCalls: [] } as WorkerState;
  const calls: Array<{ method: string; value?: unknown }> = [];
  const repository = resultRepository({
    calls,
    existing: cache({ status: 'running' }),
  });
  const result = await ensureLcaAllUnitSolveQueued(workerClient(worker) as never, {
    scope: 'dev-v1',
    snapshotId: SNAPSHOT_ID,
    userId: USER_ID,
    resultRepository: repository,
  });

  assert(result.ok);
  assertEquals(result.mode, 'in_progress');
  assertEquals(result.job_id, LEGACY_JOB_ID);
  assertEquals(
    calls.map((call) => call.method),
    ['read', 'touch'],
  );
  assertEquals(worker.rpcCalls.length, 0);
});

Deno.test(
  'all-unit enqueue performs read then admission and always replaces ready across races',
  async () => {
    for (const existing of [
      null,
      cache({ status: 'failed' }),
      cache({ status: 'ready', resultId: RESULT_ID }),
    ]) {
      const worker = { rpcCalls: [] } as WorkerState;
      const calls: Array<{ method: string; value?: unknown }> = [];
      const repository = resultRepository({ calls, existing });
      const result = await ensureLcaAllUnitSolveQueued(workerClient(worker) as never, {
        scope: 'dev-v1',
        snapshotId: SNAPSHOT_ID,
        userId: USER_ID,
        resultRepository: repository,
      });

      assert(result.ok);
      assertEquals(result.mode, 'queued');
      assertEquals(
        calls.map((call) => call.method),
        ['read', 'admit'],
      );
      assertEquals((calls[1].value as { replaceReady: boolean }).replaceReady, true);
      assertEquals(worker.rpcCalls.length, 1);
    }
  },
);

Deno.test('all-unit reused admission responds with the returned canonical binding', async () => {
  const worker = { rpcCalls: [] } as WorkerState;
  const calls: Array<{ method: string; value?: unknown }> = [];
  const canonicalLegacy = '70000000-0000-4000-8000-000000000001';
  const canonicalWorker = '80000000-0000-4000-8000-000000000001';
  const repository = resultRepository({
    calls,
    existing: null,
    outcome: 'reused',
    admitted: cache({ legacyJobId: canonicalLegacy, workerJobId: canonicalWorker }),
  });
  const result = await ensureLcaAllUnitSolveQueued(workerClient(worker) as never, {
    scope: 'dev-v1',
    snapshotId: SNAPSHOT_ID,
    userId: USER_ID,
    resultRepository: repository,
  });

  assert(result.ok);
  assertEquals(result.mode, 'in_progress');
  assertEquals(result.job_id, canonicalLegacy);
  assertEquals(result.worker_job_id, canonicalWorker);
  assertEquals(
    calls.map((call) => call.method),
    ['read', 'admit'],
  );
});

Deno.test('all-unit admission binds validated scope and LCIA evidence', async () => {
  const worker = { rpcCalls: [] } as WorkerState;
  const calls: Array<{ method: string; value?: unknown }> = [];
  const calculationEvidenceBinding = buildCalculationEvidenceV2('a'.repeat(64));
  const result = await ensureLcaAllUnitSolveQueued(workerClient(worker) as never, {
    scope: 'dev-v1',
    snapshotId: SNAPSHOT_ID,
    userId: USER_ID,
    calculationEvidenceBinding,
    resultRepository: resultRepository({ calls, existing: null }),
  });

  assert(result.ok);
  const payload = worker.rpcCalls[0].args.p_payload_json as Record<string, unknown>;
  assertEquals(worker.rpcCalls[0].args.p_payload_schema_version, 'lca.solve_all_unit.request.v2');
  assertEquals(payload.calculation_evidence_binding, calculationEvidenceBinding);
  assertEquals((calls[1].value as { requestPayload: unknown }).requestPayload, {
    version: 'lca_solve_v2',
    scope: 'dev-v1',
    snapshot_id: SNAPSHOT_ID,
    demand_mode: 'all_unit',
    solve: { return_x: false, return_g: false, return_h: true },
    print_level: 0,
    calculation_evidence_binding: calculationEvidenceBinding,
  });
});

Deno.test('all-unit cutover-disabled branch reads cache but never touches or admits', async () => {
  const worker = { rpcCalls: [] } as WorkerState;
  const calls: Array<{ method: string; value?: unknown }> = [];
  const result = await ensureLcaAllUnitSolveQueued(workerClient(worker) as never, {
    scope: 'dev-v1',
    snapshotId: SNAPSHOT_ID,
    userId: USER_ID,
    readEnv: (key) => (key === 'LCA_WORKER_JOBS_ENABLED' ? 'false' : undefined),
    resultRepository: resultRepository({ calls, existing: null }),
  });

  assertEquals(result, { ok: false, error: 'legacy_queue_disabled', status: 503 });
  assertEquals(
    calls.map((call) => call.method),
    ['read'],
  );
  assertEquals(worker.rpcCalls.length, 0);
});
