export const DATASET_TABLES = [
  'contacts',
  'sources',
  'unitgroups',
  'flowproperties',
  'flows',
  'processes',
  'lifecyclemodels',
] as const;

export type DatasetTable = (typeof DATASET_TABLES)[number];

export type SaveDraftRequest = {
  table: DatasetTable;
  id: string;
  version: string;
  jsonOrdered: unknown;
  modelId?: string;
  ruleVerification?: boolean | null;
};

export type CreateRequest = {
  table: DatasetTable;
  id: string;
  jsonOrdered: unknown;
  modelId?: string | null;
  ruleVerification?: boolean | null;
};

export type DeleteRequest = {
  table: DatasetTable;
  id: string;
  version: string;
};

export type AssignTeamRequest = {
  table: DatasetTable;
  id: string;
  version: string;
  teamId: string;
};

export type PublishRequest = {
  table: DatasetTable;
  id: string;
  version: string;
};

export type SubmitReviewRequest = {
  table: DatasetTable;
  id: string;
  version: string;
};

export type DatasetCommandFailure = {
  ok: false;
  code: string;
  message: string;
  status: number;
  details?: unknown;
};

export type DatasetCommandExecutionResult =
  | { ok: true; body: unknown; status?: number }
  | DatasetCommandFailure;
