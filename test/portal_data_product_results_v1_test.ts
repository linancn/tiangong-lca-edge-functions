import { assert, assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert';

import {
  buildPortalHmacCanonical,
  computePortalBodyHash,
  encodeBase64Url,
  type PortalHmacKeyring,
} from '../supabase/functions/_shared/portal_hmac.ts';
import { PORTAL_ATOMIC_GUARD_LUA } from '../supabase/functions/_shared/portal_redis_guard.ts';
import type { PortalRedisAdapter } from '../supabase/functions/_shared/redis_client.ts';
import {
  createPortalDataProductResultsHandler,
  createPortalPublishedLciaRepository,
  PORTAL_LCIA_FUNCTION_PATH,
  PORTAL_LCIA_MAX_REQUEST_BYTES,
  portalPublishedLciaPageSchema,
  type PortalPublishedLciaPage,
  type PortalPublishedLciaRepository,
  validatePortalPublishableCredential,
  validatePortalSupabaseUrl,
} from '../supabase/functions/portal_data_product_results_v1/index.ts';

const NOW_SECONDS = 1_800_000_000;
const SECRET = Uint8Array.from({ length: 32 }, (_value, index) => index + 11);
const KEYRING: PortalHmacKeyring = {
  current: { keyId: 'portal-test-current', secret: SECRET },
};
const PROCESS_ID = '11111111-1111-4111-8111-111111111111';
const METHOD_ID = '22222222-2222-4222-8222-222222222222';
const PUBLICATION_ID = '33333333-3333-4333-8333-333333333333';
const PACKAGE_ID = '44444444-4444-4444-8444-444444444444';
const TRUSTED_PUBLISHABLE_KEY = 'sb_publishable_test';

function credentialJwt(role: string): string {
  return [
    encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))),
    encodeBase64Url(new TextEncoder().encode(JSON.stringify({ role }))),
    encodeBase64Url(new Uint8Array([1, 2, 3, 4])),
  ].join('.');
}

const LEGACY_ANON_KEY = credentialJwt('anon');
const DEFAULT_REQUEST = {
  mode: 'process_all_impacts',
  processRefs: [{ id: PROCESS_ID, version: '01.00.000' }],
  impactCategoryId: null,
  cursor: null,
  limit: 50,
};
const GUARD_LIMITS = {
  minuteBudget: 10,
  dailyBudget: 100,
  maxConcurrency: 2,
  leaseTtlSeconds: 30,
  cacheTtlSeconds: 300,
};

function page(): PortalPublishedLciaPage {
  return {
    schemaVersion: 'portal.published-lcia-page.v1',
    mode: 'process_all_impacts',
    publication: {
      publicationId: PUBLICATION_ID,
      packageId: PACKAGE_ID,
      packageVersion: '2026.08.001',
      publishedAt: '2026-08-25T12:00:00Z',
      evidenceHash: 'a'.repeat(64),
    },
    rows: [
      {
        process: { id: PROCESS_ID, version: '01.00.000' },
        functionalUnit: {
          amount: '1',
          unit: 'kg',
          description: [{ language: 'en', value: 'one kilogram of product' }],
        },
        geography: { code: 'CN', precision: 'country' },
        referenceYear: 2025,
        method: { id: METHOD_ID, version: '01.00.000' },
        impact: {
          id: 'climate-change',
          name: [{ language: 'en', value: 'Climate change' }],
        },
        value: '-12.5',
        unit: 'kg CO2 eq',
        evidenceStatus: 'verified',
      },
    ],
    nextCursor: null,
  };
}

