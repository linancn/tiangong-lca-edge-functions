import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import {
  executeWorkerJobCommand,
  parseWorkerJobCommand,
} from '../supabase/functions/_shared/commands/worker_jobs.ts';

const TEST_JOB_ID = '66666666-6666-4666-8666-666666666666';
const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';

class FakeWorkerJobSupabase {
  rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];

  constructor(private readonly responses: Array<{ data: unknown; error: unknown }>) {}

  rpc(fn: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ fn, args: structuredClone(args) });
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`Unexpected RPC call: ${fn}`);
    }
    return Promise.resolve(response);
  }
}

function actor(): ActorContext {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: {} as SupabaseClient,
  };
}

Deno.test('parseWorkerJobCommand defaults list action', () => {
  const result = parseWorkerJobCommand({
    subjectType: 'processes',
    subjectId: TEST_DATASET_ID,
  });

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.action, 'list');
  }
});

Deno.test('executeWorkerJobCommand lists only current user worker jobs', async () => {
  const supabase = new FakeWorkerJobSupabase([
    {
      data: {
        ok: true,
        data: [
          {
            id: TEST_JOB_ID,
            status: 'running',
            requestedBy: TEST_USER_ID,
          },
        ],
      },
      error: null,
    },
  ]);

  const result = await executeWorkerJobCommand(
    {
      action: 'list',
      subjectType: 'processes',
      subjectId: TEST_DATASET_ID,
      statuses: ['queued', 'running'],
      limit: 25,
    },
    actor(),
    supabase as unknown as SupabaseClient,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.body, {
      ok: true,
      command: 'worker_jobs_list',
      data: [
        {
          id: TEST_JOB_ID,
          status: 'running',
          requestedBy: TEST_USER_ID,
        },
      ],
    });
  }
  assertEquals(supabase.rpcCalls, [
    {
      fn: 'worker_list_jobs',
      args: {
        p_requested_by: TEST_USER_ID,
        p_subject_type: 'processes',
        p_subject_id: TEST_DATASET_ID,
        p_statuses: ['queued', 'running'],
        p_visibility: 'user',
        p_limit: 25,
        p_include_internal: false,
      },
    },
  ]);
});

Deno.test('executeWorkerJobCommand rejects reading another user job', async () => {
  const supabase = new FakeWorkerJobSupabase([
    {
      data: {
        ok: true,
        data: {
          id: TEST_JOB_ID,
          status: 'running',
          requestedBy: '33333333-3333-4333-8333-333333333333',
        },
      },
      error: null,
    },
  ]);

  const result = await executeWorkerJobCommand(
    {
      action: 'read',
      jobId: TEST_JOB_ID,
    },
    actor(),
    supabase as unknown as SupabaseClient,
  );

  assertEquals(result, {
    ok: false,
    code: 'WORKER_JOB_NOT_FOUND',
    status: 404,
    message: 'Worker job not found',
  });
});

Deno.test('executeWorkerJobCommand cancels owned jobs through service RPC', async () => {
  const supabase = new FakeWorkerJobSupabase([
    {
      data: {
        ok: true,
        data: {
          id: TEST_JOB_ID,
          status: 'running',
          requestedBy: TEST_USER_ID,
        },
      },
      error: null,
    },
    {
      data: {
        ok: true,
        data: {
          id: TEST_JOB_ID,
          status: 'cancelled',
          requestedBy: TEST_USER_ID,
        },
      },
      error: null,
    },
  ]);

  const result = await executeWorkerJobCommand(
    {
      action: 'cancel',
      jobId: TEST_JOB_ID,
      reason: 'user_cancelled',
    },
    actor(),
    supabase as unknown as SupabaseClient,
  );

  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.body, {
      ok: true,
      command: 'worker_jobs_cancel',
      data: {
        id: TEST_JOB_ID,
        status: 'cancelled',
        requestedBy: TEST_USER_ID,
      },
    });
  }
  assertEquals(
    supabase.rpcCalls.map((call) => call.fn),
    ['worker_read_job', 'worker_cancel_job'],
  );
  assertEquals(supabase.rpcCalls[1].args, {
    p_job_id: TEST_JOB_ID,
    p_cancelled_by: TEST_USER_ID,
    p_reason: 'user_cancelled',
  });
});
