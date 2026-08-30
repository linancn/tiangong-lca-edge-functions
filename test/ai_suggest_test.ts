import { assertEquals } from 'jsr:@std/assert';

import { AuthMethod, type AuthResult } from '../supabase/functions/_shared/auth.ts';
import { createAiSuggestHandler } from '../supabase/functions/ai_suggest/handler.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_JOB_ID = '22222222-2222-4222-8222-222222222222';

class FakeRpcSupabase {
  calls: Array<{ fn: string; args: unknown }> = [];

  constructor(
    private readonly reply: (fn: string) => { data: unknown; error: unknown } = () => ({
      data: {
        ok: true,
        data: { id: TEST_JOB_ID, status: 'queued', payload: { secret: true } },
      },
      error: null,
    }),
  ) {}

  rpc(fn: string, args: unknown) {
    this.calls.push({ fn, args: structuredClone(args) });
    return Promise.resolve(this.reply(fn));
  }
}

function request(body: unknown, method = 'POST'): Request {
  return new Request('http://localhost/functions/v1/ai_suggest', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function buildHandler(
  supabase: FakeRpcSupabase,
  authResult: AuthResult = {
    isAuthenticated: true,
    principal: {
      userId: TEST_USER_ID,
      authMethod: 'supabase_jwt',
      assurance: 'claims',
    },
    user: {
      id: TEST_USER_ID,
      app_metadata: {},
      user_metadata: {},
      aud: '',
      created_at: '',
    },
  },
  authMethods?: AuthMethod[][],
) {
  return createAiSuggestHandler({
    authClient: {} as never,
    authenticateRequest: (_req, config) => {
      authMethods?.push(config.allowedMethods);
      return Promise.resolve(authResult);
    },
    getRedisClient: () => Promise.resolve(undefined),
    supabase: supabase as never,
  });
}

Deno.test('ai_suggest requires a user identity and excludes service-key auth', async () => {
  const methods: AuthMethod[][] = [];
  const handler = buildHandler(
    new FakeRpcSupabase(),
    { isAuthenticated: false, response: new Response('Unauthorized', { status: 401 }) },
    methods,
  );

  const response = await handler(request({ action: 'enqueue' }));

  assertEquals(response.status, 401);
  assertEquals(methods, [[AuthMethod.JWT, AuthMethod.USER_API_KEY]]);
});

Deno.test('ai_suggest rejects unsupported methods and invalid actions', async () => {
  const handler = buildHandler(new FakeRpcSupabase());
  const methodResponse = await handler(request(null, 'GET'));
  assertEquals(methodResponse.status, 405);

  const actionResponse = await handler(request({ action: 'wait' }));
  assertEquals(actionResponse.status, 400);
  assertEquals((await responseJson(actionResponse)).code, 'AI_ACTION_INVALID');
});

Deno.test('ai_suggest validates TIDAS type, JSON, and matching root before enqueue', async () => {
  const supabase = new FakeRpcSupabase();
  const handler = buildHandler(supabase);

  const typeResponse = await handler(request({ tidasData: '{}', dataType: 'model' }));
  assertEquals(typeResponse.status, 400);
  assertEquals((await responseJson(typeResponse)).code, 'AI_DATA_TYPE_INVALID');

  const jsonResponse = await handler(request({ tidasData: '{', dataType: 'process' }));
  assertEquals(jsonResponse.status, 400);
  assertEquals((await responseJson(jsonResponse)).code, 'AI_DATA_INVALID');

  const rootResponse = await handler(
    request({ tidasData: '{"flowDataSet":{}}', dataType: 'process' }),
  );
  assertEquals(rootResponse.status, 400);
  assertEquals((await responseJson(rootResponse)).code, 'AI_DATA_INVALID');
  assertEquals(supabase.calls, []);
});

Deno.test('ai_suggest enqueues the versioned AI job without returning its payload', async () => {
  const supabase = new FakeRpcSupabase();
  const handler = buildHandler(supabase);

  const response = await handler(
    request({
      tidasData: JSON.stringify({ processDataSet: { name: 'cement' } }),
      dataType: 'Process',
      options: { maxRetries: 1 },
    }),
  );

  assertEquals(response.status, 202);
  assertEquals(await responseJson(response), {
    ok: true,
    data: {
      jobId: TEST_JOB_ID,
      status: 'queued',
      phase: null,
      progress: 0,
      createdAt: null,
      updatedAt: null,
    },
  });
  assertEquals(supabase.calls, [
    {
      fn: 'svc_ai_tidas_suggestion_enqueue',
      args: {
        p_requested_by: TEST_USER_ID,
        p_data_type: 'process',
        p_data: { processDataSet: { name: 'cement' } },
      },
    },
  ]);
});

Deno.test('ai_suggest reads requester-scoped pending job status', async () => {
  const supabase = new FakeRpcSupabase(() => ({
    data: {
      ok: true,
      data: { id: TEST_JOB_ID, status: 'running', phase: 'model', progress: 35 },
    },
    error: null,
  }));
  const handler = buildHandler(supabase);

  const response = await handler(request({ action: 'read', jobId: TEST_JOB_ID }));

  assertEquals(response.status, 200);
  assertEquals((await responseJson(response)).data, {
    jobId: TEST_JOB_ID,
    status: 'running',
    phase: 'model',
    progress: 35,
    createdAt: null,
    updatedAt: null,
  });
  assertEquals(supabase.calls, [
    {
      fn: 'svc_ai_tidas_suggestion_read',
      args: { p_requested_by: TEST_USER_ID, p_job_id: TEST_JOB_ID },
    },
  ]);
});

Deno.test('ai_suggest returns the complete versioned Worker result', async () => {
  const result = {
    schemaVersion: 'ai.tidas_suggestion.result.v1',
    status: 'complete',
    dataType: 'flow',
    data: { flowDataSet: { name: 'improved' } },
  };
  const supabase = new FakeRpcSupabase(() => ({
    data: {
      ok: true,
      data: {
        id: TEST_JOB_ID,
        status: 'completed',
        resultSchemaVersion: 'ai.tidas_suggestion.result.v1',
        result,
        diagnostics: { private: true },
      },
    },
    error: null,
  }));
  const handler = buildHandler(supabase);

  const response = await handler(request({ action: 'read', jobId: TEST_JOB_ID }));

  assertEquals(response.status, 200);
  const body = await responseJson(response);
  assertEquals((body.data as Record<string, unknown>).result, result);
  assertEquals('diagnostics' in (body.data as Record<string, unknown>), false);
});

Deno.test('ai_suggest preserves stable requester denial and hides transport details', async () => {
  const denied = buildHandler(
    new FakeRpcSupabase(() => ({
      data: { ok: false, code: 'AI_JOB_NOT_FOUND', status: 404, message: 'AI job was not found' },
      error: null,
    })),
  );
  const deniedResponse = await denied(request({ action: 'read', jobId: TEST_JOB_ID }));
  assertEquals(deniedResponse.status, 404);
  assertEquals(await responseJson(deniedResponse), {
    ok: false,
    code: 'AI_JOB_NOT_FOUND',
    message: 'AI job was not found',
  });

  const failed = buildHandler(
    new FakeRpcSupabase(() => ({
      data: null,
      error: { code: 'PGRST500', message: 'private database detail' },
    })),
  );
  const failedResponse = await failed(request({ action: 'read', jobId: TEST_JOB_ID }));
  assertEquals(failedResponse.status, 502);
  assertEquals(await responseJson(failedResponse), {
    ok: false,
    code: 'AI_JOB_READ_FAILED',
    message: 'The AI worker service is temporarily unavailable',
  });
});
