import { assertEquals } from 'jsr:@std/assert';

const MODULE_PATH = '../supabase/functions/_shared/supabase_client.ts';
const TEST_SUPABASE_URL = 'https://example.supabase.co';
const TEST_SERVICE_ROLE_KEY = 'service-role-key-for-tests';
const TEST_PUBLISHABLE_KEY = 'publishable-key-for-tests';

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
    return;
  }

  Deno.env.set(name, value);
}

async function withSupabaseEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();

  for (const name of Object.keys(overrides)) {
    previous.set(name, Deno.env.get(name));
  }

  for (const [name, value] of Object.entries(overrides)) {
    restoreEnvVar(name, value);
  }

  try {
    return await fn();
  } finally {
    for (const [name, value] of previous.entries()) {
      restoreEnvVar(name, value);
    }
  }
}

async function importSupabaseClientModule() {
  return await import(`${MODULE_PATH}?case=${crypto.randomUUID()}`);
}

Deno.test('shared Supabase client falls back when remote env vars are blank', async () => {
  await withSupabaseEnv(
    {
      REMOTE_SUPABASE_URL: '   ',
      REMOTE_SERVICE_API_KEY: '',
      REMOTE_SUPABASE_PUBLISHABLE_KEY: '\n',
      REMOTE_SUPABASE_ANON_KEY: ' ',
      SUPABASE_URL: TEST_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_ROLE_KEY,
      SUPABASE_ANON_KEY: TEST_PUBLISHABLE_KEY,
    },
    async () => {
      const module = await importSupabaseClientModule();

      assertEquals(module.getSupabaseUrl(), TEST_SUPABASE_URL);
      assertEquals(module.getSupabaseServiceRoleKey(), TEST_SERVICE_ROLE_KEY);
      assertEquals(module.getSupabasePublishableKey(), TEST_PUBLISHABLE_KEY);

      if (!module.supabaseServiceClient) {
        throw new Error('expected shared service-role client to be created');
      }

      if (!module.supabaseAuthClient) {
        throw new Error('expected shared auth client to be created');
      }

      if (!module.createRequestSupabaseClient()) {
        throw new Error('expected request-scoped client to be created');
      }
    },
  );
});

Deno.test(
  'shared Supabase client never uses SERVICE_API_KEY as the Supabase service-role key',
  async () => {
    await withSupabaseEnv(
      {
        REMOTE_SUPABASE_URL: TEST_SUPABASE_URL,
        REMOTE_SUPABASE_SERVICE_ROLE_KEY: undefined,
        REMOTE_SERVICE_API_KEY: 'custom-service-auth-key',
        SERVICE_API_KEY: 'custom-service-auth-key',
        SUPABASE_URL: TEST_SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_ROLE_KEY,
        SUPABASE_ANON_KEY: TEST_PUBLISHABLE_KEY,
      },
      async () => {
        const module = await importSupabaseClientModule();

        assertEquals(module.getSupabaseServiceRoleKey(), TEST_SERVICE_ROLE_KEY);
      },
    );
  },
);

Deno.test('shared Supabase client supports secret-key envs for privileged execution', async () => {
  await withSupabaseEnv(
    {
      REMOTE_SUPABASE_URL: TEST_SUPABASE_URL,
      REMOTE_SUPABASE_SERVICE_ROLE_KEY: '',
      REMOTE_SUPABASE_SECRET_KEY: 'remote-secret-key',
      SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_ROLE_KEY,
      SUPABASE_SECRET_KEY: 'local-secret-key',
      SUPABASE_ANON_KEY: TEST_PUBLISHABLE_KEY,
    },
    async () => {
      const module = await importSupabaseClientModule();

      assertEquals(module.getSupabaseServiceRoleKey(), 'remote-secret-key');
    },
  );
});
