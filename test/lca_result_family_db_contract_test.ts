import { assert, assertEquals } from 'jsr:@std/assert';
import { createClient } from 'jsr:@supabase/supabase-js@2.98.0';
import postgres from 'postgres';

import { createLcaResultFamilyCapabilityRepository } from '../supabase/functions/_shared/capabilities/lca_result_family.ts';
import { createLcaContributionPathResultHandler } from '../supabase/functions/lca_contribution_path_result/index.ts';
import { createLcaJobsHandler } from '../supabase/functions/lca_jobs/index.ts';
import { createLcaQueryResultsHandler } from '../supabase/functions/lca_query_results/index.ts';
import { createLcaResultsHandler } from '../supabase/functions/lca_results/index.ts';
import { finishLcaResultContract } from './lca_result_contract_cleanup.ts';

const enabled = Deno.env.get('LCA_RESULT_DB_CONTRACT') === '1';
const url = Deno.env.get('LCA_RESULT_CONTRACT_URL')?.trim() ?? '';
const directRestUrl = Deno.env.get('LCA_RESULT_CONTRACT_DIRECT_REST_URL')?.trim() ?? '';
const authUrl = Deno.env.get('LCA_RESULT_CONTRACT_AUTH_URL')?.trim() ?? '';
const databaseUrl = Deno.env.get('LCA_RESULT_CONTRACT_DB_URL')?.trim() ?? '';
const serviceKey = Deno.env.get('LCA_RESULT_CONTRACT_SERVICE_KEY')?.trim() ?? '';
const anonKey = Deno.env.get('LCA_RESULT_CONTRACT_ANON_KEY')?.trim() ?? '';
const publishableKey = Deno.env.get('LCA_RESULT_CONTRACT_PUBLISHABLE_KEY')?.trim() ?? '';
const expectedHead = Deno.env.get('LCA_RESULT_CONTRACT_MIGRATION_HEAD')?.trim() ?? '';
const expectedCommit = Deno.env.get('LCA_RESULT_CONTRACT_DATABASE_COMMIT')?.trim() ?? '';
const snapshotId = Deno.env.get('LCA_RESULT_CONTRACT_SNAPSHOT_ID')?.trim() ?? '';

const WORKER_ID = 'c2580000-0000-4000-8000-000000000010';
const RESULT_ID = 'c2580000-0000-4000-8000-000000000011';
const READY_CACHE_ID = 'c2580000-0000-4000-8000-000000000012';
const LEGACY_JOB_ID = 'c2580000-0000-4000-8000-000000000013';
const PENDING_WORKER_ID = 'c2580000-0000-4000-8000-000000000014';
const PENDING_CACHE_ID = 'c2580000-0000-4000-8000-000000000015';
const PENDING_LEGACY_ID = 'c2580000-0000-4000-8000-000000000016';
const LATEST_ID = 'c2580000-0000-4000-8000-000000000017';
const ADMIT_LEGACY_ID = 'c2580000-0000-4000-8000-000000000018';
const CANCELLED_WORKER_ID = 'c2580000-0000-4000-8000-000000000019';
const CANCELLED_CACHE_ID = 'c2580000-0000-4000-8000-000000000020';
const CANCELLED_LEGACY_ID = 'c2580000-0000-4000-8000-000000000021';
const RETRY_LEGACY_ID = 'c2580000-0000-4000-8000-000000000022';

const options = {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
};

type RpcTransport = {
  schema(name: string): {
    rpc(
      name: string,
      args?: Record<string, unknown>,
    ): PromiseLike<{
      data: unknown;
      error: { code?: string } | null;
    }>;
  };
};

