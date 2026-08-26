import {
  createPortalRedisAdapter,
  type PortalRedisAdapter,
  type PortalRedisEnvironment,
  PortalRedisError,
  readPortalRedisTimeoutMs,
} from './redis_client.ts';

const REPLAY_TTL_SECONDS = 120;
const MINUTE_COUNTER_TTL_SECONDS = 120;
const DAILY_COUNTER_TTL_SECONDS = 172_800;
const ROUTE_PATTERN = /^[a-z0-9][a-z0-9_]{0,63}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const BODY_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MINIMUM_LEASE_TTL_SECONDS = 20;
const DEFAULT_LEASE_TTL_SECONDS = 30;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 8_000;
const PORTAL_LCIA_RESPONSE_CACHE_TTL_SECONDS = 60;

export const PORTAL_ATOMIC_GUARD_LUA = `
local now_ms = tonumber(ARGV[1])
local lease_expires_ms = tonumber(ARGV[2])
local lease_id = ARGV[3]
local minute_limit = tonumber(ARGV[4])
local daily_limit = tonumber(ARGV[5])
local concurrency_limit = tonumber(ARGV[6])
local minute_ttl = tonumber(ARGV[7])
local daily_ttl = tonumber(ARGV[8])
local lease_set_ttl = tonumber(ARGV[9])
local cost = tonumber(ARGV[10])

local recovered_lease_count = tonumber(redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now_ms))
local concurrency = tonumber(redis.call('ZCARD', KEYS[3]))
local minute_current = tonumber(redis.call('GET', KEYS[1]) or '0')
local daily_current = tonumber(redis.call('GET', KEYS[2]) or '0')

if minute_current + cost > minute_limit or daily_current + cost > daily_limit then
  return {1, minute_limit - minute_current, daily_limit - daily_current, concurrency_limit - concurrency, recovered_lease_count}
end
if concurrency >= concurrency_limit then
  return {2, minute_limit - minute_current, daily_limit - daily_current, 0, recovered_lease_count}
end

local minute_after = tonumber(redis.call('INCRBY', KEYS[1], cost))
if minute_after == cost then redis.call('EXPIRE', KEYS[1], minute_ttl) end
local daily_after = tonumber(redis.call('INCRBY', KEYS[2], cost))
if daily_after == cost then redis.call('EXPIRE', KEYS[2], daily_ttl) end
redis.call('ZADD', KEYS[3], lease_expires_ms, lease_id)
redis.call('EXPIRE', KEYS[3], lease_set_ttl)

return {0, minute_limit - minute_after, daily_limit - daily_after, concurrency_limit - concurrency - 1, recovered_lease_count}
`;

