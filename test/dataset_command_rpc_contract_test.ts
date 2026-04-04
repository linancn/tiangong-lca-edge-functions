import { assertEquals, assertThrows } from 'jsr:@std/assert';

import { buildCommandAuditPayload } from '../supabase/functions/_shared/command_runtime/audit_log.ts';
import { createDatasetCommandRepository } from '../supabase/functions/_shared/commands/dataset/repository.ts';
import { saveDraftRequestSchema } from '../supabase/functions/_shared/commands/dataset/save_draft.ts';
import { submitReviewRequestSchema } from '../supabase/functions/_shared/commands/dataset/submit_review.ts';
import {
  callDatasetSaveDraftRpc,
  callDatasetSubmitReviewRpc,
  type DatasetRpcResult,
} from '../supabase/functions/_shared/db_rpc/dataset_commands.ts';

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

Deno.test('submitReviewRequestSchema rejects unexpected payload fields', () => {
  const parsed = submitReviewRequestSchema.safeParse({
    table: 'processes',
    id: '11111111-1111-4111-8111-111111111111',
    version: '01.00.000',
    reviewId: '33333333-3333-4333-8333-333333333333',
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

const submitReviewRequest = {
  table: 'processes' as const,
  id: '11111111-1111-4111-8111-111111111111',
  version: '01.00.000',
};

const auditPayload = buildCommandAuditPayload({
  command: 'dataset_save_draft',
  actorUserId: '22222222-2222-4222-8222-222222222222',
  targetTable: 'flows',
  targetId: '11111111-1111-4111-8111-111111111111',
  targetVersion: '01.00.000',
  payload: {},
});

Deno.test(
  'callDatasetSaveDraftRpc unwraps success envelopes returned by cmd_dataset_* RPCs',
  async () => {
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
  },
);

Deno.test(
  'callDatasetSaveDraftRpc treats command failure envelopes as command failures',
  async () => {
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
  },
);

Deno.test(
  'callDatasetSubmitReviewRpc unwraps success envelopes returned by cmd_review_submit',
  async () => {
    const result = (await callDatasetSubmitReviewRpc(
      new FakeRpcSupabase({
        data: {
          ok: true,
          data: {
            review: {
              id: '33333333-3333-4333-8333-333333333333',
            },
          },
        },
        error: null,
      }) as never,
      submitReviewRequest,
      auditPayload,
    )) as DatasetRpcResult;

    assertEquals(result, {
      ok: true,
      data: {
        review: {
          id: '33333333-3333-4333-8333-333333333333',
        },
      },
    });
  },
);

Deno.test(
  'callDatasetSubmitReviewRpc treats command failure envelopes as command failures',
  async () => {
    const result = (await callDatasetSubmitReviewRpc(
      new FakeRpcSupabase({
        data: {
          ok: false,
          code: 'REFERENCED_DATA_UNDER_REVIEW',
          status: 409,
          message: 'Referenced data is already under review',
          details: {
            table: 'flows',
            id: '44444444-4444-4444-8444-444444444444',
            version: '01.00.000',
          },
        },
        error: null,
      }) as never,
      submitReviewRequest,
      auditPayload,
    )) as DatasetRpcResult;

    assertEquals(result, {
      ok: false,
      code: 'REFERENCED_DATA_UNDER_REVIEW',
      status: 409,
      message: 'Referenced data is already under review',
      details: {
        table: 'flows',
        id: '44444444-4444-4444-8444-444444444444',
        version: '01.00.000',
      },
    });
  },
);
