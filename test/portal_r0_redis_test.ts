import { assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert';

import type { PortalRedisAdapter } from '../supabase/functions/_shared/redis_client.ts';
import {
  admitPortalR0Request,
  PORTAL_R0_ATOMIC_GUARD_LUA,
  readPortalR0RedisConfig,
  registerPortalR0Nonce,
  releasePortalR0Lease,
  R0_NONCE_TTL_SECONDS,
  type PortalR0RedisConfig,
} from '../supabase/functions/_shared/portal_r0_redis.ts';

function environment(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] };
}

const common = {
  PORTAL_R0_RUNTIME_TARGET: 'test',
  PORTAL_R0_REDIS_NAMESPACE: 'portal:r0:fixture-20260826:v1',
  PORTAL_R0_REDIS_TIMEOUT_MS: '500',
  PORTAL_R0_MINUTE_BUDGET: '4',
  PORTAL_R0_DAILY_BUDGET: '20',
  PORTAL_R0_MAX_CONCURRENCY: '2',
  PORTAL_R0_LEASE_TTL_SECONDS: '20',
};

class FixtureRedis implements PortalRedisAdapter {
  readonly setCalls: Array<{ key: string; value: string; ttl: number }> = [];
  readonly evalCalls: Array<{ script: string; keys: string[]; args: string[] }> = [];
  setResult = true;
  evalResults: unknown[] = [[0, 3, 19, 1, 0], 1];

  constructor(readonly namespace = 'portal:r0:fixture-20260826:v1') {}

