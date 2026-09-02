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
import {
  buildPortalOpenAIResponsesParameters,
  PORTAL_OPENAI_MAX_OUTPUT_TOKENS,
} from '../supabase/functions/_shared/portal_openai_structured.ts';

const PROCESS_ID = '11111111-1111-4111-8111-111111111111';

function versionedCandidatePage() {
  const original = candidatePage();
  const item = {
    ...original.items[0],
    match: { ...original.items[0].match, algorithmVersion: 'portal-hybrid-rank-v2' },
  };
  return {
    ...original,
    schemaVersion: 'portal.public-hybrid-candidate-page.v2',
    items: [item],
    candidateCount: 2,
    datasetCount: 1,
    versionGroups: [
      {
        key: item.key,
        matches: [
          { key: item.key, match: item.match },
          {
            key: { ...item.key, version: '00.99.999' },
            match: {
              ...item.match,
              score: 0.8,
              reasonCodes: ['lexical_public_projection'],
              evidence: { lexicalRank: 2, semanticRank: null, semanticDistance: null },
            },
          },
        ],
      },
    ],
    nextCursor: null,
  };
}

Deno.test('Portal V2 requests explicitly opt into bounded opaque continuation only', () => {
  const request = {
    schemaVersion: 'portal.hybrid-search-request.v2',
    kind: 'process',
    query: 'steel',
    filters: {},
    limit: 10,
    cursor: null,
  };
  assertEquals(portalHybridSearchRequestSchema.safeParse(request).success, true);
  assertEquals(
    portalHybridSearchRequestSchema.safeParse({ ...request, cursor: 'next_page_2' }).success,
    true,
  );
  for (const cursor of ['', '?raw_query=steel', 'x'.repeat(4_097), 20, {}]) {
    assertEquals(portalHybridSearchRequestSchema.safeParse({ ...request, cursor }).success, false);
  }
  for (const field of [
    'state',
    'state_code',
    'actor',
    'team',
    'data_source',
    'embedding',
    'threshold',
    'sort',
  ]) {
    assertEquals(
      portalHybridSearchRequestSchema.safeParse({ ...request, [field]: 'override' }).success,
      false,
    );
  }
});

Deno.test('Portal V2 groups preserve every exact version and rank by their best member', () => {
  const page = versionedCandidatePage();
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(page).success, true);
  const mutations: Array<(value: typeof page) => void> = [
    (value) => {
      value.versionGroups = [];
    },
    (value) => {
      value.candidateCount = 1;
    },
    (value) => {
      value.datasetCount = 3;
    },
    (value) => {
      value.versionGroups[0].key = { ...value.versionGroups[0].key, version: '99.99.999' };
    },
    (value) => {
      value.versionGroups[0].matches[1].key.id = '22222222-2222-4222-8222-222222222222';
    },
    (value) => {
      value.versionGroups[0].matches[1].key.version = '01.00.000';
    },
    (value) => {
      value.versionGroups[0].matches[1].match.score = 1;
    },
    (value) => {
      value.versionGroups[0].matches[1].match.evidence.lexicalRank = 201;
    },
    (value) => {
      Object.assign(value.versionGroups[0].matches[1], { state_code: 20 });
    },
    (value) => {
      value.versionGroups[0].matches[1].match.reasonCodes = ['semantic_public_projection'];
    },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(page);
    mutate(value);
    assertEquals(portalPublicHybridCandidatePageSchema.safeParse(value).success, false);
  }
});

