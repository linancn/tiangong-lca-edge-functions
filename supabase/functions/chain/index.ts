
/// <reference types="https://esm.sh/v135/@supabase/functions-js@2.4.1/src/edge-runtime.d.ts" />
import { BufferMemory } from "https://esm.sh/langchain@0.2.4/memory";
import { ChatOpenAI } from "https://esm.sh/@langchain/openai@0.1.0";
import { ConversationChain } from "https://esm.sh/langchain@0.2.4/chains";
import { XataChatMessageHistory } from "https://esm.sh/@langchain/community@0.2.5/stores/message/xata";
import { BaseClient } from "https://esm.sh/@xata.io/client@0.28.4";

const openai_apiKey = Deno.env.get("OPENAI_API_KEY")
const openai_model = Deno.env.get('OPENAI_MODEL')
const xata_apiKey = Deno.env.get('XATA_API_KEY');
const xata_db_url = Deno.env.get('XATA_MEMORY_DB_URL');
const xata_branch = Deno.env.get('XATA_BRANCH');
const xata_table_name = Deno.env.get('XATA_TABLE_NAME');
console.log("Hello from Functions!")

Deno.serve(async (req) => {
  const { name } = await req.json()
  const data = {
    message: `Hello ${name}!`,
  }


  const getXataClient = () => {
    if (!xata_apiKey) {
      throw new Error("XATA_API_KEY not set");
    }
  
    if (!xata_db_url) {
      throw new Error("XATA_DB_URL not set");
    }
    const xata = new BaseClient({
      databaseURL: xata_db_url,
      apiKey: xata_apiKey,
      branch: xata_branch,
    });
    return xata;
  };
  
  const memory = new BufferMemory({
    chatHistory: new XataChatMessageHistory({
      table: "memory",
      sessionId: new Date().toISOString(), // Or some other unique identifier for the conversation
      client: getXataClient(),
      createTable: false, // Explicitly set to false if the table is already created
    }),
  });
  
  const model = new ChatOpenAI({apiKey: openai_apiKey, model: openai_model, temperature: 0});
  const chain = new ConversationChain({ llm: model, memory });
  
  const res1 = await chain.invoke({ input: "Hi, I'm Jim" });
  console.log({ res1 });
  const res2 = await chain.invoke({ "input": "Who am I?"});
  console.log({ res2 });

  return new Response(
    JSON.stringify(res1),
    { headers: { "Content-Type": "application/json" } },
  )
})

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://localhost:54321/functions/v1/chain' \
    --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
    --header 'Content-Type: application/json' \
    --data '{"name":"Functions"}'

*/
