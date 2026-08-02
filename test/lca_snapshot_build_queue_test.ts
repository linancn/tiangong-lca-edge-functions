import { assert, assertEquals, assertMatch } from 'jsr:@std/assert';

import { ensureLcaSnapshotBuildQueued } from '../supabase/functions/_shared/lca_snapshot_build_queue.ts';
import {
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH,
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256,
} from '../supabase/functions/_shared/lca_snapshot_scope.ts';

type MockState = {
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  concurrencyRows?: Array<Record<string, unknown>>;
};

function createSupabaseMock(state: MockState) {
  return {
    schema(schema: string) {
      assertEquals(schema, 'api');
      return this;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
      if (fn === 'worker_list_jobs_by_concurrency_key_v1') {
        return Promise.resolve({
          data: { ok: true, data: state.concurrencyRows ?? [] },
          error: null,
        });
      }
      if (fn === 'cmd_lca_snapshot_create_v1') {
        return Promise.resolve({
          data: { snapshotId: args.p_snapshot_id, created: true },
          error: null,
        });
      }
      return Promise.resolve({
        data: {
          ok: true,
          data: {
            id: 'worker-job-1',
            payload: args.p_payload_json,
          },
        },
        error: null,
      });
    },
  };
}

Deno.test(
  'snapshot queue sends exact scope, actor, LCIA source, and coverage proof to worker',
  async () => {
    const state: MockState = { rpcCalls: [] };
    const result = await ensureLcaSnapshotBuildQueued(createSupabaseMock(state) as never, {
      scope: 'prod',
      dataScope: 'public_plus_owner_draft',
      userId: 'user-1',
    });

    assert(result.ok);
    assertEquals(result.worker_job_id, 'worker-job-1');
    assertEquals(result.calculation_contract.data_scope, 'public_plus_owner_draft');
    assertEquals(result.calculation_contract.process_filter.process_states, [100]);
    assertEquals(result.calculation_contract.process_filter.include_user_state_codes, [0]);
    assertEquals(result.calculation_contract.process_filter.include_user_unassigned_only, true);
    assertEquals(result.calculation_contract.process_filter.include_user_review_free_only, true);
    assertEquals(result.calculation_contract.process_filter.selection_mode, 'filtered_library');
    assertEquals(result.calculation_contract.process_filter.request_roots, []);
    assertMatch(result.calculation_contract.scope_manifest_sha256 ?? '', /^[0-9a-f]{64}$/);
    assertEquals(
      result.calculation_contract.lcia_factor_coverage_contract?.missing_factor_semantics,
      'incomplete_coverage_not_zero',
    );

    const snapshotCreate = state.rpcCalls.find((call) => call.fn === 'cmd_lca_snapshot_create_v1');
    assert(snapshotCreate);
    assertEquals(snapshotCreate.args.p_scope, 'full_library');
    assertEquals(snapshotCreate.args.p_created_by, 'user-1');
    assertEquals(snapshotCreate.args.p_process_filter, result.calculation_contract.process_filter);

    assertEquals(state.rpcCalls.length, 3);
    assertEquals(state.rpcCalls[0].fn, 'worker_list_jobs_by_concurrency_key_v1');
    assertEquals(state.rpcCalls[0].args.p_job_kind, 'lca.build_snapshot');
    assertEquals(state.rpcCalls[0].args.p_limit, 20);
    const enqueueCall = state.rpcCalls.find((call) => call.fn === 'worker_enqueue_job_v1');
    assert(enqueueCall);
    assertEquals(state.rpcCalls[0].args.p_concurrency_key, enqueueCall.args.p_concurrency_key);
    const rpcArgs = enqueueCall.args;
    assertEquals(rpcArgs.p_job_kind, 'lca.build_snapshot');
    assertEquals(rpcArgs.p_payload_schema_version, 'lca.build_snapshot.request.v2');
    assertEquals(rpcArgs.p_requested_by, 'user-1');

    const payload = rpcArgs.p_payload_json as Record<string, unknown>;
    assertEquals(payload.data_scope, 'public_plus_owner_draft');
    assertEquals(payload.process_states, '100');
    assertEquals(payload.include_user_id, 'user-1');
    assertEquals(payload.include_user_state_codes, '0');
    assertEquals(payload.include_user_unassigned_only, true);
    assertEquals(payload.include_user_review_free_only, true);
    assertEquals('request_roots' in payload, false);
    assertEquals(payload.scope_manifest, result.calculation_contract.scope_manifest);
    assertEquals(payload.scope_manifest_sha256, result.calculation_contract.scope_manifest_sha256);
    assertEquals(
      (payload.lcia_method_factor_source as { snapshot_binding: { required: boolean } })
        .snapshot_binding.required,
      true,
    );
    assertEquals(
      (payload.lcia_method_factor_source as { bundle_manifest_path: string }).bundle_manifest_path,
      LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH,
    );
    assertEquals(
      (payload.lcia_method_factor_source as { bundle_manifest_sha256: string })
        .bundle_manifest_sha256,
      LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256,
    );
    assertEquals(
      (payload.lcia_factor_coverage_contract as { missing_factor_semantics: string })
        .missing_factor_semantics,
      'incomplete_coverage_not_zero',
    );
  },
);

