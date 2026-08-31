import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.112.4';

import { userHasReviewAdminRole } from '../supabase/functions/_shared/lifecyclemodel_bundle.ts';

const USER_ID = '11111111-1111-4111-8111-111111111111';

Deno.test(
  'lifecycle model authorization uses the service-only review-admin predicate',
  async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const supabase = {
      rpc(fn: string, args: Record<string, unknown>) {
        calls.push({ fn, args });
        return Promise.resolve({ data: { ok: true, data: true }, error: null });
      },
    } as unknown as SupabaseClient;

    assertEquals(await userHasReviewAdminRole(supabase, USER_ID), true);
    assertEquals(calls, [
      {
        fn: 'svc_membership_is_review_admin',
        args: { p_user_id: USER_ID },
      },
    ]);
  },
);

Deno.test(
  'lifecycle model authorization fails closed on malformed predicate responses',
  async () => {
    const supabase = {
      rpc() {
        return Promise.resolve({ data: { ok: true, data: 'yes' }, error: null });
      },
    } as unknown as SupabaseClient;

    assertEquals(await userHasReviewAdminRole(supabase, USER_ID), false);
  },
);
