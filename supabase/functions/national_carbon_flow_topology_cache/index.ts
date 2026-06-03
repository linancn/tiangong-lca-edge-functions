import '@supabase/functions-js/edge-runtime.d.ts';

import { AuthMethod, authenticateRequest } from '../_shared/auth.ts';
import { corsHeaders } from '../_shared/cors.ts';
import { createSupabaseServiceClient } from '../_shared/supabase_client.ts';

const BASIC_FLOW_TYPE = 'Elementary flow';
const DEFAULT_CACHE_BUCKET = 'lca_results';
const DEFAULT_CACHE_PREFIX = 'national-carbon/flow-topology/v1';
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1000;
const PUBLISHED_STATE_CODE = 100;
const SCHEMA_VERSION = 'flow_process_topology_v1';

type JsonRecord = Record<string, unknown>;

type DatasetRow = {
  id: string;
  json: unknown;
  json_ordered: unknown;
  modified_at?: string | null;
  version: string;
};

type FlowTopologyFlow = {
  flowType: string;
  id: string;
  name: string;
  version: string;
};

type FlowTopologyNode = {
  classification?: string;
  id: string;
  location?: string;
  name: string;
  referenceYear?: string;
  type: 'flow' | 'process';
  typeOfDataSet?: string;
  version: string;
};

type FlowTopologyEdge = {
  dataDerivationTypeStatus?: string;
  exchangeDirection: 'input' | 'output';
  id: string;
  meanAmount?: string | number;
  quantitativeReference?: boolean;
  relation: 'provider' | 'consumer';
  resultingAmount?: string | number;
  source: string;
  target: string;
};

type FlowTopologySnapshot = {
  buildId: string;
  dataAsOf: string;
  edges: FlowTopologyEdge[];
  flow: FlowTopologyFlow;
  nodes: FlowTopologyNode[];
  schemaVersion: typeof SCHEMA_VERSION;
  stats: {
    consumers: number;
    processCount: number;
    providers: number;
  };
};

type FlowMetadata = {
  flow: FlowTopologyFlow;
  modifiedAt?: string | null;
};

type ProcessMetadata = {
  classification?: string;
  id: string;
  location?: string;
  name: string;
  referenceFlowId?: string;
  referenceYear?: string;
  typeOfDataSet?: string;
  version: string;
};

type ProcessExchange = {
  dataDerivationTypeStatus?: string;
  exchangeDirection: 'input' | 'output';
  flowId: string;
  flowVersion?: string;
  meanAmount?: string | number;
  quantitativeReference: boolean;
  resultingAmount?: string | number;
};

type BuildRequest = {
  buildId?: string;
  dryRun?: boolean;
  limitFlows?: number;
  pageSize?: number;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });
}

function readOptionalEnv(name: string): string | undefined {
  const value = Deno.env.get(name)?.trim();
  return value ? value : undefined;
}

function getCacheBucket(): string {
  return (
    readOptionalEnv('FLOW_TOPOLOGY_CACHE_BUCKET') ??
    readOptionalEnv('S3_BUCKET') ??
    DEFAULT_CACHE_BUCKET
  );
}

