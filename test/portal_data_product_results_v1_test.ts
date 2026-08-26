import { assert, assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert';

import {
  buildPortalHmacCanonical,
  computePortalBodyHash,
  encodeBase64Url,
  PortalHmacError,
  type PortalHmacKeyring,
} from '../supabase/functions/_shared/portal_hmac.ts';
import { PORTAL_ATOMIC_GUARD_LUA } from '../supabase/functions/_shared/portal_redis_guard.ts';
import type { PortalRedisAdapter } from '../supabase/functions/_shared/redis_client.ts';
import {
  createPortalDataProductResultsHandler,
  createPortalPublishedLciaRepository,
  hmacSecurityOutcome,
  PORTAL_LCIA_FUNCTION_PATH,
  PORTAL_LCIA_MAX_REQUEST_BYTES,
  portalPublishedLciaPageSchema,
  type PortalPublishedLciaPage,
  type PortalPublishedLciaRepository,
  PortalTransportError,
  readPortalPublishableCredential,
  transportSecurityOutcome,
  validatePortalPublishableCredential,
  validatePortalSupabaseUrl,
} from '../supabase/functions/portal_data_product_results_v1/index.ts';
import { readPortalDeploymentSha } from '../supabase/functions/_shared/portal_security_event.ts';

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
const CORRELATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function environment(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] };
}

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
  cacheTtlSeconds: 60,
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
    correlationId?: string | null;
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
  if (options.correlationId !== null) {
    headers.set('x-portal-correlation-id', options.correlationId ?? CORRELATION_ID);
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
  readonly cache = new Map<string, { value: string; expiresAt: number }>();
  nowMillis = 0;
  guardResult: unknown = [0, 9, 99, 1, 0];
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
    const cached = this.cache.get(key);
    return Promise.resolve(cached && cached.expiresAt > this.nowMillis ? cached.value : null);
  }

  setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.calls.push('cache-set');
    this.cache.set(key, {
      value,
      expiresAt: this.nowMillis + ttlSeconds * 1000,
    });
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
    deploymentSha: 'd'.repeat(40),
    logger: () => undefined,
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
  assertEquals(response.headers.get('X-Portal-Correlation-Id'), CORRELATION_ID);
  assertEquals(response.headers.get('X-Portal-Cache'), 'miss');
  assertEquals(await response.json(), page());
  assertEquals(databaseCalls, ['database']);
  assertEquals(redis.calls, ['nonce', 'guard', 'cache-get', 'cache-set', 'release']);
  assertEquals(JSON.stringify(page()).includes('bucket'), false);
  assertEquals(JSON.stringify(page()).includes('locator'), false);
});

Deno.test('Portal emits exactly one allowlisted structured event per request', async () => {
  const redis = new HandlerRedis();
  redis.guardResult = [0, 9, 99, 1, 3];
  const events: Array<Record<string, unknown>> = [];
  const times = [100, 125];
  const handler = createPortalDataProductResultsHandler({
    ...handlerOptions(redis, repository(page())),
    deploymentSha: 'A'.repeat(40),
    monotonicNow: () => times.shift() ?? 125,
    logger: (event) => {
      events.push({ ...event });
    },
  });
  const response = await handler(await signedRequest({ nonceSeed: 60 }));
  assertEquals(response.status, 200);
  assertEquals(events, [
    {
      schemaVersion: 'portal.security-event.v1',
      route: 'portal_data_product_results_v1',
      correlationId: CORRELATION_ID,
      mode: 'process_all_impacts',
      cache: 'miss',
      hmacOutcome: 'accepted',
      transportOutcome: 'accepted',
      backend: 'supabase_public_rpc',
      latencyMs: 25,
      rows: 1,
      status: 200,
      errorCode: null,
      matchedKey: 'current',
      recoveredLeaseCount: 3,
      deploymentSha: 'a'.repeat(40),
    },
  ]);
  assertEquals(Object.keys(events[0]).sort(), [
    'backend',
    'cache',
    'correlationId',
    'deploymentSha',
    'errorCode',
    'hmacOutcome',
    'latencyMs',
    'matchedKey',
    'mode',
    'recoveredLeaseCount',
    'route',
    'rows',
    'schemaVersion',
    'status',
    'transportOutcome',
  ]);
  const serializedEvent = JSON.stringify(events[0]);
  for (const forbidden of [
    PROCESS_ID,
    METHOD_ID,
    PUBLICATION_ID,
    PACKAGE_ID,
    KEYRING.current.keyId,
    TRUSTED_PUBLISHABLE_KEY,
    LEGACY_ANON_KEY,
    'climate-change',
    'session=user-token',
    'locator',
  ]) {
    assertEquals(serializedEvent.includes(forbidden), false);
  }
});

