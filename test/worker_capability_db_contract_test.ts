import { assert, assertEquals } from 'jsr:@std/assert';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';
import postgres from 'postgres';

import {
  buildWorkerJobCancelRpcArgs,
  buildWorkerJobEnqueueRpcArgs,
  buildWorkerJobListByConcurrencyKeyRpcArgs,
  buildWorkerJobListRpcArgs,
  buildWorkerJobReadManyRpcArgs,
  buildWorkerJobReadRpcArgs,
  createServiceWorkerCapabilityRepository,
  WORKER_CAPABILITY_CONTRACT,
} from '../supabase/functions/_shared/capabilities/worker_jobs.ts';
import { resolveActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import { executeWorkerJobCommand } from '../supabase/functions/_shared/commands/worker_jobs.ts';
import { createAppWorkerJobsHandler } from '../supabase/functions/app_worker_jobs/index.ts';

const CONTRACT_ENABLED = Deno.env.get('WORKER_CAPABILITY_DB_CONTRACT') === '1';
const EXPECTED_DATABASE_COMMIT = '6809528c32bac8163e9a6eec9b985d57370589e1';
const EXPECTED_DATABASE_MIGRATION_HEAD = '20260801060304';
const EXPECTED_HOSTED_PROJECT_REF = 'nlcyzijvoyufjoqgxlku';
const EXPECTED_HOSTED_PARENT_PROJECT_REF = 'qgzvkongdjqiiamzbbts';
const EXPECTED_HOSTED_BRANCH_ID = 'b3167c24-4998-4d85-8f1d-e91510d00311';
const EXPECTED_DATABASE_BRANCH = 'codex/issue-356-worker-control-plane';
const EXPECTED_DATABASE_PR = 365;
const EXPECTED_DATABASE_MIGRATION_NAME = 'issue_356_worker_control_plane_physical_expand';
const EXPECTED_DATABASE_MIGRATION_FILE =
  'supabase/migrations/20260801060304_issue_356_worker_control_plane_physical_expand.sql';
const EXPECTED_DATABASE_MIGRATION_FILE_SHA256 =
  '19e3069a94d3ca42191e29f72904df4f84b5108af9896a4d0b5b9b44232a9d58';
const EXPECTED_HOSTED_MIGRATION_RECEIPT_SHA256 =
  'd0412c27c5311edc006e476b8a5d0b69e1dd9dfcf1423bbdf669ad1b53ad923f';
const EXPECTED_RESIDUE_VIEW_DEFINITION_MD5 = '80779a3fc370b05053792c3f73b7a35d';
const EXPECTED_RESIDUE_CONTRACT = 'worker-control-plane.private-physical-expand.v1';

function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) {
      return value;
    }
  }
  throw new Error(`Missing Worker capability contract environment: ${names.join(' or ')}`);
}

function contractConfig() {
  const url = requireEnv('WORKER_CAPABILITY_SUPABASE_URL', 'SUPABASE_URL');
  const hostname = new URL(url).hostname;
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
  const mode = Deno.env.get('WORKER_CAPABILITY_CONTRACT_MODE')?.trim() ?? 'local';
  if (mode !== 'local' && mode !== 'hosted-preview') {
    throw new Error('WORKER_CAPABILITY_CONTRACT_MODE must be local or hosted-preview');
  }
  if (mode === 'local' && !loopback) {
    throw new Error('Local Worker capability contract refuses non-loopback Supabase URLs');
  }
  if (mode === 'hosted-preview') {
    assertEquals(hostname, `${EXPECTED_HOSTED_PROJECT_REF}.supabase.co`);
  }
  const databaseUrl = mode === 'local' ? requireEnv('WORKER_CAPABILITY_DB_URL') : undefined;
  if (databaseUrl) {
    const databaseHostname = new URL(databaseUrl).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(databaseHostname)) {
      throw new Error('Worker capability DB contract refuses non-loopback database URLs');
    }
  }
  return {
    mode,
    url,
    databaseUrl,
    managementAccessToken:
      mode === 'hosted-preview'
        ? requireEnv('WORKER_CAPABILITY_SUPABASE_ACCESS_TOKEN', 'SUPABASE_ACCESS_TOKEN')
        : undefined,
    publishableKey: requireEnv(
      'WORKER_CAPABILITY_SUPABASE_PUBLISHABLE_KEY',
      'SUPABASE_PUBLISHABLE_KEY',
      'SUPABASE_ANON_KEY',
    ),
    serviceKey: requireEnv(
      'WORKER_CAPABILITY_SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SECRET_KEY',
    ),
  };
}

