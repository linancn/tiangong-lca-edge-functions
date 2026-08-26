import { assert, assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert';

import type { HybridSearchQuery } from '../supabase/functions/_shared/hybrid_query_utils.ts';
import {
  type PortalHybridModelCache,
  type PortalHybridSearchRequest,
  type PortalPublicHybridCandidatePage,
} from '../supabase/functions/_shared/portal_hybrid_contract.ts';
import type { PortalHybridSecurityEvent } from '../supabase/functions/_shared/portal_hybrid_security_event.ts';
import {
  createPortalHybridRepository,
  PortalHybridRepositoryError,
  type PortalHybridRepository,
} from '../supabase/functions/_shared/portal_hybrid_repository.ts';
import {
  buildPortalHmacCanonical,
  computePortalBodyHash,
  encodeBase64Url,
  type PortalHmacKeyring,
} from '../supabase/functions/_shared/portal_hmac.ts';
import {
  PORTAL_ATOMIC_GUARD_LUA,
  PORTAL_HYBRID_CIRCUIT_CHECK_LUA,
  PORTAL_HYBRID_CIRCUIT_FAILURE_LUA,
  PORTAL_HYBRID_CIRCUIT_SUCCESS_LUA,
} from '../supabase/functions/_shared/portal_redis_guard.ts';
import type { PortalRedisAdapter } from '../supabase/functions/_shared/redis_client.ts';
import {
  createPortalHybridSearchHandler,
  isPortalHybridEnabled,
  PORTAL_HYBRID_FUNCTION_PATH,
  PORTAL_HYBRID_RUNTIME_PATH,
} from '../supabase/functions/portal_hybrid_search_v1/index.ts';

const NOW_SECONDS = 1_800_000_000;
const SECRET = Uint8Array.from({ length: 32 }, (_value, index) => index + 17);
const KEYRING: PortalHmacKeyring = {
  current: { keyId: 'portal-hybrid-current', secret: SECRET },
};
const TRUSTED_PUBLISHABLE_KEY = 'sb_publishable_portal_hybrid';
const PROCESS_ID = '11111111-1111-4111-8111-111111111111';
const CORRELATION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const VECTOR = Array.from({ length: 1_024 }, () => 0.001);
const REQUEST: PortalHybridSearchRequest = {
  schemaVersion: 'portal.hybrid-search-request.v1',
  kind: 'process',
  query: 'private low-carbon steel query',
  filters: { accessLevel: 'open', geography: 'CN' },
  limit: 10,
};
const GUARD_LIMITS = {
  minuteBudget: 10,
  dailyBudget: 100,
  maxConcurrency: 2,
  leaseTtlSeconds: 20,
  cacheTtlSeconds: 60,
};
const CIRCUIT_LIMITS = {
  failureThreshold: 3,
  failureWindowSeconds: 60,
  openSeconds: 60,
};
const REWRITE: HybridSearchQuery = {
  semantic_query_en: 'low-carbon steel production',
  fulltext_query_en: ['steel production'],
  fulltext_query_zh: ['钢铁生产'],
};

function databasePage(): PortalPublicHybridCandidatePage {
  return {
    schemaVersion: 'portal.public-hybrid-candidate-page.v1',
    kind: 'process',
    queryFingerprint: 'a'.repeat(64),
    items: [
      {
        key: { kind: 'process', id: PROCESS_ID, version: '01.00.000' },
        accessLevel: 'open',
        capabilities: {
          metadataVisible: true,
          exchangesVisible: true,
          lciaVisible: false,
          publicArtifactVisible: false,
          citationVisible: true,
          policyVersion: 'portal-public-policy-v1',
          reasonCodes: ['published_metadata'],
        },
        names: [{ language: 'en', value: 'Steel production' }],
        summary: [{ language: 'en', value: 'Public summary' }],
        geography: {
          code: 'CN',
          label: [{ language: 'en', value: 'China' }],
          precision: 'country',
        },
        referenceYear: 2025,
        modifiedAt: '2026-08-26T00:00:00Z',
        match: {
          kind: 'hybrid',
          algorithmVersion: 'portal-hybrid-rank-v1',
          score: 0.9,
          reasonCodes: ['lexical_public_projection', 'semantic_public_projection'],
          evidence: { lexicalRank: 1, semanticRank: 2, semanticDistance: '0.125' },
        },
      },
    ],
  };
}

class FakePortalRedis implements PortalRedisAdapter {
  readonly namespace = 'portal:test:v1';
  replay = false;
  outage = false;
  guardStatus: 'admitted' | 'budget_exhausted' | 'concurrency_exhausted' = 'admitted';
  circuitOpen = false;
  cached: string | null = null;
  cacheWriteFails = false;
  readonly calls: string[] = [];
  readonly cacheWrites: string[] = [];

  setNxEx(): Promise<boolean> {
    this.calls.push('nonce');
    if (this.outage) return Promise.reject(new Error('private redis provider details'));
    return Promise.resolve(!this.replay);
  }

  eval(script: string, _keys: string[], args: string[]): Promise<unknown> {
    if (this.outage) return Promise.reject(new Error('private redis provider details'));
    if (script === PORTAL_ATOMIC_GUARD_LUA) {
      this.calls.push('guard');
      if (this.guardStatus === 'budget_exhausted') return Promise.resolve([1, 0, 0, 1, 0]);
      if (this.guardStatus === 'concurrency_exhausted') {
        return Promise.resolve([2, 1, 1, 0, 0]);
      }
      return Promise.resolve([0, 9, 99, 1, 0]);
    }
    if (script === PORTAL_HYBRID_CIRCUIT_CHECK_LUA) {
      this.calls.push('circuit_check');
      return Promise.resolve(this.circuitOpen ? [1, Number(args[0]) + 60_000] : [0, 0]);
    }
    if (script === PORTAL_HYBRID_CIRCUIT_FAILURE_LUA) {
      this.calls.push('circuit_failure');
      return Promise.resolve([0, 1, 0]);
    }
    if (script === PORTAL_HYBRID_CIRCUIT_SUCCESS_LUA) {
      this.calls.push('circuit_success');
      return Promise.resolve(1);
    }
    this.calls.push('lease_release');
    return Promise.resolve(1);
  }

  get(): Promise<string | null> {
    this.calls.push('cache_get');
    if (this.outage) return Promise.reject(new Error('private redis provider details'));
    return Promise.resolve(this.cached);
  }

  setEx(_key: string, value: string): Promise<void> {
    this.calls.push('cache_set');
    if (this.cacheWriteFails) return Promise.reject(new Error('private redis provider details'));
    this.cacheWrites.push(value);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.calls.push('close');
    return Promise.resolve();
  }
}

async function hmacSignature(secret: Uint8Array, canonical: string): Promise<string> {
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

let nonceSeed = 0;
async function signedRequest(
  options: {
    payload?: unknown;
    rawBody?: string;
    signedBody?: string;
    actualPath?: string;
    signedPath?: string;
    method?: string;
    timestamp?: number;
    keyId?: string;
    secret?: Uint8Array;
    badSignature?: boolean;
    apiKey?: string | null;
    cookie?: string;
    authorization?: string;
    correlationId?: string;
  } = {},
): Promise<Request> {
  const rawBody =
    options.rawBody ?? JSON.stringify(options.payload === undefined ? REQUEST : options.payload);
  const signedBody = options.signedBody ?? rawBody;
  const keyId = options.keyId ?? KEYRING.current.keyId;
  const timestamp = options.timestamp ?? NOW_SECONDS;
  const nonceBytes = new Uint8Array(16);
  nonceBytes.fill((++nonceSeed % 251) + 1);
  const nonce = encodeBase64Url(nonceBytes);
  const bodyHash = encodeBase64Url(
    await computePortalBodyHash(new TextEncoder().encode(signedBody)),
  );
  const canonical = buildPortalHmacCanonical({
    keyId,
    timestamp: String(timestamp),
    nonce,
    method: 'POST',
    functionPath: options.signedPath ?? PORTAL_HYBRID_FUNCTION_PATH,
    bodyHash,
  });
  const signature = await hmacSignature(options.secret ?? SECRET, canonical);
  const headers = new Headers({
    'Content-Type': 'application/json',
    'x-portal-key-id': keyId,
    'x-portal-timestamp': String(timestamp),
    'x-portal-nonce': nonce,
    'x-portal-body-sha256': bodyHash,
    'x-portal-signature': options.badSignature ? `A${signature.slice(1)}` : signature,
  });
  if (options.apiKey !== null) headers.set('apikey', options.apiKey ?? TRUSTED_PUBLISHABLE_KEY);
  if (options.cookie) headers.set('cookie', options.cookie);
  if (options.authorization) headers.set('authorization', options.authorization);
  if (options.correlationId) headers.set('x-portal-correlation-id', options.correlationId);
  const method = options.method ?? 'POST';
  return new Request(`http://localhost${options.actualPath ?? PORTAL_HYBRID_FUNCTION_PATH}`, {
    method,
    headers,
    body: method === 'POST' ? rawBody : undefined,
  });
}

function handlerOptions(
  redis: FakePortalRedis,
  repository: PortalHybridRepository,
  overrides: Record<string, unknown> = {},
) {
  return {
    keyring: KEYRING,
    redis,
    guardLimits: GUARD_LIMITS,
    circuitLimits: CIRCUIT_LIMITS,
    repository,
    rewriteQuery: async () => REWRITE,
    generateEmbedding: async () => VECTOR,
    enabled: true,
    nowSeconds: () => NOW_SECONDS,
    nowMillis: () => NOW_SECONDS * 1_000,
    timeoutMs: 1_000,
    redisTimeoutMs: 100,
    trustedPublishableKey: TRUSTED_PUBLISHABLE_KEY,
    trustedLegacyAnonKey: null,
    logger: () => undefined,
    ...overrides,
  };
}

async function responseCode(response: Response): Promise<string | null> {
  const payload = (await response.json()) as { code?: string };
  return payload.code ?? null;
}

Deno.test(
  'signed Portal Hybrid success is advisory, public-only, correlated, and no-CORS',
  async () => {
    const redis = new FakePortalRedis();
    const repositoryCalls: Array<{
      request: unknown;
      terms: string[];
      embedding: number[];
      signal: AbortSignal;
    }> = [];
    const events: PortalHybridSecurityEvent[] = [];
    const repository: PortalHybridRepository = {
      query(request, terms, embedding, signal) {
        repositoryCalls.push({ request, terms, embedding, signal });
        return Promise.resolve(databasePage());
      },
    };
    let rewriteSignal: AbortSignal | undefined;
    let embeddingSignal: AbortSignal | undefined;
    const handler = createPortalHybridSearchHandler(
      handlerOptions(redis, repository, {
        rewriteQuery: async (_config: unknown, _query: string, signal: AbortSignal) => {
          rewriteSignal = signal;
          return REWRITE;
        },
        generateEmbedding: async (_query: string, signal: AbortSignal) => {
          embeddingSignal = signal;
          return VECTOR;
        },
        logger: (event: PortalHybridSecurityEvent) => events.push(event),
      }),
    );
    const response = await handler(await signedRequest({ correlationId: CORRELATION_ID }));
    const text = await response.text();
    const payload = JSON.parse(text);

    assertEquals(response.status, 200);
    assertEquals(response.headers.get('x-portal-correlation-id'), CORRELATION_ID);
    assertEquals(response.headers.get('x-portal-cache'), 'miss');
    assertEquals(response.headers.get('access-control-allow-origin'), null);
    assertEquals(payload.schemaVersion, 'portal.hybrid-search-page.v1');
    assertEquals(payload.kind, 'process');
    assertEquals(payload.queryFingerprint, 'a'.repeat(64));
    assertEquals(payload.interpretation.source, 'model_generated');
    assertEquals(payload.interpretation.advisory, true);
    assertEquals(payload.items, databasePage().items);
    assertEquals(text.includes(REQUEST.query), false);
    assertEquals(Object.hasOwn(payload, 'fallbackReason'), false);
    assertEquals(Object.hasOwn(payload, 'lexicalResults'), false);
    assertEquals(repositoryCalls.length, 1);
    assertEquals((repositoryCalls[0].request as typeof REQUEST).filters.geography, 'cn');
    assert(repositoryCalls[0].terms.length <= 12);
    assertEquals(repositoryCalls[0].embedding.length, 1_024);
    assertEquals(repositoryCalls[0].signal, rewriteSignal);
    assertEquals(repositoryCalls[0].signal, embeddingSignal);
    assertEquals(repositoryCalls[0].signal.aborted, false);
    assertEquals(events.length, 1);
    assertEquals(events[0].correlationId, CORRELATION_ID);
    assertEquals(events[0].model, 'called');
    assertEquals(events[0].database, 'called');
    assertEquals(events[0].items, 1);
    assertEquals(redis.cacheWrites.length, 1);
    assertEquals(redis.cacheWrites[0].includes(PROCESS_ID), false);
    assertEquals(redis.cacheWrites[0].includes(REQUEST.query), false);
    assert(redis.calls.includes('lease_release'));
  },
);

Deno.test(
  'Portal Hybrid repository calls only the exact api façade with a publishable key',
  async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const signal = new AbortController().signal;
    const repository = createPortalHybridRepository({
      supabaseUrl: 'https://example.supabase.co',
      publishableKey: TRUSTED_PUBLISHABLE_KEY,
      fetchImpl: (input, init) => {
        capturedUrl = String(input);
        capturedInit = init;
        return Promise.resolve(Response.json(databasePage()));
      },
    });
    const parsedRequest: PortalHybridSearchRequest = {
      ...REQUEST,
      filters: { accessLevel: 'open', geography: 'cn' },
    };
    const result = await repository.query(parsedRequest, ['steel', '钢铁'], VECTOR, signal);

    assertEquals(result, databasePage());
    assertEquals(capturedUrl, 'https://example.supabase.co/rest/v1/rpc/portal_hybrid_search_v1');
    assertEquals(capturedInit?.method, 'POST');
    const headers = new Headers(capturedInit?.headers);
    assertEquals(headers.get('apikey'), TRUSTED_PUBLISHABLE_KEY);
    assertEquals(headers.get('content-profile'), 'api');
    assertEquals(headers.get('authorization'), null);
    assertEquals(capturedInit?.signal, signal);
    assertEquals(JSON.parse(String(capturedInit?.body)), {
      p_kind: 'process',
      p_query_terms: ['steel', '钢铁'],
      p_query_embedding: `[${VECTOR.join(',')}]`,
      p_filters: { accessLevel: 'open', geography: 'cn' },
      p_limit: 10,
    });

    for (const credential of [
      'sb_secret_forbidden',
      `${btoa('{"alg":"none"}')}.${btoa('{"role":"service_role"}')}.AA`,
    ]) {
      await assertRejects(async () => {
        const invalid = createPortalHybridRepository({
          supabaseUrl: 'https://example.supabase.co',
          publishableKey: credential,
        });
        await invalid.query(parsedRequest, ['steel'], VECTOR, signal);
      });
    }
  },
);

Deno.test('Portal Hybrid repository rejects private or malformed database DTOs', async () => {
  const privatePage = structuredClone(databasePage()) as unknown as Record<string, unknown>;
  (privatePage.items as Array<Record<string, unknown>>)[0].team_id = 'private-team';
  const repository = createPortalHybridRepository({
    supabaseUrl: 'https://example.supabase.co',
    publishableKey: TRUSTED_PUBLISHABLE_KEY,
    fetchImpl: () => Promise.resolve(Response.json(privatePage)),
  });
  const error = await assertRejects(() =>
    repository.query(REQUEST, ['steel'], VECTOR, new AbortController().signal),
  );
  assertEquals((error as PortalHybridRepositoryError).code, 'contract_failure');
});

Deno.test(
  'Portal Hybrid rejects HMAC failures before Redis, JSON, model, or database',
  async () => {
    for (const request of [
      await signedRequest({ badSignature: true, rawBody: '{bad json' }),
      await signedRequest({
        signedBody: JSON.stringify(REQUEST),
        rawBody: JSON.stringify({ ...REQUEST, limit: 9 }),
      }),
      await signedRequest({ timestamp: NOW_SECONDS - 61 }),
      await signedRequest({ keyId: 'unknown-key' }),
      await signedRequest({ signedPath: '/functions/v1/portal_data_product_results_v1' }),
    ]) {
      const redis = new FakePortalRedis();
      let modelCalls = 0;
      let databaseCalls = 0;
      const handler = createPortalHybridSearchHandler(
        handlerOptions(
          redis,
          {
            query() {
              databaseCalls += 1;
              return Promise.resolve(databasePage());
            },
          },
          {
            rewriteQuery: async () => {
              modelCalls += 1;
              return REWRITE;
            },
          },
        ),
      );
      const response = await handler(request);
      assertEquals(response.status, 401);
      assertEquals(await responseCode(response), 'portal_auth_failed');
      assertEquals(redis.calls, []);
      assertEquals(modelCalls, 0);
      assertEquals(databaseCalls, 0);
    }
  },
);

Deno.test('Portal Hybrid accepts only exact public and CLI-stripped runtime paths', async () => {
  for (const actualPath of [PORTAL_HYBRID_FUNCTION_PATH, PORTAL_HYBRID_RUNTIME_PATH]) {
    const redis = new FakePortalRedis();
    const handler = createPortalHybridSearchHandler(
      handlerOptions(redis, { query: () => Promise.resolve(databasePage()) }),
    );
    const response = await handler(await signedRequest({ actualPath }));
    assertEquals(response.status, 200);
  }
  const redis = new FakePortalRedis();
  const handler = createPortalHybridSearchHandler(
    handlerOptions(redis, { query: () => Promise.resolve(databasePage()) }),
  );
  const response = await handler(
    await signedRequest({ actualPath: `${PORTAL_HYBRID_FUNCTION_PATH}/suffix` }),
  );
  assertEquals(response.status, 401);
  assertEquals(redis.calls, []);
});

Deno.test(
  'Portal Hybrid exact-false kill switch rejects before Redis, model, or database',
  async () => {
    assertEquals(isPortalHybridEnabled({ get: () => undefined }), false);
    assertEquals(isPortalHybridEnabled({ get: () => 'TRUE' }), false);
    assertEquals(isPortalHybridEnabled({ get: () => ' true ' }), false);
    assertEquals(isPortalHybridEnabled({ get: () => 'true' }), true);

    const redis = new FakePortalRedis();
    let modelCalls = 0;
    let databaseCalls = 0;
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query() {
            databaseCalls += 1;
            return Promise.resolve(databasePage());
          },
        },
        {
          enabled: false,
          rewriteQuery: async () => {
            modelCalls += 1;
            return REWRITE;
          },
        },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 503);
    assertEquals(await responseCode(response), 'hybrid_disabled');
    assertEquals(redis.calls, []);
    assertEquals(modelCalls, 0);
    assertEquals(databaseCalls, 0);
  },
);

