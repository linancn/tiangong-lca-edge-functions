export type ResultContractCleanupStep = {
  label: string;
  run(): Promise<void>;
};

function labeled(label: string, error: unknown): Error {
  return new Error(`${label} failed`, { cause: error });
}

export async function finishLcaResultContract(options: {
  primaryError?: unknown;
  cleanupSteps: readonly ResultContractCleanupStep[];
  readback(): Promise<void>;
}): Promise<void> {
  const cleanupErrors: Error[] = [];
  for (const step of options.cleanupSteps) {
    try {
      await step.run();
    } catch (error) {
      cleanupErrors.push(labeled(`cleanup:${step.label}`, error));
    }
  }
  try {
    await options.readback();
  } catch (error) {
    cleanupErrors.push(labeled('cleanup:independent-readback', error));
  }
  if (options.primaryError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      [...(options.primaryError === undefined ? [] : [options.primaryError]), ...cleanupErrors],
      'LCA result-family capability contract or cleanup failed',
    );
  }
}
