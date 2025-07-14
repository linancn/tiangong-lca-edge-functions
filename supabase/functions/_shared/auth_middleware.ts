import { SupabaseClient } from '@supabase/supabase-js@2';
import { Redis } from '@upstash/redis';
import { authenticateCognitoToken } from './cognito_auth.ts';
import { corsHeaders } from './cors.ts';
import decodeApiKey from './decode_api_key.ts';

export interface AuthResult {
  isAuthenticated: boolean;
  userId?: string;
  response?: Response;
  email?: string;
}

/**
 * 判断 token 类型
 * @param bearerKey - Bearer token
 * @returns 'cognito' | 'supabase' | 'api_key'
 */
function getTokenType(bearerKey: string): 'cognito' | 'supabase' | 'api_key' {
  // Cognito JWT token 通常是三部分用点分隔的格式 (header.payload.signature)
  const jwtPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

  if (jwtPattern.test(bearerKey)) {
    try {
      // 解析 JWT payload 来进一步确认是否为 Cognito token
      const payload = JSON.parse(atob(bearerKey.split('.')[1]));
      if (payload.iss && payload.iss.includes('cognito')) {
        return 'cognito';
      }
    } catch (_error) {
      // 如果解析失败，可能是其他格式的 JWT
    }
  }

  // 检查是否为 API key 格式
  const credentials = decodeApiKey(bearerKey);
  if (credentials) {
    return 'api_key';
  }

  // 默认使用 Supabase 认证
  return 'supabase';
}

export async function authenticateRequest(
  req: Request,
  supabase: SupabaseClient,
  redis: Redis,
): Promise<AuthResult> {
  const apiKey = req.headers.get('x-api-key') ?? '';

  // 检查是否提供了认证信息
  if (!apiKey) {
    return {
      isAuthenticated: false,
      response: new Response(
        'Authentication required - provide either API key or Authorization token',
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        },
      ),
    };
  }

  const tokenType = getTokenType(apiKey);

  switch (tokenType) {
    case 'cognito':
      return await authenticateCognitoRequest(apiKey);

    case 'api_key':
      return await authenticateApiKeyRequest(apiKey, supabase, redis);

    case 'supabase':
    default:
      return await authenticateSupabaseRequest(apiKey, supabase);
  }
}

/**
 * 使用 Cognito JWT 认证
 */
async function authenticateCognitoRequest(bearerKey: string): Promise<AuthResult> {
  try {
    const cognitoResult = await authenticateCognitoToken(bearerKey);
    return {
      isAuthenticated: cognitoResult.isAuthenticated,
      userId: cognitoResult.userId,
      email: cognitoResult.email,
      response: cognitoResult.isAuthenticated
        ? undefined
        : new Response(cognitoResult.response || 'Cognito authentication failed', {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }),
    };
  } catch (_error) {
    return {
      isAuthenticated: false,
      response: new Response('Cognito authentication error', {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }),
    };
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
