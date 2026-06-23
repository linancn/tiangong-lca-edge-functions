export type DataProductCoverageMode = 'global_eligible' | 'subset';

export type DataProductProcessSelection = {
  id: string;
  version: string;
};

export type DataProductRunCreateRequest = {
  action: 'create_run';
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
  | DataProductRunCreateRequest
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
  runId: string;
  sourceCommand: DataProductRunCreateRequest;
  idempotencyKey: string;
};
