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
      './supabase/functions/_shared/portal_security_event.ts',
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

Deno.test(
  'Portal Hybrid runtime is publishable-only, abortable, HMAC-first, and never falls back to legacy RPCs',
  async () => {
    const files = [
      './supabase/functions/_shared/hybrid_search_kernel.ts',
      './supabase/functions/_shared/openai_structured.ts',
      './supabase/functions/_shared/portal_hmac.ts',
      './supabase/functions/_shared/portal_hybrid_contract.ts',
      './supabase/functions/_shared/portal_hybrid_deadline.ts',
      './supabase/functions/_shared/portal_hybrid_repository.ts',
      './supabase/functions/_shared/portal_hybrid_security_event.ts',
      './supabase/functions/_shared/portal_redis_guard.ts',
      './supabase/functions/portal_hybrid_search_v1/index.ts',
    ];
    const source = (await Promise.all(files.map((file) => Deno.readTextFile(file)))).join('\n');
    for (const forbidden of [
      'createSupabaseServiceClient',
      'supabaseServiceClient',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SECRET_KEY',
      'REMOTE_SERVICE_API_KEY',
      'createHybridSearchRpcClient',
      'hybrid_search_processes',
      'hybrid_search_flows',
      'Access-Control-Allow-Origin',
      'corsHeaders',
    ]) {
      assertEquals(
        source.includes(forbidden),
        false,
        `forbidden Portal Hybrid dependency: ${forbidden}`,
      );
    }
    assertStringIncludes(source, '/rest/v1/rpc/portal_hybrid_search_v1');
    assertStringIncludes(source, "'Content-Profile': 'api'");
    assertStringIncludes(source, 'getSupabasePublishableKey');
    assertStringIncludes(source, 'verifyPortalHmacRequest');
    assertStringIncludes(source, 'isPortalHybridEnabled');
    assertStringIncludes(source, "env.get('PORTAL_HYBRID_ENABLED') === 'true'");
    assertStringIncludes(source, 'abortSignal: signal');
    assertStringIncludes(source, '{ signal: request.signal }');
    assertStringIncludes(source, 'new PortalHybridDeadline(timeoutMs, monotonicNow, startedAt)');
    assertStringIncludes(source, 'await deadline.run');
    assertStringIncludes(source, 'deadline.detach');
    assertStringIncludes(
      source,
      'Task: Transform description of ${config.entityPlural} into three specific queries: SemanticQueryEN, FulltextQueryEN and FulltextQueryZH.',
    );
    assertStringIncludes(source, 'options: { model: OPENAI_CHAT_MODEL, temperature: 0 }');
    assertStringIncludes(source, 'Body: JSON.stringify({ inputs: text })');

    const loginHybridHandler = await Deno.readTextFile(
      './supabase/functions/_shared/hybrid_search_handler.ts',
    );
    assertStringIncludes(loginHybridHandler, 'rewriteQuery: rewriteHybridSearchQuery');
    assertStringIncludes(loginHybridHandler, 'generateEmbedding: generateHybridSearchEmbedding');
    assertStringIncludes(loginHybridHandler, '? jsonResponse({ data }, 200)');
    assertStringIncludes(loginHybridHandler, ': jsonResponse([], 200)');

    const environmentTemplate = await Deno.readTextFile('./supabase/.env.example');
    for (const expected of [
      'PORTAL_HYBRID_ENABLED=false',
      'PORTAL_HYBRID_MINUTE_BUDGET=60',
      'PORTAL_HYBRID_DAILY_BUDGET=5000',
      'PORTAL_HYBRID_MAX_CONCURRENCY=4',
      'PORTAL_HYBRID_LEASE_TTL_SECONDS=30',
      'PORTAL_HYBRID_CACHE_TTL_SECONDS=60',
      'PORTAL_HYBRID_TIMEOUT_MS=8000',
      'PORTAL_HYBRID_CIRCUIT_FAILURE_THRESHOLD=5',
      'PORTAL_HYBRID_CIRCUIT_WINDOW_SECONDS=60',
      'PORTAL_HYBRID_CIRCUIT_OPEN_SECONDS=60',
    ]) {
      assertStringIncludes(environmentTemplate, expected);
    }
  },
);

Deno.test('Portal transport is pinned to reviewed Supabase CLI source evidence', async () => {
  const packageJson = JSON.parse(await Deno.readTextFile('./package.json')) as {
    config: { supabaseCliVersion: string };
    devDependencies: { supabase: string };
  };
  const fixture = JSON.parse(
    await Deno.readTextFile('./test/fixtures/supabase-cli-v2.106.0-functions-transport.json'),
  ) as {
    schemaVersion: string;
    cliVersion: string;
    repository: string;
    ref: string;
    sources: Array<{ path: string; gitBlobSha: string; url: string }>;
    contract: Record<string, unknown>;
  };
  assertEquals(fixture.schemaVersion, 'portal.supabase-cli-transport-source.v1');
  assertEquals(fixture.cliVersion, packageJson.config.supabaseCliVersion);
  assertEquals(fixture.cliVersion, packageJson.devDependencies.supabase);
  assertEquals(fixture.repository, 'supabase/cli');
  assertEquals(fixture.ref, `v${fixture.cliVersion}`);
  assertEquals(fixture.contract, {
    publicPathTemplate: '/functions/v1/<function-name>',
    runtimePathTemplate: '/<function-name>',
    kongStripPath: true,
    trustedApikeyMatchInjectsAuthorization: 'Bearer <legacy-anon-key>',
    serveExportsLegacyAnonAs: 'SUPABASE_ANON_KEY',
    canonicalPathSource: 'publicPathTemplate',
  });
  assertEquals(
    fixture.sources.map(({ path, gitBlobSha }) => ({ path, gitBlobSha })),
    [
      {
        path: 'apps/cli-go/internal/start/templates/kong.yml',
        gitBlobSha: '4cbfc3b1eb388f4427fda35e22a4db022e4bad43',
      },
      {
        path: 'apps/cli-go/internal/start/start.go',
        gitBlobSha: '6ce6a4434dafce83ee4db398f3b16ed04a8dae59',
      },
      {
        path: 'apps/cli-go/internal/functions/serve/templates/main.ts',
        gitBlobSha: 'bac39b39eb3c9c7668570c3265203294b7323d85',
      },
      {
        path: 'apps/cli-go/internal/functions/serve/serve.go',
        gitBlobSha: '38ca9f7e2ebf62827b2a8dd9a0e7cb76382cf5c5',
      },
    ],
  );
  for (const source of fixture.sources) {
    assertEquals(source.url, `https://github.com/supabase/cli/blob/v2.106.0/${source.path}`);
  }

  const runtime = await Deno.readTextFile(
    './supabase/functions/portal_data_product_results_v1/index.ts',
  );
  assertStringIncludes(
    runtime,
    'allowedRequestPaths: [PORTAL_LCIA_FUNCTION_PATH, PORTAL_LCIA_RUNTIME_PATH]',
  );
  assertStringIncludes(runtime, 'readPortalLegacyAnonCredential');

  const hybridRuntime = await Deno.readTextFile(
    './supabase/functions/portal_hybrid_search_v1/index.ts',
  );
  assertStringIncludes(
    hybridRuntime,
    'allowedRequestPaths: [PORTAL_HYBRID_FUNCTION_PATH, PORTAL_HYBRID_RUNTIME_PATH]',
  );
  assertStringIncludes(hybridRuntime, 'readPortalLegacyAnonCredential');
});
