#!/usr/bin/env node
'use strict';

const { lstatSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { parseEnv } = require('node:util');

const SOURCE_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const FIXTURE_NAMESPACE_PREFIX = 'portal:test-live-fixture';
const FIXTURE_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// The SDK reads these telemetry selectors while constructing an explicitly configured client.
// Only the disable flag exists in the already-whitelisted child environment.
const DENO_ENV_PERMISSIONS = [
  'PORTAL_UPSTASH_LIVE_FIXTURE',
  'PORTAL_UPSTASH_LIVE_FIXTURE_RUN_ID',
  'PORTAL_REDIS_CLIENT_TYPE',
  'PORTAL_REDIS_NAMESPACE',
  'PORTAL_REDIS_TIMEOUT_MS',
  'PORTAL_UPSTASH_REDIS_URL',
  'PORTAL_UPSTASH_REDIS_TOKEN',
  'UPSTASH_DISABLE_TELEMETRY',
  'UPSTASH_CONSOLE',
  'VERCEL',
  'AWS_REGION',
];

class PortalUpstashFixtureError extends Error {}

function parseArguments(args) {
  let envFile;
  let cleanupOnly = false;
  let runId;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--') continue;
    if (args[index] === '--env-file') {
      envFile = args[index + 1];
      index += 1;
      continue;
    }
    if (args[index] === '--cleanup-only') {
      cleanupOnly = true;
      continue;
    }
    if (args[index] === '--run-id') {
      runId = args[index + 1];
      index += 1;
      continue;
    }
    throw new PortalUpstashFixtureError(`unknown argument: ${args[index]}`);
  }
  if (!envFile) {
    throw new PortalUpstashFixtureError(
      'usage: pnpm test:portal-upstash-live -- --env-file <path> [--run-id <uuid>] [--cleanup-only]',
    );
  }
  if (runId !== undefined) validateFixtureRunId(runId);
  if (cleanupOnly && runId === undefined) {
    throw new PortalUpstashFixtureError('--cleanup-only requires the retained --run-id');
  }
  return { envFile, cleanupOnly, runId };
}

function validateFixtureRunId(runId) {
  if (typeof runId !== 'string' || !FIXTURE_RUN_ID_PATTERN.test(runId)) {
    throw new PortalUpstashFixtureError('fixture run ID must be a canonical lowercase UUIDv4');
  }
  return runId;
}

function resolveFixtureRunId(candidate, dependencies = {}) {
  const generate = dependencies.randomUUIDImpl ?? randomUUID;
  return validateFixtureRunId(candidate ?? generate());
}

function buildFixtureNamespace(runId) {
  return `${FIXTURE_NAMESPACE_PREFIX}:${validateFixtureRunId(runId)}:v1`;
}

function readSourceCredentials(envFile, dependencies = {}) {
  const read = dependencies.readFileSyncImpl ?? readFileSync;
  const stat = dependencies.lstatSyncImpl ?? lstatSync;
  const envPath = resolve(envFile);
  let stats;
  try {
    stats = stat(envPath);
  } catch {
    throw new PortalUpstashFixtureError('unable to inspect the Upstash source env');
  }
  if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
    throw new PortalUpstashFixtureError('Upstash source env must be a mode-0600 regular file');
  }
  let parsed;
  try {
    parsed = parseEnv(read(envPath, 'utf8'));
  } catch {
    throw new PortalUpstashFixtureError('unable to read the Upstash source env');
  }
  const unexpected = Object.keys(parsed).filter((key) => !SOURCE_KEYS.includes(key));
  if (unexpected.length > 0 || Object.keys(parsed).length !== SOURCE_KEYS.length) {
    throw new PortalUpstashFixtureError(
      'Upstash source env must contain exactly the two official REST variables',
    );
  }

  const urlText = parsed.UPSTASH_REDIS_REST_URL?.trim();
  const token = parsed.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!urlText || !token) {
    throw new PortalUpstashFixtureError('Upstash REST credentials are incomplete');
  }
  let url;
  try {
    url = new URL(urlText);
  } catch {
    throw new PortalUpstashFixtureError('Upstash REST URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') {
    throw new PortalUpstashFixtureError('Upstash REST URL must be an HTTPS origin');
  }
  return { urlText, token, host: url.host };
}

