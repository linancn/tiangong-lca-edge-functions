import { assertEquals } from 'jsr:@std/assert';
import {
  buildImportSourceObjectPath,
  buildStorageObjectUrl,
  normalizeExportRequestBody,
  normalizeVersionString,
  parseStoragePathFromArtifactUrl,
  resolveExportCacheAction,
} from './tidas_package.ts';

Deno.test('normalizeVersionString pads dotted numeric versions', () => {
  assertEquals(normalizeVersionString('1.1.0'), '01.01.000');
  assertEquals(normalizeVersionString('01.01.000'), '01.01.000');
  assertEquals(normalizeVersionString('1.12.3'), '01.12.003');
  assertEquals(normalizeVersionString('draft'), 'draft');
});

Deno.test('normalizeExportRequestBody defaults to current_user and normalizes roots', () => {
  const normalized = normalizeExportRequestBody({
    roots: [
      {
        table: 'processes',
        id: '11111111-1111-4111-8111-111111111111',
        version: '1.0.0',
      },
      {
        table: 'processes',
        id: '11111111-1111-4111-8111-111111111111',
        version: '01.00.000',
      },
    ],
  });

  assertEquals(normalized.scope, 'selected_roots');
  assertEquals(normalized.roots, [
    {
      table: 'processes',
      id: '11111111-1111-4111-8111-111111111111',
      version: '01.00.000',
    },
  ]);
  assertEquals(normalized.request_payload.scope, 'selected_roots');
});

Deno.test('buildImportSourceObjectPath uses package job folder layout', () => {
  assertEquals(
    buildImportSourceObjectPath('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    'lca-results/packages/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/import-source.zip',
  );
});

Deno.test(
  'buildStorageObjectUrl and parseStoragePathFromArtifactUrl round-trip package artifact urls',
  () => {
    Deno.env.set('S3_ENDPOINT', 'https://example.storage.supabase.co/storage/v1/s3');
    const artifactUrl = buildStorageObjectUrl(
      'lca_results',
      'lca-results/packages/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/export-package.zip',
    );

    assertEquals(artifactUrl.includes('/storage/v1/s3/lca_results/'), true);
    assertEquals(parseStoragePathFromArtifactUrl(artifactUrl), {
      bucket: 'lca_results',
      objectPath:
        'lca-results/packages/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/export-package.zip',
    });
  },
);

Deno.test('resolveExportCacheAction returns in_progress for active export jobs', () => {
  const cacheRow = {
    id: 'cache-1',
    status: 'pending',
    job_id: 'job-1',
    export_artifact_id: null,
    report_artifact_id: null,
    hit_count: 2,
  };

  assertEquals(
    resolveExportCacheAction(cacheRow, {
      status: 'queued',
    }),
    'in_progress',
  );
  assertEquals(
    resolveExportCacheAction(cacheRow, {
      status: 'running',
    }),
    'in_progress',
  );
});

Deno.test(
  'resolveExportCacheAction retries completed export jobs so a fresh package is built',
  () => {
    const cacheRow = {
      id: 'cache-2',
      status: 'ready',
      job_id: 'job-2',
      export_artifact_id: 'artifact-1',
      report_artifact_id: 'artifact-2',
      hit_count: 1,
    };

    assertEquals(
      resolveExportCacheAction(cacheRow, {
        status: 'ready',
      }),
      'retry',
    );
    assertEquals(
      resolveExportCacheAction(cacheRow, {
        status: 'completed',
      }),
      'retry',
    );
  },
);

Deno.test('resolveExportCacheAction retries stale, failed, or orphaned cache rows', () => {
  const cacheRow = {
    id: 'cache-3',
    status: 'pending',
    job_id: 'job-3',
    export_artifact_id: null,
    report_artifact_id: null,
    hit_count: 4,
  };

  assertEquals(
    resolveExportCacheAction(cacheRow, {
      status: 'failed',
    }),
    'retry',
  );
  assertEquals(
    resolveExportCacheAction(cacheRow, {
      status: 'stale',
    }),
    'retry',
  );
  assertEquals(resolveExportCacheAction(cacheRow, null), 'retry');
  assertEquals(
    resolveExportCacheAction(
      {
        ...cacheRow,
        job_id: null,
      },
      {
        status: 'running',
      },
    ),
    'retry',
  );
});
