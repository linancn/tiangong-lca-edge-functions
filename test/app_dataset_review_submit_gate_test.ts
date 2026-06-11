import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import type { CommandAuditPayload } from '../supabase/functions/_shared/command_runtime/audit_log.ts';
import {
  stableJsonSha256,
  stableJsonStringify,
} from '../supabase/functions/_shared/commands/dataset/canonical_json.ts';
import type { DatasetCommandRepository } from '../supabase/functions/_shared/commands/dataset/repository.ts';
import {
  executeReviewSubmitGateCommand,
  parseReviewSubmitGateCommand,
  resolveAuthoritativeReviewSubmitRevision,
} from '../supabase/functions/_shared/commands/dataset/review_submit_gate.ts';
import type {
  DatasetCommandExecutionResult,
  ReviewSubmitGateRequest,
} from '../supabase/functions/_shared/commands/dataset/types.ts';
import type { DatasetRpcResult } from '../supabase/functions/_shared/db_rpc/dataset_commands.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';
const TEST_GATE_RUN_ID = '33333333-3333-4333-8333-333333333333';
const TEST_REVISION_CHECKSUM = 'b'.repeat(64);
const TEST_CLIENT_REVISION_CHECKSUM = 'a'.repeat(64);

type RevisionRow = {
  id: string;
  version: string;
  json_ordered?: unknown;
};

class FakeReviewSubmitGateRepository implements DatasetCommandRepository {
  reviewSubmitGateCalls: Array<{ request: ReviewSubmitGateRequest; audit: CommandAuditPayload }> =
    [];

  constructor(private readonly gateResult: DatasetRpcResult) {}

  private unimplemented(): Promise<DatasetRpcResult> {
    return Promise.reject(new Error('not implemented'));
  }

  create = () => this.unimplemented();
  createVersion = () => this.unimplemented();
  delete = () => this.unimplemented();
  saveDraft = () => this.unimplemented();
  assignTeam = () => this.unimplemented();
  publish = () => this.unimplemented();
  submitReview = () => this.unimplemented();
  reviewSubmitJobEnqueue = () => this.unimplemented();
  reviewSubmitJobRead = () => this.unimplemented();
  reviewSubmitJobReadLatest = () => this.unimplemented();

  reviewSubmitGate(request: ReviewSubmitGateRequest, audit: CommandAuditPayload) {
    this.reviewSubmitGateCalls.push({
      request: structuredClone(request),
      audit: structuredClone(audit),
    });
    return Promise.resolve(structuredClone(this.gateResult));
  }
}

class FakeRevisionQuery {
  private filters: Array<{ field: string; value: unknown }> = [];

  constructor(private readonly rows: RevisionRow[]) {}

  select(_columns: string) {
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push({ field, value });
    return this;
  }

  async range(from: number, to: number) {
    const rows = this.rows.filter((row) =>
      this.filters.every(
        (filter) => (row as unknown as Record<string, unknown>)[filter.field] === filter.value,
      ),
    );

    return { data: rows.slice(from, to + 1), error: null };
  }
}

class FakeRevisionSupabase {
  constructor(private readonly rowsByTable: Record<string, RevisionRow[]>) {}

  from(table: string) {
    return new FakeRevisionQuery(this.rowsByTable[table] ?? []);
  }
}

function buildActor(supabase: unknown = {}) {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: supabase as SupabaseClient,
  };
}

function resolveTestRevision(revisionChecksum = TEST_REVISION_CHECKSUM) {
  return () => Promise.resolve({ ok: true as const, revisionChecksum });
}

function commandBody<T>(result: DatasetCommandExecutionResult): T {
  if (!result.ok) {
    throw new Error(`Expected command success, got ${result.code}`);
  }

  return result.body as T;
}

Deno.test('parseReviewSubmitGateCommand rejects malformed gate payloads', () => {
  const result = parseReviewSubmitGateCommand({
    table: 'processes',
    id: TEST_DATASET_ID,
    version: '01.00.000',
    revisionChecksum: 'not-sha256',
  });

  assertEquals(result.ok, false);
});

Deno.test('parseReviewSubmitGateCommand accepts missing client checksum', () => {
  const result = parseReviewSubmitGateCommand({
    table: 'processes',
    id: TEST_DATASET_ID,
    version: '01.00.000',
  });

  assertEquals(result.ok, true);
});

Deno.test('stableJsonSha256 orders keys like the worker runner', async () => {
  assertEquals(
    stableJsonStringify({ 2: 'two', 10: 'ten', 1: 'one', a: 'letter' }),
    '{"1":"one","10":"ten","2":"two","a":"letter"}',
  );
  assertEquals(
    await stableJsonSha256({ '@xml:lang': 'en', '#text': 'hello' }),
    '3e129ac94dcaabd25e1cdcf880c0c3cb95ed192479416b0f9010661a622e1a65',
  );
});

