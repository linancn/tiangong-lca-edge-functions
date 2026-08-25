import { assertEquals, assertFalse } from 'jsr:@std/assert';

import {
  LCA_METHOD_FACTOR_SOURCE_BASE_URL_BINDING,
  LCA_METHOD_FACTOR_SOURCE_CONTRACT_SCHEMA_VERSION,
  LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION,
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH,
  LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256,
  LCA_STATIC_CACHE_BUNDLE_VERSION,
  LCA_STATIC_CACHE_FACTOR_MANIFEST_SHA256,
  LCA_STATIC_CACHE_METHOD_COUNT,
  LCA_STATIC_CACHE_METHOD_IDENTITY_MANIFEST_SHA256,
  LCA_STATIC_CACHE_METHOD_MANIFEST_SHA256,
  LCA_STATIC_CACHE_SOURCE_SNAPSHOT_SHA256,
  buildLcaMethodFactorSourceContract,
} from '../supabase/functions/_shared/lca_snapshot_scope.ts';

Deno.test(
  'embedded static LCIA manifest preserves reviewed raw bytes and release envelope',
  async () => {
    const manifestUrl = new URL(
      '../supabase/functions/_shared/lca_static_cache_bundle_manifest.json',
      import.meta.url,
    );
    const raw = await Deno.readFile(manifestUrl);
    assertEquals(await sha256Hex(raw), LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256);

    const parsed = JSON.parse(new TextDecoder().decode(raw));
    const contract = buildLcaMethodFactorSourceContract();
    assertEquals(contract.bundle_manifest, parsed);
    assertEquals(contract.bundle_manifest.bundle_version, LCA_STATIC_CACHE_BUNDLE_VERSION);
    assertEquals(
      contract.bundle_manifest.source_snapshot_sha256,
      LCA_STATIC_CACHE_SOURCE_SNAPSHOT_SHA256,
    );
    assertEquals(
      contract.bundle_manifest.method_manifest_sha256,
      LCA_STATIC_CACHE_METHOD_MANIFEST_SHA256,
    );
    assertEquals(
      contract.bundle_manifest.method_identity_manifest_sha256,
      LCA_STATIC_CACHE_METHOD_IDENTITY_MANIFEST_SHA256,
    );
    assertEquals(
      contract.bundle_manifest.factor_manifest_sha256,
      LCA_STATIC_CACHE_FACTOR_MANIFEST_SHA256,
    );
    assertEquals(contract.bundle_manifest.methods.length, LCA_STATIC_CACHE_METHOD_COUNT);
  },
);

Deno.test('source request v2 has exact fields and ignores client locator overrides', () => {
  const adversarialBuilder = buildLcaMethodFactorSourceContract as unknown as (
    clientFields: Record<string, unknown>,
  ) => ReturnType<typeof buildLcaMethodFactorSourceContract>;
  const contract = adversarialBuilder({
    source_kind: 'database',
    relation: 'public.lciamethods',
    bundle_manifest_path: '../../attacker/cache_manifest.json',
    bundle_manifest_sha256: '0'.repeat(64),
    base_url: 'https://attacker.invalid/',
    source_url: 'https://attacker.invalid/cache_manifest.json',
  });

  assertEquals(Object.keys(contract), [
    'schema_version',
    'source_kind',
    'bundle_manifest_path',
    'bundle_manifest_sha256',
    'bundle_manifest',
    'base_url_binding',
    'evidence_schema_version',
    'snapshot_binding',
  ]);
  assertEquals(contract.schema_version, LCA_METHOD_FACTOR_SOURCE_CONTRACT_SCHEMA_VERSION);
  assertEquals(contract.source_kind, 'static_cache_bundle');
  assertEquals(contract.bundle_manifest_path, LCA_STATIC_CACHE_BUNDLE_MANIFEST_PATH);
  assertEquals(contract.bundle_manifest_sha256, LCA_STATIC_CACHE_BUNDLE_MANIFEST_SHA256);
  assertEquals(contract.base_url_binding, LCA_METHOD_FACTOR_SOURCE_BASE_URL_BINDING);
  assertEquals(contract.evidence_schema_version, LCA_METHOD_FACTOR_SOURCE_SNAPSHOT_SCHEMA_VERSION);
  assertEquals(contract.snapshot_binding, {
    required: true,
    hash_algorithm: 'sha256',
    required_fields: [
      'bundle_manifest_sha256',
      'bundle_version',
      'source_snapshot_sha256',
      'method_manifest_sha256',
      'factor_manifest_sha256',
      'method_identity_manifest_sha256',
      'method_count',
    ],
  });
  assertFalse('base_url' in contract);
  assertFalse('source_url' in contract);
  assertFalse('relation' in contract);

  contract.bundle_manifest.methods[0].method_id = 'client-mutated';
  assertFalse(
    buildLcaMethodFactorSourceContract().bundle_manifest.methods.some(
      (method) => method.method_id === 'client-mutated',
    ),
  );
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
