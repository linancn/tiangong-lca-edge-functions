#!/usr/bin/env node
'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { lstatSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { parseEnv } = require('node:util');
const { performance } = require('node:perf_hooks');
const { runInNewContext } = require('node:vm');

const REPO_ROOT = resolve(__dirname, '..');
const ENDPOINT = 'https://api.openai.com/v1/responses';
const MODELS = { baseline: 'gpt-5.4-nano', candidate: 'gpt-6-luna' };
const TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS = 64;
const ORIGINAL_FIXTURE_SHA256 = 'c38188e32cde438f076e26498f2942af3b53e9bcdeac4213beb8cc62cbfa52b3';

class EvaluationError extends Error {}

function parseArguments(args) {
  const options = {
    baseline: MODELS.baseline,
    candidate: MODELS.candidate,
    repetitions: 2,
    phase: 'model-only',
  };
  const flags = {
    '--key-file': 'keyFile',
    '--out-dir': 'outDir',
    '--baseline': 'baseline',
    '--candidate': 'candidate',
    '--repetitions': 'repetitions',
    '--phase': 'phase',
    '--rescore-dir': 'rescoreDir',
  };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = flags[args[i]];
    if (!key || seen.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new EvaluationError('Invalid evaluation arguments');
    }
    seen.add(key);
    options[key] = args[++i];
  }
  if (
    (!options.keyFile && !options.rescoreDir) ||
    (options.keyFile && options.rescoreDir) ||
    !options.outDir ||
    options.baseline !== MODELS.baseline ||
    options.candidate !== MODELS.candidate ||
    !['model-only', 'tuned'].includes(options.phase) ||
    !/^[1-2]$/u.test(String(options.repetitions))
  ) {
    throw new EvaluationError(
      'Usage: node scripts/evaluate-hybrid-rewrite.cjs (--key-file <path> | --rescore-dir <prior-run>) --out-dir <path> [--phase model-only|tuned --baseline gpt-5.4-nano --candidate gpt-6-luna --repetitions 2]',
    );
  }
  options.repetitions = Number(options.repetitions);
  return options;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function verifyPromptContract(fixture, repoRoot = REPO_ROOT, read = readFileSync) {
  const shared = join(repoRoot, 'supabase/functions/_shared');
  const source = read(join(shared, 'hybrid_query_utils.ts'), 'utf8');
  const schemaSource = source.match(
    /export const hybridQuerySchema: Record<string, unknown> = ([\s\S]*?);\n\nexport const HYBRID_SYNONYM_RULES/u,
  )?.[1];
  const rules = source.match(/export const HYBRID_SYNONYM_RULES = `([\s\S]*?)`;/u)?.[1];
  const contract =
    fixture.phase === 'tuned' ? fixture.candidatePromptContract : fixture.promptContract;
  if (
    !schemaSource ||
    sha256(schemaSource) !== contract.schemaSourceSha256 ||
    rules !== contract.synonymRules
  ) {
    throw new EvaluationError('Frozen rewrite schema/rules differ from repository source');
  }
  // The verified declaration is a plain object literal, with no imports or environment access.
  const sourceSchema = runInNewContext(`(${schemaSource})`, Object.create(null), { timeout: 100 });
  if (JSON.stringify(sourceSchema) !== JSON.stringify(contract.schema)) {
    throw new EvaluationError('Frozen rewrite schema contents differ from repository source');
  }
  for (const file of ['hybrid_search_kernel.ts', 'portal_hybrid_kernel.ts']) {
    const template = read(join(shared, file), 'utf8').match(
      /systemPrompt: `([\s\S]*?)`,\n\s*userPrompt: `([\s\S]*?)`,/u,
    );
    if (template?.[1] !== contract.systemTemplate || template?.[2] !== contract.userTemplate) {
      throw new EvaluationError('Frozen rewrite prompts differ from repository source');
    }
  }
  return sha256(JSON.stringify(contract));
}

