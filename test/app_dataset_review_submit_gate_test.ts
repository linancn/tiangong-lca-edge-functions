import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import type { CommandAuditPayload } from '../supabase/functions/_shared/command_runtime/audit_log.ts';
import type { DatasetCommandRepository } from '../supabase/functions/_shared/commands/dataset/repository.ts';
import {
  executeReviewSubmitGateCommand,
  parseReviewSubmitGateCommand,
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

class FakeReviewSubmitGateRepository implements DatasetCommandRepository {
  reviewSubmitGateCalls: Array<{ request: ReviewSubmitGateRequest; audit: CommandAuditPayload }> =
    [];

  constructor(private readonly gateResult: DatasetRpcResult) {}

  private unimplemented(): Promise<DatasetRpcResult> {
    return Promise.reject(new Error('not implemented'));
  }

  create = () => this.unimplemented();
  delete = () => this.unimplemented();
  saveDraft = () => this.unimplemented();
  assignTeam = () => this.unimplemented();
  publish = () => this.unimplemented();
  submitReview = () => this.unimplemented();

  reviewSubmitGate(request: ReviewSubmitGateRequest, audit: CommandAuditPayload) {
    this.reviewSubmitGateCalls.push({
      request: structuredClone(request),
      audit: structuredClone(audit),
    });
    return Promise.resolve(structuredClone(this.gateResult));
  }
}

function buildActor() {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: {} as SupabaseClient,
  };
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
      revisionChecksum: TEST_REVISION_CHECKSUM,
      action: 'ensure',
      policyProfile: 'review_submit_fast.v1',
      reportSchemaVersion: 'review_submit_gate_report.v1',
    },
    buildActor(),
    repository,
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

  const queued = await executeReviewSubmitGateCommand(request, buildActor(), queuedRepository);
  const blocked = await executeReviewSubmitGateCommand(request, buildActor(), blockedRepository);

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
