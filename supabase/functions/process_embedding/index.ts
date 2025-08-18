import '@supabase/functions-js/edge-runtime.d.ts';
import { authenticateRequest, AuthMethod } from '../_shared/auth.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { openaiChat } from '../_shared/openai_chat.ts';
import { supabaseClient } from '../_shared/supabase_client.ts';

// 1) summarize input JSON, 2) embed the summary.
const session = new Supabase.ai.Session('gte-small');

Deno.serve(async (req) => {
  // if (req.method === 'OPTIONS') {
  //   return new Response('ok', { headers: corsHeaders });
  // }

  const authResult = await authenticateRequest(req, {
    supabase: supabaseClient,
    allowedMethods: [AuthMethod.SERVICE_API_KEY],
    serviceApiKey: Deno.env.get('DEFAULT_SECRET_API_KEY'),
  });

  if (!authResult.isAuthenticated) {
    return authResult.response!;
  }

  try {
    let input = await req.json();
    if (typeof input === 'string') {
      input = JSON.parse(input);
    }

    const systemPrompt =
      'Summarize the LCA process dataset in clear English. Include purpose, main inputs, main outputs, technology used, location, and any quantitative details if available. Keep it concise, self-contained, and under 500 tokens. Output only the summary.';
    const modelInput = `${systemPrompt}\n\nJSON:\n${JSON.stringify(input)}`;

    const { text } = await openaiChat(modelInput, { stream: false });
    const summary = (text || '').trim();
    if (!summary) throw new Error('Empty summary from model');

    const embedding = await session.run(summary, { mean_pool: true, normalize: true });

    return new Response(JSON.stringify({ summary, embedding }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
