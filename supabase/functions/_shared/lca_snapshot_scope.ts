export const DEFAULT_PUBLISHED_PROCESS_STATE_START = 100;
export const DEFAULT_PUBLISHED_PROCESS_STATE_END = 199;
export const DEFAULT_PUBLISHED_PROCESS_STATES: readonly number[] = Array.from(
  {
    length: DEFAULT_PUBLISHED_PROCESS_STATE_END - DEFAULT_PUBLISHED_PROCESS_STATE_START + 1,
  },
  (_, index) => DEFAULT_PUBLISHED_PROCESS_STATE_START + index,
);

export const PUBLIC_PROCESS_STATE = 100;
export const OWNER_DRAFT_PROCESS_STATE = 0;
export const PUBLIC_PLUS_OWNER_DRAFT_SCOPE = 'public_plus_owner_draft';
export const LCA_SCOPE_MANIFEST_SCHEMA_VERSION = 'lca.data_scope.manifest.v1';
export const PUBLIC_PLUS_OWNER_DRAFT_PREDICATE_VERSION =
  'public_state_100_or_authenticated_owner_state_0.v1';
export const LCA_METHOD_FACTOR_SOURCE_CONTRACT_SCHEMA_VERSION =
  'lca.method_factor_source.request.v1';
export const LCIA_FACTOR_COVERAGE_CONTRACT_SCHEMA_VERSION = 'lcia.factor_coverage.contract.v1';
export const LCA_CALCULATION_EVIDENCE_SCHEMA_VERSION = 'lca.calculation_evidence.v1';
export const LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION =
  'lca.method_factor_source.snapshot.v1';
export const LCIA_FACTOR_COVERAGE_EVIDENCE_SCHEMA_VERSION = 'lcia.factor_coverage.v1';

export type LcaDataScope =
  | 'current_user'
  | 'open_data'
  | 'all_data'
  | typeof PUBLIC_PLUS_OWNER_DRAFT_SCOPE;

export type LcaScopeManifest = {
  schema_version: typeof LCA_SCOPE_MANIFEST_SCHEMA_VERSION;
  scope: typeof PUBLIC_PLUS_OWNER_DRAFT_SCOPE;
  predicate_version: typeof PUBLIC_PLUS_OWNER_DRAFT_PREDICATE_VERSION;
  actor: {
    kind: 'authenticated_user';
    user_id: string;
  };
  applies_to: ['processes', 'flows', 'lciamethods'];
  owner_draft_collaboration_guards: {
    processes: { team_id: { is: null }; review_id: { is: null } };
    flows: { team_id: { is: null }; review_id: { is: null } };
    lciamethods: { team_id: 'not_applicable'; review_id: 'not_applicable' };
  };
  predicate: {
    operator: 'or';
    clauses: [
      { state_code: { eq: typeof PUBLIC_PROCESS_STATE } },
      {
        operator: 'and';
        clauses: [
          { user_id: { eq: string } },
          { state_code: { eq: typeof OWNER_DRAFT_PROCESS_STATE } },
        ];
      },
    ];
  };
};

export type LcaScopeBinding = {
  manifest: LcaScopeManifest;
  manifest_sha256: string;
};

export type LcaMethodFactorSourceContract = {
  schema_version: typeof LCA_METHOD_FACTOR_SOURCE_CONTRACT_SCHEMA_VERSION;
  source_kind: 'database';
  relation: 'public.lciamethods';
  visibility_binding: 'scope_manifest';
  evidence_schema_version: typeof LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION;
  snapshot_binding: {
    required: true;
    hash_algorithm: 'sha256';
    required_fields: ['source_snapshot_sha256', 'method_manifest_sha256', 'factor_manifest_sha256'];
  };
};

export type LciaFactorCoverageContract = {
  schema_version: typeof LCIA_FACTOR_COVERAGE_CONTRACT_SCHEMA_VERSION;
  match_key: ['elementary_flow_uuid', 'direction'];
  required_counts: ['matched', 'unmatched', 'invalid', 'unsupported_direction'];
  required_uncharacterized_fields: [
    'elementary_flow_uuid',
    'flow_version',
    'direction',
    'exchange_id',
    'amount',
    'reason',
  ];
  evidence_delivery: 'artifact';
  evidence_artifact_format: 'lcia-uncharacterized-jsonl:v1';
  incomplete_when_any: ['unmatched', 'invalid', 'unsupported_direction'];
  status_field: 'coverage_status';
  complete_status: 'complete';
  incomplete_status: 'incomplete_coverage';
  missing_factor_semantics: 'incomplete_coverage_not_zero';
};

