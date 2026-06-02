import { assertEquals } from 'jsr:@std/assert';

import {
  enqueueCalculatorWorkerJob,
  isWorkerJobsCutoverEnabled,
  lcaWorkerJobKindForJobType,
  workerJobIdFromRpcData,
  workerJobPayloadSchemaVersion,
  workerJobPayloadStringFromRpcData,
} from '../supabase/functions/_shared/worker_jobs_cutover.ts';

Deno.test('isWorkerJobsCutoverEnabled defaults on and accepts explicit overrides', () => {
  assertEquals(
    isWorkerJobsCutoverEnabled('FEATURE', () => undefined),
    true,
  );
  assertEquals(
    isWorkerJobsCutoverEnabled('FEATURE', (key) => (key === 'FEATURE' ? 'true' : undefined)),
    true,
  );
  assertEquals(
    isWorkerJobsCutoverEnabled('FEATURE', (key) => (key === 'FEATURE' ? '0' : undefined)),
    false,
  );
  assertEquals(
    isWorkerJobsCutoverEnabled('FEATURE', (key) =>
      key === 'WORKER_JOBS_CUTOVER_ENABLED' ? 'off' : undefined,
    ),
    false,
  );
  assertEquals(
    isWorkerJobsCutoverEnabled('FEATURE', (key) =>
      key === 'WORKER_JOBS_CUTOVER_ENABLED' ? 'on' : undefined,
    ),
    true,
  );
});

Deno.test('lcaWorkerJobKindForJobType maps legacy solver payload types', () => {
  assertEquals(lcaWorkerJobKindForJobType('solve_one'), 'lca.solve_one');
  assertEquals(lcaWorkerJobKindForJobType('solve_all_unit'), 'lca.solve_all_unit');
  assertEquals(lcaWorkerJobKindForJobType('build_snapshot'), 'lca.build_snapshot');
  assertEquals(lcaWorkerJobKindForJobType('analyze_contribution_path'), 'lca.contribution_path');
  assertEquals(lcaWorkerJobKindForJobType('unknown'), null);
});

Deno.test('workerJobPayloadSchemaVersion follows job kind contract', () => {
  assertEquals(workerJobPayloadSchemaVersion('lca.solve_one'), 'lca.solve_one.request.v1');
  assertEquals(
    workerJobPayloadSchemaVersion('tidas.export_package'),
    'tidas.export_package.request.v1',
  );
});

Deno.test('workerJobIdFromRpcData extracts worker job id defensively', () => {
  assertEquals(workerJobIdFromRpcData({ id: 'job-1' }), 'job-1');
  assertEquals(workerJobIdFromRpcData({ id: 1 }), null);
  assertEquals(workerJobIdFromRpcData(null), null);
});

Deno.test('workerJobPayloadStringFromRpcData extracts compatibility payload ids', () => {
  assertEquals(
    workerJobPayloadStringFromRpcData(
      { id: 'worker-1', payload: { job_id: 'legacy-job-1', snapshot_id: 'snapshot-1' } },
      'job_id',
    ),
    'legacy-job-1',
  );
  assertEquals(
    workerJobPayloadStringFromRpcData(
      { id: 'worker-1', payload: { job_id: 'legacy-job-1', snapshot_id: 'snapshot-1' } },
      'snapshot_id',
    ),
    'snapshot-1',
  );
  assertEquals(workerJobPayloadStringFromRpcData({ id: 'worker-1' }, 'job_id'), null);
  assertEquals(workerJobPayloadStringFromRpcData({ id: 'worker-1', payload: [] }, 'job_id'), null);
});

Deno.test('enqueueCalculatorWorkerJob requires canonical worker job id', async () => {
  const supabase = {
    rpc: () =>
      Promise.resolve({
        data: {
          ok: true,
          data: {
            status: 'queued',
          },
        },
        error: null,
      }),
  };

  const result = await enqueueCalculatorWorkerJob(supabase as never, {
    jobKind: 'lca.solve_one',
    payload: {},
  });

  assertEquals(result, {
    ok: false,
    error: 'WORKER_JOB_ID_MISSING',
    status: 500,
    details: {
      status: 'queued',
    },
  });
});
