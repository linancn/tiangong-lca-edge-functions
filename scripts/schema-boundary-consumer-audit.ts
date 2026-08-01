export type SchemaBoundaryProfile = 'expand' | 'contract';

export type SchemaBoundaryFinding = {
  file: string;
  line: number;
  kind: string;
  object?: string;
  message: string;
};

export type SchemaBoundaryAudit = {
  profile: SchemaBoundaryProfile;
  ok: boolean;
  findings: SchemaBoundaryFinding[];
  pending: SchemaBoundaryFinding[];
  counts: {
    files: number;
    staticPublicRelations: number;
    staticPublicRoutines: number;
    apiRelations: number;
    apiRoutines: number;
    requirementOccurrences: number;
  };
};

export type DynamicConsumerRegistration = {
  file: string;
  kind: string;
  expressions?: string[];
  relationExpressions?: string[];
  schemaExpressions?: string[];
  allowedSchemas?: string[];
  schemaSource?: { file: string; symbol: string };
  allowedRelations?: string[];
  allowlistSource?: { file: string; symbol: string };
};

type Manifest = {
  canonicalization: { algorithm: 'sha256'; sidecar: string };
  policy: { retainedPublicTables: string[]; allowedPostgrestSchemas: string[] };
  apiCapabilities: {
    relations: string[];
    actorRoutines: string[];
    serviceRoutines: string[];
  };
  publicResidue: {
    relations: string[];
    routines: string[];
    dynamicRpcFiles: string[];
  };
  dynamicConsumers: DynamicConsumerRegistration[];
  platformConsumers: {
    directPostgres: Array<{ file: string; status: string }>;
    pgmq: Array<{ file: string; status: string }>;
    storage: Array<{ file: string; expressions: string[] }>;
  };
  relationOccurrences: Array<{
    file: string;
    line: number;
    relation: string;
    operation: string;
    fields: unknown;
    filters: unknown;
    order: unknown;
    limit: unknown;
    ownership: unknown;
    atomicityGroup: unknown;
    idempotencyCas: unknown;
  }>;
};

export function isApprovedDynamicSchema(
  registrations: DynamicConsumerRegistration[],
  allowedPostgrestSchemas: string[],
  file: string,
  expression: string,
  sourceByFile: ReadonlyMap<string, string>,
): boolean {
  const registration = registrations.find(
    (entry) => entry.file === file && entry.schemaExpressions?.includes(expression),
  );
  const allowedSchemas = registration?.allowedSchemas ?? [];
  return Boolean(
    Boolean(registration) &&
    allowedSchemas.length > 0 &&
    allowedSchemas.every((schema) => allowedPostgrestSchemas.includes(schema)) &&
    registration &&
    isExactSchemaBinding(registration, sourceByFile),
  );
}

