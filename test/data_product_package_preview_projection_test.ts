import { assertEquals } from 'jsr:@std/assert';

import {
  previewMetadataRefsFromProjection,
  projectLciaResultPackagePreviewRows,
  projectPublishedProcessAllImpacts,
  projectPublishedProcessesOneImpact,
  projectPublishedRankedProcessesOneImpact,
} from '../supabase/functions/_shared/commands/data_product/package_preview_projection.ts';

const TEST_PROCESS_A = '11111111-1111-4111-8111-111111111111';
const TEST_PROCESS_B = '22222222-2222-4222-8222-222222222222';
const TEST_PROCESS_C = '33333333-3333-4333-8333-333333333333';
const TEST_SNAPSHOT_ID = '44444444-4444-4444-8444-444444444444';

Deno.test(
  'projectLciaResultPackagePreviewRows returns paged result detail rows with display metadata',
  () => {
    const projected = projectLciaResultPackagePreviewRows({
      preview: {
        summary: {
          packageId: '55555555-5555-4555-8555-555555555555',
          snapshotId: TEST_SNAPSHOT_ID,
          defaultImpactCategory: 'impact-climate',
        },
        inputManifest: {
          processes: [
            { id: TEST_PROCESS_A, version: '01.00.000', stateCode: 100 },
            { id: TEST_PROCESS_B, version: '01.00.001', stateCode: 101 },
            { id: TEST_PROCESS_C, version: '01.00.002', stateCode: 102 },
          ],
        },
      },
      request: {
        action: 'preview_package',
        packageId: '55555555-5555-4555-8555-555555555555',
        rowOffset: 0,
        rowLimit: 2,
        impactCategoryId: 'impact-climate',
      },
      snapshotIndex: {
        version: 1,
        snapshot_id: TEST_SNAPSHOT_ID,
        process_count: 3,
        impact_count: 2,
        process_map: [
          {
            process_id: TEST_PROCESS_A,
            process_version: '01.00.000',
            process_index: 0,
          },
          {
            process_id: TEST_PROCESS_B,
            process_version: '01.00.001',
            process_index: 1,
          },
          {
            process_id: TEST_PROCESS_C,
            process_version: '01.00.002',
            process_index: 2,
          },
        ],
        impact_map: [
          {
            impact_id: 'impact-climate',
            impact_key: 'climate-change',
            impact_index: 0,
            impact_name: '11111111-1111-4111-8111-111111111111',
            unit: '',
          },
          {
            impact_id: 'impact-acidification',
            impact_key: 'acidification',
            impact_index: 1,
            impact_name: 'Acidification',
            unit: 'mol H+ eq',
          },
        ],
      },
      queryArtifact: {
        version: 1,
        format: 'all-unit-query:v1',
        snapshot_id: TEST_SNAPSHOT_ID,
        job_id: '66666666-6666-4666-8666-666666666666',
        process_count: 3,
        impact_count: 2,
        h_matrix: [
          [10, 1],
          [20.5, 2],
          [-30, 3],
        ],
      },
      processMetadata: [
        {
          processId: TEST_PROCESS_A,
          processVersion: '01.00.000',
          processName: 'Portland cement production',
        },
        {
          processId: TEST_PROCESS_B,
          processVersion: '01.00.001',
          processName: 'Electricity, medium voltage',
        },
      ],
      impactMetadata: [
        {
          impactCategoryId: 'impact-climate',
          impactVersion: '01.00.000',
          impactName: 'Climate change',
          unit: 'kg CO2 equivalents',
        },
      ],
    });

    assertEquals(projected.detailPage, {
      status: 'ready',
      impactCategoryId: 'impact-climate',
      impactKey: 'climate-change',
      impactIndex: 0,
      impactName: 'Climate change',
      impactVersion: '01.00.000',
      unit: 'kg CO2 equivalents',
      offset: 0,
      limit: 2,
      returnedCount: 2,
      totalCount: 3,
      omittedInputCount: 0,
      rows: [
        {
          rowNumber: 1,
          processId: TEST_PROCESS_A,
          processVersion: '01.00.000',
          processName: 'Portland cement production',
          processIndex: 0,
          stateCode: 100,
          impactCategoryId: 'impact-climate',
          impactKey: 'climate-change',
          impactIndex: 0,
          impactName: 'Climate change',
          impactVersion: '01.00.000',
          unit: 'kg CO2 equivalents',
          value: 10,
        },
        {
          rowNumber: 2,
          processId: TEST_PROCESS_B,
          processVersion: '01.00.001',
          processName: 'Electricity, medium voltage',
          processIndex: 1,
          stateCode: 101,
          impactCategoryId: 'impact-climate',
          impactKey: 'climate-change',
          impactIndex: 0,
          impactName: 'Climate change',
          impactVersion: '01.00.000',
          unit: 'kg CO2 equivalents',
          value: 20.5,
        },
      ],
    });
    assertEquals(projected.impactOptions, [
      {
        impactCategoryId: 'impact-climate',
        impactKey: 'climate-change',
        impactIndex: 0,
        impactName: 'Climate change',
        impactVersion: '01.00.000',
        unit: 'kg CO2 equivalents',
      },
      {
        impactCategoryId: 'impact-acidification',
        impactKey: 'acidification',
        impactIndex: 1,
        impactName: 'Acidification',
        impactVersion: null,
        unit: 'mol H+ eq',
      },
    ]);
    assertEquals(previewMetadataRefsFromProjection(projected), {
      processes: [
        { processId: TEST_PROCESS_A, processVersion: '01.00.000' },
        { processId: TEST_PROCESS_B, processVersion: '01.00.001' },
      ],
      impactCategoryIds: ['impact-climate'],
    });
  },
);

