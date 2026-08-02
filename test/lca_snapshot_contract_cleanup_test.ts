import { assert, assertEquals } from 'jsr:@std/assert';

import { finishLcaSnapshotContract } from './lca_snapshot_contract_cleanup.ts';

Deno.test(
  'snapshot contract cleanup continues after failures and preserves primary error',
  async () => {
    const calls: string[] = [];
    const primary = new Error('injected-primary');
    let thrown: unknown;
    try {
      await finishLcaSnapshotContract({
        primaryError: primary,
        cleanupSteps: [
          {
            label: 'sign-out',
            async run() {
              calls.push('sign-out');
              throw new Error('injected-sign-out');
            },
          },
          {
            label: 'delete-user',
            async run() {
              calls.push('delete-user');
            },
          },
          {
            label: 'delete-rows',
            async run() {
              calls.push('delete-rows');
            },
          },
        ],
        async readback() {
          calls.push('readback');
          throw new Error('injected-residue');
        },
      });
    } catch (error) {
      thrown = error;
    }

    assert(thrown instanceof AggregateError);
    assertEquals(thrown.errors.length, 3);
    assertEquals(thrown.errors[0], primary);
    assert(String(thrown.errors[1]).includes('cleanup:sign-out'));
    assert(String(thrown.errors[2]).includes('cleanup:independent-readback'));
    assertEquals(calls, ['sign-out', 'delete-user', 'delete-rows', 'readback']);
  },
);

Deno.test('snapshot contract cleanup reports cleanup-only failures', async () => {
  let thrown: unknown;
  try {
    await finishLcaSnapshotContract({
      cleanupSteps: [
        {
          label: 'delete-seed',
          async run() {
            throw new Error('injected-delete');
          },
        },
      ],
      async readback() {},
    });
  } catch (error) {
    thrown = error;
  }
  assert(thrown instanceof AggregateError);
  assertEquals(thrown.errors.length, 1);
  assert(String(thrown.errors[0]).includes('cleanup:delete-seed'));
});
