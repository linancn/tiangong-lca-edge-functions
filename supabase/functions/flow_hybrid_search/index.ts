// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />

import { ChatPromptTemplate } from "https://esm.sh/@langchain/core@0.2.5/prompts";
import { ChatOpenAI } from "https://esm.sh/@langchain/openai@0.1.1";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { corsHeaders } from "../_shared/cors.ts";

const openai_api_key = Deno.env.get("OPENAI_API_KEY") ?? "";
const openai_chat_model = Deno.env.get("OPENAI_CHAT_MODEL") ?? "";
const supabase_url = Deno.env.get("SUPABASE_URL") ?? "";
const supabase_anon_key = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // // Get the session or user object
  // const authHeader = req.headers.get("Authorization");

  // // If no Authorization header, return error immediately
  // if (!authHeader) {
  //   return new Response("Unauthorized Request", { status: 401 });
  // }

  // const token = authHeader.replace("Bearer ", "");

  // const supabaseClient = createClient(
  //   supabase_url,
  //   supabase_anon_key,
  // );

  // const { data } = await supabaseClient.auth.getUser(token);
  // if (!data || !data.user) {
  //   return new Response("User Not Found", { status: 404 });
  // }

  // const user = data.user;
  // if (user?.role !== "authenticated") {
  //   return new Response("Forbidden", { status: 403 });
  // }

  const { query } = await req.json();

  if (!query) {
    return new Response("Missing query", { status: 400 });
  }

  const model = new ChatOpenAI({
    model: openai_chat_model,
    temperature: 0,
    apiKey: openai_api_key,
  });

  const querySchema = {
    type: "object",
    properties: {
      semantic_query_en: {
        title: "SemanticQueryEN",
        description: "semantic query in English",
        type: "string",
      },
      fulltext_query_en: {
        title: "FulltextQueryEN",
        description:
          "original names and synonyms for fulltext queries in English",
        type: "string[]",
      },
      fulltext_query_zh: {
        title: "FulltextQueryZH",
        description:
          "original names and synonyms for fulltext queries in Simplified Chinese",
        type: "string[]",
      },
    },
    required: ["semantic_query_en", "fulltext_query_en", "fulltext_query_zh"],
  };

  const modelWithStructuredOutput = model.withStructuredOutput(querySchema);

  const prompt = ChatPromptTemplate.fromMessages([
    [
      "system",
      `Field: Life Cycle Assessment (LCA)
Task: Extract and transform description of flows into three specific queries:
SemanticQueryEN: A query for semantic retrieval in English.
FulltextQueryEN: A query list for full-text search in English, including original names and synonyms.
FulltextQueryZH: A query list for full-text search in Simplified Chinese, including original names and synonyms.`,
    ],
    ["human", "Flow description: {input}"],
  ]);

  const chain = prompt.pipe(modelWithStructuredOutput);

  const res = await chain.invoke({ input: query });

  console.log({ res });

  // async function getEmbedding(
  //   query: string | Array<string> | Array<number> | Array<Array<number>>,
  // ) {
  //   try {
  //     const response = await openai.embeddings.create({
  //       input: query,
  //       model: "text-embedding-3-small",
  //     });
  //     return response.data;
  //   } catch (error) {
  //     console.error("Error creating embedding:", error);
  //     return { error: "Failed to create embedding" };
  //   }
  // }

  // const embeddingResult = await getEmbedding(query);

  return new Response(JSON.stringify(res), {
    headers: { "Content-Type": "application/json" },
  });
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/flow_hybrid_search' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"query":"生物化学和医学研究中酶抑制剂开发的1,10-菲咯啉流"}'

*/