async function signature(secret: Uint8Array, canonical: string): Promise<string> {
  const copy = new Uint8Array(secret.byteLength);
  copy.set(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    copy.buffer,
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
    payload?: unknown;
    rawBody?: string;
    nonceSeed?: number;
    badSignature?: boolean;
    path?: string;
    apiKey?: string | null;
    authorization?: string | null;
    cookie?: string | null;
  } = {},
): Promise<Request> {
  const rawBody =
    options.rawBody ??
    JSON.stringify(options.payload === undefined ? DEFAULT_REQUEST : options.payload);
  const bytes = new TextEncoder().encode(rawBody);
  const bodyHash = encodeBase64Url(await computePortalBodyHash(bytes));
  const nonce = encodeBase64Url(
    Uint8Array.from({ length: 16 }, (_value, index) => (index + (options.nonceSeed ?? 1)) % 256),
  );
  const canonical = buildPortalHmacCanonical({
    keyId: KEYRING.current.keyId,
    timestamp: String(NOW_SECONDS),
    nonce,
    method: 'POST',
    functionPath: PORTAL_LCIA_FUNCTION_PATH,
    bodyHash,
  });
  const headers = new Headers({
    'content-type': 'application/json',
    'x-portal-key-id': KEYRING.current.keyId,
    'x-portal-timestamp': String(NOW_SECONDS),
    'x-portal-nonce': nonce,
    'x-portal-body-sha256': bodyHash,
    'x-portal-signature': options.badSignature
      ? encodeBase64Url(new Uint8Array(32))
      : await signature(SECRET, canonical),
  });
  if (options.apiKey !== null) {
    headers.set('apikey', options.apiKey ?? TRUSTED_PUBLISHABLE_KEY);
  }
  if (options.authorization !== null && options.authorization !== undefined) {
    headers.set('authorization', options.authorization);
  }
  if (options.cookie !== null && options.cookie !== undefined) {
    headers.set('cookie', options.cookie);
  }
  return new Request(`https://example.supabase.co${options.path ?? PORTAL_LCIA_FUNCTION_PATH}`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

class HandlerRedis implements PortalRedisAdapter {
  readonly namespace = 'portal:test:v1';
  readonly calls: string[] = [];
  readonly nonces = new Set<string>();
  readonly cache = new Map<string, string>();
  guardResult: unknown = [0, 9, 99, 1];
  failSetNx = false;
  failGuard = false;

  setNxEx(key: string): Promise<boolean> {
    this.calls.push('nonce');
    if (this.failSetNx) return Promise.reject(new Error('provider detail'));
    if (this.nonces.has(key)) return Promise.resolve(false);
    this.nonces.add(key);
    return Promise.resolve(true);
  }

  eval(script: string): Promise<unknown> {
    if (script === PORTAL_ATOMIC_GUARD_LUA) {
      this.calls.push('guard');
      if (this.failGuard) return Promise.reject(new Error('provider detail'));
      return Promise.resolve(this.guardResult);
    }
    this.calls.push('release');
    return Promise.resolve(1);
  }

  get(key: string): Promise<string | null> {
    this.calls.push('cache-get');
    return Promise.resolve(this.cache.get(key) ?? null);
  }

  setEx(key: string, value: string): Promise<void> {
    this.calls.push('cache-set');
    this.cache.set(key, value);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.calls.push('close');
    return Promise.resolve();
  }
}

function repository(
  value: PortalPublishedLciaPage | null = page(),
  calls: string[] = [],
): PortalPublishedLciaRepository {
  return {
    query: () => {
      calls.push('database');
      return Promise.resolve(value);
    },
  };
}

function handlerOptions(redis: HandlerRedis, database: PortalPublishedLciaRepository) {
  return {
    keyring: KEYRING,
    redis,
    guardLimits: GUARD_LIMITS,
    repository: database,
    nowSeconds: () => NOW_SECONDS,
    nowMillis: () => NOW_SECONDS * 1000,
    upstreamTimeoutMs: 500,
    redisTimeoutMs: 500,
    trustedPublishableKey: TRUSTED_PUBLISHABLE_KEY,
    trustedLegacyAnonKey: LEGACY_ANON_KEY,
  };
}

Deno.test('signed Portal LCIA request returns the exact locator-free database DTO', async () => {
  const redis = new HandlerRedis();
  const databaseCalls: string[] = [];
  const handler = createPortalDataProductResultsHandler(
    handlerOptions(redis, repository(page(), databaseCalls)),
  );
  const response = await handler(await signedRequest());
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('X-Portal-Cache'), 'miss');
  assertEquals(await response.json(), page());
  assertEquals(databaseCalls, ['database']);
  assertEquals(redis.calls, ['nonce', 'guard', 'cache-get', 'cache-set', 'release']);
  assertEquals(JSON.stringify(page()).includes('bucket'), false);
  assertEquals(JSON.stringify(page()).includes('locator'), false);
});

Deno.test(
  'Supabase stripped path and exact pinned-CLI legacy anon transport are accepted',
  async () => {
    const redis = new HandlerRedis();
    const handler = createPortalDataProductResultsHandler(
      handlerOptions(redis, repository(page())),
    );
    const response = await handler(
      await signedRequest({
        path: '/portal_data_product_results_v1',
        authorization: `Bearer ${LEGACY_ANON_KEY}`,
        nonceSeed: 20,
      }),
    );
    assertEquals(response.status, 200);
  },
);

Deno.test('HMAC rejection precedes inbound transport validation', async () => {
  const redis = new HandlerRedis();
  const databaseCalls: string[] = [];
  const handler = createPortalDataProductResultsHandler(
    handlerOptions(redis, repository(page(), databaseCalls)),
  );
  const response = await handler(
    await signedRequest({
      badSignature: true,
      apiKey: 'sb_secret_not-public',
      authorization: 'Bearer user-token',
      nonceSeed: 21,
    }),
  );
  assertEquals(response.status, 401);
  assertEquals(redis.calls, []);
  assertEquals(databaseCalls, []);
});

Deno.test('inbound apikey must be strict public and exact before Redis or database', async () => {
  const invalidApiKeys: Array<string | null> = [
    null,
    'sb_publishable_mismatch',
    'sb_secret_test',
    credentialJwt('authenticated'),
    credentialJwt('service_role'),
  ];
  for (const [index, apiKey] of invalidApiKeys.entries()) {
    const redis = new HandlerRedis();
    const databaseCalls: string[] = [];
    const handler = createPortalDataProductResultsHandler(
      handlerOptions(redis, repository(page(), databaseCalls)),
    );
    const response = await handler(await signedRequest({ apiKey, nonceSeed: 30 + index }));
    assertEquals(response.status, 401);
    assertEquals((await response.json()).code, 'portal_auth_failed');
    assertEquals(redis.calls, []);
    assertEquals(databaseCalls, []);
  }
});

Deno.test(
  'only the exact configured legacy anon Authorization transport is tolerated',
  async () => {
    for (const [index, authorization] of [
      `Bearer ${credentialJwt('authenticated')}`,
      `Bearer ${credentialJwt('service_role')}`,
      'Bearer other-token',
      `bearer ${LEGACY_ANON_KEY}`,
    ].entries()) {
      const redis = new HandlerRedis();
      const databaseCalls: string[] = [];
      const handler = createPortalDataProductResultsHandler(
        handlerOptions(redis, repository(page(), databaseCalls)),
      );
      const response = await handler(await signedRequest({ authorization, nonceSeed: 40 + index }));
      assertEquals(response.status, 401);
      assertEquals(redis.calls, []);
      assertEquals(databaseCalls, []);
    }
  },
);

Deno.test('inbound Cookie is rejected after HMAC and before Redis or database', async () => {
  const redis = new HandlerRedis();
  const databaseCalls: string[] = [];
  const handler = createPortalDataProductResultsHandler(
    handlerOptions(redis, repository(page(), databaseCalls)),
  );
  const response = await handler(
    await signedRequest({ cookie: 'session=user-token', nonceSeed: 49 }),
  );
  assertEquals(response.status, 401);
  assertEquals((await response.json()).code, 'portal_auth_failed');
  assertEquals(redis.calls, []);
  assertEquals(databaseCalls, []);
});

Deno.test('invalid trusted transport configuration fails closed before Redis', async () => {
  const redis = new HandlerRedis();
  const databaseCalls: string[] = [];
  const handler = createPortalDataProductResultsHandler({
    ...handlerOptions(redis, repository(page(), databaseCalls)),
    trustedPublishableKey: 'sb_secret_misconfigured',
  });
  const response = await handler(await signedRequest({ nonceSeed: 50 }));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).code, 'portal_auth_unavailable');
  assertEquals(redis.calls, []);
  assertEquals(databaseCalls, []);
});

