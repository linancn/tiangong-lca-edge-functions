import { assertEquals, assertThrows } from 'jsr:@std/assert';

import {
  canonicalProviderOwnedResult,
  type ProviderOwnedResult,
  validateProviderOwnedResult,
  validateQualificationEnvironment,
} from '../scripts/scope_closure_edge_qualification.ts';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(40);

function isolatedEnvironment(): Record<string, string> {
  return {
    QUALIFICATION_NON_PRODUCTION_CONFIRMATION: 'I_CONFIRM_ISOLATED_NON_PRODUCTION_TARGETS',
    QUALIFICATION_SUPABASE_URL: 'http://127.0.0.1:54321',
    QUALIFICATION_S3_ENDPOINT: 'http://localhost:9000',
    QUALIFICATION_S3_BUCKET: 'qualification-private',
  };
}

function result(): ProviderOwnedResult {
  return {
    schemaVersion: 'lcia.scope-closure-provider-owned-result.v1',
    runId: RUN_ID,
    owner: 'edge',
    component: 'edge',
    componentSha: SHA,
    targetClass: 'isolated-production-equivalent',
    productionMutation: false,
    assertions: 42,
    evidence: {
      download: { crossOwnerRejected: true, locatorRedacted: true },
      consumers: { edgeContractPassed: true },
    },
  };
}

Deno.test('scope-closure Edge qualification accepts only isolated non-production targets', () => {
  validateQualificationEnvironment(isolatedEnvironment());
  for (const environment of [
    {
      ...isolatedEnvironment(),
      QUALIFICATION_NON_PRODUCTION_CONFIRMATION: 'no',
    },
    {
      ...isolatedEnvironment(),
      QUALIFICATION_SUPABASE_URL: 'https://example.invalid',
    },
    {
      ...isolatedEnvironment(),
      QUALIFICATION_S3_ENDPOINT: 'https://example.invalid',
    },
    { ...isolatedEnvironment(), QUALIFICATION_S3_BUCKET: 'prod-private' },
    {
      ...isolatedEnvironment(),
      QUALIFICATION_PRIVATE_MARKER: 'https://lca.tiangong.earth',
    },
  ]) {
    const error = assertThrows(() => validateQualificationEnvironment(environment)) as Error;
    assertEquals(error.message.includes('lca.tiangong.earth'), false);
  }
});

Deno.test('scope-closure Edge result is exact, deterministic, and locator free', () => {
  const value = result();
  validateProviderOwnedResult(value);
  assertEquals(canonicalProviderOwnedResult(value), canonicalProviderOwnedResult(result()));
  assertEquals(canonicalProviderOwnedResult(value).includes('://'), false);

  const locatorLeak = result() as unknown as Record<string, unknown>;
  locatorLeak.evidence = { signedUrl: 'redacted' };
  assertThrows(() => validateProviderOwnedResult(locatorLeak as unknown as ProviderOwnedResult));

  const wrongSha = result();
  wrongSha.componentSha = 'b'.repeat(39);
  assertThrows(() => validateProviderOwnedResult(wrongSha));
});
