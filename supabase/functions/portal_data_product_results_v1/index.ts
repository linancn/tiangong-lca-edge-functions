import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { z } from 'zod';

import {
  constantTimeEqual,
  decodeCanonicalBase64Url,
  loadPortalHmacKeyring,
  PortalHmacError,
  type PortalHmacKeyring,
  verifyPortalHmacRequest,
} from '../_shared/portal_hmac.ts';
import {
  readPortalLciaGuardLimits,
  readPortalResponseCache,
  redisEvalAtomicGuard,
  registerPortalNonce,
  releasePortalConcurrencyLease,
  type PortalRouteGuardLimits,
  writePortalResponseCache,
} from '../_shared/portal_redis_guard.ts';
import {
  createPortalRedisAdapter,
  type PortalRedisAdapter,
  PortalRedisError,
} from '../_shared/redis_client.ts';
import { getSupabasePublishableKey, getSupabaseUrl } from '../_shared/supabase_client.ts';

export const PORTAL_LCIA_FUNCTION_NAME = 'portal_data_product_results_v1';
export const PORTAL_LCIA_FUNCTION_PATH = `/functions/v1/${PORTAL_LCIA_FUNCTION_NAME}`;
export const PORTAL_LCIA_RUNTIME_PATH = `/${PORTAL_LCIA_FUNCTION_NAME}`;
export const PORTAL_LCIA_MAX_REQUEST_BYTES = 32 * 1024;
export const PORTAL_LCIA_MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 8_000;

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const versionSchema = z.string().regex(/^\d{2}\.\d{2}\.\d{3}$/u);
const realSchema = z
  .string()
  .regex(/^(?=(?:[^0-9]*[0-9]){1,38}[^0-9]*$)(?:0|-?(?:[1-9]\d*(?:\.\d*[1-9])?|0\.\d*[1-9]))$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const nonEmptyStringSchema = z.string().min(1);
const localizedTextSchema = z.array(
  z
    .object({
      language: z
        .string()
        .min(2)
        .max(35)
        .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u),
      value: z.string(),
    })
    .strict(),
);
const processRefSchema = z.object({ id: uuidSchema, version: versionSchema }).strict();
const requestCursorSchema = z.string().min(1).max(4096).nullable().optional().default(null);
const requestLimitSchema = z.number().int().min(1).max(50).optional().default(50);

function uniqueProcessReferences(value: Array<{ id: string; version: string }>): boolean {
  return new Set(value.map((item) => `${item.id}@${item.version}`)).size === value.length;
}

export const portalPublishedLciaRequestSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('process_all_impacts'),
      processRefs: z.array(processRefSchema).length(1).refine(uniqueProcessReferences),
      impactCategoryId: z.null(),
      cursor: requestCursorSchema,
      limit: requestLimitSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('processes_one_impact'),
      processRefs: z.array(processRefSchema).min(1).max(50).refine(uniqueProcessReferences),
      impactCategoryId: z.string().trim().min(1).max(512),
      cursor: requestCursorSchema,
      limit: requestLimitSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal('ranked_processes_one_impact'),
      processRefs: z.array(processRefSchema).min(1).max(50).refine(uniqueProcessReferences),
      impactCategoryId: z.string().trim().min(1).max(512),
      cursor: requestCursorSchema,
      limit: requestLimitSchema,
    })
    .strict(),
]);

export type PortalPublishedLciaRequest = z.infer<typeof portalPublishedLciaRequestSchema>;

const exactIdentitySchema = z.object({ id: uuidSchema, version: versionSchema }).strict();
const portalPublishedLciaRowSchema = z
  .object({
    process: exactIdentitySchema,
    functionalUnit: z
      .object({
        amount: realSchema,
        unit: nonEmptyStringSchema,
        description: localizedTextSchema,
      })
      .strict(),
    geography: z
      .object({
        code: nonEmptyStringSchema,
        precision: z.enum(['country', 'province', 'city', 'other', 'unknown']),
      })
      .strict(),
    referenceYear: z.number().int().min(0).max(9999),
    method: exactIdentitySchema,
    impact: z.object({ id: nonEmptyStringSchema, name: localizedTextSchema }).strict(),
    value: realSchema,
    unit: nonEmptyStringSchema,
    evidenceStatus: z.literal('verified'),
  })
  .strict();

