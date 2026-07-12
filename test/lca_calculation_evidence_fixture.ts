import {
  LCA_CALCULATION_EVIDENCE_SCHEMA_VERSION,
  LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION,
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH,
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256,
  LCA_STATIC_CACHE_BUNDLE_VERSION,
  LCA_STATIC_CACHE_FACTOR_MANIFEST_SHA256,
  LCA_STATIC_CACHE_METHOD_COUNT,
  LCA_STATIC_CACHE_METHOD_IDENTITY_MANIFEST_SHA256,
  LCA_STATIC_CACHE_METHOD_MANIFEST_SHA256,
  LCA_STATIC_CACHE_SOURCE_SNAPSHOT_SHA256,
  LCIA_FACTOR_COVERAGE_COUNT_UNIT,
  LCIA_FACTOR_COVERAGE_EVIDENCE_SCHEMA_VERSION,
  LCIA_UNCHARACTERIZED_ARTIFACT_FORMAT,
  buildLcaMethodFactorSourceContract,
  type LcaCalculationEvidenceBinding,
  type LciaFactorCoverageCounts,
} from '../supabase/functions/_shared/lca_snapshot_scope.ts';

export function buildCalculationEvidenceV2(
  scopeManifestSha256: string,
  options: { complete?: boolean } = {},
): LcaCalculationEvidenceBinding {
  const methods = buildLcaMethodFactorSourceContract().bundle_manifest.methods;
  if (methods.length !== LCA_STATIC_CACHE_METHOD_COUNT) {
    throw new Error('reviewed LCIA fixture method count drift');
  }

  const perMethodCounts: LciaFactorCoverageCounts = options.complete
    ? { matched: 10, unmatched: 0, invalid: 0, unsupported_direction: 0 }
    : { matched: 9, unmatched: 1, invalid: 0, unsupported_direction: 0 };
  const byMethod = methods.map((method) => ({
    method_id: method.method_id,
    method_version: method.method_version,
    artifact_locator_id: method.artifact_locator_id,
    counts: { ...perMethodCounts },
  }));
  const counts = multiplyCounts(perMethodCounts, methods.length);
  const incompleteCount = counts.unmatched + counts.invalid + counts.unsupported_direction;

  return {
    schema_version: LCA_CALCULATION_EVIDENCE_SCHEMA_VERSION,
    scope_manifest_sha256: scopeManifestSha256,
    lcia_method_factor_source: {
      schema_version: LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION,
      source_kind: 'static_cache_bundle',
      bundle_manifest_path: LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH,
      bundle_manifest_sha256: LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256,
      bundle_version: LCA_STATIC_CACHE_BUNDLE_VERSION,
      source_snapshot_sha256: LCA_STATIC_CACHE_SOURCE_SNAPSHOT_SHA256,
      method_manifest_sha256: LCA_STATIC_CACHE_METHOD_MANIFEST_SHA256,
      factor_manifest_sha256: LCA_STATIC_CACHE_FACTOR_MANIFEST_SHA256,
      method_identity_manifest_sha256: LCA_STATIC_CACHE_METHOD_IDENTITY_MANIFEST_SHA256,
      method_count: LCA_STATIC_CACHE_METHOD_COUNT,
    },
    lcia_factor_coverage: {
      schema_version: LCIA_FACTOR_COVERAGE_EVIDENCE_SCHEMA_VERSION,
      source_snapshot_sha256: LCA_STATIC_CACHE_SOURCE_SNAPSHOT_SHA256,
      method_manifest_sha256: LCA_STATIC_CACHE_METHOD_MANIFEST_SHA256,
      factor_manifest_sha256: LCA_STATIC_CACHE_FACTOR_MANIFEST_SHA256,
      method_identity_manifest_sha256: LCA_STATIC_CACHE_METHOD_IDENTITY_MANIFEST_SHA256,
      count_unit: LCIA_FACTOR_COVERAGE_COUNT_UNIT,
      key_dimensions: ['method_id', 'method_version', 'flow_uuid', 'direction'],
      coverage_status: incompleteCount === 0 ? 'complete' : 'incomplete_coverage',
      missing_factor_semantics: 'incomplete_coverage_not_zero',
      counts,
      by_method: byMethod,
      uncharacterized_evidence:
        incompleteCount === 0
          ? null
          : {
              artifact_url: 'https://example.invalid/storage/v1/s3/lca_results/private-gap.jsonl',
              artifact_format: LCIA_UNCHARACTERIZED_ARTIFACT_FORMAT,
              artifact_sha256: 'd'.repeat(64),
              record_count: incompleteCount,
            },
    },
  };
}

function multiplyCounts(
  counts: LciaFactorCoverageCounts,
  multiplier: number,
): LciaFactorCoverageCounts {
  return {
    matched: counts.matched * multiplier,
    unmatched: counts.unmatched * multiplier,
    invalid: counts.invalid * multiplier,
    unsupported_direction: counts.unsupported_direction * multiplier,
  };
}
