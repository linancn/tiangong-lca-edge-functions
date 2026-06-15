import '@supabase/functions-js/edge-runtime.d.ts';

import { InvokeEndpointCommand, SageMakerRuntimeClient } from '@aws-sdk/client-sagemaker-runtime';
import { authenticateRequest, AuthMethod } from '../_shared/auth.ts';
import { corsHeaders } from '../_shared/cors.ts';
import {
  buildHybridFulltextQueryTerms,
  HYBRID_SYNONYM_RULES,
  hybridQuerySchema,
  HybridSearchQuery,
  sanitizeHybridQueryOutput,
} from '../_shared/hybrid_query_utils.ts';
import {
  buildHybridSearchRpcRequest,
  parseHybridSearchClientRequest,
} from '../_shared/hybrid_search_request.ts';
import {
  createHybridSearchRpcClient,
  HybridSearchRpcContextError,
  type HybridSearchRpcClientContext,
} from '../_shared/hybrid_search_rpc_context.ts';
import { openaiStructuredOutput } from '../_shared/openai_structured.ts';
import { getRedisClient } from '../_shared/redis_client.ts';
import { supabaseAuthClient } from '../_shared/supabase_client.ts';
const openai_chat_model = Deno.env.get('OPENAI_CHAT_MODEL') ?? 'gpt-4.1-mini';
const SAGEMAKER_ENDPOINT_NAME = Deno.env.get('SAGEMAKER_ENDPOINT_NAME');
const AWS_REGION = 'us-east-1';
const AWS_ACCESS_KEY_ID = Deno.env.get('AWS_ACCESS_KEY_ID');
const AWS_SECRET_ACCESS_KEY = Deno.env.get('AWS_SECRET_ACCESS_KEY');
const AWS_SESSION_TOKEN = Deno.env.get('AWS_SESSION_TOKEN');
const textDecoder = new TextDecoder();

let sagemakerClient: SageMakerRuntimeClient | undefined;

function getSageMakerClient() {
  if (!sagemakerClient) {
    sagemakerClient = new SageMakerRuntimeClient({
      region: AWS_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey: AWS_SECRET_ACCESS_KEY ?? '',
        sessionToken: AWS_SESSION_TOKEN ?? undefined,
      },
    });
  }

  return sagemakerClient;
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}

/**
 * Attempts to parse a JSON string, returning undefined when parsing is not possible.
 */
