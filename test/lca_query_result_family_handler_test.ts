import { assertEquals } from 'jsr:@std/assert';

import type {
  LcaLatestAllUnitResult,
  LcaLatestSingleSolveResult,
  LcaResultCapabilityResult,
  LcaResultFamilyCapabilityRepository,
} from '../supabase/functions/_shared/capabilities/lca_result_family.ts';
import type {
  LcaSnapshotArtifact,
  LcaSnapshotCapabilityRepository,
} from '../supabase/functions/_shared/capabilities/lca_snapshot_family.ts';
import { createLcaQueryResultsHandler } from '../supabase/functions/lca_query_results/index.ts';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const SNAPSHOT_ID = '20000000-0000-4000-8000-000000000001';
const PROCESS_ID = '30000000-0000-4000-8000-000000000001';
const IMPACT_ID = '40000000-0000-4000-8000-000000000001';
const SECOND_IMPACT_ID = '40000000-0000-4000-8000-000000000002';
const ALL_UNIT_RESULT_ID = '50000000-0000-4000-8000-000000000001';
const SINGLE_RESULT_ID = '50000000-0000-4000-8000-000000000002';
const WORKER_JOB_ID = '60000000-0000-4000-8000-000000000001';
const CACHE_ID = '70000000-0000-4000-8000-000000000001';
const SNAPSHOT_ARTIFACT_URL = 'https://artifacts.test/snapshots/source.h5';
const SNAPSHOT_INDEX_URL = 'https://artifacts.test/snapshots/snapshot-index-v1.json';
const QUERY_ARTIFACT_URL = 'https://artifacts.test/results/query.json';

const snapshotIndex = {
  version: 1,
  snapshot_id: SNAPSHOT_ID,
  process_count: 1,
  impact_count: 2,
  process_map: [
    {
      process_id: PROCESS_ID,
      process_index: 0,
      process_version: '1.0.0',
    },
  ],
  impact_map: [
    {
      impact_id: IMPACT_ID,
      impact_index: 0,
      impact_key: 'climate-change',
      impact_name: 'Climate change',
      unit: 'kg CO2-eq',
    },
    {
      impact_id: SECOND_IMPACT_ID,
      impact_index: 1,
      impact_key: 'water-use',
      impact_name: 'Water use',
      unit: 'm3',
    },
  ],
};

const queryArtifact = {
  version: 1,
  format: 'all-unit-query:v1',
  snapshot_id: SNAPSHOT_ID,
  job_id: '80000000-0000-4000-8000-000000000001',
  process_count: 1,
  impact_count: 2,
  h_matrix: [[2, 3]],
};

function ok<T>(data: T): LcaResultCapabilityResult<T> {
  return { ok: true, data };
}

function failure(
  code = 'DB_SECRET_FAILURE',
  status = 409,
  message = 'must not reach the browser',
): LcaResultCapabilityResult<never> {
  return {
    ok: false,
    code,
    status,
    message,
    details: { sql: 'private.secret_table' },
  };
}

function latestAllUnit(overrides: Partial<LcaLatestAllUnitResult> = {}): LcaLatestAllUnitResult {
  return {
    snapshotId: SNAPSHOT_ID,
    resultId: ALL_UNIT_RESULT_ID,
    computedAt: '2026-08-02T10:00:00Z',
    queryArtifactUrl: QUERY_ARTIFACT_URL,
    queryArtifactFormat: 'all-unit-query:v1',
    ...overrides,
  };
}

function latestSingle(
  overrides: Partial<LcaLatestSingleSolveResult> = {},
): LcaLatestSingleSolveResult {
  return {
    snapshotId: SNAPSHOT_ID,
    processIndex: 0,
    amount: 4,
    cache: {
      cacheId: CACHE_ID,
      requestKey: 'solve-one:v1',
      status: 'ready',
      createdAt: '2026-08-02T10:30:00Z',
      updatedAt: '2026-08-02T11:00:00Z',
    },
    result: {
      resultId: SINGLE_RESULT_ID,
      workerJobId: WORKER_JOB_ID,
      snapshotId: SNAPSHOT_ID,
      createdAt: '2026-08-02T11:00:00Z',
      artifact: {},
    },
    workerJob: { id: WORKER_JOB_ID, status: 'completed' },
    ...overrides,
  };
}

type ResultRepositoryOptions = {
  calls: string[];
  allUnit: LcaResultCapabilityResult<LcaLatestAllUnitResult | null>;
  single?: LcaResultCapabilityResult<LcaLatestSingleSolveResult | null>;
};

