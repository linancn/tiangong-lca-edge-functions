import { assertEquals } from 'jsr:@std/assert';

const MODULE_PATH = '../supabase/functions/_shared/auth.ts';
const TEST_PUBLISHABLE_KEY = 'sb_publishable_test_key';
const TEST_SERVICE_API_KEY = 'service-secret';

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
    return;
  }

  Deno.env.set(name, value);
}

async function withEnv<T>(
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

async function importAuthModule() {
  return await import(`${MODULE_PATH}?case=${crypto.randomUUID()}`);
}

Deno.test(
  'publishable apikey is ignored by service-key auth when no other auth is provided',
  async () => {
    await withEnv(
      {
        SERVICE_API_KEY: TEST_SERVICE_API_KEY,
        SUPABASE_ANON_KEY: TEST_PUBLISHABLE_KEY,
      },
      async () => {
        const module = await importAuthModule();
        const req = new Request('https://example.com', {
          method: 'POST',
          headers: {
            apikey: TEST_PUBLISHABLE_KEY,
          },
        });

        const result = await module.authenticateRequest(req, {
          allowedMethods: [module.AuthMethod.SERVICE_API_KEY],
        });

        assertEquals(result.isAuthenticated, false);
        assertEquals(result.response?.status, 401);
        assertEquals(await result.response?.text(), 'Unauthorized Request');
      },
    );
  },
);

Deno.test(
  'publishable apikey does not mask JWT failures when a bearer token is present',
  async () => {
    await withEnv(
      {
        SERVICE_API_KEY: TEST_SERVICE_API_KEY,
        SUPABASE_ANON_KEY: TEST_PUBLISHABLE_KEY,
      },
      async () => {
        const module = await importAuthModule();
        const req = new Request('https://example.com', {
          method: 'POST',
          headers: {
            apikey: 'sb_publishable_test_key',
            Authorization: 'Bearer not-a-real-jwt',
          },
        });

        const result = await module.authenticateRequest(req, {
          authClient: {
            auth: {
              getUser: async () => ({ data: { user: null } }),
            },
          } as any,
          allowedMethods: [module.AuthMethod.JWT, module.AuthMethod.SERVICE_API_KEY],
        });

        assertEquals(result.isAuthenticated, false);
        assertEquals(result.response?.status, 401);
        assertEquals(await result.response?.text(), 'User Not Found');
      },
    );
  },
);

Deno.test(
  'jwt-like bearer tokens use JWT auth instead of user API key auth when both are allowed',
  async () => {
    await withEnv(
      {
        SERVICE_API_KEY: TEST_SERVICE_API_KEY,
        SUPABASE_ANON_KEY: TEST_PUBLISHABLE_KEY,
      },
      async () => {
        const module = await importAuthModule();
        const req = new Request('https://example.com', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer header.payload.signature',
          },
        });

        const result = await module.authenticateRequest(req, {
          authClient: {
            auth: {
              getUser: async () => ({ data: { user: null } }),
            },
          } as any,
          redis: {} as any,
          allowedMethods: [module.AuthMethod.JWT, module.AuthMethod.USER_API_KEY],
        });

        assertEquals(result.isAuthenticated, false);
        assertEquals(result.response?.status, 401);
        assertEquals(await result.response?.text(), 'User Not Found');
      },
    );
  },
);

Deno.test('jwt auth returns a server error when authClient wiring is missing', async () => {
  await withEnv(
    {
      SERVICE_API_KEY: TEST_SERVICE_API_KEY,
      SUPABASE_ANON_KEY: TEST_PUBLISHABLE_KEY,
    },
    async () => {
      const module = await importAuthModule();
      const req = new Request('https://example.com', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer header.payload.signature',
        },
      });

      const result = await module.authenticateRequest(req, {
        allowedMethods: [module.AuthMethod.JWT],
      });

      assertEquals(result.isAuthenticated, false);
      assertEquals(result.response?.status, 500);
      assertEquals(await result.response?.text(), 'Auth client not configured');
    },
  );
});

Deno.test(
  'user API key auth signs in with the publishable Supabase key instead of SERVICE_API_KEY',
  async () => {
    await withEnv(
      {
        REMOTE_SUPABASE_URL: 'https://example.supabase.co',
        SERVICE_API_KEY: TEST_SERVICE_API_KEY,
        SUPABASE_ANON_KEY: TEST_PUBLISHABLE_KEY,
      },
      async () => {
        const module = await importAuthModule();
        const originalFetch = globalThis.fetch;
        const fetchCalls: Request[] = [];

        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          fetchCalls.push(request);
          return new Response(
            JSON.stringify({
              access_token: 'access-token',
              refresh_token: 'refresh-token',
              token_type: 'bearer',
              expires_in: 3600,
              user: {
                id: '11111111-1111-4111-8111-111111111111',
                email: 'user@example.com',
                role: 'authenticated',
                aud: 'authenticated',
                app_metadata: { provider: 'email' },
                user_metadata: {},
                created_at: '2026-04-06T00:00:00.000Z',
              },
            }),
            {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
              },
            },
          );
        };

        try {
          const bearerToken = btoa(
            JSON.stringify({
              email: 'user@example.com',
              password: 'secret-password',
            }),
          );

          const result = await module.authenticateRequest(
            new Request('https://example.com', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${bearerToken}`,
              },
            }),
            {
              redis: {
                get: async () => null,
                set: async () => undefined,
              } as any,
              allowedMethods: [module.AuthMethod.USER_API_KEY],
            },
          );

          assertEquals(result.isAuthenticated, true);
          assertEquals(fetchCalls.length, 1);
          assertEquals(fetchCalls[0].url.includes('/auth/v1/token'), true);
          assertEquals(fetchCalls[0].headers.get('apikey'), TEST_PUBLISHABLE_KEY);
          assertEquals(fetchCalls[0].headers.get('apikey') === TEST_SERVICE_API_KEY, false);
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    );
  },
);