Deno.test('Portal Hybrid public transport rejects Cookie before Redis or cost', async () => {
  const redis = new FakePortalRedis();
  let modelCalls = 0;
  let databaseCalls = 0;
  const handler = createPortalHybridSearchHandler(
    handlerOptions(
      redis,
      {
        query() {
          databaseCalls += 1;
          return Promise.resolve(databasePage());
        },
      },
      {
        rewriteQuery: async () => {
          modelCalls += 1;
          return REWRITE;
        },
      },
    ),
  );
  const response = await handler(await signedRequest({ cookie: 'session=private' }));
  assertEquals(response.status, 401);
  assertEquals(await responseCode(response), 'portal_auth_failed');
  assertEquals(redis.calls, []);
  assertEquals(modelCalls, 0);
  assertEquals(databaseCalls, 0);
});

Deno.test(
  'Portal Hybrid replay, Redis, budget, concurrency, and circuit failures make zero cost calls',
  async () => {
    const cases: Array<{
      configure: (redis: FakePortalRedis) => void;
      status: number;
      code: string;
    }> = [
      { configure: (redis) => (redis.replay = true), status: 403, code: 'replay_rejected' },
      { configure: (redis) => (redis.outage = true), status: 503, code: 'guard_unavailable' },
      {
        configure: (redis) => (redis.guardStatus = 'budget_exhausted'),
        status: 429,
        code: 'budget_exhausted',
      },
      {
        configure: (redis) => (redis.guardStatus = 'concurrency_exhausted'),
        status: 429,
        code: 'concurrency_exhausted',
      },
      { configure: (redis) => (redis.circuitOpen = true), status: 503, code: 'circuit_open' },
    ];
    for (const testCase of cases) {
      const redis = new FakePortalRedis();
      testCase.configure(redis);
      let modelCalls = 0;
      let databaseCalls = 0;
      const handler = createPortalHybridSearchHandler(
        handlerOptions(
          redis,
          {
            query() {
              databaseCalls += 1;
              return Promise.resolve(databasePage());
            },
          },
          {
            rewriteQuery: async () => {
              modelCalls += 1;
              return REWRITE;
            },
          },
        ),
      );
      const response = await handler(await signedRequest());
      assertEquals(response.status, testCase.status);
      assertEquals(await responseCode(response), testCase.code);
      assertEquals(modelCalls, 0);
      assertEquals(databaseCalls, 0);
    }
  },
);

