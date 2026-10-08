import { assertEquals } from 'jsr:@std/assert';

import {
  createDataProductResultsHandler,
  createPublishedResultsRepository,
  dataProductPublishedResultsRequestSchema,
  impactCategoryIdsForRequest,
} from '../supabase/functions/data_product_results/index.ts';

const TEST_PROCESS_ID = '11111111-1111-4111-8111-111111111111';
const TEST_PROCESS_B_ID = '22222222-2222-4222-8222-222222222222';

Deno.test('dataProductPublishedResultsRequestSchema rejects arbitrary package ids', () => {
  const parsed = dataProductPublishedResultsRequestSchema.safeParse({
    processId: TEST_PROCESS_ID,
    processVersion: '01.00.000',
    impactCategoryId: 'climate-change',
    packageId: '55555555-5555-4555-8555-555555555555',
  });

  assertEquals(parsed.success, false);
});

Deno.test('data_product_results skips impact metadata fanout for all-impact process reads', () => {
  const impactCategoryIds = impactCategoryIdsForRequest(
    {
      mode: 'process_all_impacts',
      processId: TEST_PROCESS_ID,
      processVersion: '01.00.000',
    },
    {
      version: 1,
      snapshot_id: '33333333-3333-4333-8333-333333333333',
      process_count: 1,
      impact_count: 2,
      process_map: [],
      impact_map: [
        {
          impact_id: 'climate-change',
          impact_index: 0,
          impact_name: 'Climate change',
          unit: 'kg CO2 eq',
        },
        {
          impact_id: 'acidification',
          impact_index: 1,
          impact_name: 'Acidification',
          unit: 'mol H+ eq',
        },
      ],
    },
  );

  assertEquals(impactCategoryIds, []);
});

Deno.test('data_product_results handler accepts unauthenticated public reads', async () => {
  const calls: unknown[] = [];
  const handler = createDataProductResultsHandler({
    repository: {
      queryCurrentPublicResults: (request: unknown) => {
        calls.push(request);
        return Promise.resolve({
          ok: true,
          data: {
            publication: { publicationId: 'publication-1' },
            package: { packageId: 'package-1' },
            process: { processId: TEST_PROCESS_ID, processVersion: '01.00.000' },
            values: [{ impact_id: 'climate-change', value: 42 }],
            rowCount: 1,
          },
        });
      },
    },
  });

  const response = await handler(
    new Request('http://localhost/functions/v1/data_product_results', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        processId: TEST_PROCESS_ID,
        processVersion: '01.00.000',
        impactCategoryId: 'climate-change',
      }),
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    ok: true,
    data: {
      publication: { publicationId: 'publication-1' },
      package: { packageId: 'package-1' },
      process: { processId: TEST_PROCESS_ID, processVersion: '01.00.000' },
      values: [{ impact_id: 'climate-change', value: 42 }],
      rowCount: 1,
    },
  });
  assertEquals(calls, [
    {
      mode: 'process_all_impacts',
      processId: TEST_PROCESS_ID,
      processVersion: '01.00.000',
      impactCategoryId: 'climate-change',
    },
  ]);
});

Deno.test(
  'data_product_results handler accepts current-public selected process impact reads',
  async () => {
    const calls: unknown[] = [];
    const handler = createDataProductResultsHandler({
      repository: {
        queryCurrentPublicResults: (request: unknown) => {
          calls.push(request);
          return Promise.resolve({
            ok: true,
            data: {
              mode: 'processes_one_impact',
              impactCategoryId: 'climate-change',
              values: {
                [TEST_PROCESS_ID]: 42,
                [TEST_PROCESS_B_ID]: -3,
              },
              rowCount: 2,
            },
          });
        },
      },
    });

    const response = await handler(
      new Request('http://localhost/functions/v1/data_product_results', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'processes_one_impact',
          impactCategoryId: 'climate-change',
          processes: [
            { id: TEST_PROCESS_ID, version: '01.00.000' },
            { id: TEST_PROCESS_B_ID, version: '01.00.000' },
          ],
        }),
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(await response.json(), {
      ok: true,
      data: {
        mode: 'processes_one_impact',
        impactCategoryId: 'climate-change',
        values: {
          [TEST_PROCESS_ID]: 42,
          [TEST_PROCESS_B_ID]: -3,
        },
        rowCount: 2,
      },
    });
    assertEquals(calls, [
      {
        mode: 'processes_one_impact',
        impactCategoryId: 'climate-change',
        processes: [
          { id: TEST_PROCESS_ID, version: '01.00.000' },
          { id: TEST_PROCESS_B_ID, version: '01.00.000' },
        ],
      },
    ]);
  },
);

