import { assertEquals } from 'jsr:@std/assert';

import {
  canNonReviewAdminUpdateUnderReviewData,
  isStateCodeOnlyUpdate,
} from '../supabase/functions/_shared/update_data_review_guard.ts';

Deno.test('isStateCodeOnlyUpdate only accepts pure state_code payloads', () => {
  assertEquals(isStateCodeOnlyUpdate({ state_code: 0 }), true);
  assertEquals(isStateCodeOnlyUpdate({ state_code: 100 }), true);
  assertEquals(isStateCodeOnlyUpdate({ state_code: 0, json: {} }), false);
  assertEquals(isStateCodeOnlyUpdate({ state_code: 100, reviews: [] }), false);
  assertEquals(isStateCodeOnlyUpdate({ reviews: [] }), false);
  assertEquals(isStateCodeOnlyUpdate(undefined), false);
});

Deno.test('canNonReviewAdminUpdateUnderReviewData only allows state transitions from 20', () => {
  assertEquals(canNonReviewAdminUpdateUnderReviewData(20, { state_code: 0 }), true);
  assertEquals(canNonReviewAdminUpdateUnderReviewData(20, { state_code: 100 }), true);
  assertEquals(
    canNonReviewAdminUpdateUnderReviewData(20, { state_code: 0, json: { foo: 'bar' } }),
    false,
  );
  assertEquals(canNonReviewAdminUpdateUnderReviewData(30, { state_code: 0 }), false);
  assertEquals(canNonReviewAdminUpdateUnderReviewData(20, { reviews: [] }), false);
});