export type LciaFactorCoverageCounts = {
  matched: number;
  unmatched: number;
  invalid: number;
  unsupported_direction: number;
};

export type LcaMethodFactorSourceSnapshot = {
  schema_version: typeof LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION;
  source_kind: 'database';
  relation: 'public.lciamethods';
  source_snapshot_sha256: string;
  method_manifest_sha256: string;
  factor_manifest_sha256: string;
};

export type LciaUncharacterizedEvidenceArtifact = {
  artifact_url: string;
  artifact_format: 'lcia-uncharacterized-jsonl:v1';
  artifact_sha256: string;
  record_count: number;
};

export type LciaFactorCoverageEvidence = {
  schema_version: typeof LCIA_FACTOR_COVERAGE_EVIDENCE_SCHEMA_VERSION;
  coverage_status: 'complete' | 'incomplete_coverage';
  missing_factor_semantics: 'incomplete_coverage_not_zero';
  counts: LciaFactorCoverageCounts;
  uncharacterized_evidence: LciaUncharacterizedEvidenceArtifact | null;
};

export type LcaCalculationEvidence = {
  schema_version: typeof LCA_CALCULATION_EVIDENCE_SCHEMA_VERSION;
  scope_manifest_sha256: string;
  lcia_method_factor_source: LcaMethodFactorSourceSnapshot;
  lcia_factor_coverage: LciaFactorCoverageEvidence;
};

export type LcaCalculationEvidenceBinding = {
  schema_version: typeof LCA_CALCULATION_EVIDENCE_SCHEMA_VERSION;
  scope_manifest_sha256: string;
  lcia_method_factor_source: LcaMethodFactorSourceSnapshot;
  lcia_factor_coverage: LciaFactorCoverageEvidence;
};

export type LcaCalculationEvidenceValidation =
  | { ok: true; evidence: LcaCalculationEvidence | null }
  | {
      ok: false;
      error:
        | 'calculation_evidence_missing'
        | 'calculation_evidence_scope_mismatch'
        | 'lcia_method_factor_source_invalid'
        | 'lcia_factor_coverage_invalid';
    };

export type SnapshotProcessFilter = {
  all_states: boolean;
  process_states?: number[];
  include_user_id?: string;
  include_user_state_codes?: number[];
  include_user_unassigned_only?: boolean;
  include_user_review_free_only?: boolean;
  scope_manifest?: LcaScopeManifest;
  scope_manifest_sha256?: string;
};

export type ParsedSnapshotProcessFilter = {
  allStates: boolean;
  processStates: number[];
  includeUserId: string | null;
  includeUserStateCodes: number[];
  includeUserUnassignedOnly: boolean;
  includeUserReviewFreeOnly: boolean;
  scopeManifest: LcaScopeManifest | null;
  scopeManifestSha256: string | null;
};

export function parseLcaDataScope(raw: unknown): LcaDataScope {
  if (
    raw === 'open_data' ||
    raw === 'all_data' ||
    raw === 'current_user' ||
    raw === PUBLIC_PLUS_OWNER_DRAFT_SCOPE
  ) {
    return raw;
  }
  return 'current_user';
}

export function buildPublicPlusOwnerDraftScopeManifest(userId: string): LcaScopeManifest {
  const actorUserId = normalizeRequiredUserId(userId);
  return {
    schema_version: LCA_SCOPE_MANIFEST_SCHEMA_VERSION,
    scope: PUBLIC_PLUS_OWNER_DRAFT_SCOPE,
    predicate_version: PUBLIC_PLUS_OWNER_DRAFT_PREDICATE_VERSION,
    actor: {
      kind: 'authenticated_user',
      user_id: actorUserId,
    },
    applies_to: ['processes', 'flows', 'lciamethods'],
    owner_draft_collaboration_guards: {
      processes: { team_id: { is: null }, review_id: { is: null } },
      flows: { team_id: { is: null }, review_id: { is: null } },
      lciamethods: { team_id: 'not_applicable', review_id: 'not_applicable' },
    },
    predicate: {
      operator: 'or',
      clauses: [
        { state_code: { eq: PUBLIC_PROCESS_STATE } },
        {
          operator: 'and',
          clauses: [
            { user_id: { eq: actorUserId } },
            { state_code: { eq: OWNER_DRAFT_PROCESS_STATE } },
          ],
        },
      ],
    },
  };
}

