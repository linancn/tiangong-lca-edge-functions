import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert';

import {
  projectContactSearchText,
  projectFlowPropertySearchText,
  projectFlowSearchText,
  projectLifecycleModelSearchText,
  projectProcessSearchText,
  projectSearchText,
  projectSourceSearchText,
  projectUnitGroupSearchText,
  type SearchTextDatasetKind,
} from '../supabase/functions/_shared/search_text_projection.ts';

const PROCESS_UUID = '11111111-1111-4111-8111-111111111111';
const FLOW_UUID = '22222222-2222-4222-8222-222222222222';
const MODEL_UUID = '33333333-3333-4333-8333-333333333333';
const CONTACT_UUID = '44444444-4444-4444-8444-444444444444';
const PROPERTY_UUID = '55555555-5555-4555-8555-555555555555';
const SOURCE_UUID = '66666666-6666-4666-8666-666666666666';
const UNIT_GROUP_UUID = '77777777-7777-4777-8777-777777777777';

const PROCESS_FIXTURE = {
  processDataSet: {
    processInformation: {
      dataSetInformation: {
        'common:UUID': PROCESS_UUID,
        name: {
          baseName: [
            { '@xml:lang': 'zh', '#text': '中文流程' },
            { '@xml:lang': 'en', '#text': 'English process' },
            { '@xml:lang': 'de', '#text': 'Deutscher Prozess' },
          ],
          treatmentStandardsRoutes: [{ '@xml:lang': 'fr', '#text': 'voie française' }],
          mixAndLocationTypes: [{ '@xml:lang': 'en', '#text': 'market mix' }],
          functionalUnitFlowProperties: [{ '@xml:lang': 'en', '#text': 'mass' }],
        },
        identifierOfSubDataSet: 'SUB-1',
        'common:synonyms': [{ '@xml:lang': 'en', '#text': 'same-value' }],
        classificationInformation: {
          'common:classification': {
            'common:class': [
              { '@level': 1, '#text': 'Class child' },
              { '@level': 0, '#text': 'Class root' },
            ],
          },
        },
        'common:generalComment': [{ '@xml:lang': 'en', '#text': 'same-value' }],
      },
      quantitativeReference: {
        functionalUnitOrOther: [{ '@xml:lang': 'en', '#text': 'one kilogram' }],
        referenceToReferenceFlow: 'ref-flow-1',
      },
      time: {
        'common:timeRepresentativenessDescription': [
          { '@xml:lang': 'en', '#text': '2024 production period' },
        ],
      },
      geography: {
        locationOfOperationSupplyOrProduction: {
          '@location': 'CN',
          descriptionOfRestrictions: [{ '@xml:lang': 'zh', '#text': '区域限制' }],
        },
        subLocationOfOperationSupplyOrProduction: [
          {
            '@subLocation': 'CN-31',
            descriptionOfRestrictions: [{ '@xml:lang': 'en', '#text': 'Shanghai only' }],
          },
        ],
      },
      technology: {
        technologyDescriptionAndIncludedProcesses: [
          { '@xml:lang': 'en', '#text': 'Included kiln process' },
        ],
        technologicalApplicability: [{ '@xml:lang': 'en', '#text': 'Industrial kiln' }],
      },
    },
    modellingAndValidation: {
      LCIMethodAndAllocation: {
        LCIMethodPrinciple: 'Attributional',
        deviationsFromLCIMethodPrinciple: [{ '@xml:lang': 'en', '#text': 'No deviation' }],
        LCIMethodApproaches: 'Cut-off',
        deviationsFromLCIMethodApproaches: [{ '@xml:lang': 'en', '#text': 'None' }],
        modellingConstants: [{ '@xml:lang': 'en', '#text': 'constant A' }],
        deviationsFromModellingConstants: [{ '@xml:lang': 'en', '#text': 'No constant deviation' }],
      },
      dataSourcesTreatmentAndRepresentativeness: {
        dataCutOffAndCompletenessPrinciples: [{ '@xml:lang': 'en', '#text': 'complete' }],
        deviationsFromCutOffAndCompletenessPrinciples: [{ '@xml:lang': 'en', '#text': 'none' }],
        dataSelectionAndCombinationPrinciples: [{ '@xml:lang': 'en', '#text': 'measured' }],
        deviationsFromSelectionAndCombinationPrinciples: [{ '@xml:lang': 'en', '#text': 'none' }],
        dataTreatmentAndExtrapolationsPrinciples: [{ '@xml:lang': 'en', '#text': 'direct' }],
        deviationsFromTreatmentAndExtrapolationPrinciples: [{ '@xml:lang': 'en', '#text': 'none' }],
        samplingProcedure: [{ '@xml:lang': 'en', '#text': 'random' }],
        dataCollectionPeriod: [{ '@xml:lang': 'en', '#text': '2024' }],
        uncertaintyAdjustments: [{ '@xml:lang': 'en', '#text': 'low' }],
        useAdviceForDataSet: [{ '@xml:lang': 'en', '#text': 'Use for kiln studies' }],
      },
    },
    exchanges: {
      exchange: [
        {
          internalId: 'ref-flow-1',
          amount: 'EXCLUDED-AMOUNT',
          referenceToFlowDataSet: {
            '@refObjectId': 'REF-UUID',
            'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Reference product' }],
          },
        },
        {
          internalId: 'other-flow',
          referenceToFlowDataSet: {
            'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'EXCLUDED-NON-REFERENCE' }],
          },
        },
      ],
    },
    administrativeInformation: {
      publicationAndOwnership: { 'common:dataSetVersion': 'EXCLUDED-VERSION' },
    },
  },
};

