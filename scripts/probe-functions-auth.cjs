#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const functionsRoot = path.join(repoRoot, 'supabase', 'functions');

const DISABLED_FUNCTIONS = new Set([
  'embedding',
  'webhook_flow_embedding',
  'webhook_model_embedding',
  'webhook_process_embedding',
]);
const LOCAL_ONLY_FUNCTIONS = new Set(['embedding_ft_local']);
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CONCURRENCY = 4;
const SUMMARY_ORDER = [
  'ok',
  'reachable_but_payload_invalid',
  'reachable_other_client_error',
  'legacy_removed',
  'auth_required',
  'gateway_invalid_jwt',
  'function_auth_failed',
  'not_deployed',
  'server_error',
  'network_error',
  'skipped_missing_credential',
];

async function main() {
  loadDefaultEnvFiles();

  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const baseUrl = resolveBaseUrl(options);
  if (!options.dryRun && !baseUrl) {
    console.error(
      'Missing base URL. Provide --base-url, --remote, --local, or set EDGE_BASE_URL / REMOTE_ENDPOINT / LOCAL_ENDPOINT.',
    );
    process.exitCode = 1;
    return;
  }

  const credentials = resolveCredentials();
  const inventory = buildInventory({
    includeDisabled: options.includeDisabled,
    includeLocalOnly: options.includeLocalOnly,
    onlyPatterns: options.onlyPatterns,
  });

  if (inventory.length === 0) {
    console.error('No matching functions found for probing.');
    process.exitCode = 1;
    return;
  }

  console.log(`Base URL: ${baseUrl ?? '(dry-run only)'}`);
  console.log(
    `Credentials: USER_JWT=${formatCredentialPresence(
      credentials.userJwt,
    )} USER_API_KEY=${formatCredentialPresence(
      credentials.userApiKey,
    )} SERVICE_API_KEY=${formatCredentialPresence(credentials.serviceApiKey)}`,
  );
  console.log(
    `Functions: selected=${inventory.selected.length} total=${inventory.totalCount} default-filtered=${inventory.defaultFilteredCount} pattern-filtered=${inventory.patternFilteredCount}`,
  );
  console.log('');

  if (options.dryRun) {
    printDryRunPlan(inventory.selected, credentials);
    return;
  }

  const results = await runWithConcurrency(
    inventory.selected,
    options.concurrency,
    async (definition) =>
      probeFunction(definition, {
        baseUrl,
        timeoutMs: options.timeoutMs,
        credentials,
      }),
  );

  printResults(results);

  if (options.jsonOut) {
    const outputPath = path.resolve(repoRoot, options.jsonOut);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          baseUrl,
          generatedAt: new Date().toISOString(),
          credentials: {
            hasUserJwt: Boolean(credentials.userJwt),
            hasUserApiKey: Boolean(credentials.userApiKey),
            hasServiceApiKey: Boolean(credentials.serviceApiKey),
          },
          results,
        },
        null,
        2,
      ),
    );
    console.log('');
    console.log(`JSON report written to ${outputPath}`);
  }
}

function parseArgs(argv) {
  const options = {
    baseUrl: undefined,
    remote: false,
    local: false,
    dryRun: false,
    includeDisabled: false,
    includeLocalOnly: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    concurrency: DEFAULT_CONCURRENCY,
    onlyPatterns: [],
    jsonOut: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--include-disabled') {
      options.includeDisabled = true;
    } else if (argument === '--include-local-only') {
      options.includeLocalOnly = true;
    } else if (argument === '--remote') {
      options.remote = true;
    } else if (argument === '--local') {
      options.local = true;
    } else if (argument === '--base-url') {
      index += 1;
      options.baseUrl = argv[index];
    } else if (argument === '--timeout-ms') {
      index += 1;
      options.timeoutMs = parsePositiveInt(argv[index], '--timeout-ms');
    } else if (argument === '--concurrency') {
      index += 1;
      options.concurrency = parsePositiveInt(argv[index], '--concurrency');
    } else if (argument === '--only') {
      index += 1;
      options.onlyPatterns = splitPatterns(argv[index]);
    } else if (argument === '--json-out') {
      index += 1;
      options.jsonOut = argv[index];
    } else {
      console.error(`Unknown argument: ${argument}`);
      options.help = true;
      process.exitCode = 1;
      return options;
    }
  }

  return options;
}

