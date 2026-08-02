const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CAPABILITY_PATH,
  STABLE_ROUTINES,
  analyzeRepository,
  analyzeSource,
} = require('../scripts/lca-result-family-consumer-zero.cjs');

function kinds(source, file = 'supabase/functions/lca_solve/index.ts') {
  return analyzeSource(source, file).map((finding) => finding.kind);
}

test('detects direct, concatenated, template, const-alias, and frozen-property relations', () => {
  const source = [
    "const prefix = 'lca_';",
    "const direct = 'lca_results';",
    'const alias = direct;',
    "const contract = Object.freeze({ table: prefix + 'result_cache' });",
    "client.from('lca_latest_all_unit_results');",
    "client.from(prefix + 'factorization_registry');",
    'client.from(`${prefix}results`);',
    'client.from(alias);',
    "client.from(contract['table']);",
  ].join('\n');
  assert.deepEqual(kinds(source), Array(5).fill('target-relation'));
});

test('detects computed, optional-chain, and type-asserted Data API calls', () => {
  const source = `
    const method = 'fr' + 'om';
    (client as any)[method]?.('lca_results');
    (client as any)?.from?.('lca_result_cache');
    client['r' + 'pc']('lca_read_result_projection');
  `;
  assert.deepEqual(kinds(source), [
    'target-relation',
    'target-relation',
    'legacy-rpc',
    'owner-direct-rpc',
  ]);
});

test('detects destructured, bound, and Reflect.get method aliases', () => {
  const source = `
    const { from: readTable } = client;
    const callRpc = client.rpc.bind(client);
    const reflectedFrom = Reflect.get(client, 'from');
    readTable('lca_results');
    callRpc('lca_read_result_projection', {});
    reflectedFrom('lca_result_cache');
  `;
  assert.deepEqual(kinds(source), [
    'target-relation',
    'legacy-rpc',
    'owner-direct-rpc',
    'target-relation',
  ]);
});

test('distinguishes Storage buckets and Array.from from database relations', () => {
  const source = `
    client.storage.from('lca_results').download('object');
    client['storage']['from']('lca_result_cache').download('object');
    const { from: storageFrom } = client.storage;
    storageFrom('lca_factorization_registry');
    Array.from(['lca_latest_all_unit_results']);
  `;
  assert.deepEqual(kinds(source), []);
});

test('rejects dynamic result-family identifiers, schema fallback, and direct owner RPC', () => {
  const source = `
    client.from(tableName);
    client.schema(prefix + suffix).rpc(routineName, {});
    client.schema('private').rpc('some_ninth_result_query_v1', {});
  `;
  assert.deepEqual(kinds(source), [
    'dynamic-relation',
    'dynamic-rpc',
    'owner-direct-rpc',
    'dynamic-schema',
    'owner-direct-rpc',
    'schema-fallback',
  ]);
});

test('confines stable v1 routines and rejects legacy wrapper imports', () => {
  const source = `
    import { old } from '../_shared/db_rpc/lca_results.ts';
    client.rpc('lca_read_result_projection_v1', {});
  `;
  assert.deepEqual(kinds(source), ['legacy-import', 'escaped-stable-rpc', 'owner-direct-rpc']);
});

test('capability permits only reviewed internal routine selectors', () => {
  assert.deepEqual(
    kinds(
      'client.schema("api").rpc(routine, {});',
      'supabase/functions/_shared/capabilities/lca_result_family.ts',
    ),
    [],
  );
  assert.deepEqual(
    kinds(
      'client.schema("api").rpc(userSelectedRoutine, {});',
      'supabase/functions/_shared/capabilities/lca_result_family.ts',
    ),
    ['dynamic-rpc'],
  );
});

test('detects legacy and stable routine names passed through generic helper functions', () => {
  const source = `
    const prefix = 'lca_read_';
    callProjection(client, prefix + 'job_projection', {});
    callProjection(client, 'lca_read_result_projection_v1', {});
  `;
  assert.deepEqual(kinds(source), ['legacy-rpc', 'escaped-stable-rpc']);
});

test('detects raw SQL/query/unsafe target and legacy routine escapes', () => {
  const source = [
    "const table = 'lca_' + 'results';",
    'sql`select * from ${table}`;',
    "client.unsafe('select * from public.' + 'lca_result_cache');",
    "client.query('select lca_read_' + 'job_projection()');",
    'client.query(dynamicSql);',
  ].join('\n');
  assert.deepEqual(kinds(source), [
    'raw-sql-relation',
    'raw-sql-relation',
    'raw-sql-legacy-rpc',
    'dynamic-raw-sql',
  ]);
});

test('detects SQL passed to a generic helper without matching ordinary log text', () => {
  const source = `
    executeSql('select * from ' + 'public.lca_results');
    console.log('query lca_results failed');
  `;
  assert.deepEqual(kinds(source), ['raw-sql-relation']);
});

test('comments, log text, and HTTP or Storage paths are not executable consumers', () => {
  const source = `
    // client.from('lca_results')
    console.log('lca_result_cache');
    console.error('update lca_result_cache failed');
    console.warn('insert lca_latest_all_unit_results failed');
    const url = '/functions/v1/lca_results';
    const bucket = 'storage://lca_results/path';
  `;
  assert.deepEqual(kinds(source), []);
});

test('known unrelated generic repositories require exact allowlisted expressions', () => {
  assert.deepEqual(
    kinds('client.from(table);', 'supabase/functions/_shared/dataset_extraction_worker.ts'),
    [],
  );
  assert.deepEqual(
    kinds('client.from(otherTable);', 'supabase/functions/_shared/dataset_extraction_worker.ts'),
    ['dynamic-relation'],
  );
});

test('repository audit accepts an exact capability-only fixture', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-result-consumer-zero-'));
  try {
    const capability = path.join(root, CAPABILITY_PATH);
    fs.mkdirSync(path.dirname(capability), { recursive: true });
    const routineProperties = [...STABLE_ROUTINES]
      .map((routine, index) => `r${index}: '${routine}'`)
      .join(',\n');
    fs.writeFileSync(
      capability,
      `
        const contract = Object.freeze({ schema: 'api', routines: { ${routineProperties} } });
        export function repository(client: any) {
          const api = client.schema(contract.schema);
          return { call: (routine: string) => api.rpc(routine, {}) };
        }
      `,
    );
    assert.deepEqual(analyzeRepository(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
