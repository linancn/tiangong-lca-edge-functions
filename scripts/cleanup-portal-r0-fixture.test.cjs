'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  EXTERNAL_CLEANUP_CHECKLIST,
  buildPortalR0CleanupArgs,
  main,
} = require('./cleanup-portal-r0-fixture.cjs');

const NOW = Date.parse('2026-08-26T08:00:00.000Z');
const HEAD = 'a'.repeat(40);
const PREVIEW_REF = 'abcdefghijklmnopqrst';

function environment(overrides = {}) {
  return {
    PORTAL_R0_PROJECT_REF: PREVIEW_REF,
    PORTAL_R0_RUNTIME_TARGET: 'preview',
    PORTAL_R0_DEPLOYMENT_SHA: HEAD,
    PORTAL_R0_DEPLOY_EXPIRES_AT: '2026-08-27T07:59:59.000Z',
    PORTAL_R0_DISPOSABLE_ACK: 'delete-after-evidence',
    PORTAL_R0_CLEANUP_DRY_RUN: 'true',
    ...overrides,
  };
}

function run(overrides = {}) {
  const logs = [];
  const originalLog = console.log;
  console.log = (value) => logs.push(String(value));
  try {
    const result = main({
      target: 'preview',
      environment: environment(),
      repoRoot: process.cwd(),
      nowMillis: NOW,
      execFileSyncImpl(_command, args) {
        return args[0] === 'rev-parse' ? `${HEAD}\n` : '';
      },
      spawnSyncImpl() {
        throw new Error('dry-run must not mutate remote state');
      },
      ...overrides,
    });
    return { result, logs };
  } finally {
    console.log = originalLog;
  }
}

test('builds one fixed remote function deletion and no generic delete surface', () => {
  assert.deepEqual(buildPortalR0CleanupArgs(PREVIEW_REF), [
    'exec',
    'supabase',
    'functions',
    'delete',
    'portal_r0_hmac_verify_v1',
    '--project-ref',
    PREVIEW_REF,
  ]);
});

test('dry-run applies the deploy guard and emits external Redis/credential cleanup checks', () => {
  const { result, logs } = run();
  assert.deepEqual(result.externalCleanupChecklist, EXTERNAL_CLEANUP_CHECKLIST);
  assert.equal(logs[0], '[cleanup:portal-r0] dry-run guard passed');
  assert.equal(logs.length, EXTERNAL_CLEANUP_CHECKLIST.length + 1);
  assert.match(logs.join('\n'), /delete the dedicated R0 Redis database/u);
  assert.match(logs.join('\n'), /revoke the one-time R0 HMAC/u);
  assert.doesNotMatch(logs.join('\n'), new RegExp(PREVIEW_REF, 'u'));
  assert.doesNotMatch(logs.join('\n'), new RegExp(HEAD, 'u'));
});

for (const [name, overrides] of [
  ['production target', { target: 'production' }],
  [
    'persistent Dev ref',
    { environment: environment({ PORTAL_R0_PROJECT_REF: 'submidrhbtknjxfympna' }) },
  ],
  [
    'Production ref',
    { environment: environment({ PORTAL_R0_PROJECT_REF: 'qgzvkongdjqiiamzbbts' }) },
  ],
  [
    'missing acknowledgement',
    { environment: environment({ PORTAL_R0_DISPOSABLE_ACK: undefined }) },
  ],
  [
    'dirty checkout',
    { execFileSyncImpl: (_command, args) => (args[0] === 'rev-parse' ? HEAD : ' M file') },
  ],
]) {
  test(`cleanup rejects ${name}`, () => {
    assert.throws(() => run(overrides), /R0 deploy/u);
  });
}

test('non-dry cleanup invokes only the fixed Supabase delete command after validation', () => {
  const calls = [];
  const { result } = run({
    environment: environment({ PORTAL_R0_CLEANUP_DRY_RUN: 'false' }),
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pnpm');
  assert.deepEqual(calls[0].args, result.args);
  assert.equal(calls[0].args[4], 'portal_r0_hmac_verify_v1');
});
