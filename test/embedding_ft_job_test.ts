import { assertEquals, assertStringIncludes, assertThrows } from 'jsr:@std/assert';

import {
  allowedEmbeddingFtTables,
  buildEmbeddingFtContentQuery,
  embeddingFtFunctionTarget,
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

const EXPECTED_TARGETS = [
  { table: 'contacts', contentFunction: 'contacts_embedding_ft_input', schema: 'public' },
  {
    table: 'flowproperties',
    contentFunction: 'flowproperties_embedding_ft_input',
    schema: 'public',
  },
  { table: 'flows', contentFunction: 'flows_embedding_ft_input', schema: 'api' },
  {
    table: 'flows',
    contentFunction: 'flows_derivative_rebuild_embedding_input',
    schema: 'private',
  },
  {
    table: 'lifecyclemodels',
    contentFunction: 'lifecyclemodels_embedding_ft_input',
    schema: 'api',
  },
  { table: 'processes', contentFunction: 'processes_embedding_ft_input', schema: 'api' },
  {
    table: 'processes',
    contentFunction: 'processes_derivative_rebuild_embedding_input',
    schema: 'private',
  },
  { table: 'sources', contentFunction: 'sources_embedding_ft_input', schema: 'public' },
  { table: 'unitgroups', contentFunction: 'unitgroups_embedding_ft_input', schema: 'public' },
] as const;

function job(table: string, contentFunction = TABLE_FUNCTIONS[table], schema = 'public') {
  return {
    jobId: 1,
    id: '11111111-1111-4111-8111-111111111111',
    version: '01.00.000',
    schema,
    table,
    contentFunction,
    embeddingColumn: 'embedding_ft',
  };
}

Deno.test('embedding_ft allowlist covers seven tables and nine unique function targets', () => {
  assertEquals(allowedEmbeddingFtTables(), [
    'contacts',
    'flowproperties',
    'flows',
    'lifecyclemodels',
    'processes',
    'sources',
    'unitgroups',
  ]);
  assertEquals(EXPECTED_TARGETS.length, 9);
  assertEquals(
    new Set(EXPECTED_TARGETS.map(({ schema, contentFunction }) => `${schema}.${contentFunction}`))
      .size,
    9,
  );

  const parsed = parseEmbeddingFtJobs(
    EXPECTED_TARGETS.map(({ table, contentFunction }) => job(table, contentFunction)),
  );
  assertEquals(parsed.length, 9);
  assertEquals(
    parsed.map(({ table, contentFunction }) => `${table}/${contentFunction}`),
    EXPECTED_TARGETS.map(({ table, contentFunction }) => `${table}/${contentFunction}`),
  );
  assertEquals(
    parsed.map((parsedJob) => embeddingFtFunctionTarget(parsedJob)),
    EXPECTED_TARGETS.map(({ schema, contentFunction }) => ({ schema, function: contentFunction })),
  );
});

Deno.test('embedding_ft retains guarded derivative content functions', () => {
  const [flow, process] = parseEmbeddingFtJobs([
    job('flows', 'flows_derivative_rebuild_embedding_input'),
    job('processes', 'processes_derivative_rebuild_embedding_input'),
  ]);
  assertEquals(embeddingFtFunctionTarget(flow), {
    schema: 'private',
    function: 'flows_derivative_rebuild_embedding_input',
  });
  assertEquals(embeddingFtFunctionTarget(process), {
    schema: 'private',
    function: 'processes_derivative_rebuild_embedding_input',
  });
});

Deno.test('embedding_ft qualifies all canonical cutover functions with api', () => {
  const expected = {
    flows: 'flows_embedding_ft_input',
    processes: 'processes_embedding_ft_input',
    lifecyclemodels: 'lifecyclemodels_embedding_ft_input',
  };

  for (const [table, contentFunction] of Object.entries(expected)) {
    const [parsed] = parseEmbeddingFtJobs([job(table, contentFunction)]);
    assertEquals(embeddingFtFunctionTarget(parsed), {
      schema: 'api',
      function: contentFunction,
    });
  }
});

Deno.test('embedding_ft keeps unchanged foundation functions in public', () => {
  for (const table of ['contacts', 'flowproperties', 'sources', 'unitgroups']) {
    const [parsed] = parseEmbeddingFtJobs([job(table)]);
    assertEquals(embeddingFtFunctionTarget(parsed), {
      schema: 'public',
      function: TABLE_FUNCTIONS[table],
    });
  }
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
    { ...job('flows'), schema: 'private' },
    { ...job('contacts'), table: 'profiles' },
    { ...job('contacts'), contentFunction: 'pg_read_file' },
    { ...job('contacts'), embeddingColumn: 'json' },
  ]) {
    const error = assertThrows(() => parseEmbeddingFtJobs([unsafe]), EmbeddingFtJobError);
    assertEquals(error.code, 'UNSUPPORTED_EMBEDDING_TARGET');
  }
});

Deno.test('embedding_ft uses separately quoted schema and function identifiers', () => {
  const identifiers: string[] = [];
  const fakeSql = ((valueOrStrings: string | TemplateStringsArray, ...values: unknown[]) => {
    if (typeof valueOrStrings === 'string') {
      identifiers.push(valueOrStrings);
      return `quoted:${valueOrStrings}`;
    }
    return { strings: [...valueOrStrings], values };
  }) as unknown as Parameters<typeof buildEmbeddingFtContentQuery>[0];

  const [parsed] = parseEmbeddingFtJobs([job('lifecyclemodels')]);
  const query = buildEmbeddingFtContentQuery(fakeSql, parsed) as {
    strings: string[];
    values: unknown[];
  };

  assertEquals(identifiers, [
    'api',
    'lifecyclemodels_embedding_ft_input',
    'public',
    'lifecyclemodels',
  ]);
  assertStringIncludes(query.strings.join(''), 'select');
  assertEquals(query.values.slice(0, 4), [
    'quoted:api',
    'quoted:lifecyclemodels_embedding_ft_input',
    'quoted:public',
    'quoted:lifecyclemodels',
  ]);
});

Deno.test('embedding_ft rejects malformed batches before target evaluation', () => {
  const error = assertThrows(
    () => parseEmbeddingFtJobs([{ ...job('contacts'), id: 'not-a-uuid' }]),
    EmbeddingFtJobError,
  );
  assertEquals(error.code, 'INVALID_EMBEDDING_JOB_BATCH');
});