Deno.test(
  'projectLciaResultPackagePreviewRows keeps input detail rows when result artifacts are unavailable',
  () => {
    const projected = projectLciaResultPackagePreviewRows({
      preview: {
        summary: {
          packageId: '55555555-5555-4555-8555-555555555555',
        },
        inputManifest: {
          processes: [
            {
              id: TEST_PROCESS_A,
              version: '01.00.000',
              stateCode: 100,
            },
          ],
        },
      },
      request: {
        action: 'preview_package',
        packageId: '55555555-5555-4555-8555-555555555555',
      },
    });

    assertEquals(projected.detailPage, {
      status: 'unavailable',
      reason: 'result_projection_artifacts_unavailable',
      offset: 0,
      limit: 25,
      returnedCount: 1,
      totalCount: 1,
      omittedInputCount: 0,
      rows: [
        {
          rowNumber: 1,
          processId: TEST_PROCESS_A,
          processVersion: '01.00.000',
          processName: TEST_PROCESS_A,
          processIndex: null,
          stateCode: 100,
          impactCategoryId: null,
          impactKey: null,
          impactIndex: null,
          impactName: null,
          impactVersion: null,
          unit: null,
          value: null,
        },
      ],
    });
  },
);

Deno.test(
  'projectLciaResultPackagePreviewRows only reads h_matrix rows for the requested page',
  () => {
    const processes = Array.from({ length: 6 }, (_, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      version: '01.00.000',
      stateCode: 100,
    }));
    const hMatrix = new Proxy(
      Array.from({ length: 6 }, (_, index) => [index + 1]),
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) {
            const index = Number(property);
            if (index < 2 || index > 3) {
              throw new Error(`unexpected h_matrix row read: ${index}`);
            }
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const projected = projectLciaResultPackagePreviewRows({
      preview: {
        summary: {
          packageId: '55555555-5555-4555-8555-555555555555',
          snapshotId: TEST_SNAPSHOT_ID,
          defaultImpactCategory: 'impact-climate',
        },
        inputManifest: {
          processes,
        },
      },
      request: {
        action: 'preview_package',
        packageId: '55555555-5555-4555-8555-555555555555',
        rowOffset: 2,
        rowLimit: 2,
        impactCategoryId: 'impact-climate',
      },
      snapshotIndex: {
        version: 1,
        snapshot_id: TEST_SNAPSHOT_ID,
        process_count: 6,
        impact_count: 1,
        process_map: processes.map((process, index) => ({
          process_id: process.id,
          process_version: process.version,
          process_index: index,
        })),
        impact_map: [
          {
            impact_id: 'impact-climate',
            impact_key: 'climate-change',
            impact_index: 0,
            impact_name: 'Climate change',
            unit: 'kg CO2 eq',
          },
        ],
      },
      queryArtifact: {
        version: 1,
        format: 'all-unit-query:v1',
        snapshot_id: TEST_SNAPSHOT_ID,
        job_id: '66666666-6666-4666-8666-666666666666',
        process_count: 6,
        impact_count: 1,
        h_matrix: hMatrix,
      },
    });

    assertEquals(
      projected.detailPage.rows.map((row) => row.rowNumber),
      [3, 4],
    );
    assertEquals(
      projected.detailPage.rows.map((row) => row.value),
      [3, 4],
    );
    assertEquals(projected.detailPage.totalCount, 6);
  },
);

