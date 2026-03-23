import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

import { authenticateRequest, AuthMethod } from '../_shared/auth.ts';
import { getRedisClient } from '../_shared/redis_client.ts';
import { supabaseClient } from '../_shared/supabase_client.ts';
import {
  enqueueImportTidasPackage,
  json,
  prepareImportTidasPackageUpload,
  TidasPackageError,
} from '../_shared/tidas_package.ts';

function resolveBearerToken(req: Request): string {
  return (
    req.headers
      .get('Authorization')
      ?.replace(/^Bearer\s+/i, '')
      .trim() ?? ''
  );
}

function looksLikeJwtToken(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

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

  const bearerToken = resolveBearerToken(req);
  const shouldTryUserApiKey = bearerToken.length > 0 && !looksLikeJwtToken(bearerToken);
  const redis = shouldTryUserApiKey ? await getRedisClient() : undefined;
  const authResult = await authenticateRequest(req, {
    supabase: supabaseClient,
    redis,
    allowedMethods: shouldTryUserApiKey
      ? [AuthMethod.USER_API_KEY, AuthMethod.JWT]
      : [AuthMethod.JWT],
  });

  if (!authResult.isAuthenticated || !authResult.user?.id) {
    return (
      authResult.response ??
      json(
        {
          ok: false,
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
        },
        401,
      )
    );
  }
  const userId = authResult.user.id;

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
