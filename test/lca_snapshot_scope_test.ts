import { assertEquals, assertMatch, assertNotEquals } from 'jsr:@std/assert';

import {
  DEFAULT_PUBLISHED_PROCESS_STATES,
  LCA_METHOD_FACTOR_SOURCE_CONTRACT_SCHEMA_VERSION,
  LCA_SCOPE_MANIFEST_SCHEMA_VERSION,
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH,
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256,
  LCA_STATIC_CACHE_METHOD_COUNT,
  LCIA_FACTOR_COVERAGE_CONTRACT_SCHEMA_VERSION,
  LCIA_UNCHARACTERIZED_ARTIFACT_FORMAT,
  PUBLIC_PLUS_OWNER_DRAFT_PREDICATE_VERSION,
  buildLcaCalculationEvidenceBinding,
  buildPublicPlusOwnerDraftScopeBinding,
  buildSnapshotBuildPayloadFields,
  buildSnapshotContainsFilter,
  buildSnapshotProcessFilter,
  buildSnapshotVisibilityOrExpression,
  matchesSnapshotProcessFilter,
  parseLcaDataScope,
  parseSnapshotProcessFilter,
  shouldAutoBuildSnapshot,
  validateCalculationEvidenceForDataScope,
  validateLcaCalculationEvidence,
} from '../supabase/functions/_shared/lca_snapshot_scope.ts';
import { buildCalculationEvidenceV2 } from './lca_calculation_evidence_fixture.ts';

Deno.test(
  'parseLcaDataScope accepts the named private-incubation scope and keeps safe default',
  () => {
    assertEquals(parseLcaDataScope(undefined), 'current_user');
    assertEquals(parseLcaDataScope(''), 'current_user');
    assertEquals(parseLcaDataScope('open_data'), 'open_data');
    assertEquals(parseLcaDataScope('all_data'), 'all_data');
    assertEquals(parseLcaDataScope('public_plus_owner_draft'), 'public_plus_owner_draft');
    assertEquals(parseLcaDataScope('unexpected_scope'), 'current_user');
  },
);

Deno.test('buildSnapshotProcessFilter preserves existing shared snapshot family', async () => {
  const expectedStates = [...DEFAULT_PUBLISHED_PROCESS_STATES];
  assertEquals(await buildSnapshotProcessFilter('current_user', 'user-1'), {
    all_states: false,
    process_states: expectedStates,
    include_user_id: 'user-1',
  });
  assertEquals(await buildSnapshotProcessFilter('open_data', 'user-1'), {
    all_states: false,
    process_states: expectedStates,
    include_user_id: 'user-1',
  });
  assertEquals(await buildSnapshotProcessFilter('all_data', 'user-1'), {
    all_states: false,
    process_states: expectedStates,
    include_user_id: 'user-1',
  });
});

Deno.test(
  'public_plus_owner_draft freezes exact actor predicate and deterministic hash',
  async () => {
    const first = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1');
    const second = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1');
    const otherActor = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-2');

    assertEquals(first, second);
    assertEquals(first.all_states, false);
    assertEquals(first.process_states, [100]);
    assertEquals(first.include_user_id, 'user-1');
    assertEquals(first.include_user_state_codes, [0]);
    assertEquals(first.include_user_unassigned_only, true);
    assertEquals(first.include_user_review_free_only, true);
    assertEquals(first.scope_manifest?.schema_version, LCA_SCOPE_MANIFEST_SCHEMA_VERSION);
    assertEquals(first.scope_manifest?.scope, 'public_plus_owner_draft');
    assertEquals(
      first.scope_manifest?.predicate_version,
      PUBLIC_PLUS_OWNER_DRAFT_PREDICATE_VERSION,
    );
    assertEquals(first.scope_manifest?.actor, {
      kind: 'authenticated_user',
      user_id: 'user-1',
    });
    assertEquals(first.scope_manifest?.applies_to, ['processes', 'flows']);
    assertEquals(first.scope_manifest?.owner_draft_collaboration_guards, {
      processes: { team_id: { is: null }, review_id: { is: null } },
      flows: { team_id: { is: null }, review_id: { is: null } },
    });
    assertEquals(first.scope_manifest?.predicate, {
      operator: 'or',
      clauses: [
        { state_code: { eq: 100 } },
        {
          operator: 'and',
          clauses: [{ user_id: { eq: 'user-1' } }, { state_code: { eq: 0 } }],
        },
      ],
    });
    assertMatch(first.scope_manifest_sha256 ?? '', /^[0-9a-f]{64}$/);
    assertNotEquals(first.scope_manifest_sha256, otherActor.scope_manifest_sha256);
  },
);