Deno.test('published LCIA result projections read values from the all-unit matrix', () => {
  const preview = {
    summary: {
      packageId: '55555555-5555-4555-8555-555555555555',
      snapshotId: TEST_SNAPSHOT_ID,
      defaultImpactCategory: 'impact-climate',
    },
    inputManifest: {
      processes: [
        { id: TEST_PROCESS_A, version: '01.00.000', stateCode: 100 },
        { id: TEST_PROCESS_B, version: '01.00.001', stateCode: 100 },
        { id: TEST_PROCESS_C, version: '01.00.002', stateCode: 100 },
      ],
    },
  };
  const snapshotIndex = {
    version: 1,
    snapshot_id: TEST_SNAPSHOT_ID,
    process_count: 3,
    impact_count: 2,
    process_map: [
      {
        process_id: TEST_PROCESS_A,
        process_version: '01.00.000',
        process_index: 0,
      },
      {
        process_id: TEST_PROCESS_B,
        process_version: '01.00.001',
        process_index: 1,
      },
      {
        process_id: TEST_PROCESS_C,
        process_version: '01.00.002',
        process_index: 2,
      },
    ],
    impact_map: [
      {
        impact_id: 'impact-climate',
        impact_key: 'climate-change',
        impact_index: 0,
        impact_name: 'Climate change',
        unit: 'kg CO2 eq',
      },
      {
        impact_id: 'impact-acidification',
        impact_key: 'acidification',
        impact_index: 1,
        impact_name: 'Acidification',
        unit: 'mol H+ eq',
      },
    ],
  };
  const queryArtifact = {
    version: 1,
    format: 'all-unit-query:v1',
    snapshot_id: TEST_SNAPSHOT_ID,
    job_id: '66666666-6666-4666-8666-666666666666',
    process_count: 3,
    impact_count: 2,
    h_matrix: [
      [10, 1],
      [-30, 3],
      [20, 2],
    ],
  };

  assertEquals(
    projectPublishedProcessAllImpacts({
      preview,
      snapshotIndex,
      queryArtifact,
      processId: TEST_PROCESS_B,
      processVersion: '01.00.001',
    }).values,
    [
      {
        impact_id: 'impact-climate',
        impact_index: 0,
        impact_name: 'Climate change',
        unit: 'kg CO2 eq',
        value: -30,
      },
      {
        impact_id: 'impact-acidification',
        impact_index: 1,
        impact_name: 'Acidification',
        unit: 'mol H+ eq',
        value: 3,
      },
    ],
  );

  assertEquals(
    projectPublishedProcessesOneImpact({
      preview,
      snapshotIndex,
      queryArtifact,
      impactCategoryId: 'impact-climate',
      processes: [
        { id: TEST_PROCESS_A, version: '01.00.000' },
        { id: TEST_PROCESS_C, version: '01.00.002' },
      ],
    }).values,
    {
      [TEST_PROCESS_A]: 10,
      [TEST_PROCESS_C]: 20,
    },
  );

  assertEquals(
    projectPublishedRankedProcessesOneImpact({
      preview,
      snapshotIndex,
      queryArtifact,
      impactCategoryId: 'impact-climate',
      offset: 0,
      limit: 2,
    }),
    {
      kind: 'ranked_processes',
      impact_id: 'impact-climate',
      impact_index: 0,
      sort_by: 'absolute_value',
      sort_direction: 'desc',
      offset: 0,
      limit: 2,
      returned_count: 2,
      total_process_count: 3,
      total_absolute_value: 60,
      values: [
        {
          process_id: TEST_PROCESS_B,
          process_version: '01.00.001',
          process_index: 1,
          value: -30,
          absolute_value: 30,
        },
        {
          process_id: TEST_PROCESS_C,
          process_version: '01.00.002',
          process_index: 2,
          value: 20,
          absolute_value: 20,
        },
      ],
    },
  );
});
