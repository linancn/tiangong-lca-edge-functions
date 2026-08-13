import { assertEquals } from 'jsr:@std/assert';

import { generateFlowMarkdown } from '../supabase/functions/_shared/flow_extraction.ts';
import { generateFoundationDatasetMarkdown } from '../supabase/functions/_shared/foundation_dataset_extraction.ts';
import { tidasLifeCycleModelToMarkdown } from '../supabase/functions/webhook_model_embedding_ft/index.ts';
import { tidasProcessToMarkdown } from '../supabase/functions/webhook_process_embedding_ft/index.ts';

Deno.test('extracted_md snapshot remains byte-stable for all current generators', () => {
  assertEquals(
    generateFlowMarkdown({
      flowDataSet: {
        flowInformation: {
          dataSetInformation: {
            'common:UUID': '00000000-0000-4000-8000-000000000001',
            name: { baseName: [{ '@xml:lang': 'en', '#text': 'Snapshot flow' }] },
          },
        },
        administrativeInformation: {
          publicationAndOwnership: { 'common:dataSetVersion': '01.00.000' },
        },
      },
    }),
    '# Snapshot flow\n\n**Entity:** Flow\n**UUID:** `00000000-0000-4000-8000-000000000001`\n**Version:** 01.00.000',
  );

  assertEquals(
    generateFoundationDatasetMarkdown('contact', {
      contactDataSet: {
        contactInformation: {
          dataSetInformation: {
            'common:UUID': '00000000-0000-4000-8000-000000000002',
            'common:name': { '@xml:lang': 'en', '#text': 'Snapshot contact' },
          },
        },
      },
    }),
    '# Snapshot contact\n\n**Entity:** Contact\n**UUID:** `00000000-0000-4000-8000-000000000002`',
  );

  assertEquals(
    tidasProcessToMarkdown({
      processDataSet: {
        processInformation: {
          dataSetInformation: {
            'common:UUID': '00000000-0000-4000-8000-000000000003',
            name: { baseName: [{ '@xml:lang': 'en', '#text': 'Snapshot process' }] },
          },
        },
      },
    }),
    '# Snapshot process\n\n**Entity:** Process\n**UUID:** `00000000-0000-4000-8000-000000000003`',
  );

  assertEquals(
    tidasLifeCycleModelToMarkdown({
      lifeCycleModelDataSet: {
        lifeCycleModelInformation: {
          dataSetInformation: {
            'common:UUID': '00000000-0000-4000-8000-000000000004',
            name: { baseName: [{ '@xml:lang': 'en', '#text': 'Snapshot model' }] },
          },
        },
      },
    }),
    '# Snapshot model\n\n**Entity:** Life Cycle Model\n**UUID:** `00000000-0000-4000-8000-000000000004`',
  );
});
