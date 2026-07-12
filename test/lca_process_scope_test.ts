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
    team_id: 'team-2',
    review_id: 'review-2',
  };
  const publishedRangeOwnedByOtherUser = {
    state_code: 150,
    user_id: 'user-2',
    team_id: null,
    review_id: null,
  };
  const privateOwnedByCurrentUser = {
    state_code: 0,
    user_id: 'user-1',
    team_id: null,
    review_id: null,
  };
  const privateOwnedByOtherUser = {
    state_code: 0,
    user_id: 'user-2',
    team_id: null,
    review_id: null,
  };
  const ownerReviewState = {
    state_code: 10,
    user_id: 'user-1',
    team_id: null,
    review_id: null,
  };
  const ownerWithdrawnState = {
    state_code: -1,
    user_id: 'user-1',
    team_id: null,
    review_id: null,
  };
  const ownerDraftSharedWithTeam = {
    state_code: 0,
    user_id: 'user-1',
    team_id: 'team-1',
    review_id: null,
  };
  const ownerDraftLinkedToReview = {
    state_code: 0,
    user_id: 'user-1',
    team_id: null,
    review_id: 'review-1',
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

  assertEquals(
    matchesProcessDataScope(publishedOwnedByOtherUser, 'public_plus_owner_draft', 'user-1'),
    true,
  );
  assertEquals(
    matchesProcessDataScope(publishedRangeOwnedByOtherUser, 'public_plus_owner_draft', 'user-1'),
    false,
  );
  assertEquals(
    matchesProcessDataScope(privateOwnedByCurrentUser, 'public_plus_owner_draft', 'user-1'),
    true,
  );
  assertEquals(
    matchesProcessDataScope(privateOwnedByOtherUser, 'public_plus_owner_draft', 'user-1'),
    false,
  );
  assertEquals(
    matchesProcessDataScope(ownerReviewState, 'public_plus_owner_draft', 'user-1'),
    false,
  );
  assertEquals(
    matchesProcessDataScope(ownerWithdrawnState, 'public_plus_owner_draft', 'user-1'),
    false,
  );
  assertEquals(
    matchesProcessDataScope(ownerDraftSharedWithTeam, 'public_plus_owner_draft', 'user-1'),
    false,
  );
  assertEquals(
    matchesProcessDataScope(ownerDraftLinkedToReview, 'public_plus_owner_draft', 'user-1'),
    false,
  );
  assertEquals(matchesProcessDataScope(undefined, 'public_plus_owner_draft', 'user-1'), false);
});
