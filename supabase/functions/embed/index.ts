// Setup type definitions for built-in Supabase Runtime APIs
import '@supabase/functions-js/edge-runtime.d.ts';
import { corsHeaders } from '../_shared/cors.ts';

const session = new Supabase.ai.Session('gte-small');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  // Extract input string from JSON body
  const { input } = await req.json();

  // Generate the embedding from the user input
  const embedding = await session.run(input, {
    mean_pool: true,
    normalize: true,
  });

  // Return the embedding
  return new Response(JSON.stringify({ embedding }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