export const portalPublishedLciaPageSchema = z
  .object({
    schemaVersion: z.literal('portal.published-lcia-page.v1'),
    mode: z.enum(['process_all_impacts', 'processes_one_impact', 'ranked_processes_one_impact']),
    publication: z
      .object({
        publicationId: uuidSchema,
        packageId: uuidSchema,
        packageVersion: nonEmptyStringSchema,
        publishedAt: z.string().datetime({ offset: true }),
        evidenceHash: sha256Schema,
      })
      .strict(),
    rows: z.array(portalPublishedLciaRowSchema).max(50),
    nextCursor: z.string().min(1).max(4096).nullable(),
  })
  .strict();

export type PortalPublishedLciaPage = z.infer<typeof portalPublishedLciaPageSchema>;

export interface PortalPublishedLciaRepository {
  query(
    request: PortalPublishedLciaRequest,
    signal: AbortSignal,
  ): Promise<PortalPublishedLciaPage | null>;
}

export class PortalPublishedLciaUpstreamError extends Error {
  constructor() {
    super('published_lcia_upstream_unavailable');
    this.name = 'PortalPublishedLciaUpstreamError';
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function validatePortalSupabaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (_error) {
    throw new PortalPublishedLciaUpstreamError();
  }
  const secureRemote = url.protocol === 'https:';
  const loopback =
    isLoopbackHostname(url.hostname) && (url.protocol === 'http:' || url.protocol === 'https:');
  if (
    (!secureRemote && !loopback) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new PortalPublishedLciaUpstreamError();
  }
  return url.origin;
}

function decodeJwtPayload(value: string): Record<string, unknown> | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const decodedParts = parts.map(decodeCanonicalBase64Url);
  if (decodedParts.some((part) => part === null)) return null;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodedParts[1]!));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (_error) {
    return null;
  }
}

export function validatePortalPublishableCredential(value: string): string {
  const credential = value.trim();
  if (
    credential.length < 1 ||
    credential.length > 4096 ||
    /[\r\n]/u.test(value) ||
    /^sb_secret_/iu.test(credential)
  ) {
    throw new PortalPublishedLciaUpstreamError();
  }
  if (credential.startsWith('sb_publishable_')) return credential;
  if (credential.split('.').length === 3) {
    const payload = decodeJwtPayload(credential);
    if (!payload || payload.role !== 'anon') {
      throw new PortalPublishedLciaUpstreamError();
    }
    return credential;
  }
  throw new PortalPublishedLciaUpstreamError();
}

export type PortalTransportErrorCode =
  | 'portal_transport_config_invalid'
  | 'portal_apikey_missing'
  | 'portal_apikey_invalid'
  | 'portal_apikey_mismatch'
  | 'portal_authorization_invalid';

export class PortalTransportError extends Error {
  constructor(readonly code: PortalTransportErrorCode) {
    super(code);
    this.name = 'PortalTransportError';
  }
}

function validatePortalLegacyAnonCredential(value: string): string {
  const credential = value.trim();
  if (credential.startsWith('sb_publishable_')) {
    throw new PortalPublishedLciaUpstreamError();
  }
  return validatePortalPublishableCredential(value);
}

function constantTimeStringEqual(left: string, right: string): boolean {
  return constantTimeEqual(new TextEncoder().encode(left), new TextEncoder().encode(right));
}

