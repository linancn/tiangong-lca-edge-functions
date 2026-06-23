import { assertEquals, assertThrows } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import { buildCommandAuditPayload } from '../supabase/functions/_shared/command_runtime/audit_log.ts';
import {
  dataProductCommandRequestSchema,
  executeDataProductCommand,
} from '../supabase/functions/_shared/commands/data_product/command.ts';
import {
  createDataProductCommandRepository,
  type DataProductCommandRepository,
} from '../supabase/functions/_shared/commands/data_product/repository.ts';
import type { DataProductCommandRequest } from '../supabase/functions/_shared/commands/data_product/types.ts';
import {
  buildLciaResultBuildRequestRpcArgs,
  buildLciaResultPackagePublishRpcArgs,
  callLciaResultPackagePublishRpc,
  type DataProductRpcResult,
} from '../supabase/functions/_shared/db_rpc/data_product_commands.ts';

const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';
const TEST_BUILD_ID = '33333333-3333-4333-8333-333333333333';
const TEST_WORKER_JOB_ID = '44444444-4444-4444-8444-444444444444';
const TEST_PACKAGE_ID = '55555555-5555-4555-8555-555555555555';

const fakeActor: ActorContext = {
  userId: TEST_USER_ID,
  accessToken: 'access-token',
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient,
};

class FakeRpcSupabase {
  calls: Array<{ fn: string; args: unknown }> = [];

  constructor(private readonly result: { data: unknown; error: unknown }) {}

  rpc(fn: string, args: unknown) {
    this.calls.push({ fn, args: structuredClone(args) });
    return Promise.resolve(this.result);
  }
}

const auditPayload = buildCommandAuditPayload({
  command: 'lcia_result_build_request',
  actorUserId: TEST_USER_ID,
  targetTable: 'worker_jobs',
  targetId: 'pending',
  targetVersion: '',
  payload: {},
});

Deno.test('dataProductCommandRequestSchema accepts create_build defaults', () => {
  const parsed = dataProductCommandRequestSchema.safeParse({
    action: 'create_build',
    name: 'June public LCIA results',
    defaultImpactCategory: 'climate-change',
  });

  assertEquals(parsed.success, true);
  if (parsed.success && parsed.data.action === 'create_build') {
    assertEquals(parsed.data.coverageMode, 'global_eligible');
    assertEquals(parsed.data.lciaMethodSet, []);
  }
});

Deno.test(
  'dataProductCommandRequestSchema rejects package ids on create_build process selections',
  () => {
    const parsed = dataProductCommandRequestSchema.safeParse({
      action: 'create_build',
      name: 'bad selection',
      processes: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          version: '01.00.000',
          packageId: TEST_PACKAGE_ID,
        },
      ],
    });

    assertEquals(parsed.success, false);
  },
);

Deno.test('buildLciaResultBuildRequestRpcArgs maps command payload to DB RPC args', () => {
  const request: DataProductCommandRequest = {
    action: 'create_build',
    name: 'June public LCIA results',
    coverageMode: 'subset',
    defaultImpactCategory: 'climate-change',
    lciaMethodSet: [{ method: 'EF', version: 'v1' }],
    idempotencyKey: 'lcia-result:2026-06',
    processes: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        version: '01.00.000',
      },
    ],
  };

  assertEquals(buildLciaResultBuildRequestRpcArgs(request, auditPayload), {
    p_name: 'June public LCIA results',
    p_processes: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        version: '01.00.000',
      },
    ],
    p_coverage_mode: 'subset',
    p_default_impact_category: 'climate-change',
    p_lcia_method_set: [{ method: 'EF', version: 'v1' }],
    p_idempotency_key: 'lcia-result:2026-06',
    p_audit: auditPayload,
  });
});

Deno.test('buildLciaResultPackagePublishRpcArgs maps publish payload to DB RPC args', () => {
  assertEquals(
    buildLciaResultPackagePublishRpcArgs(
      {
        action: 'publish_package',
        packageId: TEST_PACKAGE_ID,
        displayDefaultImpactCategory: 'climate-change',
        reason: 'June publication',
      },
      auditPayload,
    ),
    {
      p_package_id: TEST_PACKAGE_ID,
      p_display_default_impact_category: 'climate-change',
      p_reason: 'June publication',
      p_audit: auditPayload,
    },
  );
});

