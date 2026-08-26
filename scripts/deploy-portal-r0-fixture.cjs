#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const FUNCTION_NAME = 'portal_r0_hmac_verify_v1';
const ALLOWED_TARGETS = new Set(['preview', 'test']);
const DISPOSABLE_ACK = 'delete-after-evidence';
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error('R0 deploy configuration is invalid.');
  }
  return value;
}

function validatePortalR0Deploy(input) {
  if (!ALLOWED_TARGETS.has(input.target)) {
    throw new Error('R0 deploy target must be explicit Preview or test.');
  }
  const projectRef = requiredEnvironmentValue(input.environment, 'PORTAL_R0_PROJECT_REF');
  const runtimeTarget = requiredEnvironmentValue(input.environment, 'PORTAL_R0_RUNTIME_TARGET');
  const deploymentSha = requiredEnvironmentValue(input.environment, 'PORTAL_R0_DEPLOYMENT_SHA');
  const expiresAtText = requiredEnvironmentValue(input.environment, 'PORTAL_R0_DEPLOY_EXPIRES_AT');
  const disposableAck = requiredEnvironmentValue(input.environment, 'PORTAL_R0_DISPOSABLE_ACK');

  if (
    !PROJECT_REF_PATTERN.test(projectRef) ||
    projectRef === input.persistentDevProjectRef ||
    projectRef === input.productionProjectRef ||
    runtimeTarget !== input.target ||
    disposableAck !== DISPOSABLE_ACK ||
    !SHA_PATTERN.test(deploymentSha) ||
    deploymentSha !== input.gitHead ||
    !input.gitClean
  ) {
    throw new Error('R0 deploy configuration is invalid.');
  }

  const expiresAt = Date.parse(expiresAtText);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= input.nowMillis ||
    expiresAt - input.nowMillis > MAX_LIFETIME_MS
  ) {
    throw new Error('R0 deploy expiry must be within the next 24 hours.');
  }

  return { projectRef, deploymentSha, expiresAtText };
}

function buildPortalR0DeployArgs(projectRef, importMapPath) {
  return [
    'exec',
    'supabase',
    'functions',
    'deploy',
    FUNCTION_NAME,
    '--project-ref',
    projectRef,
    '--no-verify-jwt',
    '--import-map',
    importMapPath,
  ];
}

function main(options = {}) {
  const target = options.target ?? process.argv[2];
  const environment = options.environment ?? process.env;
  const repoRoot = options.repoRoot ?? path.resolve(__dirname, '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const gitHead = (options.execFileSyncImpl ?? execFileSync)('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const gitClean =
    (options.execFileSyncImpl ?? execFileSync)('git', ['status', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim() === '';

  const validated = validatePortalR0Deploy({
    target,
    environment,
    persistentDevProjectRef: packageJson.config?.supabaseProjectRefDev,
    productionProjectRef: packageJson.config?.supabaseProjectRefMain,
    gitHead,
    gitClean,
    nowMillis: options.nowMillis ?? Date.now(),
  });
  const cliVersion = packageJson.config?.supabaseCliVersion;
  if (!cliVersion || packageJson.devDependencies?.supabase !== cliVersion) {
    throw new Error('Pinned Supabase CLI configuration is invalid.');
  }

  const args = buildPortalR0DeployArgs(
    validated.projectRef,
    path.join('supabase', 'functions', 'deno.json'),
  );
  if (environment.PORTAL_R0_DEPLOY_DRY_RUN === 'true') {
    console.log('[deploy:portal-r0] dry-run guard passed');
    return { command: 'pnpm', args, ...validated };
  }

  const result = (options.spawnSyncImpl ?? spawnSync)('pnpm', args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: environment,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  return { command: 'pnpm', args, ...validated };
}

module.exports = {
  ALLOWED_TARGETS,
  DISPOSABLE_ACK,
  FUNCTION_NAME,
  MAX_LIFETIME_MS,
  buildPortalR0DeployArgs,
  main,
  validatePortalR0Deploy,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'R0 deploy rejected.');
    process.exit(1);
  }
}