function escaped(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseConstString(source: string, symbol: string): string | null {
  const match = source.match(
    new RegExp(
      `(?:export\\s+)?const\\s+${escaped(symbol)}\\s*=\\s*(['"])([^'"]+)\\1\\s+as\\s+const\\s*;`,
    ),
  );
  return match?.[2] ?? null;
}

export function parseConstStringArray(source: string, symbol: string): string[] | null {
  const match = source.match(
    new RegExp(
      `(?:export\\s+)?const\\s+${escaped(symbol)}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as\\s+const\\s*;`,
    ),
  );
  if (!match) return null;
  const values = [...match[1].matchAll(/(['"])([^'"]+)\1/g)].map((item) => item[2]);
  const residue = match[1]
    .replaceAll(/(['"])([^'"]+)\1/g, '')
    .replaceAll(',', '')
    .trim();
  return residue.length === 0 ? values : null;
}

export function isExactSchemaBinding(
  registration: DynamicConsumerRegistration,
  sourceByFile: ReadonlyMap<string, string>,
): boolean {
  const binding = registration.schemaSource;
  if (!binding || registration.allowedSchemas?.length !== 1) return false;
  const source = sourceByFile.get(binding.file);
  return Boolean(
    source && parseConstString(source, binding.symbol) === registration.allowedSchemas[0],
  );
}

export function isExactCoreAllowlistBinding(
  registration: DynamicConsumerRegistration,
  sourceByFile: ReadonlyMap<string, string>,
): boolean {
  const binding = registration.allowlistSource;
  if (!binding || !registration.allowedRelations) return false;
  const source = sourceByFile.get(binding.file);
  const actual = source ? parseConstStringArray(source, binding.symbol) : null;
  return Boolean(
    actual &&
    actual.length === registration.allowedRelations.length &&
    actual.every((relation, index) => relation === registration.allowedRelations?.[index]),
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function sidecarMatchesDigest(sidecar: string, digest: string): boolean {
  return sidecar.trim().split(/\s+/)[0] === digest;
}

export function classifyDynamicRelation(
  registrations: DynamicConsumerRegistration[],
  storage: Array<{ file: string; expressions: string[] }>,
  file: string,
  expression: string,
): 'approved' | 'retire' | null {
  const dynamicRegistration = registrations.find(
    (entry) =>
      entry.file === file &&
      (entry.expressions?.includes(expression) || entry.relationExpressions?.includes(expression)),
  );
  if (dynamicRegistration) {
    return dynamicRegistration.kind === 'retire-unbounded-relation-helper' ? 'retire' : 'approved';
  }
  return storage.some((entry) => entry.file === file && entry.expressions.includes(expression))
    ? 'approved'
    : null;
}

const MANIFEST_PATH = 'supabase/functions/_shared/capabilities/schema_boundary_manifest.v1.json';
const FUNCTIONS_PATH = 'supabase/functions';

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function relativePath(root: string, file: string): string {
  return file.slice(root.endsWith('/') ? root.length : root.length + 1);
}

async function tsFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) files.push(...(await tsFiles(path)));
    else if (entry.isFile && entry.name.endsWith('.ts')) files.push(path);
  }
  return files.toSorted();
}

function addFinding(
  target: SchemaBoundaryFinding[],
  file: string,
  source: string,
  offset: number,
  kind: string,
  message: string,
  object?: string,
) {
  target.push({
    file,
    line: lineNumber(source, offset),
    kind,
    object,
    message,
  });
}

export async function auditSchemaBoundary(
  root: string,
  profile: SchemaBoundaryProfile = 'expand',
): Promise<SchemaBoundaryAudit> {
  const manifestBytes = await Deno.readFile(`${root}/${MANIFEST_PATH}`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  const retainedPublic = new Set(manifest.policy.retainedPublicTables);
  const pendingRelations = new Set(manifest.publicResidue.relations);
  const pendingRoutines = new Set(manifest.publicResidue.routines);
  const apiRelations = new Set(manifest.apiCapabilities.relations);
  const apiRoutines = new Set([
    ...manifest.apiCapabilities.actorRoutines,
    ...manifest.apiCapabilities.serviceRoutines,
  ]);
  const findings: SchemaBoundaryFinding[] = [];
  const pending: SchemaBoundaryFinding[] = [];
  const files = await tsFiles(`${root}/${FUNCTIONS_PATH}`);
  let staticPublicRelations = 0;
  let staticPublicRoutines = 0;
  let apiRelationCount = 0;
  let apiRoutineCount = 0;

  const manifestDigest = await sha256Hex(manifestBytes);
  const sidecar = await Deno.readTextFile(`${root}/${manifest.canonicalization.sidecar}`);
  if (
    manifest.canonicalization.algorithm !== 'sha256' ||
    !sidecarMatchesDigest(sidecar, manifestDigest)
  ) {
    findings.push({
      file: manifest.canonicalization.sidecar,
      line: 1,
      kind: 'manifest-digest-mismatch',
      object: manifestDigest,
      message: 'canonical schema-boundary manifest SHA-256 sidecar does not match',
    });
  }

  const sourceByFile = new Map<string, string>();
  for (const absoluteFile of files) {
    const file = relativePath(root, absoluteFile);
    const source = await Deno.readTextFile(absoluteFile);
    sourceByFile.set(file, source);

    for (const match of source.matchAll(/\.schema\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const schema = match[1];
      if (!manifest.policy.allowedPostgrestSchemas.includes(schema)) {
        addFinding(
          findings,
          file,
          source,
          match.index,
          'postgrest-schema',
          `PostgREST schema ${schema} is outside the schema-boundary contract`,
          schema,
        );
      }
    }

    for (const match of source.matchAll(/\.schema\(\s*([^)\n]+)\)/g)) {
      const expression = match[1].trim();
      if (expression.startsWith("'") || expression.startsWith('"')) continue;
      if (
        !isApprovedDynamicSchema(
          manifest.dynamicConsumers,
          manifest.policy.allowedPostgrestSchemas,
          file,
          expression,
          sourceByFile,
        )
      ) {
        addFinding(
          findings,
          file,
          source,
          match.index,
          'unregistered-dynamic-schema',
          `dynamic .schema(${expression}) is not bound to an exact approved schema constant`,
          expression,
        );
      }
    }

    for (const match of source.matchAll(/\.from\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g)) {
      const relation = match[1];
      staticPublicRelations += 1;
      if (retainedPublic.has(relation)) continue;
      if (pendingRelations.has(relation)) {
        addFinding(
          pending,
          file,
          source,
          match.index,
          'public-relation-residue',
          `public.${relation} still requires an api capability`,
          relation,
        );
      } else {
        addFinding(
          findings,
          file,
          source,
          match.index,
          'unregistered-public-relation',
          `public.${relation} is neither retained nor registered as migration residue`,
          relation,
        );
      }
    }

    for (const match of source.matchAll(/\.rpc\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
      const routine = match[1];
      staticPublicRoutines += 1;
      if (pendingRoutines.has(routine)) {
        addFinding(
          pending,
          file,
          source,
          match.index,
          'public-routine-residue',
          `unqualified routine ${routine} still requires an api alias`,
          routine,
        );
      } else {
        addFinding(
          findings,
          file,
          source,
          match.index,
          'unregistered-public-routine',
          `unqualified routine ${routine} is not registered`,
          routine,
        );
      }
    }

    for (const match of source.matchAll(/fromDatabaseApi\([^,]+,\s*['"]([A-Za-z0-9_]+)['"]/g)) {
      const relation = match[1];
      apiRelationCount += 1;
      if (!apiRelations.has(relation)) {
        addFinding(
          findings,
          file,
          source,
          match.index,
          'unregistered-api-relation',
          `api.${relation} is not registered in apiCapabilities.relations`,
          relation,
        );
      }
    }

    for (const match of source.matchAll(/callDatabaseApiRpc\([^,]+,\s*['"]([A-Za-z0-9_]+)['"]/g)) {
      const routine = match[1];
      apiRoutineCount += 1;
      if (!apiRoutines.has(routine)) {
        addFinding(
          findings,
          file,
          source,
          match.index,
          'unregistered-api-routine',
          `api.${routine} is not registered in apiCapabilities`,
          routine,
        );
      }
    }

    for (const match of source.matchAll(/\.from\(\s*([^)\n]+)\)/g)) {
      const expression = match[1].trim();
      if (expression.startsWith("'") || expression.startsWith('"')) continue;
      const line = source.slice(
        source.lastIndexOf('\n', match.index) + 1,
        source.indexOf('\n', match.index),
      );
      if (line.includes('Array.from') || line.includes('Uint8Array')) continue;
      const classification = classifyDynamicRelation(
        manifest.dynamicConsumers,
        manifest.platformConsumers.storage,
        file,
        expression,
      );
      if (!classification) {
        addFinding(
          findings,
          file,
          source,
          match.index,
          'unregistered-dynamic-from',
          `dynamic .from(${expression}) has no reviewed allowlist or Storage registration`,
          expression,
        );
      } else if (classification === 'retire') {
        addFinding(
          pending,
          file,
          source,
          match.index,
          'dynamic-relation-helper-retirement',
          `dynamic .from(${expression}) helper has no enforceable relation allowlist and must retire`,
          expression,
        );
      }
    }

    for (const match of source.matchAll(/\.rpc\(\s*([^,\n)]+)/g)) {
      const expression = match[1].trim();
      if (expression.startsWith("'") || expression.startsWith('"')) continue;
      const registered =
        manifest.publicResidue.dynamicRpcFiles.includes(file) ||
        manifest.dynamicConsumers.some(
          (entry) => entry.file === file && entry.kind === 'api-abstraction',
        );
      if (!registered) {
        addFinding(
          findings,
          file,
          source,
          match.index,
          'unregistered-dynamic-rpc',
          `dynamic .rpc(${expression}) has no capability registration`,
          expression,
        );
      } else if (manifest.publicResidue.dynamicRpcFiles.includes(file)) {
        addFinding(
          pending,
          file,
          source,
          match.index,
          'dynamic-public-routine-residue',
          'dynamic unqualified RPC helper remains in the public-schema migration ledger',
          expression,
        );
      }
    }

    if (/from\s+['"]postgres['"]/.test(source)) {
      const registration = manifest.platformConsumers.directPostgres.find(
        (entry) => entry.file === file,
      );
      if (!registration) {
        addFinding(
          findings,
          file,
          source,
          source.search(/from\s+['"]postgres['"]/),
          'unregistered-direct-postgres',
          'direct Postgres client is not registered',
        );
      } else if (registration.status === 'retire') {
        addFinding(
          pending,
          file,
          source,
          source.search(/from\s+['"]postgres['"]/),
          'direct-postgres-retirement',
          'direct Postgres consumer is explicitly scheduled for retirement',
        );
      }
    }

    if (/\bpgmq\./.test(source)) {
      const registration = manifest.platformConsumers.pgmq.find((entry) => entry.file === file);
      if (!registration) {
        addFinding(
          findings,
          file,
          source,
          source.search(/\bpgmq\./),
          'unregistered-pgmq',
          'direct PGMQ operation is not registered',
        );
      }
    }
  }

  for (const routine of apiRoutines) {
    const referenced = [...sourceByFile.values()].some(
      (source) => source.includes(`'${routine}'`) || source.includes(`"${routine}"`),
    );
    if (!referenced) {
      findings.push({
        file: MANIFEST_PATH,
        line: 1,
        kind: 'stale-api-routine-registration',
        object: routine,
        message: `registered api routine ${routine} has no source reference`,
      });
    }
  }

  for (const registration of manifest.dynamicConsumers) {
    if (registration.kind === 'core-table-allowlist') {
      const allowedRelations = registration.allowedRelations ?? [];
      const allowlistSource = registration.allowlistSource;
      const invalidRelation = allowedRelations.find((relation) => !retainedPublic.has(relation));
      if (
        allowedRelations.length === 0 ||
        !allowlistSource ||
        invalidRelation ||
        !isExactCoreAllowlistBinding(registration, sourceByFile)
      ) {
        findings.push({
          file: allowlistSource?.file ?? registration.file,
          line: 1,
          kind: 'invalid-dynamic-relation-allowlist',
          object: invalidRelation,
          message:
            'dynamic core-table consumer must bind an exact retained-table allowlist to a verifiable source symbol',
        });
      }
    }

    if (registration.schemaExpressions) {
      if (!isExactSchemaBinding(registration, sourceByFile)) {
        findings.push({
          file: registration.file,
          line: 1,
          kind: 'invalid-dynamic-schema-binding',
          object: registration.schemaSource?.symbol,
          message:
            'dynamic schema constant source does not contain its exact approved schema value',
        });
      }
    }
  }

  for (const occurrence of manifest.relationOccurrences) {
    const source = sourceByFile.get(occurrence.file);
    const requiredKeys = [
      'fields',
      'filters',
      'order',
      'limit',
      'ownership',
      'atomicityGroup',
      'idempotencyCas',
    ] as const;
    if (!source) {
      findings.push({
        file: occurrence.file,
        line: occurrence.line,
        kind: 'missing-requirement-source',
        object: occurrence.relation,
        message: 'requirement occurrence source file is missing',
      });
      continue;
    }
    const line = source.split('\n')[occurrence.line - 1] ?? '';
    if (!line.includes(`.from('${occurrence.relation}')`)) {
      findings.push({
        file: occurrence.file,
        line: occurrence.line,
        kind: 'stale-requirement-line',
        object: occurrence.relation,
        message: 'manifest line no longer points at the exact relation consumer',
      });
    }
    for (const key of requiredKeys) {
      if (occurrence[key] === undefined || occurrence[key] === null || occurrence[key] === '') {
        findings.push({
          file: occurrence.file,
          line: occurrence.line,
          kind: 'incomplete-requirement',
          object: occurrence.relation,
          message: `relation occurrence is missing ${key}`,
        });
      }
    }
  }

  const effectiveFindings = profile === 'contract' ? [...findings, ...pending] : findings;
  return {
    profile,
    ok: effectiveFindings.length === 0,
    findings: effectiveFindings,
    pending,
    counts: {
      files: files.length,
      staticPublicRelations,
      staticPublicRoutines,
      apiRelations: apiRelationCount,
      apiRoutines: apiRoutineCount,
      requirementOccurrences: manifest.relationOccurrences.length,
    },
  };
}

if (import.meta.main) {
  const profile = (Deno.args.find((arg) => arg.startsWith('--profile='))?.split('=')[1] ??
    'expand') as SchemaBoundaryProfile;
  if (profile !== 'expand' && profile !== 'contract') {
    console.error(
      'Usage: deno run --allow-read scripts/schema-boundary-consumer-audit.ts --profile=expand|contract',
    );
    Deno.exit(2);
  }
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const result = await auditSchemaBoundary(root, profile);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) Deno.exit(1);
}