const FLOW_FIXTURE = {
  flowDataSet: {
    flowInformation: {
      dataSetInformation: {
        'common:UUID': FLOW_UUID,
        name: {
          baseName: [{ '@xml:lang': 'en', '#text': 'English flow' }],
          treatmentStandardsRoutes: [{ '@xml:lang': 'zh', '#text': '处理路线' }],
          mixAndLocationTypes: [{ '@xml:lang': 'de', '#text': 'Mischung' }],
          flowProperties: [{ '@xml:lang': 'en', '#text': 'Mass' }],
        },
        'common:synonyms': [{ '@xml:lang': 'en', '#text': 'same-value' }],
        classificationInformation: {
          'common:elementaryFlowCategorization': {
            'common:category': [{ '@level': 0, '#text': 'Emissions' }],
          },
          'common:classification': {
            'common:class': [{ '@level': 0, '#text': 'Product' }],
          },
        },
        CASNumber: '50-00-0',
        'common:other': { 'ecn:ECNumber': '200-001-8' },
        sumFormula: 'CH2O',
        'common:generalComment': [{ '@xml:lang': 'fr', '#text': 'Commentaire' }],
      },
      geography: { locationOfSupply: { '@location': 'GLO' } },
      technology: { technologicalApplicability: [{ '@xml:lang': 'en', '#text': 'All sites' }] },
    },
    flowProperties: {
      flowProperty: [
        {
          dataSetInternalID: '0',
          meanValue: 'EXCLUDED-MEAN',
          referenceToFlowPropertyDataSet: [
            {
              '@refObjectId': 'FLOW-PROPERTY-UUID',
              'common:shortDescription': [
                { '@xml:lang': 'en', '#text': 'Mass property' },
                { '@xml:lang': 'zh', '#text': '质量属性' },
              ],
            },
          ],
        },
      ],
    },
    administrativeInformation: {
      publicationAndOwnership: { 'common:dataSetVersion': 'EXCLUDED-VERSION' },
    },
  },
};