function resultRepository(options: ResultRepositoryOptions): LcaResultFamilyCapabilityRepository {
  const unexpected = (name: string): never => {
    throw new Error(`unexpected result capability call: ${name}`);
  };
  return {
    access: 'service-only',
    async readLatestAllUnit(snapshotId) {
      options.calls.push(`readLatestAllUnit:${snapshotId}`);
      return options.allUnit;
    },
    async readLatestSingleSolve(request) {
      options.calls.push(
        `readLatestSingleSolve:${request.requestedBy}:${request.snapshotId}:${request.processIndex}`,
      );
      return options.single ?? ok(null);
    },
    readJobProjection: () => unexpected('readJobProjection'),
    readResultProjection: () => unexpected('readResultProjection'),
    readCache: () => unexpected('readCache'),
    touchCache: () => unexpected('touchCache'),
    admitCache: () => unexpected('admitCache'),
    reconcileCache: () => unexpected('reconcileCache'),
  };
}

function snapshotRepository(calls: string[]): LcaSnapshotCapabilityRepository {
  const artifact: LcaSnapshotArtifact = {
    snapshot_id: SNAPSHOT_ID,
    artifact_url: SNAPSHOT_ARTIFACT_URL,
    artifact_format: 'hdf5',
    process_count: 1,
    status: 'ready',
    created_at: '2026-08-02T09:00:00Z',
  };
  return {
    access: 'service-only',
    async readArtifact(snapshotId) {
      calls.push(`readArtifact:${snapshotId}`);
      return {
        data: snapshotId === SNAPSHOT_ID ? artifact : null,
        error: null,
      };
    },
    resolveReady() {
      throw new Error('unexpected resolveReady call');
    },
    readActive() {
      throw new Error('unexpected readActive call');
    },
    readScope() {
      throw new Error('unexpected readScope call');
    },
    readLatestArtifact() {
      throw new Error('unexpected readLatestArtifact call');
    },
    createDraft() {
      throw new Error('unexpected createDraft call');
    },
  };
}

function post(body: unknown): Request {
  return new Request('http://edge.test/lca_query_results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    snapshot_id: SNAPSHOT_ID,
    mode: 'process_all_impacts',
    process_id: PROCESS_ID,
    process_version: '1.0.0',
    ...overrides,
  };
}

function dependencies(
  repository: LcaResultFamilyCapabilityRepository,
  snapshotCalls: string[],
  authenticated = true,
) {
  return {
    resultRepository: repository,
    snapshotRepository: snapshotRepository(snapshotCalls),
    getRedisClient: (async () => ({})) as never,
    isSnapshotFresh: (async () => 'fresh') as never,
    authenticateRequest: (async () =>
      authenticated
        ? { isAuthenticated: true, user: { id: USER_ID } }
        : {
            isAuthenticated: false,
            response: new Response(JSON.stringify({ error: 'authentication_required' }), {
              status: 401,
            }),
          }) as never,
  };
}

type FetchOptions = {
  snapshot?: unknown;
  query?: unknown;
  rpcCalls?: string[];
};

async function withFetch<T>(options: FetchOptions, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const priorUrl = Deno.env.get('SUPABASE_URL');
  const priorKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const priorCutover = Deno.env.get('LCA_WORKER_JOBS_ENABLED');
  Deno.env.set('SUPABASE_URL', 'https://unit.supabase.test');
  Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'unit-service-key');
  Deno.env.set('LCA_WORKER_JOBS_ENABLED', 'false');
  globalThis.fetch = (async (input: Request | URL | string) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === SNAPSHOT_INDEX_URL) {
      return Response.json(options.snapshot ?? snapshotIndex);
    }
    if (url === QUERY_ARTIFACT_URL) {
      return Response.json(options.query ?? queryArtifact);
    }
    if (url.startsWith('https://unit.supabase.test/rest/v1/processes?')) {
      return Response.json([
        {
          id: PROCESS_ID,
          version: '1.0.0',
          state_code: 20,
          user_id: USER_ID,
          team_id: null,
          review_id: null,
        },
      ]);
    }
    if (url.endsWith('/rest/v1/rpc/lca_read_result_cache_v1')) {
      options.rpcCalls?.push('api.lca_read_result_cache_v1');
      return Response.json({ ok: true, data: null });
    }
    throw new Error(`unexpected fetch/direct fallback: ${url}`);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv('SUPABASE_URL', priorUrl);
    restoreEnv('SUPABASE_SERVICE_ROLE_KEY', priorKey);
    restoreEnv('LCA_WORKER_JOBS_ENABLED', priorCutover);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

