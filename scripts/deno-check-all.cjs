#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const functionsRoot = path.join(repoRoot, 'supabase', 'functions');
const testRoot = path.join(repoRoot, 'test');
const configPath = path.join('supabase', 'functions', 'deno.json');
const disabledFunctionPrefixes = ['antchain_'];
const disabledFunctionNames = new Set([
  'embedding',
  'webhook_flow_embedding',
  'webhook_model_embedding',
  'webhook_process_embedding',
]);

const functionEntryPoints = fs
  .readdirSync(functionsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== '_shared')
  .filter((entry) => !disabledFunctionPrefixes.some((prefix) => entry.name.startsWith(prefix)))
  .filter((entry) => !disabledFunctionNames.has(entry.name))
  .map((entry) => path.join('supabase', 'functions', entry.name, 'index.ts'))
  .filter((entryPoint) => fs.existsSync(path.join(repoRoot, entryPoint)))
  .sort();

const testFiles = fs
  .readdirSync(testRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => path.join('test', entry.name))
  .sort();

const targets = [...functionEntryPoints, ...testFiles];

console.log(`Running deno check for ${targets.length} targets...`);
console.log(`Skipped disabled function prefixes: ${disabledFunctionPrefixes.join(', ')}`);
console.log(`Skipped disabled function names: ${Array.from(disabledFunctionNames).join(', ')}`);

for (const target of targets) {
  console.log(`- ${target}`);
  const result = spawnSync('deno', ['check', '--config', configPath, target], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
