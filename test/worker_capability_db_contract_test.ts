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
const EXPECTED_DATABASE_MIGRATION_HEAD = '20260731164051';

function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) {
      return value;
    }
  }
  throw new Error(`Missing local contract environment: ${names.join(' or ')}`);
}

function localContractConfig() {
  const url = requireEnv('WORKER_CAPABILITY_SUPABASE_URL', 'SUPABASE_URL');
  const hostname = new URL(url).hostname;
  if (
    hostname !== '127.0.0.1' &&
    hostname !== 'localhost' &&
    hostname !== '::1' &&
    hostname !== '[::1]'
  ) {
    throw new Error('Worker capability DB contract refuses non-loopback Supabase URLs');
  }
  const databaseUrl = requireEnv('WORKER_CAPABILITY_DB_URL');
  const databaseHostname = new URL(databaseUrl).hostname;
  if (
    databaseHostname !== '127.0.0.1' &&
    databaseHostname !== 'localhost' &&
    databaseHostname !== '::1' &&
    databaseHostname !== '[::1]'
  ) {
    throw new Error('Worker capability DB contract refuses non-loopback database URLs');
  }
  return {
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

async function signIn(client: SupabaseClient, email: string, password: string) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token) {
    throw new Error(
      `Unable to sign in local contract user: ${error?.message ?? 'missing session'}`,
    );
  }
  return data.session.access_token;
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
  name: 'worker capability contract enforces auth, ownership, service facade, and idempotency on a real local DB',
  ignore: !CONTRACT_ENABLED,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const config = localContractConfig();
    await assertExactMigrationHead(config.databaseUrl);
    const service = createClient(config.url, config.serviceKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    const anonymous = requestClient(config.url, config.publishableKey);
    let owner: Awaited<ReturnType<typeof createLocalUser>> | undefined;
    let foreign: Awaited<ReturnType<typeof createLocalUser>> | undefined;

    try {
      owner = await createLocalUser(service, 'owner');
      foreign = await createLocalUser(service, 'foreign');
      const ownerToken = await signIn(anonymous, owner.email, owner.password);
      const foreignToken = await signIn(anonymous, foreign.email, foreign.password);
      const ownerClient = requestClient(config.url, config.publishableKey, ownerToken);
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

      const anonymousRpc = await anonymous.rpc(WORKER_CAPABILITY_CONTRACT.rpc.read, {
        p_job_id: firstJob.id,
        p_include_internal: false,
      });
      assert(anonymousRpc.error, 'anon must not call the service-only worker read RPC');

      const authenticatedRpc = await ownerClient.rpc(WORKER_CAPABILITY_CONTRACT.rpc.read, {
        p_job_id: firstJob.id,
        p_include_internal: false,
      });
      assert(
        authenticatedRpc.error,
        'authenticated must not call the service-only worker read RPC',
      );

      for (const [label, client] of [
        ['anon', anonymous],
        ['authenticated', ownerClient],
      ] as const) {
        const concurrencyRpc = await client.rpc(
          WORKER_CAPABILITY_CONTRACT.rpc.listByConcurrencyKey,
          {
            p_job_kind: enqueueRequest.jobKind,
            p_concurrency_key: idempotencyKey,
            p_statuses: ['queued'],
            p_limit: 20,
            p_include_internal: true,
          },
        );
        assert(
          concurrencyRpc.error,
          `${label} must not call the service-only worker concurrency-list RPC`,
        );
      }

      for (const client of [anonymous, ownerClient]) {
        const directRelation = await client.from('worker_jobs').select('id').limit(1);
        assert(directRelation.error, 'worker_jobs must not remain a public Data API relation');
      }

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
    }
  },
});