Deno.test(
  'query handler enforces method, authentication, and request validation before capabilities',
  async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const repository = resultRepository({ calls, allUnit: ok(latestAllUnit()) });

    const handler = createLcaQueryResultsHandler(dependencies(repository, snapshotCalls) as never);
    const getResponse = await handler(new Request('http://edge.test/lca_query_results'));
    assertEquals(getResponse.status, 405);
    assertEquals(await responseJson(getResponse), {
      error: 'method_not_allowed',
    });

    const invalidJson = await handler(
      new Request('http://edge.test/lca_query_results', {
        method: 'POST',
        body: '{',
      }),
    );
    assertEquals(invalidJson.status, 400);
    assertEquals(await responseJson(invalidJson), { error: 'invalid_json' });

    const invalidMode = await handler(post(baseBody({ mode: 'not-a-mode' })));
    assertEquals(invalidMode.status, 400);
    assertEquals(await responseJson(invalidMode), { error: 'invalid_mode' });

    const unauthenticated = createLcaQueryResultsHandler(
      dependencies(repository, snapshotCalls, false) as never,
    );
    const authResponse = await unauthenticated(post(baseBody()));
    assertEquals(authResponse.status, 401);
    assertEquals(await responseJson(authResponse), {
      error: 'authentication_required',
    });
    assertEquals(calls, []);
    assertEquals(snapshotCalls, []);
  },
);

Deno.test('latest-all-unit business failure is fail-closed and sanitized', async () => {
  const calls: string[] = [];
  const snapshotCalls: string[] = [];
  const handler = createLcaQueryResultsHandler(
    dependencies(resultRepository({ calls, allUnit: failure() }), snapshotCalls) as never,
  );

  await withFetch({}, async () => {
    const response = await handler(post(baseBody()));
    assertEquals(response.status, 500);
    assertEquals(await responseJson(response), {
      error: 'latest_all_unit_lookup_failed',
    });
  });
  assertEquals(calls, [`readLatestAllUnit:${SNAPSHOT_ID}`]);
  assertEquals(snapshotCalls, [`readArtifact:${SNAPSHOT_ID}`, `readArtifact:${SNAPSHOT_ID}`]);
});

Deno.test(
  'latest-all-unit null queues through the api capability without relation fallback',
  async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const rpcCalls: string[] = [];
    const handler = createLcaQueryResultsHandler(
      dependencies(resultRepository({ calls, allUnit: ok(null) }), snapshotCalls) as never,
    );

    await withFetch({ rpcCalls }, async () => {
      const response = await handler(post(baseBody()));
      assertEquals(response.status, 503);
      assertEquals(await responseJson(response), {
        error: 'legacy_queue_disabled',
        details: null,
      });
    });
    assertEquals(calls, [`readLatestAllUnit:${SNAPSHOT_ID}`]);
    assertEquals(rpcCalls, ['api.lca_read_result_cache_v1']);
  },
);

Deno.test(
  'latest-all-unit artifact succeeds and latest-single null preserves all-unit DTO',
  async () => {
    const calls: string[] = [];
    const snapshotCalls: string[] = [];
    const handler = createLcaQueryResultsHandler(
      dependencies(
        resultRepository({
          calls,
          allUnit: ok(latestAllUnit()),
          single: ok(null),
        }),
        snapshotCalls,
      ) as never,
    );

    await withFetch({}, async () => {
      const response = await handler(post(baseBody()));
      assertEquals(response.status, 200);
      assertEquals(await responseJson(response), {
        snapshot_id: SNAPSHOT_ID,
        result_id: ALL_UNIT_RESULT_ID,
        source: 'all_unit',
        mode: 'process_all_impacts',
        data: {
          process_id: PROCESS_ID,
          values: [
            {
              impact_id: IMPACT_ID,
              impact_index: 0,
              impact_key: 'climate-change',
              impact_name: 'Climate change',
              unit: 'kg CO2-eq',
              value: 2,
            },
            {
              impact_id: SECOND_IMPACT_ID,
              impact_index: 1,
              impact_key: 'water-use',
              impact_name: 'Water use',
              unit: 'm3',
              value: 3,
            },
          ],
        },
        meta: {
          cache_hit: false,
          computed_at: '2026-08-02T10:00:00Z',
          query_artifact_format: 'all-unit-query:v1',
        },
      });
    });
    assertEquals(calls, [
      `readLatestAllUnit:${SNAPSHOT_ID}`,
      `readLatestSingleSolve:${USER_ID}:${SNAPSHOT_ID}:0`,
    ]);
  },
);

