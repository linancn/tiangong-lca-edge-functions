// Setup type definitions for built-in Supabase Runtime APIs
import '@supabase/functions-js/edge-runtime.d.ts';

import { authenticateRequest, AuthMethod } from '../_shared/auth.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { getRedisClient } from '../_shared/redis_client.ts';
import { supabaseClient } from '../_shared/supabase_client.ts';

type SolveRequest = {
  scope?: string;
  snapshot_id?: string;
  demand?: {
    process_index?: number;
    amount?: number;
  };
  solve?: {
    return_x?: boolean;
    return_g?: boolean;
    return_h?: boolean;
  };
  print_level?: number;
};

type SolveResponse = {
  mode: 'queued' | 'in_progress' | 'cache_hit';
  snapshot_id: string;
  cache_key: string;
  job_id?: string;
  result_id?: string;
};

type ReadySnapshotMeta = {
  snapshot_id: string;
  process_count: number;
};

type ResultCacheRow = {
  id: string;
  status: string;
  job_id: string | null;
  result_id: string | null;
  hit_count: number;
};

const QUEUE_NAME = 'lca_jobs';
const REQUEST_VERSION = 'lca_solve_v1';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const redis = await getRedisClient();

  const authResult = await authenticateRequest(req, {
    supabase: supabaseClient,
    redis,
    allowedMethods: [AuthMethod.JWT, AuthMethod.USER_API_KEY],
  });

  if (!authResult.isAuthenticated) {
    return authResult.response!;
  }

  const userId = authResult.user?.id;
  if (!userId) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body: SolveRequest;
  try {
    body = (await req.json()) as SolveRequest;
  } catch (_error) {
    return json({ error: 'invalid_json' }, 400);
  }

  const scope = (body.scope ?? 'prod').trim() || 'prod';
  const demandIndex = body.demand?.process_index;
  const demandAmount = body.demand?.amount ?? 1.0;
  const printLevel = body.print_level ?? 0.0;

  const solve = {
    return_x: body.solve?.return_x ?? true,
    return_g: body.solve?.return_g ?? true,
    return_h: body.solve?.return_h ?? true,
  };

  if (!Number.isInteger(demandIndex) || (demandIndex as number) < 0) {
    return json({ error: 'invalid_process_index' }, 400);
  }
  if (!Number.isFinite(demandAmount)) {
    return json({ error: 'invalid_amount' }, 400);
  }
  if (!Number.isFinite(printLevel)) {
    return json({ error: 'invalid_print_level' }, 400);
  }

  const processIndex = Number(demandIndex);

  const snapshotMeta = await resolveReadySnapshot(scope, body.snapshot_id);
  if (!snapshotMeta.ok) {
    return json({ error: snapshotMeta.error }, snapshotMeta.status);
  }

  const { snapshot_id: snapshotId, process_count: processCount } = snapshotMeta.data;

  if (processIndex >= processCount) {
    return json(
      {
        error: 'process_index_out_of_range',
        process_index: processIndex,
        process_count: processCount,
      },
      400,
    );
  }

  const rhs = buildRhs(processCount, processIndex, demandAmount);

  const normalizedRequest = {
    version: REQUEST_VERSION,
    scope,
    snapshot_id: snapshotId,
    demand: {
      process_index: processIndex,
      amount: demandAmount,
    },
    solve,
    print_level: printLevel,
  };

  const requestKey = await sha256Hex(JSON.stringify(normalizedRequest));
  const idempotencyHeader = req.headers.get('x-idempotency-key')?.trim();
  const idempotencyKey = idempotencyHeader
    ? `${userId}:${idempotencyHeader}`
    : `${userId}:${requestKey}`;

  const nowIso = new Date().toISOString();

  const existingCache = await fetchResultCache(scope, snapshotId, requestKey);
  if (!existingCache.ok) {
    return json({ error: 'cache_lookup_failed' }, 500);
  }

  if (existingCache.row) {
    await touchResultCache(existingCache.row, {
      updated_at: nowIso,
      last_accessed_at: nowIso,
      hit_count: existingCache.row.hit_count + 1,
    });

    if (existingCache.row.status === 'ready' && existingCache.row.result_id) {
      const cacheHit: SolveResponse = {
        mode: 'cache_hit',
        snapshot_id: snapshotId,
        cache_key: requestKey,
        result_id: existingCache.row.result_id,
      };
      return json(cacheHit, 200);
    }

    if (
      (existingCache.row.status === 'pending' || existingCache.row.status === 'running') &&
      existingCache.row.job_id
    ) {
      const inProgress: SolveResponse = {
        mode: 'in_progress',
        snapshot_id: snapshotId,
        cache_key: requestKey,
        job_id: existingCache.row.job_id,
      };
      return json(inProgress, 200);
    }
  }

  const newJobId = crypto.randomUUID();
  const payload = {
    type: 'solve_one',
    job_id: newJobId,
    snapshot_id: snapshotId,
    rhs,
    solve,
    print_level: printLevel,
  };

  const { error: insertJobError } = await supabaseClient.from('lca_jobs').insert({
    id: newJobId,
    job_type: 'solve_one',
    snapshot_id: snapshotId,
    status: 'queued',
    payload,
    diagnostics: {},
    requested_by: userId,
    request_key: requestKey,
    idempotency_key: idempotencyKey,
    created_at: nowIso,
    updated_at: nowIso,
  });

  if (insertJobError && !isDuplicateKey(insertJobError.code)) {
    console.error('insert lca_jobs failed', {
      error: insertJobError.message,
      code: insertJobError.code,
      idempotency_key: idempotencyKey,
    });
    return json({ error: 'job_insert_failed' }, 500);
  }

  const { data: jobRow, error: jobReadError } = await supabaseClient
    .from('lca_jobs')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (jobReadError || !jobRow?.id) {
    console.error('read lca_jobs by idempotency_key failed', {
      error: jobReadError?.message,
      code: jobReadError?.code,
      idempotency_key: idempotencyKey,
    });
    return json({ error: 'job_lookup_failed' }, 500);
  }

  const finalJobId = String(jobRow.id);

  if (finalJobId === newJobId) {
    const { error: enqueueError } = await supabaseClient.rpc('lca_enqueue_job', {
      p_queue_name: QUEUE_NAME,
      p_message: payload,
    });

    if (enqueueError) {
      console.error('enqueue queue message failed', {
        error: enqueueError.message,
        code: enqueueError.code,
        details: enqueueError.details,
        hint: enqueueError.hint,
      });

      // `lca_enqueue_job` RPC may be missing if DB migration is not applied.
      if (enqueueError.code === 'PGRST202' || enqueueError.message.includes('lca_enqueue_job')) {
        return json({ error: 'queue_rpc_missing' }, 500);
      }

      return json({ error: 'queue_enqueue_failed' }, 500);
    }
  }

  if (existingCache.row) {
    const { error: cacheUpdateError } = await supabaseClient
      .from('lca_result_cache')
      .update({
        status: 'pending',
        job_id: finalJobId,
        request_payload: normalizedRequest,
        hit_count: existingCache.row.hit_count + 1,
        last_accessed_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', existingCache.row.id);

    if (cacheUpdateError) {
      console.error('update lca_result_cache failed', {
        error: cacheUpdateError.message,
        code: cacheUpdateError.code,
      });
      return json({ error: 'cache_update_failed' }, 500);
    }
  } else {
    const { error: cacheInsertError } = await supabaseClient.from('lca_result_cache').insert({
      scope,
      snapshot_id: snapshotId,
      request_key: requestKey,
      request_payload: normalizedRequest,
      status: 'pending',
      job_id: finalJobId,
      hit_count: 1,
      last_accessed_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso,
    });

    if (cacheInsertError && !isDuplicateKey(cacheInsertError.code)) {
      console.error('insert lca_result_cache failed', {
        error: cacheInsertError.message,
        code: cacheInsertError.code,
      });
      return json({ error: 'cache_insert_failed' }, 500);
    }
  }

  const queued: SolveResponse = {
    mode: 'queued',
    snapshot_id: snapshotId,
    cache_key: requestKey,
    job_id: finalJobId,
  };

  return json(queued, 202);
});