function deniedCalls(client: RpcTransport, actorId: string) {
  const api = client.schema('api');
  return [
    api.rpc('lca_read_job_projection_v1', {
      p_requested_by: actorId,
      p_worker_job_id: WORKER_ID,
      p_legacy_job_id: null,
      p_include_internal: false,
    }),
    api.rpc('lca_read_result_projection_v1', {
      p_requested_by: actorId,
      p_result_id: RESULT_ID,
      p_required_artifact_format: null,
      p_include_internal: false,
    }),
    api.rpc('lca_read_latest_single_solve_result_v1', {
      p_requested_by: actorId,
      p_snapshot_id: snapshotId,
      p_process_index: 7,
    }),
    api.rpc('lca_read_result_cache_v1', {
      p_scope: 'issue258',
      p_snapshot_id: snapshotId,
      p_request_key: 'ready-key',
    }),
    api.rpc('cmd_lca_touch_result_cache_v1', { p_cache_id: READY_CACHE_ID }),
    api.rpc('cmd_lca_admit_result_cache_v1', {
      p_scope: 'issue258',
      p_snapshot_id: snapshotId,
      p_request_key: 'denied-key',
      p_request_payload: {},
      p_legacy_job_id: ADMIT_LEGACY_ID,
      p_worker_job_id: null,
      p_replace_ready: false,
    }),
    api.rpc('cmd_lca_reconcile_result_cache_v1', {
      p_requested_by: actorId,
      p_cache_id: PENDING_CACHE_ID,
    }),
    api.rpc('lca_read_latest_all_unit_result_v1', { p_snapshot_id: snapshotId }),
  ];
}

async function assertDenied(client: RpcTransport, actorId: string) {
  for (const response of await Promise.all(deniedCalls(client, actorId))) {
    assertEquals(response.data, null);
    assertEquals(response.error?.code, '42501');
  }
}

