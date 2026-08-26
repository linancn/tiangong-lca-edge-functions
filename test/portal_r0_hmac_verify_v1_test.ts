import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';

import {
  buildPortalHmacCanonical,
  computePortalBodyHash,
  encodeBase64Url,
  type PortalHmacKey,
  type PortalHmacKeyring,
} from '../supabase/functions/_shared/portal_hmac.ts';
import type { PortalRedisAdapter } from '../supabase/functions/_shared/redis_client.ts';
import type { PortalR0RedisConfig } from '../supabase/functions/_shared/portal_r0_redis.ts';
import {
  createPortalR0HmacVerifyHandler,
  PORTAL_R0_FUNCTION_PATH,
  PORTAL_R0_MAX_REQUEST_BYTES,
  PORTAL_R0_RUNTIME_PATH,
} from '../supabase/functions/portal_r0_hmac_verify_v1/index.ts';

const NOW_SECONDS = 1_800_000_000;
const NOW_MILLIS = NOW_SECONDS * 1_000;
const PUBLISHABLE_KEY = 'sb_publishable_r0_fixture_abcdefghijklmnopqrstuvwxyz';
const CURRENT_KEY: PortalHmacKey = {
  keyId: 'r0-preview-new',
  secret: Uint8Array.from({ length: 32 }, (_value, index) => index + 1),
};
const PREVIOUS_KEY: PortalHmacKey = {
  keyId: 'r0-preview-old',
  secret: Uint8Array.from({ length: 48 }, (_value, index) => 255 - index),
};
const KEYRING: PortalHmacKeyring = { current: CURRENT_KEY, previous: PREVIOUS_KEY };
const NONCE = encodeBase64Url(Uint8Array.from({ length: 16 }, (_value, index) => index * 7 + 3));
const VALID_BODY = JSON.stringify({ schemaVersion: 'portal.r0-hmac-verify-request.v1' });

const REDIS_CONFIG: PortalR0RedisConfig = {
  target: 'test',
  provider: 'standard',
  namespace: 'portal:r0:handler-fixture:v1',
  timeoutMs: 500,
  redisUrl: 'redis://127.0.0.1:6379',
  minuteBudget: 4,
  dailyBudget: 20,
  maxConcurrency: 2,
  leaseTtlSeconds: 20,
};

class FixtureRedis implements PortalRedisAdapter {
  readonly namespace = REDIS_CONFIG.namespace;
  readonly setCalls: string[] = [];
  readonly evalCalls: Array<{ script: string; keys: string[] }> = [];
  setResult = true;
  evalResults: unknown[] = [[0, 3, 19, 1, 0], 1];

  setNxEx(key: string): Promise<boolean> {
    this.setCalls.push(key);
    return Promise.resolve(this.setResult);
  }

  eval(script: string, keys: string[]): Promise<unknown> {
    this.evalCalls.push({ script, keys });
    const result = this.evalResults.shift();
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  }

  get(): Promise<string | null> {
    throw new Error('R0 must not read business cache data');
  }

  setEx(): Promise<void> {
    throw new Error('R0 must not write business cache data');
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

async function sign(secret: Uint8Array, canonical: string): Promise<string> {
  const secretCopy = new Uint8Array(secret.byteLength);
  secretCopy.set(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    secretCopy.buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return encodeBase64Url(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical))),
  );
}

async function signedRequest(
  options: {
    body?: string;
    signedBody?: string;
    key?: PortalHmacKey;
    keyId?: string;
    path?: string;
    signedPath?: string;
    timestamp?: number;
    nonce?: string;
    headers?: HeadersInit;
  } = {},
): Promise<Request> {
  const body = options.body ?? VALID_BODY;
  const signedBody = options.signedBody ?? body;
  const key = options.key ?? CURRENT_KEY;
  const keyId = options.keyId ?? key.keyId;
  const timestamp = options.timestamp ?? NOW_SECONDS;
  const nonce = options.nonce ?? NONCE;
  const bodyHash = encodeBase64Url(
    await computePortalBodyHash(new TextEncoder().encode(signedBody)),
  );
  const signature = await sign(
    key.secret,
    buildPortalHmacCanonical({
      keyId,
      timestamp: String(timestamp),
      nonce,
      method: 'POST',
      functionPath: options.signedPath ?? PORTAL_R0_FUNCTION_PATH,
      bodyHash,
    }),
  );
  const headers = new Headers(options.headers);
  headers.set('apikey', PUBLISHABLE_KEY);
  headers.set('content-type', 'application/json');
  headers.set('x-portal-key-id', keyId);
  headers.set('x-portal-timestamp', String(timestamp));
  headers.set('x-portal-nonce', nonce);
  headers.set('x-portal-body-sha256', bodyHash);
  headers.set('x-portal-signature', signature);
  return new Request(`https://fixture.supabase.co${options.path ?? PORTAL_R0_FUNCTION_PATH}`, {
    method: 'POST',
    headers,
    body,
  });
}