export async function buildPublicPlusOwnerDraftScopeBinding(
  userId: string,
): Promise<LcaScopeBinding> {
  const manifest = buildPublicPlusOwnerDraftScopeManifest(userId);
  return {
    manifest,
    manifest_sha256: await sha256Hex(canonicalJson(manifest)),
  };
}

export async function buildSnapshotProcessFilter(
  dataScope: LcaDataScope,
  userId: string,
): Promise<SnapshotProcessFilter> {
  if (dataScope === PUBLIC_PLUS_OWNER_DRAFT_SCOPE) {
    const binding = await buildPublicPlusOwnerDraftScopeBinding(userId);
    return {
      all_states: false,
      process_states: [PUBLIC_PROCESS_STATE],
      include_user_id: binding.manifest.actor.user_id,
      include_user_state_codes: [OWNER_DRAFT_PROCESS_STATE],
      include_user_unassigned_only: true,
      include_user_review_free_only: true,
      scope_manifest: binding.manifest,
      scope_manifest_sha256: binding.manifest_sha256,
    };
  }

  // Existing scopes continue to reuse the current user-enhanced snapshot family.
  // Root-process eligibility remains distinct and is validated per request.
  return {
    all_states: false,
    process_states: [...DEFAULT_PUBLISHED_PROCESS_STATES],
    include_user_id: userId,
  };
}

export function shouldAutoBuildSnapshot(dataScope: LcaDataScope): boolean {
  return (
    dataScope === 'current_user' ||
    dataScope === 'all_data' ||
    dataScope === 'open_data' ||
    dataScope === PUBLIC_PLUS_OWNER_DRAFT_SCOPE
  );
}

export function buildSnapshotContainsFilter(
  filter: SnapshotProcessFilter,
): Record<string, unknown> {
  const parsed = parseSnapshotProcessFilter(filter);
  const containsFilter: Record<string, unknown> = {
    all_states: parsed.allStates,
  };

  if (!parsed.allStates && parsed.processStates.length > 0) {
    containsFilter.process_states = parsed.processStates;
  }
  if (!parsed.allStates && parsed.includeUserId) {
    containsFilter.include_user_id = parsed.includeUserId;
  }
  if (!parsed.allStates && parsed.includeUserStateCodes.length > 0) {
    containsFilter.include_user_state_codes = parsed.includeUserStateCodes;
  }
  if (!parsed.allStates && parsed.includeUserUnassignedOnly) {
    containsFilter.include_user_unassigned_only = true;
  }
  if (!parsed.allStates && parsed.includeUserReviewFreeOnly) {
    containsFilter.include_user_review_free_only = true;
  }
  if (!parsed.allStates && parsed.scopeManifest) {
    containsFilter.scope_manifest = parsed.scopeManifest;
  }
  if (!parsed.allStates && parsed.scopeManifestSha256) {
    containsFilter.scope_manifest_sha256 = parsed.scopeManifestSha256;
  }

  return containsFilter;
}

export function buildSnapshotBuildPayloadFields(
  filter: SnapshotProcessFilter,
): Record<string, unknown> {
  const parsed = parseSnapshotProcessFilter(filter);
  const payloadFields: Record<string, unknown> = {
    all_states: parsed.allStates,
  };

  if (!parsed.allStates && parsed.processStates.length > 0) {
    payloadFields.process_states = parsed.processStates.join(',');
  }
  if (!parsed.allStates && parsed.includeUserId) {
    payloadFields.include_user_id = parsed.includeUserId;
  }
  if (!parsed.allStates && parsed.includeUserStateCodes.length > 0) {
    payloadFields.include_user_state_codes = parsed.includeUserStateCodes.join(',');
  }
  if (!parsed.allStates && parsed.includeUserUnassignedOnly) {
    payloadFields.include_user_unassigned_only = true;
  }
  if (!parsed.allStates && parsed.includeUserReviewFreeOnly) {
    payloadFields.include_user_review_free_only = true;
  }
  if (!parsed.allStates && parsed.scopeManifest && parsed.scopeManifestSha256) {
    payloadFields.data_scope = parsed.scopeManifest.scope;
    payloadFields.scope_manifest = parsed.scopeManifest;
    payloadFields.scope_manifest_sha256 = parsed.scopeManifestSha256;
    payloadFields.lcia_method_factor_source = buildLcaMethodFactorSourceContract();
    payloadFields.lcia_factor_coverage_contract = buildLciaFactorCoverageContract();
  }

  return payloadFields;
}