function startProxy(target: string): Deno.HttpServer {
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
  name: 'LCA result-family real Data API role matrix, lifecycle, retry and cleanup',
  ignore: !enabled,
  async fn() {
    assert(expectedCommit.length === 40, 'database commit receipt is required');
    const sql = postgres(databaseUrl, { max: 1, prepare: false });
    const proxy = directRestUrl ? startProxy(directRestUrl) : null;
    const address = proxy?.addr as Deno.NetAddr | undefined;
    const effectiveUrl = address ? `http://${address.hostname}:${address.port}` : url;
    const service = createClient(effectiveUrl, serviceKey, options);
    const authAdmin = createClient(authUrl, serviceKey, options);
    const email = `issue258-${snapshotId}@example.invalid`;
    const password = `Issue258-${snapshotId}-Aa1!`;
    let actorAuth: ReturnType<typeof createClient> | undefined;
    let actorId: string | undefined;
    let primaryError: unknown;
    try {
      const [{ head }] = await sql<[{ head: string | null }]>`
        select max(version)::text as head from supabase_migrations.schema_migrations
      `;
      assertEquals(head, expectedHead);

      const created = await authAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      assertEquals(created.error, null);
      actorId = created.data.user?.id;
      assert(actorId);

      await sql`
        insert into private.lca_network_snapshots (
          id, scope, process_filter, source_hash, status, created_by, created_at, updated_at
        ) values (
          ${snapshotId}::uuid, 'full_library', '{"issue258":true}'::jsonb,
          'issue258-source', 'ready', ${actorId}::uuid, now(), now()
        )
      `;
      await sql`
        insert into public.worker_jobs (
          id, job_kind, worker_queue, subject_type, subject_id, subject_version,
          requested_by, status, payload_schema_version, payload_json,
          created_at, updated_at, finished_at
        ) values
        (
          ${WORKER_ID}::uuid, 'lca.solve_one', 'solver', 'lca_job', ${LEGACY_JOB_ID}::uuid,
          ${snapshotId}, ${actorId}::uuid, 'completed', 'lca.solve_one.request.v1',
          jsonb_build_object('job_id', ${LEGACY_JOB_ID}::text, 'snapshot_id', ${snapshotId}::text),
          now(), now(), now()
        ),
        (
          ${PENDING_WORKER_ID}::uuid, 'lca.contribution_path', 'solver', 'lca_job',
          ${PENDING_LEGACY_ID}::uuid, ${snapshotId}, ${actorId}::uuid, 'completed',
          'lca.contribution_path.request.v1',
          jsonb_build_object('job_id', ${PENDING_LEGACY_ID}::text, 'snapshot_id', ${snapshotId}::text),
          now(), now(), now()
        ),
        (
          ${CANCELLED_WORKER_ID}::uuid, 'lca.contribution_path', 'solver', 'lca_job',
          ${CANCELLED_LEGACY_ID}::uuid, ${snapshotId}, ${actorId}::uuid, 'cancelled',
          'lca.contribution_path.request.v1',
          jsonb_build_object('job_id', ${CANCELLED_LEGACY_ID}::text, 'snapshot_id', ${snapshotId}::text),
          now(), now(), now()
        )
      `;
      await sql`
        insert into public.lca_results (
          id, job_id, worker_job_id, snapshot_id, diagnostics, artifact_url,
          artifact_sha256, artifact_byte_size, artifact_format, created_at
        ) values (
          ${RESULT_ID}::uuid, ${LEGACY_JOB_ID}::uuid, ${WORKER_ID}::uuid, ${snapshotId}::uuid,
          '{}'::jsonb, 'https://example.invalid/result.json', repeat('a', 64), 128,
          'contribution-path:v1', now()
        )
      `;
      await sql`
        insert into public.lca_result_cache (
          id, scope, snapshot_id, request_key, request_payload, status, job_id,
          worker_job_id, result_id, hit_count, last_accessed_at, created_at, updated_at
        ) values
        (
          ${READY_CACHE_ID}::uuid, 'issue258', ${snapshotId}::uuid, 'ready-key',
          '{"demand_mode":"single","demand":{"process_index":7,"amount":1}}'::jsonb,
          'ready', ${LEGACY_JOB_ID}::uuid, ${WORKER_ID}::uuid, ${RESULT_ID}::uuid,
          1, now(), now(), now()
        ),
        (
          ${PENDING_CACHE_ID}::uuid, 'issue258', ${snapshotId}::uuid, 'pending-key',
          '{}'::jsonb, 'pending', ${PENDING_LEGACY_ID}::uuid, ${PENDING_WORKER_ID}::uuid,
          null, 1, now(), now(), now()
        ),
        (
          ${CANCELLED_CACHE_ID}::uuid, 'issue258', ${snapshotId}::uuid, 'cancelled-key',
          '{}'::jsonb, 'pending', ${CANCELLED_LEGACY_ID}::uuid, ${CANCELLED_WORKER_ID}::uuid,
          null, 1, now(), now(), now()
        )
      `;
      await sql`
        insert into public.lca_latest_all_unit_results (
          id, snapshot_id, job_id, worker_job_id, result_id, query_artifact_url,
          query_artifact_sha256, query_artifact_byte_size, query_artifact_format,
          status, computed_at, created_at, updated_at
        ) values (
          ${LATEST_ID}::uuid, ${snapshotId}::uuid, ${LEGACY_JOB_ID}::uuid, ${WORKER_ID}::uuid,
          ${RESULT_ID}::uuid, 'https://example.invalid/query.json', repeat('b', 64), 256,
          'json:v1', 'ready', now(), now(), now()
        )
      `;

      const repository = createLcaResultFamilyCapabilityRepository(service as never);
      const jobRead = await repository.readJobProjection({
        requestedBy: actorId,
        workerJobId: WORKER_ID,
      });
      assert(jobRead.ok);
      assertEquals(jobRead.data?.job.workerJobId, WORKER_ID);
      assertEquals(jobRead.data?.result?.resultId, RESULT_ID);
      const resultRead = await repository.readResultProjection({
        requestedBy: actorId,
        resultId: RESULT_ID,
      });
      assert(resultRead.ok);
      assertEquals(resultRead.data?.result.artifact.artifactFormat, 'contribution-path:v1');
      const singleRead = await repository.readLatestSingleSolve({
        requestedBy: actorId,
        snapshotId,
        processIndex: 7,
      });
      assert(singleRead.ok);
      assertEquals(singleRead.data?.processIndex, 7);
      assertEquals(singleRead.data?.result.resultId, RESULT_ID);
      const cacheRead = await repository.readCache({
        scope: 'issue258',
        snapshotId,
        requestKey: 'ready-key',
      });
      assert(cacheRead.ok);
      assertEquals(cacheRead.data?.hitCount, 1);
      const touched = await repository.touchCache(READY_CACHE_ID);
      assert(touched.ok);
      assertEquals(touched.data?.hitCount, 2);
      const admitted = await repository.admitCache({
        scope: 'issue258',
        snapshotId,
        requestKey: 'admit-key',
        requestPayload: {},
        legacyJobId: ADMIT_LEGACY_ID,
      });
      assert(admitted.ok);
      assertEquals(admitted.data.outcome, 'accepted');
      assertEquals(admitted.data.cache.legacyJobId, ADMIT_LEGACY_ID);
      const reconciled = await repository.reconcileCache({
        requestedBy: actorId,
        cacheId: PENDING_CACHE_ID,
      });
      if (!reconciled.ok) {
        throw new Error(`real result_pending response was rejected: ${JSON.stringify(reconciled)}`);
      }
      assertEquals(reconciled.data.code, 'result_pending');
      if (reconciled.data.code === 'result_pending') {
        assertEquals(reconciled.data.workerStatus, 'completed');
        assertEquals(reconciled.data.cache.hitCount, 2);
        assertEquals(reconciled.data.cache.resultId, null);
      }
      const latest = await repository.readLatestAllUnit(snapshotId);
      assert(latest.ok);
      assertEquals(latest.data?.resultId, RESULT_ID);

      const cancelled = await repository.reconcileCache({
        requestedBy: actorId,
        cacheId: CANCELLED_CACHE_ID,
      });
      assert(cancelled.ok);
      assertEquals(cancelled.data.code, 'reconciled');
      if (cancelled.data.code === 'reconciled') {
        assertEquals(cancelled.data.workerStatus, 'cancelled');
        assertEquals(cancelled.data.cache.status, 'failed');
        assertEquals(cancelled.data.cache.hitCount, 2);
        assertEquals(cancelled.data.cache.legacyJobId, CANCELLED_LEGACY_ID);
        assertEquals(cancelled.data.cache.workerJobId, CANCELLED_WORKER_ID);
      }
      const retried = await repository.admitCache({
        scope: 'issue258',
        snapshotId,
        requestKey: 'cancelled-key',
        requestPayload: { retry: true },
        legacyJobId: RETRY_LEGACY_ID,
        workerJobId: null,
      });
      assert(retried.ok);
      assertEquals(retried.data.outcome, 'accepted');
      assertEquals(retried.data.cache.status, 'pending');
      assertEquals(retried.data.cache.hitCount, 3);
      assertEquals(retried.data.cache.legacyJobId, RETRY_LEGACY_ID);
      assertEquals(retried.data.cache.workerJobId, null);

      const auth = (async () => ({ isAuthenticated: true, user: { id: actorId } })) as never;
      const dependencies = {
        authenticateRequest: auth,
        getRedisClient: (async () => ({})) as never,
        resultRepository: repository,
      };
      assertEquals(
        (
          await createLcaJobsHandler(dependencies)(
            new Request(`http://edge/lca_jobs/${LEGACY_JOB_ID}`),
          )
        ).status,
        200,
      );
      assertEquals(
        (
          await createLcaResultsHandler(dependencies)(
            new Request(`http://edge/lca_results/${RESULT_ID}`),
          )
        ).status,
        200,
      );
      assertEquals(
        (
          await createLcaContributionPathResultHandler({
            ...dependencies,
            fetchArtifactJson: async () => ({ ok: true, data: { tree: [] } }),
          })(new Request(`http://edge/lca_contribution_path_result/${RESULT_ID}`))
        ).status,
        200,
      );
      const queryResponse = await createLcaQueryResultsHandler({
        authenticateRequest: auth,
        getRedisClient: (async () => ({})) as never,
        resultRepository: repository,
        snapshotRepository: {} as never,
        isSnapshotFresh: (async () => 'fresh') as never,
      })(
        new Request('http://edge/lca_query_results', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'invalid-contract-probe' }),
        }),
      );
      assertEquals(queryResponse.status, 400);
      assertEquals(await queryResponse.json(), { error: 'invalid_mode' });

      await assertDenied(
        createClient(effectiveUrl, anonKey, options) as unknown as RpcTransport,
        actorId,
      );
      actorAuth = createClient(authUrl, publishableKey, options);
      const signedIn = await actorAuth.auth.signInWithPassword({ email, password });
      assertEquals(signedIn.error, null);
      const token = signedIn.data.session?.access_token;
      assert(token);
      await assertDenied(
        createClient(effectiveUrl, publishableKey, {
          ...options,
          global: { headers: { Authorization: `Bearer ${token}` } },
        }) as unknown as RpcTransport,
        actorId,
      );
    } catch (error) {
      primaryError = error;
    } finally {
      let cleanupError: unknown;
      try {
        await finishLcaResultContract({
          primaryError,
          cleanupSteps: [
            {
              label: 'sign-out',
              async run() {
                if (!actorAuth) return;
                const signedOut = await actorAuth.auth.signOut({ scope: 'global' });
                if (signedOut.error) throw signedOut.error;
              },
            },
            {
              label: 'latest-delete',
              async run() {
                await sql`delete from public.lca_latest_all_unit_results where snapshot_id = ${snapshotId}::uuid`;
              },
            },
            {
              label: 'cache-delete',
              async run() {
                await sql`delete from public.lca_result_cache where snapshot_id = ${snapshotId}::uuid`;
              },
            },
            {
              label: 'result-delete',
              async run() {
                await sql`delete from public.lca_results where snapshot_id = ${snapshotId}::uuid`;
              },
            },
            {
              label: 'worker-delete',
              async run() {
                await sql`delete from public.worker_jobs where id in (
                  ${WORKER_ID}::uuid,
                  ${PENDING_WORKER_ID}::uuid,
                  ${CANCELLED_WORKER_ID}::uuid
                )`;
              },
            },
            {
              label: 'snapshot-delete',
              async run() {
                await sql`delete from private.lca_network_snapshots where id = ${snapshotId}::uuid`;
              },
            },
            {
              label: 'user-delete',
              async run() {
                if (!actorId) return;
                const deleted = await authAdmin.auth.admin.deleteUser(actorId);
                if (deleted.error) throw deleted.error;
              },
            },
            {
              label: 'proxy-shutdown',
              async run() {
                await proxy?.shutdown();
              },
            },
          ],
          async readback() {
            const [residue] = await sql<
              [
                {
                  caches: number;
                  results: number;
                  workers: number;
                  snapshots: number;
                  users: number;
                  sessions: number;
                },
              ]
            >`
              select
                (select count(*)::int from public.lca_result_cache where snapshot_id = ${snapshotId}::uuid) caches,
                (select count(*)::int from public.lca_results where snapshot_id = ${snapshotId}::uuid) results,
                (select count(*)::int from public.worker_jobs where id in (
                  ${WORKER_ID}::uuid,
                  ${PENDING_WORKER_ID}::uuid,
                  ${CANCELLED_WORKER_ID}::uuid
                )) workers,
                (select count(*)::int from private.lca_network_snapshots where id = ${snapshotId}::uuid) snapshots,
                (select count(*)::int from auth.users where email = ${email}) users,
                (select count(*)::int from auth.sessions where user_id = coalesce(${actorId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)) sessions
            `;
            assertEquals(residue, {
              caches: 0,
              results: 0,
              workers: 0,
              snapshots: 0,
              users: 0,
              sessions: 0,
            });
          },
        });
      } catch (error) {
        cleanupError = error;
      }
      await sql.end();
      if (cleanupError !== undefined) throw cleanupError;
    }
  },
});