function getCachePrefix(): string {
  return (
    readOptionalEnv('FLOW_TOPOLOGY_CACHE_PREFIX') ?? DEFAULT_CACHE_PREFIX
  ).replace(/^\/+|\/+$/g, '');
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function pickRecord(value: unknown, keys: string[]): JsonRecord | undefined {
  let current = asRecord(value);

  for (const key of keys) {
    current = asRecord(current?.[key]);
    if (!current) {
      return undefined;
    }
  }

  return current;
}

function pickValue(value: unknown, keys: string[]): unknown {
  let current: unknown = value;

  for (const key of keys) {
    current = asRecord(current)?.[key];
    if (current === undefined || current === null) {
      return undefined;
    }
  }

  return current;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function localizedText(
  value: unknown,
  preferredLang = 'zh',
): string | undefined {
  if (typeof value === 'string') {
    return normalizeString(value);
  }

  if (typeof value === 'number') {
    return String(value);
  }

  const direct = asRecord(value);
  if (direct) {
    const text = normalizeString(direct['#text']);
    if (text) {
      return text;
    }
  }

  const items = asArray(value).map(asRecord).filter(Boolean) as JsonRecord[];
  const preferred = items.find(
    (item) => normalizeString(item['@xml:lang']) === preferredLang,
  );
  const english = items.find(
    (item) => normalizeString(item['@xml:lang']) === 'en',
  );
  return (
    normalizeString(preferred?.['#text']) ??
    normalizeString(english?.['#text']) ??
    normalizeString(items[0]?.['#text'])
  );
}

function extractClassification(
  info: JsonRecord | undefined,
): string | undefined {
  const classificationInfo = asRecord(info?.classificationInformation);
  const classification =
    pickValue(classificationInfo, ['common:classification', 'common:class']) ??
    pickValue(classificationInfo, ['classification', 'class']) ??
    pickValue(classificationInfo, [
      'common:elementaryFlowCategorization',
      'common:category',
    ]);

  const labels = asArray(classification)
    .map((item) => localizedText(item))
    .filter((item): item is string => Boolean(item));

  return labels.length > 0 ? labels.join(' / ') : undefined;
}

function extractDataSetVersion(
  dataSet: JsonRecord | undefined,
  fallback: string,
): string {
  return (
    normalizeString(
      pickValue(dataSet, [
        'administrativeInformation',
        'publicationAndOwnership',
        'common:dataSetVersion',
      ]),
    ) ?? fallback
  );
}

function parseFlowRow(row: DatasetRow): FlowMetadata | undefined {
  const root = asRecord(row.json_ordered) ?? asRecord(row.json);
  const dataSet =
    pickRecord(root, ['flowDataSet']) ?? pickRecord(root, ['flow_data_set']);
  const dataSetInfo = pickRecord(dataSet, [
    'flowInformation',
    'dataSetInformation',
  ]);
  const flowType =
    normalizeString(
      pickValue(dataSet, [
        'modellingAndValidation',
        'LCIMethod',
        'typeOfDataSet',
      ]),
    ) ??
    normalizeString(
      pickValue(dataSet, [
        'modellingAndValidation',
        'LCIMethodAndAllocation',
        'typeOfDataSet',
      ]),
    );

  if (!flowType || flowType === BASIC_FLOW_TYPE) {
    return undefined;
  }

  const name =
    localizedText(pickValue(dataSetInfo, ['name', 'baseName'])) ?? row.id;

  return {
    flow: {
      flowType,
      id: row.id,
      name,
      version: extractDataSetVersion(dataSet, row.version),
    },
    modifiedAt: row.modified_at,
  };
}

function parseProcessMetadata(row: DatasetRow): ProcessMetadata | undefined {
  const root = asRecord(row.json_ordered) ?? asRecord(row.json);
  const dataSet =
    pickRecord(root, ['processDataSet']) ??
    pickRecord(root, ['process_data_set']);
  const processInfo = pickRecord(dataSet, ['processInformation']);
  const dataSetInfo = pickRecord(processInfo, ['dataSetInformation']);
  const referenceFlow = pickRecord(processInfo, [
    'quantitativeReference',
    'referenceToReferenceFlow',
  ]);
  const name =
    localizedText(pickValue(dataSetInfo, ['name', 'baseName'])) ?? row.id;
  const version = extractDataSetVersion(dataSet, row.version);

  return {
    classification: extractClassification(dataSetInfo),
    id: row.id,
    location:
      normalizeString(
        pickValue(processInfo, [
          'geography',
          'locationOfOperationSupplyOrProduction',
          '@location',
        ]),
      ) ??
      localizedText(
        pickValue(processInfo, [
          'geography',
          'locationOfOperationSupplyOrProduction',
          'descriptionOfRestrictions',
        ]),
      ),
    name,
    referenceFlowId: normalizeString(referenceFlow?.['@refObjectId']),
    referenceYear: normalizeString(
      pickValue(processInfo, ['time', 'common:referenceYear']),
    ),
    typeOfDataSet:
      normalizeString(
        pickValue(dataSet, [
          'modellingAndValidation',
          'LCIMethod',
          'typeOfDataSet',
        ]),
      ) ??
      normalizeString(
        pickValue(dataSet, [
          'modellingAndValidation',
          'LCIMethodAndAllocation',
          'typeOfDataSet',
        ]),
      ),
    version,
  };
}

function normalizeExchangeDirection(
  value: unknown,
  quantitativeReference: boolean,
): 'input' | 'output' {
  const raw = normalizeString(value)?.toLowerCase();
  if (raw?.includes('output')) {
    return 'output';
  }
  if (raw?.includes('input')) {
    return 'input';
  }
  return quantitativeReference ? 'output' : 'input';
}

function parseProcessExchanges(
  row: DatasetRow,
  processMeta: ProcessMetadata,
): ProcessExchange[] {
  const root = asRecord(row.json_ordered) ?? asRecord(row.json);
  const dataSet =
    pickRecord(root, ['processDataSet']) ??
    pickRecord(root, ['process_data_set']);
  const exchanges = pickValue(dataSet, ['exchanges', 'exchange']);

  return asArray(exchanges).flatMap((exchangeRaw) => {
    const exchange = asRecord(exchangeRaw);
    const ref = asRecord(exchange?.referenceToFlowDataSet);
    const flowId = normalizeString(ref?.['@refObjectId']);

    if (!exchange || !flowId) {
      return [];
    }

    const quantitativeReference =
      normalizeString(exchange.quantitativeReference)?.toLowerCase() ===
        'true' || flowId === processMeta.referenceFlowId;
    const exchangeDirection = normalizeExchangeDirection(
      exchange.exchangeDirection,
      quantitativeReference,
    );

    return [
      {
        dataDerivationTypeStatus: normalizeString(
          exchange.dataDerivationTypeStatus,
        ),
        exchangeDirection,
        flowId,
        flowVersion: normalizeString(ref?.['@version']),
        meanAmount:
          normalizeString(exchange.meanAmount) ??
          normalizeString(exchange['meanValue']),
        quantitativeReference,
        resultingAmount: normalizeString(exchange.resultingAmount),
      },
    ];
  });
}

function getHashPrefix(flowId: string): string {
  return flowId.replace(/-/g, '').toLowerCase().slice(0, 2) || '00';
}

function flowNodeId(flow: FlowTopologyFlow): string {
  return `flow:${flow.id}@${flow.version}`;
}

function processNodeId(process: ProcessMetadata): string {
  return `process:${process.id}@${process.version}`;
}

function flowLookupKeys(flowId: string, flowVersion?: string): string[] {
  return flowVersion ? [`${flowId}:${flowVersion}`, flowId] : [flowId];
}

async function fetchAllRows(
  table: 'flows' | 'processes',
  pageSize: number,
): Promise<DatasetRow[]> {
  const supabase = createSupabaseServiceClient();
  const rows: DatasetRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from(table)
      .select('id,version,json,json_ordered,modified_at')
      .eq('state_code', PUBLISHED_STATE_CODE)
      .order('id', { ascending: true })
      .order('version', { ascending: false })
      .range(from, to);

    if (error) {
      throw new Error(`Failed to fetch ${table}: ${error.message}`);
    }

    const page = (data ?? []) as DatasetRow[];
    rows.push(...page);

    if (page.length < pageSize) {
      break;
    }
  }

  return rows;
}

function buildSnapshots(
  flowRows: DatasetRow[],
  processRows: DatasetRow[],
  buildId: string,
  limitFlows?: number,
): FlowTopologySnapshot[] {
  const dataAsOf = new Date().toISOString();
  const flowByVersion = new Map<string, FlowMetadata>();
  const latestFlowById = new Map<string, FlowMetadata>();

  for (const row of flowRows) {
    const flowMeta = parseFlowRow(row);
    if (!flowMeta) {
      continue;
    }

    flowByVersion.set(`${flowMeta.flow.id}:${flowMeta.flow.version}`, flowMeta);
    const currentLatest = latestFlowById.get(flowMeta.flow.id);
    if (!currentLatest || flowMeta.flow.version > currentLatest.flow.version) {
      latestFlowById.set(flowMeta.flow.id, flowMeta);
    }
  }

  for (const flowMeta of latestFlowById.values()) {
    flowByVersion.set(flowMeta.flow.id, flowMeta);
  }

  const snapshots = new Map<string, FlowTopologySnapshot>();
  const ensureSnapshot = (flowMeta: FlowMetadata) => {
    const key = `${flowMeta.flow.id}:${flowMeta.flow.version}`;
    let snapshot = snapshots.get(key);
    if (!snapshot) {
      snapshot = {
        buildId,
        dataAsOf,
        edges: [],
        flow: flowMeta.flow,
        nodes: [
          {
            id: flowNodeId(flowMeta.flow),
            name: flowMeta.flow.name,
            type: 'flow',
            version: flowMeta.flow.version,
          },
        ],
        schemaVersion: SCHEMA_VERSION,
        stats: {
          consumers: 0,
          processCount: 0,
          providers: 0,
        },
      };
      snapshots.set(key, snapshot);
    }
    return snapshot;
  };

  for (const row of processRows) {
    const processMeta = parseProcessMetadata(row);
    if (!processMeta) {
      continue;
    }

    const exchanges = parseProcessExchanges(row, processMeta);
    for (const exchange of exchanges) {
      const flowMeta = flowLookupKeys(exchange.flowId, exchange.flowVersion)
        .map((key) => flowByVersion.get(key))
        .find(Boolean);

      if (!flowMeta) {
        continue;
      }

      if (
        limitFlows !== undefined &&
        snapshots.size >= limitFlows &&
        !snapshots.has(`${flowMeta.flow.id}:${flowMeta.flow.version}`)
      ) {
        continue;
      }

      const snapshot = ensureSnapshot(flowMeta);
      const processId = processNodeId(processMeta);
      if (!snapshot.nodes.some((node) => node.id === processId)) {
        snapshot.nodes.push({
          classification: processMeta.classification,
          id: processId,
          location: processMeta.location,
          name: processMeta.name,
          referenceYear: processMeta.referenceYear,
          type: 'process',
          typeOfDataSet: processMeta.typeOfDataSet,
          version: processMeta.version,
        });
      }

      const relation =
        exchange.exchangeDirection === 'output' ? 'provider' : 'consumer';
      const edge: FlowTopologyEdge = {
        dataDerivationTypeStatus: exchange.dataDerivationTypeStatus,
        exchangeDirection: exchange.exchangeDirection,
        id: `edge:${processMeta.id}:${processMeta.version}:${snapshot.edges.length}`,
        meanAmount: exchange.meanAmount,
        quantitativeReference: exchange.quantitativeReference,
        relation,
        resultingAmount: exchange.resultingAmount,
        source: relation === 'provider' ? processId : flowNodeId(flowMeta.flow),
        target: relation === 'provider' ? flowNodeId(flowMeta.flow) : processId,
      };
      snapshot.edges.push(edge);
    }
  }

  const finalized = [...snapshots.values()].filter(
    (snapshot) => snapshot.edges.length > 0,
  );
  for (const snapshot of finalized) {
    const providerIds = new Set(
      snapshot.edges
        .filter((edge) => edge.relation === 'provider')
        .map((edge) => edge.source),
    );
    const consumerIds = new Set(
      snapshot.edges
        .filter((edge) => edge.relation === 'consumer')
        .map((edge) => edge.target),
    );
    snapshot.stats = {
      consumers: consumerIds.size,
      processCount: snapshot.nodes.filter((node) => node.type === 'process')
        .length,
      providers: providerIds.size,
    };
  }

  return finalized;
}

async function uploadJson(
  bucket: string,
  objectPath: string,
  payload: unknown,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    return;
  }

  const supabase = createSupabaseServiceClient();
  const body = new Blob([JSON.stringify(payload)], {
    type: 'application/json',
  });
  const { error } = await supabase.storage
    .from(bucket)
    .upload(objectPath, body, {
      cacheControl: '3600',
      contentType: 'application/json',
      upsert: true,
    });

  if (error) {
    throw new Error(`Failed to upload ${objectPath}: ${error.message}`);
  }
}

