import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { extractEmbeddingVector } from '../_shared/embedding_vector.ts';
import {
  generateHybridSearchEmbedding,
  rewriteHybridSearchQuery,
  type HybridSearchKernelConfig,
} from '../_shared/hybrid_search_kernel.ts';
import {
  buildHybridFulltextQueryTerms,
  sanitizeHybridQueryOutput,
  type HybridSearchQuery,
} from '../_shared/hybrid_query_utils.ts';
import {
  portalHybridModelCacheSchema,
  portalHybridSearchPageSchema,
  portalHybridSearchRequestSchema,
  type PortalHybridInterpretation,
  type PortalHybridModelCache,
  type PortalHybridSearchPage,
  type PortalHybridSearchRequest,
} from '../_shared/portal_hybrid_contract.ts';
import {
  defaultPortalHybridSecurityLogger,
  emitPortalHybridSecurityEvent,
  normalizePortalHybridErrorCode,
  portalHybridHmacOutcome,
  portalHybridTransportOutcome,
  resolvePortalCorrelationId,
  type PortalHybridErrorCode,
  type PortalHybridSecurityEvent,
  type PortalHybridSecurityLogger,
} from '../_shared/portal_hybrid_security_event.ts';
import {
  createPortalHybridRepository,
  PortalHybridRepositoryError,
  PORTAL_HYBRID_MAX_RESPONSE_BYTES,
  type PortalHybridRepository,
} from '../_shared/portal_hybrid_repository.ts';
import {
  loadPortalHmacKeyring,
  PortalHmacError,
  type PortalHmacKeyring,
  verifyPortalHmacRequest,
} from '../_shared/portal_hmac.ts';
import {
  checkPortalHybridCircuit,
  readPortalHybridCircuitLimits,
  readPortalHybridGuardLimits,
  readPortalHybridTotalTimeoutMs,
  readPortalResponseCache,
  recordPortalHybridCircuitFailure,
  recordPortalHybridCircuitSuccess,
  redisEvalAtomicGuard,
  registerPortalNonce,
  releasePortalConcurrencyLease,
  type PortalGuardTiming,
  type PortalHybridCircuitLimits,
  type PortalRouteGuardLimits,
  validatePortalHybridGuardLimits,
  writePortalResponseCache,
} from '../_shared/portal_redis_guard.ts';
import {
  PortalTransportError,
  readPortalLegacyAnonCredential,
  readPortalRawBody,
  validatePortalInboundTransport,
  validatePortalPublishableCredential,
} from '../_shared/portal_public_transport.ts';
import {
  createPortalRedisAdapter,
  type PortalRedisAdapter,
  PortalRedisError,
  readPortalRedisTimeoutMs,
} from '../_shared/redis_client.ts';
import { getSupabasePublishableKey } from '../_shared/supabase_client.ts';

export const PORTAL_HYBRID_FUNCTION_NAME = 'portal_hybrid_search_v1';
export const PORTAL_HYBRID_FUNCTION_PATH = `/functions/v1/${PORTAL_HYBRID_FUNCTION_NAME}`;
export const PORTAL_HYBRID_RUNTIME_PATH = `/${PORTAL_HYBRID_FUNCTION_NAME}`;
export const PORTAL_HYBRID_MAX_REQUEST_BYTES = 32 * 1024;

type PortalHybridHandlerOptions = {
  keyring?: PortalHmacKeyring;
  redis?: PortalRedisAdapter;
  redisFactory?: () => Promise<PortalRedisAdapter>;
  guardLimits?: PortalRouteGuardLimits;
  circuitLimits?: PortalHybridCircuitLimits;
  repository?: PortalHybridRepository;
  repositoryFactory?: (trustedPublishableKey: string) => PortalHybridRepository;
  rewriteQuery?: (
    config: HybridSearchKernelConfig,
    query: string,
    signal: AbortSignal,
  ) => Promise<HybridSearchQuery>;
  generateEmbedding?: (semanticQuery: string, signal: AbortSignal) => Promise<number[]>;
  enabled?: boolean;
  nowSeconds?: () => number;
  nowMillis?: () => number;
  timeoutMs?: number;
  redisTimeoutMs?: number;
  trustedPublishableKey?: string;
  trustedLegacyAnonKey?: string | null;
  deploymentSha?: string;
  logger?: PortalHybridSecurityLogger;
  monotonicNow?: () => number;
};

