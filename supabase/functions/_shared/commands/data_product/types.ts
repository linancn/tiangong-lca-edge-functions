export type DataProductCoverageMode = 'global_eligible' | 'subset';

export type DataProductProcessSelection = {
  id: string;
  version: string;
};

export type DataProductBuildCreateRequest = {
  action: 'create_build';
  name: string;
  processes?: DataProductProcessSelection[];
  coverageMode: DataProductCoverageMode;
  defaultImpactCategory?: string;
  lciaMethodSet: unknown[];
  idempotencyKey?: string;
};

export type DataProductPackagePreviewRequest = {
  action: 'preview_package';
  packageId: string;
};

export type DataProductPackagePublishRequest = {
  action: 'publish_package';
  packageId: string;
  displayDefaultImpactCategory?: string;
  reason?: string;
};

export type DataProductPackageUnpublishRequest = {
  action: 'unpublish_publication';
  publicationId: string;
  reason?: string;
};

export type DataProductCommandRequest =
  | DataProductBuildCreateRequest
  | DataProductPackagePreviewRequest
  | DataProductPackagePublishRequest
  | DataProductPackageUnpublishRequest;

export type DataProductCommandFailure = {
  ok: false;
  code: string;
  message: string;
  status: number;
  details?: unknown;
};

export type DataProductCommandExecutionResult =
  | { ok: true; body: unknown; status?: number }
  | DataProductCommandFailure;

export type DataProductPackageBuildRequest = {
  buildId: string;
  workerJob: DataProductWorkerJobRequest;
  idempotencyKey: string;
};

export type DataProductWorkerJobRequest = {
  jobKind: string;
  payload: Record<string, unknown>;
  payloadSchemaVersion: string;
  subjectType: string;
  subjectId: string;
  subjectVersion?: string | null;
  requestedBy: string;
  requesterType: 'user' | 'system' | 'service' | 'operator';
  requestHash?: string | null;
  queueKey?: string | null;
  visibility?: 'user' | 'operator' | 'system' | null;
};
