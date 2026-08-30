import { assertEquals, assertRejects } from 'jsr:@std/assert';

const MODULE_PATH = '../supabase/functions/_shared/auth.ts';
const TEST_PUBLISHABLE_KEY = 'sb_publishable_test_key';
const TEST_SERVICE_API_KEY = 'service-secret';
const TEST_USER_EMAIL = 'user@example.com';
const TEST_USER_PASSWORD = 'secret-password';
const TEST_SUPABASE_URL = 'https://example.supabase.co';
const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const TEST_CLIENT_ID = '33333333-3333-4333-8333-333333333333';

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `${TEST_SUPABASE_URL}/auth/v1`,
    aud: 'authenticated',
    exp: now + 3600,
    iat: now - 10,
    sub: TEST_USER_ID,
    role: 'authenticated',
    session_id: TEST_SESSION_ID,
    email: TEST_USER_EMAIL,
    ...overrides,
  };
}

function base64UrlJson(value: Record<string, unknown>): string {
  return btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

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
  return `auth:legacy-user-api-key:v2:${bytesToHex(new Uint8Array(digest))}`;
}

Deno.test(
  'publishable apikey is ignored by service-key auth when no other auth is provided',
  async () => {
    await withEnv(
      {
        SERVICE_API_KEY: TEST_SERVICE_API_KEY,
        SUPABASE_ANON_KEY: TEST_PUBLISHABLE_KEY,
        REMOTE_SUPABASE_URL: undefined,
        SUPABASE_URL: TEST_SUPABASE_URL,
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
              getClaims: async () => ({
                data: null,
                error: { message: 'JWT rejected', status: 401 },
              }),
            },
          } as any,
          allowedMethods: [module.AuthMethod.JWT, module.AuthMethod.SERVICE_API_KEY],
        });

        assertEquals(result.isAuthenticated, false);
        assertEquals(result.response?.status, 401);
        assertEquals(await result.response?.text(), 'JWT rejected');
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
        REMOTE_SUPABASE_URL: undefined,
        SUPABASE_URL: TEST_SUPABASE_URL,
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
              getClaims: async () => ({
                data: null,
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
        REMOTE_SUPABASE_URL: undefined,
        SUPABASE_URL: TEST_SUPABASE_URL,
      },
      async () => {
        const module = await importAuthModule();
        const req = new Request('https://example.com', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer header.payload.signature',
          },
        });
        let redisFactoryCalls = 0;

        const result = await module.authenticateRequest(req, {
          authClient: {
            auth: {
              getClaims: async () => ({
                data: null,
                error: { message: 'JWT rejected', status: 401 },
              }),
            },
          } as any,
          redisFactory: async () => {
            redisFactoryCalls += 1;
            return {} as any;
          },
          allowedMethods: [module.AuthMethod.JWT, module.AuthMethod.USER_API_KEY],
        });

        assertEquals(result.isAuthenticated, false);
        assertEquals(result.response?.status, 401);
        assertEquals(await result.response?.text(), 'JWT rejected');
        assertEquals(redisFactoryCalls, 0);
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
  'claims assurance verifies OAuth identity locally and exposes a minimal principal',
  async () => {
    await withEnv({ REMOTE_SUPABASE_URL: undefined, SUPABASE_URL: TEST_SUPABASE_URL }, async () => {
      const module = await importAuthModule();
      let getUserCalls = 0;
      let redisFactoryCalls = 0;
      const result = await module.authenticateRequest(
        new Request('https://example.com', {
          headers: { Authorization: 'Bearer header.payload.signature' },
        }),
        {
          authClient: {
            auth: {
              getClaims: async () => ({
                data: { claims: validClaims({ client_id: TEST_CLIENT_ID }) },
                error: null,
              }),
              getUser: async () => {
                getUserCalls += 1;
                return { data: { user: null }, error: null };
              },
            },
          } as any,
          redisFactory: async () => {
            redisFactoryCalls += 1;
            return {} as any;
          },
          allowedMethods: [module.AuthMethod.JWT, module.AuthMethod.USER_API_KEY],
        },
      );

      assertEquals(result.isAuthenticated, true);
      assertEquals(result.principal?.userId, TEST_USER_ID);
      assertEquals(result.principal?.email, TEST_USER_EMAIL);
      assertEquals(result.principal?.authMethod, 'supabase_jwt');
      assertEquals(result.principal?.assurance, 'claims');
      assertEquals(result.principal?.clientId, TEST_CLIENT_ID);
      assertEquals(result.principal?.sessionId, TEST_SESSION_ID);
      assertEquals(result.user?.user_metadata, { provider: '' });
      assertEquals(getUserCalls, 0);
      assertEquals(redisFactoryCalls, 0);
    });
  },
);