Deno.test('resolveAuthoritativeReviewSubmitRevision hashes persisted json_ordered', async () => {
  const payload = { '@xml:lang': 'en', '#text': 'hello' };
  const result = await resolveAuthoritativeReviewSubmitRevision(
    {
      table: 'processes',
      id: TEST_DATASET_ID,
      version: '01.00.000',
      action: 'ensure',
      policyProfile: 'review_submit_fast.v1',
      reportSchemaVersion: 'review_submit_gate_report.v1',
    },
    buildActor(
      new FakeRevisionSupabase({
        processes: [
          {
            id: TEST_DATASET_ID,
            version: '01.00.000',
            json_ordered: payload,
          },
        ],
      }),
    ),
  );

  assertEquals(result, {
    ok: true,
    revisionChecksum: '3e129ac94dcaabd25e1cdcf880c0c3cb95ed192479416b0f9010661a622e1a65',
  });
});

Deno.test('executeReviewSubmitGateCommand returns passed gate as submit-ready', async () => {
  const repository = new FakeReviewSubmitGateRepository({
    ok: true,
    data: {
      status: 'passed',
      gateRunId: TEST_GATE_RUN_ID,
      datasetRevision: {
        table: 'processes',
        id: TEST_DATASET_ID,
        version: '01.00.000',
        revisionChecksum: TEST_REVISION_CHECKSUM,
      },
      policy: {
        profile: 'review_submit_fast.v1',
      },
      calculatorReport: {
        schemaVersion: 'review_submit_gate_report.v1',
        generatedAt: '2026-05-25T00:00:00.000Z',
      },
      blockingReasons: [],
    },
  });

  const result = await executeReviewSubmitGateCommand(
    {
      table: 'processes',
      id: TEST_DATASET_ID,
      version: '01.00.000',
      revisionChecksum: TEST_CLIENT_REVISION_CHECKSUM,
      action: 'ensure',
      policyProfile: 'review_submit_fast.v1',
      reportSchemaVersion: 'review_submit_gate_report.v1',
    },
    buildActor(),
    repository,
    resolveTestRevision(),
  );

  assertEquals(result.ok, true);
  assertEquals(result.status, 200);
  const body = commandBody<{
    ok: boolean;
    command: string;
    data: { status: string; gateRunId: string };
  }>(result);

  assertEquals(body.ok, true);
  assertEquals(body.command, 'dataset_review_submit_gate');
  assertEquals(body.data.status, 'passed');
  assertEquals(body.data.gateRunId, TEST_GATE_RUN_ID);
  assertEquals(repository.reviewSubmitGateCalls, [
    {
      request: {
        table: 'processes',
        id: TEST_DATASET_ID,
        version: '01.00.000',
        revisionChecksum: TEST_REVISION_CHECKSUM,
        action: 'ensure',
        policyProfile: 'review_submit_fast.v1',
        reportSchemaVersion: 'review_submit_gate_report.v1',
      },
      audit: {
        command: 'dataset_review_submit_gate',
        actorUserId: TEST_USER_ID,
        targetTable: 'processes',
        targetId: TEST_DATASET_ID,
        targetVersion: '01.00.000',
        payload: {
          action: 'ensure',
          gateRunId: null,
          policyProfile: 'review_submit_fast.v1',
          reportSchemaVersion: 'review_submit_gate_report.v1',
          clientRevisionChecksum: TEST_CLIENT_REVISION_CHECKSUM,
          revisionChecksum: TEST_REVISION_CHECKSUM,
        },
      },
    },
  ]);
});

Deno.test('executeReviewSubmitGateCommand maps queued and blocked gate states', async () => {
  const queuedRepository = new FakeReviewSubmitGateRepository({
    ok: true,
    data: {
      status: 'queued',
      gateRunId: TEST_GATE_RUN_ID,
    },
  });
  const blockedRepository = new FakeReviewSubmitGateRepository({
    ok: true,
    data: {
      status: 'blocked',
      gateRunId: TEST_GATE_RUN_ID,
      blockingReasons: [{ code: 'provider_unresolved' }],
    },
  });

  const request: ReviewSubmitGateRequest = {
    table: 'processes',
    id: TEST_DATASET_ID,
    version: '01.00.000',
    revisionChecksum: TEST_REVISION_CHECKSUM,
    action: 'ensure',
    policyProfile: 'review_submit_fast.v1',
    reportSchemaVersion: 'review_submit_gate_report.v1',
  };

  const queued = await executeReviewSubmitGateCommand(
    request,
    buildActor(),
    queuedRepository,
    resolveTestRevision(),
  );
  const blocked = await executeReviewSubmitGateCommand(
    request,
    buildActor(),
    blockedRepository,
    resolveTestRevision(),
  );

  assertEquals(queued.ok, true);
  assertEquals(queued.status, 202);
  assertEquals(commandBody<{ ok: boolean; data: { status: string } }>(queued).ok, false);
  assertEquals(
    commandBody<{ ok: boolean; data: { status: string } }>(queued).data.status,
    'queued',
  );

  assertEquals(blocked.ok, true);
  assertEquals(blocked.status, 409);
  assertEquals(commandBody<{ ok: boolean; data: { status: string } }>(blocked).ok, false);
  assertEquals(
    commandBody<{ ok: boolean; data: { status: string } }>(blocked).data.status,
    'blocked',
  );
});
