import { assert, assertEquals } from 'jsr:@std/assert';

const FUNCTIONS_ROOT = new URL('../supabase/functions/', import.meta.url);
const CORE_PUBLIC_TABLES = new Set([
  'processes',
  'flows',
  'contacts',
  'sources',
  'unitgroups',
  'flowproperties',
  'lciamethods',
  'lifecyclemodels',
  'ilcd',
]);

async function collectTypeScriptFiles(directory: URL): Promise<URL[]> {
  const files: URL[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const child = new URL(entry.name + (entry.isDirectory ? '/' : ''), directory);
    if (entry.isDirectory) {
      files.push(...(await collectTypeScriptFiles(child)));
    } else if (entry.isFile && entry.name.endsWith('.ts')) {
      files.push(child);
    }
  }
  return files;
}

Deno.test('Edge database access keeps public relations and api routines explicit', async () => {
  const violations: string[] = [];

  for (const file of await collectTypeScriptFiles(FUNCTIONS_ROOT)) {
    const source = await Deno.readTextFile(file);
    const relativePath = file.pathname.split('/supabase/functions/').at(-1) ?? file.pathname;

    if (/\.schema\(\s*['"]private['"]\s*\)/.test(source)) {
      violations.push(`${relativePath}: private schema is not an Edge Data API surface`);
    }

    for (const match of source.matchAll(/\.from\(\s*(['"])([^'"]+)\1\s*\)/g)) {
      const table = match[2];
      const start = match.index ?? 0;
      const chainPrefix = source.slice(Math.max(0, start - 100), start);
      if (/\.storage\s*$/.test(chainPrefix)) {
        continue;
      }
      if (!CORE_PUBLIC_TABLES.has(table)) {
        violations.push(
          `${relativePath}: non-core relation ${table} must be accessed via an api facade`,
        );
        continue;
      }
      if (!/\.schema\(\s*['"]public['"]\s*\)\s*$/.test(chainPrefix)) {
        violations.push(
          `${relativePath}: core relation ${table} must select schema public explicitly`,
        );
      }
    }
  }

  assertEquals(violations, []);
});

Deno.test('shared Supabase clients default RPC calls to schema api', async () => {
  for (const relativePath of [
    '../supabase/functions/_shared/supabase_client.ts',
    '../supabase/functions/_shared/auth.ts',
  ]) {
    const source = await Deno.readTextFile(new URL(relativePath, import.meta.url));
    assert(
      /db:\s*\{\s*schema:\s*['"]api['"]\s*,?\s*\}/s.test(source),
      `${relativePath} must default Data API calls to schema api`,
    );
  }
});
