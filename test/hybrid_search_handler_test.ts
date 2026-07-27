import { assertEquals, assertFalse } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import {
  createHybridSearchHandler,
  type HybridSearchRouteConfig,
} from '../supabase/functions/_shared/hybrid_search_handler.ts';

const CONTACT_CONFIG: HybridSearchRouteConfig = {
  functionName: 'contact_hybrid_search',
  entityKind: 'contact',
  entityLabel: 'Contact',
  entityPlural: 'contacts',
  rpcName: 'hybrid_search_contacts',
};

const VECTOR = Array.from({ length: 1024 }, () => 0.001);

Deno.test(
  'shared Hybrid handler calls the configured RPC and performs one empty-threshold fallback',
  async () => {
    const rpcCalls: Array<{ name: string; body: Record<string, unknown> }> = [];
    const logCalls: unknown[] = [];
    let now = 100;
    const fakeClient = {
      rpc(name: string, body: Record<string, unknown>) {
        rpcCalls.push({ name, body: structuredClone(body) });
        return Promise.resolve(
          rpcCalls.length === 1
            ? { data: [], error: null }
            : { data: [{ id: 'contact-1' }], error: null },
        );
      },
    };
    const handler = createHybridSearchHandler(CONTACT_CONFIG, {
      authenticate: async () => ({ isAuthenticated: true }),
      rewriteQuery: async () => ({
        semantic_query_en: 'aluminium association',
        fulltext_query_en: ['aluminium association'],
        fulltext_query_zh: ['铝业协会'],
      }),
      generateEmbedding: async () => VECTOR,
      createRpcClient: () => ({
        client: fakeClient as unknown as SupabaseClient,
        userContextKind: 'jwt',
        bearerToken: 'header.payload.signature',
      }),
      now: () => ++now,
      logger: { log: (...args: unknown[]) => logCalls.push(args), error: () => undefined },
    });

    const response = await handler(
      new Request('http://localhost/contact_hybrid_search', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer header.payload.signature',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: 'private contact query', data_source: 'my' }),
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(await response.json(), { data: [{ id: 'contact-1' }] });
    assertEquals(
      rpcCalls.map((call) => call.name),
      ['hybrid_search_contacts', 'hybrid_search_contacts'],
    );
    assertEquals(
      rpcCalls.map((call) => call.body.match_threshold),
      [0.5, 0],
    );
    assertEquals(rpcCalls[0].body.data_source, 'my');
    assertFalse(JSON.stringify(logCalls).includes('private contact query'));
  },
);

Deno.test('shared Hybrid handler rejects invalid requests before model or RPC calls', async () => {
  let rewriteCalled = false;
  const handler = createHybridSearchHandler(CONTACT_CONFIG, {
    authenticate: async () => ({ isAuthenticated: true }),
    rewriteQuery: async () => {
      rewriteCalled = true;
      return { semantic_query_en: '', fulltext_query_en: [], fulltext_query_zh: [] };
    },
  });

  const response = await handler(
    new Request('http://localhost/contact_hybrid_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_size: 10 }),
    }),
  );

  assertEquals(response.status, 400);
  assertEquals(rewriteCalled, false);
});

Deno.test('shared Hybrid handler fails closed on a non-1024 embedding', async () => {
  const handler = createHybridSearchHandler(CONTACT_CONFIG, {
    authenticate: async () => ({ isAuthenticated: true }),
    rewriteQuery: async () => ({
      semantic_query_en: 'contact',
      fulltext_query_en: ['contact'],
      fulltext_query_zh: ['联系人'],
    }),
    generateEmbedding: async () => [0.1, 0.2],
    logger: { log: () => undefined, error: () => undefined },
  });

  const response = await handler(
    new Request('http://localhost/contact_hybrid_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'contact' }),
    }),
  );

  assertEquals(response.status, 500);
  assertEquals(await response.json(), {
    error: 'Hybrid search failed',
    code: 'EMBEDDING_DIMENSION_MISMATCH',
  });
});
