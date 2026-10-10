import { assertEquals, assertThrows } from 'jsr:@std/assert';

import {
  portalAllowedBrandCodesSchema,
  portalBrandScopeIdentity,
} from '../supabase/functions/_shared/portal_brand_scope.ts';
import { portalHybridSearchRequestSchema } from '../supabase/functions/_shared/portal_hybrid_contract.ts';
import { portalHybridSearchRequestV3Schema } from '../supabase/functions/_shared/portal_scoped_hybrid_contract.ts';

const request = {
  schemaVersion: 'portal.hybrid-search-request.v3',
  allowedBrandCodes: ['tiangong_lca'],
  kind: 'process',
  query: 'steel',
  filters: {},
  limit: 10,
  cursor: null,
};

Deno.test('signed Portal scope admits only canonical nonempty sets of known brands', () => {
  for (const codes of [['tiangong_lca'], ['bafu', 'tiangong_lca', 'uslci', 'worldsteel']]) {
    assertEquals(portalAllowedBrandCodesSchema.parse(codes), codes);
  }
  for (const codes of [
    undefined,
    null,
    [],
    ['*'],
    ['BAFU'],
    ['unknown'],
    [null],
    ['bafu', 'bafu'],
    ['uslci', 'bafu'],
    Array(5).fill('bafu'),
  ]) {
    assertEquals(portalAllowedBrandCodesSchema.safeParse(codes).success, false);
    assertThrows(() => portalBrandScopeIdentity(codes));
  }
});

Deno.test('scope identity binds the contract and the complete deployment set', () => {
  assertEquals(portalBrandScopeIdentity(['tiangong_lca']), 'portal-display-scope.v1:tiangong_lca');
  assertEquals(
    portalBrandScopeIdentity(['bafu', 'tiangong_lca']),
    'portal-display-scope.v1:bafu,tiangong_lca',
  );
});

Deno.test('V3 distinguishes deployment scope from optional user brand narrowing', () => {
  assertEquals(portalHybridSearchRequestV3Schema.parse(request).allowedBrandCodes, [
    'tiangong_lca',
  ]);
  // A known out-of-scope filter remains a valid empty-result query. It must
  // never expand or replace the authority supplied by the signed BFF scope.
  const narrowed = portalHybridSearchRequestV3Schema.parse({
    ...request,
    filters: { brand: 'bafu' },
  });
  assertEquals(narrowed.filters.brand, 'bafu');
  assertEquals(narrowed.allowedBrandCodes, ['tiangong_lca']);
  assertEquals(
    portalHybridSearchRequestV3Schema.safeParse({ ...request, filters: { brand: '*' } }).success,
    false,
  );
});

Deno.test('V3 retains strict unknown-field, query, filter and Flow validation', () => {
  for (const invalid of [
    { ...request, allowedBrandCodes: undefined },
    { ...request, state_code: 100 },
    { ...request, filters: { allowedBrandCodes: ['bafu'] } },
    { ...request, filters: { referenceYearFrom: 2025, referenceYearTo: 2020 } },
    { ...request, kind: 'flow', filters: { processSubtype: 'unit process' } },
    { ...request, query: 'x'.repeat(513) },
    { ...request, limit: 21 },
  ])
    assertEquals(portalHybridSearchRequestV3Schema.safeParse(invalid).success, false);
});

Deno.test('live parser selects V3 explicitly and rejects scope on legacy wires', () => {
  assertEquals(portalHybridSearchRequestSchema.safeParse(request).success, true);
  assertEquals(
    portalHybridSearchRequestSchema.safeParse({
      ...request,
      schemaVersion: 'portal.hybrid-search-request.v2',
    }).success,
    false,
  );
});
