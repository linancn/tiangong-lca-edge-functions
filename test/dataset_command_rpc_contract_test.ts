import { assertEquals, assertThrows } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import {
  createDatasetApiV1Repository,
  DATASET_API_V1_CONTRACT,
} from '../supabase/functions/_shared/capabilities/dataset_api_v1.ts';
import { buildCommandAuditPayload } from '../supabase/functions/_shared/command_runtime/audit_log.ts';
import { createRequestSchema } from '../supabase/functions/_shared/commands/dataset/create.ts';
import { createVersionRequestSchema } from '../supabase/functions/_shared/commands/dataset/create_version.ts';
import { deleteRequestSchema } from '../supabase/functions/_shared/commands/dataset/delete.ts';
import {
  createDatasetCommandRepository,
  createLegacyDatasetCommandRepository,
} from '../supabase/functions/_shared/commands/dataset/repository.ts';
import { reviewSubmitGateRequestSchema } from '../supabase/functions/_shared/commands/dataset/review_submit_gate.ts';
import { reviewSubmitJobRequestSchema } from '../supabase/functions/_shared/commands/dataset/review_submit_jobs.ts';
import { saveDraftRequestSchema } from '../supabase/functions/_shared/commands/dataset/save_draft.ts';
import { submitReviewRequestSchema } from '../supabase/functions/_shared/commands/dataset/submit_review.ts';
import {
  callDatasetCreateRpc,
  callDatasetCreateVersionRpc,
  callDatasetDeleteRpc,
  callDatasetReviewSubmitGateRpc,
  callDatasetReviewSubmitJobEnqueueRpc,
  callDatasetReviewSubmitJobReadRpc,
  callDatasetSubmitReviewRpc,
  type DatasetRpcResult,
} from '../supabase/functions/_shared/db_rpc/dataset_commands.ts';
import type {
  RequestJwtSupabaseClient,
  ServiceRoleSupabaseClient,
} from '../supabase/functions/_shared/supabase_client.ts';

