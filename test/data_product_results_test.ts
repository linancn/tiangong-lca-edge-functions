import { assertEquals } from 'jsr:@std/assert';

import {
  createDataProductResultsHandler,
  dataProductPublishedResultsRequestSchema,
} from '../supabase/functions/data_product_results/index.ts';

const TEST_PROCESS_ID = '11111111-1111-4111-8111-111111111111';

Deno.test('dataProductPublishedResultsRequestSchema rejects arbitrary package ids', () => {
  const parsed = dataProductPublishedResultsRequestSchema.safeParse({
    processId: TEST_PROCESS_ID,
    processVersion: '01.00.000',
    impactCategoryId: 'climate-change',
    packageId: '55555555-5555-4555-8555-555555555555',
  });

  assertEquals(parsed.success, false);
});

Deno.test('data_product_results handler accepts unauthenticated public reads', async () => {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const handler = createDataProductResultsHandler({
    supabase: {
      rpc: (fn: string, args: unknown) => {
        calls.push({ fn, args });
        return Promise.resolve({
          data: {
            ok: true,
            data: {
              rows: [{ processId: TEST_PROCESS_ID, impactCategoryId: 'climate-change' }],
              rowCount: 1,
            },
          },
          error: null,
        });
      },
    } as never,
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
      rows: [{ processId: TEST_PROCESS_ID, impactCategoryId: 'climate-change' }],
      rowCount: 1,
    },
  });
  assertEquals(calls, [
    {
      fn: 'get_published_process_lcia_results',
      args: {
        p_process_id: TEST_PROCESS_ID,
        p_process_version: '01.00.000',
        p_impact_category_id: 'climate-change',
      },
    },
  ]);
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