async function assertExactMigrationHead(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const rows = await sql<[{ head: string | null }]>`
      select max(version)::text as head
      from supabase_migrations.schema_migrations
    `;
    assertEquals(
      rows[0]?.head,
      EXPECTED_DATABASE_MIGRATION_HEAD,
      'real DB contract requires the coordinated database-engine migration head',
    );
  } finally {
    await sql.end();
  }
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchJson<T>(
  url: string,
  expectedStatus: number,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, init);
  assertEquals(response.status, expectedStatus, `unexpected attestation response from ${url}`);
  return (await response.json()) as T;
}

async function assertHostedProvenance(config: ReturnType<typeof contractConfig>) {
  assert(config.managementAccessToken, 'hosted Preview attestation requires a management token');
  const managementHeaders = {
    Authorization: `Bearer ${config.managementAccessToken}`,
    'content-type': 'application/json',
  };

  const branches = await fetchJson<
    Array<{
      id?: string;
      name?: string;
      project_ref?: string;
      parent_project_ref?: string;
      is_default?: boolean;
      persistent?: boolean;
      preview_project_status?: string;
    }>
  >(`https://api.supabase.com/v1/projects/${EXPECTED_HOSTED_PARENT_PROJECT_REF}/branches`, 200, {
    headers: managementHeaders,
  });
  const branch = branches.find(
    (candidate) => candidate.project_ref === EXPECTED_HOSTED_PROJECT_REF,
  );
  assert(branch, 'Supabase branch API must resolve the exact hosted Preview ref');
  assertEquals(branch.id, EXPECTED_HOSTED_BRANCH_ID);
  assertEquals(branch.name, EXPECTED_DATABASE_BRANCH);
  assertEquals(branch.parent_project_ref, EXPECTED_HOSTED_PARENT_PROJECT_REF);
  assertEquals(branch.is_default, false);
  assertEquals(branch.persistent, false);
  assertEquals(branch.preview_project_status, 'ACTIVE_HEALTHY');

  const migrations = await fetchJson<Array<{ version?: string; name?: string }>>(
    `https://api.supabase.com/v1/projects/${EXPECTED_HOSTED_PROJECT_REF}/database/migrations`,
    200,
    { headers: managementHeaders },
  );
  const migrationHead = migrations
    .toSorted((left, right) => String(left.version).localeCompare(String(right.version)))
    .at(-1);
  assertEquals(migrationHead?.version, EXPECTED_DATABASE_MIGRATION_HEAD);
  assertEquals(migrationHead?.name, EXPECTED_DATABASE_MIGRATION_NAME);

  const migrationReceipt = await fetchJson<{
    version?: string;
    name?: string;
    statements?: unknown[];
  }>(
    `https://api.supabase.com/v1/projects/${EXPECTED_HOSTED_PROJECT_REF}/database/migrations/${EXPECTED_DATABASE_MIGRATION_HEAD}`,
    200,
    { headers: managementHeaders },
  );
  assertEquals(migrationReceipt.version, EXPECTED_DATABASE_MIGRATION_HEAD);
  assertEquals(migrationReceipt.name, EXPECTED_DATABASE_MIGRATION_NAME);
  assert(Array.isArray(migrationReceipt.statements));
  assertEquals(
    await sha256Hex(
      JSON.stringify({
        version: migrationReceipt.version,
        name: migrationReceipt.name,
        statements: migrationReceipt.statements,
      }),
    ),
    EXPECTED_HOSTED_MIGRATION_RECEIPT_SHA256,
  );

  const attestationQuery = `
    select
      ledger.migration_head,
      residue.residue->>'contractVersion' as contract_version,
      residue.residue->>'migrationVersion' as residue_migration_version,
      (residue.residue->>'contractReady')::boolean as contract_ready,
      c.relkind::text as relkind,
      owner_role.rolname as owner,
      pg_catalog.md5(pg_catalog.pg_get_viewdef(c.oid, true)) as definition_md5,
      pg_catalog.has_table_privilege('service_role', 'private.worker_control_plane_contract_residue', 'select') as service_select,
      pg_catalog.has_table_privilege('service_role', 'private.worker_control_plane_contract_residue', 'insert') as service_insert,
      pg_catalog.has_table_privilege('service_role', 'private.worker_control_plane_contract_residue', 'update') as service_update,
      pg_catalog.has_table_privilege('service_role', 'private.worker_control_plane_contract_residue', 'delete') as service_delete,
      pg_catalog.has_table_privilege('anon', 'private.worker_control_plane_contract_residue', 'select') as anon_select,
      pg_catalog.has_table_privilege('authenticated', 'private.worker_control_plane_contract_residue', 'select') as authenticated_select
    from private.worker_control_plane_contract_residue as residue
    cross join (
      select pg_catalog.max(version)::text as migration_head
      from supabase_migrations.schema_migrations
    ) as ledger
    join pg_catalog.pg_class as c on c.oid = 'private.worker_control_plane_contract_residue'::pg_catalog.regclass
    join pg_catalog.pg_roles as owner_role on owner_role.oid = c.relowner
  `;
  const [databaseAttestation] = await fetchJson<
    Array<{
      migration_head?: string;
      contract_version?: string;
      residue_migration_version?: string;
      contract_ready?: boolean;
      relkind?: string;
      owner?: string;
      definition_md5?: string;
      service_select?: boolean;
      service_insert?: boolean;
      service_update?: boolean;
      service_delete?: boolean;
      anon_select?: boolean;
      authenticated_select?: boolean;
    }>
  >(
    `https://api.supabase.com/v1/projects/${EXPECTED_HOSTED_PROJECT_REF}/database/query/read-only`,
    201,
    {
      method: 'POST',
      headers: managementHeaders,
      body: JSON.stringify({ query: attestationQuery }),
    },
  );
  assert(databaseAttestation, 'migration-generated database attestation must exist');
  assertEquals(databaseAttestation.migration_head, EXPECTED_DATABASE_MIGRATION_HEAD);
  assertEquals(databaseAttestation.contract_version, EXPECTED_RESIDUE_CONTRACT);
  assertEquals(databaseAttestation.residue_migration_version, EXPECTED_DATABASE_MIGRATION_HEAD);
  assertEquals(databaseAttestation.contract_ready, false);
  assertEquals(databaseAttestation.relkind, 'v');
  assertEquals(databaseAttestation.owner, 'postgres');
  assertEquals(databaseAttestation.definition_md5, EXPECTED_RESIDUE_VIEW_DEFINITION_MD5);
  assertEquals(databaseAttestation.service_select, true);
  assertEquals(databaseAttestation.service_insert, false);
  assertEquals(databaseAttestation.service_update, false);
  assertEquals(databaseAttestation.service_delete, false);
  assertEquals(databaseAttestation.anon_select, false);
  assertEquals(databaseAttestation.authenticated_select, false);

  const githubHeaders: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'tiangong-lca-edge-worker-capability-contract',
  };
  const githubToken = Deno.env.get('GITHUB_TOKEN')?.trim();
  if (githubToken) {
    githubHeaders.Authorization = `Bearer ${githubToken}`;
  }
  const pullRequest = await fetchJson<{
    state?: string;
    merged?: boolean;
    head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
    base?: { ref?: string; repo?: { full_name?: string } };
  }>(
    `https://api.github.com/repos/tiangong-lca/database-engine/pulls/${EXPECTED_DATABASE_PR}`,
    200,
    { headers: githubHeaders },
  );
  assertEquals(pullRequest.state, 'closed');
  assertEquals(pullRequest.merged, true);
  assertEquals(pullRequest.head?.repo?.full_name, 'tiangong-lca/database-engine');
  assertEquals(pullRequest.head?.ref, branch.name);
  assertEquals(pullRequest.head?.sha, EXPECTED_DATABASE_COMMIT);
  assertEquals(pullRequest.base?.repo?.full_name, 'tiangong-lca/database-engine');
  assertEquals(pullRequest.base?.ref, 'dev');

  const migrationSource = await fetchJson<{ content?: string }>(
    `https://api.github.com/repos/tiangong-lca/database-engine/contents/${EXPECTED_DATABASE_MIGRATION_FILE}?ref=${EXPECTED_DATABASE_COMMIT}`,
    200,
    { headers: githubHeaders },
  );
  assert(migrationSource.content, 'exact database commit must contain the attested migration');
  const sourceBytes = Uint8Array.from(
    atob(migrationSource.content.replaceAll(/\s/g, '')),
    (character) => character.charCodeAt(0),
  );
  assertEquals(await sha256Hex(sourceBytes), EXPECTED_DATABASE_MIGRATION_FILE_SHA256);
}

