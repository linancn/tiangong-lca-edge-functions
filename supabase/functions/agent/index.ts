/// <reference types="https://esm.sh/v135/@supabase/functions-js/src/edge-runtime.d.ts" />

import { ChatOpenAI } from "https://esm.sh/@langchain/openai";
import { BaseClient } from "https://esm.sh/@xata.io/client";
import { RunnableWithMessageHistory } from "https://esm.sh/@langchain/core/runnables";
import { AgentExecutor, createOpenAIFunctionsAgent } from "https://esm.sh/langchain/agents";
import { XataChatMessageHistory } from "https://esm.sh/@langchain/community/stores/message/xata";
import { ChatPromptTemplate, MessagesPlaceholder } from "https://esm.sh/@langchain/core/prompts";
import { DuckDuckGoSearch } from "https://esm.sh/@langchain/community/tools/duckduckgo_search";

import { corsHeaders } from '../_shared/cors.ts';
//import { getXataClient } from '../xata.ts'

const openai_apiKey = Deno.env.get("OPENAI_API_KEY")
const openai_model = Deno.env.get('OPENAI_MODEL')
const xata_apiKey = Deno.env.get('XATA_API_KEY');
const xata_db_url = Deno.env.get('XATA_MEMORY_DB_URL');
const xata_branch = Deno.env.get('XATA_BRANCH');
const xata_table_name = Deno.env.get('XATA_TABLE_NAME');

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

function initChatHistory(session_id: string){
  return new XataChatMessageHistory({
    table: xata_table_name,
    sessionId: session_id,
    client: getXataClient(),
    apiKey: xata_apiKey,
    createTable: false,
  })
}

Deno.serve(async (req) => {
  // This is needed if you're planning to invoke your function from a browser.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  try{
    const tools = [new DuckDuckGoSearch({ maxResults: 1 })];

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", ""],
      new MessagesPlaceholder("history"),
      ["human", "{input}"],
      new MessagesPlaceholder("agent_scratchpad"),
      ]);

    const llm = new ChatOpenAI({ 
      apiKey: openai_apiKey,
      temperature: 0,
      model: openai_model,
    });

    const agent = await createOpenAIFunctionsAgent({
        llm,
        tools,
        prompt

    })

    const agentExecutor = AgentExecutor.fromAgentAndTools({
        agent: agent,
        tools: tools,
        returnIntermediateSteps: true,
      });

    const agentExecutorWithHistory = new RunnableWithMessageHistory({
        runnable: agentExecutor,
        getMessageHistory: (sessionId) => initChatHistory(sessionId),
        inputMessagesKey: "input",
        historyMessagesKey: "history",
    });
    
    const { query, sessionId } = await req.json();
    console.log(query)
    const result = await agentExecutorWithHistory.invoke(
        {
            input: query,
        },
        {
            configurable: {sessionId: sessionId}
        }
    )
    return new Response(
      JSON.stringify(result), 
      {
      headers: { "Content-Type": "application/json" },
      status: 200,
      }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }), 
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400,
      }
    )
  }

});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  string query:

curl -i --location --request POST 'http://localhost:54321/functions/v1/agent' \
  --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
  --header 'Content-Type: application/json' \
  --data '{"query":"Hello", "sessionId": "1"}'

*/