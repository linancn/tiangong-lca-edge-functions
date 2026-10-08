import { assertEquals, assertThrows } from 'jsr:@std/assert';

import { resolveOpenAIModel } from '../supabase/functions/_shared/openai_model.ts';

Deno.test('model resolution requires explicit configuration and honors valid overrides', () => {
  const reads: string[] = [];
  const environment = {
    get: (name: string) => {
      reads.push(name);
      return name === 'HYBRID_OPENAI_CHAT_MODEL' ? 'gpt-6-luna' : 'gpt-5.4-nano';
    },
  };
  assertEquals(resolveOpenAIModel(undefined, undefined, environment), 'gpt-5.4-nano');
  assertEquals(
    resolveOpenAIModel(undefined, 'HYBRID_OPENAI_CHAT_MODEL', environment),
    'gpt-6-luna',
  );
  assertEquals(resolveOpenAIModel('explicit-model', undefined, environment), 'explicit-model');
  assertEquals(reads, ['OPENAI_CHAT_MODEL', 'HYBRID_OPENAI_CHAT_MODEL']);
});

Deno.test('invalid explicit models cannot silently use a configured environment model', () => {
  let reads = 0;
  const environment = {
    get: (_name: string) => {
      reads++;
      return 'gpt-5.4-nano';
    },
  };
  for (const model of [
    '',
    ' ',
    ' gpt-6-luna',
    'gpt-6-luna ',
    'model\n',
    null,
    3,
    {},
    'x'.repeat(201),
  ]) {
    assertThrows(
      () => resolveOpenAIModel(model, undefined, environment),
      Error,
      'Invalid OpenAI model configuration',
    );
  }
  assertEquals(reads, 0);
});

Deno.test('missing and invalid model environment values fail closed', () => {
  assertThrows(
    () => resolveOpenAIModel(undefined, 'HYBRID_OPENAI_CHAT_MODEL', { get: () => undefined }),
    Error,
    'Missing HYBRID_OPENAI_CHAT_MODEL environment variable',
  );
  for (const model of ['', ' ', 'gpt-6-luna\n', 'gpt-6-luna?key=value']) {
    assertThrows(
      () => resolveOpenAIModel(undefined, undefined, { get: () => model }),
      Error,
      'Invalid OpenAI model configuration',
    );
  }
});
