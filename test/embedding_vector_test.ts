import { assertEquals, assertThrows } from 'jsr:@std/assert';

import {
  EMBEDDING_FT_DIMENSIONS,
  EmbeddingVectorError,
  extractEmbeddingVector,
} from '../supabase/functions/_shared/embedding_vector.ts';

Deno.test('extractEmbeddingVector reads nested model responses at exactly 1024 dimensions', () => {
  const vector = Array.from({ length: EMBEDDING_FT_DIMENSIONS }, (_, index) => index / 1024);
  assertEquals(extractEmbeddingVector({ data: JSON.stringify({ embeddings: [vector] }) }), vector);
});

Deno.test('extractEmbeddingVector rejects wrong dimensions', () => {
  const error = assertThrows(
    () => extractEmbeddingVector({ embedding: [0.1, 0.2] }),
    EmbeddingVectorError,
  );
  assertEquals(error.code, 'EMBEDDING_DIMENSION_MISMATCH');
});

Deno.test('extractEmbeddingVector rejects non-finite values', () => {
  const error = assertThrows(
    () => extractEmbeddingVector({ embedding: [Number.NaN] }),
    EmbeddingVectorError,
  );
  assertEquals(error.code, 'EMBEDDING_VECTOR_MISSING');
});
