import { assertEquals } from 'jsr:@std/assert';

import type {
  LcaResultCacheEntry,
  LcaResultFamilyCapabilityRepository,
} from '../supabase/functions/_shared/capabilities/lca_result_family.ts';
import { admitSolveCache, resolveSolveCache } from '../supabase/functions/lca_solve/index.ts';

const SNAPSHOT_ID = '10000000-0000-4000-8000-000000000001';
const CACHE_ID = '20000000-0000-4000-8000-000000000001';
const LEGACY_JOB_ID = '30000000-0000-4000-8000-000000000001';
const WORKER_JOB_ID = '40000000-0000-4000-8000-000000000001';
const RESULT_ID = '50000000-0000-4000-8000-000000000001';
const NOW = '2026-08-03T00:00:00.000Z';

function cache(overrides: Partial<LcaResultCacheEntry> = {}): LcaResultCacheEntry {
  return {
    cacheId: CACHE_ID,
    scope: 'prod',
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

function repository(state: {
  calls: string[];
  existing?: LcaResultCacheEntry | null;
  admit?: unknown;
}): LcaResultFamilyCapabilityRepository {
  return {
    access: 'service-only',
    readCache: async () => {
      state.calls.push('read');
      return { ok: true, data: state.existing ?? null };
    },
    touchCache: async () => {
      state.calls.push('touch');
      return { ok: true, data: null };
    },
    admitCache: async () => {
      state.calls.push('admit');
      return state.admit as never;
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

Deno.test('solve ready and active bindings perform read then touch only', async () => {
  for (const existing of [
    cache({ status: 'ready', resultId: RESULT_ID }),
    cache({ status: 'running' }),
    cache({ status: 'pending', workerJobId: null }),
  ]) {
    const state = { calls: [] as string[], existing };
    const decision = await resolveSolveCache({
      scope: 'prod',
      snapshotId: SNAPSHOT_ID,
      requestKey: 'request-key',
      repository: repository(state),
    });
    assertEquals(decision?.status, 200);
    assertEquals(state.calls, ['read', 'touch']);
  }
});

Deno.test('solve failed/stale/broken binding reads only before enqueue admission', async () => {
  for (const existing of [
    cache({ status: 'failed' }),
    cache({ status: 'stale' }),
    cache({ status: 'pending', legacyJobId: null, workerJobId: null }),
    cache({ status: 'ready', resultId: null }),
  ]) {
    const state = { calls: [] as string[], existing };
    const decision = await resolveSolveCache({
      scope: 'prod',
      snapshotId: SNAPSHOT_ID,
      requestKey: 'request-key',
      repository: repository(state),
    });
    assertEquals(decision, null);
    assertEquals(state.calls, ['read']);
  }
});

Deno.test('solve admission reuses canonical binding and sanitizes failures', async () => {
  const canonicalLegacy = '60000000-0000-4000-8000-000000000001';
  const canonicalWorker = '70000000-0000-4000-8000-000000000001';
  const reusedState = {
    calls: [] as string[],
    admit: {
      ok: true,
      data: {
        outcome: 'reused',
        cache: cache({ legacyJobId: canonicalLegacy, workerJobId: canonicalWorker }),
      },
    },
  };
  const reused = await admitSolveCache({
    scope: 'prod',
    snapshotId: SNAPSHOT_ID,
    requestKey: 'request-key',
    requestPayload: { version: 'v1' },
    legacyJobId: LEGACY_JOB_ID,
    workerJobId: WORKER_JOB_ID,
    repository: repository(reusedState),
  });
  assertEquals(reused, {
    status: 200,
    body: {
      mode: 'in_progress',
      snapshot_id: SNAPSHOT_ID,
      cache_key: 'request-key',
      job_id: canonicalLegacy,
      worker_job_id: canonicalWorker,
    },
  });
  assertEquals(reusedState.calls, ['admit']);

  const failureState = {
    calls: [] as string[],
    admit: {
      ok: false,
      code: '42501',
      status: 403,
      message: 'secret',
      details: { secret: 'must-not-leak' },
    },
  };
  const failed = await admitSolveCache({
    scope: 'prod',
    snapshotId: SNAPSHOT_ID,
    requestKey: 'request-key',
    requestPayload: { version: 'v1' },
    legacyJobId: LEGACY_JOB_ID,
    workerJobId: WORKER_JOB_ID,
    repository: repository(failureState),
  });
  assertEquals(failed, { status: 500, body: { error: 'cache_admission_failed' } });
  assertEquals(failureState.calls, ['admit']);
});