Deno.test(
  'newer latest-single projection takes precedence and scales the all-unit row',
  async () => {
    const calls: string[] = [];
    const handler = createLcaQueryResultsHandler(
      dependencies(
        resultRepository({
          calls,
          allUnit: ok(latestAllUnit()),
          single: ok(latestSingle()),
        }),
        [],
      ) as never,
    );

    await withFetch({}, async () => {
      const response = await handler(post(baseBody()));
      assertEquals(response.status, 200);
      const body = await responseJson(response);
      assertEquals(body.result_id, SINGLE_RESULT_ID);
      assertEquals(body.source, 'fallback_solve_one');
      assertEquals(body.data, {
        process_id: PROCESS_ID,
        values: [
          {
            impact_id: IMPACT_ID,
            impact_index: 0,
            impact_key: 'climate-change',
            impact_name: 'Climate change',
            unit: 'kg CO2-eq',
            value: 8,
          },
          {
            impact_id: SECOND_IMPACT_ID,
            impact_index: 1,
            impact_key: 'water-use',
            impact_name: 'Water use',
            unit: 'm3',
            value: 12,
          },
        ],
      });
      assertEquals(body.meta, {
        cache_hit: false,
        computed_at: '2026-08-02T11:00:00Z',
        query_artifact_format: 'all-unit-query:v1',
        scaled_from_all_unit_result_id: ALL_UNIT_RESULT_ID,
        scaled_amount: 4,
      });
    });
    assertEquals(calls, [
      `readLatestAllUnit:${SNAPSHOT_ID}`,
      `readLatestSingleSolve:${USER_ID}:${SNAPSHOT_ID}:0`,
    ]);
  },
);

Deno.test(
  'latest-single failures preserve canonical all-unit parity without diagnostic leakage',
  async () => {
    const cases: Array<{
      name: string;
      single: LcaResultCapabilityResult<LcaLatestSingleSolveResult | null>;
    }> = [
      { name: 'business failure', single: failure() },
      {
        name: 'malformed success',
        single: ok({ amount: 2, result: null } as unknown as LcaLatestSingleSolveResult),
      },
    ];

    for (const testCase of cases) {
      const calls: string[] = [];
      const handler = createLcaQueryResultsHandler(
        dependencies(
          resultRepository({
            calls,
            allUnit: ok(latestAllUnit()),
            single: testCase.single,
          }),
          [],
        ) as never,
      );
      await withFetch({}, async () => {
        const response = await handler(post(baseBody()));
        assertEquals(response.status, 200, testCase.name);
        const body = await responseJson(response);
        assertEquals(body.result_id, ALL_UNIT_RESULT_ID, testCase.name);
        assertEquals(body.source, 'all_unit', testCase.name);
        assertEquals(
          JSON.stringify(body).includes('must not reach the browser'),
          false,
          testCase.name,
        );
        assertEquals(JSON.stringify(body).includes('private.secret_table'), false, testCase.name);
      });
      assertEquals(calls, [
        `readLatestAllUnit:${SNAPSHOT_ID}`,
        `readLatestSingleSolve:${USER_ID}:${SNAPSHOT_ID}:0`,
      ]);
    }
  },
);

Deno.test('query artifact snapshot, format, and matrix shape conflicts fail closed', async () => {
  const cases = [
    {
      name: 'format',
      query: { ...queryArtifact, format: 'unknown' },
      status: 500,
      body: { error: 'unsupported_query_artifact_format' },
    },
    {
      name: 'snapshot',
      query: {
        ...queryArtifact,
        snapshot_id: '20000000-0000-4000-8000-000000000099',
      },
      status: 500,
      body: { error: 'query_artifact_snapshot_mismatch' },
    },
    {
      name: 'shape',
      query: { ...queryArtifact, h_matrix: [] },
      status: 500,
      body: { error: 'query_artifact_shape_invalid' },
    },
  ];

  for (const testCase of cases) {
    const calls: string[] = [];
    const handler = createLcaQueryResultsHandler(
      dependencies(resultRepository({ calls, allUnit: ok(latestAllUnit()) }), []) as never,
    );
    await withFetch({ query: testCase.query }, async () => {
      const response = await handler(post(baseBody()));
      assertEquals(response.status, testCase.status, testCase.name);
      assertEquals(await responseJson(response), testCase.body, testCase.name);
    });
    assertEquals(calls, [`readLatestAllUnit:${SNAPSHOT_ID}`], testCase.name);
  }
});
