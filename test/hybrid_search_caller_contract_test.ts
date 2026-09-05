import { assertEquals, assertFalse } from 'jsr:@std/assert';

const HYBRID_CALLERS = [
  [
    '../supabase/functions/process_hybrid_search/index.ts',
    'hybrid_search_processes',
    'hybrid_search_process_versions_v2',
  ],
  [
    '../supabase/functions/flow_hybrid_search/index.ts',
    'hybrid_search_flows',
    'hybrid_search_flow_versions_v2',
  ],
  ['../supabase/functions/lifecyclemodel_hybrid_search/index.ts', 'hybrid_search_lifecyclemodels'],
  ['../supabase/functions/contact_hybrid_search/index.ts', 'hybrid_search_contacts'],
  ['../supabase/functions/flowproperty_hybrid_search/index.ts', 'hybrid_search_flowproperties'],
  ['../supabase/functions/source_hybrid_search/index.ts', 'hybrid_search_sources'],
  ['../supabase/functions/unitgroup_hybrid_search/index.ts', 'hybrid_search_unitgroups'],
] as const;

Deno.test(
  'seven hybrid callers keep formal latest RPC names and reviewed versioned opt-ins',
  async () => {
    for (const [relativePath, rpcName, versionedRpcName] of HYBRID_CALLERS) {
      const path = new URL(relativePath, import.meta.url);
      const source = await Deno.readTextFile(path);

      assertEquals(
        source.match(new RegExp(`rpcName:\\s*['"]${rpcName}['"]`, 'g'))?.length ?? 0,
        1,
        relativePath,
      );
      if (versionedRpcName) {
        assertEquals(
          source.match(new RegExp(`versionedRpcName:\\s*['"]${versionedRpcName}['"]`, 'g'))
            ?.length ?? 0,
          1,
          relativePath,
        );
      } else {
        assertFalse(source.includes('_v2'), `${relativePath} retains a historical _v2 caller`);
      }
    }
  },
);
