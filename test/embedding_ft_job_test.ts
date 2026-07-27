import { assertEquals, assertThrows } from 'jsr:@std/assert';

import {
  allowedEmbeddingFtTables,
  EmbeddingFtJobError,
  parseEmbeddingFtJobs,
} from '../supabase/functions/_shared/embedding_ft_job.ts';

const TABLE_FUNCTIONS: Record<string, string> = {
  flows: 'flows_embedding_ft_input',
  processes: 'processes_embedding_ft_input',
  lifecyclemodels: 'lifecyclemodels_embedding_ft_input',
  contacts: 'contacts_embedding_ft_input',
  flowproperties: 'flowproperties_embedding_ft_input',
  sources: 'sources_embedding_ft_input',
  unitgroups: 'unitgroups_embedding_ft_input',
};

function job(table: string, contentFunction = TABLE_FUNCTIONS[table]) {
  return {
    jobId: 1,
    id: '11111111-1111-4111-8111-111111111111',
    version: '01.00.000',
    schema: 'public',
    table,
    contentFunction,
    embeddingColumn: 'embedding_ft',
  };
}

Deno.test('embedding_ft allowlist covers exactly the seven supported dataset tables', () => {
  assertEquals(allowedEmbeddingFtTables(), [
    'contacts',
    'flowproperties',
    'flows',
    'lifecyclemodels',
    'processes',
    'sources',
    'unitgroups',
  ]);
  const parsed = parseEmbeddingFtJobs(Object.keys(TABLE_FUNCTIONS).map((table) => job(table)));
  assertEquals(parsed.length, 7);
});

Deno.test('embedding_ft retains guarded derivative content functions', () => {
  assertEquals(
    parseEmbeddingFtJobs([
      job('flows', 'flows_derivative_rebuild_embedding_input'),
      job('processes', 'processes_derivative_rebuild_embedding_input'),
    ]).length,
    2,
  );
});

Deno.test('embedding_ft accepts canonical PostgreSQL UUID text beyond RFC version bits', () => {
  for (const id of [
    '00000000-0000-0000-0000-000000000001',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ]) {
    const [parsed] = parseEmbeddingFtJobs([{ ...job('sources'), id }]);
    assertEquals(parsed.id, id);
  }
});

Deno.test('embedding_ft rejects arbitrary schema, table, function, and column identifiers', () => {
  for (const unsafe of [
    { ...job('contacts'), schema: 'private' },
    { ...job('contacts'), table: 'profiles' },
    { ...job('contacts'), contentFunction: 'pg_read_file' },
    { ...job('contacts'), embeddingColumn: 'json' },
  ]) {
    const error = assertThrows(() => parseEmbeddingFtJobs([unsafe]), EmbeddingFtJobError);
    assertEquals(error.code, 'UNSUPPORTED_EMBEDDING_TARGET');
  }
});

Deno.test('embedding_ft rejects malformed batches before target evaluation', () => {
  const error = assertThrows(
    () => parseEmbeddingFtJobs([{ ...job('contacts'), id: 'not-a-uuid' }]),
    EmbeddingFtJobError,
  );
  assertEquals(error.code, 'INVALID_EMBEDDING_JOB_BATCH');
});