function loadFixture(repoRoot = REPO_ROOT, phase = 'model-only') {
  if (!['model-only', 'tuned'].includes(phase))
    throw new EvaluationError('Invalid evaluation phase');
  const originalText = readFileSync(
    join(repoRoot, 'test/fixtures/hybrid-rewrite-eval.json'),
    'utf8',
  );
  if (sha256(originalText) !== ORIGINAL_FIXTURE_SHA256) {
    throw new EvaluationError('Original model-only fixture changed; preserve baseline evidence');
  }
  const fixture = JSON.parse(
    phase === 'model-only'
      ? originalText
      : readFileSync(
          join(
            repoRoot,
            `test/fixtures/hybrid-rewrite-eval${phase === 'tuned' ? '-tuned' : ''}.json`,
          ),
          'utf8',
        ),
  );
  if (
    fixture.schemaVersion !==
      (phase === 'tuned' ? 'hybrid-rewrite-eval-tuned.v1' : 'hybrid-rewrite-eval.v1') ||
    fixture.baselineModel !== MODELS.baseline ||
    fixture.candidateModel !== MODELS.candidate ||
    fixture.cases.length !== 12 ||
    fixture.cases.filter((item) => item.portal).length !== 4 ||
    new Set(fixture.cases.map((item) => item.id)).size !== 12
  ) {
    throw new EvaluationError('Invalid frozen evaluation fixture');
  }
  if (phase === 'tuned') {
    const original = JSON.parse(
      readFileSync(join(repoRoot, 'test/fixtures/hybrid-rewrite-eval.json'), 'utf8'),
    );
    if (
      JSON.stringify(fixture.promptContract) !== JSON.stringify(original.promptContract) ||
      JSON.stringify(fixture.cases.map(({ expectations, ...item }) => item)) !==
        JSON.stringify(original.cases.map(({ expectations, ...item }) => item))
    ) {
      throw new EvaluationError(
        'Tuned fixture must retain original baseline contract and fixed case inputs',
      );
    }
  }
  // Model-only intentionally reproduces the immutable original contract after runtime tuning.
  // Tuned runs additionally prove the candidate contract matches current runtime source.
  if (phase === 'tuned') verifyPromptContract(fixture, repoRoot);
  return fixture;
}

function buildSchedule(fixture, repetitions) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 2) {
    throw new EvaluationError('Evaluation repetitions must be 1 or 2');
  }
  const schedule = [];
  let pairIndex = 0;
  for (let repetition = 0; repetition < repetitions; repetition++) {
    pairIndex = repetition;
    for (const profile of ['raw', 'portal']) {
      for (const item of fixture.cases.filter((entry) => profile === 'raw' || entry.portal)) {
        const order = pairIndex++ % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
        for (const arm of order) {
          schedule.push({
            sequence: schedule.length + 1,
            pair: `${profile}:${item.id}:${repetition + 1}`,
            caseId: item.id,
            profile,
            arm,
            model: MODELS[arm],
            repetition: repetition + 1,
          });
        }
      }
    }
  }
  validateScheduleBudget(schedule);
  return schedule;
}

function validateScheduleBudget(schedule) {
  if (schedule.length < 1 || schedule.length > MAX_REQUESTS) {
    throw new EvaluationError('Evaluation schedule exceeds the 64-request budget');
  }
}

function buildParameters(fixture, item, job) {
  const tunedCandidate = fixture.phase === 'tuned' && job.arm === 'candidate';
  const contract = tunedCandidate ? fixture.candidatePromptContract : fixture.promptContract;
  const system = contract.systemTemplate
    .replace('${config.entityPlural}', item.entityPlural)
    .replace('${HYBRID_SYNONYM_RULES}', contract.synonymRules);
  const user = contract.userTemplate
    .replace('${config.entityLabel}', item.entityLabel)
    .replace('${queryText}', item.query);
  return {
    model: job.model,
    temperature: 0,
    ...(job.profile === 'portal'
      ? { store: false, max_output_tokens: 256, reasoning: { effort: 'none' } }
      : job.arm === 'candidate'
        ? { reasoning: { effort: 'none' } }
        : {}),
    input: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    text: {
      ...(job.profile === 'portal' || tunedCandidate ? { verbosity: 'low' } : {}),
      format: {
        type: 'json_schema',
        name: `${job.profile === 'portal' ? 'portal_hybrid_search_v1' : `${item.entityKind}_hybrid_search`}_queries`,
        schema: contract.schema,
        strict: true,
      },
    },
  };
}

