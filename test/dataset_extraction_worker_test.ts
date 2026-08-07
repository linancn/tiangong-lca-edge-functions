import { assertEquals, assertStringIncludes } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import {
  type DatasetEntityKind,
  processDatasetExtractionJobs,
  type SupportedDatasetEntityKind,
} from '../supabase/functions/_shared/dataset_extraction_worker.ts';
import {
  generateFlowMarkdown,
  normalizeJsonOrdered,
} from '../supabase/functions/_shared/flow_extraction.ts';

type JsonRecord = Record<string, unknown>;
type Filter = { field: string; value: unknown };

const FIXTURES: Record<SupportedDatasetEntityKind, unknown> = {
  flow: {
    flowDataSet: {
      flowInformation: {
        dataSetInformation: {
          'common:UUID': '97000000-0000-0000-0000-000000000001',
          name: { baseName: [{ '@xml:lang': 'en', '#text': 'Test flow' }] },
        },
      },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
      },
    },
  },
  contact: {
    contactDataSet: {
      contactInformation: {
        dataSetInformation: {
          'common:name': [{ '@xml:lang': 'en', '#text': 'Alice Example' }],
          email: 'alice@example.test',
        },
      },
    },
  },
  flowproperty: {
    flowPropertyDataSet: {
      flowPropertiesInformation: {
        dataSetInformation: {
          'common:name': [{ '@xml:lang': 'en', '#text': 'Mass' }],
        },
        quantitativeReference: {
          referenceToReferenceUnitGroup: {
            'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Units of mass' }],
          },
        },
      },
    },
  },
  source: {
    sourceDataSet: {
      sourceInformation: {
        dataSetInformation: {
          'common:shortName': [{ '@xml:lang': 'en', '#text': 'Reference source' }],
          sourceCitation: 'Example et al. 2026',
        },
      },
    },
  },
  unitgroup: {
    unitGroupDataSet: {
      unitGroupInformation: {
        dataSetInformation: {
          'common:name': [{ '@xml:lang': 'en', '#text': 'Units of length' }],
        },
        quantitativeReference: { referenceToReferenceUnit: '1' },
      },
      units: { unit: { '@dataSetInternalID': '1', name: 'm', meanValue: 1 } },
    },
  },
};

const TABLE_BY_KIND: Record<SupportedDatasetEntityKind, string> = {
  flow: 'flows',
  contact: 'contacts',
  flowproperty: 'flowproperties',
  source: 'sources',
  unitgroup: 'unitgroups',
};

class FakeSupabase {
  rows: Record<string, JsonRecord[]> = {};
  claimedJobs: JsonRecord[] = [];
  rpcCalls: Array<{ fn: string; args: unknown }> = [];

  rpc(fn: string, args: unknown) {
    this.rpcCalls.push({ fn, args: structuredClone(args) });
    if (fn === 'cmd_dataset_extraction_claim') {
      return Promise.resolve({
        data: { ok: true, data: this.claimedJobs.map((job) => structuredClone(job)) },
        error: null,
      });
    }
    return Promise.resolve({ data: { ok: true }, error: null });
  }

  schema(schema: string): this {
    assertEquals(schema, 'public');
    return this;
  }

  from(table: string): FakeDatasetQuery {
    this.rows[table] ??= [];
    return new FakeDatasetQuery(this.rows[table]);
  }
}

class FakeDatasetQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private filters: Filter[] = [];
  private mode: 'select' | 'update' | null = null;
  private updateValues: JsonRecord = {};

  constructor(private readonly rows: JsonRecord[]) {}

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
    const row = this.matchingRows()[0];
    return Promise.resolve({ data: row ? structuredClone(row) : null, error: null });
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onfulfilled?:
      ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const result =
      this.mode === 'update'
        ? Promise.resolve(this.executeUpdate())
        : Promise.resolve({ data: null, error: null });
    return result.then(onfulfilled, onrejected);
  }

  private matchingRows(): JsonRecord[] {
    return this.rows.filter((row) =>
      this.filters.every((filter) => row[filter.field] === filter.value),
    );
  }

  private executeUpdate() {
    for (const row of this.matchingRows()) Object.assign(row, structuredClone(this.updateValues));
    return { data: null, error: null };
  }
}

function buildJob(
  msgId: number,
  entityKind: DatasetEntityKind,
  table: string,
  id = `97000000-0000-0000-0000-${String(msgId).padStart(12, '0')}`,
  version = '01.00.000',
  extractionKind: string = 'extracted_md',
  readCt = 1,
): JsonRecord {
  return {
    msg_id: msgId,
    read_ct: readCt,
    message: {
      schema: 'public',
      table,
      id,
      version,
      entity_kind: entityKind,
      extraction_kind: extractionKind,
      created_at: '2026-07-27T00:00:00Z',
    },
  };
}

