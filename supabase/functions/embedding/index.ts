// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

import OpenAI from "https://deno.land/x/openai@v4.47.1/mod.ts";

Deno.serve(async (req) => {
  const { query } = await req.json();
  const apiKey = Deno.env.get("OPENAI_API_KEY");

  const openai = new OpenAI({
    apiKey: apiKey,
  });

  async function getEmbedding(
    query: string | Array<string> | Array<number> | Array<Array<number>>,
  ) {
    try {
      const response = await openai.embeddings.create({
        input: query,
        model: "text-embedding-3-small",
      });
      return response.data;
    } catch (error) {
      console.error("Error creating embedding:", error);
      return { error: "Failed to create embedding" };
    }
  }

  const embeddingResult = await getEmbedding(query);

  return new Response(JSON.stringify(embeddingResult), {
    headers: { "Content-Type": "application/json" },
  });
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  string query:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/embedding' \
  --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
  --header 'Content-Type: application/json' \
  --data '{"query":"Hello"}'

  Array<string> query:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/embedding' \
  --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
  --header 'Content-Type: application/json' \
  --data '{"query":["Hello", "World"]}'
*/