function readApiKey(path, dependencies = {}) {
  const stat = dependencies.lstat ?? lstatSync;
  const read = dependencies.read ?? readFileSync;
  try {
    if (!stat(resolve(path)).isFile()) throw new Error();
    // Only the selected OpenAI value leaves the parser; process.env is never assigned.
    const key = parseEnv(read(resolve(path), 'utf8')).OPENAI_API_KEY;
    if (!key || key !== key.trim() || !/^[!-~]{8,4096}$/u.test(key)) throw new Error();
    return key;
  } catch {
    throw new EvaluationError('Unable to read a valid OPENAI_API_KEY from the supplied file');
  }
}

function redact(value, secret) {
  // Redact decoded strings and keys before encoding, including quotes/backslashes in a key.
  if (typeof value === 'string') return value.split(secret).join('[REDACTED]');
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [redact(key, secret), redact(entry, secret)]),
    );
  }
  return value;
}

function extractText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  if (!Array.isArray(response?.output)) return '';
  return response.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function scoreRaw(response, item) {
  const hardFailures = [];
  let parsed = null;
  try {
    parsed = JSON.parse(extractText(response));
  } catch {
    hardFailures.push('invalid_json');
  }
  const complete = response?.status === 'completed';
  if (!complete) hardFailures.push('incomplete');
  const structure = Boolean(
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Object.keys(parsed).sort().join(',') ===
      'fulltext_query_en,fulltext_query_zh,semantic_query_en' &&
    typeof parsed.semantic_query_en === 'string' &&
    parsed.semantic_query_en.trim() &&
    ['fulltext_query_en', 'fulltext_query_zh'].every(
      (key) => Array.isArray(parsed[key]) && parsed[key].every((term) => typeof term === 'string'),
    ),
  );
  if (!structure) hardFailures.push('invalid_structure');
  if (!structure) return { parsed, complete, checks: { structure }, hardFailures };
  const semantic = parsed.semantic_query_en;
  const aliases = [...parsed.fulltext_query_en, ...parsed.fulltext_query_zh];
  const allText = [semantic, ...aliases].join('\n');
  const expectation = item.expectations;
  const matches = (pattern, text) => new RegExp(pattern, 'iu').test(text);
  if (expectation.allowedChemicalNames) {
    const normalize = (value) => value.replace(/\s+/gu, ' ').trim().toLowerCase();
    const names = expectation.allowedChemicalNames.map(normalize);
    const verifiedName = normalize(expectation.verifiedChemicalName);
    const allowedTerm = (term) => {
      const normalized = normalize(term);
      if (names.includes(normalized)) return true;
      return expectation.allowedChemicalIdentifiers.some((id) => {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const identifier = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, 'gu');
        if (!identifier.test(normalized)) return false;
        identifier.lastIndex = 0;
        const remainder = normalized
          .replace(identifier, '')
          .replace(/\bcas\b/gu, '')
          .replace(/[()[\],;:\s]/gu, '');
        return remainder === '' || remainder === verifiedName.replace(/\s/gu, '');
      });
    };
    if ([semantic, ...aliases].some((term) => !allowedTerm(term))) {
      hardFailures.push('unverified_chemical_term');
    }
  }
  if (expectation.standardTuple) {
    const { number, year } = expectation.standardTuple;
    const bounded = (value) => new RegExp(`(?<!\\d)${value}(?!\\d)`, 'u');
    if (!bounded(number).test(semantic) || !bounded(year).test(semantic)) {
      hardFailures.push('standard_tuple_lost');
    }
    const wrongTuple = [semantic, ...aliases].some((term) => {
      const years = term.match(/\b(?:19|20)\d{2}\b/gu) ?? [];
      const isoNumbers = [...term.matchAll(/\bISO\s*(\d{4,5})\b/giu)].map((match) => match[1]);
      const bareRelatedNumbers = term.match(/\b14\d{3}\b/gu) ?? [];
      return (
        years.some((value) => value !== year) ||
        [...isoNumbers, ...bareRelatedNumbers].some((value) => value !== number)
      );
    });
    if (wrongTuple) hardFailures.push('standard_tuple_mismatch');
  }
  for (const pattern of expectation.hardSemanticAll ?? []) {
    if (!matches(pattern, semantic)) hardFailures.push('critical_meaning_lost');
  }
  for (const pattern of expectation.forbidden ?? []) {
    if (matches(pattern, allText)) hardFailures.push('forbidden_substitution');
  }
  if (
    expectation.semanticExact &&
    semantic.trim().toLowerCase() !== expectation.semanticExact.toLowerCase()
  ) {
    hardFailures.push('speculative_expansion');
  }
  if (
    expectation.aliasAllowedExact &&
    aliases.some(
      (term) =>
        !expectation.aliasAllowedExact.some(
          (allowed) => allowed.toLowerCase() === term.trim().toLowerCase(),
        ),
    )
  ) {
    hardFailures.push('speculative_expansion');
  }
  if (
    aliases.some((term) =>
      (expectation.standaloneAliasForbidden ?? []).some((pattern) => matches(pattern, term.trim())),
    )
  ) {
    hardFailures.push('alias_meaning_lost');
  }
  for (const id of expectation.requiredIdentifiers ?? []) {
    // Do not accept a required identifier solely as a substring of another identifier.
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (!matches(`(?<![\\w-])${escaped}(?![\\w-])`, allText)) {
      hardFailures.push('required_identifier_lost');
    }
  }
  const identifiers = allText.match(/\b\d{2,7}-\d{2}-\d\b/gu) ?? [];
  if (identifiers.some((id) => !(expectation.allowedIdentifiers ?? []).includes(id))) {
    hardFailures.push('unapproved_cas_identifier');
  }
  const forbiddenAlias =
    /life\s*cycle|lifecycle|assessment|environmental impact|生命周期|评估|环境影响|查询|检索|描述/iu;
  const english = (term) => /[a-z]/iu.test(term) && !/[\u4e00-\u9fff\u0400-\u04ff]/u.test(term);
  const cas = (term) => /^\d{2,7}-\d{2}-\d$/u.test(term);
  const languageExemption = (term) =>
    (expectation.languageExemptions ?? []).some((pattern) => matches(pattern, term.trim()));
  const checks = {
    structure,
    englishSemantic: english(semantic) || languageExemption(semantic),
    semanticMeaning: (expectation.semanticAll ?? []).every((pattern) => matches(pattern, semantic)),
    englishAliases: parsed.fulltext_query_en.every(
      (term) => english(term) || cas(term) || languageExemption(term),
    ),
    chineseAliases: parsed.fulltext_query_zh.every(
      (term) => /[\u4e00-\u9fff]/u.test(term) || cas(term) || languageExemption(term),
    ),
    dictionaryAliases: aliases.every((term) => term.trim() && !forbiddenAlias.test(term)),
    noDuplicates: [parsed.fulltext_query_en, parsed.fulltext_query_zh].every(
      (terms) => new Set(terms.map((term) => term.trim().toLowerCase())).size === terms.length,
    ),
    nonemptyAliases: parsed.fulltext_query_en.length > 0 && parsed.fulltext_query_zh.length > 0,
  };
  return {
    parsed,
    complete,
    checks,
    hardFailures: [...new Set(hardFailures)],
    manualReview: expectation.manualReview ?? null,
    ...(expectation.criteriaRevision
      ? {
          criteriaRevision: expectation.criteriaRevision,
          languageExemptionsApplied: [...new Set([semantic, ...aliases].filter(languageExemption))],
        }
      : {}),
  };
}

