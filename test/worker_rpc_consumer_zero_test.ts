import { assertEquals } from 'jsr:@std/assert';

const LEGACY_DEFAULT_SCHEMA_ROUTINES = [
  'worker_enqueue_job',
  'worker_read_job',
  'worker_read_jobs_by_ids',
  'worker_list_jobs_by_concurrency_key',
  'worker_list_jobs',
  'worker_cancel_job',
] as const;
const STABLE_API_ROUTINES = LEGACY_DEFAULT_SCHEMA_ROUTINES.map((routine) => `${routine}_v1`);
const CAPABILITY_REPOSITORY = 'supabase/functions/_shared/capabilities/worker_jobs.ts';

function exactQuotedLiteral(routine: string): RegExp {
  return new RegExp(["'", '"', '`'].map((quote) => `${quote}${routine}${quote}`).join('|'), 'g');
}

async function collectTypeScriptFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...(await collectTypeScriptFiles(path)));
    } else if (entry.isFile && entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

Deno.test(
  'Worker runtime centralizes api v1 and has zero default-public RPC literals',
  async () => {
    const offenders: string[] = [];
    for (const path of await collectTypeScriptFiles('supabase/functions')) {
      const source = await Deno.readTextFile(path);
      for (const routine of LEGACY_DEFAULT_SCHEMA_ROUTINES) {
        if (exactQuotedLiteral(routine).test(source)) {
          offenders.push(`${path}: legacy ${routine}`);
        }
      }
      if (path !== CAPABILITY_REPOSITORY) {
        for (const routine of STABLE_API_ROUTINES) {
          if (exactQuotedLiteral(routine).test(source)) {
            offenders.push(`${path}: direct ${routine}`);
          }
        }
      }
    }
    assertEquals(offenders, []);
  },
);