function requestClient(url: string, publishableKey: string, accessToken?: string): SupabaseClient {
  return createClient(url, publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : undefined,
  });
}

async function createLocalUser(service: SupabaseClient, label: string) {
  const password = `Local-contract-${crypto.randomUUID()}!`;
  const email = `worker-capability-${label}-${crypto.randomUUID()}@example.invalid`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`Unable to create local contract user: ${error?.message ?? 'missing user'}`);
  }
  return { id: data.user.id, email, password };
}

async function createAdminUser(service: SupabaseClient) {
  const user = await createLocalUser(service, 'admin');
  const { error } = await service.auth.admin.updateUserById(user.id, {
    app_metadata: { role: 'admin', roles: ['admin'] },
  });
  if (error) {
    throw new Error(`Unable to mark contract admin user: ${error.message}`);
  }
  return user;
}

async function signIn(client: SupabaseClient, email: string, password: string) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token) {
    throw new Error(
      `Unable to sign in local contract user: ${error?.message ?? 'missing session'}`,
    );
  }
  return data.session.access_token;
}

function signInWithFreshClient(
  url: string,
  publishableKey: string,
  email: string,
  password: string,
) {
  return signIn(requestClient(url, publishableKey), email, password);
}

async function assertNeverAuthenticated(client: SupabaseClient, label: string) {
  const { data, error } = await client.auth.getSession();
  assertEquals(error, null, `${label} session lookup must succeed`);
  assertEquals(data.session, null, `${label} must remain a never-authenticated client`);
}