export function buildLcaMethodFactorSourceContract(): LcaMethodFactorSourceContract {
  return {
    schema_version: LCA_METHOD_FACTOR_SOURCE_CONTRACT_SCHEMA_VERSION,
    source_kind: 'database',
    relation: 'public.lciamethods',
    visibility_binding: 'scope_manifest',
    evidence_schema_version: LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION,
    snapshot_binding: {
      required: true,
      hash_algorithm: 'sha256',
      required_fields: [
        'source_snapshot_sha256',
        'method_manifest_sha256',
        'factor_manifest_sha256',
      ],
    },
  };
}

export function buildLciaFactorCoverageContract(): LciaFactorCoverageContract {
  return {
    schema_version: LCIA_FACTOR_COVERAGE_CONTRACT_SCHEMA_VERSION,
    match_key: ['elementary_flow_uuid', 'direction'],
    required_counts: ['matched', 'unmatched', 'invalid', 'unsupported_direction'],
    required_uncharacterized_fields: [
      'elementary_flow_uuid',
      'flow_version',
      'direction',
      'exchange_id',
      'amount',
      'reason',
    ],
    evidence_delivery: 'artifact',
    evidence_artifact_format: 'lcia-uncharacterized-jsonl:v1',
    incomplete_when_any: ['unmatched', 'invalid', 'unsupported_direction'],
    status_field: 'coverage_status',
    complete_status: 'complete',
    incomplete_status: 'incomplete_coverage',
    missing_factor_semantics: 'incomplete_coverage_not_zero',
  };
}

export async function validateCalculationEvidenceForDataScope(
  dataScope: LcaDataScope,
  userId: string,
  raw: unknown,
): Promise<LcaCalculationEvidenceValidation> {
  if (dataScope !== PUBLIC_PLUS_OWNER_DRAFT_SCOPE) {
    return { ok: true, evidence: null };
  }

  const binding = await buildPublicPlusOwnerDraftScopeBinding(userId);
  return validateLcaCalculationEvidence(raw, binding.manifest_sha256);
}

export function validateLcaCalculationEvidence(
  raw: unknown,
  expectedScopeManifestSha256: string,
): LcaCalculationEvidenceValidation {
  const evidence = recordValue(raw);
  if (!evidence || evidence.schema_version !== LCA_CALCULATION_EVIDENCE_SCHEMA_VERSION) {
    return { ok: false, error: 'calculation_evidence_missing' };
  }

  const scopeManifestSha256 = normalizeSha256(evidence.scope_manifest_sha256);
  if (!scopeManifestSha256 || scopeManifestSha256 !== expectedScopeManifestSha256) {
    return { ok: false, error: 'calculation_evidence_scope_mismatch' };
  }

  const source = parseLcaMethodFactorSourceSnapshot(evidence.lcia_method_factor_source);
  if (!source) {
    return { ok: false, error: 'lcia_method_factor_source_invalid' };
  }

  const coverage = parseLciaFactorCoverageEvidence(evidence.lcia_factor_coverage);
  if (!coverage) {
    return { ok: false, error: 'lcia_factor_coverage_invalid' };
  }

  return {
    ok: true,
    evidence: {
      schema_version: LCA_CALCULATION_EVIDENCE_SCHEMA_VERSION,
      scope_manifest_sha256: scopeManifestSha256,
      lcia_method_factor_source: source,
      lcia_factor_coverage: coverage,
    },
  };
}

export function buildLcaCalculationEvidenceBinding(
  evidence: LcaCalculationEvidence,
): LcaCalculationEvidenceBinding {
  return {
    schema_version: evidence.schema_version,
    scope_manifest_sha256: evidence.scope_manifest_sha256,
    lcia_method_factor_source: evidence.lcia_method_factor_source,
    lcia_factor_coverage: evidence.lcia_factor_coverage,
  };
}