function safeParseJsonString(value: string): unknown | undefined {
  const trimmed = value.trim();

  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    console.warn('failed to parse JSON string from model response', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function findFirstNumberArray(value: unknown): number[] | undefined {
  if (typeof value === 'string') {
    const parsed = safeParseJsonString(value);
    if (parsed !== undefined) {
      return findFirstNumberArray(parsed);
    }
    return undefined;
  }

  if (isNumberArray(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstNumberArray(item);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    for (const key of ['embedding', 'embeddings', 'data']) {
      if (key in obj) {
        const found = findFirstNumberArray(obj[key]);
        if (found) {
          return found;
        }
      }
    }

    for (const candidate of Object.values(obj)) {
      const found = findFirstNumberArray(candidate);
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

function extractEmbedding(result: unknown): number[] | undefined {
  return findFirstNumberArray(result);
}

async function generateEmbedding(text: string) {
  if (!SAGEMAKER_ENDPOINT_NAME) {
    throw new Error('missing SAGEMAKER_ENDPOINT_NAME environment variable');
  }

  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    throw new Error('missing AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY environment variable');
  }

  const client = getSageMakerClient();

  const command = new InvokeEndpointCommand({
    EndpointName: SAGEMAKER_ENDPOINT_NAME,
    ContentType: 'application/json',
    Accept: 'application/json',
    Body: JSON.stringify({ inputs: text }),
  });

  const response = await client.send(command);

  const httpStatus = response.$metadata.httpStatusCode ?? 500;
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`SageMaker endpoint request failed: ${httpStatus}`);
  }

  const rawBody = response.Body;

  if (!rawBody) {
    throw new Error('empty response body from SageMaker endpoint');
  }

  let bodyString: string;

  if (typeof rawBody === 'string') {
    bodyString = rawBody;
  } else if (rawBody instanceof Uint8Array) {
    bodyString = textDecoder.decode(rawBody);
  } else if (
    rawBody &&
    typeof rawBody === 'object' &&
    'transformToByteArray' in rawBody &&
    typeof (rawBody as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray ===
      'function'
  ) {
    const bytes = await (
      rawBody as unknown as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    bodyString = textDecoder.decode(bytes);
  } else {
    throw new Error('unexpected response body type from SageMaker endpoint');
  }

  const parsed = JSON.parse(bodyString);
  const embedding = extractEmbedding(parsed);

  if (!embedding) {
    throw new Error('failed to generate embedding from SageMaker response');
  }

  return embedding;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  const redis = await getRedisClient();

  const authResult = await authenticateRequest(req, {
    authClient: supabaseAuthClient,
    redis: redis,
    allowedMethods: [AuthMethod.JWT, AuthMethod.USER_API_KEY, AuthMethod.SERVICE_API_KEY],
  });

  if (!authResult.isAuthenticated) {
    return authResult.response!;
  }

  console.log('Auth Success:', authResult);

  let parsedRequest;
  try {
    parsedRequest = parseHybridSearchClientRequest(await req.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request body';
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });
  }

  const rawRes = await openaiStructuredOutput<HybridSearchQuery>({
    schemaName: 'flow_hybrid_search_queries',
    schema: hybridQuerySchema,
    systemPrompt: `Field: Life Cycle Assessment (LCA)
Task: Transform description of flows into three specific queries: SemanticQueryEN, FulltextQueryEN and FulltextQueryZH.
${HYBRID_SYNONYM_RULES}`,
    userPrompt: `Flow description: ${parsedRequest.queryText}`,
    options: { model: openai_chat_model, temperature: 0 },
  });

  const normalizedRes = sanitizeHybridQueryOutput(rawRes, parsedRequest.queryText);
  const semanticQueryEn = normalizedRes.semantic_query_en;
  const fulltextQueryZh = normalizedRes.fulltext_query_zh;
  const fulltextQueryEn = normalizedRes.fulltext_query_en;

  if (!semanticQueryEn) {
    throw new Error('OpenAI structured output missing semantic_query_en');
  }

  const queryFulltextTerms = buildHybridFulltextQueryTerms(normalizedRes);

  const embedding = await generateEmbedding(semanticQueryEn);
  const vectorStr = `[${embedding.join(',')}]`;

  const requestBody = buildHybridSearchRpcRequest(
    parsedRequest.queryText,
    queryFulltextTerms,
    vectorStr,
    parsedRequest.rpcOptions,
  );
  let rpcClientContext: HybridSearchRpcClientContext;
  try {
    rpcClientContext = createHybridSearchRpcClient(
      req.headers.get('Authorization'),
      requestBody.data_source,
    );
  } catch (error) {
    if (error instanceof HybridSearchRpcContextError) {
      return new Response(JSON.stringify({ error: error.message, code: error.code }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: error.status,
      });
    }

    throw error;
  }

  const rpcLogBase = {
    function: 'flow_hybrid_search',
    entity_kind: 'flow',
    query_raw: parsedRequest.queryText,
    semantic_query_en: semanticQueryEn,
    fulltext_query_en: fulltextQueryEn,
    fulltext_query_zh: fulltextQueryZh,
    query_fulltext_terms: queryFulltextTerms,
    match_threshold: requestBody.match_threshold,
    data_source: requestBody.data_source,
    user_context_kind: rpcClientContext.userContextKind,
  };
  const rpcStartedAt = Date.now();
  console.log('[hybrid_search]', { ...rpcLogBase, stage: 'rpc_start' });

  let { data, error } = await rpcClientContext.client.rpc('hybrid_search_flows', requestBody);
  let fallbackUsed = false;

  if (!error && Array.isArray(data) && data.length === 0 && requestBody.match_threshold > 0) {
    fallbackUsed = true;
    const fallbackRequestBody = { ...requestBody, match_threshold: 0 };
    console.log('[hybrid_search]', {
      ...rpcLogBase,
      stage: 'rpc_empty_fallback',
      match_threshold: fallbackRequestBody.match_threshold,
      duration_ms: Date.now() - rpcStartedAt,
    });
    ({ data, error } = await rpcClientContext.client.rpc(
      'hybrid_search_flows',
      fallbackRequestBody,
    ));
  }

  if (error) {
    console.error('[hybrid_search]', {
      ...rpcLogBase,
      stage: 'rpc_error',
      duration_ms: Date.now() - rpcStartedAt,
      error_code: error.code ?? 'HYBRID_SEARCH_RPC_ERROR',
      error_message: error.message,
      fallback_used: fallbackUsed,
    });
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { 'Content-Type': 'application/json' },
      status: 500,
    });
  }
  console.log('[hybrid_search]', {
    ...rpcLogBase,
    stage: 'rpc_success',
    duration_ms: Date.now() - rpcStartedAt,
    result_count: Array.isArray(data) ? data.length : 0,
    fallback_used: fallbackUsed,
  });
  if (data) {
    if (data.length > 0) {
      return new Response(
        JSON.stringify({
          data,
        }),
        {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
          },
          status: 200,
        },
      );
    }
  }
  return new Response('[]', {
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
    status: 200,
  });
});
