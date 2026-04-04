import { assertEquals, assertThrows } from 'jsr:@std/assert';

import { createDatasetCommandRepository } from '../supabase/functions/_shared/commands/dataset/repository.ts';
import {
  callDatasetSaveDraftRpc,
  type DatasetRpcResult,
} from '../supabase/functions/_shared/db_rpc/dataset_commands.ts';
import { buildCommandAuditPayload } from '../supabase/functions/_shared/command_runtime/audit_log.ts';
import { saveDraftRequestSchema } from '../supabase/functions/_shared/commands/dataset/save_draft.ts';

Deno.test('saveDraftRequestSchema rejects server-owned ruleVerification input', () => {
  const parsed = saveDraftRequestSchema.safeParse({
    table: 'flows',
    id: '11111111-1111-4111-8111-111111111111',
    version: '01.00.000',
    jsonOrdered: {},
    ruleVerification: true,
  });

  assertEquals(parsed.success, false);
});

Deno.test('createDatasetCommandRepository requires an explicit Supabase client', () => {
  assertThrows(
    () => createDatasetCommandRepository(undefined as never),
    Error,
    'Dataset command repository requires an explicit Supabase client',
  );
});

class FakeRpcSupabase {
  constructor(private readonly result: { data: unknown; error: unknown }) {}

  rpc() {
    return Promise.resolve(this.result);
  }
}

const draftRequest = {
  table: 'flows' as const,
  id: '11111111-1111-4111-8111-111111111111',
  version: '01.00.000',
  jsonOrdered: { foo: 'bar' },
};

const auditPayload = buildCommandAuditPayload({
  command: 'dataset_save_draft',
  actorUserId: '22222222-2222-4222-8222-222222222222',
  targetTable: 'flows',
  targetId: '11111111-1111-4111-8111-111111111111',
  targetVersion: '01.00.000',
  payload: {},
});

Deno.test('callDatasetSaveDraftRpc unwraps success envelopes returned by cmd_dataset_* RPCs', async () => {
  const result = (await callDatasetSaveDraftRpc(
    new FakeRpcSupabase({
      data: {
        ok: true,
        data: {
          id: draftRequest.id,
          version: draftRequest.version,
        },
      },
      error: null,
    }) as never,
    draftRequest,
    auditPayload,
  )) as DatasetRpcResult;

  assertEquals(result, {
    ok: true,
    data: {
      id: draftRequest.id,
      version: draftRequest.version,
    },
  });
});

Deno.test('callDatasetSaveDraftRpc treats command failure envelopes as command failures', async () => {
  const result = (await callDatasetSaveDraftRpc(
    new FakeRpcSupabase({
      data: {
        ok: false,
        code: 'DATA_UNDER_REVIEW',
        status: 403,
        message: 'Data is under review and cannot be modified',
        details: {
          state_code: 20,
          review_state_code: 20,
        },
      },
      error: null,
    }) as never,
    draftRequest,
    auditPayload,
  )) as DatasetRpcResult;

  assertEquals(result, {
    ok: false,
    code: 'DATA_UNDER_REVIEW',
    status: 403,
    message: 'Data is under review and cannot be modified',
    details: {
      state_code: 20,
      review_state_code: 20,
    },
  });
});
