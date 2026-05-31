import { assertEquals } from 'jsr:@std/assert';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import type { CommandAuditPayload } from '../supabase/functions/_shared/command_runtime/audit_log.ts';
import type { DatasetCommandRepository } from '../supabase/functions/_shared/commands/dataset/repository.ts';
import {
  executeReviewSubmitJobCommand,
  parseReviewSubmitJobCommand,
} from '../supabase/functions/_shared/commands/dataset/review_submit_jobs.ts';
import type {
  DatasetCommandExecutionResult,
  ReviewSubmitJobEnqueueRequest,
  ReviewSubmitJobReadLatestRequest,
  ReviewSubmitJobReadRequest,
} from '../supabase/functions/_shared/commands/dataset/types.ts';
import type { DatasetRpcResult } from '../supabase/functions/_shared/db_rpc/dataset_commands.ts';

const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
const TEST_DATASET_ID = '22222222-2222-4222-8222-222222222222';
const TEST_JOB_ID = '33333333-3333-4333-8333-333333333333';
const TEST_GATE_RUN_ID = '44444444-4444-4444-8444-444444444444';
const TEST_GATE_WORKER_JOB_ID = '66666666-6666-4666-8666-666666666666';
const TEST_REVISION_CHECKSUM = 'b'.repeat(64);
const TEST_CLIENT_REVISION_CHECKSUM = 'a'.repeat(64);

class FakeReviewSubmitJobRepository implements DatasetCommandRepository {
  enqueueCalls: Array<{ request: ReviewSubmitJobEnqueueRequest; audit: CommandAuditPayload }> = [];
  readCalls: ReviewSubmitJobReadRequest[] = [];
  readLatestCalls: ReviewSubmitJobReadLatestRequest[] = [];

  constructor(private readonly result: DatasetRpcResult) {}

  private unimplemented(): Promise<DatasetRpcResult> {
    return Promise.reject(new Error('not implemented'));
  }

  create = () => this.unimplemented();
  delete = () => this.unimplemented();
  saveDraft = () => this.unimplemented();
  assignTeam = () => this.unimplemented();
  publish = () => this.unimplemented();
  submitReview = () => this.unimplemented();
  reviewSubmitGate = () => this.unimplemented();

  reviewSubmitJobEnqueue(request: ReviewSubmitJobEnqueueRequest, audit: CommandAuditPayload) {
    this.enqueueCalls.push({
      request: structuredClone(request),
      audit: structuredClone(audit),
    });
    return Promise.resolve(structuredClone(this.result));
  }

  reviewSubmitJobRead(request: ReviewSubmitJobReadRequest) {
    this.readCalls.push(structuredClone(request));
    return Promise.resolve(structuredClone(this.result));
  }

  reviewSubmitJobReadLatest(request: ReviewSubmitJobReadLatestRequest) {
    this.readLatestCalls.push(structuredClone(request));
    return Promise.resolve(structuredClone(this.result));
  }
}