export function parseSnapshotProcessFilter(raw: unknown): ParsedSnapshotProcessFilter {
  const obj = (raw ?? {}) as {
    all_states?: unknown;
    process_states?: unknown;
    include_user_id?: unknown;
    include_user_state_codes?: unknown;
    include_user_unassigned_only?: unknown;
    include_user_review_free_only?: unknown;
    scope_manifest?: unknown;
    scope_manifest_sha256?: unknown;
  };

  if (obj.all_states === true) {
    return {
      allStates: true,
      processStates: [],
      includeUserId: null,
      includeUserStateCodes: [],
      includeUserUnassignedOnly: false,
      includeUserReviewFreeOnly: false,
      scopeManifest: null,
      scopeManifestSha256: null,
    };
  }

  return {
    allStates: false,
    processStates: normalizeIntegerList(obj.process_states),
    includeUserId: normalizeIncludeUserId(obj.include_user_id),
    includeUserStateCodes: normalizeIntegerList(obj.include_user_state_codes),
    includeUserUnassignedOnly: obj.include_user_unassigned_only === true,
    includeUserReviewFreeOnly: obj.include_user_review_free_only === true,
    scopeManifest: normalizeScopeManifest(obj.scope_manifest),
    scopeManifestSha256: normalizeSha256(obj.scope_manifest_sha256),
  };
}

export function matchesSnapshotProcessFilter(
  raw: unknown,
  expected: SnapshotProcessFilter,
): boolean {
  const actual = parseSnapshotProcessFilter(raw);
  const normalizedExpected = parseSnapshotProcessFilter(expected);

  if (actual.allStates !== normalizedExpected.allStates) {
    return false;
  }
  if (actual.includeUserId !== normalizedExpected.includeUserId) {
    return false;
  }
  if (actual.scopeManifestSha256 !== normalizedExpected.scopeManifestSha256) {
    return false;
  }
  if (!sameNumberList(actual.processStates, normalizedExpected.processStates)) {
    return false;
  }
  if (!sameNumberList(actual.includeUserStateCodes, normalizedExpected.includeUserStateCodes)) {
    return false;
  }
  if (actual.includeUserUnassignedOnly !== normalizedExpected.includeUserUnassignedOnly) {
    return false;
  }
  if (actual.includeUserReviewFreeOnly !== normalizedExpected.includeUserReviewFreeOnly) {
    return false;
  }

  return canonicalJson(actual.scopeManifest) === canonicalJson(normalizedExpected.scopeManifest);
}

export function buildSnapshotVisibilityOrExpression(
  filter: ParsedSnapshotProcessFilter,
  options: { supportsCollaborationColumns?: boolean } = {},
): string | null {
  if (filter.allStates) {
    return null;
  }

  const branches: string[] = [];
  if (filter.processStates.length > 0) {
    branches.push(`state_code.in.(${filter.processStates.join(',')})`);
  }
  if (filter.includeUserId) {
    if (filter.includeUserStateCodes.length > 0) {
      const ownerClauses = [
        `user_id.eq.${filter.includeUserId}`,
        `state_code.in.(${filter.includeUserStateCodes.join(',')})`,
      ];
      if (options.supportsCollaborationColumns !== false) {
        if (filter.includeUserUnassignedOnly) {
          ownerClauses.push('team_id.is.null');
        }
        if (filter.includeUserReviewFreeOnly) {
          ownerClauses.push('review_id.is.null');
        }
      }
      branches.push(`and(${ownerClauses.join(',')})`);
    } else {
      branches.push(`user_id.eq.${filter.includeUserId}`);
    }
  }

  return branches.length > 0 ? branches.join(',') : null;
}

function normalizeIntegerList(raw: unknown): number[] {
  const values: number[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const value = Number(item);
      if (Number.isInteger(value)) {
        values.push(value);
      }
    }
  } else if (typeof raw === 'string') {
    for (const token of raw.split(',')) {
      const value = Number(token.trim());
      if (Number.isInteger(value)) {
        values.push(value);
      }
    }
  }

  return [...new Set(values)].sort((left, right) => left - right);
}

