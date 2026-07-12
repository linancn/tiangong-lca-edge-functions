import { assert, assertEquals, assertMatch } from 'jsr:@std/assert';

import { ensureLcaSnapshotBuildQueued } from '../supabase/functions/_shared/lca_snapshot_build_queue.ts';
import {
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH,
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256,
} from '../supabase/functions/_shared/lca_snapshot_scope.ts';

type MockState = {
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
  insertCalls: Array<{ table: string; row: Record<string, unknown> }>;
};

function createSupabaseMock(state: MockState) {
  return {
    from(table: string) {
      return {
        select(_columns: string) {
          return this;
        },
        eq(_column: string, _value: unknown) {
          return this;
        },
        in(_column: string, _value: unknown) {
          return this;
        },
        order(_column: string, _options: unknown) {
          return this;
        },
        limit(_limit: number) {
          return Promise.resolve({ data: [], error: null });
        },
        insert(row: Record<string, unknown>) {
          state.insertCalls.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    rpc(fn: string, args: Record<string, unknown>) {
      state.rpcCalls.push({ fn, args });
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
    const state: MockState = { rpcCalls: [], insertCalls: [] };
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
    assertMatch(result.calculation_contract.scope_manifest_sha256 ?? '', /^[0-9a-f]{64}$/);
    assertEquals(
      result.calculation_contract.lcia_factor_coverage_contract?.missing_factor_semantics,
      'incomplete_coverage_not_zero',
    );

    assertEquals(state.insertCalls.length, 1);
    assertEquals(state.insertCalls[0].table, 'lca_network_snapshots');
    assertEquals(state.insertCalls[0].row.scope, 'full_library');
    assertEquals(state.insertCalls[0].row.created_by, 'user-1');
    assertEquals(
      state.insertCalls[0].row.process_filter,
      result.calculation_contract.process_filter,
    );

    assertEquals(state.rpcCalls.length, 1);
    const rpcArgs = state.rpcCalls[0].args;
    assertEquals(state.rpcCalls[0].fn, 'worker_enqueue_job');
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

Deno.test('snapshot queue ignores client source locator and no-LCIA override fields', async () => {
  const state: MockState = { rpcCalls: [], insertCalls: [] };
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
  const payload = state.rpcCalls[0].args.p_payload_json as Record<string, unknown>;
  const source = payload.lcia_method_factor_source as Record<string, unknown>;
  assertEquals(payload.no_lcia, false);
  assertEquals(source.bundle_manifest_path, LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH);
  assertEquals(source.bundle_manifest_sha256, LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256);
  assertEquals(source.base_url_binding, 'worker_trusted_configuration');
  assertEquals('base_url' in source, false);
});
