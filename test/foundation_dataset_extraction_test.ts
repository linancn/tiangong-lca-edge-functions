import { assertEquals, assertStringIncludes, assertThrows } from 'jsr:@std/assert';

import { generateFoundationDatasetMarkdown } from '../supabase/functions/_shared/foundation_dataset_extraction.ts';

Deno.test('contact Markdown is deterministic, multilingual, and searchable', () => {
  const input = {
    contactDataSet: {
      contactInformation: {
        dataSetInformation: {
          'common:UUID': '11111111-1111-4111-8111-111111111111',
          'common:name': [
            { '@xml:lang': 'zh', '#text': '示例联系人' },
            { '@xml:lang': 'en', '#text': 'Example Contact' },
          ],
          'common:shortName': [{ '@xml:lang': 'en', '#text': 'E. Contact' }],
          classificationInformation: {
            'common:classification': {
              'common:class': [
                { '@level': 1, '#text': 'Researchers' },
                { '@level': 0, '#text': 'People' },
              ],
            },
          },
          email: 'contact@example.test',
          contactDescriptionOrComment: [{ '@xml:lang': 'en', '#text': 'LCA methodology contact.' }],
        },
      },
      administrativeInformation: {
        publicationAndOwnership: { 'common:dataSetVersion': '01.01.000' },
      },
    },
  };

  const first = generateFoundationDatasetMarkdown('contact', input);
  const second = generateFoundationDatasetMarkdown('contact', JSON.stringify(input));

  assertEquals(first, second);
  assertStringIncludes(first, '# Example Contact');
  assertStringIncludes(first, '**Classification:** People > Researchers');
  assertStringIncludes(first, '**Email:** contact@example.test');
  assertStringIncludes(first, 'LCA methodology contact.');
});

Deno.test('flow property Markdown includes synonyms and reference unit group', () => {
  const markdown = generateFoundationDatasetMarkdown('flowproperty', {
    flowPropertyDataSet: {
      flowPropertiesInformation: {
        dataSetInformation: {
          'common:name': { '@xml:lang': 'en', '#text': 'Net calorific value' },
          'common:synonyms': [
            { '@xml:lang': 'en', '#text': 'Lower heating value' },
            { '@xml:lang': 'zh', '#text': '低位热值' },
          ],
        },
        quantitativeReference: {
          referenceToReferenceUnitGroup: {
            'common:shortDescription': { '@xml:lang': 'en', '#text': 'Energy per mass' },
          },
        },
      },
    },
  });

  assertStringIncludes(markdown, '**Entity:** Flow Property');
  assertStringIncludes(markdown, '**Synonyms:** Lower heating value | 低位热值');
  assertStringIncludes(markdown, '**Reference Unit Group:** Energy per mass');
});

Deno.test('source Markdown includes citation, publication type, and description', () => {
  const markdown = generateFoundationDatasetMarkdown('source', {
    sourceDataSet: {
      sourceInformation: {
        dataSetInformation: {
          'common:shortName': { '@xml:lang': 'en', '#text': 'IPCC 2025' },
          sourceCitation: 'IPCC inventory guidelines',
          publicationType: 'Technical report',
          sourceDescriptionOrComment: { '@xml:lang': 'en', '#text': 'Reviewed source.' },
        },
      },
    },
  });

  assertStringIncludes(markdown, '# IPCC 2025');
  assertStringIncludes(markdown, '**Citation:** IPCC inventory guidelines');
  assertStringIncludes(markdown, '**Publication Type:** Technical report');
  assertStringIncludes(markdown, 'Reviewed source.');
});

Deno.test('unit group Markdown marks the reference unit and retains alternatives', () => {
  const markdown = generateFoundationDatasetMarkdown('unitgroup', {
    unitGroupDataSet: {
      unitGroupInformation: {
        dataSetInformation: {
          'common:name': { '@xml:lang': 'en', '#text': 'Units of mass' },
        },
        quantitativeReference: { referenceToReferenceUnit: '1' },
      },
      units: {
        unit: [
          { '@dataSetInternalID': '1', name: 'kg', meanValue: 1 },
          { '@dataSetInternalID': '2', name: 'g', meanValue: 0.001 },
        ],
      },
    },
  });

  assertStringIncludes(markdown, '- kg (reference, 1)');
  assertStringIncludes(markdown, '- g (0.001)');
});

Deno.test('foundation Markdown rejects mismatched document roots', () => {
  assertThrows(
    () => generateFoundationDatasetMarkdown('contact', { sourceDataSet: {} }),
    Error,
    'missing contactDataSet',
  );
});
