import { assert, assertEquals, assertMatch } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import { type AuthResult, AuthMethod } from '../supabase/functions/_shared/auth.ts';
import { createImportTidasPackageHandler } from '../supabase/functions/import_tidas_package/handler.ts';
import { createTidasPackageJobsHandler } from '../supabase/functions/tidas_package_jobs/handler.ts';

type JsonRecord = Record<string, unknown>;
type Filter = {
  field: string;
  value: unknown;
  op: 'eq' | 'in';
};
type TableName = 'lca_package_artifacts' | 'lca_package_jobs' | 'lca_package_request_cache';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_JWT = 'header.payload.signature';
const EMPTY_ZIP_BYTES = Uint8Array.from([
  0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

class FakeSupabase {
  tables: Record<TableName, JsonRecord[]> = {
    lca_package_jobs: [],
    lca_package_artifacts: [],
    lca_package_request_cache: [],
  };
  rpcCalls: Array<{ fn: string; args: unknown }> = [];
  signedUploadCalls: Array<{ bucket: string; objectPath: string }> = [];
  signedDownloadCalls: Array<{ bucket: string; objectPath: string; expiresIn: number }> = [];

  from(table: TableName): FakeQueryBuilder {
    return new FakeQueryBuilder(this, table);
  }

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({ fn, args: structuredClone(args) });
    return Promise.resolve({ data: null, error: null });
  }

  storage = {
    from: (bucket: string) => ({
      createSignedUploadUrl: async (objectPath: string) => {
        this.signedUploadCalls.push({ bucket, objectPath });
        return {
          data: {
            path: objectPath,
            token: `upload-token:${objectPath}`,
            signedUrl: `https://upload.example/${bucket}/${encodePath(objectPath)}`,
          },
          error: null,
        };
      },
      createSignedUrl: async (objectPath: string, expiresIn: number) => {
        this.signedDownloadCalls.push({ bucket, objectPath, expiresIn });
        return {
          data: {
            signedUrl: `https://download.example/${bucket}/${encodePath(objectPath)}?expires=${expiresIn}`,
          },
          error: null,
        };
      },
    }),
  };

  getRows(table: TableName): JsonRecord[] {
    return this.tables[table].map((row) => structuredClone(row));
  }

  insert(table: TableName, payload: JsonRecord | JsonRecord[]) {
    const rows = Array.isArray(payload) ? payload : [payload];
    for (const row of rows) {
      if (this.isDuplicate(table, row)) {
        return Promise.resolve({
          data: null,
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        });
      }
    }

    this.tables[table].push(...rows.map((row) => structuredClone(row)));
    return Promise.resolve({ data: null, error: null });
  }

  executeSelect(query: FakeQueryBuilder) {
    let rows = this.filterRows(query.table, query.filters);

    if (query.orderField) {
      rows = rows.slice().sort((left, right) => {
        const leftValue = normalizeSortValue(left[query.orderField!]);
        const rightValue = normalizeSortValue(right[query.orderField!]);
        if (leftValue < rightValue) {
          return query.orderAscending ? -1 : 1;
        }
        if (leftValue > rightValue) {
          return query.orderAscending ? 1 : -1;
        }
        return 0;
      });
    }

    if (query.limitCount !== null) {
      rows = rows.slice(0, query.limitCount);
    }

    return { data: rows.map((row) => structuredClone(row)), error: null };
  }

  executeMaybeSingle(query: FakeQueryBuilder) {
    const { data, error } = this.executeSelect(query);
    return Promise.resolve({
      data: data[0] ?? null,
      error,
    });
  }

  executeUpdate(query: FakeQueryBuilder) {
    const rows = this.filterRows(query.table, query.filters);
    for (const row of rows) {
      Object.assign(row, structuredClone(query.updateValues));
    }
    return { data: null, error: null };
  }

  private filterRows(table: TableName, filters: Filter[]): JsonRecord[] {
    return this.tables[table].filter((row) =>
      filters.every((filter) => {
        const actual = row[filter.field];
        if (filter.op === 'eq') {
          return actual === filter.value;
        }

        return Array.isArray(filter.value) && filter.value.includes(actual);
      }),
    );
  }

  private isDuplicate(table: TableName, row: JsonRecord): boolean {
    return this.tables[table].some((existing) => {
      if (existing.id === row.id) {
        return true;
      }

      if (table !== 'lca_package_jobs') {
        return false;
      }

      return (
        existing.requested_by === row.requested_by &&
        existing.idempotency_key !== null &&
        existing.idempotency_key !== undefined &&
        existing.idempotency_key === row.idempotency_key
      );
    });
  }
}

class FakeQueryBuilder implements PromiseLike<{ data: unknown; error: unknown }> {
  filters: Filter[] = [];
  orderField: string | null = null;
  orderAscending = true;
  limitCount: number | null = null;
  updateValues: JsonRecord = {};
  private mode: 'select' | 'update' | null = null;

  constructor(
    private readonly supabase: FakeSupabase,
    readonly table: TableName,
  ) {}

  select(_columns: string): this {
    this.mode = 'select';
    return this;
  }

  insert(payload: JsonRecord | JsonRecord[]) {
    return this.supabase.insert(this.table, payload);
  }

  update(values: JsonRecord): this {
    this.mode = 'update';
    this.updateValues = values;
    return this;
  }

  eq(field: string, value: unknown): this {
    this.filters.push({ field, value, op: 'eq' });
    return this;
  }

  in(field: string, value: unknown[]): this {
    this.filters.push({ field, value, op: 'in' });
    return this;
  }

  order(field: string, options?: { ascending?: boolean }): this {
    this.orderField = field;
    this.orderAscending = options?.ascending ?? true;
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  maybeSingle() {
    return this.supabase.executeMaybeSingle(this);
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const result =
      this.mode === 'update'
        ? Promise.resolve(this.supabase.executeUpdate(this))
        : Promise.resolve(this.supabase.executeSelect(this));

    return result.then(onfulfilled ?? undefined, onrejected ?? undefined);
  }
}

function encodePath(objectPath: string): string {
  return objectPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function normalizeSortValue(value: unknown): string | number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function createAuthResult(userId = TEST_USER_ID): AuthResult {
  return {
    isAuthenticated: true,
    user: { id: userId } as AuthResult['user'],
  };
}

function withPackageStorageEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = {
    S3_ENDPOINT: Deno.env.get('S3_ENDPOINT'),
    S3_BUCKET: Deno.env.get('S3_BUCKET'),
    S3_PREFIX: Deno.env.get('S3_PREFIX'),
  };

  Deno.env.set('S3_ENDPOINT', 'https://example.storage.supabase.co/storage/v1/s3');
  Deno.env.set('S3_BUCKET', 'lca_results');
  Deno.env.set('S3_PREFIX', 'lca-results');

  return fn().finally(() => {
    restoreEnvVar('S3_ENDPOINT', previous.S3_ENDPOINT);
    restoreEnvVar('S3_BUCKET', previous.S3_BUCKET);
    restoreEnvVar('S3_PREFIX', previous.S3_PREFIX);
  });
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
    return;
  }

  Deno.env.set(name, value);
}

Deno.test('import_tidas_package API completes prepare, enqueue, and job lookup flow', async () => {
  await withPackageStorageEnv(async () => {
    const supabase = new FakeSupabase();
    const importAuthCalls: AuthMethod[][] = [];
    const jobsAuthCalls: AuthMethod[][] = [];
    let importRedisCalls = 0;
    let jobsRedisCalls = 0;

    const importHandler = createImportTidasPackageHandler({
      supabase: supabase as unknown as SupabaseClient,
      authenticateRequest: async (_req, config) => {
        importAuthCalls.push([...config.allowedMethods]);
        return createAuthResult();
      },
      getRedisClient: async () => {
        importRedisCalls += 1;
        return undefined;
      },
    });

    const jobsHandler = createTidasPackageJobsHandler({
      supabase: supabase as unknown as SupabaseClient,
      authenticateRequest: async (_req, config) => {
        jobsAuthCalls.push([...config.allowedMethods]);
        return createAuthResult();
      },
      getRedisClient: async () => {
        jobsRedisCalls += 1;
        return undefined;
      },
    });

    const prepareRequest = new Request('https://example.com/functions/v1/import_tidas_package', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_JWT}`,
        'Content-Type': 'application/json',
        'x-idempotency-key': 'demo-package',
      },
      body: JSON.stringify({
        action: 'prepare_upload',
        filename: 'fixtures/Demo Package.zip',
        byte_size: EMPTY_ZIP_BYTES.byteLength,
        content_type: 'application/zip',
      }),
    });

    const prepareResponse = await importHandler(prepareRequest);
    assertEquals(prepareResponse.status, 200);
    const prepared = await prepareResponse.json();

    assertEquals(prepared.ok, true);
    assertEquals(prepared.action, 'prepare_upload');
    assertMatch(
      prepared.job_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assertMatch(
      prepared.source_artifact_id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    assertEquals(prepared.upload.bucket, 'lca_results');
    assertEquals(
      prepared.upload.object_path,
      `lca-results/packages/jobs/${prepared.job_id}/import-source.zip`,
    );
    assertEquals(prepared.upload.filename, 'Demo_Package.zip');
    assertEquals(prepared.upload.byte_size, EMPTY_ZIP_BYTES.byteLength);
    assertEquals(prepared.upload.content_type, 'application/zip');
    assertEquals(importRedisCalls, 0);
    assertEquals(importAuthCalls, [[AuthMethod.JWT]]);
    assertEquals(supabase.getRows('lca_package_jobs').length, 1);
    assertEquals(supabase.getRows('lca_package_artifacts').length, 1);

    const repeatedPrepareResponse = await importHandler(
      new Request('https://example.com/functions/v1/import_tidas_package', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
          'Content-Type': 'application/json',
          'x-idempotency-key': 'demo-package',
        },
        body: JSON.stringify({
          action: 'prepare_upload',
          filename: 'fixtures/Demo Package.zip',
          byte_size: EMPTY_ZIP_BYTES.byteLength,
          content_type: 'application/zip',
        }),
      }),
    );
    const repeatedPrepared = await repeatedPrepareResponse.json();

    assertEquals(repeatedPrepareResponse.status, 200);
    assertEquals(repeatedPrepared.job_id, prepared.job_id);
    assertEquals(repeatedPrepared.source_artifact_id, prepared.source_artifact_id);
    assertEquals(supabase.getRows('lca_package_jobs').length, 1);
    assertEquals(supabase.getRows('lca_package_artifacts').length, 1);

    const artifactSha256 = await sha256Hex(EMPTY_ZIP_BYTES);
    const enqueueBody = {
      action: 'enqueue',
      job_id: prepared.job_id,
      source_artifact_id: prepared.source_artifact_id,
      artifact_sha256: artifactSha256,
      artifact_byte_size: EMPTY_ZIP_BYTES.byteLength,
      filename: './uploads/Demo Package.zip',
      content_type: 'application/zip',
    };

    const enqueueResponse = await importHandler(
      new Request('https://example.com/functions/v1/import_tidas_package', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(enqueueBody),
      }),
    );
    assertEquals(enqueueResponse.status, 202);
    assertEquals(await enqueueResponse.json(), {
      ok: true,
      mode: 'queued',
      job_id: prepared.job_id,
      source_artifact_id: prepared.source_artifact_id,
    });

    const artifactRow = supabase.getRows('lca_package_artifacts')[0];
    assertEquals(artifactRow.status, 'ready');
    assertEquals(artifactRow.artifact_sha256, artifactSha256);
    assertEquals(artifactRow.artifact_byte_size, EMPTY_ZIP_BYTES.byteLength);
    assertEquals(artifactRow.content_type, 'application/zip');
    assertEquals((artifactRow.metadata as JsonRecord).upload_state, 'uploaded');
    assertEquals((artifactRow.metadata as JsonRecord).filename, 'Demo_Package.zip');

    const jobRow = supabase.getRows('lca_package_jobs')[0];
    assertEquals(jobRow.status, 'queued');
    assertEquals(jobRow.request_key, artifactSha256);
    assertEquals((jobRow.diagnostics as JsonRecord).phase, 'enqueue_import');
    assertEquals(supabase.rpcCalls.length, 1);
    assertEquals(supabase.rpcCalls[0].fn, 'lca_package_enqueue_job');

    const repeatedEnqueueResponse = await importHandler(
      new Request('https://example.com/functions/v1/import_tidas_package', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(enqueueBody),
      }),
    );

    assertEquals(repeatedEnqueueResponse.status, 200);
    assertEquals(await repeatedEnqueueResponse.json(), {
      ok: true,
      mode: 'in_progress',
      job_id: prepared.job_id,
      source_artifact_id: prepared.source_artifact_id,
    });
    assertEquals(supabase.rpcCalls.length, 1);

    const lookupResponse = await jobsHandler(
      new Request(`https://example.com/functions/v1/tidas_package_jobs/${prepared.job_id}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
        },
      }),
    );
    assertEquals(lookupResponse.status, 200);

    const jobLookup = await lookupResponse.json();
    assertEquals(jobLookup.ok, true);
    assertEquals(jobLookup.job_id, prepared.job_id);
    assertEquals(jobLookup.job_type, 'import_package');
    assertEquals(jobLookup.status, 'queued');
    assertEquals(jobLookup.request_key, artifactSha256);
    assertEquals(jobLookup.request_cache, null);
    assertEquals(jobLookup.diagnostics_summary.stage, 'enqueue_import');
    assertEquals(jobLookup.diagnostics_summary.source, 'none');
    assertEquals(jobLookup.artifacts.length, 1);
    assertEquals(
      jobLookup.artifacts_by_kind.import_source.artifact_id,
      prepared.source_artifact_id,
    );
    assertEquals(jobLookup.artifacts_by_kind.import_source.status, 'ready');
    assertEquals(
      jobLookup.artifacts_by_kind.import_source.storage_object_path,
      `lca-results/packages/jobs/${prepared.job_id}/import-source.zip`,
    );
    assertEquals(
      jobLookup.artifacts_by_kind.import_source.signed_download_url,
      `https://download.example/lca_results/lca-results/packages/jobs/${prepared.job_id}/import-source.zip?expires=3600`,
    );
    assertEquals(jobsRedisCalls, 1);
    assertEquals(jobsAuthCalls, [[AuthMethod.JWT, AuthMethod.USER_API_KEY]]);
  });
});