  setNxEx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    this.setCalls.push({ key, value, ttl: ttlSeconds });
    return Promise.resolve(this.setResult);
  }

  eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    this.evalCalls.push({ script, keys, args });
    return Promise.resolve(this.evalResults.shift());
  }

  get(): Promise<string | null> {
    throw new Error('R0 must not read cache or business data');
  }

  setEx(): Promise<void> {
    throw new Error('R0 must not write cache or business data');
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function config(overrides: Partial<PortalR0RedisConfig> = {}): PortalR0RedisConfig {
  return {
    target: 'test',
    provider: 'standard',
    namespace: 'portal:r0:fixture-20260826:v1',
    timeoutMs: 500,
    redisUrl: 'redis://127.0.0.1:6379',
    minuteBudget: 4,
    dailyBudget: 20,
    maxConcurrency: 2,
    leaseTtlSeconds: 20,
    ...overrides,
  };
}

Deno.test('R0 Redis reads complete Standard and Upstash fixture configuration only', () => {
  assertEquals(
    readPortalR0RedisConfig(
      environment({
        ...common,
        PORTAL_R0_REDIS_CLIENT_TYPE: 'standard',
        PORTAL_R0_REDIS_URL: 'redis://127.0.0.1:6380',
        PORTAL_R0_REDIS_PASSWORD: 'fixture-password',
        PORTAL_REDIS_CLIENT_TYPE: 'upstash',
        PORTAL_UPSTASH_REDIS_URL: 'https://portal-dev-forbidden.example',
      }),
    ),
    {
      target: 'test',
      provider: 'standard',
      namespace: common.PORTAL_R0_REDIS_NAMESPACE,
      timeoutMs: 500,
      redisUrl: 'redis://127.0.0.1:6380',
      redisPassword: 'fixture-password',
      minuteBudget: 4,
      dailyBudget: 20,
      maxConcurrency: 2,
      leaseTtlSeconds: 20,
    },
  );

  assertEquals(
    readPortalR0RedisConfig(
      environment({
        ...common,
        PORTAL_R0_RUNTIME_TARGET: 'preview',
        PORTAL_R0_REDIS_CLIENT_TYPE: 'upstash',
        PORTAL_R0_UPSTASH_REDIS_URL: 'https://r0-fixture.upstash.example',
        PORTAL_R0_UPSTASH_REDIS_TOKEN: 'fixture-token',
      }),
    ).provider,
    'upstash',
  );
});

Deno.test(
  'R0 Redis fails closed on generic-only, production, shared namespace, and unsafe URLs',
  () => {
    const invalid = [
      {
        ...common,
        PORTAL_REDIS_CLIENT_TYPE: 'standard',
        PORTAL_REDIS_URL: 'redis://127.0.0.1:6379',
      },
      {
        ...common,
        PORTAL_R0_RUNTIME_TARGET: 'production',
        PORTAL_R0_REDIS_CLIENT_TYPE: 'upstash',
        PORTAL_R0_UPSTASH_REDIS_URL: 'https://fixture.example',
        PORTAL_R0_UPSTASH_REDIS_TOKEN: 'token',
      },
      {
        ...common,
        PORTAL_R0_REDIS_NAMESPACE: 'portal:r0:production-fixture:v1',
        PORTAL_R0_REDIS_CLIENT_TYPE: 'standard',
        PORTAL_R0_REDIS_URL: 'redis://127.0.0.1:6379',
      },
      {
        ...common,
        PORTAL_R0_RUNTIME_TARGET: 'preview',
        PORTAL_R0_REDIS_CLIENT_TYPE: 'upstash',
        PORTAL_R0_UPSTASH_REDIS_URL: 'http://remote.example',
        PORTAL_R0_UPSTASH_REDIS_TOKEN: 'token',
      },
      {
        ...common,
        PORTAL_R0_RUNTIME_TARGET: 'preview',
        PORTAL_R0_REDIS_CLIENT_TYPE: 'standard',
        PORTAL_R0_REDIS_URL: 'redis://remote.example:6379',
      },
    ];
    for (const values of invalid) {
      let failed = false;
      try {
        readPortalR0RedisConfig(environment(values));
      } catch (_error) {
        failed = true;
      }
      assertEquals(failed, true);
    }
  },
);

Deno.test('R0 nonce registration is exact SET NX EX 120 under the fixture namespace', async () => {
  const redis = new FixtureRedis();
  const nonce = 'AQIDBAUGBwgJCgsMDQ4PEA';
  assertEquals(await registerPortalR0Nonce({ keyId: 'r0-new', nonce }, redis), true);
  assertEquals(redis.setCalls, [
    {
      key: `${redis.namespace}:replay:r0-new:${nonce}`,
      value: '1',
      ttl: R0_NONCE_TTL_SECONDS,
    },
  ]);
  redis.setResult = false;
  assertEquals(await registerPortalR0Nonce({ keyId: 'r0-new', nonce }, redis), false);
});

Deno.test(
  'R0 admission uses the reviewed atomic Lua primitive and releases its own lease',
  async () => {
    const redis = new FixtureRedis();
    const admission = await admitPortalR0Request(config(), redis, 1_800_000_000_000);
    assertEquals(admission.status, 'admitted');
    assertEquals(redis.evalCalls.length, 1);
    assertEquals(redis.evalCalls[0].script, PORTAL_R0_ATOMIC_GUARD_LUA);
    assertStringIncludes(redis.evalCalls[0].keys[0], ':budget:portal_r0_hmac_verify_v1:minute:');
    assertStringIncludes(redis.evalCalls[0].keys[1], ':budget:portal_r0_hmac_verify_v1:daily:');
    assertEquals(redis.evalCalls[0].keys[2], `${redis.namespace}:lease:portal_r0_hmac_verify_v1`);
    assertEquals(redis.evalCalls[0].args.slice(3, 6), ['4', '20', '2']);

    if (admission.status !== 'admitted') throw new Error('expected admission');
    await releasePortalR0Lease(admission.leaseId, redis);
    assertStringIncludes(redis.evalCalls[1].script, "redis.call('ZREM'");
    assertEquals(redis.evalCalls[1].keys, [`${redis.namespace}:lease:portal_r0_hmac_verify_v1`]);
  },
);

Deno.test('R0 admission preserves atomic budget and concurrency contention results', async () => {
  for (const [result, expected] of [
    [[1, 0, 19, 1, 0], 'budget_exhausted'],
    [[2, 3, 19, 0, 0], 'concurrency_exhausted'],
  ] as const) {
    const redis = new FixtureRedis();
    redis.evalResults = [result];
    assertEquals((await admitPortalR0Request(config(), redis, 10)).status, expected);
  }
});

Deno.test(
  'R0 Redis outage, timeout-shaped rejection, and malformed responses fail closed',
  async () => {
    for (const result of [undefined, null, [0, 1], ['bad', 1, 1, 1, 0], [9, 1, 1, 1, 0]]) {
      const redis = new FixtureRedis();
      redis.evalResults = [result];
      await assertRejects(() => admitPortalR0Request(config(), redis, 10));
    }
    const redis = new FixtureRedis();
    redis.eval = () => Promise.reject(new Error('provider detail must be hidden'));
    await assertRejects(() => admitPortalR0Request(config(), redis, 10));
  },
);

Deno.test('R0 namespace never aliases the retained Portal Dev/Main surface', () => {
  const source = Deno.readTextFileSync('./supabase/functions/_shared/portal_r0_redis.ts');
  for (const forbidden of [
    "env, 'PORTAL_REDIS_",
    "env, 'PORTAL_UPSTASH_",
    "env, 'REDIS_",
    "env, 'UPSTASH_",
  ]) {
    assertEquals(source.includes(forbidden), false);
  }
  assertStringIncludes(source, "'PORTAL_R0_REDIS_CLIENT_TYPE'");
  assertStringIncludes(source, "'PORTAL_R0_REDIS_NAMESPACE'");
});
