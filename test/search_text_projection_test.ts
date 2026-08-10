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
        'common:synonyms': [
          { '@xml:lang': 'en', '#text': 'same-value' },
          { '@xml:lang': 'en', '#text': 'process synonym' },
        ],
        classificationInformation: {
          'common:classification': {
            'common:class': [
              { '@level': 1, '#text': 'Class child' },
              { '@level': 0, '#text': 'Class root' },
            ],
          },
        },
        'common:generalComment': [
          { '@xml:lang': 'en', '#text': 'same-value' },
          { '@xml:lang': 'en', '#text': 'Process general comment' },
        ],
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
        deviationsFromCutOffAndCompletenessPrinciples: [
          { '@xml:lang': 'en', '#text': 'No cutoff deviation' },
        ],
        dataSelectionAndCombinationPrinciples: [{ '@xml:lang': 'en', '#text': 'measured' }],
        deviationsFromSelectionAndCombinationPrinciples: [
          { '@xml:lang': 'en', '#text': 'No selection deviation' },
        ],
        dataTreatmentAndExtrapolationsPrinciples: [{ '@xml:lang': 'en', '#text': 'direct' }],
        deviationsFromTreatmentAndExtrapolationPrinciples: [
          { '@xml:lang': 'en', '#text': 'No treatment deviation' },
        ],
        samplingProcedure: [{ '@xml:lang': 'en', '#text': 'random' }],
        dataCollectionPeriod: [{ '@xml:lang': 'en', '#text': '2024 collection period' }],
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
        'common:synonyms': [
          { '@xml:lang': 'en', '#text': 'same-value' },
          { '@xml:lang': 'en', '#text': 'flow synonym' },
        ],
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
          dataSetInternalID: 'FLOW-PROPERTY-INTERNAL-ID',
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
    administrativeInformation: {
      publicationAndOwnership: { 'common:dataSetVersion': 'EXCLUDED-UNIT-VERSION' },
    },
  },
};

type ContractValue = { path: string; value: string };

