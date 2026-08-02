const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const required = [
  'LCA_RESULT_CONTRACT_URL',
  'LCA_RESULT_CONTRACT_DIRECT_REST_URL',
  'LCA_RESULT_CONTRACT_AUTH_URL',
  'LCA_RESULT_CONTRACT_DB_URL',
  'LCA_RESULT_CONTRACT_SERVICE_KEY',
  'LCA_RESULT_CONTRACT_ANON_KEY',
  'LCA_RESULT_CONTRACT_PUBLISHABLE_KEY',
  'LCA_RESULT_CONTRACT_MIGRATION_HEAD',
  'LCA_RESULT_CONTRACT_DATABASE_COMMIT',
];
for (const name of required) {
  if (!process.env[name]?.trim()) throw new Error(`Missing required local contract env: ${name}`);
}

for (const name of [
  'LCA_RESULT_CONTRACT_URL',
  'LCA_RESULT_CONTRACT_DIRECT_REST_URL',
  'LCA_RESULT_CONTRACT_AUTH_URL',
  'LCA_RESULT_CONTRACT_DB_URL',
]) {
  const hostname = new URL(process.env[name]).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) {
    throw new Error(`${name} must target a loopback-only qualification stack`);
  }
}

if (!/^[0-9]{14}$/.test(process.env.LCA_RESULT_CONTRACT_MIGRATION_HEAD)) {
  throw new Error('LCA_RESULT_CONTRACT_MIGRATION_HEAD must be the exact 14-digit DB #395 head');
}
if (!/^[0-9a-f]{40}$/.test(process.env.LCA_RESULT_CONTRACT_DATABASE_COMMIT)) {
  throw new Error('LCA_RESULT_CONTRACT_DATABASE_COMMIT must be the exact DB #395 merge commit');
}
const adapterSource = fs.readFileSync(
  path.join('supabase', 'functions', '_shared', 'capabilities', 'lca_result_family.ts'),
  'utf8',
);
const pinnedCommit = adapterSource.match(/databaseCommit:\s*'([0-9a-f]{40})'/)?.[1];
const pinnedHead = adapterSource.match(/migrationHead:\s*'([0-9]{14})'/)?.[1];
if (
  pinnedCommit !== process.env.LCA_RESULT_CONTRACT_DATABASE_COMMIT ||
  pinnedHead !== process.env.LCA_RESULT_CONTRACT_MIGRATION_HEAD
) {
  throw new Error(
    `LCA result contract receipt does not match adapter pin: ${JSON.stringify({ pinnedCommit, pinnedHead })}`,
  );
}

const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-result-contract-'));
const junitPath = path.join(reportDirectory, 'junit.xml');

try {
  const result = spawnSync(
    'deno',
    [
      'test',
      '--junit-path',
      junitPath,
      '--allow-env',
      '--allow-net=127.0.0.1,localhost',
      '--config',
      'supabase/functions/deno.json',
      'test/lca_result_contract_cleanup_test.ts',
      'test/lca_result_family_db_contract_test.ts',
    ],
    {
      env: {
        ...process.env,
        LCA_RESULT_DB_CONTRACT: '1',
        LCA_RESULT_CONTRACT_ACTOR_ID:
          process.env.LCA_RESULT_CONTRACT_ACTOR_ID ?? 'c2580000-0000-4000-8000-000000000001',
        LCA_RESULT_CONTRACT_SNAPSHOT_ID:
          process.env.LCA_RESULT_CONTRACT_SNAPSHOT_ID ?? 'c2580000-0000-4000-8000-000000000002',
      },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`LCA result-family contract exited with status ${result.status ?? 'unknown'}`);
  }

  const junit = fs.readFileSync(junitPath, 'utf8');
  const suites = [...junit.matchAll(/<testsuite\b[^>]*>/g)].map((match) => match[0]);
  const summary = suites.reduce(
    (total, suite) => {
      const attrs = Object.fromEntries(
        [...suite.matchAll(/([a-z_]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
      );
      total.tests += Number(attrs.tests);
      total.ignored += Number(attrs.disabled);
      total.errors += Number(attrs.errors);
      total.failures += Number(attrs.failures);
      return total;
    },
    { tests: 0, ignored: 0, errors: 0, failures: 0 },
  );
  if (
    summary.tests !== 2 ||
    summary.ignored !== 0 ||
    summary.errors !== 0 ||
    summary.failures !== 0
  ) {
    throw new Error(`LCA result-family contract execution mismatch: ${JSON.stringify(summary)}`);
  }
  console.log(
    'LCA result-family contract summary: 2 passed, 0 failed, 0 ignored; DB/Auth residue independently read back as zero',
  );
} finally {
  fs.rmSync(reportDirectory, { recursive: true, force: true });
}