Deno.test('scope binding hashes canonical manifest content', async () => {
  const first = await buildPublicPlusOwnerDraftScopeBinding(' user-1 ');
  const second = await buildPublicPlusOwnerDraftScopeBinding('user-1');
  assertEquals(first, second);
  assertEquals(first.manifest.actor.user_id, 'user-1');
});

Deno.test('BAFU actor scope hash rejects the superseded combined LCIA scope hash', async () => {
  const binding = await buildPublicPlusOwnerDraftScopeBinding(
    'dab05739-1a42-421b-8170-3b77146d1d64',
  );
  assertEquals(
    binding.manifest_sha256,
    '621966942c1980dd8786b3ccfb0fda040fb77e5a842c9eb97a9e97e9c889841d',
  );
  assertNotEquals(
    binding.manifest_sha256,
    '348b347f1bc962707aa69010b1e8e2e9f1cdfbc9eff2ca075d4bb625a4309f7d',
  );
});

Deno.test('DEFAULT_PUBLISHED_PROCESS_STATES covers 100 through 199', () => {
  assertEquals(DEFAULT_PUBLISHED_PROCESS_STATES.length, 100);
  assertEquals(DEFAULT_PUBLISHED_PROCESS_STATES[0], 100);
  assertEquals(DEFAULT_PUBLISHED_PROCESS_STATES.at(-1), 199);
});

Deno.test(
  'matchesSnapshotProcessFilter rejects scope, actor, state, hash, or manifest drift',
  async () => {
    const expected = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1');
    assertEquals(matchesSnapshotProcessFilter(expected, expected), true);
    assertEquals(
      matchesSnapshotProcessFilter({ ...expected, include_user_state_codes: [0, 10] }, expected),
      false,
    );
    assertEquals(
      matchesSnapshotProcessFilter({ ...expected, include_user_unassigned_only: false }, expected),
      false,
    );
    assertEquals(
      matchesSnapshotProcessFilter(
        { ...expected, scope_manifest_sha256: '0'.repeat(64) },
        expected,
      ),
      false,
    );
    assertEquals(
      matchesSnapshotProcessFilter(
        {
          ...expected,
          scope_manifest: {
            ...expected.scope_manifest!,
            actor: { kind: 'authenticated_user', user_id: 'user-2' },
          },
        },
        expected,
      ),
      false,
    );

    const legacy = await buildSnapshotProcessFilter('current_user', 'user-1');
    assertEquals(matchesSnapshotProcessFilter(legacy, legacy), true);
    assertEquals(matchesSnapshotProcessFilter(legacy, expected), false);
  },
);

Deno.test('query/build helpers carry exact worker and LCIA proof contracts', async () => {
  const filter = await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1');
  assertEquals(buildSnapshotContainsFilter(filter), filter);

  const payload = buildSnapshotBuildPayloadFields(filter);
  assertEquals(payload.all_states, false);
  assertEquals(payload.process_states, '100');
  assertEquals(payload.include_user_id, 'user-1');
  assertEquals(payload.include_user_state_codes, '0');
  assertEquals(payload.include_user_unassigned_only, true);
  assertEquals(payload.include_user_review_free_only, true);
  assertEquals(payload.data_scope, 'public_plus_owner_draft');
  assertEquals(payload.scope_manifest, filter.scope_manifest);
  assertEquals(payload.scope_manifest_sha256, filter.scope_manifest_sha256);
  assertEquals(
    (payload.lcia_method_factor_source as { schema_version: string }).schema_version,
    LCA_METHOD_FACTOR_SOURCE_CONTRACT_SCHEMA_VERSION,
  );
  assertEquals(
    (payload.lcia_method_factor_source as { source_kind: string }).source_kind,
    'static_cache_bundle',
  );
  assertEquals(
    (payload.lcia_method_factor_source as { bundle_manifest_path: string }).bundle_manifest_path,
    LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH,
  );
  assertEquals(
    (payload.lcia_method_factor_source as { bundle_manifest_sha256: string })
      .bundle_manifest_sha256,
    LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256,
  );
  assertEquals(
    (payload.lcia_method_factor_source as { bundle_manifest: { methods: unknown[] } })
      .bundle_manifest.methods.length,
    LCA_STATIC_CACHE_METHOD_COUNT,
  );
  assertEquals(
    (payload.lcia_factor_coverage_contract as { schema_version: string }).schema_version,
    LCIA_FACTOR_COVERAGE_CONTRACT_SCHEMA_VERSION,
  );
  assertEquals(
    (payload.lcia_factor_coverage_contract as { missing_factor_semantics: string })
      .missing_factor_semantics,
    'incomplete_coverage_not_zero',
  );
});