function handler(redis: FixtureRedis, keyring: PortalHmacKeyring = KEYRING) {
  return createPortalR0HmacVerifyHandler({
    keyring,
    trustedPublishableKey: PUBLISHABLE_KEY,
    redisConfig: REDIS_CONFIG,
    redis,
    nowSeconds: () => NOW_SECONDS,
    nowMillis: () => NOW_MILLIS,
  });
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

Deno.test('R0 handler verifies exact raw bytes and returns only the bounded receipt', async () => {
  const redis = new FixtureRedis();
  const response = await handler(redis)(await signedRequest());
  assertEquals(response.status, 200);
  assertEquals(await payload(response), {
    schemaVersion: 'portal.r0-hmac-redis-receipt.v1',
    ok: true,
  });
  assertEquals(redis.setCalls.length, 1);
  assertEquals(redis.evalCalls.length, 2);
});

Deno.test(
  'R0 handler accepts only public canonical bytes on the exact CLI-stripped path',
  async () => {
    const redis = new FixtureRedis();
    const response = await handler(redis)(
      await signedRequest({ path: PORTAL_R0_RUNTIME_PATH, signedPath: PORTAL_R0_FUNCTION_PATH }),
    );
    assertEquals(response.status, 200);

    const rejectedRedis = new FixtureRedis();
    const rejected = await handler(rejectedRedis)(
      await signedRequest({ path: `${PORTAL_R0_RUNTIME_PATH}/suffix` }),
    );
    assertEquals(rejected.status, 401);
    assertEquals(rejectedRedis.setCalls.length, 0);
  },
);

Deno.test(
  'R0 rotation accepts previous during the window and rejects it after removal',
  async () => {
    const rotatingRedis = new FixtureRedis();
    assertEquals(
      (await handler(rotatingRedis)(await signedRequest({ key: PREVIOUS_KEY }))).status,
      200,
    );

    const removedRedis = new FixtureRedis();
    const removed = await handler(removedRedis, { current: CURRENT_KEY })(
      await signedRequest({ key: PREVIOUS_KEY }),
    );
    assertEquals(removed.status, 401);
    assertEquals(removedRedis.setCalls.length, 0);
  },
);

Deno.test(
  'R0 rejects tamper, expiry, future time, unknown key, and cross-function path before Redis',
  async () => {
    const cases = [
      signedRequest({
        body: '{ "schemaVersion": "portal.r0-hmac-verify-request.v1" }',
        signedBody: VALID_BODY,
      }),
      signedRequest({ timestamp: NOW_SECONDS - 61 }),
      signedRequest({ timestamp: NOW_SECONDS + 61 }),
      signedRequest({
        key: {
          keyId: 'r0-unknown',
          secret: Uint8Array.from({ length: 32 }, (_value, index) => 90 + index),
        },
      }),
      signedRequest({ path: '/functions/v1/portal_hybrid_search_v1' }),
    ];
    for (const request of await Promise.all(cases)) {
      const redis = new FixtureRedis();
      const response = await handler(redis)(request);
      assertEquals(response.status, 401);
      assertEquals(redis.setCalls.length, 0);
      assertEquals(redis.evalCalls.length, 0);
    }
  },
);

Deno.test('R0 validates its dedicated publishable key after HMAC and before Redis', async () => {
  const redis = new FixtureRedis();
  const request = await signedRequest();
  request.headers.set('apikey', 'sb_publishable_wrong');
  const response = await handler(redis)(request);
  assertEquals(response.status, 401);
  assertEquals(redis.setCalls.length, 0);
});

Deno.test('R0 replay stops after SET NX EX and never reaches Lua admission', async () => {
  const redis = new FixtureRedis();
  redis.setResult = false;
  const response = await handler(redis)(await signedRequest());
  assertEquals(response.status, 403);
  assertEquals(await payload(response), {
    schemaVersion: 'portal.r0-hmac-redis-receipt.v1',
    ok: false,
    code: 'replay_rejected',
  });
  assertEquals(redis.evalCalls.length, 0);
});

Deno.test('R0 atomic budget and concurrency contention return fixed receipts', async () => {
  for (const [result, code] of [
    [[1, 0, 19, 1, 0], 'budget_exhausted'],
    [[2, 3, 19, 0, 0], 'concurrency_exhausted'],
  ] as const) {
    const redis = new FixtureRedis();
    redis.evalResults = [result];
    const response = await handler(redis)(await signedRequest());
    assertEquals(response.status, 429);
    assertEquals((await payload(response)).code, code);
  }
});

Deno.test(
  'R0 Redis outage, malformed admission, and failed lease cleanup fail closed',
  async () => {
    for (const results of [
      [new Error('provider secret detail')],
      [[0, 1]],
      [[0, 3, 19, 1, 0], new Error('release detail')],
    ]) {
      const redis = new FixtureRedis();
      redis.evalResults = results;
      const response = await handler(redis)(await signedRequest());
      assertEquals(response.status, 503);
      assertEquals(await payload(response), {
        schemaVersion: 'portal.r0-hmac-redis-receipt.v1',
        ok: false,
        code: 'r0_unavailable',
      });
    }
  },
);

Deno.test(
  'R0 parses only after admission and releases the lease for an invalid body schema',
  async () => {
    const redis = new FixtureRedis();
    const response = await handler(redis)(await signedRequest({ body: '{}' }));
    assertEquals(response.status, 400);
    assertEquals((await payload(response)).code, 'invalid_request');
    assertEquals(redis.evalCalls.length, 2);
  },
);

Deno.test('R0 oversized requests fail before HMAC and Redis', async () => {
  const redis = new FixtureRedis();
  const response = await handler(redis)(
    new Request(`https://fixture.supabase.co${PORTAL_R0_FUNCTION_PATH}`, {
      method: 'POST',
      headers: { 'content-length': String(PORTAL_R0_MAX_REQUEST_BYTES + 1) },
      body: 'x',
    }),
  );
  assertEquals(response.status, 413);
  assertEquals(redis.setCalls.length, 0);
});

Deno.test(
  'R0 runtime has no business, provider, database, service, or logging surface',
  async () => {
    const files = [
      './supabase/functions/_shared/portal_r0_hmac.ts',
      './supabase/functions/_shared/portal_r0_redis.ts',
      './supabase/functions/_shared/portal_r0_transport.ts',
      './supabase/functions/portal_r0_hmac_verify_v1/index.ts',
    ];
    const source = (await Promise.all(files.map((file) => Deno.readTextFile(file)))).join('\n');
    for (const forbidden of [
      '.rpc(',
      '/rest/v1/',
      'createClient(',
      'createSupabase',
      'fetch(',
      'OPENAI_',
      'SAGEMAKER_',
      'AWS_',
      'SERVICE_API_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SECRET_KEY',
      'console.',
    ]) {
      assertEquals(source.includes(forbidden), false, `forbidden R0 surface: ${forbidden}`);
    }
    for (const required of [
      'PORTAL_R0_HMAC_KEY_ID_CURRENT',
      'PORTAL_R0_REDIS_CLIENT_TYPE',
      'PORTAL_R0_SUPABASE_PUBLISHABLE_KEY',
      'PORTAL_R0_FUNCTION_PATH',
    ]) {
      assertStringIncludes(source, required);
    }
  },
);

Deno.test('R0 responses contain none of the signed or Redis fixture material', async () => {
  const redis = new FixtureRedis();
  const request = await signedRequest();
  const responseText = await (await handler(redis)(request)).text();
  for (const forbidden of [
    NONCE,
    CURRENT_KEY.keyId,
    PUBLISHABLE_KEY,
    VALID_BODY,
    REDIS_CONFIG.namespace,
    'replay:',
    'budget:',
    'lease:',
  ]) {
    assertEquals(responseText.includes(forbidden), false);
  }
});
