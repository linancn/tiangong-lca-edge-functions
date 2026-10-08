import { assertEquals, assertRejects } from 'jsr:@std/assert';

import { openaiChat } from '../supabase/functions/_shared/openai_chat.ts';
import {
  buildOpenAIChatParameters,
  buildOpenAIResponsesParameters,
  openaiStructuredOutput,
  type OpenAIStructuredRequest,
} from '../supabase/functions/_shared/openai_structured.ts';
import { hybridQuerySchema } from '../supabase/functions/_shared/hybrid_query_utils.ts';

const REQUEST: OpenAIStructuredRequest = {
  schemaName: 'rewrite_queries',
  schema: hybridQuerySchema,
  systemPrompt: 'system prompt',
  userPrompt: 'user prompt',
  options: { model: 'gpt-6-luna', temperature: 0, reasoningEffort: 'none', verbosity: 'low' },
};

const REWRITE = {
  semantic_query_en: 'sodium chloride',
  fulltext_query_en: ['salt'],
  fulltext_query_zh: ['氯化钠'],
};

async function withEnvironment(
  values: Record<string, string>,
  run: (reads: string[]) => Promise<void>,
) {
  const originalGet = Deno.env.get;
  const reads: string[] = [];
  Deno.env.get = (name: string) => {
    reads.push(name);
    return values[name];
  };
  try {
    await run(reads);
  } finally {
    Deno.env.get = originalGet;
  }
}

function successfulResponse() {
  return Response.json({
    id: 'response-test',
    object: 'response',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: JSON.stringify(REWRITE), annotations: [] }],
      },
    ],
  });
}

Deno.test(
  'structured API paths encode none and low verbosity in their respective wire fields with strict schema',
  () => {
    const responses = buildOpenAIResponsesParameters(REQUEST, 'gpt-6-luna');
    const chat = buildOpenAIChatParameters(REQUEST, 'gpt-6-luna');
    assertEquals(responses.reasoning, { effort: 'none' });
    assertEquals(chat.reasoning_effort, 'none');
    assertEquals(responses.text.verbosity, 'low');
    assertEquals(chat.verbosity, 'low');
    assertEquals(responses.text.format, {
      type: 'json_schema',
      name: REQUEST.schemaName,
      schema: hybridQuerySchema,
      strict: true,
    });
    assertEquals(chat.response_format.json_schema, {
      name: REQUEST.schemaName,
      schema: hybridQuerySchema,
      strict: true,
    });
    assertEquals(responses.temperature, 0);
    assertEquals(chat.temperature, 0);
    const generic = { ...REQUEST, options: { temperature: 0.2 } };
    assertEquals(
      Object.hasOwn(buildOpenAIResponsesParameters(generic, 'configured'), 'reasoning'),
      false,
    );
    assertEquals(
      Object.hasOwn(buildOpenAIChatParameters(generic, 'configured'), 'reasoning_effort'),
      false,
    );
    assertEquals(
      Object.hasOwn(buildOpenAIResponsesParameters(generic, 'configured').text, 'verbosity'),
      false,
    );
    assertEquals(
      Object.hasOwn(buildOpenAIChatParameters(generic, 'configured'), 'verbosity'),
      false,
    );
  },
);