Deno.test('freshness visibility expression preserves owner state zero restriction', async () => {
  const exact = parseSnapshotProcessFilter(
    await buildSnapshotProcessFilter('public_plus_owner_draft', 'user-1'),
  );
  assertEquals(
    buildSnapshotVisibilityOrExpression(exact),
    'state_code.in.(100),and(user_id.eq.user-1,state_code.in.(0),team_id.is.null,review_id.is.null)',
  );
  assertEquals(
    buildSnapshotVisibilityOrExpression(exact, { supportsCollaborationColumns: false }),
    'state_code.in.(100),and(user_id.eq.user-1,state_code.in.(0))',
  );

  const legacy = parseSnapshotProcessFilter(
    await buildSnapshotProcessFilter('current_user', 'user-1'),
  );
  assertEquals(
    buildSnapshotVisibilityOrExpression(legacy),
    `state_code.in.(${DEFAULT_PUBLISHED_PROCESS_STATES.join(',')}),user_id.eq.user-1`,
  );
});

Deno.test('shouldAutoBuildSnapshot includes the exact private-incubation scope', () => {
  assertEquals(shouldAutoBuildSnapshot('current_user'), true);
  assertEquals(shouldAutoBuildSnapshot('all_data'), true);
  assertEquals(shouldAutoBuildSnapshot('open_data'), true);
  assertEquals(shouldAutoBuildSnapshot('public_plus_owner_draft'), true);
});

Deno.test(
  'calculation evidence binds exact scope, reviewed static source, and 25-method matrix',
  async () => {
    const scope = await buildPublicPlusOwnerDraftScopeBinding('user-1');
    const evidence = buildCalculationEvidenceV2(scope.manifest_sha256);
    const validation = validateLcaCalculationEvidence(evidence, scope.manifest_sha256);
    assertEquals(validation.ok, true);
    if (!validation.ok || !validation.evidence) {
      throw new Error('expected valid calculation evidence');
    }
    assertEquals(buildLcaCalculationEvidenceBinding(validation.evidence), evidence);
    assertEquals(validation.evidence.lcia_factor_coverage.by_method.length, 25);
    assertEquals(validation.evidence.lcia_factor_coverage.counts, {
      matched: 225,
      unmatched: 25,
      invalid: 0,
      unsupported_direction: 0,
    });
    assertEquals(
      validation.evidence.lcia_factor_coverage.uncharacterized_evidence?.artifact_format,
      LCIA_UNCHARACTERIZED_ARTIFACT_FORMAT,
    );

    const complete = buildCalculationEvidenceV2(scope.manifest_sha256, { complete: true });
    assertEquals(validateLcaCalculationEvidence(complete, scope.manifest_sha256).ok, true);

    assertEquals(await validateCalculationEvidenceForDataScope('current_user', 'user-1', null), {
      ok: true,
      evidence: null,
    });
  },
);

