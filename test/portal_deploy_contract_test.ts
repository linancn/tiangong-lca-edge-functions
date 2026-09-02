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
  'Portal Hybrid operator contract expands lease and timeout only after deploy',
  async () => {
    const readme = await Deno.readTextFile('./README.md');
    for (const [deployCommand, leaseCommand, timeoutCommand] of [
      [
        'pnpm deploy:dev portal_hybrid_search_v1',
        `pnpm exec supabase secrets set PORTAL_HYBRID_LEASE_TTL_SECONDS=35 \\
  --project-ref submidrhbtknjxfympna`,
        `pnpm exec supabase secrets set PORTAL_HYBRID_TIMEOUT_MS=25000 \\
  --project-ref submidrhbtknjxfympna`,
      ],
      [
        'pnpm deploy:main portal_hybrid_search_v1',
        `pnpm exec supabase secrets set PORTAL_HYBRID_LEASE_TTL_SECONDS=35 \\
  --project-ref qgzvkongdjqiiamzbbts`,
        `pnpm exec supabase secrets set PORTAL_HYBRID_TIMEOUT_MS=25000 \\
  --project-ref qgzvkongdjqiiamzbbts`,
      ],
    ] as const) {
      const deployIndex = readme.indexOf(deployCommand);
      const leaseIndex = readme.indexOf(leaseCommand);
      const timeoutIndex = readme.indexOf(timeoutCommand);
      assertEquals(deployIndex >= 0, true);
      assertEquals(leaseIndex > deployIndex, true);
      assertEquals(timeoutIndex > leaseIndex, true);
    }
    assertStringIncludes(
      readme,
      'Do not set `25000` while the target still runs code capped at `6000`',
    );
    assertStringIncludes(
      readme,
      'Set `PORTAL_HYBRID_DEPLOYMENT_SHA` to the exact eligible deployed merge only after the corresponding deploy and both configuration updates succeed.',
    );
  },
);

