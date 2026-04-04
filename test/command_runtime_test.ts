import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import { createCommandHandler } from '../supabase/functions/_shared/command_runtime/command.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';

const fakeActor = {
  userId: TEST_USER_ID,
  accessToken: 'access-token',
  supabase: {
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient,
};

Deno.test('createCommandHandler rejects invalid JSON bodies', async () => {
  const handler = createCommandHandler({
    parse: (body) => ({ ok: true as const, value: body }),
    execute: async () => ({ ok: true as const, body: { ok: true } }),
    resolveActor: async () => ({ ok: true as const, value: fakeActor }),
  });

  const response = await handler(
    new Request('http://localhost/functions/v1/app_dataset_save_draft', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: 'not-json',
    }),
  );

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    ok: false,
    code: 'INVALID_PAYLOAD',
    message: 'Request body must be valid JSON',
  });
});

Deno.test('createCommandHandler wires actor context into command execution', async () => {
  const handler = createCommandHandler({
    parse: (body) => ({ ok: true as const, value: body as { table: string } }),
    execute: async (input, actor) => ({
      ok: true as const,
      body: {
        actorUserId: actor.userId,
        table: input.table,
      },
    }),
    resolveActor: async () => ({ ok: true as const, value: fakeActor }),
  });

  const response = await handler(
    new Request('http://localhost/functions/v1/app_dataset_publish', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ table: 'flows' }),
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    actorUserId: TEST_USER_ID,
    table: 'flows',
  });
});

Deno.test('createCommandHandler propagates actor resolution failures', async () => {
  const handler = createCommandHandler({
    parse: (body) => ({ ok: true as const, value: body }),
    execute: async () => ({ ok: true as const, body: { ok: true } }),
    resolveActor: async () => ({
      ok: false as const,
      response: new Response(
        JSON.stringify({
          ok: false,
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
        }),
        {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    }),
  });

  const response = await handler(
    new Request('http://localhost/functions/v1/app_dataset_save_draft', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ table: 'flows' }),
    }),
  );

  assertEquals(response.status, 401);
  assertEquals(await response.json(), {
    ok: false,
    code: 'AUTH_REQUIRED',
    message: 'Authentication required',
  });
});
