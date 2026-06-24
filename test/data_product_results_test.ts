import { assertEquals } from 'jsr:@std/assert';

import {
  createDataProductResultsHandler,
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