async function fetchResultCache(
  scope: string,
  snapshotId: string,
  requestKey: string,
): Promise<{ ok: true; row: ResultCacheRow | null } | { ok: false }> {
  const { data, error } = await supabaseClient
    .from('lca_result_cache')
    .select('id,status,job_id,result_id,hit_count')
    .eq('scope', scope)
    .eq('snapshot_id', snapshotId)
    .eq('request_key', requestKey)
    .maybeSingle();

  if (error) {
    console.error('fetch lca_result_cache failed', {
      error: error.message,
      code: error.code,
    });
    return { ok: false };
  }

  if (!data) {
    return { ok: true, row: null };
  }

  return {
    ok: true,
    row: {
      id: String(data.id),
      status: String(data.status),
      job_id: data.job_id ? String(data.job_id) : null,
      result_id: data.result_id ? String(data.result_id) : null,
      hit_count: Number(data.hit_count ?? 0),
    },
  };
}

async function touchResultCache(
  row: ResultCacheRow,
  patch: {
    updated_at: string;
    last_accessed_at: string;
    hit_count: number;
  },
): Promise<void> {
  const { error } = await supabaseClient
    .from('lca_result_cache')
    .update({
      updated_at: patch.updated_at,
      last_accessed_at: patch.last_accessed_at,
      hit_count: patch.hit_count,
    })
    .eq('id', row.id);

  if (error) {
    console.warn('touch lca_result_cache failed', {
      error: error.message,
      code: error.code,
      row_id: row.id,
    });
  }
}

