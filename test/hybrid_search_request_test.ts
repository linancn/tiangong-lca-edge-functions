import { assertEquals, assertInstanceOf, assertThrows } from 'jsr:@std/assert';

import {
  buildHybridSearchRpcRequest,
  HybridSearchRequestError,
  parseHybridSearchClientRequest,
} from '../supabase/functions/_shared/hybrid_search_request.ts';

Deno.test('parseHybridSearchClientRequest normalizes full hybrid search options', () => {
  const parsed = parseHybridSearchClientRequest({
    query: '  electricity  ',
    filter: { flowType: 'Elementary flow' },
    data_source: 'my',
    page_size: '25',
    page_current: 3,
    match_threshold: '0.42',
    match_count: '50',
    full_text_weight: '0.4',
    extracted_text_weight: '0.1',
    semantic_weight: '0.7',
    rrf_k: '60',
  });

  assertEquals(parsed.queryText, 'electricity');
  assertEquals(parsed.rpcOptions, {
    filter_condition: '{"flowType":"Elementary flow"}',
    match_threshold: 0.42,
    match_count: 50,
    full_text_weight: 0.4,
    extracted_text_weight: 0.1,
    semantic_weight: 0.7,
    rrf_k: 60,
    data_source: 'my',
    page_size: 25,
    page_current: 3,
  });
});

Deno.test('parseHybridSearchClientRequest accepts explicit filter_condition string', () => {
  const parsed = parseHybridSearchClientRequest({
    query: 'steel',
    filter_condition: '{"classification":["materials"]}',
  });

  assertEquals(parsed.rpcOptions.filter_condition, '{"classification":["materials"]}');
  assertEquals(parsed.rpcOptions.data_source, 'tg');
  assertEquals(parsed.rpcOptions.page_size, 10);
  assertEquals(parsed.rpcOptions.page_current, 1);
});

Deno.test('parseHybridSearchClientRequest rejects invalid filter_condition JSON', () => {
  const error = assertThrows(
    () =>
      parseHybridSearchClientRequest({
        query: 'steel',
        filter_condition: 'classification = materials',
      }),
    HybridSearchRequestError,
  );

  assertEquals(error.message, 'filter_condition must be a valid JSON object string');
});

Deno.test('parseHybridSearchClientRequest rejects unsupported data_source', () => {
  const error = assertThrows(
    () =>
      parseHybridSearchClientRequest({
        query: 'steel',
        data_source: 'public',
      }),
    HybridSearchRequestError,
  );

  assertEquals(error.message, 'data_source must be one of tg, co, my, or te');
});

Deno.test('parseHybridSearchClientRequest rejects non-positive pagination', () => {
  const error = assertThrows(
    () =>
      parseHybridSearchClientRequest({
        query: 'steel',
        page_size: 0,
      }),
    HybridSearchRequestError,
  );

  assertEquals(error.message, 'page_size must be a positive integer');
});

Deno.test('buildHybridSearchRpcRequest builds the database RPC payload', () => {
  const parsed = parseHybridSearchClientRequest({
    query: 'steel',
    filter: {},
    data_source: 'co',
  });

  const payload = buildHybridSearchRpcRequest('[steel]', '[0.1,0.2]', parsed.rpcOptions);

  assertEquals(payload, {
    query_text: '[steel]',
    query_embedding: '[0.1,0.2]',
    filter_condition: '{}',
    match_threshold: 0.5,
    match_count: 20,
    full_text_weight: 0.3,
    extracted_text_weight: 0.2,
    semantic_weight: 0.5,
    rrf_k: 10,
    data_source: 'co',
    page_size: 10,
    page_current: 1,
  });
});

Deno.test('HybridSearchRequestError keeps its concrete error type', () => {
  const error = assertThrows(() => parseHybridSearchClientRequest(null), HybridSearchRequestError);

  assertInstanceOf(error, HybridSearchRequestError);
});
