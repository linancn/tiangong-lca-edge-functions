// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

import { createClient } from "https://esm.sh/@supabase/supabase-js";
import OpenAI from "https://esm.sh/openai";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Get the session or user object
  const authHeader = req.headers.get("Authorization");

  // If no Authorization header, return error immediately
  if (!authHeader) {
    return new Response("Unauthorized Request", { status: 401 });
  }

  const token = authHeader.replace("Bearer ", "");

  const supabaseClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  );

  const { data } = await supabaseClient.auth.getUser(token);
  if (!data || !data.user) {
    return new Response("User Not Found", { status: 404 });
  }

  const user = data.user;
  if (user?.role !== "authenticated") {
    return new Response("Forbidden", { status: 403 });
  }

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

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/flow_hybrid_search' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"query":"Functions"}'

*/
