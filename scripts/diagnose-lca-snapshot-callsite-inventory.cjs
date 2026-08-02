#!/usr/bin/env node

const fs = require('node:fs');

// This is a deliberately small ownership/inventory diagnostic. It does not parse or infer
// TypeScript and is not evidence that every dynamic or runtime consumer has been found.
const EXPECTED_CALL_SITES = Object.freeze({
  'supabase/functions/lca_solve/index.ts': [
    'capabilities/lca_snapshot_family.ts',
    'snapshotRepository: lcaSnapshotRepository',
    'dependencies.snapshotRepository',
  ],
  'supabase/functions/lca_query_results/index.ts': [
    'capabilities/lca_snapshot_family.ts',
    'snapshotRepository: lcaSnapshotRepository',
    'dependencies.snapshotRepository',
  ],
  'supabase/functions/lca_contribution_path/index.ts': [
    'capabilities/lca_snapshot_family.ts',
    'snapshotRepository: lcaSnapshotRepository',
    'dependencies.snapshotRepository',
  ],
  'supabase/functions/_shared/lca_snapshot_build_queue.ts': [
    'capabilities/lca_snapshot_family.ts',
    'snapshotRepository.createDraft(',
  ],
  'supabase/functions/_shared/lca_snapshot_scope_db.ts': [
    'capabilities/lca_snapshot_family.ts',
    'snapshotRepository.readScope(',
  ],
  'supabase/functions/_shared/commands/data_product/repository.ts': [
    'capabilities/lca_snapshot_family.ts',
    'snapshotRepository.readArtifact(',
  ],
});

const failures = [];
for (const [file, markers] of Object.entries(EXPECTED_CALL_SITES)) {
  if (!fs.existsSync(file)) {
    failures.push(`${file}: missing expected call-site owner`);
    continue;
  }
  const source = fs.readFileSync(file, 'utf8');
  for (const marker of markers) {
    if (!source.includes(marker))
      failures.push(`${file}: missing marker ${JSON.stringify(marker)}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `LCA snapshot call-site inventory diagnostic passed: ${Object.keys(EXPECTED_CALL_SITES).length} explicit owners. This diagnostic is not consumer-zero or authorization evidence.\n`,
  );
}

module.exports = { EXPECTED_CALL_SITES };