const CASES: Array<{
  kind: SearchTextDatasetKind;
  fixture: unknown;
  projector: (value: unknown, rowId: string) => string;
  included: ContractValue[];
  excluded: ContractValue[];
  ownUuid: string;
}> = [
  {
    kind: 'process',
    fixture: PROCESS_FIXTURE,
    projector: projectProcessSearchText,
    included: [
      { path: 'name.baseName', value: 'English process' },
      { path: 'name.treatmentStandardsRoutes', value: 'voie française' },
      { path: 'name.mixAndLocationTypes', value: 'market mix' },
      { path: 'name.functionalUnitFlowProperties', value: 'mass' },
      { path: 'identifierOfSubDataSet', value: 'SUB-1' },
      { path: 'common:synonyms', value: 'process synonym' },
      { path: 'classificationInformation.common:classification.common:class', value: 'Class root' },
      { path: 'common:generalComment', value: 'Process general comment' },
      { path: 'quantitativeReference.functionalUnitOrOther', value: 'one kilogram' },
      { path: 'time.common:timeRepresentativenessDescription', value: '2024 production period' },
      { path: 'geography.locationOfOperationSupplyOrProduction.@location', value: 'CN' },
      {
        path: 'geography.locationOfOperationSupplyOrProduction.descriptionOfRestrictions',
        value: '区域限制',
      },
      {
        path: 'geography.subLocationOfOperationSupplyOrProduction.@subLocation',
        value: 'CN-31',
      },
      {
        path: 'geography.subLocationOfOperationSupplyOrProduction.descriptionOfRestrictions',
        value: 'Shanghai only',
      },
      {
        path: 'technology.technologyDescriptionAndIncludedProcesses',
        value: 'Included kiln process',
      },
      { path: 'technology.technologicalApplicability', value: 'Industrial kiln' },
      { path: 'LCIMethodAndAllocation.LCIMethodPrinciple', value: 'Attributional' },
      {
        path: 'LCIMethodAndAllocation.deviationsFromLCIMethodPrinciple',
        value: 'No deviation',
      },
      { path: 'LCIMethodAndAllocation.LCIMethodApproaches', value: 'Cut-off' },
      { path: 'LCIMethodAndAllocation.deviationsFromLCIMethodApproaches', value: 'None' },
      { path: 'LCIMethodAndAllocation.modellingConstants', value: 'constant A' },
      {
        path: 'LCIMethodAndAllocation.deviationsFromModellingConstants',
        value: 'No constant deviation',
      },
      {
        path: 'dataSourcesTreatmentAndRepresentativeness.dataCutOffAndCompletenessPrinciples',
        value: 'complete',
      },
      {
        path: 'dataSourcesTreatmentAndRepresentativeness.deviationsFromCutOffAndCompletenessPrinciples',
        value: 'No cutoff deviation',
      },
      {
        path: 'dataSourcesTreatmentAndRepresentativeness.dataSelectionAndCombinationPrinciples',
        value: 'measured',
      },
      {
        path: 'dataSourcesTreatmentAndRepresentativeness.deviationsFromSelectionAndCombinationPrinciples',
        value: 'No selection deviation',
      },
      {
        path: 'dataSourcesTreatmentAndRepresentativeness.dataTreatmentAndExtrapolationsPrinciples',
        value: 'direct',
      },
      {
        path: 'dataSourcesTreatmentAndRepresentativeness.deviationsFromTreatmentAndExtrapolationPrinciples',
        value: 'No treatment deviation',
      },
      { path: 'dataSourcesTreatmentAndRepresentativeness.samplingProcedure', value: 'random' },
      {
        path: 'dataSourcesTreatmentAndRepresentativeness.dataCollectionPeriod',
        value: '2024 collection period',
      },
      { path: 'dataSourcesTreatmentAndRepresentativeness.uncertaintyAdjustments', value: 'low' },
      {
        path: 'dataSourcesTreatmentAndRepresentativeness.useAdviceForDataSet',
        value: 'Use for kiln studies',
      },
      {
        path: 'referenceToReferenceFlow.referenceToFlowDataSet.shortDescription',
        value: 'Reference product',
      },
    ],
    excluded: [
      {
        path: 'administrativeInformation.publicationAndOwnership.common:dataSetVersion',
        value: 'EXCLUDED-VERSION',
      },
      { path: 'referenceToReferenceFlow.exchange.internalId', value: 'ref-flow-1' },
      { path: 'referenceToReferenceFlow.referenceToFlowDataSet.@refObjectId', value: 'REF-UUID' },
      { path: 'referenceToReferenceFlow.exchange.amount', value: 'EXCLUDED-AMOUNT' },
      {
        path: 'nonReferenceExchange.referenceToFlowDataSet.shortDescription',
        value: 'EXCLUDED-NON-REFERENCE',
      },
    ],
    ownUuid: PROCESS_UUID,
  },
  {
    kind: 'flow',
    fixture: FLOW_FIXTURE,
    projector: projectFlowSearchText,
    included: [
      { path: 'name.baseName', value: 'English flow' },
      { path: 'name.treatmentStandardsRoutes', value: '处理路线' },
      { path: 'name.mixAndLocationTypes', value: 'Mischung' },
      { path: 'name.flowProperties', value: 'Mass' },
      { path: 'common:synonyms', value: 'flow synonym' },
      {
        path: 'classificationInformation.common:elementaryFlowCategorization.common:category',
        value: 'Emissions',
      },
      { path: 'classificationInformation.common:classification.common:class', value: 'Product' },
      { path: 'CASNumber', value: '50-00-0' },
      { path: 'common:other.ecn:ECNumber', value: '200-001-8' },
      { path: 'sumFormula', value: 'CH2O' },
      { path: 'common:generalComment', value: 'Commentaire' },
      { path: 'geography.locationOfSupply.@location', value: 'GLO' },
      { path: 'technology.technologicalApplicability', value: 'All sites' },
      { path: 'referenceToFlowPropertyDataSet.common:shortDescription', value: 'Mass property' },
      { path: 'referenceToFlowPropertyDataSet.common:shortDescription', value: '质量属性' },
    ],
    excluded: [
      {
        path: 'administrativeInformation.publicationAndOwnership.common:dataSetVersion',
        value: 'EXCLUDED-VERSION',
      },
      { path: 'flowProperty.dataSetInternalID', value: 'FLOW-PROPERTY-INTERNAL-ID' },
      {
        path: 'flowProperty.referenceToFlowPropertyDataSet.@refObjectId',
        value: 'FLOW-PROPERTY-UUID',
      },
      { path: 'flowProperty.meanValue', value: 'EXCLUDED-MEAN' },
    ],
    ownUuid: FLOW_UUID,
  },
  {
    kind: 'lifecyclemodel',
    fixture: LIFECYCLE_MODEL_FIXTURE,
    projector: projectLifecycleModelSearchText,
    included: [
      { path: 'name.baseName', value: 'Model name' },
      { path: 'name.treatmentStandardsRoutes', value: 'Route' },
      { path: 'name.mixAndLocationTypes', value: '组合' },
      { path: 'name.functionalUnitFlowProperties', value: 'unité' },
      {
        path: 'classificationInformation.common:classification.common:class',
        value: 'Model class',
      },
      { path: 'common:generalComment', value: 'Model description' },
      { path: 'referenceToResultingProcess.common:shortDescription', value: 'Resulting process' },
      { path: 'referenceToExternalDocumentation.common:shortDescription', value: 'External guide' },
      { path: 'technology.groupDeclarations.group.groupName', value: 'Foreground group' },
      {
        path: 'technology.processes.processInstance.referenceToProcess.common:shortDescription',
        value: 'Model process',
      },
      { path: 'dataSourcesTreatmentEtc.useAdviceForDataSet', value: 'Model use advice' },
    ],
    excluded: [
      {
        path: 'administrativeInformation.publicationAndOwnership.common:dataSetVersion',
        value: 'EXCLUDED-VERSION',
      },
      { path: 'referenceToResultingProcess.@refObjectId', value: 'RESULTING-PROCESS-UUID' },
      { path: 'referenceToExternalDocumentation.@uri', value: 'https://excluded.example.test/doc' },
      {
        path: 'technology.processes.processInstance.referenceToProcess.@refObjectId',
        value: 'PROCESS-UUID',
      },
      { path: 'technology.processes.processInstance.@dataSetInternalID', value: 'INSTANCE-ID' },
      { path: 'technology.processes.processInstance.scalingFactor', value: 'EXCLUDED-SCALE' },
    ],
    ownUuid: MODEL_UUID,
  },
  {
    kind: 'contact',
    fixture: CONTACT_FIXTURE,
    projector: projectContactSearchText,
    included: [
      { path: 'common:name', value: 'Alice' },
      { path: 'common:name', value: '爱丽丝' },
      { path: 'common:shortName', value: 'A. Beispiel' },
      { path: 'classificationInformation.common:classification.common:class', value: 'Researcher' },
      { path: 'contactAddress', value: '1 Main Street' },
      { path: 'email', value: 'alice@example.test' },
      { path: 'telephone', value: '+1-555-0100' },
      { path: 'telefax', value: '+1-555-0101' },
      { path: 'centralContactPoint', value: 'Central desk' },
      { path: 'contactDescriptionOrComment', value: 'Contact notes' },
    ],
    excluded: [{ path: 'WWWAddress', value: 'EXCLUDED-WEBSITE' }],
    ownUuid: CONTACT_UUID,
  },
  {
    kind: 'flowproperty',
    fixture: FLOW_PROPERTY_FIXTURE,
    projector: projectFlowPropertySearchText,
    included: [
      { path: 'common:name', value: 'Net calorific value' },
      { path: 'common:synonyms', value: '低位热值' },
      { path: 'classificationInformation.common:classification.common:class', value: 'Energy' },
      { path: 'common:generalComment', value: 'Energy value' },
      { path: 'referenceToReferenceUnitGroup.common:shortDescription', value: 'Energy per mass' },
    ],
    excluded: [{ path: 'referenceToReferenceUnitGroup.@refObjectId', value: 'UNIT-GROUP-UUID' }],
    ownUuid: PROPERTY_UUID,
  },
  {
    kind: 'source',
    fixture: SOURCE_FIXTURE,
    projector: projectSourceSearchText,
    included: [
      { path: 'common:shortName', value: 'IPCC source' },
      { path: 'classificationInformation.common:classification.common:class', value: 'Report' },
      { path: 'sourceCitation', value: 'IPCC 2025 DOI 10.0000/example' },
      { path: 'publicationType', value: 'Technical report' },
      { path: 'sourceDescriptionOrComment', value: 'Description source' },
      { path: 'referenceToContact.common:shortDescription', value: 'Author group' },
    ],
    excluded: [
      { path: 'referenceToContact.@refObjectId', value: 'CONTACT-UUID' },
      { path: 'referenceToDigitalFile.@uri', value: 'EXCLUDED-URI' },
    ],
    ownUuid: SOURCE_UUID,
  },
  {
    kind: 'unitgroup',
    fixture: UNIT_GROUP_FIXTURE,
    projector: projectUnitGroupSearchText,
    included: [
      { path: 'common:name', value: 'Units of mass' },
      {
        path: 'classificationInformation.common:classification.common:class',
        value: 'Physical unit',
      },
      { path: 'common:generalComment', value: '质量单位' },
      { path: 'units.unit[0].name', value: 'kg' },
      { path: 'units.unit[0].generalComment', value: 'kilogram' },
      { path: 'units.unit[1].name', value: 'g' },
      { path: 'units.unit[1].generalComment', value: 'Gramm' },
    ],
    excluded: [
      { path: 'units.unit[0].@dataSetInternalID', value: 'UNIT-INTERNAL-ID' },
      { path: 'units.unit[0].meanValue', value: 'EXCLUDED-MEAN' },
      {
        path: 'administrativeInformation.publicationAndOwnership.common:dataSetVersion',
        value: 'EXCLUDED-UNIT-VERSION',
      },
    ],
    ownUuid: UNIT_GROUP_UUID,
  },
];

Deno.test('seven explicit projectors honor included/excluded path contracts', () => {
  for (const testCase of CASES) {
    const text = testCase.projector(testCase.fixture, testCase.ownUuid);
    for (const { path, value } of testCase.included) {
      assertStringIncludes(text, value, `${testCase.kind} included path ${path}`);
    }
    for (const { path, value } of testCase.excluded) {
      assert(!text.includes(value), `${testCase.kind} leaked excluded path ${path}: ${value}`);
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
