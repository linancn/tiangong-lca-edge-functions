// Setup type definitions for built-in Supabase Runtime APIs
import '@supabase/functions-js/edge-runtime.d.ts';

import { authenticateRequest, AuthMethod } from '../_shared/auth.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { openaiChat } from '../_shared/openai_chat.ts';
import { supabaseClient } from '../_shared/supabase_client.ts';

interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema: string;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
}

Deno.serve(async (req) => {
  const authResult = await authenticateRequest(req, {
    supabase: supabaseClient,
    allowedMethods: [AuthMethod.SERVICE_API_KEY],
    serviceApiKey: Deno.env.get('REMOTE_SERVICE_API_KEY') ?? Deno.env.get('SERVICE_API_KEY') ?? '',
  });

  if (!authResult.isAuthenticated) {
    return authResult.response!;
  }

  try {
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
      'From the given life cycle assessment ILCD Life Cycle Model JSON, write one continuous paragraph (<500 tokens) suitable for embedding and retrieval. Integrate, in this order and only if explicitly available: name (use name.baseName; append process/route qualifiers from name.treatmentStandardsRoutes; append production-state qualifiers from name.mixAndLocationTypes as non-geographic tags), classification (highest→lowest, in one sentence), reference time (representative year if present; otherwise omit—do not infer; do not use dataset timestamps as representativeness), location (use original location code(s) exactly as given; derive from referenced processes geography if the model has none; if multiple, state “multiple” and keep codes verbatim; never treat mixAndLocationTypes as geography), technology description (summarize included unit processes and operation flow by synthesizing common:generalComment and each referenced process common:shortDescription, deduplicated), LCI method principle (e.g., Attributional/Consequential, only if stated), LCI method approaches (state dataset type such as Partly/Non-terminated system, cut-off/completeness rules, and main data sources/DB versions, only if stated; if available only in referenced processes, say the model follows the referenced processes practice), intended applications (if explicitly provided). Preserve all codes or IDs verbatim, exclude all URIs or schema references, and never invent values. If an element is missing, omit it entirely without placeholder text. Output only one continuous English paragraph, ending with the dataset UUID in parentheses.';
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
