import { assertEquals } from 'jsr:@std/assert';

import type {
  LcaResultCacheEntry,
  LcaResultCacheMutation,
  LcaResultFamilyCapabilityRepository,
} from '../supabase/functions/_shared/capabilities/lca_result_family.ts';
import {
  admitContributionPathCache,
  resolveContributionPathCache,
} from '../supabase/functions/lca_contribution_path/index.ts';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const SNAPSHOT_ID = '20000000-0000-4000-8000-000000000001';
const CACHE_ID = '30000000-0000-4000-8000-000000000001';
const LEGACY_JOB_ID = '40000000-0000-4000-8000-000000000001';
const WORKER_JOB_ID = '50000000-0000-4000-8000-000000000001';
const RESULT_ID = '60000000-0000-4000-8000-000000000001';
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

function mutation(entry: LcaResultCacheEntry): LcaResultCacheMutation {
  return {
    cacheId: entry.cacheId,
    status: entry.status,
    legacyJobId: entry.legacyJobId,
    workerJobId: entry.workerJobId,
    resultId: entry.resultId,
    hitCount: entry.hitCount,
    lastAccessedAt: entry.lastAccessedAt,
    updatedAt: entry.updatedAt,
  };
}

function jobProjection(workerStatus: string) {
  return {
    ok: true as const,
    data: {
      job: {
        workerJobId: WORKER_JOB_ID,
        legacyJobId: LEGACY_JOB_ID,
        snapshotId: SNAPSHOT_ID,
        jobKind: 'lca.contribution_path',
        status: workerStatus,
        timestamps: { createdAt: NOW, updatedAt: NOW },
      },
      workerJob: { id: WORKER_JOB_ID },
      result: null,
    },
  };
}

function repository(state: {
  calls: string[];
  existing: LcaResultCacheEntry | null;
  reconcile?: unknown;
  admit?: unknown;
}): LcaResultFamilyCapabilityRepository {
  return {
    access: 'service-only',
    readCache: async () => {
      state.calls.push('read');
      return { ok: true, data: state.existing };
    },
    touchCache: async () => {
      state.calls.push('touch');
      return { ok: true, data: null };
    },
    reconcileCache: async () => {
      state.calls.push('reconcile');
      return state.reconcile as never;
    },
    admitCache: async () => {
      state.calls.push('admit');
      return state.admit as never;
    },
    readJobProjection: async () => ({ ok: true, data: null }),
    readResultProjection: async () => ({ ok: true, data: null }),
    readLatestSingleSolve: async () => ({ ok: true, data: null }),
    readLatestAllUnit: async () => ({ ok: true, data: null }),
  };
}

function resolve(repository: LcaResultFamilyCapabilityRepository) {
  return resolveContributionPathCache({
    scope: 'prod',
    snapshotId: SNAPSHOT_ID,
    requestKey: 'request-key',
    userId: USER_ID,
    repository,
  });
}

Deno.test('contribution ready and legacy-only active branches only touch once', async () => {
  for (const existing of [
    cache({ status: 'ready', resultId: RESULT_ID }),
    cache({ status: 'running', workerJobId: null }),
  ]) {
    const state = { calls: [] as string[], existing };
    const decision = await resolve(repository(state));
    assertEquals(decision.kind, 'respond');
    assertEquals(state.calls, ['read', 'touch']);
    if (decision.kind === 'respond') assertEquals(decision.status, 200);
  }
});

Deno.test('contribution result_pending reconciles once without touch or admission', async () => {
  const pending = cache({ status: 'pending' });
  const state = {
    calls: [] as string[],
    existing: pending,
    reconcile: {
      ok: true,
      data: {
        code: 'result_pending',
        cache: mutation({ ...pending, hitCount: 2 }),
        workerStatus: 'completed',
        jobProjection: jobProjection('completed'),
      },
    },
  };
  const decision = await resolve(repository(state));
  assertEquals(state.calls, ['read', 'reconcile']);
  assertEquals(decision, {
    kind: 'respond',
    status: 200,
    body: {
      mode: 'in_progress',
      snapshot_id: SNAPSHOT_ID,
      cache_key: 'request-key',
      job_id: LEGACY_JOB_ID,
      worker_job_id: WORKER_JOB_ID,
    },
  });
});

