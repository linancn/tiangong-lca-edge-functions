import { createClient } from '@supabase/supabase-js@2';

export const supabaseClient = createClient(
  Deno.env.get('REMOTE_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('REMOTE_SUPABASE_PUBLISHABLE_KEY') ??
    Deno.env.get('_SUPABASE_PUBLISHABLE_KEY') ??
    '',
);
