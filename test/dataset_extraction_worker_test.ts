import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import { processDatasetExtractionJobs } from '../supabase/functions/_shared/dataset_extraction_worker.ts';
import {
  generateFlowMarkdown,
  normalizeJsonOrdered,
} from '../supabase/functions/_shared/flow_extraction.ts';

type JsonRecord = Record<string, unknown>;
type Filter = { field: string; value: unknown };

const FLOW_JSON = {
  flowDataSet: {
    flowInformation: {
      dataSetInformation: {
        'common:UUID': '97000000-0000-0000-0000-000000000001',
        name: {
          baseName: [{ '@xml:lang': 'en', '#text': 'Test flow' }],
        },
      },
    },
    administrativeInformation: {
      publicationAndOwnership: {
        'common:dataSetVersion': '01.00.000',
      },
    },
  },
};

class FakeSupabase {
  flows: JsonRecord[] = [];
  claimedJobs: JsonRecord[] = [];
  rpcCalls: Array<{ fn: string; args: unknown }> = [];

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({ fn, args: structuredClone(args) });

    if (fn === 'cmd_dataset_extraction_claim') {
      return Promise.resolve({
        data: {
          ok: true,
          data: this.claimedJobs.map((job) => structuredClone(job)),
        },
        error: null,
      });
    }

    return Promise.resolve({
      data: { ok: true },
      error: null,
    });
  }

  from(table: string): FakeFlowQuery {
    if (table !== 'flows') {
      throw new Error(`unexpected table ${table}`);
    }
    return new FakeFlowQuery(this);
  }
}

class FakeFlowQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = [];
  private mode: 'select' | 'update' | null = null;
  private updateValues: JsonRecord = {};

  constructor(private readonly supabase: FakeSupabase) {}

  select(_columns: string): this {
    this.mode = 'select';
    return this;
  }

  update(values: JsonRecord): this {
    this.mode = 'update';
    this.updateValues = structuredClone(values);
    return this;
  }

  eq(field: string, value: unknown): this {
    this.filters.push({ field, value });
    return this;
  }

  maybeSingle() {
    const rows = this.matchingRows();
    return Promise.resolve({
      data: rows[0] ? structuredClone(rows[0]) : null,
      error: null,
    });
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const result =
      this.mode === 'update'
        ? Promise.resolve(this.executeUpdate())
        : Promise.resolve({ data: null, error: null });
    return result.then(onfulfilled, onrejected);
  }

  private matchingRows(): JsonRecord[] {
    return this.supabase.flows.filter((row) =>
      this.filters.every((filter) => row[filter.field] === filter.value),
    );
  }

  private executeUpdate() {
    for (const row of this.matchingRows()) {
      Object.assign(row, structuredClone(this.updateValues));
    }
    return { data: null, error: null };
  }
}

function buildFlowJob(
  msgId: number,
  extractionKind: 'extracted_md' | 'extracted_text',
  readCt = 1,
) {
  return {
    msg_id: msgId,
    read_ct: readCt,
    message: {
      schema: 'public',
      table: 'flows',
      id: '97000000-0000-0000-0000-000000000001',
      version: '01.00.000',
      entity_kind: 'flow',
      extraction_kind: extractionKind,
      created_at: '2026-05-26T00:00:00Z',
    },
  };
}

Deno.test(
  'processDatasetExtractionJobs updates flow markdown/text jobs and acks successes',
  async () => {
    const supabase = new FakeSupabase();
    supabase.flows.push({
      id: '97000000-0000-0000-0000-000000000001',
      version: '01.00.000',
      json_ordered: FLOW_JSON,
    });
    supabase.claimedJobs = [buildFlowJob(1, 'extracted_md'), buildFlowJob(2, 'extracted_text')];

    const result = await processDatasetExtractionJobs({
      supabase: supabase as unknown as SupabaseClient,
      markdownGenerator: () => '# Test flow',
      textGenerator: async () => 'Test flow summary.',
    });

    assertEquals(result.claimed, 2);
    assertEquals(result.acked, 2);
    assertEquals(supabase.flows[0].extracted_md, '# Test flow');
    assertEquals(supabase.flows[0].extracted_text, 'Test flow summary.');
    assertEquals(supabase.rpcCalls.at(-1), {
      fn: 'cmd_dataset_extraction_ack',
      args: { p_msg_ids: [1, 2] },
    });
  },
);

Deno.test('processDatasetExtractionJobs leaves transient failures unacked for retry', async () => {
  const supabase = new FakeSupabase();
  supabase.flows.push({
    id: '97000000-0000-0000-0000-000000000001',
    version: '01.00.000',
    json_ordered: FLOW_JSON,
  });
  supabase.claimedJobs = [buildFlowJob(3, 'extracted_text', 1)];

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
    textGenerator: async () => {
      throw new Error('temporary OpenAI failure');
    },
  });

  assertEquals(result.acked, 0);
  assertEquals(result.results[0].status, 'retry');
  assertEquals(
    supabase.rpcCalls.some((call) => call.fn === 'cmd_dataset_extraction_ack'),
    false,
  );
  assertEquals(
    supabase.rpcCalls.some((call) => call.fn === 'cmd_dataset_extraction_record_failure'),
    false,
  );
});

Deno.test('processDatasetExtractionJobs records terminal retry failures', async () => {
  const supabase = new FakeSupabase();
  supabase.flows.push({
    id: '97000000-0000-0000-0000-000000000001',
    version: '01.00.000',
    json_ordered: FLOW_JSON,
  });
  supabase.claimedJobs = [buildFlowJob(4, 'extracted_text', 5)];

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
    maxReadCount: 5,
    textGenerator: async () => {
      throw new Error('terminal OpenAI failure');
    },
  });

  assertEquals(result.acked, 0);
  assertEquals(result.results[0].status, 'failed');
  assertEquals(supabase.rpcCalls.at(-1)?.fn, 'cmd_dataset_extraction_record_failure');
});

Deno.test('processDatasetExtractionJobs records process jobs as unsupported in v1', async () => {
  const supabase = new FakeSupabase();
  supabase.claimedJobs = [
    {
      msg_id: 5,
      read_ct: 1,
      message: {
        schema: 'public',
        table: 'processes',
        id: '98000000-0000-0000-0000-000000000001',
        version: '01.00.000',
        entity_kind: 'process',
        extraction_kind: 'extracted_md',
      },
    },
  ];

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
  });

  assertEquals(result.acked, 0);
  assertEquals(result.results[0].status, 'unsupported');
  assertEquals(supabase.rpcCalls.at(-1)?.fn, 'cmd_dataset_extraction_record_failure');
});

Deno.test('flow extraction helpers keep legacy string json_ordered payloads compatible', () => {
  const parsed = normalizeJsonOrdered(JSON.stringify(FLOW_JSON));
  const markdown = generateFlowMarkdown(parsed);

  assertEquals(markdown.includes('# Test flow'), true);
  assertEquals(markdown.includes('**Version:** 01.00.000'), true);
});
