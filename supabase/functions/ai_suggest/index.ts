import '@supabase/functions-js/edge-runtime.d.ts';
import { authenticateRequest, AuthMethod } from '../_shared/auth.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { openaiStructuredOutput } from '../_shared/openai_structured.ts';
import { getRedisClient } from '../_shared/redis_client.ts';
import { supabaseClient as supabase } from '../_shared/supabase_client.ts';

interface AISuggestRequest {
  tidasData?: unknown;
  dataType?: string;
  options?: Record<string, unknown>;
}

interface AISuggestResult {
  dataType: string;
  summary: string;
  missingInformation: string[];
  recommendedUpdates: string[];
  validationChecks: string[];
}

const aiSuggestSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    dataType: {
      type: 'string',
      description: 'Echo of the input data type.',
    },
    summary: {
      type: 'string',
      description: 'Short summary of overall data quality and key improvements.',
    },
    missingInformation: {
      type: 'array',
      items: { type: 'string' },
      description: 'Missing information that should be added.',
    },
    recommendedUpdates: {
      type: 'array',
      items: { type: 'string' },
      description: 'Actionable updates to improve the dataset.',
    },
    validationChecks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Checks the user should perform before publishing.',
    },
  },
  required: ['dataType', 'summary', 'missingInformation', 'recommendedUpdates', 'validationChecks'],
  additionalProperties: false,
};

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const cleaned = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return Array.from(new Set(cleaned));
}

function getStringOption(options: Record<string, unknown>, key: string): string | undefined {
  const value = options[key];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function getNumberOption(options: Record<string, unknown>, key: string): number | undefined {
  const value = options[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function stringifyDataForPrompt(
  input: unknown,
  maxChars = 80_000,
): { text: string; truncatedChars: number } {
  const raw = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  if (raw.length <= maxChars) {
    return { text: raw, truncatedChars: 0 };
  }
  return {
    text: raw.slice(0, maxChars),
    truncatedChars: raw.length - maxChars,
  };
}

async function suggestData(tidasData: unknown, dataType: string, options: Record<string, unknown>) {
  const { text: dataText, truncatedChars } = stringifyDataForPrompt(tidasData);
  const model =
    getStringOption(options, 'model') || Deno.env.get('OPENAI_CHAT_MODEL') || 'gpt-4.1-mini';
  const temperature = getNumberOption(options, 'temperature') ?? 0;
  const baseUrl = getStringOption(options, 'baseUrl') || getStringOption(options, 'base_url');

  const result = await openaiStructuredOutput<AISuggestResult>({
    schemaName: 'lca_ai_suggest_result',
    schema: aiSuggestSchema,
    systemPrompt: `You are an expert Life Cycle Assessment (LCA) data reviewer.
Your job is to suggest data-quality improvements for TIDAS-like datasets.
Focus on:
1) Missing but expected fields.
2) Inconsistent units, naming, and boundaries.
3) Practical updates that improve searchability and interoperability.
4) Validation checks before publishing.
Keep outputs concise and actionable.`,
    userPrompt: `Please analyze the following dataset and provide suggestions.
Data type: ${dataType}
Options: ${JSON.stringify(options)}
Input truncated chars: ${truncatedChars}
Dataset:
${dataText}`,
    options: { model, temperature, baseUrl },
  });

  return {
    dataType:
      typeof result.dataType === 'string' && result.dataType.trim()
        ? result.dataType.trim()
        : dataType,
    summary: typeof result.summary === 'string' ? result.summary.trim() : '',
    missingInformation: normalizeStringArray(result.missingInformation),
    recommendedUpdates: normalizeStringArray(result.recommendedUpdates),
    validationChecks: normalizeStringArray(result.validationChecks),
    meta: {
      model,
      truncatedChars,
      generatedAt: new Date().toISOString(),
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  const time_start = Date.now();

  const redis = await getRedisClient();

  const authResult = await authenticateRequest(req, {
    supabase: supabase,
    redis: redis,
    allowedMethods: [AuthMethod.JWT, AuthMethod.USER_API_KEY, AuthMethod.SERVICE_API_KEY],
  });

  if (!authResult.isAuthenticated) {
    return authResult.response!;
  }

  const payload = (await req.json()) as AISuggestRequest;
  const tidasData = payload.tidasData;
  const dataType = payload.dataType;
  const options = payload.options && typeof payload.options === 'object' ? payload.options : {};

  if (!tidasData) {
    return new Response('Missing tidas_data', { status: 400 });
  }

  if (!dataType) {
    return new Response('Missing dataType', { status: 400 });
  }
  const result = await suggestData(tidasData, dataType, options);
  const time_end = Date.now();
  const time_cost = time_end - time_start;
  console.log('AI Suggest Edge Function cost: ', time_cost, 'ms');

  return new Response(JSON.stringify(result), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status: 200,
  });
});