Deno.test(
  'Portal LCIA runtime contains no service-role client or legacy SERVICE_API_KEY path',
  async () => {
    const files = [
      './supabase/functions/_shared/portal_hmac.ts',
      './supabase/functions/_shared/portal_public_transport.ts',
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
    assertStringIncludes(source, 'readPortalPublishableCredential');
    assertStringIncludes(source, 'PORTAL_SUPABASE_PUBLISHABLE_KEY');
    assertStringIncludes(source, 'SUPABASE_PUBLISHABLE_KEYS');
    assertStringIncludes(source, "readPortalDeploymentSha('PORTAL_LCIA_DEPLOYMENT_SHA')");
    for (const forbidden of [
      "'REMOTE_SUPABASE_PUBLISHABLE_KEY'",
      "'REMOTE_SUPABASE_ANON_KEY'",
      "'REMOTE_SUPABASE_URL'",
      "Deno.env.get('PORTAL_DEPLOYMENT_SHA')",
      "from './supabase_client.ts'",
      "from '../_shared/supabase_client.ts'",
      'getSupabasePublishableKey(',
      'getSupabaseUrl(',
    ]) {
      assertEquals(source.includes(forbidden), false, `forbidden Portal fallback: ${forbidden}`);
    }
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
      './supabase/functions/_shared/portal_hybrid_kernel.ts',
      './supabase/functions/_shared/portal_hybrid_provider.ts',
      './supabase/functions/_shared/portal_hybrid_repository.ts',
      './supabase/functions/_shared/portal_hybrid_security_event.ts',
      './supabase/functions/_shared/portal_redis_guard.ts',
      './supabase/functions/_shared/portal_openai_structured.ts',
      './supabase/functions/portal_hybrid_search_v1/index.ts',
    ];
    const source = (await Promise.all(files.map((file) => Deno.readTextFile(file)))).join('\n');
    const handlerSource = await Deno.readTextFile(
      './supabase/functions/portal_hybrid_search_v1/index.ts',
    );
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
    assertStringIncludes(source, '/rest/v1/rpc/portal_hybrid_search_v2');
    assertStringIncludes(source, "'Content-Profile': 'api'");
    assertStringIncludes(source, 'readPortalPublishableCredential');
    assertStringIncludes(source, 'verifyPortalHmacRequest');
    assertStringIncludes(source, 'isPortalHybridEnabled');
    assertStringIncludes(source, "env.get('PORTAL_HYBRID_ENABLED') === 'true'");
    assertStringIncludes(source, 'abortSignal: signal');
    assertStringIncludes(source, '{ signal: request.signal }');
    assertStringIncludes(source, 'new PortalHybridDeadline(timeoutMs, monotonicNow, startedAt)');
    assertStringIncludes(handlerSource, 'redisEvalAtomicHybridBegin');
    for (const supersededCall of [
      'registerPortalNonce(',
      'redisEvalAtomicGuard(',
      'checkPortalHybridCircuit(',
    ]) {
      assertEquals(handlerSource.includes(supersededCall), false, supersededCall);
    }
    assertStringIncludes(source, 'const PORTAL_HYBRID_TOTAL_TIMEOUT_MS = 25_000;');
    assertStringIncludes(source, 'await deadline.run');
    assertStringIncludes(source, 'deadline.detach');
    assertStringIncludes(
      source,
      'Task: Transform description of ${config.entityPlural} into three specific queries: SemanticQueryEN, FulltextQueryEN and FulltextQueryZH.',
    );
    assertStringIncludes(source, 'provider.openAi');
    assertStringIncludes(source, 'Body: JSON.stringify({ inputs: text })');
    assertStringIncludes(source, "readPortalDeploymentSha('PORTAL_HYBRID_DEPLOYMENT_SHA')");

    const portalOnlyFiles = [
      './supabase/functions/_shared/portal_hybrid_kernel.ts',
      './supabase/functions/_shared/portal_hybrid_provider.ts',
      './supabase/functions/_shared/portal_hybrid_repository.ts',
      './supabase/functions/_shared/portal_openai_structured.ts',
      './supabase/functions/_shared/portal_public_transport.ts',
      './supabase/functions/portal_hybrid_search_v1/index.ts',
    ];
    const portalOnlySource = (
      await Promise.all(portalOnlyFiles.map((file) => Deno.readTextFile(file)))
    ).join('\n');
    for (const forbidden of [
      "'REMOTE_SUPABASE_PUBLISHABLE_KEY'",
      "'REMOTE_SUPABASE_ANON_KEY'",
      "'REMOTE_SUPABASE_URL'",
      "'OPENAI_API_KEY'",
      "'OPENAI_CHAT_MODEL'",
      "'OPENAI_BASE_URL'",
      "'SAGEMAKER_ENDPOINT_NAME'",
      "'AWS_ACCESS_KEY_ID'",
      "'AWS_SECRET_ACCESS_KEY'",
      "'AWS_SESSION_TOKEN'",
      "Deno.env.get('PORTAL_DEPLOYMENT_SHA')",
      "from './supabase_client.ts'",
      "from '../_shared/supabase_client.ts'",
      "from './hybrid_search_kernel.ts'",
      "from '../_shared/hybrid_search_kernel.ts'",
      "from './openai_structured.ts'",
      "from '../_shared/openai_structured.ts'",
      'getSupabasePublishableKey(',
      'getSupabaseUrl(',
      'rewriteHybridSearchQuery(',
      'generateHybridSearchEmbedding(',
    ]) {
      assertEquals(
        portalOnlySource.includes(forbidden),
        false,
        `forbidden Portal Hybrid fallback: ${forbidden}`,
      );
    }
    for (const required of [
      "'PORTAL_OPENAI_API_KEY'",
      "'PORTAL_OPENAI_CHAT_MODEL'",
      "'PORTAL_OPENAI_BASE_URL'",
      "'PORTAL_SAGEMAKER_ENDPOINT_NAME'",
      "'PORTAL_AWS_ACCESS_KEY_ID'",
      "'PORTAL_AWS_SECRET_ACCESS_KEY'",
      "'PORTAL_AWS_SESSION_TOKEN'",
    ]) {
      assertStringIncludes(portalOnlySource, required);
    }

    const loginHybridHandler = await Deno.readTextFile(
      './supabase/functions/_shared/hybrid_search_handler.ts',
    );
    const genericHybridKernel = await Deno.readTextFile(
      './supabase/functions/_shared/hybrid_search_kernel.ts',
    );
    assertStringIncludes(
      genericHybridKernel,
      "const OPENAI_CHAT_MODEL = Deno.env.get('OPENAI_CHAT_MODEL') ?? 'gpt-4.1-mini';",
    );
    assertStringIncludes(
      genericHybridKernel,
      "const SAGEMAKER_ENDPOINT_NAME = Deno.env.get('SAGEMAKER_ENDPOINT_NAME');",
    );
    assertStringIncludes(
      genericHybridKernel,
      'options: { model: OPENAI_CHAT_MODEL, temperature: 0 }',
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
      'PORTAL_HYBRID_LEASE_TTL_SECONDS=35',
      'PORTAL_HYBRID_CACHE_TTL_SECONDS=60',
      'PORTAL_HYBRID_TIMEOUT_MS=25000',
      'PORTAL_HYBRID_CIRCUIT_FAILURE_THRESHOLD=5',
      'PORTAL_HYBRID_CIRCUIT_WINDOW_SECONDS=60',
      'PORTAL_HYBRID_CIRCUIT_OPEN_SECONDS=60',
      'PORTAL_SUPABASE_PUBLISHABLE_KEY=',
      'PORTAL_OPENAI_API_KEY=',
      'PORTAL_OPENAI_CHAT_MODEL=',
      'PORTAL_OPENAI_BASE_URL=',
      'PORTAL_SAGEMAKER_ENDPOINT_NAME=',
      'PORTAL_AWS_ACCESS_KEY_ID=',
      'PORTAL_AWS_SECRET_ACCESS_KEY=',
      'PORTAL_AWS_SESSION_TOKEN=',
      'PORTAL_LCIA_DEPLOYMENT_SHA=',
      'PORTAL_HYBRID_DEPLOYMENT_SHA=',
    ]) {
      assertStringIncludes(environmentTemplate, expected);
    }
    for (const retainedGeneric of [
      'OPENAI_API_KEY=',
      'OPENAI_CHAT_MODEL=gpt-4.1-mini',
      'OPENAI_BASE_URL=',
      'SAGEMAKER_ENDPOINT_NAME=',
      'AWS_ACCESS_KEY_ID=',
      'AWS_SECRET_ACCESS_KEY=',
      'AWS_SESSION_TOKEN=',
    ]) {
      assertStringIncludes(environmentTemplate, retainedGeneric);
    }
    assertEquals(environmentTemplate.includes('\nPORTAL_DEPLOYMENT_SHA='), false);
  },
);

