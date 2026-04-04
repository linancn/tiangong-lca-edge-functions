import { assertEquals, assertThrows } from "jsr:@std/assert";

import { buildCommandAuditPayload } from "../supabase/functions/_shared/command_runtime/audit_log.ts";
import { createReviewCommandRepository } from "../supabase/functions/_shared/commands/review/repository.ts";
import {
  rejectReviewRequestSchema,
  saveAssignmentDraftRequestSchema,
  submitCommentRequestSchema,
} from "../supabase/functions/_shared/commands/review/validation.ts";
import {
  buildReviewApproveRpcArgs,
  buildReviewRejectRpcArgs,
  buildReviewSaveCommentDraftRpcArgs,
  buildReviewSubmitCommentRpcArgs,
  callReviewApproveRpc,
  callReviewRejectRpc,
  callReviewSaveAssignmentDraftRpc,
  type ReviewRpcResult,
} from "../supabase/functions/_shared/db_rpc/review_commands.ts";

Deno.test("saveAssignmentDraftRequestSchema rejects unexpected fields", () => {
  const parsed = saveAssignmentDraftRequestSchema.safeParse({
    reviewId: "11111111-1111-4111-8111-111111111111",
    reviewerIds: ["22222222-2222-4222-8222-222222222222"],
    deadline: "2026-04-10T12:00:00.000Z",
  });

  assertEquals(parsed.success, false);
});

Deno.test("submitCommentRequestSchema rejects server-owned fields", () => {
  const parsed = submitCommentRequestSchema.safeParse({
    reviewId: "11111111-1111-4111-8111-111111111111",
    json: {},
    submittedAt: "2026-04-10T12:00:00.000Z",
  });

  assertEquals(parsed.success, false);
});

Deno.test("submitCommentRequestSchema rejects invalid commentState values", () => {
  const parsed = submitCommentRequestSchema.safeParse({
    reviewId: "11111111-1111-4111-8111-111111111111",
    json: {},
    commentState: 0,
  });

  assertEquals(parsed.success, false);
});

Deno.test("rejectReviewRequestSchema requires non-empty reason", () => {
  const parsed = rejectReviewRequestSchema.safeParse({
    table: "processes",
    reviewId: "11111111-1111-4111-8111-111111111111",
    reason: "   ",
  });

  assertEquals(parsed.success, false);
});

Deno.test("createReviewCommandRepository requires an explicit Supabase client", () => {
  assertThrows(
    () => createReviewCommandRepository(undefined as never),
    Error,
    "Review command repository requires an explicit Supabase client",
  );
});

class FakeRpcSupabase {
  constructor(private readonly result: { data: unknown; error: unknown }) {}

  rpc() {
    return Promise.resolve(this.result);
  }
}

const saveAssignmentDraftRequest = {
  reviewId: "11111111-1111-4111-8111-111111111111",
  reviewerIds: ["22222222-2222-4222-8222-222222222222"],
};

const approveRequest = {
  table: "processes" as const,
  reviewId: "11111111-1111-4111-8111-111111111111",
};

const saveCommentDraftRequest = {
  reviewId: "11111111-1111-4111-8111-111111111111",
  json: { blocks: [] },
};

const submitCommentRequest = {
  reviewId: "11111111-1111-4111-8111-111111111111",
  json: { summary: "looks good" },
  commentState: -3 as const,
};

const rejectRequest = {
  table: "lifecyclemodels" as const,
  reviewId: "11111111-1111-4111-8111-111111111111",
  reason: "Insufficient evidence",
};

const auditPayload = buildCommandAuditPayload({
  command: "review_save_assignment_draft",
  actorUserId: "33333333-3333-4333-8333-333333333333",
  targetTable: "reviews",
  targetId: "11111111-1111-4111-8111-111111111111",
  targetVersion: "",
  payload: {},
});

