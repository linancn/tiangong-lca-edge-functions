#!/usr/bin/env node
'use strict';

const { lstatSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseEnv } = require('node:util');

const SOURCE_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const FIXTURE_NAMESPACE = 'portal:test-live-fixture:v1';
// The SDK reads these telemetry selectors while constructing an explicitly configured client.
// Only the disable flag exists in the already-whitelisted child environment.
const DENO_ENV_PERMISSIONS = [
  'PORTAL_UPSTASH_LIVE_FIXTURE',
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
    throw new PortalUpstashFixtureError(`unknown argument: ${args[index]}`);
  }
  if (!envFile) {
    throw new PortalUpstashFixtureError(
      'usage: pnpm test:portal-upstash-live -- --env-file <path> [--cleanup-only]',
    );
  }
  return { envFile, cleanupOnly };
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

function buildChildEnvironment(environment, credentials) {
  const inherited = Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'DENO_DIR', 'SSL_CERT_FILE'].flatMap((key) =>
      environment[key] ? [[key, environment[key]]] : [],
    ),
  );
  return {
    ...inherited,
    PORTAL_UPSTASH_LIVE_FIXTURE: '1',
    PORTAL_REDIS_CLIENT_TYPE: 'upstash',
    PORTAL_REDIS_NAMESPACE: FIXTURE_NAMESPACE,
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
  const credentials = readSourceCredentials(input.envFile, dependencies);
  const childEnv = buildChildEnvironment(input.environment, credentials);
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
    const status = runPortalUpstashFixture({
      ...options,
      environment: process.env,
      repoRoot: resolve(__dirname, '..'),
    });
    if (status !== 0) {
      process.stderr.write(
        'Portal Upstash fixture failed; rerun with the same env file and --cleanup-only.\n',
      );
      process.exit(status);
    }
    process.stdout.write(
      options.cleanupOnly
        ? 'Portal Upstash fixture keys are absent.\n'
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
  FIXTURE_NAMESPACE,
  PortalUpstashFixtureError,
  buildChildEnvironment,
  buildDenoArguments,
  parseArguments,
  readSourceCredentials,
  runPortalUpstashFixture,
};