const LIFECYCLE_MODEL_FIXTURE = {
  lifeCycleModelDataSet: {
    lifeCycleModelInformation: {
      dataSetInformation: {
        'common:UUID': MODEL_UUID,
        name: {
          baseName: [{ '@xml:lang': 'en', '#text': 'Model name' }],
          treatmentStandardsRoutes: [{ '@xml:lang': 'de', '#text': 'Route' }],
          mixAndLocationTypes: [{ '@xml:lang': 'zh', '#text': '组合' }],
          functionalUnitFlowProperties: [{ '@xml:lang': 'fr', '#text': 'unité' }],
        },
        classificationInformation: {
          'common:classification': {
            'common:class': [{ '@level': 0, '#text': 'Model class' }],
          },
        },
        'common:generalComment': [{ '@xml:lang': 'en', '#text': 'Model description' }],
        referenceToResultingProcess: [
          {
            '@refObjectId': 'RESULTING-PROCESS-UUID',
            'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Resulting process' }],
          },
        ],
        referenceToExternalDocumentation: {
          '@uri': 'https://excluded.example.test/doc',
          'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'External guide' }],
        },
      },
      technology: {
        groupDeclarations: {
          group: [{ groupName: [{ '@xml:lang': 'en', '#text': 'Foreground group' }] }],
        },
        processes: {
          processInstance: [
            {
              '@dataSetInternalID': 'INSTANCE-ID',
              scalingFactor: 'EXCLUDED-SCALE',
              referenceToProcess: {
                '@refObjectId': 'PROCESS-UUID',
                'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Model process' }],
              },
            },
          ],
        },
      },
    },
    modellingAndValidation: {
      dataSourcesTreatmentEtc: {
        useAdviceForDataSet: [{ '@xml:lang': 'en', '#text': 'Model use advice' }],
      },
    },
    administrativeInformation: {
      publicationAndOwnership: { 'common:dataSetVersion': 'EXCLUDED-VERSION' },
    },
  },
};

const CONTACT_FIXTURE = {
  contactDataSet: {
    contactInformation: {
      dataSetInformation: {
        'common:UUID': CONTACT_UUID,
        'common:name': [
          { '@xml:lang': 'en', '#text': 'Alice' },
          { '@xml:lang': 'zh', '#text': '爱丽丝' },
        ],
        'common:shortName': [{ '@xml:lang': 'de', '#text': 'A. Beispiel' }],
        classificationInformation: {
          'common:classification': { 'common:class': [{ '#text': 'Researcher' }] },
        },
        contactAddress: [{ '@xml:lang': 'en', '#text': '1 Main Street' }],
        email: 'alice@example.test',
        telephone: '+1-555-0100',
        telefax: '+1-555-0101',
        centralContactPoint: [{ '@xml:lang': 'en', '#text': 'Central desk' }],
        contactDescriptionOrComment: [{ '@xml:lang': 'en', '#text': 'Contact notes' }],
        WWWAddress: 'EXCLUDED-WEBSITE',
      },
    },
  },
};

const FLOW_PROPERTY_FIXTURE = {
  flowPropertyDataSet: {
    flowPropertiesInformation: {
      dataSetInformation: {
        'common:UUID': PROPERTY_UUID,
        'common:name': [{ '@xml:lang': 'en', '#text': 'Net calorific value' }],
        'common:synonyms': [{ '@xml:lang': 'zh', '#text': '低位热值' }],
        classificationInformation: {
          'common:classification': { 'common:class': [{ '#text': 'Energy' }] },
        },
        'common:generalComment': [{ '@xml:lang': 'en', '#text': 'Energy value' }],
      },
      quantitativeReference: {
        referenceToReferenceUnitGroup: [
          {
            '@refObjectId': 'UNIT-GROUP-UUID',
            'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Energy per mass' }],
          },
        ],
      },
    },
  },
};

