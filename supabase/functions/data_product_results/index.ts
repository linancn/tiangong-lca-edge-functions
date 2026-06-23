import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';
import { z } from 'zod';

import { commandError, json } from '../_shared/command_runtime/http.ts';
import { readJsonBody } from '../_shared/command_runtime/request.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { callDataProductPublishedResultsRpc } from '../_shared/db_rpc/data_product_commands.ts';
import { supabaseAuthClient } from '../_shared/supabase_client.ts';

const versionPattern = /^\d{2}\.\d{2}\.\d{3}$/;

export const dataProductPublishedResultsRequestSchema = z
  .object({
    processId: z.string().uuid(),
    processVersion: z.string().regex(versionPattern, 'processVersion must be in 00.00.000 format'),
    impactCategoryId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export type DataProductPublishedResultsRequest = z.infer<
  typeof dataProductPublishedResultsRequestSchema
>;

export type DataProductResultsHandlerOptions = {
  supabase?: Pick<SupabaseClient, 'rpc'>;
};

function parseQuery(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}

async function readRequestPayload(req: Request) {
  if (req.method === 'GET') {
    return { ok: true as const, value: parseQuery(req) };
  }

  return await readJsonBody(req);
}

export function createDataProductResultsHandler(options: DataProductResultsHandlerOptions = {}) {
  const supabase = options.supabase ?? supabaseAuthClient;

  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders });
    }

    if (req.method !== 'POST' && req.method !== 'GET') {
      return commandError('METHOD_NOT_ALLOWED', 'Only GET and POST are supported', 405);
    }

    const bodyResult = await readRequestPayload(req);
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const parsed = dataProductPublishedResultsRequestSchema.safeParse(bodyResult.value);
    if (!parsed.success) {
      return commandError(
        'INVALID_PAYLOAD',
        'Invalid data product result lookup payload',
        400,
        parsed.error.flatten(),
      );
    }

    const result = await callDataProductPublishedResultsRpc(supabase, parsed.data);
    if (!result.ok) {
      return commandError(result.code, result.message, result.status, result.details);
    }

    return json({
      ok: true,
      data: result.data,
    });
  };
}

export const handleDataProductResults = createDataProductResultsHandler();

if (import.meta.main) {
  Deno.serve(handleDataProductResults);
}
