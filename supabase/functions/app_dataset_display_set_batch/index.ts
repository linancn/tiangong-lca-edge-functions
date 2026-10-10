import '@supabase/functions-js/edge-runtime.d.ts';

import {
  createCommandHandler,
  type CommandHandlerOptions,
} from '../_shared/command_runtime/command.ts';
import {
  executeDatasetDisplay,
  type DatasetDisplayRequest,
  parseDatasetDisplayRequest,
} from '../_shared/commands/dataset_display.ts';

export function createAppDatasetDisplaySetBatchHandler(
  overrides: Partial<CommandHandlerOptions<DatasetDisplayRequest>> = {},
) {
  return createCommandHandler<DatasetDisplayRequest>({
    parse: parseDatasetDisplayRequest,
    execute: executeDatasetDisplay,
    ...overrides,
  });
}

export const handleAppDatasetDisplaySetBatch = createAppDatasetDisplaySetBatchHandler();

if (import.meta.main) {
  Deno.serve(handleAppDatasetDisplaySetBatch);
}
