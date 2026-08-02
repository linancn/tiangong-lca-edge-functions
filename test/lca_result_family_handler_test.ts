import { assertEquals } from 'jsr:@std/assert';

import type {
  LcaJobProjection,
  LcaResultCapabilityResult,
  LcaResultFamilyCapabilityRepository,
  LcaResultProjection,
} from '../supabase/functions/_shared/capabilities/lca_result_family.ts';
import { createLcaContributionPathResultHandler } from '../supabase/functions/lca_contribution_path_result/index.ts';
import { createLcaJobsHandler } from '../supabase/functions/lca_jobs/index.ts';
import { createLcaResultsHandler } from '../supabase/functions/lca_results/index.ts';

const USER_ID = '10000000-0000-4000-8000-000000000001';
const JOB_ID = '20000000-0000-4000-8000-000000000001';
const RESULT_ID = '30000000-0000-4000-8000-000000000001';
const SNAPSHOT_ID = '40000000-0000-4000-8000-000000000001';
const CREATED_AT = '2026-08-03T01:02:03.000Z';
const UPDATED_AT = '2026-08-03T01:03:04.000Z';

const job = {
  workerJobId: JOB_ID,
  legacyJobId: JOB_ID,
  snapshotId: SNAPSHOT_ID,
  jobKind: 'lca.contribution_path',
  jobType: 'analyze_contribution_path',
  status: 'completed',
  timestamps: { createdAt: CREATED_AT, updatedAt: UPDATED_AT },
};

const result = {
  resultId: RESULT_ID,
  legacyJobId: JOB_ID,
  workerJobId: JOB_ID,
  snapshotId: SNAPSHOT_ID,
  createdAt: CREATED_AT,
  diagnostics: { iterations: 4 },
  artifact: {
    artifactUrl: 'https://example.invalid/contribution.json',
    artifactFormat: 'contribution-path:v1',
    artifactByteSize: 128,
    artifactSha256: 'a'.repeat(64),
  },
};

const jobProjection: LcaJobProjection = {
  job,
  result,
  workerJob: { id: JOB_ID },
};

const resultProjection: LcaResultProjection = {
  job,
  result,
  workerJob: { id: JOB_ID },
};

function repository(
  options: {
    job?: LcaResultCapabilityResult<LcaJobProjection | null>;
    result?: LcaResultCapabilityResult<LcaResultProjection | null>;
  } = {},
): LcaResultFamilyCapabilityRepository {
  return {
    access: 'service-only',
    readJobProjection: async () => options.job ?? { ok: true, data: jobProjection },
    readResultProjection: async () => options.result ?? { ok: true, data: resultProjection },
    readLatestSingleSolve: async () => ({ ok: true, data: null }),
    readCache: async () => ({ ok: true, data: null }),
    touchCache: async () => ({ ok: true, data: null }),
    admitCache: async () => {
      throw new Error('unexpected admitCache');
    },
    reconcileCache: async () => {
      throw new Error('unexpected reconcileCache');
    },
    readLatestAllUnit: async () => ({ ok: true, data: null }),
  };
}

function dependencies(resultRepository: LcaResultFamilyCapabilityRepository) {
  return {
    resultRepository,
    authenticateRequest: (async () => ({
      isAuthenticated: true,
      user: { id: USER_ID },
    })) as never,
    getRedisClient: (async () => ({})) as never,
  };
}

