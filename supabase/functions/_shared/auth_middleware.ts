import { SupabaseClient } from '@supabase/supabase-js@2';
import { Redis } from '@upstash/redis';
import { corsHeaders } from './cors.ts';
import decodeApiKey from './decode_api_key.ts';

export interface AuthResult {
  isAuthenticated: boolean;
  userId?: string;
  response?: Response;
  email?: string;
}

export async function authenticateRequest(
  req: Request,
  supabase: SupabaseClient,
  redis: Redis,
): Promise<AuthResult> {
  const apiKey = req.headers.get('x-api-key') ?? '';

  // 检查是否提供了认证信息
  if (!apiKey) {
    // Get the session or user object
    const authHeader = req.headers.get('Authorization');

    // If no Authorization header, return error immediately
    if (!authHeader) {
      return {
        isAuthenticated: false,
        response: new Response('Unauthorized Request', { status: 401 }),
      };
    }

    const token = authHeader.replace('Bearer ', '');

    return await authenticateSupabaseRequest(token, supabase);
  } else {
    return await authenticateApiKeyRequest(apiKey, supabase, redis);
  }
}

/**
 * 使用 API Key 认证
 */
async function authenticateApiKeyRequest(
  bearerKey: string,
  supabase: SupabaseClient,
  redis: Redis,
): Promise<AuthResult> {
  const credentials = decodeApiKey(bearerKey);
  if (!credentials) {
    return {
      isAuthenticated: false,
      response: new Response(JSON.stringify({ error: 'Invalid API Key' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }),
    };
  }

  const { email = '', password = '' } = credentials;
  const userIdFromRedis = await redis.get('lca_' + email);

  if (!userIdFromRedis) {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (error) {
      return {
        isAuthenticated: false,
        response: new Response('Unauthorized', {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }),
      };
    }

    if (data.user.role !== 'authenticated') {
      return {
        isAuthenticated: false,
        response: new Response('You are not an authenticated user.', {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }),
      };
    } else {
      await redis.setex('lca_' + email, 3600, data.user.id);
      return {
        isAuthenticated: true,
        userId: data.user.id,
        email: data.user.email,
      };
    }
  }

  return {
    isAuthenticated: true,
    userId: String(userIdFromRedis),
    email: email,
  };
}

/**
 * 使用 Supabase 认证
 */
async function authenticateSupabaseRequest(
  bearerKey: string,
  supabase: SupabaseClient,
): Promise<AuthResult> {
  const { data: authData } = await supabase.auth.getUser(bearerKey);

  if (authData.user?.role === 'authenticated') {
    return {
      isAuthenticated: true,
      userId: authData.user?.id,
      email: authData.user?.email,
    };
  }

  if (!authData || !authData.user) {
    return {
      isAuthenticated: false,
      response: new Response('User Not Found', {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }),
    };
  } else {
    if (authData.user.role !== 'authenticated') {
      return {
        isAuthenticated: false,
        response: new Response('Forbidden', {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }),
      };
    }
  }

  return {
    isAuthenticated: true,
    userId: authData.user.id,
    email: authData.user.email,
  };
}