export function readPortalLegacyAnonCredential(
  env: Pick<typeof Deno.env, 'get'> = Deno.env,
): string | null {
  const configured =
    env.get('REMOTE_SUPABASE_ANON_KEY')?.trim() || env.get('SUPABASE_ANON_KEY')?.trim();
  if (!configured) return null;
  try {
    return validatePortalLegacyAnonCredential(configured);
  } catch (_error) {
    throw new PortalTransportError('portal_transport_config_invalid');
  }
}

export function validatePortalInboundTransport(input: {
  request: Request;
  trustedPublishableKey: string;
  trustedLegacyAnonKey?: string | null;
}): void {
  let trustedPublishableKey: string;
  try {
    trustedPublishableKey = validatePortalPublishableCredential(input.trustedPublishableKey);
  } catch (_error) {
    throw new PortalTransportError('portal_transport_config_invalid');
  }

  const inboundApiKey = input.request.headers.get('apikey');
  if (inboundApiKey === null || inboundApiKey.length === 0) {
    throw new PortalTransportError('portal_apikey_missing');
  }
  let validatedInboundApiKey: string;
  try {
    validatedInboundApiKey = validatePortalPublishableCredential(inboundApiKey);
  } catch (_error) {
    throw new PortalTransportError('portal_apikey_invalid');
  }
  if (!constantTimeStringEqual(validatedInboundApiKey, trustedPublishableKey)) {
    throw new PortalTransportError('portal_apikey_mismatch');
  }

  const authorization = input.request.headers.get('authorization');
  if (authorization === null) return;
  if (!input.trustedLegacyAnonKey) {
    throw new PortalTransportError('portal_authorization_invalid');
  }
  let trustedLegacyAnonKey: string;
  try {
    trustedLegacyAnonKey = validatePortalLegacyAnonCredential(input.trustedLegacyAnonKey);
  } catch (_error) {
    throw new PortalTransportError('portal_transport_config_invalid');
  }
  if (!constantTimeStringEqual(authorization, `Bearer ${trustedLegacyAnonKey}`)) {
    throw new PortalTransportError('portal_authorization_invalid');
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new RangeError('body_too_large');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readPortalRawBody(
  request: Request,
  maximumBytes = PORTAL_LCIA_MAX_REQUEST_BYTES,
): Promise<Uint8Array> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maximumBytes) {
    throw new RangeError('body_too_large');
  }
  return await readBoundedStream(request.body, maximumBytes);
}

function upstreamTimeoutFromEnvironment(): number {
  const value = Deno.env.get('PORTAL_LCIA_UPSTREAM_TIMEOUT_MS')?.trim();
  if (!value) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  if (!/^\d+$/u.test(value)) throw new PortalPublishedLciaUpstreamError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > DEFAULT_UPSTREAM_TIMEOUT_MS) {
    throw new PortalPublishedLciaUpstreamError();
  }
  return parsed;
}

async function readBoundedResponseJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > PORTAL_LCIA_MAX_RESPONSE_BYTES
  ) {
    throw new PortalPublishedLciaUpstreamError();
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedStream(response.body, PORTAL_LCIA_MAX_RESPONSE_BYTES);
  } catch (_error) {
    throw new PortalPublishedLciaUpstreamError();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_error) {
    throw new PortalPublishedLciaUpstreamError();
  }
}

export function createPortalPublishedLciaRepository(
  options: {
    supabaseUrl?: string;
    publishableKey?: string;
    fetchImpl?: typeof fetch;
  } = {},
): PortalPublishedLciaRepository {
  const supabaseUrl = validatePortalSupabaseUrl(options.supabaseUrl ?? getSupabaseUrl());
  const publishableKey = validatePortalPublishableCredential(
    options.publishableKey ?? getSupabasePublishableKey(),
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async query(request, signal) {
      const response = await fetchImpl(
        `${supabaseUrl}/rest/v1/rpc/portal_get_published_lcia_values_v1`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            apikey: publishableKey,
            'Content-Profile': 'api',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            p_mode: request.mode,
            p_process_refs: request.processRefs,
            p_impact_ref: request.impactCategoryId,
            p_cursor: request.cursor,
            p_limit: request.limit,
          }),
          signal,
        },
      ).catch(() => {
        throw new PortalPublishedLciaUpstreamError();
      });
      if (!response.ok) throw new PortalPublishedLciaUpstreamError();
      const value = await readBoundedResponseJson(response);
      if (value === null) return null;
      const parsed = portalPublishedLciaPageSchema.safeParse(value);
      if (!parsed.success || parsed.data.mode !== request.mode) {
        throw new PortalPublishedLciaUpstreamError();
      }
      return parsed.data;
    },
  };
}