async function resolveReadySnapshot(
  scope: string,
  requestedSnapshotId?: string,
): Promise<{ ok: true; data: ReadySnapshotMeta } | { ok: false; error: string; status: number }> {
  const explicit = requestedSnapshotId?.trim();

  if (explicit) {
    const ready = await fetchReadySnapshotMeta(explicit);
    if (!ready) {
      return { ok: false, error: 'snapshot_not_ready', status: 404 };
    }
    return { ok: true, data: ready };
  }

  const { data: activeRow, error: activeErr } = await supabaseClient
    .from('lca_active_snapshots')
    .select('snapshot_id')
    .eq('scope', scope)
    .maybeSingle();

  if (activeErr) {
    console.warn('read lca_active_snapshots failed', { error: activeErr.message, scope });
  }

  if (activeRow?.snapshot_id) {
    const activeReady = await fetchReadySnapshotMeta(String(activeRow.snapshot_id));
    if (activeReady) {
      return { ok: true, data: activeReady };
    }
  }

  const { data: latestRows, error: latestErr } = await supabaseClient
    .from('lca_snapshot_artifacts')
    .select('snapshot_id,process_count,status,created_at')
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(1);

  if (latestErr) {
    console.error('read latest ready snapshot failed', { error: latestErr.message });
    return { ok: false, error: 'snapshot_lookup_failed', status: 500 };
  }

  if (!latestRows || latestRows.length === 0) {
    return { ok: false, error: 'no_ready_snapshot', status: 404 };
  }

  const latest = latestRows[0];
  return {
    ok: true,
    data: {
      snapshot_id: String(latest.snapshot_id),
      process_count: Number(latest.process_count),
    },
  };
}

async function fetchReadySnapshotMeta(snapshotId: string): Promise<ReadySnapshotMeta | null> {
  const { data, error } = await supabaseClient
    .from('lca_snapshot_artifacts')
    .select('snapshot_id,process_count,status,created_at')
    .eq('snapshot_id', snapshotId)
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('fetch snapshot meta failed', { error: error.message, snapshot_id: snapshotId });
    return null;
  }

  if (!data || data.length === 0) {
    return null;
  }

  const row = data[0];
  return {
    snapshot_id: String(row.snapshot_id),
    process_count: Number(row.process_count),
  };
}

function buildRhs(processCount: number, processIndex: number, amount: number): number[] {
  const rhs = new Array<number>(processCount).fill(0);
  rhs[processIndex] = amount;
  return rhs;
}

function isDuplicateKey(code: string | undefined): boolean {
  return code === '23505';
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}
