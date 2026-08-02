import { assertEquals } from 'jsr:@std/assert';

import type {
  LcaSnapshotArtifact,
  LcaSnapshotCapabilityRepository,
} from '../supabase/functions/_shared/capabilities/lca_snapshot_family.ts';
import { createLcaContributionPathHandler } from '../supabase/functions/lca_contribution_path/index.ts';
import { createLcaQueryResultsHandler } from '../supabase/functions/lca_query_results/index.ts';
import { createLcaSolveHandler } from '../supabase/functions/lca_solve/index.ts';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const EXPLICIT_ID = '20000000-0000-4000-8000-000000000001';
const FIRST_ID = '20000000-0000-4000-8000-000000000002';
const SECOND_ID = '20000000-0000-4000-8000-000000000003';
const MAPPED_ID = '20000000-0000-4000-8000-000000000004';
const PROCESS_ID = '30000000-0000-4000-8000-000000000001';
const IMPACT_ID = '40000000-0000-4000-8000-000000000001';

type ArtifactResult = {
  data: LcaSnapshotArtifact | null;
  error: unknown;
};

function artifact(snapshotId: string, processCount = 5): LcaSnapshotArtifact {
  return {
    snapshot_id: snapshotId,
    artifact_url: `https://example.invalid/${snapshotId}.h5`,
    artifact_format: 'hdf5',
    process_count: processCount,
    status: 'ready',
    created_at: '2026-08-02T00:00:00Z',
  };
}

function repository(options: {
  calls: string[];
  artifacts: Record<string, ArtifactResult[]>;
  candidates?: string[];
}): LcaSnapshotCapabilityRepository {
  return {
    access: 'service-only',
    async resolveReady(scope, processFilter) {
      options.calls.push(`resolveReady:${scope}`);
      return {
        data: (options.candidates ?? []).map((id) => ({
          id,
          created_at: '2026-08-02T00:00:00Z',
          process_filter: processFilter,
        })),
        error: null,
      };
    },
    async readArtifact(snapshotId) {
      options.calls.push(`readArtifact:${snapshotId}`);
      const result = options.artifacts[snapshotId]?.shift() ?? { data: null, error: null };
      return { data: result.data, error: result.error as never };
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

function dependencies(snapshotRepository: LcaSnapshotCapabilityRepository) {
  return {
    snapshotRepository,
    authenticateRequest: (async () => ({
      isAuthenticated: true,
      user: { id: USER_ID },
    })) as never,
    getRedisClient: (async () => ({})) as never,
    isSnapshotFresh: (async () => 'fresh') as never,
  };
}

function post(body: Record<string, unknown>): Request {
  return new Request('http://edge.test/function', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const solveBody = {
  snapshot_id: EXPLICIT_ID,
  demand_mode: 'single',
  demand: { process_index: 7, amount: 1 },
};
const queryBody = { snapshot_id: EXPLICIT_ID, mode: 'process_all_impacts' };
const contributionBody = {
  snapshot_id: EXPLICIT_ID,
  process_id: PROCESS_ID,
  impact_id: IMPACT_ID,
};

Deno.test('real LCA endpoint handlers preserve explicit snapshot 404 and 500 errors', async () => {
  const cases = [
    {
      name: 'solve',
      body: solveBody,
      create: createLcaSolveHandler,
      lookupError: 'snapshot_lookup_failed',
    },
    {
      name: 'query',
      body: queryBody,
      create: createLcaQueryResultsHandler,
      lookupError: 'snapshot_artifact_lookup_failed',
    },
    {
      name: 'contribution',
      body: contributionBody,
      create: createLcaContributionPathHandler,
      lookupError: 'snapshot_artifact_lookup_failed',
    },
  ];

  for (const testCase of cases) {
    const missingCalls: string[] = [];
    const missingHandler = testCase.create(
      dependencies(repository({ calls: missingCalls, artifacts: {} })) as never,
    );
    const missingResponse = await missingHandler(post(testCase.body));
    assertEquals(missingResponse.status, 404, `${testCase.name} missing status`);
    assertEquals(await missingResponse.json(), { error: 'snapshot_not_ready' });
    assertEquals(missingCalls, [`readArtifact:${EXPLICIT_ID}`]);

    const errorCalls: string[] = [];
    const errorHandler = testCase.create(
      dependencies(
        repository({
          calls: errorCalls,
          artifacts: {
            [EXPLICIT_ID]: [{ data: null, error: { message: 'permission denied', code: '42501' } }],
          },
        }),
      ) as never,
    );
    const errorResponse = await errorHandler(post(testCase.body));
    assertEquals(errorResponse.status, 500, `${testCase.name} lookup status`);
    assertEquals(await errorResponse.json(), { error: testCase.lookupError });
    assertEquals(errorCalls, [`readArtifact:${EXPLICIT_ID}`]);
  }
});

Deno.test(
  'real lca_solve handler executes candidate fallback and consumes artifact DTO',
  async () => {
    const calls: string[] = [];
    const handler = createLcaSolveHandler(
      dependencies(
        repository({
          calls,
          candidates: [FIRST_ID, SECOND_ID],
          artifacts: {
            [FIRST_ID]: [{ data: null, error: null }],
            [SECOND_ID]: [{ data: artifact(MAPPED_ID, 5), error: null }],
          },
        }),
      ) as never,
    );

    const response = await handler(post({ ...solveBody, snapshot_id: undefined }));
    assertEquals(response.status, 400);
    assertEquals(await response.json(), {
      error: 'process_index_out_of_range',
      process_index: 7,
      process_count: 5,
    });
    assertEquals(calls, [
      'resolveReady:prod',
      `readArtifact:${FIRST_ID}`,
      `readArtifact:${SECOND_ID}`,
    ]);
  },
);

Deno.test('real query and contribution handlers use the mapped fallback snapshot id', async () => {
  for (const testCase of [
    {
      name: 'query',
      body: { ...queryBody, snapshot_id: undefined },
      create: createLcaQueryResultsHandler,
    },
    {
      name: 'contribution',
      body: { ...contributionBody, snapshot_id: undefined },
      create: createLcaContributionPathHandler,
    },
  ]) {
    const calls: string[] = [];
    const handler = testCase.create(
      dependencies(
        repository({
          calls,
          candidates: [FIRST_ID, SECOND_ID],
          artifacts: {
            [FIRST_ID]: [{ data: null, error: null }],
            [SECOND_ID]: [{ data: artifact(MAPPED_ID), error: null }],
            [MAPPED_ID]: [
              { data: null, error: { message: 'mapped lookup failed', code: 'XX000' } },
            ],
          },
        }),
      ) as never,
    );

    const response = await handler(post(testCase.body));
    assertEquals(response.status, 500, `${testCase.name} mapped lookup status`);
    assertEquals(await response.json(), { error: 'snapshot_artifact_lookup_failed' });
    assertEquals(calls, [
      'resolveReady:prod',
      `readArtifact:${FIRST_ID}`,
      `readArtifact:${SECOND_ID}`,
      `readArtifact:${MAPPED_ID}`,
    ]);
  }
});