Deno.test(
  'fresh_user assurance performs the explicit online user lookup after claims verification',
  async () => {
    await withEnv({ REMOTE_SUPABASE_URL: undefined, SUPABASE_URL: TEST_SUPABASE_URL }, async () => {
      const module = await importAuthModule();
      let getClaimsCalls = 0;
      let getUserCalls = 0;
      const result = await module.authenticateRequest(
        new Request('https://example.com', {
          headers: { Authorization: 'Bearer header.payload.signature' },
        }),
        {
          authClient: {
            auth: {
              getClaims: async () => {
                getClaimsCalls += 1;
                return { data: { claims: validClaims() }, error: null };
              },
              getUser: async () => {
                getUserCalls += 1;
                return {
                  data: {
                    user: {
                      id: TEST_USER_ID,
                      email: 'fresh@example.com',
                      role: 'authenticated',
                      app_metadata: { provider: 'email' },
                      user_metadata: { display_name: 'Fresh User' },
                      aud: 'authenticated',
                      created_at: '2026-01-01T00:00:00.000Z',
                    },
                  },
                  error: null,
                };
              },
            },
          } as any,
          allowedMethods: [module.AuthMethod.JWT],
          jwtAssurance: 'fresh_user',
        },
      );

      assertEquals(result.isAuthenticated, true);
      assertEquals(result.principal?.assurance, 'fresh_user');
      assertEquals(result.principal?.email, 'fresh@example.com');
      assertEquals(result.user?.user_metadata, { display_name: 'Fresh User' });
      assertEquals(getClaimsCalls, 1);
      assertEquals(getUserCalls, 1);
    });
  },
);

Deno.test('fresh_user assurance rejects Cognito JWT compatibility tokens', async () => {
  const module = await importAuthModule();
  const token = `${base64UrlJson({ alg: 'RS256' })}.${base64UrlJson({
    iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example',
  })}.signature`;
  const result = await module.authenticateRequest(
    new Request('https://example.com', {
      headers: { Authorization: `Bearer ${token}` },
    }),
    {
      authClient: {} as any,
      allowedMethods: [module.AuthMethod.JWT],
      jwtAssurance: 'fresh_user',
    },
  );
  assertEquals(result.isAuthenticated, false);
  assertEquals(result.response?.status, 401);
  assertEquals(await result.response?.text(), 'Fresh user assurance requires a Supabase session');
});

Deno.test(
  'claims assurance rejects malformed authority claims before exposing a principal',
  async () => {
    await withEnv({ REMOTE_SUPABASE_URL: undefined, SUPABASE_URL: TEST_SUPABASE_URL }, async () => {
      const module = await importAuthModule();
      const now = Math.floor(Date.now() / 1000);
      const cases: Array<{ overrides: Record<string, unknown>; status: number; message: string }> =
        [
          {
            overrides: { iss: 'https://evil.example/auth/v1' },
            status: 401,
            message: 'Invalid JWT issuer',
          },
          { overrides: { aud: 'anon' }, status: 401, message: 'Invalid JWT audience' },
          { overrides: { exp: now - 1 }, status: 401, message: 'JWT expired' },
          {
            overrides: { iat: now + 120 },
            status: 401,
            message: 'Invalid JWT issued-at time',
          },
          { overrides: { sub: 'not-a-uuid' }, status: 401, message: 'Invalid JWT subject' },
          { overrides: { role: 'anon' }, status: 403, message: 'Forbidden' },
          { overrides: { session_id: '' }, status: 401, message: 'Invalid JWT session' },
          { overrides: { client_id: 7 }, status: 401, message: 'Invalid OAuth client identity' },
          { overrides: { email: 7 }, status: 401, message: 'Invalid JWT email' },
        ];

      for (const testCase of cases) {
        const result = await module.authenticateRequest(
          new Request('https://example.com', {
            headers: { Authorization: 'Bearer header.payload.signature' },
          }),
          {
            authClient: {
              auth: {
                getClaims: async () => ({
                  data: { claims: validClaims(testCase.overrides) },
                  error: null,
                }),
              },
            } as any,
            allowedMethods: [module.AuthMethod.JWT],
          },
        );
        assertEquals(result.isAuthenticated, false);
        assertEquals(result.principal, undefined);
        assertEquals(result.response?.status, testCase.status);
        assertEquals(await result.response?.text(), testCase.message);
      }
    });
  },
);

