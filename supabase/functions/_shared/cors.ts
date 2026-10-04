export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  // Firefox permits wildcard headers but only reuses explicitly cached header names.
  // Keep the wildcard for other callers and name every header sent by Functions JS.
  'Access-Control-Allow-Headers': '*, authorization, apikey, content-type, x-client-info, x-region',
  'Access-Control-Max-Age': '600',
};
