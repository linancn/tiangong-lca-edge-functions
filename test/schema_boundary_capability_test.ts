import { assertEquals } from 'jsr:@std/assert';

import {
  callDatabaseApiRpc,
  databaseApi,
  fromDatabaseApi,
} from '../supabase/functions/_shared/capabilities/schema_boundary.ts';

class FakeCredentialBoundClient {
  readonly calls: Array<Record<string, unknown>> = [];

  constructor(readonly credentialRole: 'authenticated' | 'service_role' | 'anon') {}

  schema(schema: string) {
    this.calls.push({
      operation: 'schema',
      schema,
      credentialRole: this.credentialRole,
    });
    return this;
  }

  rpc(routine: string, args: Record<string, unknown>) {
    this.calls.push({
      operation: 'rpc',
      routine,
      args,
      credentialRole: this.credentialRole,
    });
    return Promise.resolve({ data: { ok: true }, error: null });
  }

  from(relation: string) {
    this.calls.push({
      operation: 'from',
      relation,
      credentialRole: this.credentialRole,
    });
    return { relation };
  }
}

for (const credentialRole of ['authenticated', 'service_role', 'anon'] as const) {
  Deno.test(
    `database API capability selects api schema without changing ${credentialRole} credentials`,
    async () => {
      const client = new FakeCredentialBoundClient(credentialRole);

      databaseApi(client as never);
      fromDatabaseApi(client as never, 'team_roles_v1');
      await callDatabaseApiRpc(client as never, 'cmd_dataset_save_draft', {
        p_table: 'flows',
      });

      assertEquals(client.calls, [
        { operation: 'schema', schema: 'api', credentialRole },
        { operation: 'schema', schema: 'api', credentialRole },
        { operation: 'from', relation: 'team_roles_v1', credentialRole },
        { operation: 'schema', schema: 'api', credentialRole },
        {
          operation: 'rpc',
          routine: 'cmd_dataset_save_draft',
          args: { p_table: 'flows' },
          credentialRole,
        },
      ]);
    },
  );
}

Deno.test(
  'the exact 10 actor and 3 service routines use the centralized api-schema boundary',
  async () => {
    const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
    const manifest = JSON.parse(
      await Deno.readTextFile(
        `${root}/supabase/functions/_shared/capabilities/schema_boundary_manifest.v1.json`,
      ),
    ) as {
      apiCapabilities: { actorRoutines: string[]; serviceRoutines: string[] };
    };
    assertEquals(manifest.apiCapabilities.actorRoutines.length, 10);
    assertEquals(manifest.apiCapabilities.serviceRoutines.length, 3);

    const datasetCommands = await Deno.readTextFile(
      `${root}/supabase/functions/_shared/db_rpc/dataset_commands.ts`,
    );
    const extractionWorker = await Deno.readTextFile(
      `${root}/supabase/functions/_shared/dataset_extraction_worker.ts`,
    );
    for (const routine of manifest.apiCapabilities.actorRoutines) {
      assertEquals(datasetCommands.includes(`'${routine}'`), true, routine);
    }
    for (const routine of manifest.apiCapabilities.serviceRoutines) {
      assertEquals(extractionWorker.includes(`'${routine}'`), true, routine);
    }
    assertEquals(datasetCommands.includes('callDatabaseApiRpc(supabase, fn, args)'), true);
    assertEquals(datasetCommands.includes("'cmd_review_submit_v2'"), true);
    assertEquals(datasetCommands.includes('callLegacyPublicDatasetRpc'), true);
  },
);
