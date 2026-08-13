import { assertEquals, assertFalse, assertStringIncludes } from 'jsr:@std/assert';

const HYBRID_CALLERS = [
  ['../supabase/functions/process_hybrid_search/index.ts', 'hybrid_search_processes'],
  ['../supabase/functions/flow_hybrid_search/index.ts', 'hybrid_search_flows'],
  ['../supabase/functions/lifecyclemodel_hybrid_search/index.ts', 'hybrid_search_lifecyclemodels'],
  ['../supabase/functions/contact_hybrid_search/index.ts', 'hybrid_search_contacts'],
  ['../supabase/functions/flowproperty_hybrid_search/index.ts', 'hybrid_search_flowproperties'],
  ['../supabase/functions/source_hybrid_search/index.ts', 'hybrid_search_sources'],
  ['../supabase/functions/unitgroup_hybrid_search/index.ts', 'hybrid_search_unitgroups'],
] as const;

Deno.test(
  'seven hybrid callers use formal RPC names without the historical _v2 suffix',
  async () => {
    for (const [relativePath, rpcName] of HYBRID_CALLERS) {
      const path = new URL(relativePath, import.meta.url);
      const source = await Deno.readTextFile(path);

      assertStringIncludes(source, `rpcName: '${rpcName}'`, relativePath);
      assertEquals(
        source.match(new RegExp(`rpcName:\\s*['"]${rpcName}['"]`, 'g'))?.length ?? 0,
        1,
        relativePath,
      );
      assertFalse(source.includes('_v2'), `${relativePath} retains a historical _v2 caller`);
    }
  },
);
