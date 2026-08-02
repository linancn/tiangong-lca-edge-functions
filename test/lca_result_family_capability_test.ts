import { assert, assertEquals } from 'jsr:@std/assert';

import {
  createLcaResultFamilyCapabilityRepository,
  LCA_RESULT_FAMILY_CAPABILITY_CONTRACT,
  type LcaResultCapabilityResult,
} from '../supabase/functions/_shared/capabilities/lca_result_family.ts';
import type {
  RequestJwtSupabaseClient,
  ServiceRoleSupabaseClient,
} from '../supabase/functions/_shared/supabase_client.ts';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const WORKER_JOB_ID = '20000000-0000-4000-8000-000000000001';
const LEGACY_JOB_ID = '30000000-0000-4000-8000-000000000001';
const SNAPSHOT_ID = '40000000-0000-4000-8000-000000000001';
const RESULT_ID = '50000000-0000-4000-8000-000000000001';
const CACHE_ID = '60000000-0000-4000-8000-000000000001';
const CREATED_AT = '2026-08-03T01:02:03.000Z';
const UPDATED_AT = '2026-08-03T01:03:04.000Z';

type RpcError = {
  code: string;
  message: string;
  details: string;
  hint: string;
};

type RpcResponse = { data: unknown; error: RpcError | null };
type RpcCall = { schema: string; fn: string; args?: Record<string, unknown> };

class FakeServiceClient {
  readonly calls: RpcCall[] = [];
  rootRpcCalls = 0;
  relationCalls = 0;

  constructor(
    private readonly respond: (
      fn: string,
      args: Record<string, unknown> | undefined,
      callIndex: number,
    ) => RpcResponse,
  ) {}

  schema(schema: string) {
    return {
      rpc: (fn: string, args?: Record<string, unknown>) => {
        this.calls.push({
          schema,
          fn,
          args: args ? structuredClone(args) : undefined,
        });
        return Promise.resolve(this.respond(fn, args, this.calls.length - 1));
      },
    };
  }

  rpc(): never {
    this.rootRpcCalls += 1;
    throw new Error('result-family adapter must not call root/default-schema rpc');
  }

  from(): never {
    this.relationCalls += 1;
    throw new Error('result-family adapter must not fall back to a relation');
  }
}

function typeCheckClientSeparation(
  requestClient: RequestJwtSupabaseClient,
  serviceClient: ServiceRoleSupabaseClient,
) {
  // @ts-expect-error Request-JWT credentials cannot enter this service-only adapter.
  createLcaResultFamilyCapabilityRepository(requestClient);
  createLcaResultFamilyCapabilityRepository(serviceClient);
}
void typeCheckClientSeparation;

function artifact() {
  return {
    artifactUrl: 'https://example.invalid/storage/v1/s3/lca_results/result.h5',
    artifactFormat: 'hdf5:v1',
    artifactByteSize: 512,
    artifactSha256: 'a'.repeat(64),
  };
}

function resultItem(overrides: Record<string, unknown> = {}) {
  return {
    resultId: RESULT_ID,
    legacyJobId: LEGACY_JOB_ID,
    workerJobId: WORKER_JOB_ID,
    snapshotId: SNAPSHOT_ID,
    createdAt: CREATED_AT,
    diagnostics: { iterations: 4 },
    artifact: artifact(),
    ...overrides,
  };
}

function jobItem(overrides: Record<string, unknown> = {}) {
  return {
    workerJobId: WORKER_JOB_ID,
    legacyJobId: LEGACY_JOB_ID,
    snapshotId: SNAPSHOT_ID,
    jobKind: 'lca.solve_one',
    jobType: 'solve_one',
    status: 'completed',
    phase: 'persisted',
    progress: 1,
    payload: { demand: 1 },
    diagnostics: { warnings: [] },
    timestamps: {
      createdAt: CREATED_AT,
      startedAt: CREATED_AT,
      finishedAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
    },
    ...overrides,
  };
}

function jobProjection(result: unknown = resultItem()) {
  return {
    job: jobItem(),
    workerJob: { id: WORKER_JOB_ID, status: 'completed' },
    result,
  };
}

function resultProjection() {
  return {
    result: resultItem(),
    job: jobItem(),
    workerJob: { id: WORKER_JOB_ID, status: 'completed' },
  };
}