Deno.test(
  "callReviewSaveAssignmentDraftRpc unwraps success envelopes returned by cmd_review_* RPCs",
  async () => {
    const result = (await callReviewSaveAssignmentDraftRpc(
      new FakeRpcSupabase({
        data: {
          ok: true,
          data: {
            review_id: saveAssignmentDraftRequest.reviewId,
            reviewer_count: saveAssignmentDraftRequest.reviewerIds.length,
          },
        },
        error: null,
      }) as never,
      saveAssignmentDraftRequest,
      auditPayload,
    )) as ReviewRpcResult;

    assertEquals(result, {
      ok: true,
      data: {
        review_id: saveAssignmentDraftRequest.reviewId,
        reviewer_count: saveAssignmentDraftRequest.reviewerIds.length,
      },
    });
  },
);

Deno.test(
  "callReviewSaveAssignmentDraftRpc treats failure envelopes as command failures",
  async () => {
    const result = (await callReviewSaveAssignmentDraftRpc(
      new FakeRpcSupabase({
        data: {
          ok: false,
          code: "REVIEW_NOT_FOUND",
          status: 404,
          message: "Review not found",
          details: {
            review_id: saveAssignmentDraftRequest.reviewId,
          },
        },
        error: null,
      }) as never,
      saveAssignmentDraftRequest,
      auditPayload,
    )) as ReviewRpcResult;

    assertEquals(result, {
      ok: false,
      code: "REVIEW_NOT_FOUND",
      status: 404,
      message: "Review not found",
      details: {
        review_id: saveAssignmentDraftRequest.reviewId,
      },
    });
  },
);

Deno.test("callReviewApproveRpc unwraps success envelopes returned by cmd_review_approve", async () => {
  const result = (await callReviewApproveRpc(
    new FakeRpcSupabase({
      data: {
        ok: true,
        data: {
          review_id: approveRequest.reviewId,
          approved: true,
        },
      },
      error: null,
    }) as never,
    approveRequest,
    auditPayload,
  )) as ReviewRpcResult;

  assertEquals(result, {
    ok: true,
    data: {
      review_id: approveRequest.reviewId,
      approved: true,
    },
  });
});

Deno.test("callReviewRejectRpc treats failure envelopes as command failures", async () => {
  const result = (await callReviewRejectRpc(
    new FakeRpcSupabase({
      data: {
        ok: false,
        code: "INVALID_STATE",
        status: 409,
        message: "Review is not in an approvable state",
        details: {
          review_id: rejectRequest.reviewId,
          state_code: 10,
        },
      },
      error: null,
    }) as never,
    rejectRequest,
    auditPayload,
  )) as ReviewRpcResult;

  assertEquals(result, {
    ok: false,
    code: "INVALID_STATE",
    status: 409,
    message: "Review is not in an approvable state",
    details: {
      review_id: rejectRequest.reviewId,
      state_code: 10,
    },
  });
});

Deno.test("review comment RPC arg builders use the DB contract field names", () => {
  assertEquals(
    buildReviewSaveCommentDraftRpcArgs(saveCommentDraftRequest, auditPayload),
    {
      p_review_id: saveCommentDraftRequest.reviewId,
      p_json: saveCommentDraftRequest.json,
      p_audit: auditPayload,
    },
  );

  assertEquals(
    buildReviewSubmitCommentRpcArgs(submitCommentRequest, auditPayload),
    {
      p_review_id: submitCommentRequest.reviewId,
      p_json: submitCommentRequest.json,
      p_comment_state: -3,
      p_audit: auditPayload,
    },
  );
});

Deno.test("review decision RPC arg builders forward table and reason fields", () => {
  assertEquals(buildReviewApproveRpcArgs(approveRequest, auditPayload), {
    p_table: approveRequest.table,
    p_review_id: approveRequest.reviewId,
    p_audit: auditPayload,
  });

  assertEquals(buildReviewRejectRpcArgs(rejectRequest, auditPayload), {
    p_table: rejectRequest.table,
    p_review_id: rejectRequest.reviewId,
    p_reason: rejectRequest.reason,
    p_audit: auditPayload,
  });
});
