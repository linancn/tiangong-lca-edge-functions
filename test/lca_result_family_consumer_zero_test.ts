import { assertEquals, assertMatch } from 'jsr:@std/assert';

const FUNCTIONS_ROOT = new URL('../supabase/functions/', import.meta.url);
const ADAPTER_PATH = '_shared/capabilities/lca_result_family.ts';

const LEGACY_RELATION_BASELINE = Object.freeze({
  lca_result_cache: 13,
  lca_results: 1,
  lca_latest_all_unit_results: 1,
  lca_factorization_registry: 0,
});

const LEGACY_ROUTINES = [
  'lca_read_job_projection',
  'lca_read_result_projection',
  'lca_read_latest_single_solve_result',
] as const;

const V1_ROUTINES = [
  'lca_read_job_projection_v1',
  'lca_read_result_projection_v1',
  'lca_read_latest_single_solve_result_v1',
  'lca_read_result_cache_v1',
  'cmd_lca_touch_result_cache_v1',
  'cmd_lca_admit_result_cache_v1',
  'cmd_lca_reconcile_result_cache_v1',
  'lca_read_latest_all_unit_result_v1',
] as const;

async function sourceFiles(): Promise<Array<{ path: string; source: string }>> {
  const files: Array<{ path: string; source: string }> = [];
  async function visit(directory: URL, prefix = ''): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const url = new URL(entry.name + (entry.isDirectory ? '/' : ''), directory);
      if (entry.isDirectory) await visit(url, path);
      else if (entry.isFile && entry.name.endsWith('.ts')) {
        files.push({ path, source: await Deno.readTextFile(url) });
      }
    }
  }
  await visit(FUNCTIONS_ROOT);
  return files;
}

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

Deno.test(
  'LCA result-family consumer-zero freezes the 15/3/0 baseline and removes every legacy owner call',
  async () => {
    assertEquals(
      Object.values(LEGACY_RELATION_BASELINE).reduce<number>((sum, value) => sum + value, 0),
      15,
    );
    assertEquals(LEGACY_ROUTINES.length, 3);
    assertEquals(LEGACY_RELATION_BASELINE.lca_factorization_registry, 0);

    const files = await sourceFiles();
    for (const relation of Object.keys(LEGACY_RELATION_BASELINE)) {
      const pattern = new RegExp(`\\.from\\(\\s*['\"]${relation}['\"]\\s*\\)`, 'g');
      assertEquals(
        files.reduce((sum, file) => sum + count(file.source, pattern), 0),
        0,
        `legacy relation consumer remains: ${relation}`,
      );
    }
    for (const routine of LEGACY_ROUTINES) {
      const pattern = new RegExp(`\\.rpc\\(\\s*['\"]${routine}['\"]`, 'g');
      assertEquals(
        files.reduce((sum, file) => sum + count(file.source, pattern), 0),
        0,
        `legacy RPC consumer remains: ${routine}`,
      );
    }
  },
);

Deno.test(
  'all 8 v1 literals are confined to the api service adapter with no schema fallback',
  async () => {
    const files = await sourceFiles();
    const adapter = files.find((file) => file.path === ADAPTER_PATH);
    if (!adapter) throw new Error(`missing ${ADAPTER_PATH}`);

    for (const routine of V1_ROUTINES) {
      const literal = new RegExp(`['\"]${routine}['\"]`, 'g');
      assertEquals(count(adapter.source, literal), 1, `${routine} adapter literal count`);
      assertEquals(
        files
          .filter((file) => file.path !== ADAPTER_PATH)
          .reduce((sum, file) => sum + count(file.source, literal), 0),
        0,
        `${routine} escaped the adapter`,
      );
    }

    assertEquals(count(adapter.source, /schema:\s*['"]api['"]/g), 1);
    assertEquals(
      count(adapter.source, /\.schema\(LCA_RESULT_FAMILY_CAPABILITY_CONTRACT\.schema\)/g),
      3,
    );
    assertEquals(count(adapter.source, /\.schema\(\s*['"](?:public|private)['"]\s*\)/g), 0);
    assertEquals(count(adapter.source, /\.from\s*\(/g), 0);
    assertEquals(count(adapter.source, /\bclient\.rpc\s*\(/g), 0);
    assertMatch(adapter.source, /client:\s*ServiceRoleSupabaseClient/);
  },
);
