import { assertEquals } from 'jsr:@std/assert';

import { embeddingFtPostgresOptions } from '../supabase/functions/_shared/embedding_ft_postgres.ts';

Deno.test('embedding_ft bounds each Edge isolate database pool', () => {
  assertEquals(embeddingFtPostgresOptions(), {
    max: 1,
    idle_timeout: 20,
    max_lifetime: 300,
    connection: {
      application_name: 'embedding-ft-edge',
    },
  });
});