Deno.test('Portal handler rejects lease 19 and accepts the 20-second safety boundary', async () => {
  const rejectedRedis = new HandlerRedis();
  const rejectedDatabaseCalls: string[] = [];
  const rejected = createPortalDataProductResultsHandler({
    ...handlerOptions(rejectedRedis, repository(page(), rejectedDatabaseCalls)),
    guardLimits: { ...GUARD_LIMITS, leaseTtlSeconds: 19 },
  });
  const rejectedResponse = await rejected(await signedRequest({ nonceSeed: 51 }));
  assertEquals(rejectedResponse.status, 503);
  assertEquals((await rejectedResponse.json()).code, 'guard_unavailable');
  assertEquals(rejectedRedis.calls, []);
  assertEquals(rejectedDatabaseCalls, []);

  const acceptedRedis = new HandlerRedis();
  const accepted = createPortalDataProductResultsHandler({
    ...handlerOptions(acceptedRedis, repository(page())),
    guardLimits: { ...GUARD_LIMITS, leaseTtlSeconds: 20 },
  });
  assertEquals((await accepted(await signedRequest({ nonceSeed: 52 }))).status, 200);
});

Deno.test('default repository receives the same resolved trusted project key', async () => {
  const redis = new HandlerRedis();
  const resolvedKeys: string[] = [];
  const handler = createPortalDataProductResultsHandler({
    ...handlerOptions(redis, repository(page())),
    repository: undefined,
    repositoryFactory: (trustedPublishableKey) => {
      resolvedKeys.push(trustedPublishableKey);
      return repository(page());
    },
  });
  assertEquals((await handler(await signedRequest({ nonceSeed: 53 }))).status, 200);
  assertEquals(resolvedKeys, [TRUSTED_PUBLISHABLE_KEY]);
});

