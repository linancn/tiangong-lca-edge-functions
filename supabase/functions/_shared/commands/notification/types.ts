export type NotificationSendValidationIssueRequest = {
  recipientUserId: string;
  sourceDatasetType: string;
  sourceDatasetId: string;
  sourceDatasetVersion: string;
  datasetType: string;
  datasetId: string;
  datasetVersion: string;
  link?: string | null;
  issueCodes?: string[];
  tabNames?: string[];
  issueCount?: number;
};

export type NotificationCommandFailure = {
  ok: false;
  code: string;
  message: string;
  status: number;
  details?: unknown;
};

export type NotificationCommandExecutionResult =
  | { ok: true; body: unknown; status?: number }
  | NotificationCommandFailure;
