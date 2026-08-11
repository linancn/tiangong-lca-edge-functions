import { assertEquals } from 'jsr:@std/assert';

import type { ActorContext } from '../supabase/functions/_shared/command_runtime/actor_context.ts';
import {
  executeAdminReviewBatchDecisionCommand,
  executeReviewerBatchDecisionCommand,
} from '../supabase/functions/_shared/commands/review/batch_decision.ts';
import type { ReviewCommandRepository } from '../supabase/functions/_shared/commands/review/repository.ts';
import { reviewBatchDecisionRequestSchema } from '../supabase/functions/_shared/commands/review/validation.ts';

const firstReviewId = '11111111-1111-4111-8111-111111111111';
const secondReviewId = '22222222-2222-4222-8222-222222222222';
const actor = {
  userId: '33333333-3333-4333-8333-333333333333',
  accessToken: 'test-token',
  supabase: {} as never,
} as ActorContext;

Deno.test('review batch schema deduplicates IDs and requires a rejection reason', () => {
  const parsed = reviewBatchDecisionRequestSchema.safeParse({
    reviewIds: [firstReviewId, firstReviewId],
    decision: 'reject',
    reason: '  shared reason  ',
  });

  assertEquals(parsed.success, true);
  if (parsed.success) {
    assertEquals(parsed.data, {
      reviewIds: [firstReviewId],
      decision: 'reject',
      reason: 'shared reason',
    });
  }

  assertEquals(
    reviewBatchDecisionRequestSchema.safeParse({
      reviewIds: [firstReviewId],
      decision: 'reject',
      reason: '   ',
    }).success,
    false,
  );
});

Deno.test('admin batch decisions use only review-admin finalization methods', async () => {
  const calls: string[] = [];
  const repository = {
    finalizeApproveById: async ({ reviewId }: { reviewId: string }) => {
      calls.push(`admin:${reviewId}`);
      return reviewId === secondReviewId
        ? { ok: false as const, code: 'INVALID_REVIEW_STATE', message: 'stale', status: 409 }
        : { ok: true as const, data: {} };
    },
    finalizeRejectById: async () => ({ ok: true as const, data: {} }),
    submitReviewerDecision: async () => {
      calls.push('reviewer');
      return { ok: true as const, data: {} };
    },
  } as unknown as ReviewCommandRepository;

  const result = await executeAdminReviewBatchDecisionCommand(
    { reviewIds: [firstReviewId, secondReviewId], decision: 'approve' },
    actor,
    repository,
  );

  assertEquals(calls, [`admin:${firstReviewId}`, `admin:${secondReviewId}`]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals((result.body as { summary: unknown }).summary, {
      total: 2,
      succeeded: 1,
      failed: 1,
    });
  }
});

Deno.test('reviewer batch decisions use only reviewer opinion methods', async () => {
  const calls: string[] = [];
  const repository = {
    finalizeApproveById: async () => {
      calls.push('admin');
      return { ok: true as const, data: {} };
    },
    finalizeRejectById: async () => {
      calls.push('admin');
      return { ok: true as const, data: {} };
    },
    submitReviewerDecision: async (request: { reviewId: string; decision: string }) => {
      calls.push(`${request.decision}:${request.reviewId}`);
      return { ok: true as const, data: {} };
    },
  } as unknown as ReviewCommandRepository;

  await executeReviewerBatchDecisionCommand(
    { reviewIds: [firstReviewId], decision: 'reject', reason: 'needs work' },
    actor,
    repository,
  );

  assertEquals(calls, [`reject:${firstReviewId}`]);
});
