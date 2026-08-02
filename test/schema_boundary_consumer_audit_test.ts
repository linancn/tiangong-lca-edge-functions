import { assert, assertEquals } from 'jsr:@std/assert';
import { Ajv2020 } from 'npm:ajv@8.20.0/dist/2020.js';

import {
  auditSchemaBoundary,
  classifyDynamicRelation,
  compareRelationOccurrenceInventories,
  deriveAstBoundaryViolations,
  deriveBoundaryMethodCalls,
  deriveSourceRelationOccurrences,
  exactStringSet,
  exactUniqueList,
  EXPECTED_AUTHORIZED_DATABASE_SLICE,
  EXPECTED_DATABASE_BASE_COMMIT,
  EXPECTED_DATABASE_CANDIDATE_COMMENT,
  EXPECTED_DATABASE_MIGRATION_HEAD,
  isApprovedDynamicSchema,
  isExactCoreAllowlistBinding,
  isExactSchemaBinding,
  REQUIRED_RELATION_OCCURRENCE_SCOPE,
  sha256Hex,
  sidecarMatchesDigest,
  type DynamicConsumerRegistration,
} from '../scripts/schema-boundary-consumer-audit.ts';
import {
  DATABASE_API_ACTOR_CAPABILITIES,
  DATABASE_PUBLIC_ACTOR_CAPABILITIES,
  DATABASE_PUBLIC_SERVICE_CAPABILITIES,
} from '../supabase/functions/_shared/capabilities/schema_boundary.ts';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

Deno.test(
  'official JSON Schema accepts the canonical manifest and rejects structural drift',
  async () => {
    const manifest = JSON.parse(
      await Deno.readTextFile(
        `${ROOT}/supabase/functions/_shared/capabilities/schema_boundary_manifest.v1.json`,
      ),
    );
    const schema = JSON.parse(
      await Deno.readTextFile(
        `${ROOT}/supabase/functions/_shared/capabilities/schema_boundary_manifest.v1.schema.json`,
      ),
    );
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    assertEquals(validate(manifest), true, JSON.stringify(validate.errors));

    const missingSignatureField = structuredClone(manifest);
    delete missingSignatureField.preferredApiIdentities[0].signature.resultType;
    assertEquals(validate(missingSignatureField), false);

    const extraSignatureField = structuredClone(manifest);
    extraSignatureField.preferredApiIdentities[0].signature.unreviewed = true;
    assertEquals(validate(extraSignatureField), false);

    const invalidAcl = structuredClone(manifest);
    invalidAcl.preferredApiIdentities[0].acl.state = 'implicitly-authorized';
    assertEquals(validate(invalidAcl), false);

    const missingOccurrence = structuredClone(manifest);
    missingOccurrence.relationOccurrences.pop();
    assertEquals(validate(missingOccurrence), false);

    const missingSourceAuditControl = structuredClone(manifest);
    missingSourceAuditControl.sourceAudit.controls.pop();
    assertEquals(validate(missingSourceAuditControl), false);

    const widenedActorApi = structuredClone(manifest);
    widenedActorApi.apiCapabilities.actorRoutines.push('cmd_dataset_create');
    assertEquals(validate(widenedActorApi), false);

    const widenedServiceApi = structuredClone(manifest);
    widenedServiceApi.apiCapabilities.serviceRoutines.push('cmd_dataset_extraction_claim');
    assertEquals(validate(widenedServiceApi), false);

    const staleDatabaseHead = structuredClone(manifest);
    staleDatabaseHead.databaseSource.migrationHead = '20260801131918';
    assertEquals(validate(staleDatabaseHead), false);

    const widenedAuthorizedSlice = structuredClone(manifest);
    widenedAuthorizedSlice.databaseSource.authorizedSlices[0].apiActorRoutines.push(
      'cmd_dataset_create',
    );
    assertEquals(validate(widenedAuthorizedSlice), false);
  },
);