Deno.test('invalid wrapper models fail before provider configuration or fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls++;
    throw new Error('provider must not be called');
  };
  try {
    await withEnvironment({ OPENAI_CHAT_MODEL: 'configured-model' }, async (reads) => {
      for (const model of ['', ' ', 'bad model', null]) {
        await assertRejects(
          () => openaiStructuredOutput({ ...REQUEST, options: { model: model as string } }),
          Error,
          'Invalid OpenAI model configuration',
        );
        await assertRejects(
          () => openaiChat('translate', { model: model as string }),
          Error,
          'Invalid OpenAI model configuration',
        );
      }
      assertEquals(reads, []);
    });
    await withEnvironment({}, async (reads) => {
      await assertRejects(
        () => openaiStructuredOutput({ ...REQUEST, options: undefined }),
        Error,
        'Missing OPENAI_CHAT_MODEL environment variable',
      );
      await assertRejects(
        () => openaiChat('translate'),
        Error,
        'Missing OPENAI_CHAT_MODEL environment variable',
      );
      assertEquals(reads, ['OPENAI_CHAT_MODEL', 'OPENAI_CHAT_MODEL']);
    });
    assertEquals(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test(
  'raw rewrite resolves its dedicated model per call while translation keeps its model',
  async () => {
    const originalFetch = globalThis.fetch;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      bodies.push(JSON.parse(await request.text()));
      assertEquals(new URL(request.url).pathname, '/v1/responses');
      return successfulResponse();
    };
    const values: Record<string, string> = {
      OPENAI_API_KEY: 'sk-fake-test-key',
      OPENAI_BASE_URL: 'https://rewrite-test.invalid/v1',
      OPENAI_CHAT_MODEL: 'translation-model',
      HYBRID_OPENAI_CHAT_MODEL: 'gpt-6-luna',
    };
    try {
      await withEnvironment(values, async () => {
        const { rewriteHybridSearchQuery } =
          await import('../supabase/functions/_shared/hybrid_search_kernel.ts');
        const config = {
          functionName: 'flow_hybrid_search',
          entityLabel: 'Flow',
          entityPlural: 'flows',
        };
        assertEquals(await rewriteHybridSearchQuery(config, '食盐'), REWRITE);
        values.HYBRID_OPENAI_CHAT_MODEL = 'gpt-5.4-nano';
        assertEquals(await rewriteHybridSearchQuery(config, '食盐'), REWRITE);
        await openaiChat('translate');
        await openaiChat('translate', { model: 'explicit-translation-model' });
        assertEquals(
          bodies.map((body) => body.model),
          ['gpt-6-luna', 'gpt-5.4-nano', 'translation-model', 'explicit-translation-model'],
        );
        assertEquals(bodies[0].reasoning, { effort: 'none' });
        assertEquals(bodies[1].reasoning, { effort: 'none' });
        assertEquals((bodies[0].text as { verbosity: unknown }).verbosity, 'low');
        assertEquals((bodies[1].text as { verbosity: unknown }).verbosity, 'low');
        assertEquals(bodies[0].temperature, 0);
        assertEquals((bodies[0].text as { format: unknown }).format, {
          type: 'json_schema',
          name: 'flow_hybrid_search_queries',
          schema: hybridQuerySchema,
          strict: true,
        });
        assertEquals(bodies[2], { model: 'translation-model', stream: false, input: 'translate' });
        assertEquals(bodies[3], {
          model: 'explicit-translation-model',
          stream: false,
          input: 'translate',
        });
        values.HYBRID_OPENAI_CHAT_MODEL = '';
        await assertRejects(
          () => rewriteHybridSearchQuery(config, '食盐'),
          Error,
          'Invalid OpenAI model configuration',
        );
        delete values.HYBRID_OPENAI_CHAT_MODEL;
        await assertRejects(
          () => rewriteHybridSearchQuery(config, '食盐'),
          Error,
          'Missing HYBRID_OPENAI_CHAT_MODEL environment variable',
        );
        assertEquals(bodies.length, 4);
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test('provider request rejection never selects a different model or API path', async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (input, init) => {
    paths.push(new URL(new Request(input, init).url).pathname);
    return Promise.resolve(
      Response.json(
        { error: { message: 'unsupported model', type: 'invalid_request_error' } },
        { status: 400 },
      ),
    );
  };
  try {
    await withEnvironment({ OPENAI_API_KEY: 'sk-fake-rejection-key' }, async () => {
      await assertRejects(() =>
        openaiStructuredOutput({
          ...REQUEST,
          options: { ...REQUEST.options, baseUrl: 'https://rejection-test.invalid/v1' },
        }),
      );
      assertEquals(paths, ['/v1/responses']);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
