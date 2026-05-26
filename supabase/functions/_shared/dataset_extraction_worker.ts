import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2.98.0';

import {
  generateFlowMarkdown,
  generateFlowTextSummary,
  normalizeJsonOrdered,
} from './flow_extraction.ts';
import type { OpenAIChatResult } from './openai_chat.ts';

export type DatasetExtractionKind = 'extracted_md' | 'extracted_text';
export type DatasetEntityKind = 'flow' | 'process';

export interface DatasetExtractionJobMessage {
  schema: string;
  table: string;
  id: string;
  version: string;
  entity_kind: DatasetEntityKind;
  extraction_kind: DatasetExtractionKind;
  created_at?: string;
}

export interface ClaimedDatasetExtractionJob {
  msg_id: number;
  read_ct: number;
  message: DatasetExtractionJobMessage;
}

export interface DatasetExtractionJobResult {
  msg_id: number;
  entity_kind?: string;
  extraction_kind?: string;
  table?: string;
  id?: string;
  version?: string;
  status: 'success' | 'retry' | 'failed' | 'unsupported';
  duration_ms: number;
  error_code?: string;
  error_message?: string;
}

export interface DatasetExtractionWorkerResult {
  claimed: number;
  acked: number;
  results: DatasetExtractionJobResult[];
}

export interface DatasetExtractionWorkerOptions {
  supabase: SupabaseClient;
  batchSize?: number;
  visibilityTimeoutSeconds?: number;
  maxReadCount?: number;
  markdownGenerator?: (flowJson: unknown) => string;
  textGenerator?: (
    flowJson: unknown,
    chat?: (input: string, options?: { stream?: boolean }) => Promise<OpenAIChatResult>,
  ) => Promise<string>;
}

interface RpcEnvelope<T> {
  ok?: boolean;
  data?: T;
  code?: string;
  status?: number;
  message?: string;
}

function positiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value ?? NaN)) return fallback;
  return Math.min(Math.max(Math.trunc(value!), 1), max);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : String(value);
}

function parseClaimedJob(value: unknown): ClaimedDatasetExtractionJob {
  const raw = asRecord(value);
  const message = asRecord(raw.message);
  return {
    msg_id: Number(raw.msg_id),
    read_ct: Number(raw.read_ct ?? 0),
    message: {
      schema: asString(message.schema),
      table: asString(message.table),
      id: asString(message.id),
      version: asString(message.version),
      entity_kind: asString(message.entity_kind) as DatasetEntityKind,
      extraction_kind: asString(message.extraction_kind) as DatasetExtractionKind,
      created_at: message.created_at === undefined ? undefined : asString(message.created_at),
    },
  };
}

function assertFlowJob(job: ClaimedDatasetExtractionJob): void {
  const message = job.message;
  if (message.schema !== 'public' || message.table !== 'flows' || message.entity_kind !== 'flow') {
    throw Object.assign(new Error('Unsupported dataset extraction job entity'), {
      code: 'UNSUPPORTED_ENTITY_KIND',
    });
  }
  if (message.extraction_kind !== 'extracted_md' && message.extraction_kind !== 'extracted_text') {
    throw Object.assign(new Error('Unsupported dataset extraction kind'), {
      code: 'UNSUPPORTED_EXTRACTION_KIND',
    });
  }
  if (!message.id || !message.version) {
    throw Object.assign(new Error('Dataset extraction job is missing id or version'), {
      code: 'INVALID_JOB_MESSAGE',
    });
  }
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = Reflect.get(error, 'code');
    if (typeof code === 'string' && code.trim()) return code;
  }
  return 'DATASET_EXTRACTION_JOB_FAILED';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function recordTerminalFailure(
  supabase: SupabaseClient,
  job: ClaimedDatasetExtractionJob,
  reason: string,
  message: string,
): Promise<void> {
  const { error } = await supabase.rpc('cmd_dataset_extraction_record_failure', {
    p_msg_id: job.msg_id,
    p_read_count: job.read_ct,
    p_reason: reason,
    p_message: job.message,
    p_last_error: message,
    p_delete: true,
  });

  if (error) throw error;
}

async function fetchFlowJson(
  supabase: SupabaseClient,
  id: string,
  version: string,
): Promise<unknown> {
  const { data, error } = await supabase
    .from('flows')
    .select('id,version,json_ordered')
    .eq('id', id)
    .eq('version', version)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw Object.assign(new Error('Flow row was not found for dataset extraction job'), {
      code: 'FLOW_NOT_FOUND',
    });
  }

  return normalizeJsonOrdered((data as { json_ordered?: unknown }).json_ordered);
}