Deno.test(
  'canonical manifest binds the deployed E3-B database head without over-authorizing',
  async () => {
    const manifest = JSON.parse(
      await Deno.readTextFile(
        `${ROOT}/supabase/functions/_shared/capabilities/schema_boundary_manifest.v1.json`,
      ),
    );
    assertEquals(manifest.databaseSource.baseCommit, EXPECTED_DATABASE_BASE_COMMIT);
    assertEquals(manifest.databaseSource.migrationHead, EXPECTED_DATABASE_MIGRATION_HEAD);
    assertEquals(manifest.databaseSource.candidateComment, EXPECTED_DATABASE_CANDIDATE_COMMENT);
    assertEquals(manifest.databaseSource.state, 'candidate-not-frozen');
    assertEquals(manifest.databaseSource.authorization, 'not-authorized');
    assertEquals(manifest.databaseSource.authorizedSlices, [EXPECTED_AUTHORIZED_DATABASE_SLICE]);
    assertEquals(manifest.databaseSource.frozenManifest, {
      path: null,
      sha256: null,
      sidecarPath: null,
      contentFingerprintSha256: null,
      edgeExposureFingerprintSha256: null,
      commit: null,
      reviewComment: null,
    });
  },
);

Deno.test(
  'schema boundary expand audit has no unregistered consumers and inventories all 48 relation occurrences',
  async () => {
    const result = await auditSchemaBoundary(ROOT, 'expand');
    assertEquals(result.findings, []);
    assertEquals(result.counts.requirementOccurrences, 48);
    assertEquals(result.counts.apiRoutines, 1);
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

Deno.test(
  'every actor and service routine is required by both typed and observed inventories',
  () => {
    for (const routines of [
      Object.values(DATABASE_API_ACTOR_CAPABILITIES),
      Object.values(DATABASE_PUBLIC_ACTOR_CAPABILITIES),
      Object.values(DATABASE_PUBLIC_SERVICE_CAPABILITIES),
    ]) {
      for (const routine of routines) {
        assertEquals(
          exactStringSet(
            routines,
            routines.filter((candidate) => candidate !== routine),
          ),
          false,
          `removing ${routine} must fail the routine inventory`,
        );
      }
    }
    for (const capabilityIds of [
      Object.keys(DATABASE_API_ACTOR_CAPABILITIES),
      Object.keys(DATABASE_PUBLIC_ACTOR_CAPABILITIES),
      Object.keys(DATABASE_PUBLIC_SERVICE_CAPABILITIES),
    ]) {
      for (const capabilityId of capabilityIds) {
        assertEquals(
          exactStringSet(
            capabilityIds,
            capabilityIds.filter((candidate) => candidate !== capabilityId),
          ),
          false,
          `removing observed ${capabilityId} must fail the capability inventory`,
        );
      }
    }
    assertEquals(exactUniqueList(['one', 'one'], ['one', 'two']), false);
  },
);

Deno.test(
  'AST audit rejects multiline variables, bracket calls, destructuring, and detached methods',
  () => {
    const source = `
const table = request.table;
const { rpc } = client;
const detached = client.schema;
client['from']('processes');
client.from(
  table
);
rpc('unsafe');
`;
    const violations = deriveAstBoundaryViolations(
      'bypass.ts',
      source,
      [],
      [],
      ['api'],
      new Map([['bypass.ts', source]]),
    );
    const kinds = violations.map((finding) => finding.kind);
    assert(kinds.includes('destructured-data-api-method'));
    assert(kinds.includes('detached-data-api-method'));
    assert(kinds.includes('computed-data-api-call'));
    assert(kinds.includes('ast-unregistered-dynamic-from'));
    assert(kinds.includes('detached-data-api-call'));
  },
);

Deno.test(
  'Supabase client alias chains and constant computed calls are derived and rejected',
  () => {
    const source = `
const origin = createClient();
const firstAlias = origin;
let assignedAlias;
assignedAlias = firstAlias;
const prefix = 'fr';
const method = prefix + 'om';
function query(db, operation) {
  return db[operation]('lca_result_cache').select('id');
}
query(assignedAlias, method);
`;
    const occurrences = deriveSourceRelationOccurrences(
      'alias.ts',
      source,
      new Set(['lca_result_cache']),
    );
    assertEquals(occurrences.length, 1);
    assertEquals(occurrences[0].relation, 'lca_result_cache');
    assertEquals(occurrences[0].operation, 'select');

    const violations = deriveAstBoundaryViolations(
      'alias.ts',
      source,
      [],
      [],
      ['api'],
      new Map([['alias.ts', source]]),
    );
    assert(
      violations.some((finding) => finding.kind === 'computed-data-api-call'),
      'a constant-folded computed .from call must not bypass the audit',
    );
  },
);

Deno.test('unknown computed methods fail closed across aliases and local parameter passing', () => {
  const source = `
const origin = createSupabaseServiceClient();
const alias = origin;
function passthrough(value) {
  return value;
}
const wrappedAlias = passthrough(alias);
function invoke(db, method) {
  return db[method]('lca_result_cache');
}
invoke(wrappedAlias, request.method);
`;
  const violations = deriveAstBoundaryViolations(
    'parameter.ts',
    source,
    [],
    [],
    ['api'],
    new Map([['parameter.ts', source]]),
  );
  assert(
    violations.some((finding) => finding.kind === 'unknown-computed-data-api-call'),
    'an unresolved method on a client passed through a parameter must fail closed',
  );
});

Deno.test('object property aliases cannot hide computed Supabase client calls', () => {
  const source = `
const client = createClient();
const holder = { db: client };
const nested = { holder };
const harmless = { db: { invoke: () => undefined } };
holder.db['r' + 'pc']('cmd_dataset_create');
holder.db[request.method]('cmd_dataset_create');
nested.holder.db['r' + 'pc']('cmd_dataset_create');
harmless.db[request.method]('not-a-supabase-call');
`;
  const violations = deriveAstBoundaryViolations(
    'object-property-alias.ts',
    source,
    [],
    [],
    ['api'],
    new Map([['object-property-alias.ts', source]]),
  );
  assertEquals(violations.filter((finding) => finding.kind === 'computed-data-api-call').length, 2);
  assertEquals(
    violations.filter((finding) => finding.kind === 'unknown-computed-data-api-call').length,
    1,
  );
});

Deno.test('client aliases cannot detach or destructure schema-boundary methods', () => {
  const source = `
const context = { supabase: createClient() };
const { supabase: alias } = context;
const { rpc: invoke } = alias;
const detached = alias['schema'];
invoke('unsafe');
`;
  const violations = deriveAstBoundaryViolations(
    'detach.ts',
    source,
    [],
    [],
    ['api'],
    new Map([['detach.ts', source]]),
  );
  const kinds = violations.map((finding) => finding.kind);
  assert(kinds.includes('destructured-data-api-method'));
  assert(kinds.includes('detached-data-api-method'));
});

Deno.test('dynamic capability abstraction call expressions and counts are exact', () => {
  const exact = `
const schema = client.schema(API_SCHEMA);
schema.rpc(apiRoutine, args);
client.rpc(publicRoutine, args);
schema.from(relation);
`;
  assertEquals(deriveBoundaryMethodCalls(exact), {
    'schema:API_SCHEMA': 1,
    'rpc:apiRoutine': 1,
    'rpc:publicRoutine': 1,
    'from:relation': 1,
  });
  assertEquals(deriveBoundaryMethodCalls(`${exact}\nschema.from(otherRelation);`), {
    'schema:API_SCHEMA': 1,
    'rpc:apiRoutine': 1,
    'rpc:publicRoutine': 1,
    'from:relation': 1,
    'from:otherRelation': 1,
  });
});

Deno.test(
  'source-derived relation occurrence inventory rejects additions, deletion, and duplicates',
  () => {
    const source = `
const one = client.from('lca_result_cache').select('id');
const two = client.from('lca_result_cache').update({ status: 'ready' });
`;
    const derived = deriveSourceRelationOccurrences(
      'consumer.ts',
      source,
      new Set(['lca_result_cache']),
    );
    assertEquals(derived.length, 2);
    assertEquals(
      derived.map((item) => item.operation),
      ['select', 'update'],
    );
    assertEquals(
      compareRelationOccurrenceInventories(derived, structuredClone(derived)).exact,
      true,
    );

    const missing = compareRelationOccurrenceInventories(derived, [derived[0]]);
    assertEquals(missing.exact, false);
    assertEquals(missing.missingFromManifest.length, 1);

    const stale = compareRelationOccurrenceInventories([derived[0]], derived);
    assertEquals(stale.exact, false);
    assertEquals(stale.staleInManifest.length, 1);

    const duplicate = compareRelationOccurrenceInventories(derived, [
      ...derived,
      structuredClone(derived[0]),
    ]);
    assertEquals(duplicate.exact, false);
    assertEquals(duplicate.duplicateManifest.length, 1);
    assertEquals(
      exactStringSet(
        REQUIRED_RELATION_OCCURRENCE_SCOPE,
        REQUIRED_RELATION_OCCURRENCE_SCOPE.slice(1),
      ),
      false,
    );
  },
);

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
    assert(result.findings.some((finding) => finding.kind === 'database-freeze-pending'));
  },
);
