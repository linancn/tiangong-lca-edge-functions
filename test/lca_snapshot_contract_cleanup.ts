export type ContractCleanupStep = {
  label: string;
  run(): Promise<void>;
};

function asError(label: string, error: unknown): Error {
  return new Error(`${label} failed`, { cause: error });
}

export async function finishLcaSnapshotContract(options: {
  primaryError?: unknown;
  cleanupSteps: readonly ContractCleanupStep[];
  readback: () => Promise<void>;
}): Promise<void> {
  const cleanupErrors: Error[] = [];
  for (const step of options.cleanupSteps) {
    try {
      await step.run();
    } catch (error) {
      cleanupErrors.push(asError(`cleanup:${step.label}`, error));
    }
  }
  try {
    await options.readback();
  } catch (error) {
    cleanupErrors.push(asError('cleanup:independent-readback', error));
  }

  if (options.primaryError !== undefined && cleanupErrors.length === 0) {
    throw options.primaryError;
  }
  if (options.primaryError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [...(options.primaryError !== undefined ? [options.primaryError] : []), ...cleanupErrors],
      'LCA snapshot capability contract or cleanup failed',
    );
  }
}
