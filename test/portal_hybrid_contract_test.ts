import { assertEquals } from 'jsr:@std/assert';

import {
  portalHybridSearchPageSchema,
  portalHybridSearchRequestSchema,
  portalPublicHybridCandidatePageSchema,
} from '../supabase/functions/_shared/portal_hybrid_contract.ts';
import {
  PORTAL_HYBRID_SECURITY_EVENT_SCHEMA,
  sanitizePortalHybridSecurityEvent,
} from '../supabase/functions/_shared/portal_hybrid_security_event.ts';

const PROCESS_ID = '11111111-1111-4111-8111-111111111111';

function candidatePage() {
  return {
    schemaVersion: 'portal.public-hybrid-candidate-page.v1',
    kind: 'process',
    queryFingerprint: 'a'.repeat(64),
    items: [
      {
        key: { kind: 'process', id: PROCESS_ID, version: '01.00.000' },
        accessLevel: 'open',
        capabilities: {
          metadataVisible: true,
          exchangesVisible: true,
          lciaVisible: false,
          publicArtifactVisible: false,
          citationVisible: true,
          policyVersion: 'portal-public-policy-v1',
          reasonCodes: ['published_metadata'],
        },
        names: [{ language: 'en', value: 'Steel production' }],
        summary: [{ language: 'en', value: 'Public summary' }],
        geography: {
          code: 'CN',
          label: [{ language: 'en', value: 'China' }],
          precision: 'country',
        },
        referenceYear: 2025,
        modifiedAt: '2026-08-26T00:00:00Z',
        match: {
          kind: 'hybrid',
          algorithmVersion: 'portal-hybrid-rank-v1',
          score: 0.9,
          reasonCodes: ['lexical_public_projection', 'semantic_public_projection'],
          evidence: {
            lexicalRank: 1,
            semanticRank: 2,
            semanticDistance: '0.125',
          },
        },
      },
    ],
  };
}

Deno.test('Portal Hybrid request accepts only the bounded R2 public shape', () => {
  const parsed = portalHybridSearchRequestSchema.safeParse({
    schemaVersion: 'portal.hybrid-search-request.v1',
    kind: 'process',
    query: '  low-carbon steel  ',
    filters: {
      accessLevel: 'open',
      geography: ' CN ',
      referenceYearFrom: 2020,
      referenceYearTo: 2026,
    },
    limit: 20,
  });
  assertEquals(parsed.success, true);
  if (parsed.success) {
    assertEquals(parsed.data.query, 'low-carbon steel');
    assertEquals(parsed.data.filters.geography, 'CN');
  }

  for (const forbidden of [
    'cursor',
    'sort',
    'state',
    'actor',
    'team',
    'data_source',
    'model',
    'weights',
    'threshold',
    'embedding',
    'visitorHash',
    'notes',
  ]) {
    assertEquals(
      portalHybridSearchRequestSchema.safeParse({
        schemaVersion: 'portal.hybrid-search-request.v1',
        kind: 'process',
        query: 'steel',
        filters: {},
        limit: 10,
        [forbidden]: 'forbidden',
      }).success,
      false,
      forbidden,
    );
  }
});

Deno.test(
  'Portal Hybrid request enforces code-point, byte, control, filter, and limit bounds',
  () => {
    const base = {
      schemaVersion: 'portal.hybrid-search-request.v1',
      kind: 'flow',
      filters: {},
      limit: 1,
    };
    for (const query of [
      '',
      ' ',
      'a'.repeat(513),
      '界'.repeat(683),
      'unsafe\nquery',
      'unsafe\u0085query',
    ]) {
      assertEquals(portalHybridSearchRequestSchema.safeParse({ ...base, query }).success, false);
    }
    assertEquals(
      portalHybridSearchRequestSchema.safeParse({ ...base, query: 'flow', limit: 21 }).success,
      false,
    );
    assertEquals(
      portalHybridSearchRequestSchema.safeParse({
        ...base,
        query: 'flow',
        filters: { referenceYearFrom: 2026, referenceYearTo: 2025 },
      }).success,
      false,
    );
  },
);

Deno.test('Portal public Hybrid page strictly binds R1 cards to real ranking evidence', () => {
  const page = candidatePage();
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(page).success, true);

  const lexicalMismatch = structuredClone(page);
  lexicalMismatch.items[0].match.evidence.lexicalRank = null as unknown as number;
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(lexicalMismatch).success, false);

  const semanticMismatch = structuredClone(page);
  semanticMismatch.items[0].match.evidence.semanticDistance = null as unknown as string;
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(semanticMismatch).success, false);

  const privateField = structuredClone(page) as Record<string, unknown>;
  (privateField.items as Array<Record<string, unknown>>)[0].team_id = 'private-team';
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(privateField).success, false);

  const wrongKind = structuredClone(page);
  wrongKind.items[0].key.kind = 'flow';
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(wrongKind).success, false);
});

Deno.test(
  'Portal Edge Hybrid page exposes only advisory model interpretation plus public items',
  () => {
    const databasePage = candidatePage();
    const edgePage = {
      schemaVersion: 'portal.hybrid-search-page.v1',
      kind: databasePage.kind,
      queryFingerprint: databasePage.queryFingerprint,
      interpretation: {
        source: 'model_generated',
        advisory: true,
        semanticQuery: 'low carbon steel production',
        terms: [
          { language: 'en', value: 'steel production' },
          { language: 'zh-CN', value: '钢铁生产' },
        ],
      },
      items: databasePage.items,
    };
    assertEquals(portalHybridSearchPageSchema.safeParse(edgePage).success, true);
    assertEquals(
      portalHybridSearchPageSchema.safeParse({
        ...edgePage,
        interpretation: { ...edgePage.interpretation, advisory: false },
      }).success,
      false,
    );
  },
);

Deno.test('Portal Hybrid security events have one fixed safe allowlist', () => {
  const event = sanitizePortalHybridSecurityEvent({
    correlationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    kind: 'process',
    cache: 'miss',
    hmacOutcome: 'accepted',
    transportOutcome: 'accepted',
    guardOutcome: 'admitted',
    circuit: 'closed',
    model: 'called',
    database: 'called',
    latencyMs: 321,
    items: 2,
    status: 200,
    errorCode: null,
    matchedKey: 'current',
    recoveredLeaseCount: 1,
    deploymentSha: 'a'.repeat(40),
  });
  assertEquals(event.schemaVersion, PORTAL_HYBRID_SECURITY_EVENT_SCHEMA);
  assertEquals(Object.keys(event).sort(), [
    'cache',
    'circuit',
    'correlationId',
    'database',
    'deploymentSha',
    'errorCode',
    'guardOutcome',
    'hmacOutcome',
    'items',
    'kind',
    'latencyMs',
    'matchedKey',
    'model',
    'recoveredLeaseCount',
    'route',
    'schemaVersion',
    'status',
    'transportOutcome',
  ]);
  for (const forbidden of [
    'query',
    'bodyHash',
    'nonce',
    'keyId',
    'embedding',
    'redisKey',
    'apiKey',
    'cookie',
    'locator',
  ]) {
    assertEquals(Object.hasOwn(event, forbidden), false);
  }
});
