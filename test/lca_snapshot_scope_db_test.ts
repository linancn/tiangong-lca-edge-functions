import { assertEquals } from 'jsr:@std/assert';

import { buildSnapshotProcessFilter } from '../supabase/functions/_shared/lca_snapshot_scope.ts';
import { verifySnapshotMatchesDataScope } from '../supabase/functions/_shared/lca_snapshot_scope_db.ts';

type MockState = {
  row: { process_filter: unknown } | null;
  error: { code: string; message: string } | null;
  snapshotIds: unknown[];
};

function createSupabaseMock(state: MockState) {
  return {
    rpc(fn: string, args: Record<string, unknown>) {
      assertEquals(fn, 'svc_lca_snapshot_candidates');
      state.snapshotIds.push(args.p_snapshot_id);
      if (state.error) {
        return Promise.resolve({ data: null, error: state.error });
      }
      return Promise.resolve({
        data: {
          ok: true,
          data: state.row
            ? [
                {
                  snapshotId: args.p_snapshot_id,
                  scope: 'full_library',
                  processFilter: state.row.process_filter,
                  createdAt: '2026-08-07T00:00:00Z',
                  isActive: true,
                  artifact: { artifactUrl: 's3://snapshot' },
                },
              ]
            : [],
        },
        error: null,
      });
    },
  };
}

Deno.test(
  'verifySnapshotMatchesDataScope accepts only the exact actor-bound manifest',
  async () => {
    const expected = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1');
    const state: MockState = {
      row: { process_filter: expected },
      error: null,
      snapshotIds: [],
    };
    const result = await verifySnapshotMatchesDataScope(createSupabaseMock(state) as never, {
      snapshotId: 'snapshot-1',
      dataScope: 'public_plus_owner_draft',
      userId: 'user-1',
    });

    assertEquals(result, { ok: true, matches: true, process_filter: expected });
    assertEquals(state.snapshotIds, ['snapshot-1']);
  },
);

Deno.test(
  'explicit snapshot verification accepts full and root identities inside the same data scope',
  async () => {
    const rootScoped = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1', [
      {
        process_id: '11111111-1111-4111-8111-111111111111',
        process_version: '00.00.001',
      },
    ]);
    const state: MockState = {
      row: { process_filter: rootScoped },
      error: null,
      snapshotIds: [],
    };
    const result = await verifySnapshotMatchesDataScope(createSupabaseMock(state) as never, {
      snapshotId: 'snapshot-root',
      dataScope: 'public_plus_owner_draft',
      userId: 'user-1',
    });

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.matches, true);
      if (result.matches) {
        assertEquals(result.process_filter.selection_mode, 'filtered_library');
        assertEquals(result.process_filter.request_roots, []);
      }
    }
  },
);

Deno.test(
  'verifySnapshotMatchesDataScope rejects old broad and foreign-actor snapshots',
  async () => {
    const broad = await buildSnapshotProcessFilter('current_user', 'user-1');
    const foreignActor = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-2');
    const supersededCombinedScope = {
      ...(await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1')),
      scope_manifest_sha256: '348b347f1bc962707aa69010b1e8e2e9f1cdfbc9eff2ca075d4bb625a4309f7d',
    };

    for (const processFilter of [broad, foreignActor, supersededCombinedScope, null]) {
      const state: MockState = {
        row: processFilter ? { process_filter: processFilter } : null,
        error: null,
        snapshotIds: [],
      };
      const result = await verifySnapshotMatchesDataScope(createSupabaseMock(state) as never, {
        snapshotId: 'snapshot-1',
        dataScope: 'public_plus_owner_draft',
        userId: 'user-1',
      });
      assertEquals(result, { ok: true, matches: false });
    }
  },
);

Deno.test('verifySnapshotMatchesDataScope reports lookup failures closed', async () => {
  const state: MockState = {
    row: null,
    error: { code: 'XX000', message: 'boom' },
    snapshotIds: [],
  };
  const result = await verifySnapshotMatchesDataScope(createSupabaseMock(state) as never, {
    snapshotId: 'snapshot-1',
    dataScope: 'public_plus_owner_draft',
    userId: 'user-1',
  });
  assertEquals(result, { ok: false, error: 'snapshot_scope_lookup_failed', status: 500 });
});
