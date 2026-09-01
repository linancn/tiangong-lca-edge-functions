import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';

Deno.test('generic Edge auth Redis is absent while Portal keeps its isolated names', async () => {
  const source = await Deno.readTextFile(
    new URL('../supabase/functions/_shared/redis_client.ts', import.meta.url),
  );
  assertEquals(source.includes('getRedisClient'), false);
  assertEquals(source.includes('UPSTASH_REDIS_REST_URL'), false);
  assertEquals(source.includes('UPSTASH_REDIS_REST_TOKEN'), false);
  assertStringIncludes(source, 'createPortalRedisAdapter');
  assertStringIncludes(source, 'PORTAL_UPSTASH_REDIS_URL');
  assertStringIncludes(source, 'PORTAL_UPSTASH_REDIS_TOKEN');

  const environmentTemplate = await Deno.readTextFile(
    new URL('../supabase/.env.example', import.meta.url),
  );
  assertEquals(/^UPSTASH_REDIS_REST_URL=/mu.test(environmentTemplate), false);
  assertEquals(/^UPSTASH_REDIS_REST_TOKEN=/mu.test(environmentTemplate), false);
  assertEquals(/^UPSTASH_REDIS_URL=/mu.test(environmentTemplate), false);
  assertEquals(/^UPSTASH_REDIS_TOKEN=/mu.test(environmentTemplate), false);
  assertStringIncludes(environmentTemplate, 'PORTAL_UPSTASH_REDIS_URL=');
  assertStringIncludes(environmentTemplate, 'PORTAL_UPSTASH_REDIS_TOKEN=');
});
