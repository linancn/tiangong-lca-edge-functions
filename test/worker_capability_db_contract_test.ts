import { assert, assertEquals } from 'jsr:@std/assert';
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';
import postgres from 'postgres';

import {
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
    assertEquals(
      requireEnv('WORKER_CAPABILITY_EXPECTED_DATABASE_COMMIT'),
      EXPECTED_DATABASE_COMMIT,
    );
    assertEquals(
      requireEnv('WORKER_CAPABILITY_EXPECTED_MIGRATION_HEAD'),
      EXPECTED_DATABASE_MIGRATION_HEAD,
    );
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
    const service = createClient(config.url, config.serviceKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
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
      const worker = createServiceWorkerCapabilityRepository(service);
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

      for (const [label, client] of [
        ['anon', anonymous],
        ['foreign', foreignClient],
        ['owner', ownerClient],
        ['admin', adminClient],
      ] as const) {
        const readRpc = await client
          .schema(WORKER_CAPABILITY_CONTRACT.database.schema)
          .rpc(WORKER_CAPABILITY_CONTRACT.database.routine.read, {
            p_job_id: firstJob.id,
            p_include_internal: false,
          });
        assertPostgrestPermissionDenied(readRpc.error, `${label} service-only api Worker read RPC`);

        const concurrencyRpc = await client
          .schema(WORKER_CAPABILITY_CONTRACT.database.schema)
          .rpc(WORKER_CAPABILITY_CONTRACT.database.routine.listByConcurrencyKey, {
            p_job_kind: enqueueRequest.jobKind,
            p_concurrency_key: idempotencyKey,
            p_statuses: ['queued'],
            p_limit: 20,
            p_include_internal: true,
          });
        assertPostgrestPermissionDenied(
          concurrencyRpc.error,
          `${label} service-only api Worker concurrency-list RPC`,
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
    } finally {
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
