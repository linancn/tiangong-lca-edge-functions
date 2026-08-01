import ts from 'npm:typescript@5.9.3';

import {
  DATABASE_API_ACTOR_CAPABILITIES,
  DATABASE_API_RELATION_CAPABILITIES,
  DATABASE_API_SERVICE_CAPABILITIES,
} from '../supabase/functions/_shared/capabilities/schema_boundary.ts';

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
  rpcExpressions?: string[];
  dynamicCallCounts?: Record<string, number>;
  schemaExpressions?: string[];
  allowedSchemas?: string[];
  schemaSource?: { file: string; symbol: string };
  allowedRelations?: string[];
  allowlistSource?: { file: string; symbol: string };
};

type Manifest = {
  canonicalization: {
    algorithm: 'sha256';
    sidecar: string;
    schemaPath: string;
    schemaSha256: string;
  };
  databaseSource: {
    issue: string;
    repository: string;
    freezeSchemaVersion: string;
    freezeSchemaPath: string;
    baseCommit: string;
    migrationHead: string;
    publicObjectInventorySha256: string;
    state: string;
    authorization: string;
    frozenManifest: {
      path: string | null;
      sha256: string | null;
      sidecarPath: string | null;
      contentFingerprintSha256: string | null;
      edgeExposureFingerprintSha256: string | null;
      commit: string | null;
      reviewComment: number | null;
    };
    requiredFrozenBindings: {
      consumerSource: string[];
      exposureSurface: string[];
      authorizationPolicy: string[];
    };
  };
  policy: { retainedPublicTables: string[]; allowedPostgrestSchemas: string[] };
  apiCapabilities: {
    relations: string[];
    actorRoutines: string[];
    serviceRoutines: string[];
  };
  relationOccurrenceScope: { relations: string[]; sourceKind: string };
  preferredApiIdentities: Array<{
    capability: string;
    identity: string;
    returns: string;
    signature: { identityArguments: string[]; arguments: string[]; resultType: string };
    acl: {
      state: string;
      authorizationPolicyIds: string[] | null;
      executeRoles: string[] | null;
      deniedRoles: string[] | null;
    };
  }>;
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
    span: { start: number; end: number };
    fields: unknown;
    filters: unknown;
    order: unknown;
    limit: unknown;
    ownership: unknown;
    atomicityGroup: unknown;
    idempotencyCas: unknown;
  }>;
};

export type SourceRelationOccurrence = {
  file: string;
  line: number;
  relation: string;
  operation: string;
  span: { start: number; end: number };
};

export type RelationOccurrenceComparison = {
  duplicateSource: string[];
  duplicateManifest: string[];
  missingFromManifest: string[];
  staleInManifest: string[];
  exact: boolean;
};

function relationOccurrenceKey(occurrence: SourceRelationOccurrence): string {
  return `${occurrence.file}:${occurrence.span.start}:${occurrence.span.end}:${occurrence.relation}:${occurrence.operation}`;
}

export function compareRelationOccurrenceInventories(
  sourceOccurrences: SourceRelationOccurrence[],
  manifestOccurrences: SourceRelationOccurrence[],
): RelationOccurrenceComparison {
  const sourceKeys = sourceOccurrences.map(relationOccurrenceKey);
  const manifestKeys = manifestOccurrences.map(relationOccurrenceKey);
  const duplicateSource = [
    ...new Set(sourceKeys.filter((key, index) => sourceKeys.indexOf(key) !== index)),
  ];
  const duplicateManifest = [
    ...new Set(manifestKeys.filter((key, index) => manifestKeys.indexOf(key) !== index)),
  ];
  const sourceSet = new Set(sourceKeys);
  const manifestSet = new Set(manifestKeys);
  const missingFromManifest = sourceKeys.filter((key) => !manifestSet.has(key));
  const staleInManifest = manifestKeys.filter((key) => !sourceSet.has(key));
  return {
    duplicateSource,
    duplicateManifest,
    missingFromManifest,
    staleInManifest,
    exact:
      duplicateSource.length === 0 &&
      duplicateManifest.length === 0 &&
      missingFromManifest.length === 0 &&
      staleInManifest.length === 0,
  };
}

