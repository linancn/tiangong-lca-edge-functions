import { assert, assertEquals } from 'jsr:@std/assert';

import {
  auditSchemaBoundary,
  classifyDynamicRelation,
  isApprovedDynamicSchema,
  isExactCoreAllowlistBinding,
  isExactSchemaBinding,
  sha256Hex,
  sidecarMatchesDigest,
  type DynamicConsumerRegistration,
} from '../scripts/schema-boundary-consumer-audit.ts';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

Deno.test(
  'schema boundary expand audit has no unregistered consumers and inventories all 48 relation occurrences',
  async () => {
    const result = await auditSchemaBoundary(ROOT, 'expand');
    assertEquals(result.findings, []);
    assertEquals(result.counts.requirementOccurrences, 48);
    assert(result.pending.length > 0, 'expand phase must not claim consumer-zero before DB #357');
  },
);

Deno.test('dynamic schema and relation registrations are exact-expression fail-closed', () => {
  const registrations: DynamicConsumerRegistration[] = [
    {
      file: 'capability.ts',
      kind: 'api-abstraction',
      schemaExpressions: ['API_SCHEMA'],
      allowedSchemas: ['api'],
      schemaSource: { file: 'capability.ts', symbol: 'API_SCHEMA' },
      relationExpressions: ['relation'],
    },
    {
      file: 'datasets.ts',
      kind: 'core-table-allowlist',
      expressions: ['request.table'],
      allowedRelations: ['processes'],
      allowlistSource: { file: 'datasets.ts', symbol: 'DATASET_TABLES' },
    },
  ];
  const sourceByFile = new Map([
    ['capability.ts', "export const API_SCHEMA = 'api' as const;"],
    ['datasets.ts', "export const DATASET_TABLES = ['processes'] as const;"],
  ]);

  assertEquals(
    isApprovedDynamicSchema(registrations, ['api'], 'capability.ts', 'API_SCHEMA', sourceByFile),
    true,
  );
  assertEquals(
    isApprovedDynamicSchema(
      registrations,
      ['api'],
      'capability.ts',
      'request.schema',
      sourceByFile,
    ),
    false,
  );
  assertEquals(
    classifyDynamicRelation(registrations, [], 'datasets.ts', 'request.table'),
    'approved',
  );
  assertEquals(classifyDynamicRelation(registrations, [], 'datasets.ts', 'otherTable'), null);
  assertEquals(classifyDynamicRelation(registrations, [], 'other.ts', 'request.table'), null);
});

Deno.test('core relation allowlist is bound to the exact canonical const initializer', () => {
  const registration: DynamicConsumerRegistration = {
    file: 'consumer.ts',
    kind: 'core-table-allowlist',
    expressions: ['table'],
    allowedRelations: ['processes'],
    allowlistSource: { file: 'allowlist.ts', symbol: 'CORE_TABLES' },
  };

  assertEquals(
    isExactCoreAllowlistBinding(
      registration,
      new Map([
        [
          'allowlist.ts',
          "const UNRELATED = 'processes' as const; const CORE_TABLES = ['flows'] as const;",
        ],
      ]),
    ),
    false,
  );
  assertEquals(
    isExactCoreAllowlistBinding(
      registration,
      new Map([['allowlist.ts', "const CORE_TABLES = ['processes', 'private_jobs'] as const;"]]),
    ),
    false,
  );
  assertEquals(
    isExactCoreAllowlistBinding(
      registration,
      new Map([['allowlist.ts', "const CORE_TABLES = ['processes'] as const;"]]),
    ),
    true,
  );
});

Deno.test('dynamic schema is bound to the exact canonical const initializer', () => {
  const registration: DynamicConsumerRegistration = {
    file: 'consumer.ts',
    kind: 'api-abstraction',
    schemaExpressions: ['API_SCHEMA'],
    allowedSchemas: ['api'],
    schemaSource: { file: 'schema.ts', symbol: 'API_SCHEMA' },
  };

  assertEquals(
    isExactSchemaBinding(
      registration,
      new Map([
        ['schema.ts', "const API_SCHEMA = 'private' as const; const UNRELATED = 'api' as const;"],
      ]),
    ),
    false,
  );
  assertEquals(
    isExactSchemaBinding(
      registration,
      new Map([['schema.ts', "const API_SCHEMA = 'api' as const;"]]),
    ),
    true,
  );
});

Deno.test('manifest sidecar verification fails when canonical bytes change', async () => {
  const canonical = new TextEncoder().encode('{"version":1}\n');
  const changed = new TextEncoder().encode('{"version":2}\n');
  const digest = await sha256Hex(canonical);

  assertEquals(sidecarMatchesDigest(`${digest}  manifest.json\n`, digest), true);
  assertEquals(sidecarMatchesDigest(`${digest}  manifest.json\n`, await sha256Hex(changed)), false);
});

Deno.test(
  'schema boundary contract profile fails closed while public residue remains',
  async () => {
    const result = await auditSchemaBoundary(ROOT, 'contract');
    assertEquals(result.ok, false);
    assert(result.findings.some((finding) => finding.kind === 'public-relation-residue'));
    assert(result.findings.some((finding) => finding.kind.includes('routine-residue')));
  },
);
