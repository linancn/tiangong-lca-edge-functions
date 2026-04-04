import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import { executeSubmitReviewCommand } from '../supabase/functions/_shared/commands/dataset/submit_review.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';

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
          p_audit: {
            command: 'dataset_submit_review',
            actorUserId: TEST_USER_ID,
            targetTable: 'processes',
            targetId: TEST_DATASET_ID,
            targetVersion: '01.00.000',
            payload: {},
          },
        },
      },
    ]);
  },
);
