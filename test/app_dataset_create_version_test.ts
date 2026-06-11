import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import {
  executeCreateVersionCommand,
  parseCreateVersionCommand,
} from '../supabase/functions/_shared/commands/dataset/create_version.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';
const TEST_MODEL_ID = '33333333-3333-4333-8333-333333333333';

class FakeRpcSupabase {
  rpcCalls: Array<{ fn: string; args: unknown }> = [];
  response: { data: unknown; error: unknown };

  constructor(
    response: { data: unknown; error: unknown } = {
      data: {
        ok: true,
        data: {
          id: TEST_DATASET_ID,
          version: '01.00.001',
        },
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

Deno.test(
  'executeCreateVersionCommand forwards version creation to cmd_dataset_create_version',
  async () => {
    const supabase = new FakeRpcSupabase();
    const result = await executeCreateVersionCommand(
      {
        table: 'processes',
        id: TEST_DATASET_ID,
        sourceVersion: '01.00.000',
        jsonOrdered: { foo: 'bar' },
        modelId: TEST_MODEL_ID,
        ruleVerification: false,
      },
      buildActor(supabase),
    );

    assertEquals(result.ok, true);
    assertEquals(supabase.rpcCalls, [
      {
        fn: 'cmd_dataset_create_version',
        args: {
          p_table: 'processes',
          p_id: TEST_DATASET_ID,
          p_source_version: '01.00.000',
          p_json_ordered: { foo: 'bar' },
          p_model_id: TEST_MODEL_ID,
          p_rule_verification: false,
          p_audit: {
            command: 'dataset_create_version',
            actorUserId: TEST_USER_ID,
            targetTable: 'processes',
            targetId: TEST_DATASET_ID,
            targetVersion: '',
            payload: {
              sourceVersion: '01.00.000',
              modelId: TEST_MODEL_ID,
            },
          },
        },
      },
    ]);
  },
);

Deno.test('executeCreateVersionCommand returns the server allocated version', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeCreateVersionCommand(
    {
      table: 'flows',
      id: TEST_DATASET_ID,
      sourceVersion: '01.00.000',
      jsonOrdered: { foo: 'bar' },
    },
    buildActor(supabase),
  );

  assertEquals(result, {
    ok: true,
    status: 200,
    body: {
      ok: true,
      command: 'dataset_create_version',
      data: {
        id: TEST_DATASET_ID,
        version: '01.00.001',
      },
    },
  });
});

Deno.test('parseCreateVersionCommand rejects missing sourceVersion', () => {
  const result = parseCreateVersionCommand({
    table: 'flows',
    id: TEST_DATASET_ID,
    jsonOrdered: { foo: 'bar' },
  });

  assertEquals(result.ok, false);
});

Deno.test('executeCreateVersionCommand rejects modelId for non-process datasets', async () => {
  const supabase = new FakeRpcSupabase();
  const result = await executeCreateVersionCommand(
    {
      table: 'flows',
      id: TEST_DATASET_ID,
      sourceVersion: '01.00.000',
      jsonOrdered: { foo: 'bar' },
      modelId: TEST_MODEL_ID,
    },
    buildActor(supabase),
  );

  assertEquals(result, {
    ok: false,
    code: 'MODEL_ID_NOT_ALLOWED',
    message: 'modelId is only allowed for process dataset version creates',
    status: 400,
  });
  assertEquals(supabase.rpcCalls, []);
});
