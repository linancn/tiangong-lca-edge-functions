'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DISPOSABLE_ACK,
  FUNCTION_NAME,
  buildPortalR0DeployArgs,
  validatePortalR0Deploy,
} = require('./deploy-portal-r0-fixture.cjs');

const NOW = Date.parse('2026-08-26T08:00:00.000Z');
const HEAD = 'a'.repeat(40);
const PREVIEW_REF = 'abcdefghijklmnopqrst';
const DEV_REF = 'submidrhbtknjxfympna';
const MAIN_REF = 'qgzvkongdjqiiamzbbts';

function validInput() {
  return {
    target: 'preview',
    environment: {
      PORTAL_R0_PROJECT_REF: PREVIEW_REF,
      PORTAL_R0_RUNTIME_TARGET: 'preview',
      PORTAL_R0_DEPLOYMENT_SHA: HEAD,
      PORTAL_R0_DEPLOY_EXPIRES_AT: '2026-08-27T07:59:59.000Z',
      PORTAL_R0_DISPOSABLE_ACK: DISPOSABLE_ACK,
    },
    persistentDevProjectRef: DEV_REF,
    productionProjectRef: MAIN_REF,
    gitHead: HEAD,
    gitClean: true,
    nowMillis: NOW,
  };
}

test('builds one fixed no-gateway-JWT R0 function deployment', () => {
  assert.deepEqual(buildPortalR0DeployArgs(PREVIEW_REF, 'supabase/functions/deno.json'), [
    'exec',
    'supabase',
    'functions',
    'deploy',
    FUNCTION_NAME,
    '--project-ref',
    PREVIEW_REF,
    '--no-verify-jwt',
    '--import-map',
    'supabase/functions/deno.json',
  ]);
});

test('accepts only explicit short-lived Preview and test fixture targets', () => {
  assert.deepEqual(validatePortalR0Deploy(validInput()), {
    projectRef: PREVIEW_REF,
    deploymentSha: HEAD,
    expiresAtText: '2026-08-27T07:59:59.000Z',
  });
  const testInput = validInput();
  testInput.target = 'test';
  testInput.environment.PORTAL_R0_RUNTIME_TARGET = 'test';
  assert.equal(validatePortalR0Deploy(testInput).projectRef, PREVIEW_REF);
});

for (const [name, mutate] of [
  ['production target', (input) => (input.target = 'production')],
  ['main target', (input) => (input.target = 'main')],
  ['persistent Dev ref', (input) => (input.environment.PORTAL_R0_PROJECT_REF = DEV_REF)],
  ['Production ref', (input) => (input.environment.PORTAL_R0_PROJECT_REF = MAIN_REF)],
  ['runtime target mismatch', (input) => (input.environment.PORTAL_R0_RUNTIME_TARGET = 'test')],
  [
    'missing disposable acknowledgement',
    (input) => delete input.environment.PORTAL_R0_DISPOSABLE_ACK,
  ],
  [
    'wrong disposable acknowledgement',
    (input) => (input.environment.PORTAL_R0_DISPOSABLE_ACK = 'keep'),
  ],
  ['SHA mismatch', (input) => (input.environment.PORTAL_R0_DEPLOYMENT_SHA = 'b'.repeat(40))],
  ['dirty worktree', (input) => (input.gitClean = false)],
  [
    'expired fixture',
    (input) => (input.environment.PORTAL_R0_DEPLOY_EXPIRES_AT = '2026-08-26T07:59:59.000Z'),
  ],
  [
    'fixture beyond 24 hours',
    (input) => (input.environment.PORTAL_R0_DEPLOY_EXPIRES_AT = '2026-08-27T08:00:01.000Z'),
  ],
]) {
  test(`rejects ${name}`, () => {
    const input = validInput();
    mutate(input);
    assert.throws(() => validatePortalR0Deploy(input), /R0 deploy/u);
  });
}

test('guard surface never accepts a function name argument', () => {
  assert.equal(FUNCTION_NAME, 'portal_r0_hmac_verify_v1');
  assert.equal(validatePortalR0Deploy.length, 1);
});