Deno.test('data_product_results handler accepts current-public hotspot ranking reads', async () => {
  const calls: unknown[] = [];
  const handler = createDataProductResultsHandler({
    repository: {
      queryCurrentPublicResults: (request: unknown) => {
        calls.push(request);
        return Promise.resolve({
          ok: true,
          data: {
            kind: 'ranked_processes',
            impact_id: 'climate-change',
            offset: 10,
            limit: 5,
            total_process_count: 20,
            total_absolute_value: 100,
            values: [
              {
                process_id: TEST_PROCESS_ID,
                process_version: '01.00.000',
                process_index: 0,
                value: 42,
                absolute_value: 42,
              },
            ],
          },
        });
      },
    },
  });

  const response = await handler(
    new Request('http://localhost/functions/v1/data_product_results', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'ranked_processes_one_impact',
        impactCategoryId: 'climate-change',
        offset: 10,
        limit: 5,
      }),
    }),
  );

  assertEquals(response.status, 200);
  assertEquals(calls, [
    {
      mode: 'ranked_processes_one_impact',
      impactCategoryId: 'climate-change',
      offset: 10,
      limit: 5,
    },
  ]);
  assertEquals((await response.json()).data.kind, 'ranked_processes');
});

Deno.test('data_product_results handler rejects GET requests with package ids', async () => {
  const handler = createDataProductResultsHandler({
    supabase: {
      rpc: () => Promise.reject(new Error('not used')),
    } as never,
  });

  const response = await handler(
    new Request(
      `http://localhost/functions/v1/data_product_results?processId=${TEST_PROCESS_ID}&processVersion=01.00.000&packageId=55555555-5555-4555-8555-555555555555`,
      { method: 'GET' },
    ),
  );

  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, 'INVALID_PAYLOAD');
});

Deno.test(
  'data_product_results admits exact batches and preserves versioned availability rows',
  async () => {
    const request = {
      mode: 'processes_one_impact_exact',
      impactCategoryId: '6209b35f-9447-40b5-b68c-a1099e3674a0',
      processes: [
        { id: TEST_PROCESS_ID, version: '01.00.000' },
        { id: TEST_PROCESS_ID, version: '01.00.001' },
      ],
    };
    let received: unknown;
    const data = {
      ...request,
      values: [
        { ...request.processes[0], status: 'available', value: 0, unit: 'kg CO2 Equivalents' },
        { ...request.processes[1], status: 'missing', value: null, unit: '' },
      ],
      rowCount: 2,
    };
    const handler = createDataProductResultsHandler({
      repository: {
        queryCurrentPublicResults: (body) => {
          received = body;
          return Promise.resolve({ ok: true, data });
        },
      },
    });
    const response = await handler(
      new Request('http://localhost', { method: 'POST', body: JSON.stringify(request) }),
    );
    assertEquals(response.status, 200);
    assertEquals(received, request);
    assertEquals((await response.json()).data, data);
  },
);
Deno.test(
  'data_product_results rejects empty, duplicate, excessive and malformed exact selections before lookup',
  async () => {
    let calls = 0;
    const handler = createDataProductResultsHandler({
      repository: {
        queryCurrentPublicResults: () => {
          calls++;
          return Promise.resolve({ ok: true, data: {} });
        },
      },
    });
    const base = {
      mode: 'processes_one_impact_exact',
      impactCategoryId: '6209b35f-9447-40b5-b68c-a1099e3674a0',
      processes: [{ id: TEST_PROCESS_ID, version: '01.00.000' }],
    };
    for (const request of [
      { ...base, processes: [] },
      { ...base, processes: [base.processes[0], base.processes[0]] },
      {
        ...base,
        processes: Array.from({ length: 101 }, (_, i) => ({
          id: TEST_PROCESS_ID,
          version: `01.00.${String(i).padStart(3, '0')}`,
        })),
      },
      { ...base, impactCategoryId: 'Climate change' },
      { ...base, processes: [{ id: TEST_PROCESS_ID, version: 'latest' }] },
      { ...base, unexpected: true },
    ]) {
      const response = await handler(
        new Request('http://localhost', { method: 'POST', body: JSON.stringify(request) }),
      );
      assertEquals(response.status, 400);
    }
    assertEquals(calls, 0);
  },
);

