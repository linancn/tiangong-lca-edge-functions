import {
  portalPublicHybridCandidatePageSchema,
  type PortalHybridSearchRequest,
  type PortalPublicHybridCandidatePage,
} from './portal_hybrid_contract.ts';
import {
  readPortalBoundedStream,
  validatePortalPublishableCredential,
  validatePortalSupabaseUrl,
} from './portal_public_transport.ts';
import { getSupabasePublishableKey, getSupabaseUrl } from './supabase_client.ts';

export const PORTAL_HYBRID_MAX_RESPONSE_BYTES = 512 * 1024;

export type PortalHybridRepositoryErrorCode = 'hybrid_upstream_unavailable' | 'contract_failure';

export class PortalHybridRepositoryError extends Error {
  constructor(readonly code: PortalHybridRepositoryErrorCode) {
    super(code);
    this.name = 'PortalHybridRepositoryError';
  }
}

export interface PortalHybridRepository {
  query(
    request: PortalHybridSearchRequest,
    queryTerms: string[],
    queryEmbedding: number[],
    signal: AbortSignal,
  ): Promise<PortalPublicHybridCandidatePage>;
}

export function serializePortalHybridEmbedding(queryEmbedding: number[]): string {
  if (
    queryEmbedding.length !== 1_024 ||
    !queryEmbedding.every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    throw new PortalHybridRepositoryError('contract_failure');
  }
  return `[${queryEmbedding.join(',')}]`;
}

async function readRepositoryResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > PORTAL_HYBRID_MAX_RESPONSE_BYTES
  ) {
    throw new PortalHybridRepositoryError('contract_failure');
  }
  let bytes: Uint8Array;
  try {
    bytes = await readPortalBoundedStream(response.body, PORTAL_HYBRID_MAX_RESPONSE_BYTES);
  } catch (_error) {
    throw new PortalHybridRepositoryError('contract_failure');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_error) {
    throw new PortalHybridRepositoryError('contract_failure');
  }
}

export function createPortalHybridRepository(
  options: {
    supabaseUrl?: string;
    publishableKey?: string;
    fetchImpl?: typeof fetch;
  } = {},
): PortalHybridRepository {
  let supabaseUrl: string;
  let publishableKey: string;
  try {
    supabaseUrl = validatePortalSupabaseUrl(options.supabaseUrl ?? getSupabaseUrl());
    publishableKey = validatePortalPublishableCredential(
      options.publishableKey ?? getSupabasePublishableKey(),
    );
  } catch (_error) {
    throw new PortalHybridRepositoryError('hybrid_upstream_unavailable');
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async query(request, queryTerms, queryEmbedding, signal) {
      const response = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/portal_hybrid_search_v1`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          apikey: publishableKey,
          'Content-Profile': 'api',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          p_kind: request.kind,
          p_query_terms: queryTerms,
          p_query_embedding: serializePortalHybridEmbedding(queryEmbedding),
          p_filters: request.filters,
          p_limit: request.limit,
        }),
        signal,
      }).catch(() => {
        throw new PortalHybridRepositoryError('hybrid_upstream_unavailable');
      });
      if (!response.ok) {
        throw new PortalHybridRepositoryError('hybrid_upstream_unavailable');
      }
      const value = await readRepositoryResponse(response);
      const parsed = portalPublicHybridCandidatePageSchema.safeParse(value);
      if (!parsed.success || parsed.data.kind !== request.kind) {
        throw new PortalHybridRepositoryError('contract_failure');
      }
      return parsed.data;
    },
  };
}