function assertPostgrestPermissionDenied(
  error: { code?: string; message?: string } | null,
  label: string,
) {
  assert(error, `${label} must return a PostgREST permission error`);
  assert(
    error.code === '42501',
    `${label} returned unexpected PostgREST code ${error.code ?? 'missing'}`,
  );
}

function post(url: string, token: string | null, body: unknown, apiKey?: string) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (apiKey) {
    headers.set('apikey', apiKey);
  }
  return new Request(`${url}/functions/v1/${WORKER_CAPABILITY_CONTRACT.edgeFunction}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function withoutAuthDebugLogs<T>(operation: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return await operation();
  } finally {
    console.log = originalLog;
  }
}

Deno.test({
  name: 'worker capability contract enforces schema profile, auth matrix, ownership, service facade, and idempotency on a real DB',
  ignore: !CONTRACT_ENABLED,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const config = contractConfig();
    if (config.databaseUrl) {
      await assertExactMigrationHead(config.databaseUrl);
    }
    if (config.mode === 'hosted-preview') {
      await assertHostedProvenance(config);
    }
    const service = createClient(config.url, config.serviceKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    const worker = createServiceWorkerCapabilityRepository(service);
    const cleanupJobIds = new Set<string>();
    // This client is reserved for anonymous probes. Token acquisition must use
    // separate clients because supabase-js reads each client's current auth session.
    const anonymous = requestClient(config.url, config.publishableKey);
    let owner: Awaited<ReturnType<typeof createLocalUser>> | undefined;
    let foreign: Awaited<ReturnType<typeof createLocalUser>> | undefined;
    let admin: Awaited<ReturnType<typeof createLocalUser>> | undefined;

    try {
      owner = await createLocalUser(service, 'owner');
      foreign = await createLocalUser(service, 'foreign');
      admin = await createAdminUser(service);
      const ownerToken = await signInWithFreshClient(
        config.url,
        config.publishableKey,
        owner.email,
        owner.password,
      );
      const foreignToken = await signInWithFreshClient(
        config.url,
        config.publishableKey,
        foreign.email,
        foreign.password,
      );
      const adminToken = await signInWithFreshClient(
        config.url,
        config.publishableKey,
        admin.email,
        admin.password,
      );
      await assertNeverAuthenticated(anonymous, 'anonymous probe client after JWT acquisition');
      const ownerClient = requestClient(config.url, config.publishableKey, ownerToken);
      const foreignClient = requestClient(config.url, config.publishableKey, foreignToken);
      const adminClient = requestClient(config.url, config.publishableKey, adminToken);
      const idempotencyKey = `edge-worker-contract:${crypto.randomUUID()}`;
      const enqueueRequest = {
        jobKind: 'review_submit.gate',
        payload: { contractProbe: true },
        payloadSchemaVersion: 'review_submit.gate.request.v1',
        requestedBy: owner.id,
        requesterType: 'user' as const,
        idempotencyKey,
        requestHash: idempotencyKey,
        concurrencyKey: idempotencyKey,
        visibility: 'user' as const,
      };

      const firstEnqueue = await worker.enqueue(enqueueRequest);
      const retryEnqueue = await worker.enqueue(enqueueRequest);
      assert(firstEnqueue.ok);
      assert(retryEnqueue.ok);
      const firstJob = firstEnqueue.data as { id?: string };
      const retryJob = retryEnqueue.data as { id?: string };
      assert(firstJob.id);
      cleanupJobIds.add(firstJob.id);
      assertEquals(retryJob.id, firstJob.id);

      const serviceRead = await worker.read({ jobId: firstJob.id, includeInternal: true });
      assert(serviceRead.ok);
      assertEquals((serviceRead.data as { requestedBy?: string }).requestedBy, owner.id);

      const serviceBatchRead = await worker.readManyInternal([firstJob.id, firstJob.id]);
      assert(serviceBatchRead.ok, JSON.stringify(serviceBatchRead));
      assertEquals((serviceBatchRead.data as unknown[]).length, 1);

      const serviceConcurrencyRead = await worker.listByConcurrencyKey({
        jobKind: enqueueRequest.jobKind,
        concurrencyKey: idempotencyKey,
        statuses: ['queued'],
        limit: 20,
        includeInternal: true,
      });
      assert(serviceConcurrencyRead.ok, JSON.stringify(serviceConcurrencyRead));
      assertEquals(serviceConcurrencyRead.data[0]?.id, firstJob.id);

      const serviceList = await worker.list({
        requestedBy: owner.id,
        statuses: ['queued'],
        visibility: 'user',
        limit: 50,
        includeInternal: true,
      });
      assert(serviceList.ok, JSON.stringify(serviceList));
      assert(
        serviceList.data.some((job) => job.id === firstJob.id),
        'service list must return the controlled contract job',
      );

      const serviceCancelIdempotencyKey = `edge-worker-contract-cancel:${crypto.randomUUID()}`;
      const serviceCancelEnqueue = await worker.enqueue({
        ...enqueueRequest,
        idempotencyKey: serviceCancelIdempotencyKey,
        requestHash: serviceCancelIdempotencyKey,
        concurrencyKey: serviceCancelIdempotencyKey,
      });
      assert(serviceCancelEnqueue.ok, JSON.stringify(serviceCancelEnqueue));
      assert(serviceCancelEnqueue.data.id);
      cleanupJobIds.add(serviceCancelEnqueue.data.id);
      const serviceCancel = await worker.cancel({
        jobId: serviceCancelEnqueue.data.id,
        cancelledBy: owner.id,
        reason: 'hosted_contract_service_cancel',
      });
      assert(serviceCancel.ok, JSON.stringify(serviceCancel));
      assertEquals(serviceCancel.data.status, 'cancelled');
      cleanupJobIds.delete(serviceCancelEnqueue.data.id);

      const negativeRpcProbes = [
        {
          label: 'enqueue',
          routine: WORKER_CAPABILITY_CONTRACT.database.routine.enqueue,
          args: buildWorkerJobEnqueueRpcArgs({
            ...enqueueRequest,
            idempotencyKey: `forbidden:${crypto.randomUUID()}`,
            requestHash: `forbidden:${crypto.randomUUID()}`,
            concurrencyKey: `forbidden:${crypto.randomUUID()}`,
          }),
        },
        {
          label: 'read',
          routine: WORKER_CAPABILITY_CONTRACT.database.routine.read,
          args: buildWorkerJobReadRpcArgs({ jobId: firstJob.id, includeInternal: false }),
        },
        {
          label: 'read-many',
          routine: WORKER_CAPABILITY_CONTRACT.database.routine.readMany,
          args: buildWorkerJobReadManyRpcArgs([firstJob.id], false),
        },
        {
          label: 'list',
          routine: WORKER_CAPABILITY_CONTRACT.database.routine.list,
          args: buildWorkerJobListRpcArgs({
            requestedBy: owner.id,
            statuses: ['queued'],
            limit: 20,
            includeInternal: false,
          }),
        },
        {
          label: 'concurrency-list',
          routine: WORKER_CAPABILITY_CONTRACT.database.routine.listByConcurrencyKey,
          args: buildWorkerJobListByConcurrencyKeyRpcArgs({
            jobKind: enqueueRequest.jobKind,
            concurrencyKey: idempotencyKey,
            statuses: ['queued'],
            limit: 20,
            includeInternal: true,
          }),
        },
        {
          label: 'cancel',
          routine: WORKER_CAPABILITY_CONTRACT.database.routine.cancel,
          args: buildWorkerJobCancelRpcArgs({
            jobId: firstJob.id,
            cancelledBy: owner.id,
            reason: 'forbidden_contract_probe',
          }),
        },
      ] as const;

      for (const [label, client] of [
        ['anon', anonymous],
        ['foreign', foreignClient],
        ['owner', ownerClient],
        ['admin', adminClient],
      ] as const) {
        for (const probe of negativeRpcProbes) {
          const result = await client
            .schema(WORKER_CAPABILITY_CONTRACT.database.schema)
            .rpc(probe.routine, probe.args);
          assertPostgrestPermissionDenied(
            result.error,
            `${label} service-only api Worker ${probe.label} RPC`,
          );
        }

        const domainRefs = await client
          .schema(WORKER_CAPABILITY_CONTRACT.database.schema)
          .from('worker_job_domain_refs')
          .select('*')
          .limit(1);
        assertPostgrestPermissionDenied(
          domainRefs.error,
          `${label} api worker_job_domain_refs relation`,
        );
      }

      const privateProfile = await fetch(
        `${config.url}/rest/v1/rpc/${WORKER_CAPABILITY_CONTRACT.database.routine.read}`,
        {
          method: 'POST',
          headers: {
            apikey: config.serviceKey,
            'content-type': 'application/json',
            'content-profile': 'private',
          },
          body: JSON.stringify({ p_job_id: firstJob.id, p_include_internal: true }),
        },
      );
      assertEquals(privateProfile.status, 406);
      assertEquals((await privateProfile.json()).code, 'PGRST106');

      for (const [label, client] of [
        ['anon', anonymous],
        ['owner', ownerClient],
      ] as const) {
        const directRelation = await client.from('worker_jobs').select('id').limit(1);
        assertPostgrestPermissionDenied(
          directRelation.error,
          `${label} public worker_jobs relation`,
        );
      }

      await assertNeverAuthenticated(anonymous, 'anonymous probe client after negative probes');

      const handler = createAppWorkerJobsHandler({
        resolveActor: (request) =>
          resolveActorContext(request, {
            createSupabaseClient: (accessToken) =>
              requestClient(config.url, config.publishableKey, accessToken),
          }),
        execute: (request, actor) => executeWorkerJobCommand(request, actor, service),
      });
      const callHandler = (request: Request) => withoutAuthDebugLogs(() => handler(request));

      const anonResponse = await callHandler(
        post(config.url, null, { action: 'read', jobId: firstJob.id }),
      );
      assertEquals(anonResponse.status, 401);

      const serviceApiResponse = await callHandler(
        post(config.url, null, { action: 'read', jobId: firstJob.id }, config.serviceKey),
      );
      assertEquals(serviceApiResponse.status, 401);

      const ownerRead = await callHandler(
        post(config.url, ownerToken, { action: 'read', jobId: firstJob.id }),
      );
      assertEquals(ownerRead.status, 200);
      assertEquals((await ownerRead.json()).data.id, firstJob.id);

      const foreignRead = await callHandler(
        post(config.url, foreignToken, { action: 'read', jobId: firstJob.id }),
      );
      assertEquals(foreignRead.status, 404);

      const foreignCancel = await callHandler(
        post(config.url, foreignToken, { action: 'cancel', jobId: firstJob.id }),
      );
      assertEquals(foreignCancel.status, 404);

      const ownerCancel = await callHandler(
        post(config.url, ownerToken, {
          action: 'cancel',
          jobId: firstJob.id,
          reason: 'local_contract_complete',
        }),
      );
      assertEquals(ownerCancel.status, 200);
      assertEquals((await ownerCancel.json()).data.status, 'cancelled');
      cleanupJobIds.delete(firstJob.id);
    } finally {
      for (const jobId of cleanupJobIds) {
        await worker.cancel({
          jobId,
          cancelledBy: owner?.id ?? null,
          reason: 'hosted_contract_finally_cleanup',
        });
      }
      if (owner) {
        await service.auth.admin.deleteUser(owner.id);
      }
      if (foreign) {
        await service.auth.admin.deleteUser(foreign.id);
      }
      if (admin) {
        await service.auth.admin.deleteUser(admin.id);
      }
    }
  },
});