Deno.test('processDatasetExtractionJobs writes and ACKs all four foundation datasets', async () => {
  const supabase = new FakeSupabase();
  const kinds: SupportedDatasetEntityKind[] = ['contact', 'flowproperty', 'source', 'unitgroup'];
  kinds.forEach((kind, index) => {
    const msgId = index + 1;
    const id = `97000000-0000-0000-0000-${String(msgId).padStart(12, '0')}`;
    supabase.rows[TABLE_BY_KIND[kind]] = [
      { id, version: '01.00.000', json_ordered: FIXTURES[kind] },
    ];
    supabase.claimedJobs.push(buildJob(msgId, kind, TABLE_BY_KIND[kind], id));
  });

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
  });

  assertEquals(result.claimed, 4);
  assertEquals(result.acked, 4);
  assertEquals(
    result.results.map((item) => item.status),
    ['success', 'success', 'success', 'success'],
  );
  assertStringIncludes(String(supabase.rows.contacts[0].extracted_md), '**Entity:** Contact');
  assertStringIncludes(
    String(supabase.rows.flowproperties[0].extracted_md),
    '**Entity:** Flow Property',
  );
  assertStringIncludes(String(supabase.rows.sources[0].extracted_md), '**Entity:** Source');
  assertStringIncludes(String(supabase.rows.unitgroups[0].extracted_md), '**Entity:** Unit Group');
  assertEquals(supabase.rpcCalls.at(-1), {
    fn: 'cmd_dataset_extraction_ack',
    args: { p_msg_ids: [1, 2, 3, 4] },
  });
});

Deno.test('dataset extraction updates only the exact id and version', async () => {
  const supabase = new FakeSupabase();
  const id = '97000000-0000-0000-0000-000000000010';
  supabase.rows.sources = [
    { id, version: '01.00.000', json_ordered: FIXTURES.source },
    { id, version: '01.01.000', json_ordered: FIXTURES.source },
  ];
  supabase.claimedJobs = [buildJob(10, 'source', 'sources', id, '01.01.000')];

  await processDatasetExtractionJobs({ supabase: supabase as unknown as SupabaseClient });

  assertEquals(supabase.rows.sources[0].extracted_md, undefined);
  assertStringIncludes(String(supabase.rows.sources[1].extracted_md), '# Reference source');
});

Deno.test('missing or expired dataset identities are ACKed as stale no-ops', async () => {
  const supabase = new FakeSupabase();
  supabase.rows.contacts = [
    {
      id: '97000000-0000-0000-0000-000000000020',
      version: '02.00.000',
      json_ordered: FIXTURES.contact,
    },
  ];
  supabase.claimedJobs = [
    buildJob(20, 'contact', 'contacts', '97000000-0000-0000-0000-000000000020', '01.00.000'),
  ];

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
  });

  assertEquals(result.results[0].status, 'stale');
  assertEquals(result.acked, 1);
  assertEquals(
    supabase.rpcCalls.some((call) => call.fn === 'cmd_dataset_extraction_record_failure'),
    false,
  );
});

Deno.test('wrong table/entity combinations are terminal unsupported jobs', async () => {
  const supabase = new FakeSupabase();
  supabase.claimedJobs = [buildJob(30, 'source', 'contacts')];

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
  });

  assertEquals(result.acked, 0);
  assertEquals(result.results[0].status, 'unsupported');
  assertEquals(result.results[0].error_code, 'UNSUPPORTED_ENTITY_KIND');
  assertEquals(supabase.rpcCalls.at(-1)?.fn, 'cmd_dataset_extraction_record_failure');
});

Deno.test('transient generator failures remain visible for retry', async () => {
  const supabase = new FakeSupabase();
  const id = '97000000-0000-0000-0000-000000000040';
  supabase.rows.sources = [{ id, version: '01.00.000', json_ordered: FIXTURES.source }];
  supabase.claimedJobs = [buildJob(40, 'source', 'sources', id)];

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
    markdownGenerators: {
      source: () => {
        throw new Error('temporary failure');
      },
    },
  });

  assertEquals(result.results[0].status, 'retry');
  assertEquals(result.acked, 0);
  assertEquals(
    supabase.rpcCalls.some((call) => call.fn === 'cmd_dataset_extraction_record_failure'),
    false,
  );
});

Deno.test('max-read generator failures are recorded and removed', async () => {
  const supabase = new FakeSupabase();
  const id = '97000000-0000-0000-0000-000000000050';
  supabase.rows.unitgroups = [{ id, version: '01.00.000', json_ordered: FIXTURES.unitgroup }];
  supabase.claimedJobs = [
    buildJob(50, 'unitgroup', 'unitgroups', id, '01.00.000', 'extracted_md', 5),
  ];

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
    maxReadCount: 5,
    markdownGenerators: {
      unitgroup: () => {
        throw new Error('terminal failure');
      },
    },
  });

  assertEquals(result.results[0].status, 'failed');
  assertEquals(supabase.rpcCalls.at(-1)?.fn, 'cmd_dataset_extraction_record_failure');
});

Deno.test('unsupported extraction kind and process jobs fail deterministically', async () => {
  const supabase = new FakeSupabase();
  supabase.claimedJobs = [
    buildJob(60, 'flow', 'flows', undefined, '01.00.000', 'legacy_kind'),
    buildJob(61, 'process', 'processes'),
  ];

  const result = await processDatasetExtractionJobs({
    supabase: supabase as unknown as SupabaseClient,
  });

  assertEquals(
    result.results.map((item) => item.status),
    ['unsupported', 'unsupported'],
  );
  assertEquals(
    result.results.map((item) => item.error_code),
    ['UNSUPPORTED_EXTRACTION_KIND', 'UNSUPPORTED_ENTITY_KIND'],
  );
});

Deno.test('flow extraction helpers retain string json_ordered compatibility', () => {
  const parsed = normalizeJsonOrdered(JSON.stringify(FIXTURES.flow));
  const markdown = generateFlowMarkdown(parsed);

  assertStringIncludes(markdown, '# Test flow');
  assertStringIncludes(markdown, '**Version:** 01.00.000');
});