Deno.test(
  'contribution terminal reconciliation converges over two polls without command overlap',
  async () => {
    for (const workerStatus of ['failed', 'stale', 'cancelled']) {
      const terminal = cache({ status: 'failed', hitCount: 2 });
      const state = {
        calls: [] as string[],
        existing: cache({ status: 'running' }),
        reconcile: {
          ok: true,
          data: {
            code: 'reconciled',
            cache: mutation(terminal),
            workerStatus,
            jobProjection: jobProjection(workerStatus),
          },
        },
        admit: {
          ok: true,
          data: { outcome: 'accepted', cache: cache({ status: 'pending', hitCount: 3 }) },
        },
      };
      const repo = repository(state);

      const firstPoll = await resolve(repo);
      assertEquals(firstPoll.kind, 'respond');
      assertEquals(state.calls, ['read', 'reconcile']);

      state.existing = terminal;
      const secondPoll = await resolve(repo);
      assertEquals(secondPoll, { kind: 'continue', retryAfterJobId: LEGACY_JOB_ID });
      assertEquals(state.calls, ['read', 'reconcile', 'read']);

      const admitted = await admitContributionPathCache({
        scope: 'prod',
        snapshotId: SNAPSHOT_ID,
        requestKey: 'request-key',
        requestPayload: { version: 'v1' },
        legacyJobId: LEGACY_JOB_ID,
        workerJobId: WORKER_JOB_ID,
        repository: repo,
      });
      assertEquals(admitted.status, 202);
      assertEquals(state.calls, ['read', 'reconcile', 'read', 'admit']);
    }
  },
);

Deno.test('contribution reconcile/admission errors are fail-closed and sanitized', async () => {
  const reconcileState = {
    calls: [] as string[],
    existing: cache({ status: 'running' }),
    reconcile: {
      ok: false,
      code: '42501',
      status: 403,
      message: 'secret message',
      details: { secret: 'must-not-leak' },
    },
  };
  const reconcileDecision = await resolve(repository(reconcileState));
  assertEquals(reconcileDecision, {
    kind: 'respond',
    status: 500,
    body: { error: 'cache_reconcile_failed' },
  });
  assertEquals(reconcileState.calls, ['read', 'reconcile']);

  const admitState = {
    calls: [] as string[],
    existing: null,
    admit: {
      ok: false,
      code: 'AUTH_REQUIRED',
      status: 401,
      message: 'secret message',
      details: { secret: 'must-not-leak' },
    },
  };
  const admission = await admitContributionPathCache({
    scope: 'prod',
    snapshotId: SNAPSHOT_ID,
    requestKey: 'request-key',
    requestPayload: { version: 'v1' },
    legacyJobId: LEGACY_JOB_ID,
    workerJobId: WORKER_JOB_ID,
    repository: repository(admitState),
  });
  assertEquals(admission, { status: 500, body: { error: 'cache_admission_failed' } });
  assertEquals(admitState.calls, ['admit']);
});

Deno.test('contribution reused admission returns the canonical binding', async () => {
  const canonicalLegacy = '70000000-0000-4000-8000-000000000001';
  const canonicalWorker = '80000000-0000-4000-8000-000000000001';
  const state = {
    calls: [] as string[],
    existing: null,
    admit: {
      ok: true,
      data: {
        outcome: 'reused',
        cache: cache({ legacyJobId: canonicalLegacy, workerJobId: canonicalWorker }),
      },
    },
  };
  const admission = await admitContributionPathCache({
    scope: 'prod',
    snapshotId: SNAPSHOT_ID,
    requestKey: 'request-key',
    requestPayload: { version: 'v1' },
    legacyJobId: LEGACY_JOB_ID,
    workerJobId: WORKER_JOB_ID,
    repository: repository(state),
  });
  assertEquals(admission, {
    status: 200,
    body: {
      mode: 'in_progress',
      snapshot_id: SNAPSHOT_ID,
      cache_key: 'request-key',
      job_id: canonicalLegacy,
      worker_job_id: canonicalWorker,
    },
  });
  assertEquals(state.calls, ['admit']);
});
