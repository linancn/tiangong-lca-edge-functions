import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';

Deno.test(
  'Portal functions inherit the repository no-gateway-JWT serve and deploy contract',
  async () => {
    const packageJson = JSON.parse(await Deno.readTextFile('./package.json')) as {
      scripts: Record<string, string>;
    };
    const deployScript = await Deno.readTextFile('./scripts/deploy-function.cjs');
    assertStringIncludes(packageJson.scripts.start, '--no-verify-jwt');
    assertStringIncludes(deployScript, "'--no-verify-jwt'");
    assertStringIncludes(deployScript, "'--import-map'");
    assertEquals(packageJson.scripts.start.includes('--verify-jwt'), false);
  },
);

Deno.test(
  'Portal LCIA runtime contains no service-role client or legacy SERVICE_API_KEY path',
  async () => {
    const files = [
      './supabase/functions/_shared/portal_hmac.ts',
      './supabase/functions/_shared/portal_redis_guard.ts',
      './supabase/functions/portal_data_product_results_v1/index.ts',
    ];
    const source = (await Promise.all(files.map((file) => Deno.readTextFile(file)))).join('\n');
    for (const forbidden of [
      'createSupabaseServiceClient',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SECRET_KEY',
      'REMOTE_SERVICE_API_KEY',
    ]) {
      assertEquals(source.includes(forbidden), false, `forbidden Portal dependency: ${forbidden}`);
    }
    assertStringIncludes(source, "'Content-Profile': 'api'");
    assertStringIncludes(source, 'getSupabasePublishableKey');
  },
);