type MutableHybridEventState = Pick<
  PortalHybridSecurityEvent,
  | 'kind'
  | 'cache'
  | 'hmacOutcome'
  | 'transportOutcome'
  | 'guardOutcome'
  | 'circuit'
  | 'model'
  | 'database'
  | 'items'
  | 'matchedKey'
  | 'recoveredLeaseCount'
>;

export function isPortalHybridEnabled(env: Pick<typeof Deno.env, 'get'> = Deno.env): boolean {
  return env.get('PORTAL_HYBRID_ENABLED') === 'true';
}

function jsonResponse(status: number, payload: unknown, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function errorResponse(status: number, code: PortalHybridErrorCode, message: string): Response {
  return jsonResponse(status, { code, message });
}

function authFailure(error: unknown): Response {
  if (error instanceof PortalHmacError && error.code === 'portal_hmac_config_invalid') {
    return errorResponse(
      503,
      'portal_auth_unavailable',
      'Portal request authentication unavailable',
    );
  }
  if (error instanceof PortalHmacError && error.code === 'portal_hmac_method_invalid') {
    return errorResponse(405, 'method_not_allowed', 'Only POST is supported');
  }
  return errorResponse(401, 'portal_auth_failed', 'Portal request authentication failed');
}

function validateCircuitLimits(limits: PortalHybridCircuitLimits): PortalHybridCircuitLimits {
  const bounded = (value: number, minimum: number, maximum: number) =>
    Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  if (
    !bounded(limits.failureThreshold, 1, 100) ||
    !bounded(limits.failureWindowSeconds, 1, 3_600) ||
    !bounded(limits.openSeconds, 1, 3_600)
  ) {
    throw new PortalRedisError();
  }
  return limits;
}

function buildKernelConfig(kind: PortalHybridSearchRequest['kind']): HybridSearchKernelConfig {
  return {
    functionName: PORTAL_HYBRID_FUNCTION_NAME,
    entityLabel: kind === 'process' ? 'Process' : 'Flow',
    entityPlural: kind === 'process' ? 'processes' : 'flows',
  };
}

function uniqueInterpretationTerms(
  normalized: HybridSearchQuery,
): PortalHybridInterpretation['terms'] {
  const values: PortalHybridInterpretation['terms'] = [];
  const seen = new Set<string>();
  for (const [language, terms] of [
    ['en', normalized.fulltext_query_en],
    ['zh-CN', normalized.fulltext_query_zh],
  ] as const) {
    for (const value of terms) {
      const key = `${language}\u0000${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      values.push({ language, value });
    }
  }
  if (values.length === 0 && normalized.semantic_query_en) {
    values.push({ language: 'en', value: normalized.semantic_query_en });
  }
  return values.slice(0, 12);
}

function buildModelCache(
  rawRewrite: HybridSearchQuery,
  request: PortalHybridSearchRequest,
  embedding: number[],
): PortalHybridModelCache {
  const modelOnly = sanitizeHybridQueryOutput(rawRewrite, '');
  const retrieval = sanitizeHybridQueryOutput(rawRewrite, request.query);
  if (!modelOnly.semantic_query_en || !retrieval.semantic_query_en) {
    throw new PortalHybridRepositoryError('contract_failure');
  }
  const queryTerms = buildHybridFulltextQueryTerms(modelOnly).slice(0, 12);
  const candidate = {
    schemaVersion: 'portal.hybrid-model-cache.v1' as const,
    interpretation: {
      source: 'model_generated' as const,
      advisory: true as const,
      semanticQuery: modelOnly.semantic_query_en,
      terms: uniqueInterpretationTerms(modelOnly),
    },
    queryTerms,
    queryEmbedding: extractEmbeddingVector(embedding),
  };
  const parsed = portalHybridModelCacheSchema.safeParse(candidate);
  if (!parsed.success) throw new PortalHybridRepositoryError('contract_failure');
  return parsed.data;
}

function retrievalTermsFromModelCache(cache: PortalHybridModelCache, query: string): string[] {
  const normalizedModelQuery: HybridSearchQuery = {
    semantic_query_en: cache.interpretation.semanticQuery,
    fulltext_query_en: cache.interpretation.terms
      .filter((term) => term.language === 'en')
      .map((term) => term.value),
    fulltext_query_zh: cache.interpretation.terms
      .filter((term) => term.language === 'zh-CN')
      .map((term) => term.value),
  };
  return buildHybridFulltextQueryTerms(
    sanitizeHybridQueryOutput(normalizedModelQuery, query),
  ).slice(0, 12);
}

async function responseErrorCode(response: Response): Promise<PortalHybridErrorCode | null> {
  if (response.status < 400) return null;
  try {
    const payload = await response.clone().json();
    return normalizePortalHybridErrorCode(
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>).code : null,
    );
  } catch (_error) {
    return 'internal_error';
  }
}

export function createPortalHybridSearchHandler(options: PortalHybridHandlerOptions = {}) {
  return async (request: Request): Promise<Response> => {
    const monotonicNow = () => {
      try {
        const value = options.monotonicNow?.() ?? performance.now();
        return Number.isFinite(value) ? value : 0;
      } catch (_error) {
        return 0;
      }
    };
    const startedAt = monotonicNow();
    const correlationId = resolvePortalCorrelationId(request.headers);
    const event: MutableHybridEventState = {
      kind: null,
      cache: 'not_checked',
      hmacOutcome: 'not_checked',
      transportOutcome: 'not_checked',
      guardOutcome: 'not_checked',
      circuit: 'not_checked',
      model: 'not_called',
      database: 'not_called',
      items: null,
      matchedKey: null,
      recoveredLeaseCount: 0,
    };

    const execute = async (): Promise<Response> => {
      let rawBody: Uint8Array;
      try {
        rawBody = await readPortalRawBody(request, PORTAL_HYBRID_MAX_REQUEST_BYTES);
      } catch (_error) {
        return errorResponse(413, 'request_too_large', 'Request body exceeds the allowed size');
      }

      let verification;
      try {
        verification = await verifyPortalHmacRequest({
          request,
          rawBody,
          expectedFunctionPath: PORTAL_HYBRID_FUNCTION_PATH,
          allowedRequestPaths: [PORTAL_HYBRID_FUNCTION_PATH, PORTAL_HYBRID_RUNTIME_PATH],
          keyring: options.keyring ?? loadPortalHmacKeyring(),
          nowSeconds: options.nowSeconds?.(),
        });
        event.hmacOutcome = 'accepted';
        event.matchedKey = verification.matchedKey;
      } catch (error) {
        event.hmacOutcome = portalHybridHmacOutcome(error);
        return authFailure(error);
      }

      let trustedPublishableKey: string;
      try {
        trustedPublishableKey = validatePortalPublishableCredential(
          options.trustedPublishableKey ?? getSupabasePublishableKey(),
        );
        validatePortalInboundTransport({
          request,
          trustedPublishableKey,
          trustedLegacyAnonKey:
            options.trustedLegacyAnonKey === undefined
              ? readPortalLegacyAnonCredential()
              : options.trustedLegacyAnonKey,
        });
        event.transportOutcome = 'accepted';
      } catch (error) {
        event.transportOutcome = portalHybridTransportOutcome(error);
        if (
          !(error instanceof PortalTransportError) ||
          error.code === 'portal_transport_config_invalid'
        ) {
          return errorResponse(
            503,
            'portal_auth_unavailable',
            'Portal request authentication unavailable',
          );
        }
        return errorResponse(401, 'portal_auth_failed', 'Portal request authentication failed');
      }

      if (!(options.enabled ?? isPortalHybridEnabled())) {
        return errorResponse(503, 'hybrid_disabled', 'Portal Hybrid search is disabled');
      }

      let timeoutMs: number;
      let guardLimits: PortalRouteGuardLimits;
      let circuitLimits: PortalHybridCircuitLimits;
      try {
        timeoutMs = options.timeoutMs ?? readPortalHybridTotalTimeoutMs();
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 8_000) {
          throw new PortalRedisError();
        }
        const timing: PortalGuardTiming = {
          redisTimeoutMs: options.redisTimeoutMs ?? readPortalRedisTimeoutMs(),
          upstreamTimeoutMs: timeoutMs,
        };
        guardLimits = options.guardLimits
          ? validatePortalHybridGuardLimits(options.guardLimits, timing)
          : readPortalHybridGuardLimits(Deno.env, timing);
        circuitLimits = options.circuitLimits
          ? validateCircuitLimits(options.circuitLimits)
          : readPortalHybridCircuitLimits();
      } catch (_error) {
        event.guardOutcome = 'unavailable';
        return errorResponse(503, 'guard_unavailable', 'Portal request guard unavailable');
      }

      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
      const wallNow = () => options.nowMillis?.() ?? Date.now();
      let redis: PortalRedisAdapter;
      let ownsRedis = false;
      try {
        redis = options.redis ?? (await (options.redisFactory ?? createPortalRedisAdapter)());
        ownsRedis = options.redis === undefined;
      } catch (_error) {
        clearTimeout(timeoutId);
        event.guardOutcome = 'unavailable';
        return errorResponse(503, 'guard_unavailable', 'Portal request guard unavailable');
      }

      let leaseId: string | undefined;
      const recordFailure = async () => {
        try {
          await recordPortalHybridCircuitFailure(
            { route: PORTAL_HYBRID_FUNCTION_NAME, limits: circuitLimits, nowMillis: wallNow() },
            redis,
          );
          event.circuit = 'failure_recorded';
        } catch (_error) {
          event.circuit = 'record_failed';
        }
      };

      try {
        const nonceRegistered = await registerPortalNonce(
          { keyId: verification.keyId, nonce: verification.nonce },
          redis,
        );
        if (!nonceRegistered) {
          event.guardOutcome = 'replay_rejected';
          return errorResponse(403, 'replay_rejected', 'Portal request replay rejected');
        }

        const guard = await redisEvalAtomicGuard(
          {
            route: PORTAL_HYBRID_FUNCTION_NAME,
            limits: guardLimits,
            nowMillis: wallNow(),
          },
          redis,
        );
        event.recoveredLeaseCount = guard.recoveredLeaseCount;
        if (guard.status === 'budget_exhausted') {
          event.guardOutcome = 'budget_exhausted';
          return errorResponse(429, 'budget_exhausted', 'Portal route budget exhausted');
        }
        if (guard.status === 'concurrency_exhausted') {
          event.guardOutcome = 'concurrency_exhausted';
          return errorResponse(429, 'concurrency_exhausted', 'Portal route concurrency exhausted');
        }
        if (!('leaseId' in guard)) throw new PortalRedisError();
        leaseId = guard.leaseId;
        event.guardOutcome = 'admitted';

        if (abortController.signal.aborted) {
          return errorResponse(503, 'hybrid_timeout', 'Portal Hybrid search timed out');
        }

        const circuit = await checkPortalHybridCircuit(
          { route: PORTAL_HYBRID_FUNCTION_NAME, nowMillis: wallNow() },
          redis,
        );
        if (circuit.status === 'open') {
          event.circuit = 'open';
          return errorResponse(503, 'circuit_open', 'Portal Hybrid circuit is open');
        }
        event.circuit = 'closed';

        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
        } catch (_error) {
          return errorResponse(400, 'invalid_request', 'Invalid Portal Hybrid request');
        }
        const parsedRequest = portalHybridSearchRequestSchema.safeParse(payload);
        if (!parsedRequest.success) {
          return errorResponse(400, 'invalid_request', 'Invalid Portal Hybrid request');
        }
        const hybridRequest = parsedRequest.data;
        event.kind = hybridRequest.kind;

        let modelCache: PortalHybridModelCache;
        let cached: string | null;
        try {
          cached = await readPortalResponseCache(
            { route: PORTAL_HYBRID_FUNCTION_NAME, bodyHash: verification.bodyHash },
            redis,
          );
        } catch (_error) {
          event.cache = 'invalid';
          event.guardOutcome = 'unavailable';
          return errorResponse(503, 'guard_unavailable', 'Portal request guard unavailable');
        }
        if (cached !== null) {
          let parsedCache;
          try {
            parsedCache = portalHybridModelCacheSchema.safeParse(JSON.parse(cached));
          } catch (_error) {
            parsedCache = { success: false } as const;
          }
          if (!parsedCache.success) {
            event.cache = 'invalid';
            await recordFailure();
            return errorResponse(503, 'contract_failure', 'Portal Hybrid contract unavailable');
          }
          event.cache = 'hit';
          event.model = 'cache_hit';
          modelCache = parsedCache.data;
        } else {
          event.cache = 'miss';
          let rawRewrite: HybridSearchQuery;
          event.model = 'called';
          try {
            rawRewrite = await (options.rewriteQuery ?? rewriteHybridSearchQuery)(
              buildKernelConfig(hybridRequest.kind),
              hybridRequest.query,
              abortController.signal,
            );
          } catch (_error) {
            event.model = abortController.signal.aborted ? 'aborted' : 'failed';
            await recordFailure();
            return abortController.signal.aborted
              ? errorResponse(503, 'hybrid_timeout', 'Portal Hybrid search timed out')
              : errorResponse(
                  503,
                  'hybrid_upstream_unavailable',
                  'Portal Hybrid search unavailable',
                );
          }

          const modelOnly = sanitizeHybridQueryOutput(rawRewrite, '');
          if (!modelOnly.semantic_query_en) {
            event.model = 'failed';
            await recordFailure();
            return errorResponse(503, 'contract_failure', 'Portal Hybrid contract unavailable');
          }

          let embedding: number[];
          try {
            embedding = await (options.generateEmbedding ?? generateHybridSearchEmbedding)(
              modelOnly.semantic_query_en,
              abortController.signal,
            );
            modelCache = buildModelCache(rawRewrite, hybridRequest, embedding);
          } catch (error) {
            event.model = abortController.signal.aborted ? 'aborted' : 'failed';
            await recordFailure();
            if (abortController.signal.aborted) {
              return errorResponse(503, 'hybrid_timeout', 'Portal Hybrid search timed out');
            }
            if (error instanceof PortalHybridRepositoryError && error.code === 'contract_failure') {
              return errorResponse(503, 'contract_failure', 'Portal Hybrid contract unavailable');
            }
            const code =
              typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : null;
            return code === 'EMBEDDING_VECTOR_MISSING' || code === 'EMBEDDING_DIMENSION_MISMATCH'
              ? errorResponse(503, 'contract_failure', 'Portal Hybrid contract unavailable')
              : errorResponse(
                  503,
                  'hybrid_upstream_unavailable',
                  'Portal Hybrid search unavailable',
                );
          }

          try {
            await writePortalResponseCache(
              {
                route: PORTAL_HYBRID_FUNCTION_NAME,
                bodyHash: verification.bodyHash,
                value: JSON.stringify(modelCache),
                ttlSeconds: guardLimits.cacheTtlSeconds,
              },
              redis,
            );
          } catch (_error) {
            event.cache = 'write_failed';
          }
        }

        if (abortController.signal.aborted) {
          event.model = event.model === 'called' ? 'aborted' : event.model;
          await recordFailure();
          return errorResponse(503, 'hybrid_timeout', 'Portal Hybrid search timed out');
        }

        const queryTerms = retrievalTermsFromModelCache(modelCache, hybridRequest.query);

        let databasePage;
        try {
          const repository =
            options.repository ??
            options.repositoryFactory?.(trustedPublishableKey) ??
            createPortalHybridRepository({ publishableKey: trustedPublishableKey });
          event.database = 'called';
          databasePage = await repository.query(
            hybridRequest,
            queryTerms,
            modelCache.queryEmbedding,
            abortController.signal,
          );
        } catch (error) {
          if (abortController.signal.aborted) {
            event.database = 'failed';
            await recordFailure();
            return errorResponse(503, 'hybrid_timeout', 'Portal Hybrid search timed out');
          }
          const contractFailure =
            error instanceof PortalHybridRepositoryError && error.code === 'contract_failure';
          event.database = contractFailure ? 'contract_failed' : 'failed';
          await recordFailure();
          return contractFailure
            ? errorResponse(503, 'contract_failure', 'Portal Hybrid contract unavailable')
            : errorResponse(503, 'hybrid_upstream_unavailable', 'Portal Hybrid search unavailable');
        }

        const edgePage: PortalHybridSearchPage = {
          schemaVersion: 'portal.hybrid-search-page.v1',
          kind: databasePage.kind,
          queryFingerprint: databasePage.queryFingerprint,
          interpretation: modelCache.interpretation,
          items: databasePage.items,
        };
        const parsedPage = portalHybridSearchPageSchema.safeParse(edgePage);
        if (!parsedPage.success || parsedPage.data.kind !== hybridRequest.kind) {
          event.database = 'contract_failed';
          await recordFailure();
          return errorResponse(503, 'contract_failure', 'Portal Hybrid contract unavailable');
        }
        const serialized = JSON.stringify(parsedPage.data);
        if (new TextEncoder().encode(serialized).byteLength > PORTAL_HYBRID_MAX_RESPONSE_BYTES) {
          event.database = 'contract_failed';
          await recordFailure();
          return errorResponse(503, 'contract_failure', 'Portal Hybrid contract unavailable');
        }

        try {
          await recordPortalHybridCircuitSuccess({ route: PORTAL_HYBRID_FUNCTION_NAME }, redis);
        } catch (_error) {
          event.circuit = 'reset_failed';
        }
        event.items = parsedPage.data.items.length;
        return jsonResponse(200, parsedPage.data, {
          'X-Portal-Cache': event.cache === 'hit' ? 'hit' : 'miss',
        });
      } catch (error) {
        if (error instanceof PortalRedisError) {
          event.guardOutcome = 'unavailable';
          return errorResponse(503, 'guard_unavailable', 'Portal request guard unavailable');
        }
        return errorResponse(503, 'internal_error', 'Portal Hybrid search unavailable');
      } finally {
        clearTimeout(timeoutId);
        if (leaseId) {
          await releasePortalConcurrencyLease(
            { route: PORTAL_HYBRID_FUNCTION_NAME, leaseId },
            redis,
          ).catch(() => undefined);
        }
        if (ownsRedis) await redis.close().catch(() => undefined);
      }
    };

    let response: Response;
    try {
      response = await execute();
    } catch (_error) {
      response = errorResponse(503, 'internal_error', 'Portal Hybrid search unavailable');
    }
    response.headers.set('X-Portal-Correlation-Id', correlationId);
    emitPortalHybridSecurityEvent(options.logger ?? defaultPortalHybridSecurityLogger, {
      correlationId,
      ...event,
      latencyMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
      status: response.status,
      errorCode: await responseErrorCode(response),
      deploymentSha: options.deploymentSha ?? Deno.env.get('PORTAL_DEPLOYMENT_SHA') ?? 'unknown',
    });
    return response;
  };
}

export const handlePortalHybridSearch = createPortalHybridSearchHandler();

if (import.meta.main) {
  Deno.serve(handlePortalHybridSearch);
}
