import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { authenticateRequest, AuthMethod } from '../_shared/auth.ts';
import { supabaseClient } from '../_shared/supabase_client.ts';
import {
  enqueueImportTidasPackage,
  json,
  prepareImportTidasPackageUpload,
  TidasPackageError,
} from '../_shared/tidas_package.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return json('ok');
  }

  if (req.method !== 'POST') {
    return json(
      {
        ok: false,
        code: 'METHOD_NOT_ALLOWED',
        message: 'Only POST is supported',
      },
      405,
    );
  }

  const authResult = await authenticateRequest(req, {
    supabase: supabaseClient,
    allowedMethods: [AuthMethod.JWT],
  });

  const userId = authResult.user?.id;
  if (!authResult.isAuthenticated || !userId) {
    return json(
      {
        ok: false,
        code: 'AUTH_REQUIRED',
        message: 'Authentication required',
      },
      401,
    );
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch (_error) {
    body = {};
  }

  try {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const action = typeof record.action === 'string' ? record.action : 'prepare_upload';

    if (action === 'prepare_upload') {
      const response = await prepareImportTidasPackageUpload(supabaseClient, userId, body, req);
      return json(response, 200);
    }

    if (action === 'enqueue') {
      const response = await enqueueImportTidasPackage(supabaseClient, userId, body);
      return json(response, response.mode === 'queued' ? 202 : 200);
    }

    return json(
      {
        ok: false,
        code: 'INVALID_ACTION',
        message: 'Unsupported import action',
      },
      400,
    );
  } catch (error) {
    console.error('import_tidas_package failed', error);
    if (error instanceof TidasPackageError) {
      return json(
        {
          ok: false,
          code: error.code,
          message: error.message,
        },
        error.status,
      );
    }
    return json(
      {
        ok: false,
        code: 'IMPORT_FAILED',
        message: error instanceof Error ? error.message : 'Failed to import TIDAS package',
      },
      500,
    );
  }
});