Deno.test(
  'exact public batch production repository resolves a single current publication and artifact pair',
  async () => {
    let currentReads = 0;
    const impactId = '6209b35f-9447-40b5-b68c-a1099e3674a0';
    const snapshotId = '44444444-4444-4444-8444-444444444444';
    const index = {
      version: 1,
      snapshot_id: snapshotId,
      process_count: 2,
      impact_count: 1,
      process_map: [
        { process_id: TEST_PROCESS_ID, process_version: '01.00.000', process_index: 0 },
        { process_id: TEST_PROCESS_ID, process_version: '01.00.001', process_index: 1 },
      ],
      impact_map: [
        {
          impact_id: impactId,
          impact_index: 0,
          impact_name: 'Climate change',
          unit: 'kg CO2 Equivalents',
        },
      ],
    };
    const query = {
      version: 1,
      format: 'all-unit-query:v1',
      snapshot_id: snapshotId,
      process_count: 2,
      impact_count: 1,
      h_matrix: [[0], [-1.25]],
    };
    const artifactReads: string[] = [];
    const repository = createPublishedResultsRepository(
      {
        rpc: (name: string) => {
          assertEquals(name, 'svc_data_product_current_public_package');
          currentReads++;
          return Promise.resolve({
            error: null,
            data: {
              ok: true,
              data: {
                publication: { id: 'publication-a', package_id: 'package-a' },
                package: {
                  id: 'package-a',
                  snapshot_id: snapshotId,
                  query_artifact_ref: { artifactUrl: 'query-artifact' },
                },
              },
            },
          });
        },
      } as never,
      {
        fetchSnapshotArtifactUrl: (id: string) => {
          assertEquals(id, snapshotId);
          return Promise.resolve({
            ok: true,
            data: { artifactUrl: 'https://example.invalid/snapshot.npz' },
          });
        },
        fetchJsonArtifact: (url: string) => {
          artifactReads.push(url);
          return Promise.resolve({ ok: true, data: url === 'query-artifact' ? query : index });
        },
        fetchPreviewMetadata: () =>
          Promise.resolve({ ok: true, data: { processes: [], impacts: [] } }),
      } as never,
    );
    const request = {
      mode: 'processes_one_impact_exact' as const,
      impactCategoryId: impactId,
      processes: [
        { id: TEST_PROCESS_ID, version: '01.00.000' },
        { id: TEST_PROCESS_ID, version: '01.00.001' },
      ],
    };
    const result = await repository.queryCurrentPublicResults(request);
    assertEquals(result.ok, true);
    if (result.ok) {
      const data = result.data as { values: Array<{ value: number; version: string }> };
      assertEquals(
        data.values.map((row) => [row.version, row.value]),
        [
          ['01.00.000', 0],
          ['01.00.001', -1.25],
        ],
      );
    }
    assertEquals(currentReads, 1);
    assertEquals(artifactReads.length, 2);
    query.snapshot_id = 'wrong';
    const failure = await repository.queryCurrentPublicResults(request);
    assertEquals(failure.ok, false);
    if (!failure.ok) {
      assertEquals(failure.code, 'published_lcia_projection_invalid');
      assertEquals(failure.status, 502);
    }
  },
);
