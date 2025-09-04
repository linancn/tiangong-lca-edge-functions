import '@supabase/functions-js/edge-runtime.d.ts';

import { ChatPromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { Redis } from '@upstash/redis';
// import { authenticateRequest } from '../_shared/auth_middleware.ts';
import { authenticateRequest, AuthMethod } from '../_shared/auth.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { supabaseClient as supabase } from '../_shared/supabase_client.ts';
import { suggestData, SuggestOptions } from '@tiangong-lca/tidas-sdk';

const openai_api_key = Deno.env.get('OPENAI_API_KEY') ?? '';
const openai_chat_model = Deno.env.get('OPENAI_CHAT_MODEL') ?? '';

const redis_url = Deno.env.get('UPSTASH_REDIS_URL') ?? '';
const redis_token = Deno.env.get('UPSTASH_REDIS_TOKEN') ?? '';

const redis = new Redis({
  url: redis_url,
  token: redis_token,
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authResult = await authenticateRequest(req, {
    supabase: supabase,
    redis: redis,
    allowedMethods: [AuthMethod.JWT, AuthMethod.USER_API_KEY, AuthMethod.SERVICE_API_KEY],
    serviceApiKey: Deno.env.get('SERVICE_API_KEY'),
  });

  if (!authResult.isAuthenticated) {
    return authResult.response!;
  }

  const { tidasData, dataType, options } = await req.json();

  if (!tidasData) {
    return new Response('Missing tidas_data', { status: 400 });
  }

  if (!dataType) {
    return new Response('Missing dataType', { status: 400 });
  }

  const modelConfig: SuggestOptions['modelConfig'] = {
    model: openai_chat_model,
    apiKey: openai_api_key,
  };

  const result = await suggestData(tidasData, dataType, {
    ...options,
    modelConfig,
  });

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
  });
});