const SOURCE_FIXTURE = {
  sourceDataSet: {
    sourceInformation: {
      dataSetInformation: {
        'common:UUID': SOURCE_UUID,
        'common:shortName': [{ '@xml:lang': 'en', '#text': 'IPCC source' }],
        classificationInformation: {
          'common:classification': { 'common:class': [{ '#text': 'Report' }] },
        },
        sourceCitation: 'IPCC 2025 DOI 10.0000/example',
        publicationType: 'Technical report',
        sourceDescriptionOrComment: [{ '@xml:lang': 'fr', '#text': 'Description source' }],
        referenceToContact: [
          {
            '@refObjectId': 'CONTACT-UUID',
            'common:shortDescription': [{ '@xml:lang': 'en', '#text': 'Author group' }],
          },
        ],
        referenceToDigitalFile: { '@uri': 'EXCLUDED-URI' },
      },
    },
  },
};

const UNIT_GROUP_FIXTURE = {
  unitGroupDataSet: {
    unitGroupInformation: {
      dataSetInformation: {
        'common:UUID': UNIT_GROUP_UUID,
        'common:name': [{ '@xml:lang': 'en', '#text': 'Units of mass' }],
        classificationInformation: {
          'common:classification': { 'common:class': [{ '#text': 'Physical unit' }] },
        },
        'common:generalComment': [{ '@xml:lang': 'zh', '#text': '质量单位' }],
      },
    },
    units: {
      unit: [
        {
          '@dataSetInternalID': 'UNIT-INTERNAL-ID',
          name: 'kg',
          meanValue: 'EXCLUDED-MEAN',
          generalComment: [{ '@xml:lang': 'en', '#text': 'kilogram' }],
        },
        { name: 'g', generalComment: [{ '@xml:lang': 'de', '#text': 'Gramm' }] },
      ],
    },
  },
};

const CASES: Array<{
  kind: SearchTextDatasetKind;
  fixture: unknown;
  projector: (value: unknown, rowId: string) => string;
  included: string[];
  excluded: string[];
  ownUuid: string;
}> = [
  {
    kind: 'process',
    fixture: PROCESS_FIXTURE,
    projector: projectProcessSearchText,
    included: ['Deutscher Prozess', '中文流程', 'CN', 'CN-31', 'Reference product', 'same-value'],
    excluded: ['EXCLUDED-VERSION', 'REF-UUID', 'EXCLUDED-AMOUNT', 'EXCLUDED-NON-REFERENCE'],
    ownUuid: PROCESS_UUID,
  },
  {
    kind: 'flow',
    fixture: FLOW_FIXTURE,
    projector: projectFlowSearchText,
    included: ['English flow', '处理路线', '50-00-0', '200-001-8', 'Mass property', '质量属性'],
    excluded: ['EXCLUDED-VERSION', 'FLOW-PROPERTY-UUID', 'EXCLUDED-MEAN'],
    ownUuid: FLOW_UUID,
  },
  {
    kind: 'lifecyclemodel',
    fixture: LIFECYCLE_MODEL_FIXTURE,
    projector: projectLifecycleModelSearchText,
    included: [
      'Model name',
      '组合',
      'Resulting process',
      'External guide',
      'Foreground group',
      'Model process',
      'Model use advice',
    ],
    excluded: [
      'EXCLUDED-VERSION',
      'RESULTING-PROCESS-UUID',
      'PROCESS-UUID',
      'INSTANCE-ID',
      'EXCLUDED-SCALE',
    ],
    ownUuid: MODEL_UUID,
  },
  {
    kind: 'contact',
    fixture: CONTACT_FIXTURE,
    projector: projectContactSearchText,
    included: ['Alice', '爱丽丝', 'A. Beispiel', 'alice@example.test', 'Contact notes'],
    excluded: ['EXCLUDED-WEBSITE'],
    ownUuid: CONTACT_UUID,
  },
  {
    kind: 'flowproperty',
    fixture: FLOW_PROPERTY_FIXTURE,
    projector: projectFlowPropertySearchText,
    included: ['Net calorific value', '低位热值', 'Energy per mass'],
    excluded: ['UNIT-GROUP-UUID'],
    ownUuid: PROPERTY_UUID,
  },
  {
    kind: 'source',
    fixture: SOURCE_FIXTURE,
    projector: projectSourceSearchText,
    included: [
      'IPCC source',
      'IPCC 2025 DOI 10.0000/example',
      'Technical report',
      'Description source',
      'Author group',
    ],
    excluded: ['CONTACT-UUID', 'EXCLUDED-URI'],
    ownUuid: SOURCE_UUID,
  },
  {
    kind: 'unitgroup',
    fixture: UNIT_GROUP_FIXTURE,
    projector: projectUnitGroupSearchText,
    included: ['Units of mass', 'Physical unit', '质量单位', 'kg', 'kilogram', 'g', 'Gramm'],
    excluded: ['UNIT-INTERNAL-ID', 'EXCLUDED-MEAN'],
    ownUuid: UNIT_GROUP_UUID,
  },
];