Deno.test('callLciaResultPackagePublishRpc treats DB command failures as failures', async () => {
  const result = (await callLciaResultPackagePublishRpc(
    new FakeRpcSupabase({
      data: {
        ok: false,
        code: 'default_impact_missing',
        status: 400,
        message: 'Default impact category is required before publication',
      },
      error: null,
    }) as never,
    {
      action: 'publish_package',
      packageId: TEST_PACKAGE_ID,
      displayDefaultImpactCategory: 'missing-impact',
    },
    auditPayload,
  )) as DataProductRpcResult;

  assertEquals(result, {
    ok: false,
    code: 'default_impact_missing',
    status: 400,
    message: 'Default impact category is required before publication',
  });
});

Deno.test('createDataProductCommandRepository requires an explicit actor Supabase client', () => {
  assertThrows(
    () => createDataProductCommandRepository(undefined as never, {} as never),
    Error,
    'Data product command repository requires an explicit actor Supabase client',
  );
});

Deno.test('createDataProductCommandRepository enqueues LCIA result package payloads', async () => {
  const serviceClient = new FakeRpcSupabase({
    data: {
      ok: true,
      data: {
        id: TEST_WORKER_JOB_ID,
        status: 'queued',
      },
    },
    error: null,
  });
  const repository = createDataProductCommandRepository(
    new FakeRpcSupabase({ data: null, error: null }) as never,
    serviceClient as never,
  );

  const result = await repository.enqueuePackageBuild(
    {
      buildId: TEST_BUILD_ID,
      idempotencyKey: `lcia_result.package_build:${TEST_BUILD_ID}`,
      workerJob: {
        jobKind: 'lcia_result.package_build',
        payload: {
          type: 'lcia_result_package_build',
          build_id: TEST_BUILD_ID,
          requested_by: TEST_USER_ID,
          coverage_mode: 'global_eligible',
          default_impact_category: 'climate-change',
          lcia_method_set: [],
        },
        payloadSchemaVersion: 'lcia_result.package_build.request.v1',
        subjectType: 'lcia_result_build',
        subjectId: TEST_BUILD_ID,
        subjectVersion: null,
        requestedBy: TEST_USER_ID,
        requesterType: 'operator',
        requestHash: 'manifest-hash',
        queueKey: TEST_BUILD_ID,
        visibility: 'operator',
      },
    },
    fakeActor,
  );

  assertEquals(result, {
    ok: true,
    workerJobId: TEST_WORKER_JOB_ID,
    data: {
      id: TEST_WORKER_JOB_ID,
      status: 'queued',
    },
  });
  assertEquals(serviceClient.calls, [
    {
      fn: 'worker_enqueue_job',
      args: {
        p_job_kind: 'lcia_result.package_build',
        p_payload_json: {
          type: 'lcia_result_package_build',
          build_id: TEST_BUILD_ID,
          requested_by: TEST_USER_ID,
          coverage_mode: 'global_eligible',
          default_impact_category: 'climate-change',
          lcia_method_set: [],
        },
        p_payload_schema_version: 'lcia_result.package_build.request.v1',
        p_subject_type: 'lcia_result_build',
        p_subject_id: TEST_BUILD_ID,
        p_subject_version: null,
        p_requested_by: TEST_USER_ID,
        p_requester_type: 'operator',
        p_team_id: null,
        p_idempotency_key: `lcia_result.package_build:${TEST_BUILD_ID}`,
        p_request_hash: 'manifest-hash',
        p_concurrency_key: null,
        p_priority: null,
        p_queue_key: TEST_BUILD_ID,
        p_run_after: null,
        p_visibility: 'operator',
        p_max_attempts: null,
        p_timeout_at: null,
        p_payload_ref: null,
        p_parent_job_id: null,
        p_root_job_id: null,
      },
    },
  ]);
});