function topologyObjectPath(
  prefix: string,
  buildId: string,
  flow: FlowTopologyFlow,
): string {
  return `${prefix}/builds/${buildId}/by-flow/${getHashPrefix(flow.id)}/${flow.id}/${flow.version}/topology.json`;
}

function latestPointerPath(
  prefix: string,
  buildId: string,
  flowId: string,
): string {
  return `${prefix}/builds/${buildId}/by-flow/${getHashPrefix(flowId)}/${flowId}/latest.json`;
}

async function publishSnapshots(
  snapshots: FlowTopologySnapshot[],
  request: BuildRequest,
) {
  const bucket = getCacheBucket();
  const prefix = getCachePrefix();
  const buildId =
    request.buildId?.trim() ||
    `flow-topology-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const dryRun = request.dryRun === true;
  let uploadedObjects = 0;

  for (const snapshot of snapshots) {
    const topologyPath = topologyObjectPath(prefix, buildId, snapshot.flow);
    const latestPath = latestPointerPath(prefix, buildId, snapshot.flow.id);
    await uploadJson(bucket, topologyPath, snapshot, dryRun);
    await uploadJson(
      bucket,
      latestPath,
      {
        buildId,
        flow: snapshot.flow,
        schemaVersion: SCHEMA_VERSION,
        topologyPath: topologyPath.replace(`${prefix}/`, ''),
      },
      dryRun,
    );
    uploadedObjects += 2;
  }

  await uploadJson(
    bucket,
    `${prefix}/manifest.json`,
    {
      activeBuildId: buildId,
      bucket,
      generatedAt: new Date().toISOString(),
      objectCount: snapshots.length,
      schemaVersion: SCHEMA_VERSION,
    },
    dryRun,
  );

  uploadedObjects += 1;

  return {
    buildId,
    bucket,
    dryRun,
    prefix,
    snapshotCount: snapshots.length,
    uploadedObjects: dryRun ? 0 : uploadedObjects,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const authResult = await authenticateRequest(req, {
    allowedMethods: [AuthMethod.SERVICE_API_KEY],
  });

  if (!authResult.isAuthenticated) {
    return authResult.response!;
  }

  let request: BuildRequest = {};
  try {
    request = (await req.json()) as BuildRequest;
  } catch (_error) {
    request = {};
  }

  try {
    const pageSize = Math.min(
      Math.max(Number(request.pageSize) || DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    const buildId =
      request.buildId?.trim() ||
      `flow-topology-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const [flowRows, processRows] = await Promise.all([
      fetchAllRows('flows', pageSize),
      fetchAllRows('processes', pageSize),
    ]);
    const snapshots = buildSnapshots(
      flowRows,
      processRows,
      buildId,
      request.limitFlows,
    );
    const published = await publishSnapshots(snapshots, {
      ...request,
      buildId,
    });

    return json({
      ...published,
      sourceRows: {
        flows: flowRows.length,
        processes: processRows.length,
      },
    });
  } catch (error) {
    console.error('national carbon flow topology cache build failed', error);
    return json(
      {
        error: 'flow_topology_cache_build_failed',
        message: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});