Deno.test(
  'Portal Hybrid parses JSON only after admission and rejects every extra field before model',
  async () => {
    for (const rawBody of [
      '{bad json',
      JSON.stringify({ ...REQUEST, data_source: 'tg' }),
      JSON.stringify({ ...REQUEST, cursor: 'forbidden' }),
      JSON.stringify({ ...REQUEST, kind: 'flow', filters: { processSubtype: 'unit' } }),
    ]) {
      const redis = new FakePortalRedis();
      let modelCalls = 0;
      let databaseCalls = 0;
      const handler = createPortalHybridSearchHandler(
        handlerOptions(
          redis,
          {
            query() {
              databaseCalls += 1;
              return Promise.resolve(databasePage());
            },
          },
          {
            rewriteQuery: async () => {
              modelCalls += 1;
              return REWRITE;
            },
          },
        ),
      );
      const response = await handler(await signedRequest({ rawBody }));
      assertEquals(response.status, 400);
      assertEquals(await responseCode(response), 'invalid_request');
      assert(redis.calls.includes('guard'));
      assertEquals(modelCalls, 0);
      assertEquals(databaseCalls, 0);
    }
  },
);

Deno.test(
  'Portal Hybrid model cache skips models but never skips the public database façade',
  async () => {
    const redis = new FakePortalRedis();
    const cache: PortalHybridModelCache = {
      schemaVersion: 'portal.hybrid-model-cache.v1',
      interpretation: {
        source: 'model_generated',
        advisory: true,
        semanticQuery: 'steel production',
        terms: [{ language: 'en', value: 'steel' }],
      },
      queryTerms: ['steel'],
      queryEmbedding: VECTOR,
    };
    redis.cached = JSON.stringify(cache);
    let databaseCalls = 0;
    const events: PortalHybridSecurityEvent[] = [];
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query() {
            databaseCalls += 1;
            return Promise.resolve(databasePage());
          },
        },
        {
          rewriteQuery: () => Promise.reject(new Error('must not call rewrite')),
          generateEmbedding: () => Promise.reject(new Error('must not call embedding')),
          logger: (event: PortalHybridSecurityEvent) => events.push(event),
        },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 200);
    assertEquals(response.headers.get('x-portal-cache'), 'hit');
    assertEquals(databaseCalls, 1);
    assertEquals(events[0].model, 'cache_hit');
  },
);

