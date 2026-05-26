import { assertEquals } from 'jsr:@std/assert';

import {
  classifyEmbeddingJobError,
  parsePositiveInteger,
} from '../supabase/functions/_shared/embedding_queue_runtime.ts';

Deno.test('parsePositiveInteger uses fallback for missing or invalid values', () => {
  assertEquals(parsePositiveInteger(undefined, 300), 300);
  assertEquals(parsePositiveInteger('', 300), 300);
  assertEquals(parsePositiveInteger('0', 300), 300);
  assertEquals(parsePositiveInteger('-1', 300), 300);
  assertEquals(parsePositiveInteger('abc', 300), 300);
  assertEquals(parsePositiveInteger('120', 300), 120);
});

Deno.test('classifyEmbeddingJobError marks lock and statement timeouts retryable', () => {
  assertEquals(classifyEmbeddingJobError({ code: '55P03', message: 'lock timeout' }), {
    category: 'db_lock_timeout',
    code: '55P03',
    message: 'lock timeout',
    retryable: true,
  });

  assertEquals(
    classifyEmbeddingJobError({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    }),
    {
      category: 'db_statement_timeout',
      code: '57014',
      message: 'canceling statement due to statement timeout',
      retryable: true,
    },
  );
});

Deno.test('classifyEmbeddingJobError leaves unexpected errors non-retryable', () => {
  assertEquals(classifyEmbeddingJobError(new Error('SageMaker failed')), {
    category: 'unexpected',
    code: undefined,
    message: 'SageMaker failed',
    retryable: false,
  });
});
