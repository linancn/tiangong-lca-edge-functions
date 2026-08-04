import { assertEquals } from 'jsr:@std/assert';

import {
  callLcaReadJobProjectionRpc,
  callLcaReadLatestSingleSolveResultRpc,
  callLcaReadResultProjectionRpc,
} from '../supabase/functions/_shared/db_rpc/lca_results.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_WORKER_JOB_ID = '22222222-2222-4222-8222-222222222222';
const TEST_LEGACY_JOB_ID = '33333333-3333-4333-8333-333333333333';
const TEST_RESULT_ID = '44444444-4444-4444-8444-444444444444';
const TEST_SNAPSHOT_ID = '55555555-5555-4555-8555-555555555555';

class FakeRpcSupabase {
  calls: Array<{ fn: string; args: unknown }> = [];

  constructor(private readonly result: { data: unknown; error: unknown }) {}

  rpc(fn: string, args: unknown) {
    this.calls.push({ fn, args: structuredClone(args) });
    return Promise.resolve(this.result);
  }
}

Deno.test('callLcaReadJobProjectionRpc forwards worker and legacy lookup args', async () => {
  const supabase = new FakeRpcSupabase({
    data: {
      ok: true,
      data: {
        job: {
          workerJobId: TEST_WORKER_JOB_ID,
          legacyJobId: TEST_LEGACY_JOB_ID,
        },
      },
    },
    error: null,
  });

  const result = await callLcaReadJobProjectionRpc(supabase as never, {
    requestedBy: TEST_USER_ID,
    workerJobId: TEST_WORKER_JOB_ID,
    legacyJobId: TEST_LEGACY_JOB_ID,
    includeInternal: true,
  });

  assertEquals(result, {
    ok: true,
    data: {
      job: {
        workerJobId: TEST_WORKER_JOB_ID,
        legacyJobId: TEST_LEGACY_JOB_ID,
      },
    },
  });
  assertEquals(supabase.calls, [
    {
      fn: 'lca_read_job_projection',
      args: {
        p_requested_by: TEST_USER_ID,
        p_worker_job_id: TEST_WORKER_JOB_ID,
        p_legacy_job_id: TEST_LEGACY_JOB_ID,
        p_include_internal: true,
      },
    },
  ]);
});

Deno.test('callLcaReadResultProjectionRpc forwards result auth and format args', async () => {
  const supabase = new FakeRpcSupabase({
    data: {
      ok: true,
      data: {
        result: {
          resultId: TEST_RESULT_ID,
        },
      },
    },
    error: null,
  });

  const result = await callLcaReadResultProjectionRpc(supabase as never, {
    requestedBy: TEST_USER_ID,
    resultId: TEST_RESULT_ID,
    requiredArtifactFormat: 'contribution-path:v1',
  });

  assertEquals(result, {
    ok: true,
    data: {
      result: {
        resultId: TEST_RESULT_ID,
      },
    },
  });
  assertEquals(supabase.calls, [
    {
      fn: 'lca_read_result_projection',
      args: {
        p_requested_by: TEST_USER_ID,
        p_result_id: TEST_RESULT_ID,
        p_required_artifact_format: 'contribution-path:v1',
        p_include_internal: false,
      },
    },
  ]);
});

Deno.test('callLcaReadLatestSingleSolveResultRpc forwards snapshot process args', async () => {
  const supabase = new FakeRpcSupabase({
    data: {
      ok: true,
      data: null,
    },
    error: null,
  });

  const result = await callLcaReadLatestSingleSolveResultRpc(supabase as never, {
    requestedBy: TEST_USER_ID,
    snapshotId: TEST_SNAPSHOT_ID,
    processIndex: 7,
  });

  assertEquals(result, {
    ok: true,
    data: null,
  });
  assertEquals(supabase.calls, [
    {
      fn: 'lca_read_latest_single_solve_result',
      args: {
        p_requested_by: TEST_USER_ID,
        p_snapshot_id: TEST_SNAPSHOT_ID,
        p_process_index: 7,
      },
    },
  ]);
});

Deno.test('callLcaReadResultProjectionRpc preserves DB command failures', async () => {
  const supabase = new FakeRpcSupabase({
    data: {
      ok: false,
      code: 'UNSUPPORTED_LCA_RESULT_ARTIFACT_FORMAT',
      status: 409,
      message: 'format mismatch',
      details: {
        resultId: TEST_RESULT_ID,
      },
    },
    error: null,
  });

  const result = await callLcaReadResultProjectionRpc(supabase as never, {
    requestedBy: TEST_USER_ID,
    resultId: TEST_RESULT_ID,
    requiredArtifactFormat: 'contribution-path:v1',
  });

  assertEquals(result, {
    ok: false,
    code: 'UNSUPPORTED_LCA_RESULT_ARTIFACT_FORMAT',
    status: 409,
    message: 'format mismatch',
    details: {
      resultId: TEST_RESULT_ID,
    },
  });
});