function buildActor() {
  return {
    userId: TEST_USER_ID,
    accessToken: 'access-token',
    supabase: {} as SupabaseClient,
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

Deno.test('parseReviewSubmitJobCommand defaults enqueue action and policy metadata', () => {
  const result = parseReviewSubmitJobCommand({
    table: 'processes',
    id: TEST_DATASET_ID,
    version: '01.00.000',
  });

  assertEquals(result.ok, true);
  if (result.ok && result.value.action === 'enqueue') {
    assertEquals(result.value.action, 'enqueue');
    assertEquals(result.value.policyProfile, 'review_submit_fast.v1');
    assertEquals(result.value.reportSchemaVersion, 'review_submit_gate_report.v1');
  }
});

Deno.test('parseReviewSubmitJobCommand validates read payloads', () => {
  const result = parseReviewSubmitJobCommand({
    action: 'read',
  });

  assertEquals(result.ok, false);
});

Deno.test(
  'executeReviewSubmitJobCommand enqueues with authoritative revision checksum',
  async () => {
    const repository = new FakeReviewSubmitJobRepository({
      ok: true,
      data: {
        status: 'waiting_gate',
        reviewSubmitJobId: TEST_JOB_ID,
        gateRunId: TEST_GATE_RUN_ID,
        gateWorkerJobId: TEST_GATE_WORKER_JOB_ID,
        datasetRevision: {
          table: 'processes',
          id: TEST_DATASET_ID,
          version: '01.00.000',
          revisionChecksum: TEST_REVISION_CHECKSUM,
        },
      },
    });

    const result = await executeReviewSubmitJobCommand(
      {
        action: 'enqueue',
        table: 'processes',
        id: TEST_DATASET_ID,
        version: '01.00.000',
        revisionChecksum: TEST_CLIENT_REVISION_CHECKSUM,
        policyProfile: 'review_submit_fast.v1',
        reportSchemaVersion: 'review_submit_gate_report.v1',
      },
      buildActor(),
      repository,
      resolveTestRevision(),
    );

    assertEquals(result.ok, true);
    assertEquals(result.status, 202);
    assertEquals(
      commandBody<{
        ok: boolean;
        command: string;
        data: {
          status: string;
          reviewSubmitJobId: string;
          gateRunId: string;
          gateWorkerJobId: string;
          datasetRevision: {
            table: string;
            id: string;
            version: string;
            revisionChecksum: string;
          };
        };
      }>(result),
      {
        ok: false,
        command: 'dataset_review_submit_job_enqueue',
        data: {
          status: 'waiting_gate',
          reviewSubmitJobId: TEST_JOB_ID,
          gateRunId: TEST_GATE_RUN_ID,
          gateWorkerJobId: TEST_GATE_WORKER_JOB_ID,
          datasetRevision: {
            table: 'processes',
            id: TEST_DATASET_ID,
            version: '01.00.000',
            revisionChecksum: TEST_REVISION_CHECKSUM,
          },
        },
      },
    );
    assertEquals(repository.enqueueCalls, [
      {
        request: {
          action: 'enqueue',
          table: 'processes',
          id: TEST_DATASET_ID,
          version: '01.00.000',
          revisionChecksum: TEST_REVISION_CHECKSUM,
          policyProfile: 'review_submit_fast.v1',
          reportSchemaVersion: 'review_submit_gate_report.v1',
        },
        audit: {
          command: 'dataset_review_submit_job_enqueue',
          actorUserId: TEST_USER_ID,
          targetTable: 'processes',
          targetId: TEST_DATASET_ID,
          targetVersion: '01.00.000',
          payload: {
            policyProfile: 'review_submit_fast.v1',
            reportSchemaVersion: 'review_submit_gate_report.v1',
            clientRevisionChecksum: TEST_CLIENT_REVISION_CHECKSUM,
            revisionChecksum: TEST_REVISION_CHECKSUM,
          },
        },
      },
    ]);
  },
);

Deno.test('executeReviewSubmitJobCommand reads job state without resolving revision', async () => {
  const repository = new FakeReviewSubmitJobRepository({
    ok: true,
    data: {
      status: 'submitted',
      reviewSubmitJobId: TEST_JOB_ID,
      result: {
        review: {
          id: '55555555-5555-4555-8555-555555555555',
        },
      },
    },
  });

  const result = await executeReviewSubmitJobCommand(
    {
      action: 'read',
      reviewSubmitJobId: TEST_JOB_ID,
    },
    buildActor(),
    repository,
    () => {
      throw new Error('read should not resolve dataset revision');
    },
  );

  assertEquals(result.ok, true);
  assertEquals(result.status, 200);
  assertEquals(repository.readCalls, [
    {
      action: 'read',
      reviewSubmitJobId: TEST_JOB_ID,
    },
  ]);
});

Deno.test(
  'executeReviewSubmitJobCommand reads latest job for current authoritative revision',
  async () => {
    const repository = new FakeReviewSubmitJobRepository({
      ok: true,
      data: {
        status: 'submitting',
        reviewSubmitJobId: TEST_JOB_ID,
      },
    });

    const result = await executeReviewSubmitJobCommand(
      {
        action: 'read_latest',
        table: 'processes',
        id: TEST_DATASET_ID,
        version: '01.00.000',
        revisionChecksum: TEST_CLIENT_REVISION_CHECKSUM,
      },
      buildActor(),
      repository,
      resolveTestRevision(),
    );

    assertEquals(result.ok, true);
    assertEquals(result.status, 202);
    assertEquals(repository.readLatestCalls, [
      {
        action: 'read_latest',
        table: 'processes',
        id: TEST_DATASET_ID,
        version: '01.00.000',
        revisionChecksum: TEST_REVISION_CHECKSUM,
      },
    ]);
  },
);
