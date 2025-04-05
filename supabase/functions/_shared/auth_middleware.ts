import { SupabaseClient } from '@supabase/supabase-js@2';
import { Redis } from '@upstash/redis';
import { corsHeaders } from './cors.ts';
import decodeApiKey from './decode_api_key.ts';
import supabaseAuth from './supabase_auth.ts';

export interface AuthResult {
  isAuthenticated: boolean;
  userId?: string;
  response?: Response;
}

export async function authenticateRequest(
  req: Request,
  supabase: SupabaseClient,
  redis: Redis,
): Promise<AuthResult> {
  let email = req.headers.get('email') ?? '';
  let password = req.headers.get('password') ?? '';

  const apiKey = req.headers.get('x-api-key') ?? '';
  const authHeader = req.headers.get('Authorization') ?? '';

  if (!authHeader && !apiKey) {
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

  if (apiKey) {
    const credentials = decodeApiKey(apiKey);
    if (credentials) {
      if (!email) email = credentials.email;
      if (!password) password = credentials.password;
    } else {
      return {
        isAuthenticated: false,
        response: new Response(JSON.stringify({ error: 'Invalid API Key' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }),
      };
    }
  }

  let user = null;
  if (authHeader) {
    const token = authHeader.replace('Bearer ', '');
    const { data: authData } = await supabase.auth.getUser(token);

    if (authData.user?.role === 'authenticated') {
      return {
        isAuthenticated: true,
        userId: authData.user?.id,
      };
    }

    if (!authData || !authData.user) {
      // Only return error if no API key was provided as alternative
      if (!apiKey) {
        return {
          isAuthenticated: false,
          response: new Response('User Not Found', { status: 404 }),
        };
      }
    } else {
      user = authData.user;
      if (user.role !== 'authenticated' && !apiKey) {
        return {
          isAuthenticated: false,
          response: new Response('Forbidden', { status: 403 }),
        };
      }
    }
  }

  const userIdFromRedis = await redis.get('lca_' + email);
  if (!userIdFromRedis) {
    const authResponse = await supabaseAuth(supabase, email, password);
    const authData = await authResponse.json();
    if (authResponse.status !== 200) {
      return {
        isAuthenticated: false,
        response: authResponse,
      };
    } else {
      await redis.setex('lca_' + email, 3600, authData.userId);
      return {
        isAuthenticated: true,
        userId: authData.userId,
      };
    }
  }

  return {
    isAuthenticated: true,
    userId: typeof userIdFromRedis === 'string' ? userIdFromRedis : undefined,
  };
}