const PORTAL_RELEASE_LEASE_LUA = `
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

export type PortalRouteGuardLimits = {
  minuteBudget: number;
  dailyBudget: number;
  maxConcurrency: number;
  leaseTtlSeconds: number;
  cacheTtlSeconds: number;
};

export type PortalGuardTiming = {
  redisTimeoutMs: number;
  upstreamTimeoutMs: number;
};

export type PortalGuardAdmission =
  | {
      status: 'admitted';
      leaseId: string;
      remainingMinute: number;
      remainingDaily: number;
      remainingConcurrency: number;
      recoveredLeaseCount: number;
    }
  | {
      status: 'budget_exhausted' | 'concurrency_exhausted';
      remainingMinute: number;
      remainingDaily: number;
      remainingConcurrency: number;
      recoveredLeaseCount: number;
    };

function environmentValue(env: PortalRedisEnvironment, name: string): string | undefined {
  const value = env.get(name)?.trim();
  return value ? value : undefined;
}

function boundedEnvironmentInteger(
  env: PortalRedisEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = environmentValue(env, name);
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new PortalRedisError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new PortalRedisError();
  }
  return parsed;
}

export function readPortalLciaGuardLimits(
  env: PortalRedisEnvironment = Deno.env,
  timing: Partial<PortalGuardTiming> = {},
): PortalRouteGuardLimits {
  const resolvedTiming = {
    redisTimeoutMs: timing.redisTimeoutMs ?? readPortalRedisTimeoutMs(env),
    upstreamTimeoutMs:
      timing.upstreamTimeoutMs ??
      boundedEnvironmentInteger(
        env,
        'PORTAL_LCIA_UPSTREAM_TIMEOUT_MS',
        DEFAULT_UPSTREAM_TIMEOUT_MS,
        100,
        DEFAULT_UPSTREAM_TIMEOUT_MS,
      ),
  };
  return validatePortalLciaGuardLimits(
    {
      minuteBudget: boundedEnvironmentInteger(env, 'PORTAL_LCIA_MINUTE_BUDGET', 120, 1, 1_000_000),
      dailyBudget: boundedEnvironmentInteger(
        env,
        'PORTAL_LCIA_DAILY_BUDGET',
        20_000,
        1,
        100_000_000,
      ),
      maxConcurrency: boundedEnvironmentInteger(env, 'PORTAL_LCIA_MAX_CONCURRENCY', 20, 1, 10_000),
      leaseTtlSeconds: boundedEnvironmentInteger(
        env,
        'PORTAL_LCIA_LEASE_TTL_SECONDS',
        DEFAULT_LEASE_TTL_SECONDS,
        MINIMUM_LEASE_TTL_SECONDS,
        300,
      ),
      cacheTtlSeconds: boundedEnvironmentInteger(
        env,
        'PORTAL_LCIA_CACHE_TTL_SECONDS',
        PORTAL_LCIA_RESPONSE_CACHE_TTL_SECONDS,
        1,
        PORTAL_LCIA_RESPONSE_CACHE_TTL_SECONDS,
      ),
    },
    resolvedTiming,
  );
}

export function minimumPortalLeaseTtlSeconds(timing: PortalGuardTiming): number {
  if (
    !Number.isSafeInteger(timing.redisTimeoutMs) ||
    timing.redisTimeoutMs < 0 ||
    !Number.isSafeInteger(timing.upstreamTimeoutMs) ||
    timing.upstreamTimeoutMs < 0
  ) {
    throw new PortalRedisError();
  }
  return Math.max(
    MINIMUM_LEASE_TTL_SECONDS,
    Math.ceil((timing.redisTimeoutMs + timing.upstreamTimeoutMs) / 1000) + 5,
  );
}

export function validatePortalLciaGuardLimits(
  limits: PortalRouteGuardLimits,
  timing: PortalGuardTiming,
): PortalRouteGuardLimits {
  const integerWithin = (value: number, minimum: number, maximum: number) =>
    Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  if (
    !integerWithin(limits.minuteBudget, 1, 1_000_000) ||
    !integerWithin(limits.dailyBudget, 1, 100_000_000) ||
    !integerWithin(limits.maxConcurrency, 1, 10_000) ||
    !integerWithin(limits.leaseTtlSeconds, MINIMUM_LEASE_TTL_SECONDS, 300) ||
    !integerWithin(limits.cacheTtlSeconds, 1, PORTAL_LCIA_RESPONSE_CACHE_TTL_SECONDS) ||
    limits.leaseTtlSeconds < minimumPortalLeaseTtlSeconds(timing)
  ) {
    throw new PortalRedisError();
  }
  return limits;
}

async function usePortalRedisAdapter<T>(
  adapter: PortalRedisAdapter | undefined,
  operation: (resolved: PortalRedisAdapter) => Promise<T>,
): Promise<T> {
  const resolved = adapter ?? (await createPortalRedisAdapter());
  try {
    return await operation(resolved);
  } catch (_error) {
    throw new PortalRedisError();
  } finally {
    if (!adapter) await resolved.close().catch(() => undefined);
  }
}

export async function redisSetNxEx(
  key: string,
  value: string,
  ttlSeconds: number,
  adapter?: PortalRedisAdapter,
): Promise<boolean> {
  return await usePortalRedisAdapter(adapter, (resolved) =>
    resolved.setNxEx(key, value, ttlSeconds),
  );
}

function finiteInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function randomLeaseId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export async function redisEvalAtomicGuard(
  input: {
    route: string;
    limits: PortalRouteGuardLimits;
    nowMillis?: number;
    cost?: number;
  },
  adapter?: PortalRedisAdapter,
): Promise<PortalGuardAdmission> {
  if (!ROUTE_PATTERN.test(input.route)) throw new PortalRedisError();
  const nowMillis = input.nowMillis ?? Date.now();
  const cost = input.cost ?? 1;
  if (
    !Number.isSafeInteger(nowMillis) ||
    nowMillis < 0 ||
    !Number.isSafeInteger(cost) ||
    cost < 1
  ) {
    throw new PortalRedisError();
  }
  const leaseId = randomLeaseId();
  const leaseExpiresMillis = nowMillis + input.limits.leaseTtlSeconds * 1000;
  const minuteWindow = Math.floor(nowMillis / 60_000);
  const dailyWindow = Math.floor(nowMillis / 86_400_000);

  return await usePortalRedisAdapter(adapter, async (resolved) => {
    const prefix = resolved.namespace;
    const result = await resolved.eval(
      PORTAL_ATOMIC_GUARD_LUA,
      [
        `${prefix}:budget:${input.route}:minute:${minuteWindow}`,
        `${prefix}:budget:${input.route}:daily:${dailyWindow}`,
        `${prefix}:lease:${input.route}`,
      ],
      [
        String(nowMillis),
        String(leaseExpiresMillis),
        leaseId,
        String(input.limits.minuteBudget),
        String(input.limits.dailyBudget),
        String(input.limits.maxConcurrency),
        String(MINUTE_COUNTER_TTL_SECONDS),
        String(DAILY_COUNTER_TTL_SECONDS),
        String(input.limits.leaseTtlSeconds + 1),
        String(cost),
      ],
    );
    if (!Array.isArray(result) || result.length !== 5) throw new PortalRedisError();
    const values = result.map(finiteInteger);
    if (values.some((value) => value === null)) throw new PortalRedisError();
    const [code, remainingMinute, remainingDaily, remainingConcurrency, recoveredLeaseCount] =
      values as number[];
    if (recoveredLeaseCount < 0) throw new PortalRedisError();
    const common = {
      remainingMinute: Math.max(0, remainingMinute),
      remainingDaily: Math.max(0, remainingDaily),
      remainingConcurrency: Math.max(0, remainingConcurrency),
      recoveredLeaseCount,
    };
    if (code === 0) return { status: 'admitted', leaseId, ...common };
    if (code === 1) return { status: 'budget_exhausted', ...common };
    if (code === 2) return { status: 'concurrency_exhausted', ...common };
    throw new PortalRedisError();
  });
}

export async function registerPortalNonce(
  input: { keyId: string; nonce: string },
  adapter?: PortalRedisAdapter,
): Promise<boolean> {
  if (!KEY_ID_PATTERN.test(input.keyId) || !NONCE_PATTERN.test(input.nonce)) {
    throw new PortalRedisError();
  }
  return await usePortalRedisAdapter(adapter, (resolved) =>
    redisSetNxEx(
      `${resolved.namespace}:replay:${input.keyId}:${input.nonce}`,
      '1',
      REPLAY_TTL_SECONDS,
      resolved,
    ),
  );
}

export async function releasePortalConcurrencyLease(
  input: { route: string; leaseId: string },
  adapter?: PortalRedisAdapter,
): Promise<void> {
  if (!ROUTE_PATTERN.test(input.route) || !NONCE_PATTERN.test(input.leaseId)) return;
  await usePortalRedisAdapter(adapter, async (resolved) => {
    const result = await resolved.eval(
      PORTAL_RELEASE_LEASE_LUA,
      [`${resolved.namespace}:lease:${input.route}`],
      [input.leaseId],
    );
    if (finiteInteger(result) === null) throw new PortalRedisError();
  });
}

function portalCacheKey(adapter: PortalRedisAdapter, route: string, bodyHash: string): string {
  if (!ROUTE_PATTERN.test(route) || !BODY_HASH_PATTERN.test(bodyHash)) {
    throw new PortalRedisError();
  }
  return `${adapter.namespace}:cache:${route}:${bodyHash}`;
}

export async function readPortalResponseCache(
  input: { route: string; bodyHash: string },
  adapter?: PortalRedisAdapter,
): Promise<string | null> {
  return await usePortalRedisAdapter(adapter, (resolved) =>
    resolved.get(portalCacheKey(resolved, input.route, input.bodyHash)),
  );
}

export async function writePortalResponseCache(
  input: { route: string; bodyHash: string; value: string; ttlSeconds: number },
  adapter?: PortalRedisAdapter,
): Promise<void> {
  await usePortalRedisAdapter(adapter, (resolved) =>
    resolved.setEx(
      portalCacheKey(resolved, input.route, input.bodyHash),
      input.value,
      input.ttlSeconds,
    ),
  );
}

export {
  DEFAULT_LEASE_TTL_SECONDS,
  MINIMUM_LEASE_TTL_SECONDS,
  PORTAL_LCIA_RESPONSE_CACHE_TTL_SECONDS,
  REPLAY_TTL_SECONDS,
};
