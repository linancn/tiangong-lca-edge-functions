import { assertEquals } from 'jsr:@std/assert';

import {
  matchesProcessDataScope,
  processScopeLookupKey,
} from '../supabase/functions/_shared/lca_process_scope.ts';

Deno.test('processScopeLookupKey normalizes missing versions', () => {
  assertEquals(processScopeLookupKey('process-1', '01.00.000'), 'process-1:01.00.000');
  assertEquals(processScopeLookupKey('process-1'), 'process-1:');
  assertEquals(processScopeLookupKey('process-1', '  '), 'process-1:');
});

Deno.test('matchesProcessDataScope enforces root-process semantics per scope', () => {
  const publishedOwnedByOtherUser = {
    state_code: 100,
    user_id: 'user-2',
  };
  const publishedRangeOwnedByOtherUser = {
    state_code: 150,
    user_id: 'user-2',
  };
  const privateOwnedByCurrentUser = {
    state_code: 0,
    user_id: 'user-1',
  };
  const privateOwnedByOtherUser = {
    state_code: 0,
    user_id: 'user-2',
  };

  assertEquals(matchesProcessDataScope(publishedOwnedByOtherUser, 'open_data', 'user-1'), true);
  assertEquals(
    matchesProcessDataScope(publishedRangeOwnedByOtherUser, 'open_data', 'user-1'),
    true,
  );
  assertEquals(matchesProcessDataScope(privateOwnedByCurrentUser, 'open_data', 'user-1'), false);

  assertEquals(matchesProcessDataScope(privateOwnedByCurrentUser, 'current_user', 'user-1'), true);
  assertEquals(matchesProcessDataScope(publishedOwnedByOtherUser, 'current_user', 'user-1'), false);
  assertEquals(
    matchesProcessDataScope(publishedRangeOwnedByOtherUser, 'current_user', 'user-1'),
    false,
  );

  assertEquals(matchesProcessDataScope(privateOwnedByCurrentUser, 'all_data', 'user-1'), true);
  assertEquals(matchesProcessDataScope(publishedOwnedByOtherUser, 'all_data', 'user-1'), true);
  assertEquals(matchesProcessDataScope(publishedRangeOwnedByOtherUser, 'all_data', 'user-1'), true);
  assertEquals(matchesProcessDataScope(privateOwnedByOtherUser, 'all_data', 'user-1'), false);
  assertEquals(matchesProcessDataScope(undefined, 'all_data', 'user-1'), false);
});
