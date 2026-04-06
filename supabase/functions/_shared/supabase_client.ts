import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

function readEnv(name: string): string | undefined {
  try {
    const value = Deno.env.get(name);
    if (value === undefined) {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  } catch (_error) {
    return undefined;
  }
}

const FALLBACK_SUPABASE_URL = 'http://127.0.0.1:54321';
const FALLBACK_SUPABASE_KEY = 'placeholder-key';
const SHARED_CLIENT_OPTIONS = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
};

export function getSupabaseUrl(): string {
  return readEnv('REMOTE_SUPABASE_URL') ?? readEnv('SUPABASE_URL') ?? FALLBACK_SUPABASE_URL;
}

export function getSupabaseServiceRoleKey(): string {
  return (
    readEnv('REMOTE_SUPABASE_SERVICE_ROLE_KEY') ??
    readEnv('REMOTE_SUPABASE_SECRET_KEY') ??
    readEnv('SUPABASE_SERVICE_ROLE_KEY') ??
    readEnv('SUPABASE_SECRET_KEY') ??
    FALLBACK_SUPABASE_KEY
  );
}

export function getSupabasePublishableKey(): string {
  return (
    readEnv('REMOTE_SUPABASE_PUBLISHABLE_KEY') ??
    readEnv('REMOTE_SUPABASE_ANON_KEY') ??
    readEnv('SUPABASE_PUBLISHABLE_KEY') ??
    readEnv('SUPABASE_ANON_KEY') ??
    FALLBACK_SUPABASE_KEY
  );
}

export function createSupabaseAuthClient(): SupabaseClient {
  return createClient(getSupabaseUrl(), getSupabasePublishableKey(), SHARED_CLIENT_OPTIONS);
}

export function createSupabaseServiceClient(): SupabaseClient {
  return createClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), SHARED_CLIENT_OPTIONS);
}

export function createRequestSupabaseClient(accessToken?: string): SupabaseClient {
  const headers: Record<string, string> = {};

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return createClient(getSupabaseUrl(), getSupabasePublishableKey(), {
    ...SHARED_CLIENT_OPTIONS,
    global: Object.keys(headers).length > 0 ? { headers } : undefined,
  });
}

export const supabaseAuthClient = createSupabaseAuthClient();
export const supabaseServiceClient = createSupabaseServiceClient();

// Backward-compatible aliases for existing service-role call sites.
export const getServiceRoleKey = getSupabaseServiceRoleKey;
export const getPublishableKey = getSupabasePublishableKey;
export const createServiceRoleClient = createSupabaseServiceClient;
export const supabaseClient = supabaseServiceClient;
