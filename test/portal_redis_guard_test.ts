import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from 'jsr:@std/assert';

import {
  DEFAULT_LEASE_TTL_SECONDS,
  minimumPortalLeaseTtlSeconds,
  MINIMUM_LEASE_TTL_SECONDS,
  PORTAL_ATOMIC_GUARD_LUA,
  readPortalLciaGuardLimits,
  readPortalResponseCache,
  redisEvalAtomicGuard,
  registerPortalNonce,
  releasePortalConcurrencyLease,
  REPLAY_TTL_SECONDS,
  validatePortalLciaGuardLimits,
  writePortalResponseCache,
} from '../supabase/functions/_shared/portal_redis_guard.ts';
import {
  type PortalRedisAdapter,
  PortalRedisError,
  readPortalRedisRuntimeConfig,
} from '../supabase/functions/_shared/redis_client.ts';

type StoredValue = { value: string; expiresAt: number };
type SharedRedisState = {
  values: Map<string, StoredValue>;
  counters: Map<string, StoredValue>;
  leases: Map<string, Map<string, number>>;
};

function sharedState(): SharedRedisState {
  return { values: new Map(), counters: new Map(), leases: new Map() };
}

class MemoryPortalRedis implements PortalRedisAdapter {
  nowMillis = 0;
  readonly setNxCalls: Array<{ key: string; ttlSeconds: number }> = [];
  readonly evalCalls: Array<{ script: string; keys: string[]; args: string[] }> = [];

  constructor(
    readonly namespace: string,
    private readonly state: SharedRedisState = sharedState(),
  ) {}

  setNxEx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    this.setNxCalls.push({ key, ttlSeconds });
    const existing = this.state.values.get(key);
    if (existing && existing.expiresAt > this.nowMillis) return Promise.resolve(false);
    this.state.values.set(key, {
      value,
      expiresAt: this.nowMillis + ttlSeconds * 1000,
    });
    return Promise.resolve(true);
  }

  eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    this.evalCalls.push({ script, keys, args });
    if (!script.includes('ZREMRANGEBYSCORE')) {
      const leases = this.state.leases.get(keys[0]);
      return Promise.resolve(leases?.delete(args[0]) ? 1 : 0);
    }

    const now = Number(args[0]);
    const leaseExpires = Number(args[1]);
    const leaseId = args[2];
    const minuteLimit = Number(args[3]);
    const dailyLimit = Number(args[4]);
    const concurrencyLimit = Number(args[5]);
    const minuteTtl = Number(args[6]);
    const dailyTtl = Number(args[7]);
    const cost = Number(args[9]);
    const minute = this.counter(keys[0], now);
    const daily = this.counter(keys[1], now);
    const leases = this.state.leases.get(keys[2]) ?? new Map<string, number>();
    for (const [member, expires] of leases) {
      if (expires <= now) leases.delete(member);
    }
    this.state.leases.set(keys[2], leases);
    if (minute + cost > minuteLimit || daily + cost > dailyLimit) {
      return Promise.resolve([
        1,
        minuteLimit - minute,
        dailyLimit - daily,
        concurrencyLimit - leases.size,
      ]);
    }
    if (leases.size >= concurrencyLimit) {
      return Promise.resolve([2, minuteLimit - minute, dailyLimit - daily, 0]);
    }
    this.state.counters.set(keys[0], {
      value: String(minute + cost),
      expiresAt: now + minuteTtl * 1000,
    });
    this.state.counters.set(keys[1], {
      value: String(daily + cost),
      expiresAt: now + dailyTtl * 1000,
    });
    leases.set(leaseId, leaseExpires);
    return Promise.resolve([
      0,
      minuteLimit - minute - cost,
      dailyLimit - daily - cost,
      concurrencyLimit - leases.size,
    ]);
  }

  private counter(key: string, now: number): number {
    const entry = this.state.counters.get(key);
    if (!entry || entry.expiresAt <= now) return 0;
    return Number(entry.value);
  }

  get(key: string): Promise<string | null> {
    const entry = this.state.values.get(key);
    if (!entry || entry.expiresAt <= this.nowMillis) return Promise.resolve(null);
    return Promise.resolve(entry.value);
  }

  setEx(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.state.values.set(key, {
      value,
      expiresAt: this.nowMillis + ttlSeconds * 1000,
    });
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const LIMITS = {
  minuteBudget: 10,
  dailyBudget: 100,
  maxConcurrency: 2,
  leaseTtlSeconds: DEFAULT_LEASE_TTL_SECONDS,
  cacheTtlSeconds: 300,
};

function environment(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] };
}