Deno.test('missing or bad HMAC is rejected before Redis, JSON, or database work', async () => {
  for (const request of [
    new Request(`https://example.supabase.co${PORTAL_LCIA_FUNCTION_PATH}`, {
      method: 'POST',
      body: 'not-json',
    }),
    await signedRequest({ rawBody: 'not-json', badSignature: true, nonceSeed: 2 }),
  ]) {
    const redis = new HandlerRedis();
    const databaseCalls: string[] = [];
    const handler = createPortalDataProductResultsHandler(
      handlerOptions(redis, repository(page(), databaseCalls)),
    );
    const response = await handler(request);
    assertEquals(response.status, 401);
    assertEquals((await response.json()).code, 'portal_auth_failed');
    assertEquals(redis.calls, []);
    assertEquals(databaseCalls, []);
  }
});

Deno.test('signed malformed JSON reaches auth and guard but never database', async () => {
  const redis = new HandlerRedis();
  const databaseCalls: string[] = [];
  const handler = createPortalDataProductResultsHandler(
    handlerOptions(redis, repository(page(), databaseCalls)),
  );
  const response = await handler(await signedRequest({ rawBody: 'not-json', nonceSeed: 3 }));
  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, 'invalid_request');
  assertEquals(redis.calls, ['nonce', 'guard', 'release']);
  assertEquals(databaseCalls, []);
});

Deno.test('duplicate nonce is rejected before admission and database', async () => {
  const redis = new HandlerRedis();
  const databaseCalls: string[] = [];
  const handler = createPortalDataProductResultsHandler(
    handlerOptions(redis, repository(page(), databaseCalls)),
  );
  assertEquals((await handler(await signedRequest({ nonceSeed: 4 }))).status, 200);
  const replay = await handler(await signedRequest({ nonceSeed: 4 }));
  assertEquals(replay.status, 403);
  assertEquals((await replay.json()).code, 'replay_rejected');
  assertEquals(databaseCalls, ['database']);
});

