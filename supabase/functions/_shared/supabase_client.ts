import { createClient } from "jsr:@supabase/supabase-js@2.98.0";

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

const FALLBACK_SUPABASE_URL = "http://127.0.0.1:54321";
const FALLBACK_SUPABASE_KEY = "placeholder-key";
const SERVICE_ROLE_CLIENT_OPTIONS = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
};

export function getSupabaseUrl(): string {
  return readEnv("REMOTE_SUPABASE_URL") ?? readEnv("SUPABASE_URL") ??
    FALLBACK_SUPABASE_URL;
}

export function getServiceRoleKey(): string {
  return (
    readEnv("REMOTE_SUPABASE_SERVICE_ROLE_KEY") ??
      readEnv("SUPABASE_SERVICE_ROLE_KEY") ??
      FALLBACK_SUPABASE_KEY
  );
}

export function getPublishableKey(): string {
  return (
    readEnv("REMOTE_SUPABASE_PUBLISHABLE_KEY") ??
      readEnv("REMOTE_SUPABASE_ANON_KEY") ??
      readEnv("SUPABASE_PUBLISHABLE_KEY") ??
      readEnv("SUPABASE_ANON_KEY") ??
      FALLBACK_SUPABASE_KEY
  );
}

export function createServiceRoleClient() {
  return createClient(
    getSupabaseUrl(),
    getServiceRoleKey(),
    SERVICE_ROLE_CLIENT_OPTIONS,
  );
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

export const supabaseClient = createClient(
  getSupabaseUrl(),
  getServiceRoleKey(),
  SERVICE_ROLE_CLIENT_OPTIONS,
);