Deno.test('Portal Redis config requires an explicit isolated namespace and provider', () => {
  assertEquals(
    readPortalRedisRuntimeConfig(
      environment({
        REDIS_CLIENT_TYPE: 'upstash',
        UPSTASH_REDIS_URL: 'https://example.upstash.io',
        UPSTASH_REDIS_TOKEN: 'test-token',
        PORTAL_REDIS_NAMESPACE: 'portal:main:v1',
        PORTAL_REDIS_TIMEOUT_MS: '500',
      }),
    ),
    {
      provider: 'upstash',
      namespace: 'portal:main:v1',
      timeoutMs: 500,
      upstashUrl: 'https://example.upstash.io',
      upstashToken: 'test-token',
    },
  );
  assertEquals(
    readPortalRedisRuntimeConfig(
      environment({
        REDIS_CLIENT_TYPE: 'standard',
        REDIS_URL: 'redis://127.0.0.1:6379',
        REDIS_PASSWORD: 'local-password',
        PORTAL_REDIS_NAMESPACE: 'portal:test:v1',
      }),
    ),
    {
      provider: 'standard',
      namespace: 'portal:test:v1',
      timeoutMs: 500,
      redisUrl: 'redis://127.0.0.1:6379',
      redisPassword: 'local-password',
    },
  );
  for (const values of [
    {},
    {
      REDIS_CLIENT_TYPE: 'upstash',
      UPSTASH_REDIS_URL: 'http://insecure.example',
      UPSTASH_REDIS_TOKEN: 'token',
      PORTAL_REDIS_NAMESPACE: 'portal:main:v1',
    },
    {
      REDIS_CLIENT_TYPE: 'standard',
      REDIS_URL: 'redis://127.0.0.1:6379',
      PORTAL_REDIS_NAMESPACE: 'shared',
    },
  ]) {
    let code: string | undefined;
    try {
      readPortalRedisRuntimeConfig(environment(values));
    } catch (error) {
      code = (error as PortalRedisError).code;
    }
    assertEquals(code, 'guard_unavailable');
  }
});

Deno.test('Portal nonce registration is atomic with at least a 120 second TTL', async () => {
  const redis = new MemoryPortalRedis('portal:test:v1');
  const nonce = 'AAAAAAAAAAAAAAAAAAAAAA';
  assertEquals(await registerPortalNonce({ keyId: 'test-key', nonce }, redis), true);
  assertEquals(await registerPortalNonce({ keyId: 'test-key', nonce }, redis), false);
  assertEquals(redis.setNxCalls[0].ttlSeconds, REPLAY_TTL_SECONDS);
  assert(REPLAY_TTL_SECONDS >= 120);
  redis.nowMillis = REPLAY_TTL_SECONDS * 1000 + 1;
  assertEquals(await registerPortalNonce({ keyId: 'test-key', nonce }, redis), true);
});

Deno.test('Preview and production namespaces cannot observe each other replay keys', async () => {
  const state = sharedState();
  const preview = new MemoryPortalRedis('portal:preview:v1', state);
  const production = new MemoryPortalRedis('portal:production:v1', state);
  const request = { keyId: 'portal-key', nonce: 'BBBBBBBBBBBBBBBBBBBBBB' };
  assertEquals(await registerPortalNonce(request, preview), true);
  assertEquals(await registerPortalNonce(request, preview), false);
  assertEquals(await registerPortalNonce(request, production), true);
});

Deno.test('Portal route guard atomically enforces budget without read-then-write', async () => {
  const redis = new MemoryPortalRedis('portal:test:v1');
  const limits = { ...LIMITS, minuteBudget: 1, maxConcurrency: 5 };
  const first = await redisEvalAtomicGuard(
    { route: 'portal_data_product_results_v1', limits, nowMillis: 1000 },
    redis,
  );
  assertEquals(first.status, 'admitted');
  if (first.status === 'admitted') {
    await releasePortalConcurrencyLease(
      { route: 'portal_data_product_results_v1', leaseId: first.leaseId },
      redis,
    );
  }
  const second = await redisEvalAtomicGuard(
    { route: 'portal_data_product_results_v1', limits, nowMillis: 1001 },
    redis,
  );
  assertEquals(second.status, 'budget_exhausted');
  assertEquals(redis.evalCalls[0].script, PORTAL_ATOMIC_GUARD_LUA);
  assertStringIncludes(PORTAL_ATOMIC_GUARD_LUA, "redis.call('INCRBY'");
  assertStringIncludes(PORTAL_ATOMIC_GUARD_LUA, "redis.call('ZADD'");
});

Deno.test('Portal route guard admits only one concurrent caller at limit one', async () => {
  const redis = new MemoryPortalRedis('portal:test:v1');
  const limits = { ...LIMITS, maxConcurrency: 1 };
  const results = await Promise.all([
    redisEvalAtomicGuard(
      { route: 'portal_data_product_results_v1', limits, nowMillis: 2000 },
      redis,
    ),
    redisEvalAtomicGuard(
      { route: 'portal_data_product_results_v1', limits, nowMillis: 2000 },
      redis,
    ),
  ]);
  assertEquals(results.map((result) => result.status).sort(), [
    'admitted',
    'concurrency_exhausted',
  ]);
});