Deno.test('invalid inbound correlation id is replaced and never echoed', async () => {
  const redis = new HandlerRedis();
  const events: Array<Record<string, unknown>> = [];
  const handler = createPortalDataProductResultsHandler({
    ...handlerOptions(redis, repository(page())),
    logger: (event) => {
      events.push({ ...event });
    },
  });
  const invalidCorrelationId = `invalid:${PROCESS_ID}:private`;
  const response = await handler(
    await signedRequest({ correlationId: invalidCorrelationId, nonceSeed: 63 }),
  );
  const resolved = response.headers.get('X-Portal-Correlation-Id');
  assert(resolved);
  assertEquals(resolved === invalidCorrelationId, false);
  assertEquals(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(resolved),
    true,
  );
  assertEquals(events[0].correlationId, resolved);
  assertEquals(JSON.stringify(events[0]).includes(invalidCorrelationId), false);
});

Deno.test('security logger failure never changes or duplicates the response', async () => {
  const redis = new HandlerRedis();
  let loggerCalls = 0;
  const handler = createPortalDataProductResultsHandler({
    ...handlerOptions(redis, repository(page())),
    logger: () => {
      loggerCalls += 1;
      throw new Error('logger backend unavailable with sensitive details');
    },
  });
  const response = await handler(await signedRequest({ nonceSeed: 61 }));
  assertEquals(response.status, 200);
  assertEquals(loggerCalls, 1);
});

Deno.test('never-resolving async logger cannot delay the response', async () => {
  const redis = new HandlerRedis();
  let loggerCalls = 0;
  const handler = createPortalDataProductResultsHandler({
    ...handlerOptions(redis, repository(page())),
    logger: () => {
      loggerCalls += 1;
      return new Promise<void>(() => undefined);
    },
  });
  const outcome = await Promise.race([
    handler(await signedRequest({ nonceSeed: 62 })),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50)),
  ]);
  assertEquals(outcome instanceof Response, true);
  if (outcome instanceof Response) assertEquals(outcome.status, 200);
  assertEquals(loggerCalls, 1);
});

Deno.test(
  'pre-auth rejection still emits one sanitized event and performs no Redis work',
  async () => {
    const redis = new HandlerRedis();
    const events: Array<Record<string, unknown>> = [];
    const handler = createPortalDataProductResultsHandler({
      ...handlerOptions(redis, repository(page())),
      logger: (event) => {
        events.push({ ...event });
      },
    });
    const response = await handler(
      new Request(`https://example.supabase.co${PORTAL_LCIA_FUNCTION_PATH}`, {
        method: 'POST',
        body: 'private-query-and-cookie-value',
      }),
    );
    assertEquals(response.status, 401);
    assertEquals(redis.calls, []);
    assertEquals(events.length, 1);
    assertEquals(events[0].errorCode, 'portal_auth_failed');
    assertEquals(events[0].matchedKey, null);
    assertEquals(events[0].hmacOutcome, 'headers');
    assertEquals(events[0].transportOutcome, 'not_checked');
    assertEquals(events[0].backend, 'none');
    assertEquals(response.headers.get('X-Portal-Correlation-Id'), events[0].correlationId);
    assertEquals(JSON.stringify(events[0]).includes('private-query-and-cookie-value'), false);
  },
);

