import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import {
  executeSubmitReviewCommand,
  parseSubmitReviewCommand,
} from '../supabase/functions/_shared/commands/dataset/submit_review.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';
const TEST_GATE_RUN_ID = '44444444-4444-4444-8444-444444444444';
const TEST_REVISION_CHECKSUM = 'a'.repeat(64);

class FakeRpcSupabase {
  rpcCalls: Array<{ fn: string; args: unknown }> = [];

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({
      fn,
      args: structuredClone(args),
    });

    return Promise.resolve({
      data: {
        review: {
          id: '33333333-3333-4333-8333-333333333333',
        },
        affected_datasets: [
          {
            table: 'processes',
            id: TEST_DATASET_ID,
            version: '01.00.000',
          },
        ],
      },
      error: null,
    });
  }
}

function buildActor(supabase: FakeRpcSupabase) {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: supabase as unknown as SupabaseClient,
  };
}

Deno.test(
  'executeSubmitReviewCommand forwards dataset review submission to cmd_review_submit',
  async () => {
    const supabase = new FakeRpcSupabase();
    const result = await executeSubmitReviewCommand(
      {
        table: 'processes',
        id: TEST_DATASET_ID,
        version: '01.00.000',
        reviewSubmitGateRunId: TEST_GATE_RUN_ID,
        revisionChecksum: TEST_REVISION_CHECKSUM,
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_review_submit',
        args: {
          p_table: 'processes',
          p_id: TEST_DATASET_ID,
          p_version: '01.00.000',
          p_review_submit_gate_run_id: TEST_GATE_RUN_ID,
          p_review_submit_revision_checksum: TEST_REVISION_CHECKSUM,
          p_review_submit_policy_profile: 'review_submit_fast.v1',
          p_review_submit_report_schema_version: 'review_submit_gate_report.v1',
          p_audit: {
            command: 'dataset_submit_review',
            actorUserId: TEST_USER_ID,
            targetTable: 'processes',
            targetId: TEST_DATASET_ID,
            targetVersion: '01.00.000',
            payload: {
              reviewSubmitGateRunId: TEST_GATE_RUN_ID,
              revisionChecksum: TEST_REVISION_CHECKSUM,
              reviewSubmitPolicyProfile: 'review_submit_fast.v1',
              reviewSubmitReportSchemaVersion: 'review_submit_gate_report.v1',
            },
          },
        },
      },
    ]);
  },
);

Deno.test('parseSubmitReviewCommand requires process review-submit gate metadata', () => {
  const result = parseSubmitReviewCommand({
    table: 'processes',
    id: TEST_DATASET_ID,
    version: '01.00.000',
  });

  assertEquals(result.ok, false);
});
