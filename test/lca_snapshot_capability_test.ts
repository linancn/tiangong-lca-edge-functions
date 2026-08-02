import { assertEquals } from 'jsr:@std/assert';

import {
  createLcaSnapshotCapabilityRepository,
  LCA_SNAPSHOT_CAPABILITY_CONTRACT,
} from '../supabase/functions/_shared/capabilities/lca_snapshot_family.ts';
import type {
  RequestJwtSupabaseClient,
  ServiceRoleSupabaseClient,
} from '../supabase/functions/_shared/supabase_client.ts';

type RpcCall = { schema: string; fn: string; args?: Record<string, unknown> };

function typeCheckClientSeparation(
  requestClient: RequestJwtSupabaseClient,
  serviceClient: ServiceRoleSupabaseClient,
) {
  // @ts-expect-error Request-JWT credentials cannot enter the service-only snapshot adapter.
  createLcaSnapshotCapabilityRepository(requestClient);
  createLcaSnapshotCapabilityRepository(serviceClient);
}
void typeCheckClientSeparation;

Deno.test(
  'LCA snapshot capability binds the exact api schema, routines, and arguments',
  async () => {
    const calls: RpcCall[] = [];
    let schemaCalls = 0;
    const client = {
      schema(schema: string) {
        schemaCalls += 1;
        return {
          rpc(fn: string, args?: Record<string, unknown>) {
            calls.push({ schema, fn, args });
            const dataByRoutine: Record<string, unknown> = {
              lca_snapshot_active_read_v1: [
                {
                  snapshot_id: 'snapshot-active',
                  source_hash: 'source-hash',
                  activated_at: '2026-08-02T00:00:00Z',
                },
              ],
              lca_snapshot_scope_read_v1: [
                {
                  id: 'snapshot-scope',
                  scope: 'prod',
                  process_filter: { owner: 'user-1' },
                  status: 'ready',
                },
              ],
              lca_snapshot_resolve_v1: [
                {
                  id: 'snapshot-ready',
                  created_at: '2026-08-02T00:00:00Z',
                  process_filter: { owner: 'user-1' },
                },
              ],
              lca_snapshot_artifact_read_v1: [
                {
                  snapshot_id: 'snapshot-scope',
                  artifact_url: 'https://example.invalid/snapshot.h5',
                  artifact_format: 'hdf5',
                  process_count: 12,
                  status: 'ready',
                  created_at: '2026-08-02T00:00:00Z',
                },
              ],
              lca_snapshot_artifact_latest_v1: [
                {
                  snapshot_id: 'snapshot-latest',
                  artifact_url: 'https://example.invalid/latest.h5',
                  artifact_format: 'hdf5',
                  process_count: 20,
                  status: 'ready',
                  created_at: '2026-08-02T01:00:00Z',
                },
              ],
              cmd_lca_snapshot_create_v1: { snapshotId: 'snapshot-new', created: true },
            };
            return Promise.resolve({ data: dataByRoutine[fn], error: null });
          },
        };
      },
      from() {
        throw new Error('snapshot adapter must not fall back to a relation');
      },
    };

    const repository = createLcaSnapshotCapabilityRepository(client as never);
    assertEquals(schemaCalls, 0);
    assertEquals(repository.access, 'service-only');
    assertEquals((await repository.readActive('prod')).data?.snapshot_id, 'snapshot-active');
    assertEquals((await repository.readScope('snapshot-scope')).data?.scope, 'prod');
    assertEquals(
      (await repository.resolveReady('custom-scope', { owner: 'user-1' })).data[0].id,
      'snapshot-ready',
    );
    assertEquals(
      (await repository.readArtifact('snapshot-scope')).data?.artifact_url,
      'https://example.invalid/snapshot.h5',
    );
    assertEquals((await repository.readLatestArtifact()).data?.snapshot_id, 'snapshot-latest');
    assertEquals(
      await repository.createDraft({
        snapshotId: 'snapshot-new',
        scope: 'full_library',
        processFilter: { owner: 'user-1' },
        createdBy: 'user-1',
      }),
      { data: { snapshotId: 'snapshot-new', created: true }, error: null },
    );

    assertEquals(calls, [
      {
        schema: 'api',
        fn: 'lca_snapshot_active_read_v1',
        args: { p_scope: 'prod' },
      },
      {
        schema: 'api',
        fn: 'lca_snapshot_scope_read_v1',
        args: { p_snapshot_id: 'snapshot-scope' },
      },
      {
        schema: 'api',
        fn: 'lca_snapshot_resolve_v1',
        args: { p_scope: 'custom-scope', p_process_filter: { owner: 'user-1' } },
      },
      {
        schema: 'api',
        fn: 'lca_snapshot_artifact_read_v1',
        args: { p_snapshot_id: 'snapshot-scope' },
      },
      { schema: 'api', fn: 'lca_snapshot_artifact_latest_v1', args: undefined },
      {
        schema: 'api',
        fn: 'cmd_lca_snapshot_create_v1',
        args: {
          p_snapshot_id: 'snapshot-new',
          p_scope: 'full_library',
          p_process_filter: { owner: 'user-1' },
          p_created_by: 'user-1',
        },
      },
    ]);
    assertEquals(LCA_SNAPSHOT_CAPABILITY_CONTRACT.databaseCommit.length, 40);
    assertEquals(LCA_SNAPSHOT_CAPABILITY_CONTRACT.migrationHead, '20260802091342');
    assertEquals(schemaCalls, 6);
  },
);

Deno.test('LCA snapshot capability propagates api errors without a public fallback', async () => {
  let rpcCount = 0;
  const failure = {
    name: 'PostgrestError',
    code: '42501',
    message: 'permission denied',
    details: '',
    hint: '',
  };
  const client = {
    schema(schema: string) {
      assertEquals(schema, 'api');
      return {
        rpc(fn: string, args?: Record<string, unknown>) {
          rpcCount += 1;
          assertEquals(fn, 'lca_snapshot_active_read_v1');
          assertEquals(args, { p_scope: 'prod' });
          return Promise.resolve({ data: null, error: failure });
        },
      };
    },
    from() {
      throw new Error('public fallback attempted');
    },
  };

  const result = await createLcaSnapshotCapabilityRepository(client as never).readActive('prod');
  assertEquals(result, { data: null, error: failure });
  assertEquals(rpcCount, 1);
});
