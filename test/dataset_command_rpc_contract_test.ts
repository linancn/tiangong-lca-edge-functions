import { assertEquals, assertThrows } from 'jsr:@std/assert';

import { createDatasetCommandRepository } from '../supabase/functions/_shared/commands/dataset/repository.ts';
import { saveDraftRequestSchema } from '../supabase/functions/_shared/commands/dataset/save_draft.ts';

Deno.test('saveDraftRequestSchema rejects server-owned ruleVerification input', () => {
  const parsed = saveDraftRequestSchema.safeParse({
    table: 'flows',
    id: '11111111-1111-4111-8111-111111111111',
    version: '01.00.000',
    jsonOrdered: {},
    ruleVerification: true,
  });

  assertEquals(parsed.success, false);
});

Deno.test('createDatasetCommandRepository requires an explicit Supabase client', () => {
  assertThrows(
    () => createDatasetCommandRepository(undefined as never),
    Error,
    'Dataset command repository requires an explicit Supabase client',
  );
});