Deno.test('security outcome mappings are fixed, complete, and locator-free', () => {
  const hmacOutcomes = [
    ['portal_hmac_config_invalid', 'config'],
    ['portal_hmac_method_invalid', 'method'],
    ['portal_hmac_path_invalid', 'path'],
    ['portal_hmac_headers_missing', 'headers'],
    ['portal_hmac_headers_invalid', 'headers'],
    ['portal_hmac_timestamp_expired', 'timestamp'],
    ['portal_hmac_body_hash_mismatch', 'body_hash'],
    ['portal_hmac_key_unknown', 'unknown_key'],
    ['portal_hmac_signature_invalid', 'signature'],
  ] as const;
  assertEquals(
    hmacOutcomes.map(([code]) => hmacSecurityOutcome(new PortalHmacError(code))),
    hmacOutcomes.map(([, outcome]) => outcome),
  );

  const transportOutcomes = [
    ['portal_transport_config_invalid', 'config'],
    ['portal_apikey_missing', 'apikey_missing'],
    ['portal_apikey_invalid', 'apikey_invalid'],
    ['portal_apikey_mismatch', 'apikey_mismatch'],
    ['portal_authorization_invalid', 'authorization_invalid'],
    ['portal_cookie_invalid', 'cookie_invalid'],
  ] as const;
  assertEquals(
    transportOutcomes.map(([code]) => transportSecurityOutcome(new PortalTransportError(code))),
    transportOutcomes.map(([, outcome]) => outcome),
  );
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
  const invalidApiKeys: Array<[string | null, string]> = [
    [null, 'apikey_missing'],
    ['sb_publishable_mismatch', 'apikey_mismatch'],
    ['sb_secret_test', 'apikey_invalid'],
    [credentialJwt('authenticated'), 'apikey_invalid'],
    [credentialJwt('service_role'), 'apikey_invalid'],
  ];
  for (const [index, [apiKey, expectedOutcome]] of invalidApiKeys.entries()) {
    const redis = new HandlerRedis();
    const databaseCalls: string[] = [];
    const events: Array<Record<string, unknown>> = [];
    const handler = createPortalDataProductResultsHandler({
      ...handlerOptions(redis, repository(page(), databaseCalls)),
      logger: (event) => {
        events.push({ ...event });
      },
    });
    const response = await handler(await signedRequest({ apiKey, nonceSeed: 30 + index }));
    assertEquals(response.status, 401);
    assertEquals((await response.json()).code, 'portal_auth_failed');
    assertEquals(redis.calls, []);
    assertEquals(databaseCalls, []);
    assertEquals(events[0].hmacOutcome, 'accepted');
    assertEquals(events[0].transportOutcome, expectedOutcome);
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
  const events: Array<Record<string, unknown>> = [];
  const handler = createPortalDataProductResultsHandler({
    ...handlerOptions(redis, repository(page(), databaseCalls)),
    logger: (event) => {
      events.push({ ...event });
    },
  });
  const response = await handler(
    await signedRequest({ cookie: 'session=user-token', nonceSeed: 49 }),
  );
  assertEquals(response.status, 401);
  assertEquals((await response.json()).code, 'portal_auth_failed');
  assertEquals(redis.calls, []);
  assertEquals(databaseCalls, []);
  assertEquals(events[0].hmacOutcome, 'accepted');
  assertEquals(events[0].transportOutcome, 'cookie_invalid');
  assertEquals(JSON.stringify(events[0]).includes('session=user-token'), false);
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

Deno.test('Portal publishable credential is dedicated and bound to the current project', () => {
  const portalKey = 'sb_publishable_portal_project_key';
  assertEquals(
    readPortalPublishableCredential(
      environment({
        PORTAL_SUPABASE_PUBLISHABLE_KEY: portalKey,
        SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ portal: portalKey, web: 'sb_publishable_web' }),
        REMOTE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_forbidden_fallback',
      }),
    ),
    portalKey,
  );

  for (const values of [
    {
      REMOTE_SUPABASE_PUBLISHABLE_KEY: portalKey,
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ portal: portalKey }),
    },
    {
      PORTAL_SUPABASE_PUBLISHABLE_KEY: portalKey,
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ otherProject: 'sb_publishable_other_project' }),
    },
    {
      PORTAL_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_forbidden_portal',
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ secret: 'sb_secret_forbidden_portal' }),
    },
    {
      PORTAL_SUPABASE_PUBLISHABLE_KEY: ` ${portalKey}`,
      SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ portal: portalKey }),
    },
    {
      PORTAL_SUPABASE_PUBLISHABLE_KEY: portalKey,
      SUPABASE_PUBLISHABLE_KEYS: '{bad-json',
    },
  ]) {
    assertThrows(
      () => readPortalPublishableCredential(environment(values)),
      PortalTransportError,
      'portal_transport_config_invalid',
    );
  }
});

