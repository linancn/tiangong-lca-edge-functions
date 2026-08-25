#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const functionsRoot = path.join(repoRoot, 'supabase', 'functions');
const testRoot = path.join(repoRoot, 'test');
const configPath = path.join('supabase', 'functions', 'deno.json');
const disabledFunctionPrefixes = ['antchain_'];
const MAX_ROOTS_PER_BATCH = 200;

function discoverTargets() {
  const functionEntryPoints = fs
    .readdirSync(functionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
    .filter((entry) => !disabledFunctionPrefixes.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => path.join('supabase', 'functions', entry.name, 'index.ts'))
    .filter((entryPoint) => fs.existsSync(path.join(repoRoot, entryPoint)));

  const testFiles = fs
    .readdirSync(testRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join('test', entry.name));

  return [...new Set([...functionEntryPoints, ...testFiles])].sort();
}

function buildCheckBatches(targets) {
  const batches = [];
  for (let offset = 0; offset < targets.length; offset += MAX_ROOTS_PER_BATCH) {
    batches.push(targets.slice(offset, offset + MAX_ROOTS_PER_BATCH));
  }
  return batches;
}

function runDenoChecks({
  logger = console.log,
  spawnSyncImpl = spawnSync,
  targets = discoverTargets(),
} = {}) {
  const batches = buildCheckBatches(targets);
  logger(
    `Running deno check for ${targets.length} roots in ${batches.length} shared graph batch(es)...`,
  );
  logger(`Skipped disabled function prefixes: ${disabledFunctionPrefixes.join(', ')}`);
  for (const target of targets) logger(`- ${target}`);

  for (const [index, batch] of batches.entries()) {
    logger(`Checking graph batch ${index + 1}/${batches.length} (${batch.length} roots)...`);
    const result = spawnSyncImpl('deno', ['check', '--config', configPath, ...batch], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error) {
      console.error(result.error);
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }

  return 0;
}

module.exports = {
  MAX_ROOTS_PER_BATCH,
  buildCheckBatches,
  discoverTargets,
  runDenoChecks,
};

if (require.main === module) process.exitCode = runDenoChecks();
