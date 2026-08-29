import { assertEquals } from 'jsr:@std/assert';

import {
  createPortalRedisAdapter,
  readPortalRedisRuntimeConfig,
} from '../supabase/functions/_shared/redis_client.ts';
import {
  readPortalResponseCache,
  redisEvalAtomicGuard,
  registerPortalNonce,
  releasePortalConcurrencyLease,
  writePortalResponseCache,
} from '../supabase/functions/_shared/portal_redis_guard.ts';

const LIVE_FIXTURE_ENABLED = Deno.env.get('PORTAL_UPSTASH_LIVE_FIXTURE') === '1';
const FIXTURE_RUN_ID = Deno.env.get('PORTAL_UPSTASH_LIVE_FIXTURE_RUN_ID') ?? '';
const CLEANUP_ONLY = Deno.args.includes('--cleanup-only');
const FIXTURE_NOW_MILLIS = Date.parse('2026-08-27T00:00:00.000Z');
const FIXTURE_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CLEANUP_LUA = `
for _, key in ipairs(KEYS) do redis.call('DEL', key) end
return #KEYS
`;

function fixtureNamespace(runId: string): string {
  const uuidHex = runId.replaceAll('-', '');
  const runToken = BigInt(`0x${uuidHex}`).toString(36).padStart(25, '0');
  return `portal:t${runToken}:v1`;
}

Deno.test({
  name: 'real Upstash proves Portal replay, atomic admission, lease release, cache, and cleanup',
  ignore: !LIVE_FIXTURE_ENABLED,
  fn: async () => {
    if (!FIXTURE_RUN_ID_PATTERN.test(FIXTURE_RUN_ID)) {
      throw new Error('live fixture requires a canonical lowercase UUIDv4 run ID');
    }
    const config = readPortalRedisRuntimeConfig();
    const expectedNamespace = fixtureNamespace(FIXTURE_RUN_ID);
    if (config.provider !== 'upstash' || config.namespace !== expectedNamespace) {
      throw new Error('live fixture requires an isolated test namespace');
    }

    const nowMillis = FIXTURE_NOW_MILLIS;
    const adapter = await createPortalRedisAdapter(config);
    const keyId = 'live-fixture';
    const nonce = 'AQIDBAUGBwgJCgsMDQ4PEA';
    const route = 'fixture';
    const bodyHash = 'A'.repeat(43);
    const minuteWindow = Math.floor(nowMillis / 60_000);
    const dailyWindow = Math.floor(nowMillis / 86_400_000);
    const keys = [
      `${config.namespace}:replay:${keyId}:${nonce}`,
      `${config.namespace}:budget:${route}:minute:${minuteWindow}`,
      `${config.namespace}:budget:${route}:daily:${dailyWindow}`,
      `${config.namespace}:lease:${route}`,
      `${config.namespace}:cache:${route}:${bodyHash}`,
    ];

    const deleteFixtureKeys = async () => {
      await adapter.eval(CLEANUP_LUA, keys, []);
      for (const key of keys) assertEquals(await adapter.get(key), null);
    };

    try {
      if (!CLEANUP_ONLY) {
        await deleteFixtureKeys();
        assertEquals(await registerPortalNonce({ keyId, nonce }, adapter), true);
        assertEquals(await registerPortalNonce({ keyId, nonce }, adapter), false);

        const limits = {
          minuteBudget: 2,
          dailyBudget: 2,
          maxConcurrency: 1,
          leaseTtlSeconds: 20,
          cacheTtlSeconds: 5,
        };
        const first = await redisEvalAtomicGuard({ route, limits, nowMillis }, adapter);
        assertEquals(first.status, 'admitted');
        if (first.status !== 'admitted') throw new Error('first admission failed');

        const blocked = await redisEvalAtomicGuard({ route, limits, nowMillis }, adapter);
        assertEquals(blocked.status, 'concurrency_exhausted');
        await releasePortalConcurrencyLease({ route, leaseId: first.leaseId }, adapter);

        const second = await redisEvalAtomicGuard({ route, limits, nowMillis }, adapter);
        assertEquals(second.status, 'admitted');
        if (second.status !== 'admitted') throw new Error('second admission failed');
        await releasePortalConcurrencyLease({ route, leaseId: second.leaseId }, adapter);

        const exhausted = await redisEvalAtomicGuard({ route, limits, nowMillis }, adapter);
        assertEquals(exhausted.status, 'budget_exhausted');

        await writePortalResponseCache(
          { route, bodyHash, value: 'fixture', ttlSeconds: 5 },
          adapter,
        );
        assertEquals(await readPortalResponseCache({ route, bodyHash }, adapter), 'fixture');
      }
    } finally {
      try {
        await deleteFixtureKeys();
      } finally {
        await adapter.close();
      }
    }
  },
});
