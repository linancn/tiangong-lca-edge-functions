import { assertEquals } from 'jsr:@std/assert';

import { LEGACY_ENDPOINT_REMOVED_RESPONSE } from '../supabase/functions/_shared/legacy_endpoint_removed.ts';
import { handleUpdateComment } from '../supabase/functions/update_comment/index.ts';
import { handleUpdateData } from '../supabase/functions/update_data/index.ts';
import { handleUpdateReview } from '../supabase/functions/update_review/index.ts';
import { handleUpdateRole } from '../supabase/functions/update_role/index.ts';
import { handleUpdateTeam } from '../supabase/functions/update_team/index.ts';
import { handleUpdateUser } from '../supabase/functions/update_user/index.ts';

const legacyHandlers = [
  ['update_data', handleUpdateData],
  ['update_user', handleUpdateUser],
  ['update_team', handleUpdateTeam],
  ['update_role', handleUpdateRole],
  ['update_comment', handleUpdateComment],
  ['update_review', handleUpdateReview],
] as const;

for (const [name, handler] of legacyHandlers) {
  for (const method of ['GET', 'POST', 'PUT'] as const) {
    Deno.test(`${name} returns 410 Gone for legacy ${method} callers`, async () => {
      const response = await handler(
        new Request(`http://localhost/functions/v1/${name}`, {
          method,
          headers: {
            Authorization: 'Bearer legacy-token',
            'Content-Type': 'application/json',
          },
          body: method === 'GET' ? undefined : JSON.stringify({}),
        }),
      );

      assertEquals(response.status, 410);
      assertEquals(await response.json(), LEGACY_ENDPOINT_REMOVED_RESPONSE);
    });
  }

  Deno.test(`${name} still responds to OPTIONS preflight`, async () => {
    const response = await handler(
      new Request(`http://localhost/functions/v1/${name}`, {
        method: 'OPTIONS',
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(await response.text(), 'ok');
  });
}