Deno.test(
  'snapshot queue skips an expired newest candidate and reuses the next active job',
  async () => {
    const now = Date.now();
    const state: MockState = {
      rpcCalls: [],
      concurrencyRows: [
        {
          id: 'expired-worker-job',
          status: 'queued',
          createdAt: new Date(now - 11 * 60 * 1000).toISOString(),
          payload: { job_id: 'expired-job', snapshot_id: 'expired-snapshot' },
        },
        {
          id: 'active-worker-job',
          status: 'running',
          createdAt: new Date(now - 20 * 60 * 1000).toISOString(),
          startedAt: new Date(now - 5 * 60 * 1000).toISOString(),
          payload: { job_id: 'active-job', snapshot_id: 'active-snapshot' },
        },
      ],
    };

    const result = await ensureLcaSnapshotBuildQueued(createSupabaseMock(state) as never, {
      scope: 'prod',
      dataScope: 'public_plus_owner_draft',
      userId: 'user-1',
    });

    assert(result.ok);
    assertEquals(result.job_id, 'active-job');
    assertEquals(result.snapshot_id, 'active-snapshot');
    assertEquals(result.worker_job_id, 'active-worker-job');
    assertEquals(state.rpcCalls.length, 1);
    assertEquals(state.rpcCalls[0].fn, 'worker_list_jobs_by_concurrency_key_v1');
  },
);

Deno.test('snapshot queue ignores client source locator and no-LCIA override fields', async () => {
  const state: MockState = { rpcCalls: [] };
  const enqueue = ensureLcaSnapshotBuildQueued as unknown as (
    supabase: ReturnType<typeof createSupabaseMock>,
    args: Record<string, unknown>,
  ) => ReturnType<typeof ensureLcaSnapshotBuildQueued>;
  const result = await enqueue(createSupabaseMock(state), {
    scope: 'prod',
    dataScope: 'public_plus_owner_draft',
    userId: 'user-1',
    no_lcia: true,
    bundle_manifest_path: '../../attacker.json',
    bundle_manifest_sha256: '0'.repeat(64),
    base_url: 'https://attacker.invalid/',
  });

  assert(result.ok);
  const enqueueCall = state.rpcCalls.find((call) => call.fn === 'worker_enqueue_job_v1');
  assert(enqueueCall);
  const payload = enqueueCall.args.p_payload_json as Record<string, unknown>;
  const source = payload.lcia_method_factor_source as Record<string, unknown>;
  assertEquals(payload.no_lcia, false);
  assertEquals(source.bundle_manifest_path, LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH);
  assertEquals(source.bundle_manifest_sha256, LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256);
  assertEquals(source.base_url_binding, 'worker_trusted_configuration');
  assertEquals('base_url' in source, false);
});

Deno.test(
  'root-scoped queue binds roots into payload, snapshot identity, and idempotency',
  async () => {
    const rootA = {
      process_id: '11111111-1111-4111-8111-111111111111',
      process_version: '00.00.001',
    };
    const rootB = {
      process_id: '22222222-2222-4222-8222-222222222222',
      process_version: '01.00.000',
    };

    const enqueue = async (requestRoots?: Array<typeof rootA>) => {
      const state: MockState = { rpcCalls: [] };
      const result = await ensureLcaSnapshotBuildQueued(createSupabaseMock(state) as never, {
        scope: 'prod',
        dataScope: 'public_plus_owner_draft',
        userId: 'user-1',
        requestRoots,
      });
      assert(result.ok);
      return { state, result };
    };

    const canonical = await enqueue([rootA, rootB, rootA]);
    const reordered = await enqueue([rootB, rootA]);
    const onlyA = await enqueue([rootA]);
    const onlyB = await enqueue([rootB]);
    const full = await enqueue();

    const canonicalArgs = canonical.state.rpcCalls.find(
      (call) => call.fn === 'worker_enqueue_job_v1',
    )!.args;
    const canonicalPayload = canonicalArgs.p_payload_json as Record<string, unknown>;
    assertEquals(
      canonical.result.calculation_contract.process_filter.selection_mode,
      'request_roots_closure',
    );
    assertEquals(canonical.result.calculation_contract.process_filter.request_roots, [
      rootA,
      rootB,
    ]);
    assertEquals(canonicalPayload.request_roots, [rootA, rootB]);
    assertEquals(
      canonical.state.rpcCalls.find((call) => call.fn === 'cmd_lca_snapshot_create_v1')!.args
        .p_process_filter,
      canonical.result.calculation_contract.process_filter,
    );

    for (const field of ['p_request_hash', 'p_idempotency_key', 'p_concurrency_key']) {
      const enqueueArgs = (state: MockState) =>
        state.rpcCalls.find((call) => call.fn === 'worker_enqueue_job_v1')!.args;
      assertEquals(canonicalArgs[field], enqueueArgs(reordered.state)[field]);
      assert(canonicalArgs[field] !== enqueueArgs(onlyA.state)[field]);
      assert(enqueueArgs(onlyA.state)[field] !== enqueueArgs(onlyB.state)[field]);
      assert(enqueueArgs(onlyA.state)[field] !== enqueueArgs(full.state)[field]);
    }
  },
);
