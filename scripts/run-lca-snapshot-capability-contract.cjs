const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const required = [
  'LCA_SNAPSHOT_CONTRACT_URL',
  'LCA_SNAPSHOT_CONTRACT_DIRECT_REST_URL',
  'LCA_SNAPSHOT_CONTRACT_AUTH_URL',
  'LCA_SNAPSHOT_CONTRACT_DB_URL',
  'LCA_SNAPSHOT_CONTRACT_SERVICE_KEY',
  'LCA_SNAPSHOT_CONTRACT_ANON_KEY',
  'LCA_SNAPSHOT_CONTRACT_PUBLISHABLE_KEY',
];
for (const name of required) {
  if (!process.env[name]?.trim()) throw new Error(`Missing required local contract env: ${name}`);
}

for (const name of [
  'LCA_SNAPSHOT_CONTRACT_URL',
  'LCA_SNAPSHOT_CONTRACT_DIRECT_REST_URL',
  'LCA_SNAPSHOT_CONTRACT_AUTH_URL',
  'LCA_SNAPSHOT_CONTRACT_DB_URL',
]) {
  const hostname = new URL(process.env[name]).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) {
    throw new Error(`${name} must target a loopback-only qualification stack`);
  }
}

const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lca-snapshot-contract-'));
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
      'test/lca_snapshot_contract_cleanup_test.ts',
      'test/lca_snapshot_capability_db_contract_test.ts',
    ],
    {
      env: {
        ...process.env,
        LCA_SNAPSHOT_DB_CONTRACT: '1',
        LCA_SNAPSHOT_CONTRACT_FIXTURE_ID:
          process.env.LCA_SNAPSHOT_CONTRACT_FIXTURE_ID ?? 'c2560000-0000-4000-8000-000000000001',
        LCA_SNAPSHOT_CONTRACT_CREATE_ID:
          process.env.LCA_SNAPSHOT_CONTRACT_CREATE_ID ?? 'c2560000-0000-4000-8000-000000000003',
        LCA_SNAPSHOT_CONTRACT_ACTOR_ID:
          process.env.LCA_SNAPSHOT_CONTRACT_ACTOR_ID ?? 'c2560000-0000-4000-8000-000000000004',
      },
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`LCA snapshot contract exited with status ${result.status ?? 'unknown'}`);
  }

  const junit = fs.readFileSync(junitPath, 'utf8');
  const suiteTags = [...junit.matchAll(/<testsuite\b[^>]*>/g)].map((match) => match[0]);
  if (suiteTags.length === 0) {
    throw new Error('LCA snapshot contract did not produce any JUnit suites');
  }
  const summary = suiteTags.reduce(
    (total, suiteTag) => {
      const attributes = Object.fromEntries(
        [...suiteTag.matchAll(/([a-z_]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
      );
      total.tests += Number(attributes.tests);
      total.ignored += Number(attributes.disabled);
      total.errors += Number(attributes.errors);
      total.failures += Number(attributes.failures);
      return total;
    },
    { tests: 0, ignored: 0, errors: 0, failures: 0 },
  );
  if (
    summary.tests !== 3 ||
    summary.ignored !== 0 ||
    summary.errors !== 0 ||
    summary.failures !== 0
  ) {
    throw new Error(`LCA snapshot contract execution mismatch: ${JSON.stringify(summary)}`);
  }
  console.log(
    'LCA snapshot contract summary: 3 passed, 0 failed, 0 ignored; DB/Auth residue independently read back as zero',
  );
} finally {
  fs.rmSync(reportDirectory, { recursive: true, force: true });
}