function buildChildEnvironment(environment, credentials, runId) {
  const fixtureRunId = validateFixtureRunId(runId);
  const inherited = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'DENO_DIR', 'SSL_CERT_FILE'].flatMap((key) =>
      environment[key] ? [[key, environment[key]]] : [],
    ),
  );
  return {
    ...inherited,
    PORTAL_UPSTASH_LIVE_FIXTURE: '1',
    PORTAL_UPSTASH_LIVE_FIXTURE_RUN_ID: fixtureRunId,
    PORTAL_REDIS_CLIENT_TYPE: 'upstash',
    PORTAL_REDIS_NAMESPACE: buildFixtureNamespace(fixtureRunId),
    PORTAL_REDIS_TIMEOUT_MS: '5000',
    PORTAL_UPSTASH_REDIS_URL: credentials.urlText,
    PORTAL_UPSTASH_REDIS_TOKEN: credentials.token,
    UPSTASH_DISABLE_TELEMETRY: '1',
  };
}

function buildDenoArguments(host, cleanupOnly) {
  const args = [
    'test',
    '--no-prompt',
    '--config',
    'supabase/functions/deno.json',
    `--allow-net=${host}`,
    `--allow-env=${DENO_ENV_PERMISSIONS.join(',')}`,
    'test/portal_redis_upstash_live_test.ts',
  ];
  if (cleanupOnly) args.push('--', '--cleanup-only');
  return args;
}

function runPortalUpstashFixture(input, dependencies = {}) {
  const spawn = dependencies.spawnSyncImpl ?? spawnSync;
  const runId = validateFixtureRunId(input.runId);
  const credentials = readSourceCredentials(input.envFile, dependencies);
  const childEnv = buildChildEnvironment(input.environment, credentials, runId);
  const result = spawn('deno', buildDenoArguments(credentials.host, input.cleanupOnly), {
    cwd: input.repoRoot,
    env: childEnv,
    stdio: 'inherit',
  });
  childEnv.PORTAL_UPSTASH_REDIS_URL = '';
  childEnv.PORTAL_UPSTASH_REDIS_TOKEN = '';
  if (result.error) {
    throw new PortalUpstashFixtureError('unable to run the Deno Upstash fixture');
  }
  return result.status ?? 1;
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const runId = resolveFixtureRunId(options.runId);
    process.stdout.write(`Portal Upstash fixture run ID: ${runId}\n`);
    const status = runPortalUpstashFixture({
      ...options,
      runId,
      environment: process.env,
      repoRoot: resolve(__dirname, '..'),
    });
    if (status !== 0) {
      process.stderr.write(
        `Portal Upstash fixture failed; rerun with the same env file, --cleanup-only, and --run-id ${runId}.\n`,
      );
      process.exit(status);
    }
    process.stdout.write(
      options.cleanupOnly
        ? `Portal Upstash fixture keys are absent for run ${runId}.\n`
        : 'Portal Upstash live fixture passed with verified cleanup.\n',
    );
  } catch (error) {
    const message =
      error instanceof PortalUpstashFixtureError ? error.message : 'Portal Upstash fixture failed';
    process.stderr.write(`${message}\n`);
    process.exit(2);
  }
}

if (require.main === module) main();

module.exports = {
  FIXTURE_NAMESPACE_PREFIX,
  FIXTURE_RUN_ID_PATTERN,
  PortalUpstashFixtureError,
  buildChildEnvironment,
  buildDenoArguments,
  buildFixtureNamespace,
  parseArguments,
  readSourceCredentials,
  resolveFixtureRunId,
  runPortalUpstashFixture,
  validateFixtureRunId,
};
