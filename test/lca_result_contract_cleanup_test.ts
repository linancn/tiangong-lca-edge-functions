import { assert, assertEquals } from 'jsr:@std/assert';

import { finishLcaResultContract } from './lca_result_contract_cleanup.ts';

Deno.test(
  'result contract cleanup runs every step and preserves primary/readback failures',
  async () => {
    const calls: string[] = [];
    const primary = new Error('primary');
    let thrown: unknown;
    try {
      await finishLcaResultContract({
        primaryError: primary,
        cleanupSteps: [
          {
            label: 'first',
            async run() {
              calls.push('first');
              throw new Error('first failed');
            },
          },
          {
            label: 'second',
            async run() {
              calls.push('second');
            },
          },
        ],
        async readback() {
          calls.push('readback');
          throw new Error('residue');
        },
      });
    } catch (error) {
      thrown = error;
    }
    assert(thrown instanceof AggregateError);
    assertEquals(thrown.errors.length, 3);
    assertEquals(thrown.errors[0], primary);
    assertEquals(calls, ['first', 'second', 'readback']);
  },
);
