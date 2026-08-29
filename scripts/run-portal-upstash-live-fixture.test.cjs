'use strict';

const assert = require('node:assert/strict');
const { chmodSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  FIXTURE_NAMESPACE_PREFIX,
  buildChildEnvironment,
  buildDenoArguments,
  buildFixtureNamespace,
  parseArguments,
  readSourceCredentials,
  resolveFixtureRunId,
  runPortalUpstashFixture,
} = require('./run-portal-upstash-live-fixture.cjs');

const RUN_ID_A = '11111111-1111-4111-8111-111111111111';
const RUN_ID_B = '22222222-2222-4222-a222-222222222222';

const SOURCE_TEXT = [
  'UPSTASH_REDIS_REST_URL=https://fixture.example.upstash.io',
  'UPSTASH_REDIS_REST_TOKEN=fixture-token',
  '',
].join('\n');

function withSourceFile(sourceText, mode, callback) {
  const directory = mkdtempSync(join(tmpdir(), 'portal-upstash-runner-'));
  const envFile = join(directory, 'upstash.env');
  try {
    writeFileSync(envFile, sourceText, { mode: 0o600 });
    chmodSync(envFile, mode);
    return callback(envFile);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('accepts an optional run receipt and requires it for deterministic cleanup', () => {
  assert.deepEqual(parseArguments(['--env-file', '/tmp/upstash.env']), {
    envFile: '/tmp/upstash.env',
    cleanupOnly: false,
    runId: undefined,
  });
  assert.deepEqual(
    parseArguments([
      '--',
      '--cleanup-only',
      '--run-id',
      RUN_ID_A,
      '--env-file',
      '/tmp/upstash.env',
    ]),
    {
      envFile: '/tmp/upstash.env',
      cleanupOnly: true,
      runId: RUN_ID_A,
    },
  );
  assert.throws(
    () => parseArguments(['--cleanup-only', '--env-file', '/not-read.env']),
    /requires the retained --run-id/u,
  );
  assert.throws(
    () => parseArguments(['--env-file', '/not-read.env', '--run-id', 'predictable']),
    /canonical lowercase UUIDv4/u,
  );
  assert.throws(() => parseArguments(['--unknown']), /unknown argument/u);
});

test('generates distinct canonical run receipts and derives disjoint namespaces', () => {
  const generated = [RUN_ID_A, RUN_ID_B];
  const first = resolveFixtureRunId(undefined, { randomUUIDImpl: () => generated.shift() });
  const second = resolveFixtureRunId(undefined, { randomUUIDImpl: () => generated.shift() });
  assert.notEqual(first, second);
  assert.match(buildFixtureNamespace(first), /^portal:t[a-z0-9]{25}:v1$/u);
  assert.match(buildFixtureNamespace(second), /^portal:t[a-z0-9]{25}:v1$/u);
  assert.equal(buildFixtureNamespace(first).startsWith(FIXTURE_NAMESPACE_PREFIX), true);
  assert.notEqual(buildFixtureNamespace(first), buildFixtureNamespace(second));
});

test('accepts only a mode-0600 source with the two official REST names', () => {
  withSourceFile(SOURCE_TEXT, 0o600, (envFile) => {
    assert.deepEqual(readSourceCredentials(envFile), {
      urlText: 'https://fixture.example.upstash.io',
      token: 'fixture-token',
      host: 'fixture.example.upstash.io',
    });
  });
  withSourceFile(SOURCE_TEXT, 0o644, (envFile) => {
    assert.throws(() => readSourceCredentials(envFile), /mode-0600/u);
  });
  let insecureReadCount = 0;
  assert.throws(
    () =>
      readSourceCredentials('/not-read.env', {
        lstatSyncImpl: () => ({ isFile: () => true, mode: 0o100644 }),
        readFileSyncImpl: () => {
          insecureReadCount += 1;
          return SOURCE_TEXT;
        },
      }),
    /mode-0600/u,
  );
  assert.equal(insecureReadCount, 0);
  withSourceFile(`${SOURCE_TEXT}UNRELATED=value\n`, 0o600, (envFile) => {
    assert.throws(() => readSourceCredentials(envFile), /exactly the two official/u);
  });
});

test('maps credentials into a minimal Portal-only child environment', () => {
  const child = buildChildEnvironment(
    { PATH: '/bin', HOME: '/tmp/home', UNRELATED: 'must-not-pass' },
    { urlText: 'https://fixture.example.upstash.io', token: 'fixture-token' },
    RUN_ID_A,
  );
  assert.deepEqual(child, {
    PATH: '/bin',
    HOME: '/tmp/home',
    PORTAL_UPSTASH_LIVE_FIXTURE: '1',
    PORTAL_UPSTASH_LIVE_FIXTURE_RUN_ID: RUN_ID_A,
    PORTAL_REDIS_CLIENT_TYPE: 'upstash',
    PORTAL_REDIS_NAMESPACE: buildFixtureNamespace(RUN_ID_A),
    PORTAL_REDIS_TIMEOUT_MS: '5000',
    PORTAL_UPSTASH_REDIS_URL: 'https://fixture.example.upstash.io',
    PORTAL_UPSTASH_REDIS_TOKEN: 'fixture-token',
    UPSTASH_DISABLE_TELEMETRY: '1',
  });
  assert.equal(child.UPSTASH_REDIS_REST_URL, undefined);
  assert.equal(child.UPSTASH_REDIS_REST_TOKEN, undefined);
});

test('grants no filesystem access and restricts network access to the exact Upstash host', () => {
  const args = buildDenoArguments('fixture.example.upstash.io', false);
  assert.deepEqual(args, [
    'test',
    '--no-prompt',
    '--config',
    'supabase/functions/deno.json',
    '--allow-net=fixture.example.upstash.io',
    '--allow-env=PORTAL_UPSTASH_LIVE_FIXTURE,PORTAL_UPSTASH_LIVE_FIXTURE_RUN_ID,PORTAL_REDIS_CLIENT_TYPE,PORTAL_REDIS_NAMESPACE,PORTAL_REDIS_TIMEOUT_MS,PORTAL_UPSTASH_REDIS_URL,PORTAL_UPSTASH_REDIS_TOKEN,UPSTASH_DISABLE_TELEMETRY,UPSTASH_CONSOLE,VERCEL,AWS_REGION',
    'test/portal_redis_upstash_live_test.ts',
  ]);
  assert.equal(
    args.some((argument) => argument.startsWith('--allow-read')),
    false,
  );
  assert.deepEqual(buildDenoArguments('fixture.example.upstash.io', true).slice(-2), [
    '--',
    '--cleanup-only',
  ]);
});

test('runs one inherited-stdio Deno child and propagates its status', () => {
  withSourceFile(SOURCE_TEXT, 0o600, (envFile) => {
    const calls = [];
    const status = runPortalUpstashFixture(
      {
        envFile,
        cleanupOnly: false,
        runId: RUN_ID_A,
        environment: { PATH: '/bin', UNRELATED: 'must-not-pass' },
        repoRoot: '/fixture/repo',
      },
      {
        spawnSyncImpl(command, args, options) {
          calls.push({ command, args, options: { ...options, env: { ...options.env } } });
          return { status: 17 };
        },
      },
    );
    assert.equal(status, 17);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'deno');
    assert.equal(calls[0].options.cwd, '/fixture/repo');
    assert.equal(calls[0].options.stdio, 'inherit');
    assert.equal(calls[0].options.env.UNRELATED, undefined);
    assert.equal(calls[0].options.env.PORTAL_UPSTASH_REDIS_TOKEN, 'fixture-token');

    assert.equal(
      runPortalUpstashFixture(
        {
          envFile,
          cleanupOnly: true,
          runId: RUN_ID_A,
          environment: { PATH: '/bin' },
          repoRoot: '/fixture/repo',
        },
        { spawnSyncImpl: () => ({ status: null, signal: 'SIGTERM' }) },
      ),
      1,
    );
  });
});

test('rejects an invalid cleanup receipt before inspecting credentials', () => {
  let credentialReadCount = 0;
  assert.throws(
    () =>
      runPortalUpstashFixture(
        {
          envFile: '/not-read.env',
          cleanupOnly: true,
          runId: undefined,
          environment: { PATH: '/bin' },
          repoRoot: '/fixture/repo',
        },
        {
          lstatSyncImpl: () => {
            credentialReadCount += 1;
            return { isFile: () => true, mode: 0o100600 };
          },
        },
      ),
    /canonical lowercase UUIDv4/u,
  );
  assert.equal(credentialReadCount, 0);
});