Deno.test(
  'Portal V2 orders dataset representatives by their best score and deterministic id tie-break',
  () => {
    const page = versionedCandidatePage();
    const second = structuredClone(page.items[0]);
    second.key.id = '22222222-2222-4222-8222-222222222222';
    second.match.score = 0.8;
    page.items.push(second);
    page.versionGroups.push({
      key: second.key,
      matches: [{ key: second.key, match: second.match }],
    });
    page.candidateCount = 3;
    page.datasetCount = 2;
    assertEquals(portalPublicHybridCandidatePageSchema.safeParse(page).success, true);

    second.match.score = page.items[0].match.score;
    assertEquals(portalPublicHybridCandidatePageSchema.safeParse(page).success, true);
    page.items.reverse();
    page.versionGroups.reverse();
    assertEquals(portalPublicHybridCandidatePageSchema.safeParse(page).success, false);

    second.match.score = 1;
    assertEquals(portalPublicHybridCandidatePageSchema.safeParse(page).success, true);
    page.items.reverse();
    page.versionGroups.reverse();
    assertEquals(portalPublicHybridCandidatePageSchema.safeParse(page).success, false);
  },
);

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
        context: {
          reference: {
            kind: 'reference_product',
            name: [{ language: 'en', value: 'Steel' }],
          },
          functionalUnit: {
            amount: '1',
            unit: 'kg',
            description: [{ language: 'en', value: '1 kg steel' }],
          },
          technology: [{ language: 'en', value: 'Electric arc furnace' }],
          source: {
            databaseId: 'tiangong-database',
            databaseVersion: '2026.1',
            sourceRecordId: null,
            providerName: [{ language: 'en', value: 'TianGong' }],
            licenseId: 'CC-BY-4.0',
            licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
          },
          quality: { reviewStatus: 'reviewed' },
        },
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
    assertEquals(parsed.data.filters.geography, 'cn');
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
    assertEquals(
      portalHybridSearchRequestSchema.safeParse({
        ...base,
        query: 'flow',
        filters: { processSubtype: 'unit process' },
      }).success,
      false,
    );
    assertEquals(
      portalHybridSearchRequestSchema.safeParse({
        schemaVersion: 'portal.hybrid-search-request.v1',
        kind: 'process',
        query: 'process',
        filters: {
          geography: 'CN',
          classification: 'Metals',
          processSubtype: 'Unit Process',
          source: 'Database Source',
        },
        limit: 1,
      }).success,
      true,
    );
    assertEquals(
      portalHybridSearchRequestSchema.safeParse({
        schemaVersion: 'portal.hybrid-search-request.v1',
        kind: 'process',
        query: 'process',
        filters: { geography: 'a'.repeat(129) },
        limit: 1,
      }).success,
      false,
    );
    assertEquals(
      portalHybridSearchRequestSchema.safeParse({
        schemaVersion: 'portal.hybrid-search-request.v1',
        kind: 'process',
        query: 'process',
        filters: { source: 'İ'.repeat(64) },
        limit: 1,
      }).success,
      true,
    );
    assertEquals(
      portalHybridSearchRequestSchema.safeParse({
        schemaVersion: 'portal.hybrid-search-request.v1',
        kind: 'process',
        query: 'process',
        filters: { source: 'İ'.repeat(128) },
        limit: 1,
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

  const negativeDistance = structuredClone(page);
  negativeDistance.items[0].match.evidence.semanticDistance = '-0.125';
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(negativeDistance).success, false);

  const privateField = structuredClone(page) as Record<string, unknown>;
  (privateField.items as Array<Record<string, unknown>>)[0].team_id = 'private-team';
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(privateField).success, false);

  const missingContext = structuredClone(page) as Record<string, unknown>;
  delete (missingContext.items as Array<Record<string, unknown>>)[0].context;
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(missingContext).success, false);

  const malformedAmount = structuredClone(page);
  malformedAmount.items[0].context.functionalUnit!.amount = '01';
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(malformedAmount).success, false);

  const privateContext = structuredClone(page) as Record<string, unknown>;
  const context = (privateContext.items as Array<Record<string, unknown>>)[0].context as Record<
    string,
    unknown
  >;
  (context.source as Record<string, unknown>).storagePath = 'private/bucket/object';
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(privateContext).success, false);

  const unsafeLicenseUrl = structuredClone(page);
  unsafeLicenseUrl.items[0].context.source.licenseUrl =
    'https://example.com/license?private_locator=value';
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(unsafeLicenseUrl).success, false);

  const wrongKind = structuredClone(page);
  wrongKind.items[0].key.kind = 'flow';
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(wrongKind).success, false);

  const duplicate = structuredClone(page);
  duplicate.items.push(structuredClone(duplicate.items[0]));
  assertEquals(portalPublicHybridCandidatePageSchema.safeParse(duplicate).success, false);
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
    assertEquals(
      portalHybridSearchPageSchema.safeParse({
        ...edgePage,
        interpretation: {
          ...edgePage.interpretation,
          terms: Array.from({ length: 13 }, (_value, index) => ({
            language: 'en',
            value: `term-${index}`,
          })),
        },
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
    rewriteOutcome: 'succeeded',
    embeddingOutcome: 'succeeded',
    rewriteLatencyMs: 123,
    embeddingLatencyMs: 234,
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
    'embeddingLatencyMs',
    'embeddingOutcome',
    'errorCode',
    'guardOutcome',
    'hmacOutcome',
    'items',
    'kind',
    'latencyMs',
    'matchedKey',
    'model',
    'recoveredLeaseCount',
    'rewriteLatencyMs',
    'rewriteOutcome',
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

Deno.test('Portal OpenAI Responses requests are bounded for low-latency structured output', () => {
  const schema = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  };
  const parameters = buildPortalOpenAIResponsesParameters(
    {
      schemaName: 'portal_hybrid_query',
      schema,
      systemPrompt: 'system prompt',
      userPrompt: 'user prompt',
      temperature: 0,
    },
    {
      apiKey: 'sk-private-provider-value',
      model: 'gpt-5.4-nano',
    },
  );

  assertEquals(parameters, {
    model: 'gpt-5.4-nano',
    temperature: 0,
    store: false,
    max_output_tokens: PORTAL_OPENAI_MAX_OUTPUT_TOKENS,
    reasoning: { effort: 'none' },
    input: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
    ],
    text: {
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: 'portal_hybrid_query',
        schema,
        strict: true,
      },
    },
  });
  assertEquals(PORTAL_OPENAI_MAX_OUTPUT_TOKENS, 256);
  assertEquals(Object.hasOwn(parameters, 'service_tier'), false);
  assertEquals(JSON.stringify(parameters).includes('sk-private-provider-value'), false);
});