Deno.test('Redis nonce or admission outage fails closed before database', async () => {
  for (const failure of ['nonce', 'guard'] as const) {
    const redis = new HandlerRedis();
    if (failure === 'nonce') redis.failSetNx = true;
    else redis.failGuard = true;
    const databaseCalls: string[] = [];
    const handler = createPortalDataProductResultsHandler(
      handlerOptions(redis, repository(page(), databaseCalls)),
    );
    const response = await handler(await signedRequest({ nonceSeed: failure === 'nonce' ? 5 : 6 }));
    assertEquals(response.status, 503);
    assertEquals((await response.json()).code, 'guard_unavailable');
    assertEquals(databaseCalls, []);
  }
});

Deno.test('budget and concurrency rejection never call database', async () => {
  for (const [guardResult, code] of [
    [[1, 0, 99, 1], 'budget_exhausted'],
    [[2, 9, 99, 0], 'concurrency_exhausted'],
  ] as const) {
    const redis = new HandlerRedis();
    redis.guardResult = guardResult;
    const databaseCalls: string[] = [];
    const handler = createPortalDataProductResultsHandler(
      handlerOptions(redis, repository(page(), databaseCalls)),
    );
    const response = await handler(
      await signedRequest({ nonceSeed: code === 'budget_exhausted' ? 7 : 8 }),
    );
    assertEquals(response.status, 429);
    assertEquals((await response.json()).code, code);
    assertEquals(databaseCalls, []);
  }
});

Deno.test('missing publication is unavailable and never synthesized as zero', async () => {
  const redis = new HandlerRedis();
  const handler = createPortalDataProductResultsHandler(handlerOptions(redis, repository(null)));
  const response = await handler(await signedRequest({ nonceSeed: 9 }));
  assertEquals(response.status, 404);
  const body = await response.json();
  assertEquals(body.code, 'published_lcia_unavailable');
  assertEquals(JSON.stringify(body).includes(':0'), false);
});

Deno.test('numeric zero and incomplete response context fail the exact DTO boundary', async () => {
  const invalid = structuredClone(page()) as unknown as Record<string, unknown>;
  (invalid.rows as Array<Record<string, unknown>>)[0].value = 0;
  assertEquals(portalPublishedLciaPageSchema.safeParse(invalid).success, false);

  const redis = new HandlerRedis();
  const handler = createPortalDataProductResultsHandler(
    handlerOptions(redis, repository(invalid as unknown as PortalPublishedLciaPage)),
  );
  const response = await handler(await signedRequest({ nonceSeed: 10 }));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).code, 'published_lcia_unavailable');
});

Deno.test('successful LCIA response cache is validated and prevents a second DB call', async () => {
  const redis = new HandlerRedis();
  const databaseCalls: string[] = [];
  const handler = createPortalDataProductResultsHandler(
    handlerOptions(redis, repository(page(), databaseCalls)),
  );
  assertEquals((await handler(await signedRequest({ nonceSeed: 11 }))).status, 200);
  const cached = await handler(await signedRequest({ nonceSeed: 12 }));
  assertEquals(cached.status, 200);
  assertEquals(cached.headers.get('X-Portal-Cache'), 'hit');
  assertEquals(databaseCalls, ['database']);
});

Deno.test('request body limit is enforced without Redis or database work', async () => {
  const redis = new HandlerRedis();
  const databaseCalls: string[] = [];
  const handler = createPortalDataProductResultsHandler(
    handlerOptions(redis, repository(page(), databaseCalls)),
  );
  const response = await handler(
    new Request(`https://example.supabase.co${PORTAL_LCIA_FUNCTION_PATH}`, {
      method: 'POST',
      body: 'x'.repeat(PORTAL_LCIA_MAX_REQUEST_BYTES + 1),
    }),
  );
  assertEquals(response.status, 413);
  assertEquals(redis.calls, []);
  assertEquals(databaseCalls, []);
});

Deno.test('upstream timeout returns only a stable locator-free unavailable response', async () => {
  const redis = new HandlerRedis();
  let databaseCalled = false;
  const handler = createPortalDataProductResultsHandler({
    ...handlerOptions(redis, {
      query: (_request, signal) => {
        databaseCalled = true;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('private locator')), {
            once: true,
          });
        });
      },
    }),
    upstreamTimeoutMs: 100,
  });
  const response = await handler(await signedRequest({ nonceSeed: 13 }));
  assert(databaseCalled);
  assertEquals(response.status, 503);
  const body = await response.json();
  assertEquals(body, {
    code: 'published_lcia_unavailable',
    message: 'Published LCIA results unavailable',
  });
});