Deno.test(
  'executeDataProductCommand create_build enqueues package build and returns workerJobId',
  async () => {
    const calls: string[] = [];
    const repository: DataProductCommandRepository = {
      createBuild: () => {
        calls.push('createBuild');
        return Promise.resolve({
          ok: true,
          data: {
            buildId: TEST_BUILD_ID,
            coverageMode: 'global_eligible',
            eligibleInputCount: 2,
            includedInputCount: 2,
            inputManifestHash: 'manifest-hash',
            workerJob: {
              jobKind: 'lcia_result.package_build',
              payload: {
                type: 'lcia_result_package_build',
                build_id: TEST_BUILD_ID,
              },
              payloadSchemaVersion: 'lcia_result.package_build.request.v1',
              subjectType: 'lcia_result_build',
              subjectId: TEST_BUILD_ID,
              subjectVersion: null,
              requestedBy: TEST_USER_ID,
              requesterType: 'operator',
              requestHash: 'manifest-hash',
              queueKey: TEST_BUILD_ID,
              visibility: 'operator',
            },
          },
        });
      },
      enqueuePackageBuild: (request, actor) => {
        calls.push('enqueuePackageBuild');
        assertEquals(actor.userId, TEST_USER_ID);
        assertEquals(request.buildId, TEST_BUILD_ID);
        assertEquals(request.idempotencyKey, `lcia_result.package_build:${TEST_BUILD_ID}`);
        return Promise.resolve({
          ok: true,
          workerJobId: TEST_WORKER_JOB_ID,
          data: { id: TEST_WORKER_JOB_ID },
        });
      },
      previewPackage: () => Promise.reject(new Error('not used')),
      publishPackage: () => Promise.reject(new Error('not used')),
      unpublishPublication: () => Promise.reject(new Error('not used')),
    };

    const result = await executeDataProductCommand(
      {
        action: 'create_build',
        name: 'June public LCIA results',
        coverageMode: 'global_eligible',
        defaultImpactCategory: 'climate-change',
        lciaMethodSet: [],
      },
      fakeActor,
      repository,
    );

    assertEquals(calls, ['createBuild', 'enqueuePackageBuild']);
    assertEquals(result, {
      ok: true,
      status: 200,
      body: {
        ok: true,
        command: 'lcia_result_build_request',
        data: {
          buildId: TEST_BUILD_ID,
          coverageMode: 'global_eligible',
          eligibleInputCount: 2,
          includedInputCount: 2,
          inputManifestHash: 'manifest-hash',
          workerJob: {
            jobKind: 'lcia_result.package_build',
            payload: {
              type: 'lcia_result_package_build',
              build_id: TEST_BUILD_ID,
            },
            payloadSchemaVersion: 'lcia_result.package_build.request.v1',
            subjectType: 'lcia_result_build',
            subjectId: TEST_BUILD_ID,
            subjectVersion: null,
            requestedBy: TEST_USER_ID,
            requesterType: 'operator',
            requestHash: 'manifest-hash',
            queueKey: TEST_BUILD_ID,
            visibility: 'operator',
          },
          workerJobId: TEST_WORKER_JOB_ID,
        },
      },
    });
  },
);

Deno.test('executeDataProductCommand propagates manager authorization failures', async () => {
  const repository: DataProductCommandRepository = {
    createBuild: () =>
      Promise.resolve({
        ok: false,
        code: 'not_data_product_manager',
        status: 403,
        message: 'Data product manager role is required',
      }),
    enqueuePackageBuild: () => Promise.reject(new Error('not used')),
    previewPackage: () => Promise.reject(new Error('not used')),
    publishPackage: () => Promise.reject(new Error('not used')),
    unpublishPublication: () => Promise.reject(new Error('not used')),
  };

  const result = await executeDataProductCommand(
    {
      action: 'create_build',
      name: 'June public LCIA results',
      coverageMode: 'global_eligible',
      lciaMethodSet: [],
    },
    fakeActor,
    repository,
  );

  assertEquals(result, {
    ok: false,
    code: 'not_data_product_manager',
    status: 403,
    message: 'Data product manager role is required',
  });
});