function parsePositiveInt(rawValue, flagName) {
  const parsed = Number.parseInt(rawValue ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} expects a positive integer, got: ${rawValue}`);
  }
  return parsed;
}

function splitPatterns(rawValue) {
  return String(rawValue ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function printHelp() {
  console.log(`Usage: npm run probe:auth -- [options]

Options:
  --remote                  Use REMOTE_ENDPOINT as the base URL.
  --local                   Use LOCAL_ENDPOINT as the base URL.
  --base-url <url>          Override the probe base URL.
  --dry-run                 Print the planned probe matrix without sending requests.
  --include-disabled        Include repo-marked disabled routes (antchain_*, legacy non-*_ft embedding/webhook).
  --include-local-only      Include local-only helper routes such as embedding_ft_local.
  --only <a,b>              Only probe function names containing one of the comma-separated fragments.
  --timeout-ms <ms>         Per-request timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS}.
  --concurrency <n>         Parallel probes. Default: ${DEFAULT_CONCURRENCY}.
  --json-out <path>         Write a JSON report relative to the repo root.
  --help                    Show this help text.

Environment variables:
  EDGE_BASE_URL             Full functions base URL. Example: https://<project>.supabase.co/functions/v1
  REMOTE_ENDPOINT           Existing repo env alias for a remote functions base URL.
  LOCAL_ENDPOINT            Existing repo env alias for a local functions base URL.
  USER_JWT                  Browser/user JWT used for JWT-protected functions.
  USER_API_KEY              Optional user API key for functions that support it.
  REMOTE_SERVICE_API_KEY    Optional service key for SERVICE_API_KEY routes.
  SERVICE_API_KEY           Fallback service key env name.

Classification hints:
  gateway_invalid_jwt       The request was likely rejected before your function ran.
  function_auth_failed      The request reached function runtime, but the function-side auth path rejected it.
  reachable_but_payload_invalid
                            Auth/connectivity is probably fine; the minimal probe body is not enough for business validation.