type PortalDataProductResultsHandlerOptions = {
  keyring?: PortalHmacKeyring;
  redis?: PortalRedisAdapter;
  redisFactory?: () => Promise<PortalRedisAdapter>;
  guardLimits?: PortalRouteGuardLimits;
  repository?: PortalPublishedLciaRepository;
  nowSeconds?: () => number;
  nowMillis?: () => number;
  upstreamTimeoutMs?: number;
  trustedPublishableKey?: string;
  trustedLegacyAnonKey?: string | null;
};

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

function errorResponse(status: number, code: string, message: string): Response {
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

export function createPortalDataProductResultsHandler(
  options: PortalDataProductResultsHandlerOptions = {},
) {
  return async (request: Request): Promise<Response> => {
    let rawBody: Uint8Array;
    try {
      rawBody = await readPortalRawBody(request);
    } catch (_error) {
      return errorResponse(413, 'request_too_large', 'Request body exceeds the allowed size');
    }

    let verification;
    try {
      verification = await verifyPortalHmacRequest({
        request,
        rawBody,
        expectedFunctionPath: PORTAL_LCIA_FUNCTION_PATH,
        allowedRequestPaths: [PORTAL_LCIA_FUNCTION_PATH, PORTAL_LCIA_RUNTIME_PATH],
        keyring: options.keyring ?? loadPortalHmacKeyring(),
        nowSeconds: options.nowSeconds?.(),
      });
    } catch (error) {
      return authFailure(error);
    }

    try {
      validatePortalInboundTransport({
        request,
        trustedPublishableKey: options.trustedPublishableKey ?? getSupabasePublishableKey(),
        trustedLegacyAnonKey:
          options.trustedLegacyAnonKey === undefined
            ? readPortalLegacyAnonCredential()
            : options.trustedLegacyAnonKey,
      });
    } catch (error) {
      if (
        error instanceof PortalTransportError &&
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

    let redis: PortalRedisAdapter;
    let ownsRedis = false;
    try {
      redis = options.redis ?? (await (options.redisFactory ?? createPortalRedisAdapter)());
      ownsRedis = options.redis === undefined;
    } catch (_error) {
      return errorResponse(503, 'guard_unavailable', 'Portal request guard unavailable');
    }

    let leaseId: string | undefined;
    try {
      const nonceRegistered = await registerPortalNonce(
        { keyId: verification.keyId, nonce: verification.nonce },
        redis,
      );
      if (!nonceRegistered) {
        return errorResponse(403, 'replay_rejected', 'Portal request replay rejected');
      }

      const guard = await redisEvalAtomicGuard(
        {
          route: PORTAL_LCIA_FUNCTION_NAME,
          limits: options.guardLimits ?? readPortalLciaGuardLimits(),
          nowMillis: options.nowMillis?.(),
        },
        redis,
      );
      if (guard.status === 'budget_exhausted') {
        return errorResponse(429, 'budget_exhausted', 'Portal route budget exhausted');
      }
      if (guard.status === 'concurrency_exhausted') {
        return errorResponse(429, 'concurrency_exhausted', 'Portal route concurrency exhausted');
      }
      if (!('leaseId' in guard)) {
        return errorResponse(503, 'guard_unavailable', 'Portal request guard unavailable');
      }
      leaseId = guard.leaseId;

      let requestPayload: unknown;
      try {
        requestPayload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
      } catch (_error) {
        return errorResponse(400, 'invalid_request', 'Invalid Portal LCIA request');
      }
      const parsedRequest = portalPublishedLciaRequestSchema.safeParse(requestPayload);
      if (!parsedRequest.success) {
        return errorResponse(400, 'invalid_request', 'Invalid Portal LCIA request');
      }

      let cached: string | null;
      try {
        cached = await readPortalResponseCache(
          { route: PORTAL_LCIA_FUNCTION_NAME, bodyHash: verification.bodyHash },
          redis,
        );
      } catch (_error) {
        return errorResponse(503, 'guard_unavailable', 'Portal request guard unavailable');
      }
      if (cached !== null) {
        try {
          const parsedCached = portalPublishedLciaPageSchema.safeParse(JSON.parse(cached));
          if (parsedCached.success && parsedCached.data.mode === parsedRequest.data.mode) {
            return jsonResponse(200, parsedCached.data, { 'X-Portal-Cache': 'hit' });
          }
        } catch (_error) {
          // A malformed cache entry is treated as an unavailable security dependency below.
        }
        return errorResponse(503, 'guard_unavailable', 'Portal request guard unavailable');
      }

      const timeoutMs = options.upstreamTimeoutMs ?? upstreamTimeoutFromEnvironment();
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 8_000) {
        return errorResponse(
          503,
          'published_lcia_unavailable',
          'Published LCIA results unavailable',
        );
      }
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
      let page: PortalPublishedLciaPage | null;
      try {
        page = await (options.repository ?? createPortalPublishedLciaRepository()).query(
          parsedRequest.data,
          abortController.signal,
        );
      } catch (_error) {
        return errorResponse(
          503,
          'published_lcia_unavailable',
          'Published LCIA results unavailable',
        );
      } finally {
        clearTimeout(timeoutId);
      }
      if (page === null) {
        return errorResponse(
          404,
          'published_lcia_unavailable',
          'Published LCIA results unavailable',
        );
      }
      const parsedPage = portalPublishedLciaPageSchema.safeParse(page);
      if (!parsedPage.success || parsedPage.data.mode !== parsedRequest.data.mode) {
        return errorResponse(
          503,
          'published_lcia_unavailable',
          'Published LCIA results unavailable',
        );
      }
      const serialized = JSON.stringify(parsedPage.data);
      if (new TextEncoder().encode(serialized).byteLength > PORTAL_LCIA_MAX_RESPONSE_BYTES) {
        return errorResponse(
          503,
          'published_lcia_unavailable',
          'Published LCIA results unavailable',
        );
      }
      try {
        await writePortalResponseCache(
          {
            route: PORTAL_LCIA_FUNCTION_NAME,
            bodyHash: verification.bodyHash,
            value: serialized,
            ttlSeconds: (options.guardLimits ?? readPortalLciaGuardLimits()).cacheTtlSeconds,
          },
          redis,
        );
      } catch (_error) {
        // Admission already succeeded. A best-effort cache write never widens database authority.
      }
      return jsonResponse(200, parsedPage.data, { 'X-Portal-Cache': 'miss' });
    } catch (error) {
      if (error instanceof PortalRedisError) {
        return errorResponse(503, 'guard_unavailable', 'Portal request guard unavailable');
      }
      return errorResponse(503, 'published_lcia_unavailable', 'Published LCIA results unavailable');
    } finally {
      if (leaseId) {
        await releasePortalConcurrencyLease(
          { route: PORTAL_LCIA_FUNCTION_NAME, leaseId },
          redis,
        ).catch(() => undefined);
      }
      if (ownsRedis) await redis.close().catch(() => undefined);
    }
  };
}

export const handlePortalDataProductResults = createPortalDataProductResultsHandler();

if (import.meta.main) {
  Deno.serve(handlePortalDataProductResults);
}
