import { assertEquals } from "jsr:@std/assert";

const MODULE_PATH = "../supabase/functions/_shared/auth.ts";

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
  "publishable apikey is ignored by service-key auth when no other auth is provided",
  async () => {
    await withEnv(
      {
        SERVICE_API_KEY: "service-secret",
        SUPABASE_ANON_KEY: "sb_publishable_test_key",
      },
      async () => {
        const module = await importAuthModule();
        const req = new Request("https://example.com", {
          method: "POST",
          headers: {
            apikey: "sb_publishable_test_key",
          },
        });

        const result = await module.authenticateRequest(req, {
          allowedMethods: [module.AuthMethod.SERVICE_API_KEY],
        });

        assertEquals(result.isAuthenticated, false);
        assertEquals(result.response?.status, 401);
        assertEquals(await result.response?.text(), "Unauthorized Request");
      },
    );
  },
);

Deno.test(
  "publishable apikey does not mask JWT failures when a bearer token is present",
  async () => {
    await withEnv(
      {
        SERVICE_API_KEY: "service-secret",
        SUPABASE_ANON_KEY: "sb_publishable_test_key",
      },
      async () => {
        const module = await importAuthModule();
        const req = new Request("https://example.com", {
          method: "POST",
          headers: {
            apikey: "sb_publishable_test_key",
            Authorization: "Bearer not-a-real-jwt",
          },
        });

        const result = await module.authenticateRequest(req, {
          supabase: {
            auth: {
              getUser: async () => ({ data: { user: null } }),
            },
          } as any,
          allowedMethods: [module.AuthMethod.JWT, module.AuthMethod.SERVICE_API_KEY],
        });

        assertEquals(result.isAuthenticated, false);
        assertEquals(result.response?.status, 401);
        assertEquals(await result.response?.text(), "User Not Found");
      },
    );
  },
);

Deno.test(
  "jwt-like bearer tokens use JWT auth instead of user API key auth when both are allowed",
  async () => {
    await withEnv(
      {
        SERVICE_API_KEY: "service-secret",
        SUPABASE_ANON_KEY: "sb_publishable_test_key",
      },
      async () => {
        const module = await importAuthModule();
        const req = new Request("https://example.com", {
          method: "POST",
          headers: {
            Authorization: "Bearer header.payload.signature",
          },
        });

        const result = await module.authenticateRequest(req, {
          supabase: {
            auth: {
              getUser: async () => ({ data: { user: null } }),
            },
          } as any,
          redis: {} as any,
          allowedMethods: [module.AuthMethod.JWT, module.AuthMethod.USER_API_KEY],
        });

        assertEquals(result.isAuthenticated, false);
        assertEquals(result.response?.status, 401);
        assertEquals(await result.response?.text(), "User Not Found");
      },
    );
  },
);
