import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import {
  executeCreateCommand,
  parseCreateCommand,
} from '../supabase/functions/_shared/commands/dataset/create.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';
const TEST_MODEL_ID = '33333333-3333-4333-8333-333333333333';

class FakeRpcSupabase {
  rpcCalls: Array<{ fn: string; args: unknown }> = [];
  response: { data: unknown; error: unknown };

  constructor(
    response: { data: unknown; error: unknown } = {
      data: {
        id: TEST_DATASET_ID,
        version: '01.00.000',
      },
      error: null,
    },
  ) {
    this.response = response;
  }

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({
      fn,
      args: structuredClone(args),
    });

    return Promise.resolve(structuredClone(this.response));
  }
}

function buildActor(supabase: FakeRpcSupabase) {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: supabase as unknown as SupabaseClient,
  };
}

Deno.test('executeCreateCommand forwards dataset creation to cmd_dataset_create', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeCreateCommand(
    {
      table: 'processes',
      id: TEST_DATASET_ID,
      jsonOrdered: { foo: 'bar' },
      modelId: TEST_MODEL_ID,
      ruleVerification: false,
    },
    buildActor(supabase),
  );

  assertEquals(result.ok, true);
  assertEquals(supabase.rpcCalls, [
    {
      fn: 'cmd_dataset_create',
      args: {
        p_table: 'processes',
        p_id: TEST_DATASET_ID,
        p_json_ordered: { foo: 'bar' },
        p_model_id: TEST_MODEL_ID,
        p_rule_verification: false,
        p_audit: {
          command: 'dataset_create',
          actorUserId: TEST_USER_ID,
          targetTable: 'processes',
          targetId: TEST_DATASET_ID,
          targetVersion: '',
          payload: {
            modelId: TEST_MODEL_ID,
          },
        },
      },
    },
  ]);
});

Deno.test('executeCreateCommand allows process creates without modelId', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeCreateCommand(
    {
      table: 'processes',
      id: TEST_DATASET_ID,
      jsonOrdered: { foo: 'bar' },
    },
    buildActor(supabase),
  );

  assertEquals(result.ok, true);
  assertEquals(supabase.rpcCalls, [
    {
      fn: 'cmd_dataset_create',
      args: {
        p_table: 'processes',
        p_id: TEST_DATASET_ID,
        p_json_ordered: { foo: 'bar' },
        p_model_id: null,
        p_rule_verification: null,
        p_audit: {
          command: 'dataset_create',
          actorUserId: TEST_USER_ID,
          targetTable: 'processes',
          targetId: TEST_DATASET_ID,
          targetVersion: '',
          payload: {},
        },
      },
    },
  ]);
});

Deno.test('parseCreateCommand rejects invalid dataset create payloads', () => {
  const result = parseCreateCommand({
    table: 'unknown',
    id: 'not-a-uuid',
    jsonOrdered: { foo: 'bar' },
  });

  assertEquals(result.ok, false);
});

Deno.test('executeCreateCommand rejects modelId for non-process datasets', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeCreateCommand(
    {
      table: 'flows',
      id: TEST_DATASET_ID,
      jsonOrdered: { foo: 'bar' },
      modelId: TEST_MODEL_ID,
    },
    buildActor(supabase),
  );

  assertEquals(result, {
    ok: false,
    code: 'MODEL_ID_NOT_ALLOWED',
    message: 'modelId is only allowed for process dataset creates',
    status: 400,
  });
  assertEquals(supabase.rpcCalls, []);
});