Deno.test('Portal LCIA and Hybrid deployment provenance read only their own exact SHA', () => {
  const lciaSha = 'a'.repeat(40);
  const hybridSha = 'b'.repeat(64);
  const env = environment({
    PORTAL_LCIA_DEPLOYMENT_SHA: lciaSha.toUpperCase(),
    PORTAL_HYBRID_DEPLOYMENT_SHA: hybridSha,
    PORTAL_DEPLOYMENT_SHA: 'c'.repeat(40),
  });
  assertEquals(readPortalDeploymentSha('PORTAL_LCIA_DEPLOYMENT_SHA', env), lciaSha);
  assertEquals(readPortalDeploymentSha('PORTAL_HYBRID_DEPLOYMENT_SHA', env), hybridSha);
  assertEquals(
    readPortalDeploymentSha(
      'PORTAL_HYBRID_DEPLOYMENT_SHA',
      environment({ PORTAL_LCIA_DEPLOYMENT_SHA: lciaSha }),
    ),
    'unknown',
  );
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
    [[1, 0, 99, 1, 0], 'budget_exhausted'],
    [[2, 9, 99, 0, 0], 'concurrency_exhausted'],
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
  const events: Array<Record<string, unknown>> = [];
  const handler = createPortalDataProductResultsHandler({
    ...handlerOptions(redis, repository(null)),
    logger: (event) => {
      events.push({ ...event });
    },
  });
  const response = await handler(await signedRequest({ nonceSeed: 9 }));
  assertEquals(response.status, 404);
  const body = await response.json();
  assertEquals(body.code, 'published_lcia_unavailable');
  assertEquals(JSON.stringify(body).includes(':0'), false);
  assertEquals(events[0].rows, 0);
  assertEquals(events[0].backend, 'supabase_public_rpc');
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

Deno.test('revoked publication becomes unavailable at the 60-second cache boundary', async () => {
  const redis = new HandlerRedis();
  let clockMillis = 0;
  let currentPublication: PortalPublishedLciaPage | null = page();
  const databaseCalls: number[] = [];
  const handler = createPortalDataProductResultsHandler({
    ...handlerOptions(redis, {
      query: () => {
        databaseCalls.push(clockMillis);
        return Promise.resolve(currentPublication);
      },
    }),
    nowMillis: () => clockMillis,
  });

  assertEquals((await handler(await signedRequest({ nonceSeed: 70 }))).status, 200);
  currentPublication = null;

  clockMillis = 59_999;
  redis.nowMillis = clockMillis;
  const stillCached = await handler(await signedRequest({ nonceSeed: 71 }));
  assertEquals(stillCached.status, 200);
  assertEquals(stillCached.headers.get('X-Portal-Cache'), 'hit');

  clockMillis = 60_000;
  redis.nowMillis = clockMillis;
  const revoked = await handler(await signedRequest({ nonceSeed: 72 }));
  assertEquals(revoked.status, 404);
  assertEquals((await revoked.json()).code, 'published_lcia_unavailable');
  assertEquals(databaseCalls, [0, 60_000]);
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
