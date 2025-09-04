/**
 * LangGraph Client
 * Due to the CPU limitation of Supabase Edge Functions, we need to use the LangGraph SDK to call the LangGraph API.
 * LANGGRAPH_API_URL is updated every time the Langgraph service is deployed, so this variable needs to be updated after each deployment.
 */
import { Client } from '@langchain/langgraph-sdk';

export const langgraphClient = new Client({
  apiUrl: Deno.env.get('LANGGRAPH_API_URL') ?? '',
  apiKey: Deno.env.get('LANGGRAPH_API_KEY') ?? '',
});


export interface Assistant {
  assistant_id: string;
  graph_id: string;
  created_at: string;
  updated_at: string;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  version: number;
  name: string;
  description: string | null;
  context: Record<string, unknown>;
}

export async function listAssistants(): Promise<Assistant[]> {
  const assistants = await langgraphClient.assistants.search() as Assistant[];
  return assistants;
}
