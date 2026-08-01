import { assertEquals, assertThrows } from 'jsr:@std/assert';

import {
  callActorDatabaseApiRpc,
  callServiceDatabaseApiRpc,
  DATABASE_API_ACTOR_CAPABILITIES,
  DATABASE_API_RELATION_CAPABILITIES,
  DATABASE_API_SERVICE_CAPABILITIES,
  databaseApi,
  fromDatabaseApi,
  type DatabaseApiActorCapabilityId,
  type DatabaseApiRelationCapabilityId,
  type DatabaseApiServiceCapabilityId,
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

Deno.test(
  'all 10 actor capability IDs resolve exact routines through actor credentials',
  async () => {
    assertEquals(Object.keys(DATABASE_API_ACTOR_CAPABILITIES).length, 10);
    for (const [capabilityId, routine] of Object.entries(DATABASE_API_ACTOR_CAPABILITIES)) {
      const client = new FakeCredentialBoundClient('authenticated');
      await callActorDatabaseApiRpc(client as never, capabilityId as DatabaseApiActorCapabilityId, {
        proof: capabilityId,
      });
      assertEquals(client.calls, [
        { operation: 'schema', schema: 'api', credentialRole: 'authenticated' },
        {
          operation: 'rpc',
          routine,
          args: { proof: capabilityId },
          credentialRole: 'authenticated',
        },
      ]);
    }
  },
);

Deno.test(
  'all 3 service capability IDs resolve exact routines through service credentials',
  async () => {
    assertEquals(Object.keys(DATABASE_API_SERVICE_CAPABILITIES).length, 3);
    for (const [capabilityId, routine] of Object.entries(DATABASE_API_SERVICE_CAPABILITIES)) {
      const client = new FakeCredentialBoundClient('service_role');
      await callServiceDatabaseApiRpc(
        client as never,
        capabilityId as DatabaseApiServiceCapabilityId,
        { proof: capabilityId },
      );
      assertEquals(client.calls, [
        { operation: 'schema', schema: 'api', credentialRole: 'service_role' },
        {
          operation: 'rpc',
          routine,
          args: { proof: capabilityId },
          credentialRole: 'service_role',
        },
      ]);
    }
  },
);

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
      callActorDatabaseApiRpc(
        actorClient as never,
        'forged.actor' as DatabaseApiActorCapabilityId,
        {},
      ),
    Error,
    'Unregistered database API capability',
  );
  assertEquals(actorClient.calls, []);

  const serviceClient = new FakeCredentialBoundClient('service_role');
  assertThrows(
    () =>
      callServiceDatabaseApiRpc(
        serviceClient as never,
        'forged.service' as DatabaseApiServiceCapabilityId,
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