function request(path: string, method: 'GET' | 'POST', body?: unknown) {
  return new Request(`http://edge.test/${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

Deno.test('LCA jobs handler preserves GET/POST success DTO and lookup validation', async () => {
  const handler = createLcaJobsHandler(dependencies(repository()));
  for (const req of [
    request(`lca_jobs?job_id=${JOB_ID}`, 'GET'),
    request('lca_jobs', 'POST', { job_id: JOB_ID }),
  ]) {
    const response = await handler(req);
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.job_id, JOB_ID);
    assertEquals(body.worker_job_id, JOB_ID);
    assertEquals(body.result.result_id, RESULT_ID);
  }

  assertEquals((await handler(request('lca_jobs', 'GET'))).status, 400);
  assertEquals((await handler(request('lca_jobs?job_id=not-a-uuid', 'GET'))).status, 400);
  const invalidJson = new Request('http://edge.test/lca_jobs', {
    method: 'POST',
    body: '{',
  });
  assertEquals((await handler(invalidJson)).status, 400);
});

Deno.test('LCA jobs handler keeps null as 404 and sanitizes facade failures', async () => {
  const missing = createLcaJobsHandler(dependencies(repository({ job: { ok: true, data: null } })));
  assertEquals((await missing(request(`lca_jobs/${JOB_ID}`, 'GET'))).status, 404);

  for (const failure of [
    { ok: false, code: '42501', status: 403, message: 'forbidden', details: { role: 'anon' } },
    { ok: false, code: 'AUTH_REQUIRED', status: 401, message: 'auth required', details: null },
    {
      ok: false,
      code: 'INVALID_LCA_JOB_PROJECTION',
      status: 500,
      message: 'malformed',
      details: { field: 'job' },
    },
  ] as const) {
    const handler = createLcaJobsHandler(dependencies(repository({ job: failure })));
    const response = await handler(request(`lca_jobs/${JOB_ID}`, 'GET'));
    assertEquals(response.status, 500);
    assertEquals(await response.json(), { error: 'job_lookup_failed' });
  }
});

Deno.test(
  'LCA results handler preserves success/not-found and sanitizes business failures',
  async () => {
    const success = createLcaResultsHandler(dependencies(repository()));
    const response = await success(request('lca_results', 'POST', { result_id: RESULT_ID }));
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.result_id, RESULT_ID);
    assertEquals(body.snapshot_id, SNAPSHOT_ID);
    assertEquals(body.artifact.artifact_format, 'contribution-path:v1');

    const missing = createLcaResultsHandler(
      dependencies(repository({ result: { ok: true, data: null } })),
    );
    assertEquals((await missing(request(`lca_results/${RESULT_ID}`, 'GET'))).status, 404);

    const businessFailure = {
      ok: false as const,
      code: 'UNSUPPORTED_LCA_RESULT_ARTIFACT_FORMAT',
      status: 409,
      message: 'unsupported',
      details: { expected: 'x' },
    };
    const failed = createLcaResultsHandler(dependencies(repository({ result: businessFailure })));
    const failedResponse = await failed(request(`lca_results/${RESULT_ID}`, 'GET'));
    assertEquals(failedResponse.status, 500);
    assertEquals(await failedResponse.json(), { error: 'result_lookup_failed' });
  },
);

Deno.test(
  'contribution result handler preserves format conflict and artifact success DTO',
  async () => {
    const handler = createLcaContributionPathResultHandler({
      ...dependencies(repository()),
      fetchArtifactJson: async () => ({ ok: true, data: { tree: [{ id: 'root' }] } }),
    });
    const success = await handler(request(`lca_contribution_path_result/${RESULT_ID}`, 'GET'));
    assertEquals(success.status, 200);
    const body = await success.json();
    assertEquals(body.result_id, RESULT_ID);
    assertEquals(body.data, { tree: [{ id: 'root' }] });

    const failure = {
      ok: false as const,
      code: 'UNSUPPORTED_LCA_RESULT_ARTIFACT_FORMAT',
      status: 409,
      message: 'wrong artifact',
      details: { actualArtifactFormat: 'hdf5:v1' },
    };
    const conflict = createLcaContributionPathResultHandler({
      ...dependencies(repository({ result: failure })),
      fetchArtifactJson: async () => {
        throw new Error('artifact fetch must not run');
      },
    });
    const conflictResponse = await conflict(
      request(`lca_contribution_path_result/${RESULT_ID}`, 'GET'),
    );
    assertEquals(conflictResponse.status, 409);
    assertEquals(await conflictResponse.json(), { error: 'unsupported_artifact_format' });
  },
);