`);
}

function loadDefaultEnvFiles() {
  loadEnvFile(path.join(repoRoot, '.env'));
  loadEnvFile(path.join(repoRoot, 'supabase', '.env.local'));
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalizedLine = line.startsWith('export ') ? line.slice(7).trim() : line;
    const equalsIndex = normalizedLine.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalizedLine.slice(0, equalsIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = normalizedLine.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function resolveBaseUrl(options) {
  const rawValue =
    options.baseUrl ??
    (options.remote ? process.env.REMOTE_ENDPOINT : undefined) ??
    (options.local ? process.env.LOCAL_ENDPOINT : undefined) ??
    process.env.EDGE_BASE_URL ??
    process.env.BASE_URL ??
    process.env.REMOTE_ENDPOINT ??
    process.env.LOCAL_ENDPOINT;

  if (!rawValue) {
    return undefined;
  }

  const trimmed = rawValue.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (!parsed.pathname || parsed.pathname === '/') {
      return `${trimmed}/functions/v1`;
    }
  } catch (_error) {
    return trimmed;
  }

  return trimmed;
}

function resolveCredentials() {
  return {
    userJwt: readEnv('USER_JWT'),
    userApiKey: readEnv('USER_API_KEY'),
    serviceApiKey: readEnv('REMOTE_SERVICE_API_KEY') ?? readEnv('SERVICE_API_KEY'),
  };
}

function readEnv(name) {
  const value = process.env[name];
  if (!value) {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function buildInventory({ includeDisabled, includeLocalOnly, onlyPatterns }) {
  const entries = fs
    .readdirSync(functionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
    .map((entry) => buildFunctionDefinition(entry.name));

  const afterDefaultFilters = entries.filter((entry) => {
    if (!includeDisabled && entry.defaultSkipped === 'disabled') {
      return false;
    }
    if (!includeLocalOnly && entry.defaultSkipped === 'local_only') {
      return false;
    }
    return true;
  });

  const selected = afterDefaultFilters.filter((entry) => {
    if (onlyPatterns.length > 0 && !onlyPatterns.some((pattern) => entry.name.includes(pattern))) {
      return false;
    }
    return true;
  });

  return {
    selected,
    totalCount: entries.length,
    defaultFilteredCount: entries.length - afterDefaultFilters.length,
    patternFilteredCount: afterDefaultFilters.length - selected.length,
  };
}

function buildFunctionDefinition(name) {
  const directory = path.join(functionsRoot, name);
  const source = readFunctionSource(directory);
  const authMethods = inferAuthMethods(source);
  const preferredMethod = inferHttpMethod(source);
  const isLegacyRemoved = source.includes('createLegacyEndpointRemovedHandler');
  const isCommandRuntime =
    source.includes('createCommandHandler') || source.includes('command_runtime/command.ts');

  let defaultSkipped = null;
  if (name.startsWith('antchain_') || DISABLED_FUNCTIONS.has(name)) {
    defaultSkipped = 'disabled';
  } else if (LOCAL_ONLY_FUNCTIONS.has(name)) {
    defaultSkipped = 'local_only';
  }

  return {
    name,
    directory,
    defaultSkipped,
    authMethods,
    preferredMethod,
    isLegacyRemoved,
    isCommandRuntime,
  };
}

function readFunctionSource(directory) {
  const files = [];
  walkDirectory(directory, files);
  return files
    .filter((filePath) => filePath.endsWith('.ts') || filePath.endsWith('.js'))
    .map((filePath) => fs.readFileSync(filePath, 'utf8'))
    .join('\n');
}

function walkDirectory(directory, bucket) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(fullPath, bucket);
      continue;
    }
    bucket.push(fullPath);
  }
}

function inferAuthMethods(source) {
  if (source.includes('createLegacyEndpointRemovedHandler')) {
    return [];
  }

  if (source.includes('createCommandHandler') || source.includes('command_runtime/command.ts')) {
    return ['JWT'];
  }

  const discoveredMethods = new Set();
  const matches = source.matchAll(/allowedMethods:\s*\[([\s\S]*?)\]/g);
  for (const match of matches) {
    const block = match[1];
    for (const methodMatch of block.matchAll(/AuthMethod\.([A-Z_]+)/g)) {
      discoveredMethods.add(methodMatch[1]);
    }
  }

  if (discoveredMethods.size > 0) {
    return ['JWT', 'USER_API_KEY', 'SERVICE_API_KEY'].filter((method) =>
      discoveredMethods.has(method),
    );
  }

  if (source.includes('authenticateRequest(')) {
    return ['JWT', 'USER_API_KEY', 'SERVICE_API_KEY'];
  }

  return [];
}

function inferHttpMethod(source) {
  if (source.includes('Only POST is supported')) {
    return 'POST';
  }
  if (
    source.includes("req.method !== 'GET' && req.method !== 'POST'") ||
    source.includes('req.method !== "GET" && req.method !== "POST"')
  ) {
    return 'GET';
  }
  if (source.includes("req.method !== 'POST'") || source.includes('req.method !== "POST"')) {
    return 'POST';
  }
  if (source.includes("req.method !== 'GET'") || source.includes('req.method !== "GET"')) {
    return 'GET';
  }
  if (source.includes('expected POST request')) {
    return 'POST';
  }
  return 'POST';
}

function formatCredentialPresence(value) {
  return value ? 'yes' : 'no';
}

function buildProbeVariants(definition, credentials) {
  const variants = [{ type: 'none', label: 'no-auth' }];

  for (const method of definition.authMethods) {
    if (method === 'JWT' && credentials.userJwt) {
      variants.push({ type: 'JWT', label: 'jwt' });
    } else if (method === 'USER_API_KEY' && credentials.userApiKey) {
      variants.push({ type: 'USER_API_KEY', label: 'user-api-key' });
    } else if (method === 'SERVICE_API_KEY' && credentials.serviceApiKey) {
      variants.push({ type: 'SERVICE_API_KEY', label: 'service-api-key' });
    }
  }

  const missing = definition.authMethods.filter((method) => {
    if (method === 'JWT') {
      return !credentials.userJwt;
    }
    if (method === 'USER_API_KEY') {
      return !credentials.userApiKey;
    }
    if (method === 'SERVICE_API_KEY') {
      return !credentials.serviceApiKey;
    }
    return false;
  });

  return { variants, missing };
}

function printDryRunPlan(inventory, credentials) {
  for (const definition of inventory) {
    const { variants, missing } = buildProbeVariants(definition, credentials);
    const authLabel =
      definition.authMethods.length > 0 ? definition.authMethods.join('|') : 'public-or-unknown';
    const probeLabels = variants.map((variant) => variant.label).join(', ');
    const missingLabel = missing.length > 0 ? ` missing=${missing.join('|')}` : '';
    const defaultSkipLabel =
      definition.defaultSkipped === 'disabled'
        ? ' disabled-by-default'
        : definition.defaultSkipped === 'local_only'
          ? ' local-only-by-default'
          : '';
    console.log(
      `${definition.name.padEnd(36)} method=${definition.preferredMethod.padEnd(
        4,
      )} auth=${authLabel.padEnd(28)} probes=${probeLabels}${missingLabel}${defaultSkipLabel}`,
    );
  }
}

async function probeFunction(definition, context) {
  const { variants, missing } = buildProbeVariants(definition, context.credentials);
  const probes = [];

  for (const variant of variants) {
    probes.push(await runProbe(definition, variant, context));
  }

  for (const missingMethod of missing) {
    probes.push({
      label: missingMethod.toLowerCase(),
      variant: missingMethod,
      skipped: true,
      classification: 'skipped_missing_credential',
      summary: `missing credential for ${missingMethod}`,
    });
  }

  const primaryProbe =
    probes.find((probe) => !probe.skipped && probe.variant !== 'none') ??
    probes.find((probe) => !probe.skipped) ??
    probes[0];

  return {
    ...definition,
    probes,
    primaryClassification: primaryProbe?.classification ?? 'skipped_missing_credential',
  };
}

async function runProbe(definition, variant, context) {
  const url = `${context.baseUrl}/${definition.name}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), context.timeoutMs);
  const startedAt = Date.now();

  const headers = { Accept: 'application/json' };
  let body;

  if (definition.preferredMethod === 'POST') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(getProbeBody(definition.name));
  }

  if (variant.type === 'JWT') {
    headers.Authorization = `Bearer ${context.credentials.userJwt}`;
  } else if (variant.type === 'USER_API_KEY') {
    headers.Authorization = `Bearer ${context.credentials.userApiKey}`;
  } else if (variant.type === 'SERVICE_API_KEY') {
    headers.apikey = context.credentials.serviceApiKey;
  }

  try {
    const response = await fetch(url, {
      method: definition.preferredMethod,
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const text = await response.text();
    const excerpt = summarizeBody(text);
    const classification = classifyResponse(response.status, text, variant.type);

    return {
      label: variant.label,
      variant: variant.type,
      skipped: false,
      durationMs: Date.now() - startedAt,
      status: response.status,
      classification,
      summary: excerpt,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    const message =
      error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
        ? `request timed out after ${context.timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      label: variant.label,
      variant: variant.type,
      skipped: false,
      durationMs: Date.now() - startedAt,
      classification: 'network_error',
      summary: message,
    };
  }
}

function getProbeBody(functionName) {
  if (
    functionName === 'embedding' ||
    functionName === 'embedding_ft' ||
    functionName === 'embedding_ft_local'
  ) {
    return [];
  }
  return {};
}

function summarizeBody(text) {
  const normalized = String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!normalized) {
    return '(empty response body)';
  }
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function classifyResponse(status, rawBody, variantType) {
  const body = String(rawBody ?? '').toLowerCase();

  if (status >= 200 && status < 300) {
    return 'ok';
  }
  if (status === 404) {
    return 'not_deployed';
  }
  if (status === 410 && body.includes('legacy_endpoint_removed')) {
    return 'legacy_removed';
  }
  if (status === 401 || status === 403) {
    if (body.includes('invalid jwt')) {
      return 'gateway_invalid_jwt';
    }
    if (
      body.includes('authentication required') ||
      body.includes('unauthorized request') ||
      body.includes('user not found') ||
      body.includes('forbidden') ||
      body.includes('unauthorized') ||
      body.includes('invalid service api key') ||
      body.includes('service api key not configured') ||
      body.includes('auth client not configured')
    ) {
      return variantType === 'none' ? 'auth_required' : 'function_auth_failed';
    }
    return variantType === 'none' ? 'auth_required' : 'function_auth_failed';
  }
  if (status === 400 || status === 405 || status === 422) {
    return 'reachable_but_payload_invalid';
  }
  if (status >= 500) {
    return 'server_error';
  }
  return 'reachable_other_client_error';
}

function printResults(results) {
  const counts = new Map();
  for (const result of results) {
    counts.set(result.primaryClassification, (counts.get(result.primaryClassification) ?? 0) + 1);
  }

  console.log('Summary');
  for (const key of SUMMARY_ORDER) {
    if (counts.has(key)) {
      console.log(`  ${key.padEnd(28)} ${counts.get(key)}`);
    }
  }

  console.log('');
  console.log('Per function');
  for (const result of results) {
    const authLabel = result.authMethods.length > 0 ? result.authMethods.join('|') : 'PUBLIC';
    const probeSummary = result.probes
      .map((probe) => {
        if (probe.skipped) {
          return `${probe.label}=skip(${probe.summary})`;
        }
        const statusLabel = probe.status ?? '-';
        return `${probe.label}=${statusLabel}/${probe.classification}`;
      })
      .join(' ');

    console.log(
      `${result.name.padEnd(36)} method=${result.preferredMethod.padEnd(4)} auth=${authLabel.padEnd(
        28,
      )} ${probeSummary}`,
    );

    for (const probe of result.probes) {
      if (probe.summary) {
        const prefix = probe.skipped ? 'skip' : probe.label;
        console.log(`  - ${prefix}: ${probe.summary}`);
      }
    }
  }

  console.log('');
  console.log('Legend');
  console.log('  gateway_invalid_jwt: likely blocked before function runtime');
  console.log('  function_auth_failed: function runtime rejected the provided credential');
  console.log(
    '  reachable_but_payload_invalid: function is reachable and auth likely passed, but the minimal probe body is insufficient',
  );
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await worker(items[current], current);
    }
  }

  const runnerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: runnerCount }, () => runner()));
  return results;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
