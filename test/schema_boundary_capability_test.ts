import { assertEquals, assertThrows } from 'jsr:@std/assert';

import {
  callActorDatabaseRpc,
  callServiceDatabaseRpc,
  DATABASE_API_ACTOR_CAPABILITIES,
  DATABASE_API_RELATION_CAPABILITIES,
  DATABASE_API_SERVICE_CAPABILITIES,
  DATABASE_PUBLIC_ACTOR_CAPABILITIES,
  DATABASE_PUBLIC_SERVICE_CAPABILITIES,
  databaseApi,
  fromDatabaseApi,
  type DatabaseActorCapabilityId,
  type DatabaseApiRelationCapabilityId,
  type DatabaseServiceCapabilityId,
} from '../supabase/functions/_shared/capabilities/schema_boundary.ts';

class FakeCredentialBoundClient {
  readonly calls: Array<Record<string, unknown>> = [];

  constructor(readonly credentialRole: 'authenticated' | 'service_role' | 'anon') {}

  schema(schema: string) {
    this.calls.push({ operation: 'schema', schema, credentialRole: this.credentialRole });
    return this;
  }

  rpc(routine: string, args: Record<string, unknown>) {
    this.calls.push({ operation: 'rpc', routine, args, credentialRole: this.credentialRole });
    return Promise.resolve({ data: { ok: true }, error: null });
  }

  from(relation: string) {
    this.calls.push({ operation: 'from', relation, credentialRole: this.credentialRole });
    return { relation };
  }
}

Deno.test('database API capability selects api schema without changing bound credentials', () => {
  for (const credentialRole of ['authenticated', 'service_role', 'anon'] as const) {
    const client = new FakeCredentialBoundClient(credentialRole);
    databaseApi(client as never);
    fromDatabaseApi(client as never, 'team.roles');
    assertEquals(client.calls, [
      { operation: 'schema', schema: 'api', credentialRole },
      { operation: 'schema', schema: 'api', credentialRole },
      { operation: 'from', relation: 'team_roles_v1', credentialRole },
    ]);
  }
});

Deno.test('save-draft is the only actor capability routed through api', async () => {
  assertEquals(DATABASE_API_ACTOR_CAPABILITIES, {
    'dataset.save-draft': 'cmd_dataset_save_draft',
  });
  assertEquals(DATABASE_API_SERVICE_CAPABILITIES, {});
  const client = new FakeCredentialBoundClient('authenticated');
  await callActorDatabaseRpc(client as never, 'dataset.save-draft', {
    proof: 'dataset.save-draft',
  });
  assertEquals(client.calls, [
    { operation: 'schema', schema: 'api', credentialRole: 'authenticated' },
    {
      operation: 'rpc',
      routine: 'cmd_dataset_save_draft',
      args: { proof: 'dataset.save-draft' },
      credentialRole: 'authenticated',
    },
  ]);
});

Deno.test('the other 9 actor and 3 service capabilities explicitly remain on public', async () => {
  assertEquals(Object.keys(DATABASE_PUBLIC_ACTOR_CAPABILITIES).length, 9);
  assertEquals(Object.keys(DATABASE_PUBLIC_SERVICE_CAPABILITIES).length, 3);

  for (const [capabilityId, routine] of Object.entries(DATABASE_PUBLIC_ACTOR_CAPABILITIES)) {
    const client = new FakeCredentialBoundClient('authenticated');
    await callActorDatabaseRpc(client as never, capabilityId as DatabaseActorCapabilityId, {
      proof: capabilityId,
    });
    assertEquals(client.calls, [
      {
        operation: 'rpc',
        routine,
        args: { proof: capabilityId },
        credentialRole: 'authenticated',
      },
    ]);
  }

  for (const [capabilityId, routine] of Object.entries(DATABASE_PUBLIC_SERVICE_CAPABILITIES)) {
    const client = new FakeCredentialBoundClient('service_role');
    await callServiceDatabaseRpc(client as never, capabilityId as DatabaseServiceCapabilityId, {
      proof: capabilityId,
    });
    assertEquals(client.calls, [
      {
        operation: 'rpc',
        routine,
        args: { proof: capabilityId },
        credentialRole: 'service_role',
      },
    ]);
  }
});

Deno.test('all relation capability IDs resolve exact api facade relations', () => {
  for (const [capabilityId, relation] of Object.entries(DATABASE_API_RELATION_CAPABILITIES)) {
    const client = new FakeCredentialBoundClient('service_role');
    fromDatabaseApi(client as never, capabilityId as DatabaseApiRelationCapabilityId);
    assertEquals(client.calls.at(-1), {
      operation: 'from',
      relation,
      credentialRole: 'service_role',
    });
  }
});

Deno.test('forged actor, service, and relation capability IDs fail before a Data API call', () => {
  const actorClient = new FakeCredentialBoundClient('authenticated');
  assertThrows(
    () =>
      callActorDatabaseRpc(actorClient as never, 'forged.actor' as DatabaseActorCapabilityId, {}),
    Error,
    'Unregistered database API capability',
  );
  assertEquals(actorClient.calls, []);

  const serviceClient = new FakeCredentialBoundClient('service_role');
  assertThrows(
    () =>
      callServiceDatabaseRpc(
        serviceClient as never,
        'forged.service' as DatabaseServiceCapabilityId,
        {},
      ),
    Error,
    'Unregistered database API capability',
  );
  assertEquals(serviceClient.calls, []);

  const relationClient = new FakeCredentialBoundClient('service_role');
  assertThrows(
    () =>
      fromDatabaseApi(
        relationClient as never,
        'forged.relation' as DatabaseApiRelationCapabilityId,
      ),
    Error,
    'Unregistered database API capability',
  );
  assertEquals(relationClient.calls, []);
});