function latestSingle(overrides: Record<string, unknown> = {}) {
  return {
    snapshotId: SNAPSHOT_ID,
    processIndex: 7,
    amount: 1.5,
    cache: {
      cacheId: CACHE_ID,
      requestKey: 'request-key',
      status: 'ready',
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    },
    result: resultItem(),
    workerJob: { id: WORKER_JOB_ID, status: 'completed' },
    ...overrides,
  };
}

function cacheEntry(overrides: Record<string, unknown> = {}) {
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
    lastAccessedAt: UPDATED_AT,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function cacheMutation(overrides: Record<string, unknown> = {}) {
  const value = cacheEntry(overrides);
  return {
    cacheId: value.cacheId,
    status: value.status,
    legacyJobId: value.legacyJobId,
    workerJobId: value.workerJobId,
    resultId: value.resultId,
    hitCount: value.hitCount,
    lastAccessedAt: value.lastAccessedAt,
    updatedAt: value.updatedAt,
  };
}

function ok(data: unknown): RpcResponse {
  return { data: { ok: true, data }, error: null };
}

function clientFor(response: RpcResponse) {
  return new FakeServiceClient(() => structuredClone(response));
}

async function expectInvalid(result: Promise<LcaResultCapabilityResult<unknown>>, code: string) {
  const observed = await result;
  assert(!observed.ok, `expected ${code}, received success`);
  assertEquals(observed.code, code);
  assertEquals(observed.status, 500);
}

Deno.test(
  'LCA result capability binds service identity, api schema, all 8 routines, and exact args',
  async () => {
    const responses: Record<string, RpcResponse> = {
      lca_read_job_projection_v1: ok(jobProjection()),
      lca_read_result_projection_v1: ok(resultProjection()),
      lca_read_latest_single_solve_result_v1: ok(latestSingle()),
      lca_read_result_cache_v1: ok(cacheEntry()),
      cmd_lca_touch_result_cache_v1: ok(cacheMutation({ hitCount: 2 })),
      cmd_lca_admit_result_cache_v1: {
        data: { ok: true, outcome: 'accepted', data: cacheEntry() },
        error: null,
      },
      cmd_lca_reconcile_result_cache_v1: {
        data: {
          ok: true,
          code: 'reconciled',
          data: {
            cache: cacheMutation({
              status: 'ready',
              resultId: RESULT_ID,
              hitCount: 2,
            }),
            workerStatus: 'completed',
            jobProjection: { ok: true, data: jobProjection() },
          },
        },
        error: null,
      },
      lca_read_latest_all_unit_result_v1: ok({
        snapshotId: SNAPSHOT_ID,
        resultId: RESULT_ID,
        computedAt: UPDATED_AT,
        queryArtifactUrl: 'https://example.invalid/query.jsonl',
        queryArtifactFormat: 'jsonl:v1',
      }),
    };
    const client = new FakeServiceClient((fn) => responses[fn]);
    const repository = createLcaResultFamilyCapabilityRepository(client as never);

    assertEquals(repository.access, 'service-only');
    assert(
      (
        await repository.readJobProjection({
          requestedBy: USER_ID,
          workerJobId: WORKER_JOB_ID,
          legacyJobId: LEGACY_JOB_ID,
          includeInternal: true,
        })
      ).ok,
    );
    assert(
      (
        await repository.readResultProjection({
          requestedBy: USER_ID,
          resultId: RESULT_ID,
          requiredArtifactFormat: 'hdf5:v1',
          includeInternal: true,
        })
      ).ok,
    );
    assert(
      (
        await repository.readLatestSingleSolve({
          requestedBy: USER_ID,
          snapshotId: SNAPSHOT_ID,
          processIndex: 7,
        })
      ).ok,
    );
    assert(
      (
        await repository.readCache({
          scope: 'prod',
          snapshotId: SNAPSHOT_ID,
          requestKey: 'request-key',
        })
      ).ok,
    );
    assert((await repository.touchCache(CACHE_ID)).ok);
    assert(
      (
        await repository.admitCache({
          scope: 'prod',
          snapshotId: SNAPSHOT_ID,
          requestKey: 'request-key',
          requestPayload: { demand_mode: 'single' },
          legacyJobId: LEGACY_JOB_ID,
          workerJobId: WORKER_JOB_ID,
          replaceReady: true,
        })
      ).ok,
    );
    assert(
      (
        await repository.reconcileCache({
          requestedBy: USER_ID,
          cacheId: CACHE_ID,
        })
      ).ok,
    );
    assert((await repository.readLatestAllUnit(SNAPSHOT_ID)).ok);

    assertEquals(client.calls, [
      {
        schema: 'api',
        fn: 'lca_read_job_projection_v1',
        args: {
          p_requested_by: USER_ID,
          p_worker_job_id: WORKER_JOB_ID,
          p_legacy_job_id: LEGACY_JOB_ID,
          p_include_internal: true,
        },
      },
      {
        schema: 'api',
        fn: 'lca_read_result_projection_v1',
        args: {
          p_requested_by: USER_ID,
          p_result_id: RESULT_ID,
          p_required_artifact_format: 'hdf5:v1',
          p_include_internal: true,
        },
      },
      {
        schema: 'api',
        fn: 'lca_read_latest_single_solve_result_v1',
        args: {
          p_requested_by: USER_ID,
          p_snapshot_id: SNAPSHOT_ID,
          p_process_index: 7,
        },
      },
      {
        schema: 'api',
        fn: 'lca_read_result_cache_v1',
        args: {
          p_scope: 'prod',
          p_snapshot_id: SNAPSHOT_ID,
          p_request_key: 'request-key',
        },
      },
      {
        schema: 'api',
        fn: 'cmd_lca_touch_result_cache_v1',
        args: { p_cache_id: CACHE_ID },
      },
      {
        schema: 'api',
        fn: 'cmd_lca_admit_result_cache_v1',
        args: {
          p_scope: 'prod',
          p_snapshot_id: SNAPSHOT_ID,
          p_request_key: 'request-key',
          p_request_payload: { demand_mode: 'single' },
          p_legacy_job_id: LEGACY_JOB_ID,
          p_worker_job_id: WORKER_JOB_ID,
          p_replace_ready: true,
        },
      },
      {
        schema: 'api',
        fn: 'cmd_lca_reconcile_result_cache_v1',
        args: { p_requested_by: USER_ID, p_cache_id: CACHE_ID },
      },
      {
        schema: 'api',
        fn: 'lca_read_latest_all_unit_result_v1',
        args: { p_snapshot_id: SNAPSHOT_ID },
      },
    ]);
    assertEquals(client.rootRpcCalls, 0);
    assertEquals(client.relationCalls, 0);
    assertEquals(LCA_RESULT_FAMILY_CAPABILITY_CONTRACT.schema, 'api');
    assertEquals(LCA_RESULT_FAMILY_CAPABILITY_CONTRACT.fallback, 'none');
    assertEquals(LCA_RESULT_FAMILY_CAPABILITY_CONTRACT.databaseCommit.length, 40);
    assertEquals(LCA_RESULT_FAMILY_CAPABILITY_CONTRACT.migrationHead, '20260802190427');
  },
);

Deno.test('LCA result capability maps transport errors without fallback', async () => {
  for (const testCase of [
    { code: '42501', status: 403 },
    { code: 'AUTH_REQUIRED', status: 401 },
    { code: 'PGRST116', status: 404 },
  ]) {
    const client = clientFor({
      data: null,
      error: {
        code: testCase.code,
        message: `transport:${testCase.code}`,
        details: 'transport-details',
        hint: '',
      },
    });
    const result = await createLcaResultFamilyCapabilityRepository(client as never).readCache({
      scope: 'prod',
      snapshotId: SNAPSHOT_ID,
      requestKey: 'request-key',
    });
    assertEquals(result, {
      ok: false,
      code: testCase.code,
      status: testCase.status,
      message: `transport:${testCase.code}`,
      details: 'transport-details',
    });
    assertEquals(client.calls.length, 1);
    assertEquals(client.calls[0].schema, 'api');
    assertEquals(client.rootRpcCalls, 0);
    assertEquals(client.relationCalls, 0);
  }
});

Deno.test('LCA result capability preserves exact database business failure fields', async () => {
  const details = {
    resultId: RESULT_ID,
    expectedArtifactFormat: 'contribution-path:v1',
  };
  const client = clientFor({
    data: {
      ok: false,
      code: 'UNSUPPORTED_LCA_RESULT_ARTIFACT_FORMAT',
      status: 409,
      message: 'format mismatch',
      details,
    },
    error: null,
  });
  const result = await createLcaResultFamilyCapabilityRepository(
    client as never,
  ).readResultProjection({ requestedBy: USER_ID, resultId: RESULT_ID });
  assertEquals(result, {
    ok: false,
    code: 'UNSUPPORTED_LCA_RESULT_ARTIFACT_FORMAT',
    status: 409,
    message: 'format mismatch',
    details,
  });
});

Deno.test('LCA result capability preserves exact null/not-found success semantics', async () => {
  const methods = [
    (repository: ReturnType<typeof createLcaResultFamilyCapabilityRepository>) =>
      repository.readJobProjection({
        requestedBy: USER_ID,
        workerJobId: WORKER_JOB_ID,
      }),
    (repository: ReturnType<typeof createLcaResultFamilyCapabilityRepository>) =>
      repository.readResultProjection({
        requestedBy: USER_ID,
        resultId: RESULT_ID,
      }),
    (repository: ReturnType<typeof createLcaResultFamilyCapabilityRepository>) =>
      repository.readLatestSingleSolve({
        requestedBy: USER_ID,
        snapshotId: SNAPSHOT_ID,
        processIndex: 7,
      }),
    (repository: ReturnType<typeof createLcaResultFamilyCapabilityRepository>) =>
      repository.readCache({
        scope: 'prod',
        snapshotId: SNAPSHOT_ID,
        requestKey: 'missing',
      }),
    (repository: ReturnType<typeof createLcaResultFamilyCapabilityRepository>) =>
      repository.touchCache(CACHE_ID),
    (repository: ReturnType<typeof createLcaResultFamilyCapabilityRepository>) =>
      repository.readLatestAllUnit(SNAPSHOT_ID),
  ];
  for (const invoke of methods) {
    const repository = createLcaResultFamilyCapabilityRepository(clientFor(ok(null)) as never);
    assertEquals(await invoke(repository), { ok: true, data: null });
  }

  for (const code of ['cache_not_found', 'job_not_found'] as const) {
    const repository = createLcaResultFamilyCapabilityRepository(
      clientFor({
        data: { ok: true, code, data: null },
        error: null,
      }) as never,
    );
    assertEquals(
      await repository.reconcileCache({
        requestedBy: USER_ID,
        cacheId: CACHE_ID,
      }),
      {
        ok: true,
        data: { code, cache: null, workerStatus: null, jobProjection: null },
      },
    );
  }
});

Deno.test(
  'projection decoders reject scalar, array, missing fields, invalid UUID/time, and non-finite numbers',
  async () => {
    for (const malformed of [
      'scalar',
      [],
      {},
      { ...jobProjection(), job: jobItem({ workerJobId: 'not-a-uuid' }) },
      {
        ...jobProjection(),
        job: jobItem({
          timestamps: { createdAt: 'not-a-time', updatedAt: UPDATED_AT },
        }),
      },
      {
        ...jobProjection(),
        job: jobItem({ progress: Number.POSITIVE_INFINITY }),
      },
      { ...jobProjection(), job: jobItem({ jobKind: 'not-an-lca-job' }) },
      { ...jobProjection(), job: jobItem({ status: 'not-a-worker-status' }) },
    ]) {
      const repository = createLcaResultFamilyCapabilityRepository(
        clientFor(ok(malformed)) as never,
      );
      await expectInvalid(
        repository.readJobProjection({
          requestedBy: USER_ID,
          workerJobId: WORKER_JOB_ID,
        }),
        'INVALID_LCA_JOB_PROJECTION',
      );
    }

    for (const malformed of [
      'scalar',
      [],
      {},
      { ...resultProjection(), result: resultItem({ resultId: 'not-a-uuid' }) },
      {
        ...resultProjection(),
        result: resultItem({ createdAt: 'not-a-time' }),
      },
      {
        ...resultProjection(),
        result: resultItem({
          artifact: { ...artifact(), artifactByteSize: Number.NaN },
        }),
      },
    ]) {
      const repository = createLcaResultFamilyCapabilityRepository(
        clientFor(ok(malformed)) as never,
      );
      await expectInvalid(
        repository.readResultProjection({
          requestedBy: USER_ID,
          resultId: RESULT_ID,
        }),
        'INVALID_LCA_RESULT_PROJECTION',
      );
    }

    for (const malformed of [
      'scalar',
      [],
      {},
      latestSingle({ snapshotId: 'not-a-uuid' }),
      latestSingle({ processIndex: 1.5 }),
      latestSingle({ amount: Number.NEGATIVE_INFINITY }),
      latestSingle({
        cache: { ...latestSingle().cache, updatedAt: 'not-a-time' },
      }),
      latestSingle({
        cache: { ...latestSingle().cache, status: 'pending' },
      }),
    ]) {
      const repository = createLcaResultFamilyCapabilityRepository(
        clientFor(ok(malformed)) as never,
      );
      await expectInvalid(
        repository.readLatestSingleSolve({
          requestedBy: USER_ID,
          snapshotId: SNAPSHOT_ID,
          processIndex: 7,
        }),
        'INVALID_LCA_SINGLE_SOLVE_PROJECTION',
      );
    }
  },
);

Deno.test(
  'cache, touch, admission, and latest-all-unit decoders reject malformed values',
  async () => {
    for (const malformed of [
      'scalar',
      [],
      {},
      cacheEntry({ cacheId: 'not-a-uuid' }),
      cacheEntry({ hitCount: Number.POSITIVE_INFINITY }),
      cacheEntry({ updatedAt: 'not-a-time' }),
      cacheEntry({ status: 'not-a-cache-status' }),
    ]) {
      const repository = createLcaResultFamilyCapabilityRepository(
        clientFor(ok(malformed)) as never,
      );
      await expectInvalid(
        repository.readCache({
          scope: 'prod',
          snapshotId: SNAPSHOT_ID,
          requestKey: 'request-key',
        }),
        'INVALID_LCA_RESULT_CACHE_RESPONSE',
      );
    }

    for (const malformed of [
      'scalar',
      [],
      {},
      cacheMutation({ resultId: 'not-a-uuid' }),
      cacheMutation({ hitCount: Number.NaN }),
      cacheMutation({ lastAccessedAt: 'not-a-time' }),
      cacheMutation({ status: 'not-a-cache-status' }),
    ]) {
      const repository = createLcaResultFamilyCapabilityRepository(
        clientFor(ok(malformed)) as never,
      );
      await expectInvalid(repository.touchCache(CACHE_ID), 'INVALID_LCA_RESULT_CACHE_RESPONSE');
    }

    for (const malformed of [
      null,
      'scalar',
      { ok: true, data: cacheEntry() },
      { ok: true, outcome: 'unknown', data: cacheEntry() },
      {
        ok: true,
        outcome: 'accepted',
        data: cacheEntry({ snapshotId: 'not-a-uuid' }),
      },
    ]) {
      const repository = createLcaResultFamilyCapabilityRepository(
        clientFor({
          data: malformed,
          error: null,
        }) as never,
      );
      await expectInvalid(
        repository.admitCache({
          scope: 'prod',
          snapshotId: SNAPSHOT_ID,
          requestKey: 'request-key',
          requestPayload: {},
          legacyJobId: LEGACY_JOB_ID,
        }),
        'INVALID_LCA_RESULT_CACHE_RESPONSE',
      );
    }

    for (const malformed of [
      'scalar',
      [],
      {},
      {
        snapshotId: 'not-a-uuid',
        resultId: RESULT_ID,
        computedAt: UPDATED_AT,
        queryArtifactUrl: 'https://example.invalid/query.jsonl',
        queryArtifactFormat: 'jsonl:v1',
      },
      {
        snapshotId: SNAPSHOT_ID,
        resultId: RESULT_ID,
        computedAt: 'not-a-time',
        queryArtifactUrl: 'https://example.invalid/query.jsonl',
        queryArtifactFormat: 'jsonl:v1',
      },
    ]) {
      const repository = createLcaResultFamilyCapabilityRepository(
        clientFor(ok(malformed)) as never,
      );
      await expectInvalid(
        repository.readLatestAllUnit(SNAPSHOT_ID),
        'INVALID_LCA_LATEST_ALL_UNIT_RESPONSE',
      );
    }
  },
);

Deno.test('all facade responses must preserve the exact requested object identity', async () => {
  const otherWorkerId = '90000000-0000-4000-8000-000000000001';
  const otherLegacyId = '90000000-0000-4000-8000-000000000002';
  const otherResultId = '90000000-0000-4000-8000-000000000003';
  const otherSnapshotId = '90000000-0000-4000-8000-000000000004';
  const otherCacheId = '90000000-0000-4000-8000-000000000005';
  const otherJobProjection = {
    job: jobItem({ workerJobId: otherWorkerId, legacyJobId: otherLegacyId }),
    workerJob: { id: otherWorkerId, status: 'completed' },
    result: resultItem({ workerJobId: otherWorkerId, legacyJobId: otherLegacyId }),
  };

  await expectInvalid(
    createLcaResultFamilyCapabilityRepository(
      clientFor(ok(otherJobProjection)) as never,
    ).readJobProjection({ requestedBy: USER_ID, workerJobId: WORKER_JOB_ID }),
    'INVALID_LCA_JOB_PROJECTION',
  );
  await expectInvalid(
    createLcaResultFamilyCapabilityRepository(
      clientFor(
        ok({ ...resultProjection(), result: resultItem({ resultId: otherResultId }) }),
      ) as never,
    ).readResultProjection({ requestedBy: USER_ID, resultId: RESULT_ID }),
    'INVALID_LCA_RESULT_PROJECTION',
  );
  await expectInvalid(
    createLcaResultFamilyCapabilityRepository(
      clientFor(ok(latestSingle({ snapshotId: otherSnapshotId }))) as never,
    ).readLatestSingleSolve({ requestedBy: USER_ID, snapshotId: SNAPSHOT_ID, processIndex: 7 }),
    'INVALID_LCA_SINGLE_SOLVE_PROJECTION',
  );
  await expectInvalid(
    createLcaResultFamilyCapabilityRepository(
      clientFor(ok(cacheEntry({ requestKey: 'another-request' }))) as never,
    ).readCache({ scope: 'prod', snapshotId: SNAPSHOT_ID, requestKey: 'request-key' }),
    'INVALID_LCA_RESULT_CACHE_RESPONSE',
  );
  await expectInvalid(
    createLcaResultFamilyCapabilityRepository(
      clientFor(ok(cacheMutation({ cacheId: otherCacheId }))) as never,
    ).touchCache(CACHE_ID),
    'INVALID_LCA_RESULT_CACHE_RESPONSE',
  );
  await expectInvalid(
    createLcaResultFamilyCapabilityRepository(
      clientFor({
        data: {
          ok: true,
          outcome: 'accepted',
          data: cacheEntry({ scope: 'another-scope' }),
        },
        error: null,
      }) as never,
    ).admitCache({
      scope: 'prod',
      snapshotId: SNAPSHOT_ID,
      requestKey: 'request-key',
      requestPayload: {},
      legacyJobId: LEGACY_JOB_ID,
    }),
    'INVALID_LCA_RESULT_CACHE_RESPONSE',
  );
  await expectInvalid(
    createLcaResultFamilyCapabilityRepository(
      clientFor({
        data: {
          ok: true,
          code: 'reconciled',
          data: {
            cache: cacheMutation({
              cacheId: otherCacheId,
              status: 'ready',
              resultId: RESULT_ID,
            }),
            workerStatus: 'completed',
            jobProjection: { ok: true, data: jobProjection() },
          },
        },
        error: null,
      }) as never,
    ).reconcileCache({ requestedBy: USER_ID, cacheId: CACHE_ID }),
    'INVALID_LCA_RESULT_CACHE_RESPONSE',
  );
  await expectInvalid(
    createLcaResultFamilyCapabilityRepository(
      clientFor(
        ok({
          snapshotId: otherSnapshotId,
          resultId: RESULT_ID,
          computedAt: UPDATED_AT,
          queryArtifactUrl: 'https://example.invalid/query.jsonl',
          queryArtifactFormat: 'jsonl:v1',
        }),
      ) as never,
    ).readLatestAllUnit(SNAPSHOT_ID),
    'INVALID_LCA_LATEST_ALL_UNIT_RESPONSE',
  );
});

Deno.test(
  'failure envelopes reject missing, empty, fractional, and out-of-range fields',
  async () => {
    for (const malformed of [
      'scalar',
      [],
      {},
      { ok: false, code: '', status: 409, message: 'failure' },
      { ok: false, code: 'FAILURE', status: 409.5, message: 'failure' },
      { ok: false, code: 'FAILURE', status: 99, message: 'failure' },
      { ok: false, code: 'FAILURE', status: 600, message: 'failure' },
      { ok: false, code: 'FAILURE', status: 409, message: '' },
      { ok: true },
    ]) {
      const repository = createLcaResultFamilyCapabilityRepository(
        clientFor({
          data: malformed,
          error: null,
        }) as never,
      );
      await expectInvalid(
        repository.readResultProjection({
          requestedBy: USER_ID,
          resultId: RESULT_ID,
        }),
        'INVALID_LCA_RESULT_FACADE_RESPONSE',
      );
    }
  },
);

Deno.test('reconcile decoder enforces exact code/data pairing and strict nested DTOs', async () => {
  const readyData = {
    cache: cacheMutation({ status: 'ready', resultId: RESULT_ID, hitCount: 2 }),
    workerStatus: 'completed',
    jobProjection: { ok: true, data: jobProjection() },
  };
  const pendingData = {
    cache: cacheMutation({ status: 'pending', resultId: null, hitCount: 2 }),
    workerStatus: 'completed',
    jobProjection: { ok: true, data: jobProjection(null) },
  };

  for (const response of [
    { ok: true, code: 'reconciled', data: null },
    { ok: true, code: 'result_pending', data: null },
    { ok: true, code: 'cache_not_found', data: readyData },
    { ok: true, code: 'job_not_found', data: pendingData },
    { ok: true, code: 'unknown', data: null },
    { ok: true, code: 'reconciled', data: { ...readyData, cache: 'scalar' } },
    {
      ok: true,
      code: 'reconciled',
      data: { ...readyData, cache: cacheMutation({ cacheId: 'not-a-uuid' }) },
    },
    {
      ok: true,
      code: 'reconciled',
      data: {
        ...readyData,
        cache: cacheMutation({ cacheId: '90000000-0000-4000-8000-000000000001' }),
      },
    },
    {
      ok: true,
      code: 'reconciled',
      data: { ...readyData, workerStatus: '' },
    },
    {
      ok: true,
      code: 'reconciled',
      data: { ...readyData, workerStatus: 'not-a-worker-status' },
    },
    {
      ok: true,
      code: 'reconciled',
      data: { ...readyData, jobProjection: { ok: true, data: 'scalar' } },
    },
    {
      ok: true,
      code: 'result_pending',
      data: { ...pendingData, workerStatus: 'running' },
    },
    {
      ok: true,
      code: 'reconciled',
      data: {
        ...readyData,
        cache: cacheMutation({ status: 'ready', resultId: null }),
      },
    },
    ...(['failed', 'stale', 'cancelled'] as const).flatMap((workerStatus) => [
      {
        ok: true,
        code: 'reconciled',
        data: {
          cache: cacheMutation({ status: 'pending', resultId: null }),
          workerStatus,
          jobProjection: {
            ok: true,
            data: { ...jobProjection(null), job: jobItem({ status: workerStatus }) },
          },
        },
      },
      {
        ok: true,
        code: 'reconciled',
        data: {
          cache: cacheMutation({ status: 'ready', resultId: RESULT_ID }),
          workerStatus,
          jobProjection: {
            ok: true,
            data: { ...jobProjection(), job: jobItem({ status: workerStatus }) },
          },
        },
      },
    ]),
    {
      ok: true,
      code: 'reconciled',
      data: {
        cache: cacheMutation({ status: 'pending', resultId: null }),
        workerStatus: 'running',
        jobProjection: { ok: true, data: jobProjection(null) },
      },
    },
    {
      ok: true,
      code: 'reconciled',
      data: {
        cache: cacheMutation({
          status: 'failed',
          resultId: null,
          workerJobId: '70000000-0000-4000-8000-000000000001',
        }),
        workerStatus: 'cancelled',
        jobProjection: {
          ok: true,
          data: { ...jobProjection(null), job: jobItem({ status: 'cancelled' }) },
        },
      },
    },
    {
      ok: true,
      code: 'reconciled',
      data: {
        cache: cacheMutation({
          status: 'failed',
          resultId: null,
          legacyJobId: '70000000-0000-4000-8000-000000000002',
        }),
        workerStatus: 'cancelled',
        jobProjection: {
          ok: true,
          data: { ...jobProjection(null), job: jobItem({ status: 'cancelled' }) },
        },
      },
    },
    {
      ok: true,
      code: 'reconciled',
      data: {
        cache: cacheMutation({ status: 'pending', resultId: null }),
        workerStatus: 'running',
        jobProjection: {
          ok: true,
          data: { ...jobProjection(), job: jobItem({ status: 'running' }) },
        },
      },
    },
    {
      ok: true,
      code: 'reconciled',
      data: {
        ...readyData,
        jobProjection: {
          ok: true,
          data: {
            ...jobProjection(),
            result: resultItem({
              workerJobId: '70000000-0000-4000-8000-000000000003',
            }),
          },
        },
      },
    },
    {
      ok: true,
      code: 'reconciled',
      data: {
        cache: cacheMutation({
          status: 'pending',
          resultId: null,
          workerJobId: '70000000-0000-4000-8000-000000000001',
        }),
        workerStatus: 'completed',
        jobProjection: { ok: true, data: jobProjection(null) },
      },
    },
    {
      ok: true,
      code: 'reconciled',
      data: {
        ...readyData,
        cache: cacheMutation({
          status: 'ready',
          resultId: '80000000-0000-4000-8000-000000000001',
        }),
      },
    },
    {
      ok: true,
      code: 'result_pending',
      data: {
        ...pendingData,
        jobProjection: { ok: true, data: jobProjection() },
      },
    },
  ]) {
    const repository = createLcaResultFamilyCapabilityRepository(
      clientFor({
        data: response,
        error: null,
      }) as never,
    );
    const result = await repository.reconcileCache({
      requestedBy: USER_ID,
      cacheId: CACHE_ID,
    });
    assert(!result.ok, `malformed reconciliation was accepted: ${JSON.stringify(response)}`);
    assertEquals(result.status, 500);
  }

  const pendingRepository = createLcaResultFamilyCapabilityRepository(
    clientFor({
      data: { ok: true, code: 'result_pending', data: pendingData },
      error: null,
    }) as never,
  );
  const pending = await pendingRepository.reconcileCache({
    requestedBy: USER_ID,
    cacheId: CACHE_ID,
  });
  assert(pending.ok);
  assertEquals(pending.data.code, 'result_pending');
  assert(pending.data.cache);
  assertEquals(pending.data.cache.hitCount, 2);
  assertEquals(pending.data.workerStatus, 'completed');

  const { result: _omittedResult, ...projectionWithoutResult } = jobProjection(null);
  const strippedPendingRepository = createLcaResultFamilyCapabilityRepository(
    clientFor({
      data: {
        ok: true,
        code: 'result_pending',
        data: {
          ...pendingData,
          jobProjection: { ok: true, data: projectionWithoutResult },
        },
      },
      error: null,
    }) as never,
  );
  const strippedPending = await strippedPendingRepository.reconcileCache({
    requestedBy: USER_ID,
    cacheId: CACHE_ID,
  });
  assert(strippedPending.ok);
  assertEquals(strippedPending.data.code, 'result_pending');
  assertEquals(strippedPending.data.jobProjection?.data?.result, null);

  const readyRepository = createLcaResultFamilyCapabilityRepository(
    clientFor({
      data: { ok: true, code: 'reconciled', data: readyData },
      error: null,
    }) as never,
  );
  const ready = await readyRepository.reconcileCache({
    requestedBy: USER_ID,
    cacheId: CACHE_ID,
  });
  assert(ready.ok);
  assertEquals(ready.data.code, 'reconciled');
  assert(ready.data.cache);
  assertEquals(ready.data.cache.resultId, RESULT_ID);

  const cancelledData = {
    cache: cacheMutation({ status: 'failed', resultId: RESULT_ID, hitCount: 2 }),
    workerStatus: 'cancelled',
    jobProjection: {
      ok: true,
      data: { ...jobProjection(), job: jobItem({ status: 'cancelled' }) },
    },
  };
  const cancelledRepository = createLcaResultFamilyCapabilityRepository(
    clientFor({
      data: { ok: true, code: 'reconciled', data: cancelledData },
      error: null,
    }) as never,
  );
  const cancelled = await cancelledRepository.reconcileCache({
    requestedBy: USER_ID,
    cacheId: CACHE_ID,
  });
  assert(cancelled.ok);
  assertEquals(cancelled.data.code, 'reconciled');
  assertEquals(cancelled.data.cache?.status, 'failed');
  assertEquals(cancelled.data.workerStatus, 'cancelled');
});
