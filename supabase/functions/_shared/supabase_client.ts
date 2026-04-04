import { createClient } from 'jsr:@supabase/supabase-js@2.98.0';

function readEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? undefined;
  } catch (_error) {
    return undefined;
  }
}

const FALLBACK_SUPABASE_URL = 'http://127.0.0.1:54321';
const FALLBACK_SUPABASE_KEY = 'placeholder-key';

export function getSupabaseUrl(): string {
  return readEnv('REMOTE_SUPABASE_URL') ?? readEnv('SUPABASE_URL') ?? FALLBACK_SUPABASE_URL;
}

export function getServiceRoleKey(): string {
  return (
    readEnv('REMOTE_SERVICE_API_KEY') ??
    readEnv('SERVICE_API_KEY') ??
    readEnv('REMOTE_SUPABASE_SERVICE_ROLE_KEY') ??
    readEnv('SUPABASE_SERVICE_ROLE_KEY') ??
    FALLBACK_SUPABASE_KEY
  );
}

export function getPublishableKey(): string {
  return (
    readEnv('REMOTE_SUPABASE_PUBLISHABLE_KEY') ??
    readEnv('REMOTE_SUPABASE_ANON_KEY') ??
    readEnv('SUPABASE_PUBLISHABLE_KEY') ??
    readEnv('SUPABASE_ANON_KEY') ??
    FALLBACK_SUPABASE_KEY
  );
}

export function createServiceRoleClient() {
  return createClient(getSupabaseUrl(), getServiceRoleKey());
}

export function createRequestSupabaseClient(accessToken?: string) {
  const headers: Record<string, string> = {};

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return createClient(getSupabaseUrl(), getPublishableKey(), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: Object.keys(headers).length > 0 ? { headers } : undefined,
  });
}

export const supabaseClient = createClient(getSupabaseUrl(), getServiceRoleKey());