Deno.test(
  'Portal Hybrid malformed cache fails contract without model or database fallback',
  async () => {
    const redis = new FakePortalRedis();
    redis.cached = '{"schemaVersion":"portal.hybrid-model-cache.v1","query":"private"}';
    let modelCalls = 0;
    let databaseCalls = 0;
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query() {
            databaseCalls += 1;
            return Promise.resolve(databasePage());
          },
        },
        {
          rewriteQuery: async () => {
            modelCalls += 1;
            return REWRITE;
          },
        },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 503);
    assertEquals(await responseCode(response), 'contract_failure');
    assertEquals(modelCalls, 0);
    assertEquals(databaseCalls, 0);
    assert(redis.calls.includes('circuit_failure'));
  },
);

Deno.test(
  'Portal Hybrid model failure and invalid embedding are fixed circuit failures',
  async () => {
    for (const testCase of [
      {
        rewriteQuery: () => Promise.reject(new Error('private provider details')),
        generateEmbedding: async () => VECTOR,
        code: 'hybrid_upstream_unavailable',
      },
      {
        rewriteQuery: async () => REWRITE,
        generateEmbedding: async () => [0.1, 0.2],
        code: 'contract_failure',
      },
    ]) {
      const redis = new FakePortalRedis();
      let databaseCalls = 0;
      const handler = createPortalHybridSearchHandler(
        handlerOptions(
          redis,
          {
            query() {
              databaseCalls += 1;
              return Promise.resolve(databasePage());
            },
          },
          testCase,
        ),
      );
      const response = await handler(await signedRequest());
      assertEquals(response.status, 503);
      assertEquals(await responseCode(response), testCase.code);
      assertEquals(databaseCalls, 0);
      assert(redis.calls.includes('circuit_failure'));
    }
  },
);

