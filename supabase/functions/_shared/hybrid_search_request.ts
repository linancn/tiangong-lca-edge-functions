export class HybridSearchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HybridSearchRequestError';
  }
}

export interface HybridSearchClientRequest {
  queryText: string;
  rpcOptions: HybridSearchRpcOptions;
}

export interface HybridSearchRpcOptions {
  filter_condition: string;
  match_threshold: number;
  match_count: number;
  full_text_weight: number;
  extracted_text_weight: number;
  semantic_weight: number;
  rrf_k: number;
  data_source: string;
  page_size: number;
  page_current: number;
}

export interface HybridSearchRpcRequest extends HybridSearchRpcOptions {
  query_text: string;
  query_embedding: string;
}

const VALID_DATA_SOURCES = new Set(['tg', 'co', 'my', 'te']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseNumber(value: unknown, fieldName: string, fallback: number): number {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;

  if (!Number.isFinite(parsed)) {
    throw new HybridSearchRequestError(`${fieldName} must be a finite number`);
  }

  return parsed;
}

function parsePositiveInteger(value: unknown, fieldName: string, fallback: number): number {
  const parsed = parseNumber(value, fieldName, fallback);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HybridSearchRequestError(`${fieldName} must be a positive integer`);
  }

  return parsed;
}

function parseNonNegativeNumber(value: unknown, fieldName: string, fallback: number): number {
  const parsed = parseNumber(value, fieldName, fallback);

  if (parsed < 0) {
    throw new HybridSearchRequestError(`${fieldName} must be greater than or equal to 0`);
  }

  return parsed;
}

function parseMatchThreshold(value: unknown): number {
  const parsed = parseNumber(value, 'match_threshold', 0.5);

  if (parsed < 0 || parsed > 1) {
    throw new HybridSearchRequestError('match_threshold must be between 0 and 1');
  }

  return parsed;
}

function parseDataSource(value: unknown): string {
  const dataSource = value === undefined || value === null || value === '' ? 'tg' : String(value);

  if (!VALID_DATA_SOURCES.has(dataSource)) {
    throw new HybridSearchRequestError('data_source must be one of tg, co, my, or te');
  }

  return dataSource;
}

function normalizeFilterCondition(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    return '{}';
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return '{}';
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (!isRecord(parsed)) {
        throw new HybridSearchRequestError('filter_condition must be a JSON object');
      }
      return JSON.stringify(parsed);
    } catch (error) {
      if (error instanceof HybridSearchRequestError) {
        throw error;
      }
      throw new HybridSearchRequestError('filter_condition must be a valid JSON object string');
    }
  }

  if (!isRecord(value)) {
    throw new HybridSearchRequestError('filter_condition must be a JSON object');
  }

  return JSON.stringify(value);
}

export function parseHybridSearchClientRequest(body: unknown): HybridSearchClientRequest {
  if (!isRecord(body)) {
    throw new HybridSearchRequestError('request body must be a JSON object');
  }

  const query = body.query;
  if (query === undefined || query === null || query === '') {
    throw new HybridSearchRequestError('Missing query');
  }

  const queryText = typeof query === 'string' ? query.trim() : String(query).trim();
  if (!queryText) {
    throw new HybridSearchRequestError('Missing query');
  }

  const filterInput = body.filter_condition ?? body.filter;

  return {
    queryText,
    rpcOptions: {
      filter_condition: normalizeFilterCondition(filterInput),
      match_threshold: parseMatchThreshold(body.match_threshold),
      match_count: parsePositiveInteger(body.match_count, 'match_count', 20),
      full_text_weight: parseNonNegativeNumber(body.full_text_weight, 'full_text_weight', 0.3),
      extracted_text_weight: parseNonNegativeNumber(
        body.extracted_text_weight,
        'extracted_text_weight',
        0.2,
      ),
      semantic_weight: parseNonNegativeNumber(body.semantic_weight, 'semantic_weight', 0.5),
      rrf_k: parsePositiveInteger(body.rrf_k, 'rrf_k', 10),
      data_source: parseDataSource(body.data_source),
      page_size: parsePositiveInteger(body.page_size, 'page_size', 10),
      page_current: parsePositiveInteger(body.page_current, 'page_current', 1),
    },
  };
}

export function buildHybridSearchRpcRequest(
  queryText: string,
  queryEmbedding: string,
  options: HybridSearchRpcOptions,
): HybridSearchRpcRequest {
  return {
    query_text: queryText,
    query_embedding: queryEmbedding,
    ...options,
  };
}