function sanitizeResponse(raw, apiKey) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  // Retain provider output JSON and measured metadata, never error bodies or request echoes.
  const selected = Object.fromEntries(
    ['id', 'status', 'model', 'reasoning', 'usage', 'incomplete_details', 'output', 'output_text']
      .filter((key) => Object.hasOwn(raw, key))
      .map((key) => [key, raw[key]]),
  );
  return redact(selected, apiKey);
}

function tokenUsage(response) {
  const number = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
  return {
    input: number(response?.usage?.input_tokens),
    output: number(response?.usage?.output_tokens),
    total: number(response?.usage?.total_tokens),
    cachedInput: number(response?.usage?.input_tokens_details?.cached_tokens),
    reasoningOutput: number(response?.usage?.output_tokens_details?.reasoning_tokens),
  };
}

async function readBoundedJson(response) {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error();
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error();
  } finally {
    reader.releaseLock();
  }
}

async function measureRequest(parameters, apiKey, item, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? (() => performance.now());
  const signal = dependencies.signal ?? AbortSignal.timeout(TIMEOUT_MS);
  const start = now();
  let result;
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(parameters),
    });
    if (!response.ok) {
      // Never read or retain upstream error bodies, which may echo request/header details.
      await response.body?.cancel().catch(() => {});
      result = {
        outcome:
          response.status === 429
            ? 'capacity_failure'
            : response.status >= 400 && response.status < 500
              ? 'configuration_failure'
              : 'provider_failure',
        httpStatus: response.status,
      };
    } else {
      let raw;
      try {
        raw = await readBoundedJson(response);
      } catch {
        result = {
          outcome: signal.aborted ? 'timeout' : 'malformed_response',
          httpStatus: response.status,
        };
      }
      if (!result) {
        const safe = sanitizeResponse(raw, apiKey);
        if (!safe) {
          result = { outcome: 'malformed_response', httpStatus: response.status };
        } else if (safe.status === 'failed') {
          result = { outcome: 'provider_failure', httpStatus: response.status };
        } else {
          const score = scoreRaw(safe, item);
          result = {
            outcome: 'observed',
            httpStatus: response.status,
            status: typeof safe.status === 'string' ? safe.status : null,
            effectiveModel: typeof safe.model === 'string' ? safe.model : null,
            requestedEffort: parameters.reasoning?.effort ?? null,
            effectiveEffort: safe.reasoning?.effort ?? null,
            incompleteReason: ['max_output_tokens', 'content_filter'].includes(
              safe.incomplete_details?.reason,
            )
              ? safe.incomplete_details.reason
              : null,
            usage: tokenUsage(safe),
            score,
            rawResponse: safe,
          };
        }
      }
    }
  } catch {
    result = { outcome: signal.aborted ? 'timeout' : 'transport_failure', httpStatus: null };
  }
  return { ...result, latencyMs: Math.round((now() - start) * 1000) / 1000 };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function acceptedObservation(record) {
  return Boolean(
    record.outcome === 'observed' &&
    record.score?.complete === true &&
    record.score.hardFailures.length === 0 &&
    record.score.checks.structure === true &&
    Object.values(record.score.checks).every(Boolean),
  );
}

