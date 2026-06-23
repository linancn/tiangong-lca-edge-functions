import { z } from 'zod';

import type { ActorContext } from '../../command_runtime/actor_context.ts';
import { buildCommandAuditPayload } from '../../command_runtime/audit_log.ts';
import type { CommandParseResult } from '../../command_runtime/command.ts';
import {
  createDataProductCommandRepository,
  type DataProductCommandRepository,
} from './repository.ts';
import type {
  DataProductBuildCreateRequest,
  DataProductCommandExecutionResult,
  DataProductCommandRequest,
  DataProductWorkerJobRequest,
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

const createBuildSchema = z
  .object({
    action: z.literal('create_build'),
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
  createBuildSchema,
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

function objectField(value: unknown, field: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const fieldValue = value[field];
  return isRecord(fieldValue) ? fieldValue : null;
}

function requesterTypeFrom(
  value: string | null,
): DataProductWorkerJobRequest['requesterType'] | null {
  if (value === 'user' || value === 'system' || value === 'service' || value === 'operator') {
    return value;
  }

  return null;
}

function visibilityFrom(value: string | null): DataProductWorkerJobRequest['visibility'] {
  if (value === 'user' || value === 'operator' || value === 'system') {
    return value;
  }

  return null;
}

function workerJobFrom(value: Record<string, unknown>): DataProductWorkerJobRequest | null {
  const jobKind = stringField(value, 'jobKind');
  const payload = objectField(value, 'payload');
  const payloadSchemaVersion = stringField(value, 'payloadSchemaVersion');
  const subjectType = stringField(value, 'subjectType');
  const subjectId = stringField(value, 'subjectId');
  const requestedBy = stringField(value, 'requestedBy');
  const requesterType = requesterTypeFrom(stringField(value, 'requesterType'));

  if (
    !jobKind ||
    !payload ||
    !payloadSchemaVersion ||
    !subjectType ||
    !subjectId ||
    !requestedBy ||
    !requesterType
  ) {
    return null;
  }

  return {
    jobKind,
    payload,
    payloadSchemaVersion,
    subjectType,
    subjectId,
    subjectVersion: stringField(value, 'subjectVersion'),
    requestedBy,
    requesterType,
    requestHash: stringField(value, 'requestHash'),
    queueKey: stringField(value, 'queueKey'),
    visibility: visibilityFrom(stringField(value, 'visibility')),
  };
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
    case 'create_build':
      return buildCommandAuditPayload({
        command: 'lcia_result_build_request',
        actorUserId: actor.userId,
        targetTable: 'worker_jobs',
        targetId: 'pending',
        targetVersion: '',
        payload: {
          coverageMode: request.coverageMode,
          defaultImpactCategory: request.defaultImpactCategory ?? null,
        },
      });
    case 'publish_package':
      return buildCommandAuditPayload({
        command: 'lcia_result_package_publish',
        actorUserId: actor.userId,
        targetTable: 'lcia_result_packages',
        targetId: request.packageId,
        targetVersion: '',
        payload: {
          displayDefaultImpactCategory: request.displayDefaultImpactCategory ?? null,
          reason: request.reason ?? null,
        },
      });
    case 'unpublish_publication':
      return buildCommandAuditPayload({
        command: 'lcia_result_publication_unpublish',
        actorUserId: actor.userId,
        targetTable: 'lcia_result_publications',
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

async function executeCreateBuild(
  request: DataProductBuildCreateRequest,
  actor: ActorContext,
  repository: DataProductCommandRepository,
): Promise<DataProductCommandExecutionResult> {
  const audit = auditFor(request, actor)!;
  const result = await repository.createBuild(request, audit);
  if (!result.ok) {
    return result;
  }

  const buildId = stringField(result.data, 'buildId');
  if (!buildId) {
    return {
      ok: false,
      code: 'lcia_result_build_id_missing',
      status: 502,
      message: 'LCIA result build RPC did not return a buildId',
      details: result.data,
    };
  }

  const workerJobEnvelope = objectField(result.data, 'workerJob');
  const workerJobRequest = workerJobFrom(workerJobEnvelope ?? {});
  if (!workerJobRequest) {
    return {
      ok: false,
      code: 'lcia_result_worker_job_request_missing',
      status: 502,
      message: 'LCIA result build RPC did not return a valid worker job request',
      details: result.data,
    };
  }

  const workerJob = await repository.enqueuePackageBuild(
    {
      buildId,
      workerJob: workerJobRequest,
      idempotencyKey:
        stringField(workerJobEnvelope, 'idempotencyKey') ?? `lcia_result.package_build:${buildId}`,
    },
    actor,
  );
  if (!workerJob.ok) {
    return {
      ok: false,
      code: 'worker_jobs_enqueue_failed',
      status: workerJob.status,
      message: 'Failed to enqueue LCIA result package build',
      details: {
        buildId,
        error: workerJob.error,
        details: workerJob.details ?? null,
      },
    };
  }

  if (!workerJob.workerJobId) {
    return {
      ok: false,
      code: 'lcia_result_worker_job_id_missing',
      status: 502,
      message: 'Worker enqueue RPC did not return a worker job id',
      details: workerJob.data,
    };
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      command: 'lcia_result_build_request',
      data: {
        ...(isRecord(result.data) ? result.data : { buildId }),
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
    case 'create_build':
      return executeCreateBuild(request, actor, repository);
    case 'preview_package': {
      const result = await repository.previewPackage(request);
      if (!result.ok) {
        return result;
      }
      return {
        ok: true,
        body: {
          ok: true,
          command: 'lcia_result_package_preview',
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
          command: 'lcia_result_package_publish',
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
          command: 'lcia_result_publication_unpublish',
          data: result.data,
        },
      };
    }
  }
}