Deno.test(
  'publishable repository calls only the api RPC with no user or service credential',
  async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const database = createPortalPublishedLciaRepository({
      supabaseUrl: 'https://example.supabase.co',
      publishableKey: 'sb_publishable_test',
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return Promise.resolve(
          new Response(JSON.stringify(page()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }) as typeof fetch,
    });
    const result = await database.query(
      {
        mode: 'process_all_impacts',
        processRefs: [{ id: PROCESS_ID, version: '01.00.000' }],
        impactCategoryId: null,
        cursor: null,
        limit: 50,
      },
      new AbortController().signal,
    );
    assertEquals(result, page());
    assert(captured);
    assertEquals(
      captured.url,
      'https://example.supabase.co/rest/v1/rpc/portal_get_published_lcia_values_v1',
    );
    const headers = new Headers(captured.init.headers);
    assertEquals(headers.get('apikey'), 'sb_publishable_test');
    assertEquals(headers.get('Content-Profile'), 'api');
    assertEquals(headers.get('Authorization'), null);
    assertEquals(JSON.parse(String(captured.init.body)), {
      p_mode: 'process_all_impacts',
      p_process_refs: [{ id: PROCESS_ID, version: '01.00.000' }],
      p_impact_ref: null,
      p_cursor: null,
      p_limit: 50,
    });
    assertEquals(JSON.stringify(captured).includes('service_role'), false);
  },
);

Deno.test(
  'publishable repository rejects a non-schema or oversized upstream response',
  async () => {
    for (const response of [
      new Response(JSON.stringify({ ...page(), items: page().rows, rows: undefined }), {
        status: 200,
      }),
      new Response('x', {
        status: 200,
        headers: { 'Content-Length': String(512 * 1024 + 1) },
      }),
    ]) {
      const database = createPortalPublishedLciaRepository({
        supabaseUrl: 'https://example.supabase.co',
        publishableKey: 'sb_publishable_test',
        fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
      });
      await assertRejects(() =>
        database.query(
          {
            mode: 'process_all_impacts',
            processRefs: [{ id: PROCESS_ID, version: '01.00.000' }],
            impactCategoryId: null,
            cursor: null,
            limit: 50,
          },
          new AbortController().signal,
        ),
      );
    }
  },
);

Deno.test('Portal repository rejects secret/service credentials and unsafe remote URLs', () => {
  const jwt = (role: string) =>
    [
      encodeBase64Url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))),
      encodeBase64Url(new TextEncoder().encode(JSON.stringify({ role }))),
      encodeBase64Url(new Uint8Array([1, 2, 3, 4])),
    ].join('.');

  assertEquals(validatePortalPublishableCredential('sb_publishable_test'), 'sb_publishable_test');
  assertEquals(validatePortalPublishableCredential(jwt('anon')), jwt('anon'));
  for (const credential of [
    'sb_secret_test',
    jwt('service_role'),
    jwt('authenticated'),
    'header.not-base64!.signature',
    'sb_publishable_test\n',
  ]) {
    assertThrows(
      () => validatePortalPublishableCredential(credential),
      Error,
      'published_lcia_upstream_unavailable',
    );
  }

  assertEquals(
    validatePortalSupabaseUrl('https://example.supabase.co/'),
    'https://example.supabase.co',
  );
  assertEquals(validatePortalSupabaseUrl('http://127.0.0.1:54321'), 'http://127.0.0.1:54321');
  for (const url of [
    'http://example.supabase.co',
    'https://user:password@example.supabase.co',
    'https://example.supabase.co/rest/v1',
    'https://example.supabase.co?key=value',
    'ftp://example.supabase.co',
  ]) {
    assertThrows(
      () => validatePortalSupabaseUrl(url),
      Error,
      'published_lcia_upstream_unavailable',
    );
  }
});
