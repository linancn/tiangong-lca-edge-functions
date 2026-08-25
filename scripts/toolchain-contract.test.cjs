'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
const readJson = (relativePath) => JSON.parse(read(relativePath));
const workflowSources = fs
  .readdirSync(path.join(repositoryRoot, '.github/workflows'))
  .filter((fileName) => fileName.endsWith('.yml'))
  .map((fileName) => ({ fileName, source: read(`.github/workflows/${fileName}`) }));

const expectedActions = new Map([
  ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
  ['denoland/setup-deno', '22d081ff2d3a40755e97629de92e3bcbfa7cf2ed'],
  ['dtolnay/rust-toolchain', '4360b52568e2003a75bf9bc1d59f33a8e3fc893c'],
  ['pnpm/setup', '84cb39b217b10273981911c288cd62326dc7c6d2'],
]);

test('keeps Deno authoritative and auxiliary Node tooling exact', () => {
  const packageJson = readJson('package.json');

  assert.equal(packageJson.packageManager, 'pnpm@11.23.0');
  assert.deepEqual(packageJson.engines, { node: '24.19.0', pnpm: '11.23.0' });
  assert.equal(packageJson.config.denoVersion, '2.9.5');
  assert.equal(packageJson.config.denoTypeScriptVersion, '6.0.3');
  assert.equal(packageJson.devDependencies.prettier, '3.9.5');
  assert.equal(packageJson.devDependencies.supabase, '2.106.0');
  assert.equal(packageJson.devDependencies.typescript, undefined);
  assert.equal(packageJson.devDependencies['prettier-plugin-organize-imports'], undefined);
  assert.equal(read('.nvmrc').trim(), '24.19.0');
  assert.doesNotMatch(read('.prettierrc.js'), /prettier-plugin-organize-imports/u);
});

test('uses one frozen pnpm graph without npm-owned compiler tooling', () => {
  const lockfile = read('pnpm-lock.yaml');
  const workspace = read('pnpm-workspace.yaml');

  assert.match(lockfile, /^\s{2}prettier@3\.9\.5:/mu);
  assert.match(lockfile, /^\s{2}supabase@2\.106\.0:/mu);
  assert.doesNotMatch(lockfile, /^\s{2}typescript@/mu);
  assert.doesNotMatch(lockfile, /prettier-plugin-organize-imports/u);
  assert.match(workspace, /supabase:\s*true/u);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'package-lock.json')), false);
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'yarn.lock')), false);
});

test('makes canonical check run exact environment, graph, and behavior tests', () => {
  const scripts = readJson('package.json').scripts;

  assert.equal(scripts['check:env'], 'node scripts/check-env.cjs');
  assert.equal(scripts['check:types'], 'node scripts/deno-check-all.cjs');
  assert.equal(scripts['test:node'], 'node --test scripts/*.test.cjs');
  assert.equal(
    scripts['test:deno'],
    'deno test --config supabase/functions/deno.json --allow-env --allow-read --allow-net=127.0.0.1 test',
  );
  assert.equal(scripts.test, 'pnpm test:node && pnpm test:deno');
  assert.equal(scripts.check, 'pnpm check:env && pnpm check:types && pnpm test');
  assert.equal(
    scripts.lint,
    'pnpm exec prettier --check "**/*.{cjs,js,jsx,tsx,ts,less,md,json,yml,yaml}"',
  );
});

test('uses pnpm only across active repository automation', () => {
  const activeSources = [
    ['package.json', read('package.json')],
    ...fs
      .readdirSync(path.join(repositoryRoot, 'scripts'))
      .filter((fileName) => /\.(?:cjs|sh)$/u.test(fileName) && !fileName.endsWith('.test.cjs'))
      .map((fileName) => [`scripts/${fileName}`, read(`scripts/${fileName}`)]),
    ...fs
      .readdirSync(path.join(repositoryRoot, '.githooks'))
      .map((fileName) => [`.githooks/${fileName}`, read(`.githooks/${fileName}`)]),
    ...workflowSources.map(({ fileName, source }) => [`.github/workflows/${fileName}`, source]),
  ];

  for (const [relativePath, source] of activeSources) {
    assert.doesNotMatch(source, /(^|[\s"'`:])npx(?=$|[\s"'])/mu, relativePath);
    assert.doesNotMatch(source, /(^|[\s"'`:])npm\s+(?:exec|install|pack|publish|rebuild|run|test)(?=$|\s)/mu, relativePath);
  }
});

test('pins every external action to a reviewed executable commit', () => {
  const observedActions = new Map();

  for (const { fileName, source } of workflowSources) {
    for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)) {
      const actionRef = match[1];
      if (actionRef.startsWith('./')) continue;

      assert.match(actionRef, /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[a-f0-9]{40}$/iu, fileName);
      const separator = actionRef.lastIndexOf('@');
      const action = actionRef.slice(0, separator);
      const commit = actionRef.slice(separator + 1);
      assert.equal(commit, expectedActions.get(action), `${fileName}: unexpected ${action} commit`);
      observedActions.set(action, commit);
    }
  }

  assert.deepEqual(observedActions, expectedActions);
  assert.equal(workflowSources.some(({ source }) => source.includes('actions/setup-node')), false);
  assert.equal(workflowSources.some(({ source }) => source.includes('pnpm/action-setup')), false);
});

test('binds CI to exact Deno and auxiliary Node runtimes', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /version:\s*11\.23\.0/u);
  assert.match(ci, /runtime:\s*node@24\.19\.0/u);
  assert.match(ci, /deno-version:\s*2\.9\.5/u);
  assert.match(ci, /run:\s*pnpm install --frozen-lockfile/u);
  assert.match(ci, /run:\s*pnpm check/u);
});
