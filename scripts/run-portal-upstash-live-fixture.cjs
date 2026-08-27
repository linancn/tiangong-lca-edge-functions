#!/usr/bin/env node
'use strict';

const { randomBytes } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseEnv } = require('node:util');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let envFile;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--') {
    continue;
  } else if (args[index] === '--env-file') {
    envFile = args[index + 1];
    index += 1;
  } else {
    fail(`unknown argument: ${args[index]}`);
  }
}
if (!envFile)
  fail('usage: pnpm test:portal-upstash-live -- --env-file <absolute-or-relative-path>');

const envPath = resolve(envFile);
const stats = statSync(envPath);
if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
  fail('Upstash source env must be a mode-0600 regular file');
}

const parsed = parseEnv(readFileSync(envPath, 'utf8'));
const allowedKeys = new Set(['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']);
const unexpected = Object.keys(parsed).filter((key) => !allowedKeys.has(key));
if (unexpected.length > 0 || Object.keys(parsed).length !== allowedKeys.size) {
  fail('Upstash source env must contain exactly the two official REST variables');
}

const sourceUrl = parsed.UPSTASH_REDIS_REST_URL?.trim();
const sourceToken = parsed.UPSTASH_REDIS_REST_TOKEN?.trim();
if (!sourceUrl || !sourceToken) fail('Upstash REST credentials are incomplete');
let url;
try {
  url = new URL(sourceUrl);
} catch {
  fail('Upstash REST URL is invalid');
}
if (url.protocol !== 'https:') fail('Upstash REST URL must use HTTPS');

const namespace = `portal:test-live-${randomBytes(6).toString('hex')}:v1`;
const childEnv = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'DENO_DIR', 'SSL_CERT_FILE'].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
childEnv.PORTAL_UPSTASH_LIVE_FIXTURE = '1';
childEnv.PORTAL_REDIS_CLIENT_TYPE = 'upstash';
childEnv.PORTAL_REDIS_NAMESPACE = namespace;
childEnv.PORTAL_REDIS_TIMEOUT_MS = '5000';
childEnv.PORTAL_UPSTASH_REDIS_URL = sourceUrl;
childEnv.PORTAL_UPSTASH_REDIS_TOKEN = sourceToken;

const result = spawnSync(
  'deno',
  [
    'test',
    '--config',
    'supabase/functions/deno.json',
    '--allow-read',
    `--allow-net=${url.host}`,
    '--allow-env',
    'test/portal_redis_upstash_live_test.ts',
  ],
  { cwd: resolve(__dirname, '..'), env: childEnv, stdio: 'inherit' },
);

childEnv.PORTAL_UPSTASH_REDIS_URL = '';
childEnv.PORTAL_UPSTASH_REDIS_TOKEN = '';
if (result.error) fail('unable to run the Deno Upstash fixture');
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write('Portal Upstash live fixture passed with verified cleanup.\n');