type CapabilityCall = {
  file: string;
  line: number;
  helper: 'actor' | 'service';
  capabilityId: string | null;
  expression: string;
};

function calledPropertyName(expression: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return ts.isIdentifier(expression) ? expression.text : null;
}

function relationOperation(call: ts.CallExpression): string {
  const operations = new Set(['select', 'insert', 'update', 'upsert', 'delete']);
  let current: ts.Node = call;
  while (current.parent && !ts.isStatement(current.parent)) {
    current = current.parent;
    if (ts.isCallExpression(current)) {
      const name = calledPropertyName(current.expression);
      if (name && operations.has(name)) return name;
    }
  }
  return 'unknown';
}

export function deriveSourceRelationOccurrences(
  file: string,
  source: string,
  scopedRelations: ReadonlySet<string>,
): SourceRelationOccurrence[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const occurrences: SourceRelationOccurrence[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && calledPropertyName(node.expression) === 'from') {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument) && scopedRelations.has(argument.text)) {
        const start = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.getStart(sourceFile)
          : node.getStart(sourceFile);
        occurrences.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
          relation: argument.text,
          operation: relationOperation(node),
          span: { start, end: node.getEnd() },
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return occurrences;
}

function deriveCapabilityCalls(file: string, source: string): CapabilityCall[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const calls: CapabilityCall[] = [];
  const helperByName = new Map([
    ['callActorDatabaseApiRpc', 'actor' as const],
    ['callServiceDatabaseApiRpc', 'service' as const],
  ]);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calledPropertyName(node.expression);
      const helper = name ? helperByName.get(name) : undefined;
      if (helper) {
        const argument = node.arguments[1];
        const start = node.getStart(sourceFile);
        calls.push({
          file,
          line: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
          helper,
          capabilityId: argument && ts.isStringLiteralLike(argument) ? argument.text : null,
          expression: argument?.getText(sourceFile) ?? '<missing>',
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

export function deriveBoundaryMethodCalls(source: string): Record<string, number> {
  const sourceFile = ts.createSourceFile(
    'boundary.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const counts: Record<string, number> = {};
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const method = calledPropertyName(node.expression);
      if (method === 'from' || method === 'rpc' || method === 'schema') {
        const argument = node.arguments[0];
        if (argument && !ts.isStringLiteralLike(argument)) {
          const key = `${method}:${argument.getText(sourceFile)}`;
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return counts;
}

export function deriveAstBoundaryViolations(
  file: string,
  source: string,
  registrations: DynamicConsumerRegistration[],
  storage: Array<{ file: string; expressions: string[] }>,
  allowedSchemas: string[],
  sourceByFile: ReadonlyMap<string, string>,
  legacyDynamicRpcFiles: readonly string[] = [],
): SchemaBoundaryFinding[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations: SchemaBoundaryFinding[] = [];
  const boundaryMethods = new Set(['from', 'rpc', 'schema']);
  const looksLikeClient = (expression: string) =>
    /(?:^|\.)(?:client|supabase|supabaseClient|serviceClient|authClient|rpcClient)$/.test(
      expression,
    ) || expression.includes('databaseApi(');
  const push = (node: ts.Node, kind: string, message: string, object?: string) => {
    violations.push({
      file,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      kind,
      object,
      message,
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isBindingElement(node)) {
      const name = node.propertyName ?? node.name;
      const declaration = node.parent.parent;
      const initializer = ts.isVariableDeclaration(declaration)
        ? declaration.initializer
        : undefined;
      if (
        ts.isIdentifier(name) &&
        boundaryMethods.has(name.text) &&
        initializer &&
        looksLikeClient(initializer.getText(sourceFile))
      ) {
        push(
          node,
          'destructured-data-api-method',
          `destructuring ${name.text} bypasses the verifiable schema-boundary call shape`,
          name.text,
        );
      }
    }

    if (ts.isPropertyAccessExpression(node) && boundaryMethods.has(node.name.text)) {
      if (
        looksLikeClient(node.expression.getText(sourceFile)) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
        !ts.isTypeOfExpression(node.parent)
      ) {
        push(
          node,
          'detached-data-api-method',
          `detaching .${node.name.text} bypasses the verifiable schema-boundary call shape`,
          node.getText(sourceFile),
        );
      }
    }

    if (ts.isCallExpression(node)) {
      const method = calledPropertyName(node.expression);
      if (!method || !boundaryMethods.has(method)) {
        ts.forEachChild(node, visit);
        return;
      }
      if (ts.isIdentifier(node.expression)) {
        push(
          node,
          'detached-data-api-call',
          `bare ${method}(...) cannot prove its schema-boundary receiver`,
          method,
        );
      }
      if (ts.isElementAccessExpression(node.expression)) {
        if (looksLikeClient(node.expression.expression.getText(sourceFile))) {
          push(
            node,
            'computed-data-api-call',
            `computed ['${method}'](...) calls are forbidden at the schema boundary`,
            method,
          );
        }
      }

      const argument = node.arguments[0];
      if (!argument || ts.isStringLiteralLike(argument)) {
        ts.forEachChild(node, visit);
        return;
      }
      const expression = argument.getText(sourceFile);
      if (method === 'from') {
        const receiver =
          ts.isPropertyAccessExpression(node.expression) ||
          ts.isElementAccessExpression(node.expression)
            ? node.expression.expression.getText(sourceFile)
            : '';
        if (receiver === 'Array' || receiver === 'Uint8Array') {
          ts.forEachChild(node, visit);
          return;
        }
        if (!classifyDynamicRelation(registrations, storage, file, expression)) {
          push(
            node,
            'ast-unregistered-dynamic-from',
            `AST-derived dynamic .from(${expression}) has no exact registration`,
            expression,
          );
        }
      } else if (method === 'rpc') {
        const registered =
          registrations.some(
            (entry) => entry.file === file && entry.rpcExpressions?.includes(expression),
          ) || legacyDynamicRpcFiles.includes(file);
        if (!registered) {
          push(
            node,
            'ast-unregistered-dynamic-rpc',
            `AST-derived dynamic .rpc(${expression}) has no exact capability registration`,
            expression,
          );
        }
      } else if (
        !isApprovedDynamicSchema(registrations, allowedSchemas, file, expression, sourceByFile)
      ) {
        push(
          node,
          'ast-unregistered-dynamic-schema',
          `AST-derived dynamic .schema(${expression}) has no exact approved binding`,
          expression,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}

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

export function exactStringSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const leftValues = [...new Set(left)].toSorted();
  const rightValues = [...new Set(right)].toSorted();
  return JSON.stringify(leftValues) === JSON.stringify(rightValues);
}

export function exactUniqueList(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    exactStringSet(actual, expected)
  );
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
export const REQUIRED_RELATION_OCCURRENCE_SCOPE = [
  'lcia_result_publications',
  'lcia_result_packages',
  'lca_snapshot_artifacts',
  'lca_network_snapshots',
  'lca_result_cache',
  'lca_active_snapshots',
  'lca_latest_all_unit_results',
  'lca_results',
  'lca_package_artifacts',
  'lca_package_request_cache',
] as const;

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
  const sourceOccurrences: SourceRelationOccurrence[] = [];
  const capabilityCalls: CapabilityCall[] = [];
  const scopedRelations = new Set(manifest.relationOccurrenceScope.relations);
  if (
    manifest.relationOccurrenceScope.sourceKind !== 'literal-postgrest-from-call' ||
    !exactUniqueList(manifest.relationOccurrenceScope.relations, REQUIRED_RELATION_OCCURRENCE_SCOPE)
  ) {
    findings.push({
      file: MANIFEST_PATH,
      line: 1,
      kind: 'relation-occurrence-scope-drift',
      message: 'the reviewed 10-relation occurrence scope cannot be narrowed by manifest edits',
    });
  }

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
  const manifestSchemaBytes = await Deno.readFile(
    `${root}/${manifest.canonicalization.schemaPath}`,
  );
  const manifestSchemaDigest = await sha256Hex(manifestSchemaBytes);
  try {
    JSON.parse(new TextDecoder().decode(manifestSchemaBytes));
  } catch (_error) {
    findings.push({
      file: manifest.canonicalization.schemaPath,
      line: 1,
      kind: 'invalid-manifest-schema-json',
      message: 'schema-boundary manifest schema must be valid JSON',
    });
  }
  if (manifestSchemaDigest !== manifest.canonicalization.schemaSha256) {
    findings.push({
      file: manifest.canonicalization.schemaPath,
      line: 1,
      kind: 'manifest-schema-digest-mismatch',
      object: manifestSchemaDigest,
      message: 'schema-boundary manifest schema SHA-256 does not match canonicalization metadata',
    });
  }

  const sha256Pattern = /^[0-9a-f]{64}$/;
  const commitPattern = /^[0-9a-f]{40}$/;
  const databaseSource = manifest.databaseSource;
  const requiredFrozenBindings = databaseSource.requiredFrozenBindings;
  const databaseCandidateValid =
    databaseSource.issue === 'tiangong-lca/database-engine#357' &&
    databaseSource.repository === 'tiangong-lca/database-engine' &&
    databaseSource.freezeSchemaVersion === 'database.lca-private-expand-freeze.v3' &&
    databaseSource.freezeSchemaPath ===
      'supabase/tests/contracts/lca_private_expand_freeze.v3.schema.json' &&
    commitPattern.test(databaseSource.baseCommit) &&
    /^\d{14}$/.test(databaseSource.migrationHead) &&
    sha256Pattern.test(databaseSource.publicObjectInventorySha256) &&
    exactUniqueList(requiredFrozenBindings.consumerSource, [
      'sourceId',
      'repository',
      'commit',
      'manifestPath',
      'manifestSha256',
      'manifestSchemaPath',
      'manifestSchemaSha256',
      'manifestSchemaVersion',
      'consumerKinds',
    ]) &&
    exactUniqueList(requiredFrozenBindings.exposureSurface, [
      'identity',
      'signature',
      'authorizationPolicyIds',
      'phaseRepresentations',
      'fingerprintSha256',
    ]) &&
    exactUniqueList(requiredFrozenBindings.authorizationPolicy, [
      'policyType',
      'security',
      'owner',
      'searchPath',
      'executeRoles',
      'deniedRoles',
      'directPgRoles',
      'rlsMode',
      'ownershipCheck',
      'fingerprintSha256',
    ]);
  if (!databaseCandidateValid) {
    findings.push({
      file: MANIFEST_PATH,
      line: 1,
      kind: 'invalid-database-source-provenance',
      message: 'databaseSource must bind the exact #357 v3 schema and database provenance',
    });
  }

  const exposureFingerprint = await sha256Hex(
    new TextEncoder().encode(JSON.stringify(manifest.preferredApiIdentities)),
  );
  for (const exposure of manifest.preferredApiIdentities) {
    const open = exposure.identity.indexOf('(');
    const close = exposure.identity.lastIndexOf(')');
    const identityArguments =
      open >= 0 && close > open && exposure.identity.slice(open + 1, close).trim()
        ? exposure.identity
            .slice(open + 1, close)
            .split(',')
            .map((value) => value.trim())
        : [];
    if (
      JSON.stringify(exposure.signature.identityArguments) !== JSON.stringify(identityArguments) ||
      JSON.stringify(exposure.signature.arguments) !== JSON.stringify(identityArguments) ||
      exposure.signature.resultType !== exposure.returns
    ) {
      findings.push({
        file: MANIFEST_PATH,
        line: 1,
        kind: 'invalid-exposure-signature',
        object: exposure.identity,
        message:
          'preferred API identity and structured signature must be exact and self-consistent',
      });
    }
  }

  const frozenManifest = databaseSource.frozenManifest;
  const frozenAclComplete = manifest.preferredApiIdentities.every(
    (exposure) =>
      exposure.acl.state === 'reviewed-frozen' &&
      Array.isArray(exposure.acl.authorizationPolicyIds) &&
      exposure.acl.authorizationPolicyIds.length > 0 &&
      Array.isArray(exposure.acl.executeRoles) &&
      Array.isArray(exposure.acl.deniedRoles),
  );
  const databaseFrozen =
    databaseSource.state === 'reviewed-frozen' &&
    databaseSource.authorization === 'consumer-migration-authorized' &&
    Boolean(frozenManifest.path?.endsWith('.v3.json')) &&
    Boolean(frozenManifest.sidecarPath?.endsWith('.sha256')) &&
    Boolean(frozenManifest.sha256 && sha256Pattern.test(frozenManifest.sha256)) &&
    Boolean(
      frozenManifest.contentFingerprintSha256 &&
      sha256Pattern.test(frozenManifest.contentFingerprintSha256),
    ) &&
    frozenManifest.edgeExposureFingerprintSha256 === exposureFingerprint &&
    Boolean(frozenManifest.commit && commitPattern.test(frozenManifest.commit)) &&
    typeof frozenManifest.reviewComment === 'number' &&
    frozenManifest.reviewComment > 0 &&
    frozenAclComplete;
  if (!databaseFrozen) {
    if (
      databaseSource.state !== 'candidate-not-frozen' ||
      databaseSource.authorization !== 'not-authorized' ||
      Object.values(frozenManifest).some((value) => value !== null) ||
      manifest.preferredApiIdentities.some(
        (exposure) =>
          exposure.acl.state !== 'candidate-not-frozen' ||
          exposure.acl.authorizationPolicyIds !== null ||
          exposure.acl.executeRoles !== null ||
          exposure.acl.deniedRoles !== null,
      )
    ) {
      findings.push({
        file: MANIFEST_PATH,
        line: 1,
        kind: 'invalid-database-freeze-state',
        message:
          'database binding must be either an explicitly non-authorizing candidate or a complete reviewed-frozen #357 v3 contract',
      });
    } else {
      pending.push({
        file: MANIFEST_PATH,
        line: 1,
        kind: 'database-freeze-pending',
        object: exposureFingerprint,
        message:
          'database #357 v3 is candidate-only; contract cannot pass until exact freeze, exposure signatures, and ACL policies are bound',
      });
    }
  }

  const sourceByFile = new Map<string, string>();
  for (const absoluteFile of files) {
    const file = relativePath(root, absoluteFile);
    const source = await Deno.readTextFile(absoluteFile);
    sourceByFile.set(file, source);
    sourceOccurrences.push(...deriveSourceRelationOccurrences(file, source, scopedRelations));
    capabilityCalls.push(...deriveCapabilityCalls(file, source));

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

    for (const match of source.matchAll(/fromDatabaseApi\([^,]+,\s*['"]([A-Za-z0-9_.-]+)['"]/g)) {
      const capabilityId = match[1];
      const relation = (DATABASE_API_RELATION_CAPABILITIES as Readonly<Record<string, string>>)[
        capabilityId
      ];
      apiRelationCount += 1;
      if (!relation || !apiRelations.has(relation)) {
        addFinding(
          findings,
          file,
          source,
          match.index,
          'unregistered-api-relation',
          `relation capability ${capabilityId} is not registered in apiCapabilities.relations`,
          capabilityId,
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
          (entry) => entry.file === file && entry.rpcExpressions?.includes(expression),
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

  for (const [file, source] of sourceByFile) {
    findings.push(
      ...deriveAstBoundaryViolations(
        file,
        source,
        manifest.dynamicConsumers,
        manifest.platformConsumers.storage,
        manifest.policy.allowedPostgrestSchemas,
        sourceByFile,
        manifest.publicResidue.dynamicRpcFiles,
      ),
    );
  }

  const actorMap = DATABASE_API_ACTOR_CAPABILITIES as Readonly<Record<string, string>>;
  const serviceMap = DATABASE_API_SERVICE_CAPABILITIES as Readonly<Record<string, string>>;
  const relationMap = DATABASE_API_RELATION_CAPABILITIES as Readonly<Record<string, string>>;
  if (!exactUniqueList(manifest.apiCapabilities.actorRoutines, Object.values(actorMap))) {
    findings.push({
      file: MANIFEST_PATH,
      line: 1,
      kind: 'actor-capability-manifest-drift',
      message: 'typed actor routine map and manifest actor routines must be bidirectionally equal',
    });
  }
  if (!exactUniqueList(manifest.apiCapabilities.serviceRoutines, Object.values(serviceMap))) {
    findings.push({
      file: MANIFEST_PATH,
      line: 1,
      kind: 'service-capability-manifest-drift',
      message:
        'typed service routine map and manifest service routines must be bidirectionally equal',
    });
  }
  if (!exactUniqueList(manifest.apiCapabilities.relations, Object.values(relationMap))) {
    findings.push({
      file: MANIFEST_PATH,
      line: 1,
      kind: 'relation-capability-manifest-drift',
      message: 'typed relation map and manifest API relations must be bidirectionally equal',
    });
  }

  for (const call of capabilityCalls) {
    const map = call.helper === 'actor' ? actorMap : serviceMap;
    if (!call.capabilityId || !(call.capabilityId in map)) {
      findings.push({
        file: call.file,
        line: call.line,
        kind: 'dynamic-or-unknown-api-capability',
        object: call.expression,
        message: `${call.helper} API helper requires an exact registered literal capability ID`,
      });
    }
  }
  const actorCalls = capabilityCalls.filter((call) => call.helper === 'actor');
  const serviceCalls = capabilityCalls.filter((call) => call.helper === 'service');
  if (
    !exactUniqueList(
      actorCalls.flatMap((call) => (call.capabilityId ? [call.capabilityId] : [])),
      Object.keys(actorMap),
    )
  ) {
    findings.push({
      file: MANIFEST_PATH,
      line: 1,
      kind: 'actor-capability-observation-drift',
      message: 'observed actor capability IDs and typed actor map must be bidirectionally equal',
    });
  }
  if (
    !exactUniqueList(
      serviceCalls.flatMap((call) => (call.capabilityId ? [call.capabilityId] : [])),
      Object.keys(serviceMap),
    )
  ) {
    findings.push({
      file: MANIFEST_PATH,
      line: 1,
      kind: 'service-capability-observation-drift',
      message:
        'observed service capability IDs and typed service map must be bidirectionally equal',
    });
  }
  apiRoutineCount = actorCalls.length + serviceCalls.length;

  const occurrenceComparison = compareRelationOccurrenceInventories(
    sourceOccurrences,
    manifest.relationOccurrences,
  );
  if (
    occurrenceComparison.duplicateSource.length > 0 ||
    occurrenceComparison.duplicateManifest.length > 0
  ) {
    findings.push({
      file: MANIFEST_PATH,
      line: 1,
      kind: 'duplicate-relation-occurrence',
      object: [
        ...occurrenceComparison.duplicateSource,
        ...occurrenceComparison.duplicateManifest,
      ].join(','),
      message: 'source-derived and manifest relation occurrence identities must be unique',
    });
  }
  if (!occurrenceComparison.exact) {
    findings.push({
      file: MANIFEST_PATH,
      line: 1,
      kind: 'relation-occurrence-bidirectional-drift',
      object: JSON.stringify({
        missingFromManifest: occurrenceComparison.missingFromManifest,
        staleInManifest: occurrenceComparison.staleInManifest,
      }),
      message:
        'source-derived (file,span,relation,operation) occurrences and manifest occurrences must be bidirectionally equal',
    });
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
    if (registration.dynamicCallCounts) {
      const source = sourceByFile.get(registration.file);
      const actual = source ? deriveBoundaryMethodCalls(source) : {};
      if (
        JSON.stringify(Object.entries(actual).toSorted()) !==
        JSON.stringify(Object.entries(registration.dynamicCallCounts).toSorted())
      ) {
        findings.push({
          file: registration.file,
          line: 1,
          kind: 'dynamic-capability-call-shape-drift',
          message:
            'dynamic schema/from/rpc call expressions and counts must exactly match the reviewed capability abstraction',
        });
      }
    }
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
