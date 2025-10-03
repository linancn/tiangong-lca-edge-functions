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
      `
From the given life cycle assessment ILCD Life Cycle Model JSON, write one continuous English paragraph (<500 tokens) suitable for embedding and retrieval. The paragraph must strictly follow the natural language template below. Fill in values only if explicitly available. Do not add, remove, or reorder sentences. If a field has no value, omit the entire sentence where it belongs, not just the placeholder. 
Always output in English only. Omit or translate non-English names. For technology and included processes, write concise natural sentences, do not mechanically list all referenced processes. Summarize supporting processes by category (utilities, water, energy, treatment) instead of enumerating all. If LCI method information is incomplete, output only what is explicitly given, but note that additional details are not stated.

Template:
<name.baseName [plus any qualifiers from name.treatmentStandardsRoutes and name.mixAndLocationTypes, joined with commas as non-geographic tags]> is classified under <classification path highest→lowest>. The reference time is <representative year>. The location is <location code(s) exactly as given; if multiple, state “multiple” and keep codes verbatim>. The technology and included processes are <summary of included unit processes and operation flow synthesized from common:generalComment and referenced process common:shortDescription, deduplicated>. The LCI method principle is <LCIMethodPrinciple, e.g. Attributional/Consequential>. The LCI method approaches are <dataset type such as Partly/Non-terminated system, cut-off/completeness rules, and main data sources/DB versions, or note that the model follows the referenced processes practice>. Its intended applications are <explicit intended application if provided>. (<UUID>)

Additional rules:
Preserve any codes or IDs verbatim.
Exclude all URIs or schema references.
Never treat mixAndLocationTypes as geography.
Do not infer or invent values.
`;
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