Deno.test(
  'Portal Hybrid total timeout aborts the SageMaker stage and never calls database',
  async () => {
    const redis = new FakePortalRedis();
    let embeddingSignal: AbortSignal | undefined;
    let databaseCalls = 0;
    const events: PortalHybridSecurityEvent[] = [];
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        {
          query() {
            databaseCalls += 1;
            return Promise.resolve(databasePage());
          },
        },
        {
          timeoutMs: 100,
          generateEmbedding: (_query: string, signal: AbortSignal) => {
            embeddingSignal = signal;
            return new Promise((_resolve, reject) => {
              signal.addEventListener(
                'abort',
                () => reject(new DOMException('aborted', 'AbortError')),
                {
                  once: true,
                },
              );
            });
          },
          logger: (event: PortalHybridSecurityEvent) => events.push(event),
        },
      ),
    );
    const response = await handler(await signedRequest());
    assertEquals(response.status, 503);
    assertEquals(await responseCode(response), 'hybrid_timeout');
    assertEquals(embeddingSignal?.aborted, true);
    assertEquals(databaseCalls, 0);
    assertEquals(events[0].model, 'aborted');
  },
);

Deno.test(
  'Portal Hybrid database contract drift never leaks or falls back to raw Hybrid RPC',
  async () => {
    const redis = new FakePortalRedis();
    const invalid = structuredClone(databasePage()) as unknown as Record<string, unknown>;
    (invalid.items as Array<Record<string, unknown>>)[0].owner_id = 'private-owner';
    const handler = createPortalHybridSearchHandler(
      handlerOptions(redis, {
        query: () => Promise.resolve(invalid as unknown as PortalPublicHybridCandidatePage),
      }),
    );
    const response = await handler(await signedRequest());
    const body = await response.text();
    assertEquals(response.status, 503);
    assertStringIncludes(body, 'contract_failure');
    assertEquals(body.includes('private-owner'), false);
    assert(redis.calls.includes('circuit_failure'));
  },
);

Deno.test(
  'Portal Hybrid emits exactly one event and a never-resolving logger cannot delay',
  async () => {
    const redis = new FakePortalRedis();
    let loggerCalls = 0;
    const handler = createPortalHybridSearchHandler(
      handlerOptions(
        redis,
        { query: () => Promise.resolve(databasePage()) },
        {
          logger: () => {
            loggerCalls += 1;
            return new Promise<void>(() => undefined);
          },
        },
      ),
    );
    const result = await Promise.race([
      handler(await signedRequest()).then((response) => response.status),
      new Promise<number>((resolve) => setTimeout(() => resolve(599), 250)),
    ]);
    assertEquals(result, 200);
    assertEquals(loggerCalls, 1);
  },
);