Deno.test('Portal concurrency lease recovers after TTL without explicit release', async () => {
  const redis = new MemoryPortalRedis('portal:test:v1');
  const limits = {
    ...LIMITS,
    maxConcurrency: 1,
    leaseTtlSeconds: MINIMUM_LEASE_TTL_SECONDS,
  };
  const first = await redisEvalAtomicGuard(
    { route: 'portal_data_product_results_v1', limits, nowMillis: 0 },
    redis,
  );
  assertEquals(first.status, 'admitted');
  const blocked = await redisEvalAtomicGuard(
    {
      route: 'portal_data_product_results_v1',
      limits,
      nowMillis: MINIMUM_LEASE_TTL_SECONDS * 1000 - 1,
    },
    redis,
  );
  assertEquals(blocked.status, 'concurrency_exhausted');
  const recovered = await redisEvalAtomicGuard(
    {
      route: 'portal_data_product_results_v1',
      limits,
      nowMillis: MINIMUM_LEASE_TTL_SECONDS * 1000,
    },
    redis,
  );
  assertEquals(recovered.status, 'admitted');
});

Deno.test('Portal cache keys are hash-only, namespaced, and TTL bounded', async () => {
  const redis = new MemoryPortalRedis('portal:test:v1');
  const bodyHash = 'C'.repeat(43);
  await writePortalResponseCache(
    {
      route: 'portal_data_product_results_v1',
      bodyHash,
      value: '{"safe":true}',
      ttlSeconds: 300,
    },
    redis,
  );
  assertEquals(
    await readPortalResponseCache({ route: 'portal_data_product_results_v1', bodyHash }, redis),
    '{"safe":true}',
  );
  redis.nowMillis = 300_001;
  assertEquals(
    await readPortalResponseCache({ route: 'portal_data_product_results_v1', bodyHash }, redis),
    null,
  );
});

Deno.test('Portal guard propagates Redis outage only as guard_unavailable', async () => {
  const unavailable: PortalRedisAdapter = {
    namespace: 'portal:test:v1',
    setNxEx: () => Promise.reject(new Error('contains provider details')),
    eval: () => Promise.reject(new Error('contains provider details')),
    get: () => Promise.reject(new Error('contains provider details')),
    setEx: () => Promise.reject(new Error('contains provider details')),
    close: () => Promise.resolve(),
  };
  const error = await assertRejects(() =>
    registerPortalNonce({ keyId: 'key', nonce: 'DDDDDDDDDDDDDDDDDDDDDD' }, unavailable),
  );
  assertEquals((error as PortalRedisError).code, 'guard_unavailable');
  assertEquals((error as Error).message, 'guard_unavailable');
});

Deno.test(
  'Portal LCIA guard limits have bounded defaults and fail closed on malformed values',
  () => {
    assertEquals(readPortalLciaGuardLimits(environment({})), {
      minuteBudget: 120,
      dailyBudget: 20_000,
      maxConcurrency: 20,
      leaseTtlSeconds: DEFAULT_LEASE_TTL_SECONDS,
      cacheTtlSeconds: 300,
    });
    let code: string | undefined;
    try {
      readPortalLciaGuardLimits(environment({ PORTAL_LCIA_MAX_CONCURRENCY: '0' }));
    } catch (error) {
      code = (error as PortalRedisError).code;
    }
    assertEquals(code, 'guard_unavailable');

    for (const leaseTtlSeconds of [19, 20, 30]) {
      const values = {
        PORTAL_LCIA_LEASE_TTL_SECONDS: String(leaseTtlSeconds),
        PORTAL_REDIS_TIMEOUT_MS: '5000',
        PORTAL_LCIA_UPSTREAM_TIMEOUT_MS: '8000',
      };
      if (leaseTtlSeconds === 19) {
        assertThrows(() => readPortalLciaGuardLimits(environment(values)));
      } else {
        assertEquals(
          readPortalLciaGuardLimits(environment(values)).leaseTtlSeconds,
          leaseTtlSeconds,
        );
      }
    }
  },
);

Deno.test(
  'Portal lease covers Redis plus upstream timeout with five-second recovery margin',
  () => {
    const timing = { redisTimeoutMs: 5000, upstreamTimeoutMs: 8000 };
    assertEquals(minimumPortalLeaseTtlSeconds(timing), 20);
    assertThrows(() => validatePortalLciaGuardLimits({ ...LIMITS, leaseTtlSeconds: 19 }, timing));
    assertEquals(
      validatePortalLciaGuardLimits({ ...LIMITS, leaseTtlSeconds: 20 }, timing).leaseTtlSeconds,
      20,
    );

    const longerTiming = { redisTimeoutMs: 15_000, upstreamTimeoutMs: 10_000 };
    assertEquals(minimumPortalLeaseTtlSeconds(longerTiming), 30);
    assertThrows(() =>
      validatePortalLciaGuardLimits({ ...LIMITS, leaseTtlSeconds: 29 }, longerTiming),
    );
    assertEquals(
      validatePortalLciaGuardLimits({ ...LIMITS, leaseTtlSeconds: 30 }, longerTiming)
        .leaseTtlSeconds,
      30,
    );
  },
);
