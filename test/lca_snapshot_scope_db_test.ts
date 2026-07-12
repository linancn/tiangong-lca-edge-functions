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
    from(table: string) {
      assertEquals(table, 'lca_network_snapshots');
      return {
        select(columns: string) {
          assertEquals(columns, 'process_filter');
          return this;
        },
        eq(column: string, value: unknown) {
          assertEquals(column, 'id');
          state.snapshotIds.push(value);
          return this;
        },
        maybeSingle() {
          return Promise.resolve({ data: state.row, error: state.error });
        },
      };
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
  'verifySnapshotMatchesDataScope rejects old broad and foreign-actor snapshots',
  async () => {
    const broad = await buildSnapshotProcessFilter('current_user', 'user-1');
    const foreignActor = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-2');

    for (const processFilter of [broad, foreignActor, null]) {
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
