#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');

const EXPECTED_TOOLCHAIN_VERSIONS = Object.freeze({
  deno: '2.9.5',
  denoTypescript: '6.0.3',
  node: '24.19.0',
  pnpm: '11.24.0',
});

function parseDenoVersionOutput(output) {
  const deno = /^deno\s+([^\s]+)/mu.exec(output)?.[1] ?? 'unavailable';
  const denoTypescript = /^typescript\s+([^\s]+)/mu.exec(output)?.[1] ?? 'unavailable';
  return { deno, denoTypescript };
}

function readToolchainVersions() {
  let denoVersions = { deno: 'unavailable', denoTypescript: 'unavailable' };
  let pnpm = 'unavailable';

  try {
    denoVersions = parseDenoVersionOutput(
      execFileSync('deno', ['--version'], { encoding: 'utf8' }),
    );
  } catch {
    // The fail-closed validator reports the unavailable runtime.
  }
  try {
    pnpm = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    // The fail-closed validator reports the unavailable package manager.
  }

  return {
    ...denoVersions,
    node: process.versions.node,
    pnpm,
  };
}

function validateToolchainVersions(versions) {
  const errors = [];
  for (const [tool, expected] of Object.entries(EXPECTED_TOOLCHAIN_VERSIONS)) {
    const actual = versions[tool] ?? 'unavailable';
    if (actual !== expected) {
      errors.push(`${tool} version mismatch: expected ${expected}, got ${actual}`);
    }
  }
  return errors;
}

function main() {
  const versions = readToolchainVersions();
  const errors = validateToolchainVersions(versions);

  for (const [tool, version] of Object.entries(versions)) {
    console.log(`[check-env] ${tool}: ${version}`);
  }
  if (errors.length > 0) {
    for (const error of errors) console.error(`[check-env] FAIL ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('[check-env] OK exact Deno and auxiliary Node toolchains');
}

module.exports = {
  EXPECTED_TOOLCHAIN_VERSIONS,
  main,
  parseDenoVersionOutput,
  readToolchainVersions,
  validateToolchainVersions,
};

if (require.main === module) main();
