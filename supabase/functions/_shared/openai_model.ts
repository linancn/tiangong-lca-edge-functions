type ModelEnvironment = Pick<typeof Deno.env, 'get'>;

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;

/** Resolve an explicitly supplied model or one required environment setting. */
export function resolveOpenAIModel(
  explicitModel?: unknown,
  environmentName = 'OPENAI_CHAT_MODEL',
  environment: ModelEnvironment = Deno.env,
): string {
  const model = explicitModel === undefined ? environment.get(environmentName) : explicitModel;
  if (model === undefined) {
    throw new Error(`Missing ${environmentName} environment variable`);
  }
  if (typeof model !== 'string' || !MODEL_PATTERN.test(model)) {
    throw new Error('Invalid OpenAI model configuration');
  }
  return model;
}