Deno.test(
  'claims assurance accepts the bounded local Kong-to-loopback issuer mapping',
  async () => {
    await withEnv(
      { REMOTE_SUPABASE_URL: undefined, SUPABASE_URL: 'http://kong:8000' },
      async () => {
        const module = await importAuthModule();
        const result = await module.authenticateRequest(
          new Request('http://localhost', {
            headers: { Authorization: 'Bearer header.payload.signature' },
          }),
          {
            authClient: {
              auth: {
                getClaims: async () => ({
                  data: {
                    claims: validClaims({ iss: 'http://127.0.0.1:54321/auth/v1' }),
                  },
                  error: null,
                }),
              },
            } as any,
            allowedMethods: [module.AuthMethod.JWT],
          },
        );
        assertEquals(result.isAuthenticated, true);
      },
    );
  },
);

Deno.test('service and malformed opaque credentials never initialize legacy Redis', async () => {
  await withEnv({ SERVICE_API_KEY: TEST_SERVICE_API_KEY }, async () => {
    const module = await importAuthModule();
    let redisFactoryCalls = 0;
    const redisFactory = async () => {
      redisFactoryCalls += 1;
      return {} as any;
    };

    const serviceResult = await module.authenticateRequest(
      new Request('https://example.com', { headers: { apikey: TEST_SERVICE_API_KEY } }),
      { allowedMethods: [module.AuthMethod.SERVICE_API_KEY], redisFactory },
    );
    assertEquals(serviceResult.isAuthenticated, true);
    assertEquals(serviceResult.principal?.authMethod, 'service_api_key');

    const malformedResult = await module.authenticateRequest(
      new Request('https://example.com', {
        headers: { Authorization: 'Bearer definitely-not-base64-json' },
      }),
      { allowedMethods: [module.AuthMethod.USER_API_KEY], redisFactory },
    );
    assertEquals(malformedResult.isAuthenticated, false);
    assertEquals(malformedResult.response?.status, 401);
    assertEquals(redisFactoryCalls, 0);
  });
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

Deno.test(
  'legacy user API key lazily initializes Redis and uses an email-free hash key',
  async () => {
    const expectedCacheKey = await createExpectedUserApiCacheKey(
      TEST_USER_EMAIL,
      TEST_USER_PASSWORD,
    );
    let seenCacheKey: string | undefined;
    let redisFactoryCalls = 0;

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
        redisFactory: async () => {
          redisFactoryCalls += 1;
          return {
            get: async (key: string) => {
              seenCacheKey = key;
              return TEST_USER_ID;
            },
            set: async () => undefined,
          } as any;
        },
        allowedMethods: [module.AuthMethod.USER_API_KEY],
      },
    );

    assertEquals(result.isAuthenticated, true);
    assertEquals(result.principal?.authMethod, 'legacy_user_api_key');
    assertEquals(redisFactoryCalls, 1);
    assertEquals(seenCacheKey, expectedCacheKey);
    assertEquals(seenCacheKey?.includes(TEST_USER_EMAIL), false);
    assertEquals(seenCacheKey?.startsWith('lca_'), false);
  },
);

Deno.test('legacy user API key fails closed when lazy Redis initialization fails', async () => {
  const module = await importAuthModule();
  const bearerToken = btoa(
    JSON.stringify({ email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD }),
  );
  const result = await module.authenticateRequest(
    new Request('https://example.com', {
      headers: { Authorization: `Bearer ${bearerToken}` },
    }),
    {
      redisFactory: async () => {
        throw new Error('redis unavailable');
      },
      allowedMethods: [module.AuthMethod.USER_API_KEY],
    },
  );
  assertEquals(result.isAuthenticated, false);
  assertEquals(result.response?.status, 503);
  assertEquals(await result.response?.text(), 'Legacy user API key authentication unavailable');
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
