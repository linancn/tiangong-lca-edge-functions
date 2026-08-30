import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';

Deno.test(
  'generic Edge Redis uses the shared Edge/MCP REST names without touching Portal names',
  async () => {
    const source = await Deno.readTextFile(
      new URL('../supabase/functions/_shared/redis_client.ts', import.meta.url),
    );
    const start = source.indexOf('function getUpstashClient()');
    const end = source.indexOf('async function getStandardClient()', start);
    const genericUpstashFactory = source.slice(start, end);

    assertEquals(start >= 0 && end > start, true);
    assertStringIncludes(genericUpstashFactory, 'UPSTASH_REDIS_REST_URL');
    assertStringIncludes(genericUpstashFactory, 'UPSTASH_REDIS_REST_TOKEN');
    assertEquals(genericUpstashFactory.includes('UPSTASH_REDIS_URL'), false);
    assertEquals(genericUpstashFactory.includes('UPSTASH_REDIS_TOKEN'), false);
    assertEquals(genericUpstashFactory.includes('PORTAL_'), false);

    const environmentTemplate = await Deno.readTextFile(
      new URL('../supabase/.env.example', import.meta.url),
    );
    assertStringIncludes(environmentTemplate, 'UPSTASH_REDIS_REST_URL=');
    assertStringIncludes(environmentTemplate, 'UPSTASH_REDIS_REST_TOKEN=');
    assertEquals(/^UPSTASH_REDIS_URL=/mu.test(environmentTemplate), false);
    assertEquals(/^UPSTASH_REDIS_TOKEN=/mu.test(environmentTemplate), false);
  },
);
