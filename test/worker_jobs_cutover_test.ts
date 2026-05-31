import { assertEquals } from 'jsr:@std/assert';

import {
  isWorkerJobsCutoverEnabled,
  lcaWorkerJobKindForJobType,
  workerJobIdFromRpcData,
  workerJobPayloadSchemaVersion,
} from '../supabase/functions/_shared/worker_jobs_cutover.ts';

Deno.test('isWorkerJobsCutoverEnabled accepts explicit truthy values', () => {
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
