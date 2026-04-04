import type {
  AssignTeamRequest,
  DatasetCommandFailure,
  PublishRequest,
  SaveDraftRequest,
} from './types.ts';

function invalidInput(code: string, message: string): DatasetCommandFailure {
  return {
    ok: false,
    code,
    message,
    status: 400,
  };
}

export function assertSaveDraftPolicy(
  request: SaveDraftRequest,
): { ok: true } | DatasetCommandFailure {
  if (request.table === 'processes' && !request.modelId) {
    return invalidInput('MODEL_ID_REQUIRED', 'modelId is required for process dataset drafts');
  }

  if (request.table !== 'processes' && request.modelId) {
    return invalidInput(
      'MODEL_ID_NOT_ALLOWED',
      'modelId is only allowed for process dataset drafts',
    );
  }

  return { ok: true };
}

export function assertAssignTeamPolicy(
  _request: AssignTeamRequest,
): { ok: true } | DatasetCommandFailure {
  return { ok: true };
}

export function assertPublishPolicy(
  _request: PublishRequest,
): { ok: true } | DatasetCommandFailure {
  return { ok: true };
}
