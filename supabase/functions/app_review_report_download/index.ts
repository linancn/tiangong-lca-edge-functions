import '@supabase/functions-js/edge-runtime.d.ts';

import {
  type CommandHandlerOptions,
  createCommandHandler,
} from '../_shared/command_runtime/command.ts';
import {
  executeReviewReportDownloadCommand,
  parseReviewReportDownloadCommand,
} from '../_shared/commands/review/report_download.ts';
import type { ReviewReportDownloadRequest } from '../_shared/commands/review/types.ts';

export function createAppReviewReportDownloadHandler(
  overrides: Partial<CommandHandlerOptions<ReviewReportDownloadRequest>> = {},
) {
  return createCommandHandler<ReviewReportDownloadRequest>({
    parse: parseReviewReportDownloadCommand,
    execute: executeReviewReportDownloadCommand,
    ...overrides,
  });
}

export const handleAppReviewReportDownload = createAppReviewReportDownloadHandler();

if (import.meta.main) {
  Deno.serve(handleAppReviewReportDownload);
}