async function updateFlowExtraction(
  supabase: SupabaseClient,
  id: string,
  version: string,
  values: { extracted_md?: string; extracted_text?: string },
): Promise<void> {
  const { error } = await supabase.from('flows').update(values).eq('id', id).eq('version', version);
  if (error) throw error;
}

async function processFlowJob(
  supabase: SupabaseClient,
  job: ClaimedDatasetExtractionJob,
  markdownGenerator: (flowJson: unknown) => string,
  textGenerator: (flowJson: unknown) => Promise<string>,
): Promise<void> {
  assertFlowJob(job);
  const { id, version, extraction_kind } = job.message;
  const flowJson = await fetchFlowJson(supabase, id, version);

  if (extraction_kind === 'extracted_md') {
    const markdown = markdownGenerator(flowJson);
    if (!markdown.trim()) {
      throw Object.assign(new Error('Empty extracted markdown'), {
        code: 'EMPTY_EXTRACTED_MD',
      });
    }
    await updateFlowExtraction(supabase, id, version, { extracted_md: markdown });
    return;
  }

  const summary = await textGenerator(flowJson);
  await updateFlowExtraction(supabase, id, version, { extracted_text: summary });
}

export async function processDatasetExtractionJobs(
  options: DatasetExtractionWorkerOptions,
): Promise<DatasetExtractionWorkerResult> {
  const batchSize = positiveInteger(options.batchSize, 5, 50);
  const visibilityTimeoutSeconds = positiveInteger(options.visibilityTimeoutSeconds, 300, 3600);
  const maxReadCount = positiveInteger(options.maxReadCount, 5, 100);
  const markdownGenerator = options.markdownGenerator ?? generateFlowMarkdown;
  const textGenerator = options.textGenerator ?? generateFlowTextSummary;

  const { data, error } = await options.supabase.rpc('cmd_dataset_extraction_claim', {
    p_qty: batchSize,
    p_vt_seconds: visibilityTimeoutSeconds,
    p_max_read_count: maxReadCount,
  });

  if (error) throw error;

  const envelope = data as RpcEnvelope<unknown[]>;
  if (envelope?.ok === false) {
    throw Object.assign(new Error(envelope.message ?? 'Dataset extraction claim failed'), {
      code: envelope.code ?? 'DATASET_EXTRACTION_CLAIM_FAILED',
      status: envelope.status,
    });
  }

  const jobs = Array.isArray(envelope?.data) ? envelope.data.map(parseClaimedJob) : [];
  const ackIds: number[] = [];
  const results: DatasetExtractionJobResult[] = [];

  for (const job of jobs) {
    const start = Date.now();
    const baseLog = {
      msg_id: job.msg_id,
      entity_kind: job.message.entity_kind,
      table: job.message.table,
      id: job.message.id,
      version: job.message.version,
      extraction_kind: job.message.extraction_kind,
      retry_count: job.read_ct,
    };

    try {
      await processFlowJob(options.supabase, job, markdownGenerator, (flowJson) =>
        textGenerator(flowJson),
      );
      ackIds.push(job.msg_id);
      const result = {
        ...baseLog,
        status: 'success' as const,
        duration_ms: Date.now() - start,
      };
      console.log('[dataset_extraction_job]', { ...result, stage: 'success' });
      results.push(result);
    } catch (caught) {
      const code = errorCode(caught);
      const message = errorMessage(caught);
      const terminal = code === 'UNSUPPORTED_ENTITY_KIND' || job.read_ct >= maxReadCount;

      if (terminal) {
        await recordTerminalFailure(options.supabase, job, code, message);
      }

      const result = {
        ...baseLog,
        status:
          code === 'UNSUPPORTED_ENTITY_KIND'
            ? ('unsupported' as const)
            : terminal
              ? ('failed' as const)
              : ('retry' as const),
        duration_ms: Date.now() - start,
        error_code: code,
        error_message: message,
      };
      console.error('[dataset_extraction_job]', { ...result, stage: result.status });
      results.push(result);
    }
  }

  if (ackIds.length > 0) {
    const { error: ackError } = await options.supabase.rpc('cmd_dataset_extraction_ack', {
      p_msg_ids: ackIds,
    });
    if (ackError) throw ackError;
  }

  return {
    claimed: jobs.length,
    acked: ackIds.length,
    results,
  };
}
