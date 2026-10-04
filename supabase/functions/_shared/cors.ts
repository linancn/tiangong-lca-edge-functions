export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  // Authorization is never covered by the Fetch preflight header wildcard.
  'Access-Control-Allow-Headers': '*, authorization',
  'Access-Control-Max-Age': '600',
};
