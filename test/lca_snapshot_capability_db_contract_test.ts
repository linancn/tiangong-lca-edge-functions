import { assert, assertEquals } from 'jsr:@std/assert';
import { createClient } from 'jsr:@supabase/supabase-js@2.98.0';
import postgres from 'postgres';

import { createLcaSnapshotCapabilityRepository } from '../supabase/functions/_shared/capabilities/lca_snapshot_family.ts';
import { finishLcaSnapshotContract } from './lca_snapshot_contract_cleanup.ts';

const contractEnabled = Deno.env.get('LCA_SNAPSHOT_DB_CONTRACT') === '1';
const url = Deno.env.get('LCA_SNAPSHOT_CONTRACT_URL')?.trim() ?? '';
const directRestUrl = Deno.env.get('LCA_SNAPSHOT_CONTRACT_DIRECT_REST_URL')?.trim() ?? '';
const authUrl = Deno.env.get('LCA_SNAPSHOT_CONTRACT_AUTH_URL')?.trim() ?? '';
const databaseUrl = Deno.env.get('LCA_SNAPSHOT_CONTRACT_DB_URL')?.trim() ?? '';
const serviceKey = Deno.env.get('LCA_SNAPSHOT_CONTRACT_SERVICE_KEY')?.trim() ?? '';
const anonKey = Deno.env.get('LCA_SNAPSHOT_CONTRACT_ANON_KEY')?.trim() ?? '';
const publishableKey = Deno.env.get('LCA_SNAPSHOT_CONTRACT_PUBLISHABLE_KEY')?.trim() ?? '';
const fixtureSnapshotId = Deno.env.get('LCA_SNAPSHOT_CONTRACT_FIXTURE_ID')?.trim() ?? '';
const createSnapshotId = Deno.env.get('LCA_SNAPSHOT_CONTRACT_CREATE_ID')?.trim() ?? '';
const fixtureActorId = Deno.env.get('LCA_SNAPSHOT_CONTRACT_ACTOR_ID')?.trim() ?? '';
const enabled = Boolean(
  contractEnabled &&
  (url || directRestUrl) &&
  databaseUrl &&
  serviceKey &&
  anonKey &&
  publishableKey &&
  fixtureSnapshotId &&
  createSnapshotId &&
  fixtureActorId &&
  authUrl,
);

const options = {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
};

type RpcTransport = {
  schema(name: string): {
    rpc(
      name: string,
      args?: Record<string, unknown>,
    ): PromiseLike<{ data: unknown; error: { code?: string } | null }>;
  };
};

function deniedRpcCalls(client: RpcTransport) {
  const api = client.schema('api');
  return [
    api.rpc('lca_snapshot_active_read_v1', { p_scope: 'issue256-contract' }),
    api.rpc('lca_snapshot_scope_read_v1', { p_snapshot_id: fixtureSnapshotId }),
    api.rpc('lca_snapshot_resolve_v1', {
      p_scope: 'prod',
      p_process_filter: { issue256: true },
    }),
    api.rpc('lca_snapshot_artifact_read_v1', { p_snapshot_id: fixtureSnapshotId }),
    api.rpc('lca_snapshot_artifact_latest_v1'),
    api.rpc('cmd_lca_snapshot_create_v1', {
      p_snapshot_id: 'c2560000-0000-4000-8000-000000000099',
      p_scope: 'full_library',
      p_process_filter: { denied: true },
      p_created_by: fixtureActorId,
    }),
  ];
}

async function assertTransportDenied(client: RpcTransport) {
  for (const response of await Promise.all(deniedRpcCalls(client))) {
    assertEquals(response.data, null);
    assertEquals(response.error?.code, '42501');
  }
}