Deno.test('seven explicit projectors honor included/excluded path contracts', () => {
  for (const testCase of CASES) {
    const text = testCase.projector(testCase.fixture, testCase.ownUuid);
    for (const value of testCase.included) assertStringIncludes(text, value, testCase.kind);
    for (const value of testCase.excluded) {
      assert(!text.includes(value), `${testCase.kind} leaked excluded value ${value}`);
    }
    assertEquals(
      text.split('\n').filter((line) => line === 'same-value').length,
      testCase.kind === 'process' || testCase.kind === 'flow' ? 1 : 0,
    );
    assertEquals(text.split(testCase.ownUuid).length - 1, 1, `${testCase.kind} UUID count`);
  }
});

Deno.test(
  'projectors sort languages, normalize fragments, globally deduplicate, and newline-join',
  () => {
    const text = projectSearchText('process', PROCESS_UUID, PROCESS_FIXTURE);
    const lines = text.split('\n');

    assertEquals(lines[0], 'Deutscher Prozess');
    assertEquals(lines[1], 'English process');
    assertEquals(lines[2], '中文流程');
    assertEquals(new Set(lines).size, lines.length);
    assertEquals(text.includes('name'), false);
    assertEquals(text.includes('processInformation'), false);
  },
);

Deno.test('projectors inject the trusted row identity instead of JSON UUID', () => {
  const trustedRowId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const text = projectProcessSearchText(PROCESS_FIXTURE, trustedRowId);

  assertStringIncludes(text, trustedRowId);
  assertEquals(text.includes(PROCESS_UUID), false);
});

Deno.test('projectors accept direct roots and nested authored-value containers', () => {
  const directProcess = structuredClone(
    (PROCESS_FIXTURE as { processDataSet: Record<string, unknown> }).processDataSet,
  );
  const processInformation = directProcess.processInformation as Record<string, unknown>;
  const dataInfo = processInformation.dataSetInformation as Record<string, unknown>;
  dataInfo['common:synonyms'] = {
    value: [{ '@xml:lang': 'es', '#text': 'Proceso directo' }],
  };
  (dataInfo.classificationInformation as Record<string, unknown>)['common:classification'] = [
    { 'common:class': [{ '#text': 'Array root' }] },
    { 'common:class': [{ '#text': 'Array child' }] },
  ];

  const text = projectProcessSearchText(directProcess, PROCESS_UUID);
  assertStringIncludes(text, 'Proceso directo');
  assertStringIncludes(text, 'Array root');
  assertStringIncludes(text, 'Array child');
});

Deno.test('projectSearchText rejects a mismatched dataset root', () => {
  let threw = false;
  try {
    projectSearchText('source', CONTACT_UUID, CONTACT_FIXTURE);
  } catch (error) {
    threw = error instanceof Error && error.message.includes('missing data set');
  }
  assert(threw);
});