Deno.test(
  'calculation evidence fails closed on v1, source, method-matrix, or artifact drift',
  async () => {
    const scope = await buildPublicPlusOwnerDraftScopeBinding('user-1');
    const evidence = buildCalculationEvidenceV2(scope.manifest_sha256);

    assertEquals(validateLcaCalculationEvidence(null, scope.manifest_sha256), {
      ok: false,
      error: 'calculation_evidence_missing',
    });
    assertEquals(validateLcaCalculationEvidence(evidence, 'f'.repeat(64)), {
      ok: false,
      error: 'calculation_evidence_scope_mismatch',
    });

    const oldTopLevel = structuredClone(evidence) as Record<string, unknown>;
    oldTopLevel.schema_version = 'lca.calculation_evidence.v1';
    assertEquals(validateLcaCalculationEvidence(oldTopLevel, scope.manifest_sha256), {
      ok: false,
      error: 'calculation_evidence_missing',
    });

    const sourceDrift = structuredClone(evidence);
    sourceDrift.lcia_method_factor_source.factor_manifest_sha256 = '0'.repeat(64) as never;
    assertEquals(validateLcaCalculationEvidence(sourceDrift, scope.manifest_sha256), {
      ok: false,
      error: 'lcia_method_factor_source_invalid',
    });

    const sourceV1 = structuredClone(evidence) as unknown as {
      lcia_method_factor_source: Record<string, unknown>;
    };
    sourceV1.lcia_method_factor_source = {
      schema_version: 'lca.method_factor_source.snapshot.v1',
      source_kind: 'database',
      relation: 'public.lciamethods',
      source_snapshot_sha256: 'a'.repeat(64),
      method_manifest_sha256: 'b'.repeat(64),
      factor_manifest_sha256: 'c'.repeat(64),
    };
    assertEquals(validateLcaCalculationEvidence(sourceV1, scope.manifest_sha256), {
      ok: false,
      error: 'lcia_method_factor_source_invalid',
    });

    const unionCoverageV1 = structuredClone(evidence) as unknown as {
      lcia_factor_coverage: Record<string, unknown>;
    };
    unionCoverageV1.lcia_factor_coverage = {
      schema_version: 'lcia.factor_coverage.v1',
      coverage_status: 'complete',
      missing_factor_semantics: 'incomplete_coverage_not_zero',
      counts: { matched: 10, unmatched: 0, invalid: 0, unsupported_direction: 0 },
      uncharacterized_evidence: null,
    };
    assertEquals(validateLcaCalculationEvidence(unionCoverageV1, scope.manifest_sha256), {
      ok: false,
      error: 'lcia_factor_coverage_invalid',
    });

    for (const mutate of [
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.coverage_status = 'complete';
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.by_method.pop();
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.by_method[1] = structuredClone(
          candidate.lcia_factor_coverage.by_method[0],
        );
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.by_method[0].artifact_locator_id = 'wrong-locator';
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.by_method[0].method_id = ` ${candidate.lcia_factor_coverage.by_method[0].method_id}`;
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.by_method[0].counts.matched += 1;
        candidate.lcia_factor_coverage.counts.matched += 1;
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.counts.matched -= 1;
      },
      (candidate: ReturnType<typeof buildCalculationEvidenceV2>) => {
        candidate.lcia_factor_coverage.uncharacterized_evidence!.artifact_format =
          'lcia-uncharacterized-jsonl:v1' as never;
      },
    ]) {
      const candidate = structuredClone(evidence);
      mutate(candidate);
      assertEquals(validateLcaCalculationEvidence(candidate, scope.manifest_sha256), {
        ok: false,
        error: 'lcia_factor_coverage_invalid',
      });
    }

    const zeroMatrix = buildCalculationEvidenceV2(scope.manifest_sha256, { complete: true });
    zeroMatrix.lcia_factor_coverage.counts = {
      matched: 0,
      unmatched: 0,
      invalid: 0,
      unsupported_direction: 0,
    };
    zeroMatrix.lcia_factor_coverage.by_method.forEach((method) => {
      method.counts = { matched: 0, unmatched: 0, invalid: 0, unsupported_direction: 0 };
    });
    assertEquals(validateLcaCalculationEvidence(zeroMatrix, scope.manifest_sha256), {
      ok: false,
      error: 'lcia_factor_coverage_invalid',
    });

    const unsafeAggregate = buildCalculationEvidenceV2(scope.manifest_sha256);
    const perCategory = Math.floor(Number.MAX_SAFE_INTEGER / (25 * 2)) + 1;
    unsafeAggregate.lcia_factor_coverage.by_method.forEach((method) => {
      method.counts = {
        matched: perCategory,
        unmatched: perCategory,
        invalid: 0,
        unsupported_direction: 0,
      };
    });
    unsafeAggregate.lcia_factor_coverage.counts = {
      matched: perCategory * 25,
      unmatched: perCategory * 25,
      invalid: 0,
      unsupported_direction: 0,
    };
    unsafeAggregate.lcia_factor_coverage.uncharacterized_evidence!.record_count = perCategory * 25;
    assertEquals(validateLcaCalculationEvidence(unsafeAggregate, scope.manifest_sha256), {
      ok: false,
      error: 'lcia_factor_coverage_invalid',
    });
  },
);