function startDirectRestProxy(target: string): Deno.HttpServer {
  return Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (request) => {
    const incoming = new URL(request.url);
    const path = incoming.pathname.replace(/^\/rest\/v1/, '') || '/';
    return fetch(`${target}${path}${incoming.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
    });
  });
}

Deno.test({
  name: 'LCA snapshot api capability passes service/anon/authenticated transport and retry',
  ignore: !enabled,
  async fn() {
    const sql = postgres(databaseUrl, { max: 1, prepare: false });
    const proxy = directRestUrl ? startDirectRestProxy(directRestUrl) : null;
    const proxyAddress = proxy?.addr as Deno.NetAddr | undefined;
    const effectiveUrl = proxyAddress
      ? `http://${proxyAddress.hostname}:${proxyAddress.port}`
      : url;
    const service = createClient(effectiveUrl, serviceKey, options);
    const authAdmin = createClient(authUrl, serviceKey, options);
    const email = `issue256-${createSnapshotId}@example.invalid`;
    const password = `Issue256-${createSnapshotId}-Aa1!`;
    let actorAuth: ReturnType<typeof createClient> | undefined;
    let createdUserId: string | undefined;
    let primaryError: unknown;
    try {
      const [{ head }] = await sql<[{ head: string | null }]>`
        select max(version)::text as head from supabase_migrations.schema_migrations
      `;
      assertEquals(head, '20260802091342');
      await sql`
        insert into private.lca_network_snapshots (
          id, scope, process_filter, source_hash, status, created_by, created_at, updated_at
        ) values (
          ${fixtureSnapshotId}::uuid, 'full_library', '{"issue256":true}'::jsonb,
          'issue256-source', 'ready', ${fixtureActorId}::uuid,
          '2099-08-02T00:00:00Z'::timestamptz, '2099-08-02T00:00:00Z'::timestamptz
        )
      `;
      await sql`
        insert into private.lca_snapshot_artifacts (
          id, snapshot_id, artifact_url, artifact_sha256, artifact_byte_size,
          artifact_format, process_count, flow_count, impact_count, a_nnz, b_nnz, c_nnz,
          status, created_at, updated_at
        ) values (
          'c2560000-0000-4000-8000-000000000002'::uuid, ${fixtureSnapshotId}::uuid,
          'https://example.invalid/issue256.h5', repeat('a', 64), 256,
          'hdf5', 12, 34, 5, 1, 2, 3, 'ready',
          '2099-08-02T00:00:01Z'::timestamptz, '2099-08-02T00:00:01Z'::timestamptz
        )
      `;
      await sql`
        insert into private.lca_active_snapshots (
          scope, snapshot_id, source_hash, activated_at, activated_by, note
        ) values (
          'issue256-contract', ${fixtureSnapshotId}::uuid, 'issue256-source',
          '2099-08-02T00:00:02Z'::timestamptz, ${fixtureActorId}::uuid,
          'Edge issue 256 contract fixture'
        )
      `;

      const repository = createLcaSnapshotCapabilityRepository(service as never);

      const active = await repository.readActive('issue256-contract');
      assertEquals(active.error, null);
      assertEquals(active.data?.snapshot_id, fixtureSnapshotId);

      const scope = await repository.readScope(fixtureSnapshotId);
      assertEquals(scope.error, null);
      assertEquals(scope.data?.status, 'ready');
      assertEquals(scope.data?.process_filter, { issue256: true });

      const resolved = await repository.resolveReady('prod', { issue256: true });
      assertEquals(resolved.error, null);
      assert(resolved.data.some((row) => row.id === fixtureSnapshotId));

      const artifact = await repository.readArtifact(fixtureSnapshotId);
      assertEquals(artifact.error, null);
      assertEquals(artifact.data?.artifact_url, 'https://example.invalid/issue256.h5');
      assertEquals(artifact.data?.process_count, 12);

      const latest = await repository.readLatestArtifact();
      assertEquals(latest.error, null);
      assertEquals(latest.data?.snapshot_id, fixtureSnapshotId);

      const createRequest = {
        snapshotId: createSnapshotId,
        scope: 'full_library' as const,
        processFilter: { issue256Create: true },
        createdBy: fixtureActorId,
      };
      assertEquals((await repository.createDraft(createRequest)).data?.created, true);
      assertEquals((await repository.createDraft(createRequest)).data?.created, false);
      assertEquals((await repository.readScope(createSnapshotId)).data?.status, 'draft');

      // The disposable direct PostgREST transport has no Kong key translation. Its checked
      // anon role therefore uses the real project anon JWT, while the publishable key below
      // is used only with GoTrue to obtain a real authenticated access token.
      await assertTransportDenied(
        createClient(effectiveUrl, anonKey, options) as unknown as RpcTransport,
      );

      const createdUser = await authAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      assertEquals(createdUser.error, null);
      assert(createdUser.data.user);
      createdUserId = createdUser.data.user.id;
      actorAuth = createClient(authUrl, publishableKey, options);
      const signedIn = await actorAuth.auth.signInWithPassword({ email, password });
      assertEquals(signedIn.error, null);
      const accessToken = signedIn.data.session?.access_token;
      assert(accessToken);
      const authenticatedTransport = createClient(effectiveUrl, publishableKey, {
        ...options,
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
      await assertTransportDenied(authenticatedTransport as unknown as RpcTransport);
    } catch (error) {
      primaryError = error;
    } finally {
      let contractOrCleanupError: unknown;
      try {
        await finishLcaSnapshotContract({
          primaryError,
          cleanupSteps: [
            {
              label: 'authenticated-session-sign-out',
              async run() {
                if (!actorAuth) return;
                const signedOut = await actorAuth.auth.signOut({ scope: 'global' });
                if (signedOut.error) throw signedOut.error;
              },
            },
            {
              label: 'authenticated-user-delete',
              async run() {
                if (!createdUserId) return;
                const deleted = await authAdmin.auth.admin.deleteUser(createdUserId);
                if (deleted.error) throw deleted.error;
              },
            },
            {
              label: 'active-snapshot-delete',
              async run() {
                await sql`
                  delete from private.lca_active_snapshots
                  where snapshot_id in (${fixtureSnapshotId}::uuid, ${createSnapshotId}::uuid)
                `;
              },
            },
            {
              label: 'snapshot-artifact-delete',
              async run() {
                await sql`
                  delete from private.lca_snapshot_artifacts
                  where snapshot_id in (${fixtureSnapshotId}::uuid, ${createSnapshotId}::uuid)
                `;
              },
            },
            {
              label: 'snapshot-network-delete',
              async run() {
                await sql`
                  delete from private.lca_network_snapshots
                  where id in (${fixtureSnapshotId}::uuid, ${createSnapshotId}::uuid)
                `;
              },
            },
            {
              label: 'direct-rest-proxy-shutdown',
              async run() {
                await proxy?.shutdown();
              },
            },
          ],
          async readback() {
            const [residue] = await sql<
              [
                {
                  network: number;
                  artifact: number;
                  active: number;
                  users: number;
                  sessions: number;
                },
              ]
            >`
              select
                (select count(*)::int from private.lca_network_snapshots
                 where id in (${fixtureSnapshotId}::uuid, ${createSnapshotId}::uuid)) as network,
                (select count(*)::int from private.lca_snapshot_artifacts
                 where snapshot_id in (${fixtureSnapshotId}::uuid, ${createSnapshotId}::uuid)) as artifact,
                (select count(*)::int from private.lca_active_snapshots
                 where snapshot_id in (${fixtureSnapshotId}::uuid, ${createSnapshotId}::uuid)) as active,
                (select count(*)::int from auth.users where email = ${email}) as users,
                (select count(*)::int from auth.sessions
                 where user_id = coalesce(${createdUserId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)) as sessions
            `;
            assertEquals(residue, {
              network: 0,
              artifact: 0,
              active: 0,
              users: 0,
              sessions: 0,
            });
          },
        });
      } catch (error) {
        contractOrCleanupError = error;
      }
      let connectionCleanupError: unknown;
      try {
        await sql.end();
      } catch (error) {
        connectionCleanupError = error;
      }
      if (contractOrCleanupError !== undefined && connectionCleanupError !== undefined) {
        throw new AggregateError(
          [contractOrCleanupError, connectionCleanupError],
          'LCA snapshot contract, cleanup, or DB connection shutdown failed',
        );
      }
      if (contractOrCleanupError !== undefined) {
        throw contractOrCleanupError;
      }
      if (connectionCleanupError !== undefined) {
        throw connectionCleanupError;
      }
    }
  },
});
