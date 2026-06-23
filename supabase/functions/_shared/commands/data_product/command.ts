import { z } from 'zod';

import type { ActorContext } from '../../command_runtime/actor_context.ts';
import { buildCommandAuditPayload } from '../../command_runtime/audit_log.ts';
import type { CommandParseResult } from '../../command_runtime/command.ts';
import {
  createDataProductCommandRepository,
  type DataProductCommandRepository,
} from './repository.ts';
import type {
  DataProductCommandExecutionResult,
  DataProductCommandRequest,
  DataProductRunCreateRequest,
} from './types.ts';

const versionPattern = /^\d{2}\.\d{2}\.\d{3}$/;
const uuidSchema = z.string().uuid();
const nonEmptyTextSchema = z.string().trim().min(1).max(200);

const processSelectionSchema = z
  .object({
    id: uuidSchema,
    version: z.string().regex(versionPattern, 'version must be in 00.00.000 format'),
  })
  .strict();

const createRunSchema = z
  .object({
    action: z.literal('create_run'),
    name: nonEmptyTextSchema,
    processes: z.array(processSelectionSchema).min(1).optional(),
    coverageMode: z.enum(['global_eligible', 'subset']).default('global_eligible'),
    defaultImpactCategory: nonEmptyTextSchema.optional(),
    lciaMethodSet: z.array(z.unknown()).default([]),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const previewPackageSchema = z
  .object({
    action: z.literal('preview_package'),
    packageId: uuidSchema,
  })
  .strict();

const publishPackageSchema = z
  .object({
    action: z.literal('publish_package'),
    packageId: uuidSchema,
    displayDefaultImpactCategory: nonEmptyTextSchema.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const unpublishPublicationSchema = z
  .object({
    action: z.literal('unpublish_publication'),
    publicationId: uuidSchema,
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const dataProductCommandRequestSchema = z.discriminatedUnion('action', [
  createRunSchema,
  previewPackageSchema,
  publishPackageSchema,
  unpublishPublicationSchema,
]);

function invalidPayload<T>(message: string, error: z.ZodError): CommandParseResult<T> {
  return {
    ok: false,
    message,
    details: error.flatten(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown, field: string): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const fieldValue = value[field];
  return typeof fieldValue === 'string' && fieldValue.length > 0 ? fieldValue : null;
}

export function parseDataProductCommand(
  body: unknown,
): CommandParseResult<DataProductCommandRequest> {
  const parsed = dataProductCommandRequestSchema.safeParse(body);
  if (!parsed.success) {
    return invalidPayload('Invalid data product command payload', parsed.error);
  }

  return {
    ok: true,
    value: parsed.data,
  };
}

function auditFor(request: DataProductCommandRequest, actor: ActorContext) {
  switch (request.action) {
    case 'create_run':
      return buildCommandAuditPayload({
        command: 'data_product_run_create',
        actorUserId: actor.userId,
        targetTable: 'data_product_runs',
        targetId: 'pending',
        targetVersion: '',
        payload: {
          coverageMode: request.coverageMode,
          defaultImpactCategory: request.defaultImpactCategory ?? null,
        },
      });
    case 'publish_package':
      return buildCommandAuditPayload({
        command: 'data_product_package_publish',
        actorUserId: actor.userId,
        targetTable: 'data_product_packages',
        targetId: request.packageId,
        targetVersion: '',
        payload: {
          displayDefaultImpactCategory: request.displayDefaultImpactCategory ?? null,
          reason: request.reason ?? null,
        },
      });
    case 'unpublish_publication':
      return buildCommandAuditPayload({
        command: 'data_product_package_unpublish',
        actorUserId: actor.userId,
        targetTable: 'data_product_publications',
        targetId: request.publicationId,
        targetVersion: '',
        payload: {
          reason: request.reason ?? null,
        },
      });
    case 'preview_package':
      return null;
  }
}

async function executeCreateRun(
  request: DataProductRunCreateRequest,
  actor: ActorContext,
  repository: DataProductCommandRepository,
): Promise<DataProductCommandExecutionResult> {
  const audit = auditFor(request, actor)!;
  const result = await repository.createRun(request, audit);
  if (!result.ok) {
    return result;
  }

  const runId = stringField(result.data, 'runId');
  if (!runId) {
    return {
      ok: false,
      code: 'data_product_run_id_missing',
      status: 502,
      message: 'Data product run RPC did not return a runId',
      details: result.data,
    };
  }

  const workerJob = await repository.enqueuePackageBuild(
    {
      runId,
      sourceCommand: request,
      idempotencyKey: `data_product.package_build:${runId}`,
    },
    actor,
  );
  if (!workerJob.ok) {
    return {
      ok: false,
      code: 'worker_jobs_enqueue_failed',
      status: workerJob.status,
      message: 'Failed to enqueue data product package build',
      details: {
        runId,
        error: workerJob.error,
        details: workerJob.details ?? null,
      },
    };
  }

  if (!workerJob.workerJobId) {
    return {
      ok: false,
      code: 'data_product_worker_job_id_missing',
      status: 502,
      message: 'Worker enqueue RPC did not return a worker job id',
      details: workerJob.data,
    };
  }

  const attached = await repository.attachRunWorkerJob(runId, workerJob.workerJobId);
  if (!attached.ok) {
    return attached;
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      command: 'data_product_run_create',
      data: {
        ...(isRecord(result.data) ? result.data : { runId }),
        workerJobId: workerJob.workerJobId,
      },
    },
  };
}

export async function executeDataProductCommand(
  request: DataProductCommandRequest,
  actor: ActorContext,
  repository: DataProductCommandRepository = createDataProductCommandRepository(actor.supabase),
): Promise<DataProductCommandExecutionResult> {
  switch (request.action) {
    case 'create_run':
      return executeCreateRun(request, actor, repository);
    case 'preview_package': {
      const result = await repository.previewPackage(request);
      if (!result.ok) {
        return result;
      }
      return {
        ok: true,
        body: {
          ok: true,
          command: 'data_product_package_preview',
          data: result.data,
        },
      };
    }
    case 'publish_package': {
      const result = await repository.publishPackage(request, auditFor(request, actor)!);
      if (!result.ok) {
        return result;
      }
      return {
        ok: true,
        body: {
          ok: true,
          command: 'data_product_package_publish',
          data: result.data,
        },
      };
    }
    case 'unpublish_publication': {
      const result = await repository.unpublishPublication(request, auditFor(request, actor)!);
      if (!result.ok) {
        return result;
      }
      return {
        ok: true,
        body: {
          ok: true,
          command: 'data_product_package_unpublish',
          data: result.data,
        },
      };
    }
  }
}