Deno.test('saveDraftRequestSchema accepts optional ruleVerification metadata', () => {
  const parsed = saveDraftRequestSchema.safeParse({
    table: 'flows',
    id: '11111111-1111-4111-8111-111111111111',
    version: '01.00.000',
    jsonOrdered: {},
    ruleVerification: false,
  });

  assertEquals(parsed.success, true);
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

Deno.test('submitReviewRequestSchema requires process gate metadata', () => {
  const parsed = submitReviewRequestSchema.safeParse({
    table: 'processes',
    id: '11111111-1111-4111-8111-111111111111',
    version: '01.00.000',
  });

  assertEquals(parsed.success, false);
});

Deno.test(
  'reviewSubmitGateRequestSchema defaults action and review-submit gate contract versions',
  () => {
    const parsed = reviewSubmitGateRequestSchema.safeParse({
      table: 'processes',
      id: '11111111-1111-4111-8111-111111111111',
      version: '01.00.000',
      revisionChecksum: 'a'.repeat(64),
    });

    assertEquals(parsed.success, true);
    if (parsed.success) {
      assertEquals(parsed.data.action, 'ensure');
      assertEquals(parsed.data.policyProfile, 'review_submit_fast.v1');
      assertEquals(parsed.data.reportSchemaVersion, 'review_submit_gate_report.v1');
    }
  },
);

Deno.test(
  'reviewSubmitJobRequestSchema defaults enqueue action and review-submit gate contract versions',
  () => {
    const parsed = reviewSubmitJobRequestSchema.safeParse({
      table: 'processes',
      id: '11111111-1111-4111-8111-111111111111',
      version: '01.00.000',
    });

    assertEquals(parsed.success, true);
    if (parsed.success && parsed.data.action === 'enqueue') {
      assertEquals(parsed.data.action, 'enqueue');
      assertEquals(parsed.data.policyProfile, 'review_submit_fast.v1');
      assertEquals(parsed.data.reportSchemaVersion, 'review_submit_gate_report.v1');
    }
  },
);

Deno.test('createRequestSchema rejects create payloads with version fields', () => {
  const parsed = createRequestSchema.safeParse({
    table: 'flows',
    id: '11111111-1111-4111-8111-111111111111',
    version: '01.00.000',
    jsonOrdered: {},
  });

  assertEquals(parsed.success, false);
});

Deno.test('createRequestSchema accepts optional ruleVerification', () => {
  const parsed = createRequestSchema.safeParse({
    table: 'flows',
    id: '11111111-1111-4111-8111-111111111111',
    jsonOrdered: {},
    ruleVerification: false,
  });

  assertEquals(parsed.success, true);
});

Deno.test(
  'createVersionRequestSchema requires sourceVersion and rejects target version fields',
  () => {
    const parsed = createVersionRequestSchema.safeParse({
      table: 'flows',
      id: '11111111-1111-4111-8111-111111111111',
      version: '01.00.001',
      jsonOrdered: {},
    });

    assertEquals(parsed.success, false);
  },
);

Deno.test('createVersionRequestSchema accepts sourceVersion and optional ruleVerification', () => {
  const parsed = createVersionRequestSchema.safeParse({
    table: 'flows',
    id: '11111111-1111-4111-8111-111111111111',
    sourceVersion: '01.00.000',
    jsonOrdered: {},
    ruleVerification: false,
  });

  assertEquals(parsed.success, true);
});

Deno.test('deleteRequestSchema rejects unexpected payload fields', () => {
  const parsed = deleteRequestSchema.safeParse({
    table: 'flows',
    id: '11111111-1111-4111-8111-111111111111',
    version: '01.00.000',
    jsonOrdered: {},
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

Deno.test('dataset api v1 fixes the complete request-JWT save-draft contract', () => {
  assertEquals(Object.isFrozen(DATASET_API_V1_CONTRACT), true);
  assertEquals(DATASET_API_V1_CONTRACT, {
    contractVersion: 'supabase-consumer.v1',
    logicalCapability: 'dataset.save-draft',
    transport: 'data-api-rpc',
    schema: 'api',
    object: 'cmd_dataset_save_draft',
    signature: 'cmd_dataset_save_draft(text,uuid,text,jsonb,uuid,boolean,jsonb)',
    callerIdentity: 'request-jwt',
    authPropagation: 'caller-access-token',
    compatibility: 'preserve-request-response-error-auth-idempotency-audit',
    fallback: 'none',
    legacyIdentity: 'public.cmd_dataset_save_draft',
    legacyRemovalGate: 'consumer-zero-burn-in-contract-approval',
  });
});

function assertDatasetApiIdentityBoundary(
  requestClient: RequestJwtSupabaseClient,
  serviceClient: ServiceRoleSupabaseClient,
  unclassifiedClient: SupabaseClient,
) {
  createDatasetApiV1Repository(requestClient);
  createDatasetCommandRepository(requestClient);

  // @ts-expect-error A service-role client cannot enter a request-JWT adapter.
  createDatasetApiV1Repository(serviceClient);
  // @ts-expect-error A service-role client cannot enter a request-JWT command repository.
  createDatasetCommandRepository(serviceClient);
  // @ts-expect-error An unclassified client cannot enter a request-JWT adapter.
  createDatasetApiV1Repository(unclassifiedClient);
}

void assertDatasetApiIdentityBoundary;

class FakeRpcSupabase {
  calls: Array<{ fn: string; args: unknown }> = [];
  scopedCalls: Array<{ schema: string; routine: string; args: unknown }> = [];
  schemas: string[] = [];

  constructor(private readonly result: { data: unknown; error: unknown }) {}

  schema(name: string) {
    this.schemas.push(name);
    return {
      rpc: (routine: string, args: unknown) => {
        this.scopedCalls.push({
          schema: name,
          routine,
          args: structuredClone(args),
        });
        return Promise.resolve(this.result);
      },
    };
  }

  rpc(fn: string, args: unknown) {
    this.calls.push({ fn, args: structuredClone(args) });
    return Promise.resolve(this.result);
  }
}

class FakeLegacyRpcSupabase {
  calls: Array<{ fn: string; args: unknown }> = [];

  constructor(private readonly result: { data: unknown; error: unknown }) {}

  rpc(fn: string, args: unknown) {
    this.calls.push({ fn, args: structuredClone(args) });
    return Promise.resolve(this.result);
  }
}

const draftRequest = {
  table: 'flows' as const,
  id: '11111111-1111-4111-8111-111111111111',
  version: '01.00.000',
  jsonOrdered: { foo: 'bar' },
};

const createRequest = {
  table: 'processes' as const,
  id: '11111111-1111-4111-8111-111111111111',
  jsonOrdered: { foo: 'bar' },
  modelId: '33333333-3333-4333-8333-333333333333',
};

const createVersionRequest = {
  table: 'processes' as const,
  id: '11111111-1111-4111-8111-111111111111',
  sourceVersion: '01.00.000',
  jsonOrdered: { foo: 'bar' },
  modelId: '33333333-3333-4333-8333-333333333333',
  ruleVerification: false,
};

const deleteRequest = {
  table: 'flows' as const,
  id: '11111111-1111-4111-8111-111111111111',
  version: '01.00.000',
};

const submitReviewRequest = {
  table: 'processes' as const,
  id: '11111111-1111-4111-8111-111111111111',
  version: '01.00.000',
  reviewSubmitGateRunId: '44444444-4444-4444-8444-444444444444',
  revisionChecksum: 'a'.repeat(64),
};

const reviewSubmitGateRequest = {
  table: 'processes' as const,
  id: '11111111-1111-4111-8111-111111111111',
  version: '01.00.000',
  revisionChecksum: 'a'.repeat(64),
  action: 'ensure' as const,
  policyProfile: 'review_submit_fast.v1' as const,
  reportSchemaVersion: 'review_submit_gate_report.v1' as const,
};

const reviewSubmitJobEnqueueRequest = {
  action: 'enqueue' as const,
  table: 'processes' as const,
  id: '11111111-1111-4111-8111-111111111111',
  version: '01.00.000',
  revisionChecksum: 'a'.repeat(64),
  policyProfile: 'review_submit_fast.v1' as const,
  reportSchemaVersion: 'review_submit_gate_report.v1' as const,
};

const reviewSubmitJobReadRequest = {
  action: 'read' as const,
  reviewSubmitJobId: '55555555-5555-4555-8555-555555555555',
};

const auditPayload = buildCommandAuditPayload({
  command: 'dataset_save_draft',
  actorUserId: '22222222-2222-4222-8222-222222222222',
  targetTable: 'flows',
  targetId: '11111111-1111-4111-8111-111111111111',
  targetVersion: '01.00.000',
  payload: {},
});

Deno.test('legacy dataset repository excludes save-draft from its domain methods', () => {
  const legacy = createLegacyDatasetCommandRepository(
    new FakeRpcSupabase({ data: null, error: null }) as never,
  );

  assertEquals('saveDraft' in legacy, false);
});

Deno.test('legacy dataset command stays on one root RPC without selecting api', async () => {
  const supabase = new FakeLegacyRpcSupabase({
    data: {
      ok: true,
      data: { id: createRequest.id, version: '01.00.000' },
    },
    error: null,
  });
  const repository = createDatasetCommandRepository(
    supabase as unknown as RequestJwtSupabaseClient,
  );

  const result = await repository.create(createRequest, auditPayload);

  assertEquals(result.ok, true);
  assertEquals(supabase.calls, [
    {
      fn: 'cmd_dataset_create',
      args: {
        p_table: 'processes',
        p_id: createRequest.id,
        p_json_ordered: createRequest.jsonOrdered,
        p_model_id: createRequest.modelId,
        p_rule_verification: null,
        p_audit: auditPayload,
      },
    },
  ]);
});

Deno.test(
  'callDatasetCreateRpc unwraps success envelopes returned by cmd_dataset_create',
  async () => {
    const result = (await callDatasetCreateRpc(
      new FakeRpcSupabase({
        data: {
          ok: true,
          data: {
            id: createRequest.id,
            version: '01.00.000',
          },
        },
        error: null,
      }) as never,
      createRequest,
      auditPayload,
    )) as DatasetRpcResult;

    assertEquals(result, {
      ok: true,
      data: {
        id: createRequest.id,
        version: '01.00.000',
      },
    });
  },
);

Deno.test(
  'callDatasetCreateVersionRpc forwards create-version RPC args and unwraps success envelopes',
  async () => {
    const supabase = new FakeRpcSupabase({
      data: {
        ok: true,
        data: {
          id: createVersionRequest.id,
          version: '01.00.001',
        },
      },
      error: null,
    });
    const result = (await callDatasetCreateVersionRpc(
      supabase as never,
      createVersionRequest,
      auditPayload,
    )) as DatasetRpcResult;

    assertEquals(result, {
      ok: true,
      data: {
        id: createVersionRequest.id,
        version: '01.00.001',
      },
    });
    assertEquals(supabase.calls, [
      {
        fn: 'cmd_dataset_create_version',
        args: {
          p_table: 'processes',
          p_id: createVersionRequest.id,
          p_source_version: createVersionRequest.sourceVersion,
          p_json_ordered: createVersionRequest.jsonOrdered,
          p_model_id: createVersionRequest.modelId,
          p_rule_verification: false,
          p_audit: auditPayload,
        },
      },
    ]);
  },
);

Deno.test('callDatasetDeleteRpc treats command failure envelopes as command failures', async () => {
  const result = (await callDatasetDeleteRpc(
    new FakeRpcSupabase({
      data: {
        ok: false,
        code: 'DATASET_NOT_FOUND',
        status: 404,
        message: 'Dataset not found',
      },
      error: null,
    }) as never,
    deleteRequest,
    auditPayload,
  )) as DatasetRpcResult;

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, 'DATASET_NOT_FOUND');
    assertEquals(result.status, 404);
    assertEquals(result.message, 'Dataset not found');
    assertEquals(result.details, undefined);
  }
});

Deno.test(
  'dataset api v1 repository unwraps success envelopes returned by cmd_dataset_* RPCs',
  async () => {
    const supabase = new FakeRpcSupabase({
      data: {
        ok: true,
        data: {
          id: draftRequest.id,
          version: draftRequest.version,
        },
      },
      error: null,
    });
    const result = (await createDatasetApiV1Repository(supabase as never).saveDraft(
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
    assertEquals(supabase.schemas, ['api']);
    assertEquals(supabase.calls, []);
    assertEquals(supabase.scopedCalls, [
      {
        schema: 'api',
        routine: 'cmd_dataset_save_draft',
        args: {
          p_table: 'flows',
          p_id: draftRequest.id,
          p_version: draftRequest.version,
          p_json_ordered: draftRequest.jsonOrdered,
          p_model_id: null,
          p_audit: auditPayload,
          p_rule_verification: null,
        },
      },
    ]);
  },
);

Deno.test(
  'dataset api v1 repository treats command failure envelopes as command failures',
  async () => {
    const result = (await createDatasetApiV1Repository(
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
    ).saveDraft(draftRequest, auditPayload)) as DatasetRpcResult;

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

Deno.test('dataset api v1 reuses one api binding across save-draft retries', async () => {
  const supabase = new FakeRpcSupabase({
    data: {
      ok: true,
      data: { id: draftRequest.id, version: draftRequest.version },
    },
    error: null,
  });
  const repository = createDatasetCommandRepository(
    supabase as unknown as RequestJwtSupabaseClient,
  );

  assertEquals(supabase.schemas, []);
  await repository.saveDraft(draftRequest, auditPayload);
  await repository.saveDraft(draftRequest, auditPayload);

  assertEquals(supabase.schemas, ['api']);
  assertEquals(supabase.calls, []);
  assertEquals(supabase.scopedCalls.length, 2);
  assertEquals(
    supabase.scopedCalls.map(({ schema, routine }) => ({ schema, routine })),
    [
      { schema: 'api', routine: 'cmd_dataset_save_draft' },
      { schema: 'api', routine: 'cmd_dataset_save_draft' },
    ],
  );
});

Deno.test('dataset api v1 returns missing-routine errors without a root fallback', async () => {
  const supabase = new FakeRpcSupabase({
    data: null,
    error: { code: 'PGRST202', message: 'Could not find the function' },
  });
  const repository = createDatasetCommandRepository(
    supabase as unknown as RequestJwtSupabaseClient,
  );

  const result = await repository.saveDraft(draftRequest, auditPayload);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.code, 'PGRST202');
  }
  assertEquals(supabase.schemas, ['api']);
  assertEquals(supabase.calls, []);
  assertEquals(supabase.scopedCalls.length, 1);
});

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

Deno.test('callDatasetReviewSubmitGateRpc unwraps review-submit gate run envelopes', async () => {
  const result = (await callDatasetReviewSubmitGateRpc(
    new FakeRpcSupabase({
      data: {
        ok: true,
        data: {
          status: 'queued',
          gateRunId: '44444444-4444-4444-8444-444444444444',
        },
      },
      error: null,
    }) as never,
    reviewSubmitGateRequest,
    auditPayload,
  )) as DatasetRpcResult;

  assertEquals(result, {
    ok: true,
    data: {
      status: 'queued',
      gateRunId: '44444444-4444-4444-8444-444444444444',
    },
  });
});

Deno.test('callDatasetReviewSubmitJobEnqueueRpc forwards enqueue job RPC args', async () => {
  const supabase = new FakeRpcSupabase({
    data: {
      ok: true,
      data: {
        status: 'waiting_gate',
        reviewSubmitJobId: reviewSubmitJobReadRequest.reviewSubmitJobId,
      },
    },
    error: null,
  });
  const result = (await callDatasetReviewSubmitJobEnqueueRpc(
    supabase as never,
    reviewSubmitJobEnqueueRequest,
    auditPayload,
  )) as DatasetRpcResult;

  assertEquals(result, {
    ok: true,
    data: {
      status: 'waiting_gate',
      reviewSubmitJobId: reviewSubmitJobReadRequest.reviewSubmitJobId,
    },
  });
  assertEquals(supabase.calls, [
    {
      fn: 'cmd_dataset_review_submit_job_enqueue',
      args: {
        p_table: 'processes',
        p_id: reviewSubmitJobEnqueueRequest.id,
        p_version: reviewSubmitJobEnqueueRequest.version,
        p_revision_checksum: reviewSubmitJobEnqueueRequest.revisionChecksum,
        p_policy_profile: 'review_submit_fast.v1',
        p_report_schema_version: 'review_submit_gate_report.v1',
        p_audit: auditPayload,
      },
    },
  ]);
});

Deno.test('callDatasetReviewSubmitJobReadRpc unwraps review-submit job envelopes', async () => {
  const supabase = new FakeRpcSupabase({
    data: {
      ok: true,
      data: {
        status: 'submitted',
        reviewSubmitJobId: reviewSubmitJobReadRequest.reviewSubmitJobId,
      },
    },
    error: null,
  });
  const result = (await callDatasetReviewSubmitJobReadRpc(
    supabase as never,
    reviewSubmitJobReadRequest,
  )) as DatasetRpcResult;

  assertEquals(result, {
    ok: true,
    data: {
      status: 'submitted',
      reviewSubmitJobId: reviewSubmitJobReadRequest.reviewSubmitJobId,
    },
  });
  assertEquals(supabase.calls, [
    {
      fn: 'cmd_dataset_review_submit_job_read',
      args: {
        p_job_id: reviewSubmitJobReadRequest.reviewSubmitJobId,
      },
    },
  ]);
});
