import OpenAI from '@openai/openai';

/**
 * Reusable OpenAI client (lazy initialized singleton).
 */
let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (_client) return _client;
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY environment variable');
  }
  _client = new OpenAI({ apiKey });
  return _client;
}

export interface OpenAIChatOptions {
  /** Model name; defaults to env OPENAI_CHAT_MODEL or falls back to gpt-5-mini */
  model?: string;
  /** Enable streaming (default false). Function currently returns aggregate result. */
  stream?: boolean;
}

export interface OpenAIChatResult {
  text: string;
  raw: unknown; // Original response object for downstream use when needed
}

/**
 * Call OpenAI Responses API.
 * @param instruct System / behavior instruction
 * @param input User input text
 * @param options Optional settings
 * @returns Output text plus raw response
 */
export async function openaiChat(
  input: string,
  options: OpenAIChatOptions = {},
): Promise<OpenAIChatResult> {
  if (!input) throw new Error('input must not be empty');

  const client = getClient();
  const model = options.model || Deno.env.get('OPENAI_CHAT_MODEL') || 'gpt-5-mini';
  const stream = options.stream ?? false;

  const response = await client.responses.create({
    model,
    stream,
    input,
  });

  // SDK is expected to provide output_text; fall back to empty string if absent.
  const maybeOutput = response as { output_text?: string };
  const text = maybeOutput.output_text ?? '';
  return { text, raw: response };
}

// Example usage (only runs when this file is executed directly, not when imported).
if (import.meta.main) {
  const demoInput = 'Say hello in one short sentence.';
  openaiChat(demoInput)
    .then((r) => console.log('[demo]', r.text))
    .catch((e) => console.error('[demo error]', e));
}