function aggregate(records, plannedRequests) {
  const groups = [];
  for (const profile of ['raw', 'portal']) {
    for (const arm of ['baseline', 'candidate']) {
      const selected = records.filter((record) => record.profile === profile && record.arm === arm);
      const observations = selected.filter((record) => record.outcome === 'observed');
      const accepted = observations.filter(acceptedObservation);
      const usage = {};
      for (const key of ['input', 'output', 'total', 'cachedInput', 'reasoningOutput']) {
        const known = observations.map((record) => record.usage[key]).filter((n) => n !== null);
        usage[key] = {
          sum: known.length ? known.reduce((a, b) => a + b, 0) : null,
          known: known.length,
        };
      }
      groups.push({
        profile,
        arm,
        attempts: selected.length,
        observed: observations.length,
        acceptedOutputs: accepted.length,
        failures: selected.filter((record) => record.outcome !== 'observed').length,
        hardFailureObservations: observations.filter((record) => record.score.hardFailures.length)
          .length,
        passedChecks: observations.reduce(
          (sum, record) => sum + Object.values(record.score.checks).filter(Boolean).length,
          0,
        ),
        totalChecks: observations.reduce(
          (sum, record) => sum + Object.keys(record.score.checks).length,
          0,
        ),
        failedChecks: observations.flatMap((record) =>
          Object.entries(record.score.checks)
            .filter(([, pass]) => !pass)
            .map(([check]) => ({ caseId: record.caseId, repetition: record.repetition, check })),
        ),
        medianLatencyMs: median(observations.map((record) => record.latencyMs)),
        acceptedMedianLatencyMs: median(accepted.map((record) => record.latencyMs)),
        minLatencyMs: observations.length
          ? Math.min(...observations.map((record) => record.latencyMs))
          : null,
        maxLatencyMs: observations.length
          ? Math.max(...observations.map((record) => record.latencyMs))
          : null,
        usage,
      });
    }
  }
  const pairs = [];
  for (const pair of new Set(records.map((record) => record.pair))) {
    const baseline = records.find((record) => record.pair === pair && record.arm === 'baseline');
    const candidate = records.find((record) => record.pair === pair && record.arm === 'candidate');
    if (baseline?.outcome === 'observed' && candidate?.outcome === 'observed') {
      pairs.push({
        pair,
        profile: baseline.profile,
        baselineMs: baseline.latencyMs,
        candidateMs: candidate.latencyMs,
        deltaMs: candidate.latencyMs - baseline.latencyMs,
        ratio: baseline.latencyMs > 0 ? candidate.latencyMs / baseline.latencyMs : null,
        acceptedOutputs: acceptedObservation(baseline) && acceptedObservation(candidate),
      });
    }
  }
  return {
    schemaVersion: 'hybrid-rewrite-eval-summary.v1',
    plannedRequests,
    attemptedRequests: records.length,
    completedSchedule: records.length === plannedRequests,
    groups,
    pairs,
    pairScope:
      'All observed pairs, including rejected output; use acceptedPairs for screened quality comparisons.',
    acceptedPairs: pairs.filter((pair) => pair.acceptedOutputs),
    pairedMedianDeltaMs: Object.fromEntries(
      ['raw', 'portal'].map((profile) => [
        profile,
        median(pairs.filter((pair) => pair.profile === profile).map((pair) => pair.deltaMs)),
      ]),
    ),
    acceptedPairedMedianDeltaMs: Object.fromEntries(
      ['raw', 'portal'].map((profile) => [
        profile,
        median(
          pairs
            .filter((pair) => pair.profile === profile && pair.acceptedOutputs)
            .map((pair) => pair.deltaMs),
        ),
      ]),
    ),
    limitations: [
      'Small sequential sample; no stable p95 or production load conclusion.',
      'Latency includes transport and response-body read; no retries or warmups.',
      'Raw baseline omits reasoning; raw candidate explicitly requests none.',
      'Regex checks screen synthetic raw output; normalization and downstream retrieval are separate proof.',
      'Cached input and reasoning tokens are unknown when omitted, never assumed zero.',
      'Accepted timings require both complete outputs, zero hard failures, and every raw screening check passing; human and retrieval review remain required.',
    ],
  };
}