Deno.test('import_tidas_package handler only resolves Redis for opaque bearer tokens', async () => {
  await withPackageStorageEnv(async () => {
    const supabase = new FakeSupabase();
    const authCalls: AuthMethod[][] = [];
    let redisCalls = 0;

    const handler = createImportTidasPackageHandler({
      supabase: supabase as unknown as SupabaseClient,
      authenticateRequest: async (_req, config) => {
        authCalls.push([...config.allowedMethods]);
        return {
          isAuthenticated: false,
          response: new Response('Unauthorized', { status: 401 }),
        };
      },
      getRedisClient: async () => {
        redisCalls += 1;
        return undefined;
      },
    });

    const jwtResponse = await handler(
      new Request('https://example.com/functions/v1/import_tidas_package', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_JWT}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    );
    assertEquals(jwtResponse.status, 401);

    const apiKeyResponse = await handler(
      new Request('https://example.com/functions/v1/import_tidas_package', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer opaque-user-api-key',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    );
    assertEquals(apiKeyResponse.status, 401);

    assertEquals(redisCalls, 1);
    assertEquals(authCalls, [[AuthMethod.JWT], [AuthMethod.USER_API_KEY, AuthMethod.JWT]]);
    assertEquals(supabase.getRows('lca_package_jobs').length, 0);
  });
});

Deno.test('tidas_package_jobs rejects missing job identifiers', async () => {
  const handler = createTidasPackageJobsHandler({
    supabase: new FakeSupabase() as unknown as SupabaseClient,
    authenticateRequest: async () => createAuthResult(),
    getRedisClient: async () => undefined,
  });

  const response = await handler(
    new Request('https://example.com/functions/v1/tidas_package_jobs', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TEST_JWT}`,
      },
    }),
  );

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    ok: false,
    code: 'MISSING_JOB_ID',
    message: 'A package job id is required',
  });
  assert(response.headers.get('content-type')?.includes('application/json'));
});
