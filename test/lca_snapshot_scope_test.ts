import { assertEquals } from 'jsr:@std/assert';

import {
  buildSnapshotBuildPayloadFields,
  buildSnapshotContainsFilter,
  buildSnapshotProcessFilter,
  matchesSnapshotProcessFilter,
  parseLcaDataScope,
  shouldAutoBuildSnapshot,
} from '../supabase/functions/_shared/lca_snapshot_scope.ts';

Deno.test('parseLcaDataScope defaults unknown values to current_user', () => {
  assertEquals(parseLcaDataScope(undefined), 'current_user');
  assertEquals(parseLcaDataScope(''), 'current_user');
  assertEquals(parseLcaDataScope('open_data'), 'open_data');
  assertEquals(parseLcaDataScope('all_data'), 'all_data');
  assertEquals(parseLcaDataScope('unexpected_scope'), 'current_user');
});

Deno.test('buildSnapshotProcessFilter maps each scope to the expected process filter', () => {
  assertEquals(buildSnapshotProcessFilter('current_user', 'user-1'), {
    all_states: false,
    process_states: [100],
    include_user_id: 'user-1',
  });
  assertEquals(buildSnapshotProcessFilter('open_data', 'user-1'), {
    all_states: false,
    process_states: [100],
    include_user_id: 'user-1',
  });
  assertEquals(buildSnapshotProcessFilter('all_data', 'user-1'), {
    all_states: false,
    process_states: [100],
    include_user_id: 'user-1',
  });
});

Deno.test(
  'matchesSnapshotProcessFilter keeps all scopes aligned to the same user-enhanced snapshot family',
  () => {
    const currentUserFilter = buildSnapshotProcessFilter('current_user', 'user-1');
    const openDataFilter = buildSnapshotProcessFilter('open_data', 'user-1');
    const allDataFilter = buildSnapshotProcessFilter('all_data', 'user-1');

    assertEquals(matchesSnapshotProcessFilter(currentUserFilter, currentUserFilter), true);
    assertEquals(matchesSnapshotProcessFilter(openDataFilter, openDataFilter), true);
    assertEquals(matchesSnapshotProcessFilter(allDataFilter, allDataFilter), true);
    assertEquals(matchesSnapshotProcessFilter(currentUserFilter, openDataFilter), true);
    assertEquals(matchesSnapshotProcessFilter(openDataFilter, currentUserFilter), true);
    assertEquals(matchesSnapshotProcessFilter(currentUserFilter, allDataFilter), true);
    assertEquals(matchesSnapshotProcessFilter(allDataFilter, currentUserFilter), true);
    assertEquals(matchesSnapshotProcessFilter(openDataFilter, allDataFilter), true);
    assertEquals(matchesSnapshotProcessFilter(allDataFilter, openDataFilter), true);
  },
);

Deno.test('query/build payload helper outputs stay aligned with snapshot semantics', () => {
  const currentUserFilter = buildSnapshotProcessFilter('current_user', 'user-1');
  const openDataFilter = buildSnapshotProcessFilter('open_data', 'user-1');
  const allDataFilter = buildSnapshotProcessFilter('all_data', 'user-1');

  assertEquals(buildSnapshotContainsFilter(currentUserFilter), {
    all_states: false,
    process_states: [100],
    include_user_id: 'user-1',
  });
  assertEquals(buildSnapshotContainsFilter(openDataFilter), {
    all_states: false,
    process_states: [100],
    include_user_id: 'user-1',
  });
  assertEquals(buildSnapshotContainsFilter(allDataFilter), {
    all_states: false,
    process_states: [100],
    include_user_id: 'user-1',
  });

  assertEquals(buildSnapshotBuildPayloadFields(currentUserFilter), {
    all_states: false,
    process_states: '100',
    include_user_id: 'user-1',
  });
  assertEquals(buildSnapshotBuildPayloadFields(openDataFilter), {
    all_states: false,
    process_states: '100',
    include_user_id: 'user-1',
  });
  assertEquals(buildSnapshotBuildPayloadFields(allDataFilter), {
    all_states: false,
    process_states: '100',
    include_user_id: 'user-1',
  });
});

Deno.test('shouldAutoBuildSnapshot aligns all scopes', () => {
  assertEquals(shouldAutoBuildSnapshot('current_user'), true);
  assertEquals(shouldAutoBuildSnapshot('all_data'), true);
  assertEquals(shouldAutoBuildSnapshot('open_data'), true);
});
