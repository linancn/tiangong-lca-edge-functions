import "@supabase/functions-js/edge-runtime.d.ts";

import { Redis } from "@upstash/redis";
import { authenticateRequest, AuthMethod } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { supabaseClient as supabase } from "../_shared/supabase_client.ts";
import { langgraphClient } from "../_shared/langgraph_client.ts";

const redis_url = Deno.env.get("UPSTASH_REDIS_URL") ?? "";
const redis_token = Deno.env.get("UPSTASH_REDIS_TOKEN") ?? "";

const redis = new Redis({
  url: redis_url,
  token: redis_token,
});

const assistantId = "lca_ai_suggestion";

async function suggestData(
  tidasData: string,
  dataType: string,
  options: any,
) {
  const threadId = crypto.randomUUID();
  const result = await langgraphClient.runs.wait(threadId, assistantId, {
    data: tidasData,
    dataType,
    options,
  });
  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const authResult = await authenticateRequest(req, {
    supabase: supabase,
    redis: redis,
    allowedMethods: [
      AuthMethod.JWT,
      AuthMethod.USER_API_KEY,
      AuthMethod.SERVICE_API_KEY,
    ],
    serviceApiKey: Deno.env.get("SERVICE_API_KEY"),
  });

  if (!authResult.isAuthenticated) {
    return authResult.response!;
  }

  const { tidasData, dataType, options } = await req.json();

  if (!tidasData) {
    return new Response("Missing tidas_data", { status: 400 });
  }

  if (!dataType) {
    return new Response("Missing dataType", { status: 400 });
  }
  const result = await suggestData(tidasData, dataType, options);

  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
});
