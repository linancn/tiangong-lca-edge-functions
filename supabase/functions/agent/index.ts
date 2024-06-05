/// <reference types="https://esm.sh/v135/@supabase/functions-js/src/edge-runtime.d.ts" />

import { XataChatMessageHistory } from "https://esm.sh/@langchain/community@0.2.5/stores/message/xata";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "https://esm.sh/@langchain/core@0.2.5/prompts";
import { RunnableWithMessageHistory } from "https://esm.sh/@langchain/core@0.2.5/runnables";
import { ChatOpenAI } from "https://esm.sh/@langchain/openai@0.1.1";
import { BaseClient } from "https://esm.sh/@xata.io/client@0.28.4";
import {
  AgentExecutor,
  createOpenAIFunctionsAgent,
} from "https://esm.sh/langchain@0.2.4/agents";

import { corsHeaders } from "../_shared/cors.ts";
import SearchInternetTool from "../tools/search_Internet_tool.ts";
import SearchEsgTool from "../tools/search_esg_tool.ts";

const openai_api_key = Deno.env.get("OPENAI_API_KEY") ?? "";
const openai_chat_model = Deno.env.get("OPENAI_CHAT_MODEL") ?? "";
const xata_api_key = Deno.env.get("XATA_API_KEY") ?? "";
const xata_db_url = Deno.env.get("XATA_MEMORY_DB_URL") ?? "";
const xata_branch = Deno.env.get("XATA_BRANCH") ?? "";
const xata_table_name = Deno.env.get("XATA_TABLE_NAME") ?? "";

const getXataClient = (): BaseClient | undefined => {
  if (xata_db_url && xata_api_key && xata_branch) {
    const xata = new BaseClient({
      databaseURL: xata_db_url,
      apiKey: xata_api_key,
      branch: xata_branch,
    });
    return xata;
  }
  return undefined;
};

function initChatHistory(session_id: string) {
  const client = getXataClient();
  if (!client) {
    throw new Error("Failed to get Xata client");
  }
  return new XataChatMessageHistory({
    table: xata_table_name,
    sessionId: session_id,
    client: client,
    apiKey: xata_api_key,
    createTable: true,
  });
}

Deno.serve(async (req) => {
  // This is needed if you're planning to invoke your function from a browser.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  //try {
    const tools = [
      new SearchInternetTool().invoke(), 
      new SearchEsgTool().invoke()
    ];

    const prompt = ChatPromptTemplate.fromMessages([
      ["system", ""],
      new MessagesPlaceholder("history"),
      ["human", "{input}"],
      new MessagesPlaceholder("agent_scratchpad"),
    ]);

    const llm = new ChatOpenAI({
      apiKey: openai_api_key,
      temperature: 0,
      model: openai_chat_model,
    });

    const agent = await createOpenAIFunctionsAgent({
      llm,
      tools,
      prompt,
    });

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
    console.log(query);
    const res = await agentExecutorWithHistory.invoke(
      {
        input: query,
      },
      {
        configurable: { sessionId: sessionId },
      },
    );
    console.log(res);
    return new Response(
      JSON.stringify(res.output),
      {
        headers: { "Content-Type": "application/json" },
        status: 200,
      },
    );
  /*} catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      },
    );
  }
  */
});

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  string query:

  curl -i --location --request POST 'http://localhost:54321/functions/v1/agent' \
  --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' \
  --header 'Content-Type: application/json' \
  --data '{"query":"does alibaba have board committees overseeing climate risk? search in the esg database. topK is 5, doc id is rec_cosa04n2v20pl80pk30g", "sessionId": "zyh1222"}'

*/