function normalizeIncludeUserId(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }

  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function normalizeRequiredUserId(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error('authenticated user id is required for public_plus_owner_draft');
  }
  return value;
}

function normalizeScopeManifest(raw: unknown): LcaScopeManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  return raw as LcaScopeManifest;
}

function parseLcaMethodFactorSourceSnapshot(raw: unknown): LcaMethodFactorSourceSnapshot | null {
  const value = recordValue(raw);
  if (
    !value ||
    value.schema_version !== LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION ||
    value.source_kind !== 'database' ||
    value.relation !== 'public.lciamethods'
  ) {
    return null;
  }

  const sourceSnapshotSha256 = normalizeSha256(value.source_snapshot_sha256);
  const methodManifestSha256 = normalizeSha256(value.method_manifest_sha256);
  const factorManifestSha256 = normalizeSha256(value.factor_manifest_sha256);
  if (!sourceSnapshotSha256 || !methodManifestSha256 || !factorManifestSha256) {
    return null;
  }

  return {
    schema_version: LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION,
    source_kind: 'database',
    relation: 'public.lciamethods',
    source_snapshot_sha256: sourceSnapshotSha256,
    method_manifest_sha256: methodManifestSha256,
    factor_manifest_sha256: factorManifestSha256,
  };
}

function parseLciaFactorCoverageEvidence(raw: unknown): LciaFactorCoverageEvidence | null {
  const value = recordValue(raw);
  if (
    !value ||
    value.schema_version !== LCIA_FACTOR_COVERAGE_EVIDENCE_SCHEMA_VERSION ||
    (value.coverage_status !== 'complete' && value.coverage_status !== 'incomplete_coverage') ||
    value.missing_factor_semantics !== 'incomplete_coverage_not_zero'
  ) {
    return null;
  }

  const countsValue = recordValue(value.counts);
  if (!countsValue) {
    return null;
  }
  const counts = {
    matched: nonnegativeInteger(countsValue.matched),
    unmatched: nonnegativeInteger(countsValue.unmatched),
    invalid: nonnegativeInteger(countsValue.invalid),
    unsupported_direction: nonnegativeInteger(countsValue.unsupported_direction),
  };
  if (Object.values(counts).some((count) => count === null)) {
    return null;
  }

  const incompleteCount =
    Number(counts.unmatched) + Number(counts.invalid) + Number(counts.unsupported_direction);
  if (
    (incompleteCount > 0 && value.coverage_status !== 'incomplete_coverage') ||
    (incompleteCount === 0 && value.coverage_status !== 'complete')
  ) {
    return null;
  }

  const uncharacterizedEvidence = parseUncharacterizedEvidenceArtifact(
    value.uncharacterized_evidence,
  );
  if (incompleteCount > 0 && !uncharacterizedEvidence) {
    return null;
  }
  if (incompleteCount > 0 && uncharacterizedEvidence?.record_count !== incompleteCount) {
    return null;
  }
  if (incompleteCount === 0 && value.uncharacterized_evidence !== null) {
    return null;
  }

  return {
    schema_version: LCIA_FACTOR_COVERAGE_EVIDENCE_SCHEMA_VERSION,
    coverage_status: value.coverage_status,
    missing_factor_semantics: 'incomplete_coverage_not_zero',
    counts: counts as LciaFactorCoverageCounts,
    uncharacterized_evidence: uncharacterizedEvidence,
  };
}

function parseUncharacterizedEvidenceArtifact(
  raw: unknown,
): LciaUncharacterizedEvidenceArtifact | null {
  const value = recordValue(raw);
  if (!value) {
    return null;
  }
  const artifactUrl = nonemptyString(value.artifact_url);
  const artifactSha256 = normalizeSha256(value.artifact_sha256);
  const recordCount = nonnegativeInteger(value.record_count);
  if (
    !artifactUrl ||
    value.artifact_format !== 'lcia-uncharacterized-jsonl:v1' ||
    !artifactSha256 ||
    recordCount === null ||
    recordCount === 0
  ) {
    return null;
  }
  return {
    artifact_url: artifactUrl,
    artifact_format: 'lcia-uncharacterized-jsonl:v1',
    artifact_sha256: artifactSha256,
    record_count: recordCount,
  };
}

function recordValue(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

function nonemptyString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function nonnegativeInteger(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

function normalizeSha256(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function sameNumberList(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