Deno.test('Portal transport is pinned to reviewed Supabase CLI source evidence', async () => {
  const packageJson = JSON.parse(await Deno.readTextFile('./package.json')) as {
    config: { supabaseCliVersion: string };
    devDependencies: { supabase: string };
  };
  const fixture = JSON.parse(
    await Deno.readTextFile('./test/fixtures/supabase-cli-v2.116.0-functions-transport.json'),
  ) as {
    schemaVersion: string;
    cliVersion: string;
    repository: string;
    ref: string;
    sources: Array<{ path: string; gitBlobSha: string; url: string }>;
    contract: Record<string, unknown>;
  };
  assertEquals(fixture.schemaVersion, 'portal.supabase-cli-transport-source.v2');
  assertEquals(fixture.cliVersion, packageJson.config.supabaseCliVersion);
  assertEquals(fixture.cliVersion, packageJson.devDependencies.supabase);
  assertEquals(fixture.repository, 'supabase/cli');
  assertEquals(fixture.ref, `v${fixture.cliVersion}`);
  assertEquals(fixture.contract, {
    publicPathTemplate: '/functions/v1/<function-name>',
    runtimePathTemplate: '/<function-name>',
    kongStripPath: true,
    trustedApikeyMatchInjectsWorkerHeader: 'sb-api-key: Bearer <legacy-anon-key>',
    functionsGatewayInjectsAuthorization: false,
    serveExportsLegacyAnonAs: 'SUPABASE_ANON_KEY',
    serveExportsSupabaseUrlAs: 'http://kong:8000',
    workerExportsPublishableRegistryAs: 'SUPABASE_PUBLISHABLE_KEYS.default',
    canonicalPathSource: 'publicPathTemplate',
  });
  assertEquals(
    fixture.sources.map(({ path, gitBlobSha }) => ({ path, gitBlobSha })),
    [
      {
        path: 'apps/cli/src/legacy/commands/start/templates/kong.yml.ts',
        gitBlobSha: '60912939332c117c41ecf9ebdf67d1e7fb2707db',
      },
      {
        path: 'apps/cli/src/legacy/commands/start/services/kong.service.ts',
        gitBlobSha: 'd0e38c603814ec3c4cd5c0914ed5c95a187e5e2f',
      },
      {
        path: 'apps/cli/src/shared/functions/serve.ts',
        gitBlobSha: 'a763e2ae78828f8803825dcc2d4dcb9ea5d86671',
      },
      {
        path: 'apps/cli/src/shared/functions/serve.main.ts',
        gitBlobSha: '2cf89e2e719feaeaf0a8f93f77fb10619c94f59e',
      },
    ],
  );
  for (const source of fixture.sources) {
    assertEquals(source.url, `https://github.com/supabase/cli/blob/v2.116.0/${source.path}`);
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
