import { assertEquals } from 'jsr:@std/assert';

import {
  DEFAULT_LCA_SNAPSHOT_SCOPE,
  parseLcaSnapshotScope,
} from '../supabase/functions/_shared/lca_snapshot_capabilities.ts';

Deno.test('LCA snapshot scope defaults to the canonical full-library scope', () => {
  assertEquals(DEFAULT_LCA_SNAPSHOT_SCOPE, 'full_library');
  assertEquals(parseLcaSnapshotScope(undefined), 'full_library');
  assertEquals(parseLcaSnapshotScope(null), 'full_library');
  assertEquals(parseLcaSnapshotScope(''), 'full_library');
  assertEquals(parseLcaSnapshotScope('  '), 'full_library');
});

Deno.test('LCA snapshot scope accepts only database-supported values', () => {
  assertEquals(parseLcaSnapshotScope('full_library'), 'full_library');
  assertEquals(parseLcaSnapshotScope(' data_product '), 'data_product');
  assertEquals(parseLcaSnapshotScope('dev-v1'), null);
  assertEquals(parseLcaSnapshotScope('prod'), null);
  assertEquals(parseLcaSnapshotScope(1), null);
});
