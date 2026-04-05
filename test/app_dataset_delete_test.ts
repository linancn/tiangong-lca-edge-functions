import { assertEquals } from "jsr:@std/assert";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2.98.0";

import { executeDeleteCommand } from "../supabase/functions/_shared/commands/dataset/delete.ts";

const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
const TEST_DATASET_ID = "22222222-2222-4222-8222-222222222222";

class FakeRpcSupabase {
  rpcCalls: Array<{ fn: string; args: unknown }> = [];

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({
      fn,
      args: structuredClone(args),
    });

    return Promise.resolve({
      data: {
        id: TEST_DATASET_ID,
        deleted: true,
      },
      error: null,
    });
  }
}

function buildActor(supabase: FakeRpcSupabase) {
  return {
    userId: TEST_USER_ID,
    accessToken: "access-token",
    supabase: supabase as unknown as SupabaseClient,
  };
}

Deno.test("executeDeleteCommand forwards dataset deletion to cmd_dataset_delete", async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeDeleteCommand(
    {
      table: "flows",
      id: TEST_DATASET_ID,
      version: "01.00.000",
    },
    buildActor(supabase),
  );

  assertEquals(result.ok, true);
  assertEquals(supabase.rpcCalls, [
    {
      fn: "cmd_dataset_delete",
      args: {
        p_table: "flows",
        p_id: TEST_DATASET_ID,
        p_version: "01.00.000",
        p_audit: {
          command: "dataset_delete",
          actorUserId: TEST_USER_ID,
          targetTable: "flows",
          targetId: TEST_DATASET_ID,
          targetVersion: "01.00.000",
          payload: {},
        },
      },
    },
  ]);
});
