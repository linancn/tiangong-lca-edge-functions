const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const mode = process.argv[2];
const allowedHosts = {
  local: '127.0.0.1,localhost',
  'hosted-preview': 'nlcyzijvoyufjoqgxlku.supabase.co,api.supabase.com,api.github.com',
};

if (!(mode in allowedHosts)) {
  console.error('Worker capability contract mode must be local or hosted-preview');
  process.exit(2);
}

const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-capability-contract-'));
const junitPath = path.join(reportDirectory, 'junit.xml');

try {
  const result = spawnSync(
    'deno',
    [
      'test',
      '--junit-path',
      junitPath,
      '--allow-env',
      `--allow-net=${allowedHosts[mode]}`,
      '--config',
      'supabase/functions/deno.json',
      'test/worker_capability_db_contract_test.ts',
    ],
    {
      env: {
        ...process.env,
        WORKER_CAPABILITY_DB_CONTRACT: '1',
        WORKER_CAPABILITY_CONTRACT_MODE: mode,
      },
      stdio: 'inherit',
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Worker capability contract exited with status ${result.status ?? 'unknown'}`);
  }

  const junit = fs.readFileSync(junitPath, 'utf8');
  const suiteTag = junit.match(/<testsuite\b[^>]*>/)?.[0];
  if (!suiteTag) {
    throw new Error('Worker capability contract did not produce a JUnit test suite');
  }
  const attributes = Object.fromEntries(
    [...suiteTag.matchAll(/([a-z_]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  );
  const summary = {
    tests: Number(attributes.tests),
    ignored: Number(attributes.disabled),
    errors: Number(attributes.errors),
    failures: Number(attributes.failures),
  };
  if (
    summary.tests !== 1 ||
    summary.ignored !== 0 ||
    summary.errors !== 0 ||
    summary.failures !== 0
  ) {
    throw new Error(
      `Worker capability contract execution count mismatch: ${JSON.stringify(summary)}`,
    );
  }

  console.log(`Worker capability contract summary: 1 passed, 0 failed, 0 ignored (${mode})`);
} finally {
  fs.rmSync(reportDirectory, { recursive: true, force: true });
}
