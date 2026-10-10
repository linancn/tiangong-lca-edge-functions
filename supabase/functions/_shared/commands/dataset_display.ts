import type { ActorContext } from '../command_runtime/actor_context.ts';
import type { CommandExecutionResult, CommandParseResult } from '../command_runtime/command.ts';

export type DatasetDisplayItem = {
  datasetKind: string;
  id: string;
  version: string;
};

export type DatasetDisplayRequest = {
  items: DatasetDisplayItem[];
  isVisible: boolean;
};

const DATASET_KINDS = new Set([
  'lifecyclemodel',
  'process',
  'flow',
  'flowproperty',
  'unitgroup',
  'source',
  'contact',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const VERSION_PATTERN = /^\d{2}\.\d{2}\.\d{3}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseDatasetDisplayRequest(
  body: unknown,
): CommandParseResult<DatasetDisplayRequest> {
  if (
    !isRecord(body) ||
    !Array.isArray(body.items) ||
    typeof body.isVisible !== 'boolean' ||
    Object.keys(body).some((key) => key !== 'items' && key !== 'isVisible')
  ) {
    return { ok: false, message: 'items must be an array and isVisible a boolean' };
  }
  if (body.items.length < 1 || body.items.length > 100) {
    return { ok: false, message: 'items must contain between 1 and 100 exact dataset versions' };
  }

  const items: DatasetDisplayItem[] = [];
  for (const value of body.items) {
    if (
      !isRecord(value) ||
      Object.keys(value).some((key) => key !== 'datasetKind' && key !== 'id' && key !== 'version')
    ) {
      return { ok: false, message: 'each item must contain only datasetKind, id and version' };
    }
    const id = typeof value.id === 'string' ? value.id.trim().toLowerCase() : '';
    const version = typeof value.version === 'string' ? value.version.trim() : '';
    const datasetKind = typeof value.datasetKind === 'string' ? value.datasetKind : '';
    if (
      !DATASET_KINDS.has(datasetKind) ||
      !UUID_PATTERN.test(id) ||
      !VERSION_PATTERN.test(version)
    ) {
      return {
        ok: false,
        message: 'each item must contain a supported datasetKind, valid id and version',
      };
    }
    items.push({ datasetKind, id, version });
  }

  return { ok: true, value: { items, isVisible: body.isVisible } };
}

function rpcFailure(error: { code?: string; message?: string; details?: unknown }) {
  const code = error.code ?? 'DATASET_DISPLAY_FAILED';
  const status = code === '42501' ? 403 : code === '28000' ? 401 : code === '22023' ? 400 : 500;
  return {
    ok: false as const,
    code,
    status,
    message: error.message ?? 'Dataset display configuration failed',
    details: error.details ?? null,
  };
}

export async function executeDatasetDisplay(
  request: DatasetDisplayRequest,
  actor: ActorContext,
): Promise<CommandExecutionResult> {
  const { data, error } = await actor.supabase.rpc('cmd_dataset_display_set_batch', {
    p_items: request.items,
    p_is_visible: request.isVisible,
  });
  if (error) {
    return rpcFailure(error);
  }

  const payload = isRecord(data) ? data.data : null;
  if (
    !isRecord(data) ||
    data.ok !== true ||
    !isRecord(payload) ||
    payload.isVisible !== request.isVisible ||
    !['inputCount', 'requestedCount', 'changedCount', 'unchangedCount'].every(
      (key) => Number.isInteger(payload[key]) && (payload[key] as number) >= 0,
    ) ||
    payload.requestedCount !== (payload.changedCount as number) + (payload.unchangedCount as number)
  ) {
    return {
      ok: false,
      code: 'DATASET_DISPLAY_INVALID_RESPONSE',
      status: 502,
      message: 'Dataset display configuration returned an invalid response',
    };
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      command: 'dataset_display_set_batch',
      data: data.data,
    },
  };
}
