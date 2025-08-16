// Setup type definitions for built-in Supabase Runtime APIs
import '@supabase/functions-js/edge-runtime.d.ts';

import { createClient } from '@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { openaiChat } from '../_shared/openai_chat.ts';

interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}

Deno.serve(async (req) => {
  // if (req.method === 'OPTIONS') {
  //   return new Response('ok', { headers: corsHeaders });
  // }

  // Get the session or user object
  const secretApiKey = req.headers.get('apikey');

  // If no Authorization header, return error immediately
  if (!secretApiKey) {
    return new Response('Unauthorized Request', { status: 401 });
  }

  try {
    const supabaseUrl = Deno.env.get('REMOTE_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseClient = createClient(supabaseUrl, secretApiKey);

    const payload: WebhookPayload = await req.json();
    const { type, table, record } = payload;

    if (type !== 'INSERT' && type !== 'UPDATE') {
      return new Response('Ignored operation type', {
        status: 200,
        headers: corsHeaders,
      });
    }

    if (!record) {
      throw new Error('No record data found');
    }

    const jsonData = record.json_ordered;
    if (!jsonData) {
      throw new Error('No json_ordered data found in record');
    }

    // console.log(`${table} ${record.id} ${record.version} summary ${type} request`);

    const systemPrompt =
      'Summarize the following LCA process dataset from JSON input. Include: purpose, main inputs, main outputs, technology, location, and quantitative details if available. Keep it concise, self-contained, under 500 tokens. Output only the summary text.';
    const modelInput = `${systemPrompt}\nJSON:\n${JSON.stringify(jsonData)}`;

    const { text } = await openaiChat(modelInput, { stream: false });
    const summary = (text || '').trim();
    if (!summary) throw new Error('Empty summary from model');

    const { error: updateError } = await supabaseClient
      .from(table)
      .update({
        extracted_text: summary,
      })
      .eq('id', record.id)
      .eq('version', record.version);

    if (updateError) {
      throw updateError;
    }
    console.log(summary);
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error(errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
