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

    const systemPrompt = `From the given life cycle assessment ILCD Process JSON, write one continuous English paragraph (<500 tokens) suitable for embedding and retrieval. Integrate, in this order and only if explicitly available: Process type (typeOfDataSet) and whether it implies background inclusion/aggregation (e.g., unit process single operation, unit process black box, partly terminated system, LCI result). Purpose/intended application; Reference product / reference flow (identify the exchange that matches processInformation.quantitativeReference.referenceToReferenceFlow) and the reported amount (state “unit as in source” if the unit is not explicit). Main inputs (top 3–6 by presence in exchanges, list name + amount, and note Measured/Estimated); Main outputs/emissions (key product + notable wastewater/emissions with amounts). Technology and included processes (plain language). Location & time representativeness (country/sub-location, reference year). Method/meta: dataset type, allocation note, cut-off/completeness rule, review type/reviewer (if present), compliance system. Data source citation (short description from dataSource or publication info, if present). Preserve all codes or IDs verbatim, exclude all URIs or schema references, and never invent values. If an element is missing, omit it entirely. Output must be one continuous English paragraph, ending with the dataset UUID in parentheses.`;
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
