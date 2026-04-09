import { assertEquals, assertRejects } from 'jsr:@std/assert';

const MODULE_PATH = '../supabase/functions/_shared/auth.ts';
const TEST_PUBLISHABLE_KEY = 'sb_publishable_test_key';
const TEST_SERVICE_API_KEY = 'service-secret';
const TEST_USER_EMAIL = 'user@example.com';
const TEST_USER_PASSWORD = 'secret-password';

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

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createExpectedUserApiCacheKey(email: string, password: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${email}\0${password}`),
  );
  return `lca_${email}_${bytesToHex(new Uint8Array(digest))}`;
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
  'jwt auth surfaces upstream auth-client errors instead of masking them as missing users',
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
              getUser: async () => ({
                data: { user: null },
                error: {
                  message: 'Invalid JWT secret / wrong project',
                  status: 401,
                },
              }),
            },
          } as any,
          allowedMethods: [module.AuthMethod.JWT],
        });

        assertEquals(result.isAuthenticated, false);
        assertEquals(result.response?.status, 401);
        assertEquals(await result.response?.text(), 'Invalid JWT secret / wrong project');
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
  'createAuthenticatedSupabaseClient fails fast when Supabase URL env is missing',
  async () => {
    await withEnv(
      {
        REMOTE_SUPABASE_URL: undefined,
        SUPABASE_URL: undefined,
      },
      async () => {
        const module = await importAuthModule();

        await assertRejects(
          () => module.createAuthenticatedSupabaseClient('service-secret'),
          Error,
          'Missing Supabase URL',
        );
      },
    );
  },
);

Deno.test('user API key cache key includes the password-derived hash', async () => {
  const expectedCacheKey = await createExpectedUserApiCacheKey(TEST_USER_EMAIL, TEST_USER_PASSWORD);
  let seenCacheKey: string | undefined;

  const module = await importAuthModule();
  const bearerToken = btoa(
    JSON.stringify({
      email: TEST_USER_EMAIL,
      password: TEST_USER_PASSWORD,
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
        get: async (key: string) => {
          seenCacheKey = key;
          return 'cached-user-id';
        },
        set: async () => undefined,
      } as any,
      allowedMethods: [module.AuthMethod.USER_API_KEY],
    },
  );

  assertEquals(result.isAuthenticated, true);
  assertEquals(seenCacheKey, expectedCacheKey);
  assertEquals(seenCacheKey === `lca_${TEST_USER_EMAIL}`, false);
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
        const expectedCacheKey = await createExpectedUserApiCacheKey(
          TEST_USER_EMAIL,
          TEST_USER_PASSWORD,
        );
        let cacheGetKey: string | undefined;
        let cacheSetKey: string | undefined;

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
                email: TEST_USER_EMAIL,
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
              email: TEST_USER_EMAIL,
              password: TEST_USER_PASSWORD,
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
                get: async (key: string) => {
                  cacheGetKey = key;
                  return null;
                },
                set: async (key: string) => {
                  cacheSetKey = key;
                  return undefined;
                },
              } as any,
              allowedMethods: [module.AuthMethod.USER_API_KEY],
            },
          );

          assertEquals(result.isAuthenticated, true);
          assertEquals(fetchCalls.length, 1);
          assertEquals(fetchCalls[0].url.includes('/auth/v1/token'), true);
          assertEquals(fetchCalls[0].headers.get('apikey'), TEST_PUBLISHABLE_KEY);
          assertEquals(fetchCalls[0].headers.get('apikey') === TEST_SERVICE_API_KEY, false);
          assertEquals(cacheGetKey, expectedCacheKey);
          assertEquals(cacheSetKey, expectedCacheKey);
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
    );
  },
);