async function runEvaluation(options, dependencies = {}) {
  if (options.rescoreDir) return rescoreEvaluation(options, dependencies);
  const fixture = dependencies.fixture ?? loadFixture(REPO_ROOT, options.phase ?? 'model-only');
  const schedule = buildSchedule(fixture, options.repetitions);
  validateScheduleBudget(schedule);
  const apiKey = (dependencies.readKey ?? readApiKey)(options.keyFile);
  const runDirectory = join(resolve(options.outDir), randomUUID());
  mkdirSync(resolve(options.outDir), { recursive: true, mode: 0o700 });
  mkdirSync(runDirectory, { mode: 0o700 });
  const save = (name, value) =>
    writeFileSync(join(runDirectory, name), `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  save('manifest.json', {
    schemaVersion: 'hybrid-rewrite-eval-run.v1',
    startedAt: new Date().toISOString(),
    phase: options.phase ?? 'model-only',
    criteriaRevision: fixture.criteriaRevision ?? 'hybrid-rewrite-criteria.v1',
    fixture,
    schedule,
    timeoutMs: TIMEOUT_MS,
    maxRetries: 0,
    endpoint: ENDPOINT,
    profileParameters:
      fixture.phase === 'tuned'
        ? 'Original baseline contract; tuned candidate contract and raw verbosity low; Portal none/store:false/low/256.'
        : 'Checked-in raw baseline and raw candidate none; Portal none/store:false/low/256.',
  });
  const records = [];
  for (const job of schedule) {
    const item = fixture.cases.find((entry) => entry.id === job.caseId);
    const result = await measureRequest(
      buildParameters(fixture, item, job),
      apiKey,
      item,
      dependencies,
    );
    const record = { ...job, ...result };
    save(`${String(job.sequence).padStart(3, '0')}-${job.arm}.json`, record);
    records.push(record);
    dependencies.progress?.(records.length, schedule.length);
    // Invalid provider/configuration is not evidence of rewrite quality. Stop spending.
    if (
      [
        'configuration_failure',
        'capacity_failure',
        'provider_failure',
        'transport_failure',
        'timeout',
        'malformed_response',
      ].includes(result.outcome)
    )
      break;
  }
  const summary = aggregate(records, schedule.length);
  summary.phase = options.phase ?? 'model-only';
  summary.criteriaRevision = fixture.criteriaRevision ?? 'hybrid-rewrite-criteria.v1';
  save('summary.json', summary);
  return { runDirectory, summary };
}

async function rescoreEvaluation(options, dependencies = {}) {
  if (options.keyFile) throw new EvaluationError('Rescoring must not receive a key file');
  const fixture = dependencies.fixture ?? loadFixture(REPO_ROOT, options.phase ?? 'model-only');
  const sourceDirectory = resolve(options.rescoreDir);
  const manifestText = readFileSync(join(sourceDirectory, 'manifest.json'), 'utf8');
  const sourceManifest = JSON.parse(manifestText);
  validateScheduleBudget(sourceManifest.schedule);
  const expected = buildSchedule(fixture, sourceManifest.schedule.length / 32);
  if (
    JSON.stringify(sourceManifest.schedule) !== JSON.stringify(expected) ||
    JSON.stringify(sourceManifest.fixture.cases.map(({ expectations, ...item }) => item)) !==
      JSON.stringify(fixture.cases.map(({ expectations, ...item }) => item))
  ) {
    throw new EvaluationError('Rescoring requires the complete fixed original corpus schedule');
  }
  // Read and verify every scheduled record before writing a new run. Missing evidence fails closed.
  const sources = expected.map((job) => {
    const file = `${String(job.sequence).padStart(3, '0')}-${job.arm}.json`;
    const text = readFileSync(join(sourceDirectory, file), 'utf8');
    const record = JSON.parse(text);
    if (Object.keys(job).some((key) => record[key] !== job[key])) {
      throw new EvaluationError('Rescoring source record does not match its schedule');
    }
    return { record, file, sha256: sha256(text) };
  });
  const runDirectory = join(resolve(options.outDir), randomUUID());
  mkdirSync(resolve(options.outDir), { recursive: true, mode: 0o700 });
  mkdirSync(runDirectory, { mode: 0o700 });
  const save = (name, value) =>
    writeFileSync(join(runDirectory, name), `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  save('manifest.json', {
    schemaVersion: 'hybrid-rewrite-eval-rescore.v1',
    startedAt: new Date().toISOString(),
    phase: 'offline-rescore',
    criteriaRevision: fixture.criteriaRevision ?? 'hybrid-rewrite-criteria.v1',
    sourceDirectory,
    sourceManifestSha256: sha256(manifestText),
    sourcePhase: sourceManifest.phase ?? 'model-only',
    fixture,
    schedule: expected,
    apiRequests: 0,
    sourceRecords: sources.map(({ file, sha256: digest }) => ({ file, sha256: digest })),
  });
  const records = sources.map(({ record, file, sha256: digest }) => {
    const item = fixture.cases.find((entry) => entry.id === record.caseId);
    const rescored = {
      ...record,
      previousScore: record.score ?? null,
      ...(record.outcome === 'observed' ? { score: scoreRaw(record.rawResponse, item) } : {}),
      criteriaRevision: fixture.criteriaRevision ?? 'hybrid-rewrite-criteria.v1',
      sourceRecordSha256: digest,
    };
    save(file, rescored);
    return rescored;
  });
  const summary = aggregate(records, expected.length);
  summary.phase = 'offline-rescore';
  summary.criteriaRevision = fixture.criteriaRevision ?? 'hybrid-rewrite-criteria.v1';
  summary.sourceManifestSha256 = sha256(manifestText);
  summary.apiRequests = 0;
  save('summary.json', summary);
  return { runDirectory, summary };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const { runDirectory, summary } = await runEvaluation(options, {
      progress: (done, total) => process.stdout.write(`Rewrite evaluation: ${done}/${total}\n`),
    });
    process.stdout.write(`Private evidence: ${runDirectory}\n`);
    process.stdout.write(
      `Schedule ${summary.completedSchedule ? 'complete' : 'stopped'}; inspect summary.json for quality observations.\n`,
    );
    process.exitCode = summary.completedSchedule ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof EvaluationError ? error.message : 'Rewrite evaluation failed; retain any existing evidence.'}\n`,
    );
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = {
  EvaluationError,
  ENDPOINT,
  aggregate,
  buildParameters,
  buildSchedule,
  extractText,
  loadFixture,
  measureRequest,
  parseArguments,
  readApiKey,
  redact,
  sanitizeResponse,
  runEvaluation,
  rescoreEvaluation,
  scoreRaw,
  tokenUsage,
  verifyPromptContract,
};
