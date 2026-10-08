'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const {
  ENDPOINT,
  aggregate,
  buildParameters,
  buildSchedule,
  loadFixture,
  measureRequest,
  parseArguments,
  readApiKey,
  redact,
  runEvaluation,
  scoreRaw,
  sanitizeResponse,
  tokenUsage,
  verifyPromptContract,
} = require('./evaluate-hybrid-rewrite.cjs');

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../test/fixtures/hybrid-rewrite-eval.json'), 'utf8'),
);
const tunedFixture = loadFixture(join(__dirname, '..'), 'tuned');
const chemical = fixture.cases.find((item) => item.id === 'flow-dichloromethane');
const rewrite = {
  semantic_query_en: 'dichloromethane',
  fulltext_query_en: ['dichloromethane', 'methylene chloride', '75-09-2'],
  fulltext_query_zh: ['二氯甲烷', '75-09-2'],
};
const responseFor = (value, overrides = {}) => ({
  status: 'completed',
  model: 'gpt-6-luna',
  reasoning: { effort: 'none' },
  usage: {
    input_tokens: 100,
    output_tokens: 42,
    total_tokens: 142,
    input_tokens_details: { cached_tokens: 24 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  ...overrides,
});

test('fixed corpus covers seven generic routes and four Portal cases', () => {
  assert.equal(fixture.cases.length, 12);
  assert.equal(new Set(fixture.cases.map((item) => item.entityKind)).size, 7);
  assert.equal(fixture.cases.filter((item) => item.portal).length, 4);
  verifyPromptContract(tunedFixture);
  const changed = structuredClone(tunedFixture);
  changed.candidatePromptContract.schema.additionalProperties = true;
  assert.throws(() => verifyPromptContract(changed), /schema contents differ/u);
  changed.candidatePromptContract.schema.additionalProperties = false;
  changed.candidatePromptContract.systemTemplate += 'changed';
  assert.throws(() => verifyPromptContract(changed), /prompts differ/u);
  changed.candidatePromptContract.schemaSourceSha256 = 'changed';
  assert.throws(() => verifyPromptContract(changed), /schema\/rules differ/u);
});

test('arguments fix the two models and bound request count without accepting URLs', () => {
  assert.deepEqual(parseArguments(['--key-file', 'private.env', '--out-dir', 'evidence']), {
    keyFile: 'private.env',
    outDir: 'evidence',
    baseline: 'gpt-5.4-nano',
    candidate: 'gpt-6-luna',
    repetitions: 2,
    phase: 'model-only',
  });
  for (const args of [
    ['--url', 'https://elsewhere.example'],
    ['--candidate', 'other-model'],
    ['--repetitions', '20'],
    ['--repetitions', '3'],
    ['--phase', 'unknown'],
    ['--key-file'],
    ['--key-file', 'a', '--key-file', 'b'],
  ]) {
    assert.throws(() => parseArguments(args));
  }
});

test('tuned cross-arm contracts preserve original baseline while changing only candidate prompt/schema and raw verbosity', () => {
  assert.deepEqual(tunedFixture.promptContract, fixture.promptContract);
  for (const profile of ['raw', 'portal']) {
    const baselineJob = { arm: 'baseline', model: 'gpt-5.4-nano', profile };
    const candidateJob = { arm: 'candidate', model: 'gpt-6-luna', profile };
    const originalBaseline = buildParameters(fixture, chemical, baselineJob);
    const tunedBaseline = buildParameters(tunedFixture, chemical, baselineJob);
    assert.deepEqual(tunedBaseline, originalBaseline);
    const originalCandidate = buildParameters(fixture, chemical, candidateJob);
    const tunedCandidate = buildParameters(tunedFixture, chemical, candidateJob);
    assert.notEqual(tunedCandidate.input[0].content, originalCandidate.input[0].content);
    assert.deepEqual(
      tunedCandidate.text.format.schema,
      tunedFixture.candidatePromptContract.schema,
    );
    assert.equal(tunedCandidate.input[1].content, originalCandidate.input[1].content);
    assert.equal(tunedCandidate.text.verbosity, 'low');
    assert.deepEqual(tunedCandidate.reasoning, { effort: 'none' });
    assert.equal(tunedCandidate.max_output_tokens, originalCandidate.max_output_tokens);
    assert.equal(tunedCandidate.store, originalCandidate.store);
  }
});

test('revised criteria correct chemical identity uniformly without modifying original criteria', () => {
  const item = tunedFixture.cases.find((entry) => entry.id === 'flow-long-chemical');
  const bad = {
    semantic_query_en: 'quizalofop-P-tefuryl',
    fulltext_query_en: ['quizalofop-P-tefuryl', '111479-05-1'],
    fulltext_query_zh: ['111479-05-1'],
  };
  const original = fixture.cases.find((entry) => entry.id === item.id);
  assert.equal(scoreRaw(responseFor(bad), original).hardFailures.length, 0);
  assert.ok(scoreRaw(responseFor(bad), item).hardFailures.includes('forbidden_substitution'));
  for (const name of ['Propaquizafop', '111479-05-1']) {
    const good = {
      semantic_query_en: name,
      fulltext_query_en: [name, '111479-05-1'],
      fulltext_query_zh: ['111479-05-1'],
    };
    const score = scoreRaw(responseFor(good), item);
    assert.equal(score.hardFailures.length, 0);
    assert.equal(score.checks.englishSemantic, true);
    assert.equal(score.criteriaRevision, 'hybrid-rewrite-criteria.v3');
  }
});

test('revised criteria reject wrong DCM aliases, lifecycle boundary and speculative AC expansion', () => {
  const item = (id) => tunedFixture.cases.find((entry) => entry.id === id);
  assert.ok(
    scoreRaw(
      responseFor({
        ...rewrite,
        fulltext_query_en: [...rewrite.fulltext_query_en, 'Methyl chloride'],
      }),
      item('flow-dichloromethane'),
    ).hardFailures.includes('forbidden_substitution'),
  );
  assert.equal(scoreRaw(responseFor(rewrite), item('flow-dichloromethane')).hardFailures.length, 0);
  const steel = {
    semantic_query_en: 'steel cradle-to-gate',
    fulltext_query_en: ['steel gate-to-gate'],
    fulltext_query_zh: ['钢'],
  };
  assert.ok(
    scoreRaw(responseFor(steel), item('lifecyclemodel-steel')).hardFailures.includes(
      'forbidden_substitution',
    ),
  );
  const ac = {
    semantic_query_en: 'alternating current',
    fulltext_query_en: ['AC'],
    fulltext_query_zh: ['交流电'],
  };
  assert.ok(
    scoreRaw(responseFor(ac), item('flow-ambiguous-ac')).hardFailures.includes(
      'speculative_expansion',
    ),
  );
  const verbatim = {
    semantic_query_en: 'AC',
    fulltext_query_en: ['AC'],
    fulltext_query_zh: ['AC'],
  };
  assert.equal(scoreRaw(responseFor(verbatim), item('flow-ambiguous-ac')).hardFailures.length, 0);
});

test('isolated geography/voltage loses alias meaning; explicit ISO/unit language exemptions are recorded', () => {
  const item = tunedFixture.cases.find((entry) => entry.id === 'process-electricity');
  const raw = {
    semantic_query_en: 'China low-voltage electricity',
    fulltext_query_en: ['electricity', 'China', 'low voltage'],
    fulltext_query_zh: ['低压电网'],
  };
  assert.ok(scoreRaw(responseFor(raw), item).hardFailures.includes('alias_meaning_lost'));
  const source = tunedFixture.cases.find((entry) => entry.id === 'source-standard-edition');
  const score = scoreRaw(
    responseFor({
      semantic_query_en: 'ISO 14040:2006',
      fulltext_query_en: ['ISO 14040:2006'],
      fulltext_query_zh: ['ISO 14040:2006'],
    }),
    source,
  );
  assert.equal(score.checks.chineseAliases, true);
  assert.deepEqual(score.languageExemptionsApplied, ['ISO 14040:2006']);
});

test('chemical identity rejects unrelated names even beside the correct supplied CAS', () => {
  const item = tunedFixture.cases.find((entry) => entry.id === 'flow-long-chemical');
  for (const raw of [
    {
      semantic_query_en: 'acetone 111479-05-1',
      fulltext_query_en: ['acetone', '111479-05-1'],
      fulltext_query_zh: ['丙酮', '111479-05-1'],
    },
    {
      semantic_query_en: 'Propaquizafop',
      fulltext_query_en: ['acetone', '111479-05-1'],
      fulltext_query_zh: ['111479-05-1'],
    },
    {
      semantic_query_en: '111479-05-1',
      fulltext_query_en: ['Propaquizafop', '111479-05-1'],
      fulltext_query_zh: ['丙酮'],
    },
  ]) {
    assert.ok(scoreRaw(responseFor(raw), item).hardFailures.includes('unverified_chemical_term'));
  }
  for (const semantic of [
    'Propaquizafop',
    '111479-05-1',
    'CAS 111479-05-1',
    'Propaquizafop (CAS 111479-05-1)',
    item.expectations.allowedChemicalNames[1],
  ]) {
    const raw = {
      semantic_query_en: semantic,
      fulltext_query_en: ['Propaquizafop', '111479-05-1'],
      fulltext_query_zh: ['111479-05-1'],
    };
    assert.equal(
      scoreRaw(responseFor(raw), item).hardFailures.includes('unverified_chemical_term'),
      false,
    );
  }
});

test('negative fossil/recycled qualifiers cannot pass positive substring checks', () => {
  const fossil = tunedFixture.cases.find((entry) => entry.id === 'flow-fossil-carbon-dioxide');
  for (const term of [
    'non-fossil carbon dioxide',
    'non fossil carbon dioxide',
    'not fossil carbon dioxide',
  ]) {
    const raw = {
      semantic_query_en: term,
      fulltext_query_en: [term],
      fulltext_query_zh: ['非化石二氧化碳'],
    };
    assert.ok(scoreRaw(responseFor(raw), fossil).hardFailures.includes('forbidden_substitution'));
  }
  assert.ok(
    scoreRaw(
      responseFor({
        semantic_query_en: 'fossil carbon dioxide',
        fulltext_query_en: ['fossil carbon dioxide'],
        fulltext_query_zh: ['非化石二氧化碳'],
      }),
      fossil,
    ).hardFailures.includes('forbidden_substitution'),
  );
  const recycled = tunedFixture.cases.find((entry) => entry.id === 'process-recycled-aluminium');
  for (const term of [
    'unrecycled aluminium production',
    'un-recycled aluminium production',
    'non-recycled aluminium production',
    'not recycled aluminium production',
  ]) {
    const raw = {
      semantic_query_en: term,
      fulltext_query_en: [term],
      fulltext_query_zh: ['未回收铝生产'],
    };
    assert.ok(scoreRaw(responseFor(raw), recycled).hardFailures.includes('forbidden_substitution'));
  }
  assert.ok(
    scoreRaw(
      responseFor({
        semantic_query_en: 'recycled aluminium production',
        fulltext_query_en: ['recycled aluminium'],
        fulltext_query_zh: ['未回收铝生产'],
      }),
      recycled,
    ).hardFailures.includes('forbidden_substitution'),
  );
});

test('standard number/year tuple rejects conflicting aliases and detached-year repairs', () => {
  const item = tunedFixture.cases.find((entry) => entry.id === 'source-standard-edition');
  for (const aliases of [
    ['ISO 14040:1997', '2006'],
    ['ISO14040 (1997)', '2006'],
    ['ISO 14044:2006'],
    ['ISO 14040:2006', '1997'],
  ]) {
    const raw = {
      semantic_query_en: 'ISO 14040:2006',
      fulltext_query_en: aliases,
      fulltext_query_zh: ['ISO 14040:2006'],
    };
    assert.ok(scoreRaw(responseFor(raw), item).hardFailures.includes('standard_tuple_mismatch'));
  }
  const missing = {
    semantic_query_en: 'ISO 14040',
    fulltext_query_en: ['ISO 14040', '2006'],
    fulltext_query_zh: ['ISO 14040:2006'],
  };
  assert.ok(scoreRaw(responseFor(missing), item).hardFailures.includes('standard_tuple_lost'));
  const good = {
    semantic_query_en: 'ISO 14040:2006',
    fulltext_query_en: ['ISO 14040 (2006)', 'ISO 14040'],
    fulltext_query_zh: ['ISO 14040:2006'],
  };
  assert.equal(scoreRaw(responseFor(good), item).hardFailures.length, 0);
});

test('criteria revision preserves both frozen prompt contracts', () => {
  assert.deepEqual(tunedFixture.promptContract, fixture.promptContract);
  assert.equal(
    createHash('sha256').update(JSON.stringify(tunedFixture.candidatePromptContract)).digest('hex'),
    'ba42282855234a98cfda3adbe6ba0559b820a64c27e0aba0981cfd643517a894',
  );
  verifyPromptContract(tunedFixture);
});

test('64 sequential jobs contain exact matched pairs with alternating arm order', () => {
  const schedule = buildSchedule(fixture, 2);
  assert.equal(schedule.length, 64);
  assert.equal(schedule.filter((job) => job.profile === 'raw').length, 48);
  assert.equal(schedule.filter((job) => job.profile === 'portal').length, 16);
  for (let index = 0; index < schedule.length; index += 2) {
    const pair = schedule.slice(index, index + 2);
    assert.equal(pair[0].pair, pair[1].pair);
    assert.equal(pair[0].caseId, pair[1].caseId);
    assert.equal(pair[0].repetition, pair[1].repetition);
    assert.deepEqual(
      pair.map((job) => job.arm),
      (index / 2 + (pair[0].repetition - 1)) % 2
        ? ['candidate', 'baseline']
        : ['baseline', 'candidate'],
    );
  }
  for (const job of schedule.filter(
    (entry) => entry.repetition === 1 && entry.arm === 'baseline',
  )) {
    const second = schedule.find(
      (entry) =>
        entry.repetition === 2 &&
        entry.arm === 'baseline' &&
        entry.caseId === job.caseId &&
        entry.profile === job.profile,
    );
    assert.notEqual(job.sequence % 2, second.sequence % 2);
  }
});

test('direct callers cannot exceed the schedule budget before credential access', async () => {
  assert.equal(buildSchedule(fixture, 1).length, 32);
  assert.throws(() => buildSchedule(fixture, 3), /repetitions must be 1 or 2/u);
  const enlarged = structuredClone(fixture);
  enlarged.cases.push(...enlarged.cases);
  assert.throws(() => buildSchedule(enlarged, 2), /64-request budget/u);
  let credentialReads = 0;
  let requests = 0;
  await assert.rejects(
    runEvaluation(
      { keyFile: 'never-read', outDir: 'never-created', repetitions: 2 },
      {
        fixture: enlarged,
        readKey: () => {
          credentialReads++;
          return 'synthetic-secret';
        },
        fetch: async () => {
          requests++;
          return Response.json(responseFor(rewrite));
        },
      },
    ),
    /64-request budget/u,
  );
  assert.equal(credentialReads, 0);
  assert.equal(requests, 0);
});

test('parameter profiles preserve the exact prompt/schema and baseline reasoning omission', () => {
  const base = { arm: 'baseline', model: 'gpt-5.4-nano', profile: 'raw' };
  const candidate = { ...base, arm: 'candidate', model: 'gpt-6-luna' };
  const a = buildParameters(fixture, chemical, base);
  const b = buildParameters(fixture, chemical, candidate);
  assert.equal(a.reasoning, undefined);
  assert.equal(a.store, undefined);
  assert.equal(a.max_output_tokens, undefined);
  assert.deepEqual(b, { ...a, model: 'gpt-6-luna', reasoning: { effort: 'none' } });
  assert.equal(a.input[1].content, `Flow description: ${chemical.query}`);
  assert.deepEqual(a.text.format.schema, fixture.promptContract.schema);
  assert.equal(a.text.format.strict, true);
  for (const job of [base, candidate]) {
    const parameters = buildParameters(fixture, chemical, { ...job, profile: 'portal' });
    assert.equal(parameters.store, false);
    assert.equal(parameters.max_output_tokens, 256);
    assert.deepEqual(parameters.reasoning, { effort: 'none' });
    assert.equal(parameters.text.verbosity, 'low');
    assert.equal(parameters.text.format.name, 'portal_hybrid_search_v1_queries');
  }
});

test('key reader selects only OPENAI_API_KEY without changing process environment', () => {
  const previous = process.env.OPENAI_API_KEY;
  const key = readApiKey('unused', {
    lstat: () => ({ isFile: () => true }),
    read: () => 'UNRELATED_SECRET=never-selected\nOPENAI_API_KEY="synthetic-openai-key"\n',
  });
  assert.equal(key, 'synthetic-openai-key');
  assert.equal(process.env.OPENAI_API_KEY, previous);
  assert.throws(
    () =>
      readApiKey('unused', {
        lstat: () => ({ isFile: () => true }),
        read: () => {
          throw new Error('upstream secret');
        },
      }),
    { message: 'Unable to read a valid OPENAI_API_KEY from the supplied file' },
  );
});

test('raw scoring catches malformed, incomplete and invalid structural output', () => {
  const valid = scoreRaw(responseFor(rewrite), chemical);
  assert.deepEqual(valid.hardFailures, []);
  assert.ok(Object.values(valid.checks).every(Boolean));
  for (const invalid of [
    null,
    [],
    {},
    { ...rewrite, extra: true },
    { ...rewrite, semantic_query_en: '' },
  ]) {
    assert.ok(scoreRaw(responseFor(invalid), chemical).hardFailures.includes('invalid_structure'));
  }
  assert.ok(
    scoreRaw({ status: 'completed', output_text: '{broken' }, chemical).hardFailures.includes(
      'invalid_json',
    ),
  );
  assert.ok(
    scoreRaw(responseFor(rewrite, { status: 'incomplete' }), chemical).hardFailures.includes(
      'incomplete',
    ),
  );
});

test('predeclared identity, recycled and fossil errors remain hard failures', () => {
  const missing = {
    ...rewrite,
    fulltext_query_en: ['dichloromethane'],
    fulltext_query_zh: ['二氯甲烷'],
  };
  assert.ok(
    scoreRaw(responseFor(missing), chemical).hardFailures.includes('required_identifier_lost'),
  );
  const wrong = { ...rewrite, fulltext_query_en: [...rewrite.fulltext_query_en, '67-64-1'] };
  assert.ok(
    scoreRaw(responseFor(wrong), chemical).hardFailures.includes('unapproved_cas_identifier'),
  );
  const partial = { ...rewrite, fulltext_query_en: ['175-09-2'], fulltext_query_zh: ['二氯甲烷'] };
  assert.ok(
    scoreRaw(responseFor(partial), chemical).hardFailures.includes('required_identifier_lost'),
  );
  const aluminium = fixture.cases.find((item) => item.id === 'process-recycled-aluminium');
  const lost = {
    semantic_query_en: 'primary aluminium production',
    fulltext_query_en: ['aluminium'],
    fulltext_query_zh: ['铝'],
  };
  const scored = scoreRaw(responseFor(lost), aluminium);
  assert.ok(scored.hardFailures.includes('critical_meaning_lost'));
  assert.ok(scored.hardFailures.includes('forbidden_substitution'));
  const fossil = fixture.cases.find((item) => item.id === 'flow-fossil-carbon-dioxide');
  assert.ok(
    scoreRaw(
      responseFor({ ...lost, semantic_query_en: 'biogenic carbon dioxide' }),
      fossil,
    ).hardFailures.includes('critical_meaning_lost'),
  );
});

test('language and dictionary issues are visible before any normalization', () => {
  const score = scoreRaw(
    responseFor({
      semantic_query_en: '二氯甲烷',
      fulltext_query_en: ['environmental impact assessment', '二氯甲烷', '75-09-2'],
      fulltext_query_zh: ['dichloromethane'],
    }),
    chemical,
  );
  assert.equal(score.checks.englishSemantic, false);
  assert.equal(score.checks.englishAliases, false);
  assert.equal(score.checks.chineseAliases, false);
  assert.equal(score.checks.dictionaryAliases, false);
});

test('token details distinguish missing values from observed zero', () => {
  assert.deepEqual(tokenUsage({}), {
    input: null,
    output: null,
    total: null,
    cachedInput: null,
    reasoningOutput: null,
  });
  assert.deepEqual(tokenUsage(responseFor(rewrite)), {
    input: 100,
    output: 42,
    total: 142,
    cachedInput: 24,
    reasoningOutput: 0,
  });
});

test('redaction removes the selected key from nested strings and object keys', () => {
  for (const secret of ['synthetic-secret', 'synthetic-"secret\\suffix']) {
    const value = { [secret]: [`prefix ${secret} suffix`, { nested: secret }] };
    const safe = redact(value, secret);
    assert.deepEqual(safe, {
      '[REDACTED]': ['prefix [REDACTED] suffix', { nested: '[REDACTED]' }],
    });
  }
});

test('successful evidence omits error bodies and echoed request/metadata fields', () => {
  const safe = sanitizeResponse(
    {
      ...responseFor(rewrite),
      error: { message: 'private provider details' },
      input: [{ content: 'private request echo' }],
      metadata: { Authorization: 'unrelated-secret' },
    },
    'synthetic-secret',
  );
  assert.equal(safe.error, undefined);
  assert.equal(safe.input, undefined);
  assert.equal(safe.metadata, undefined);
  assert.deepEqual(safe.output, responseFor(rewrite).output);
});

test('fetch uses official endpoint, disables redirects and measures one complete response', async () => {
  let calls = 0;
  let tick = 0;
  const parameters = buildParameters(fixture, chemical, {
    arm: 'candidate',
    model: 'gpt-6-luna',
    profile: 'portal',
  });
  const result = await measureRequest(parameters, 'synthetic-secret', chemical, {
    now: () => tick++ * 12,
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, ENDPOINT);
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers.Authorization, 'Bearer synthetic-secret');
      return Response.json(responseFor(rewrite));
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.latencyMs, 12);
  assert.equal(result.outcome, 'observed');
  assert.equal(result.effectiveEffort, 'none');
  assert.equal(result.usage.reasoningOutput, 0);
});

test('provider/configuration errors never retain upstream bodies or retry', async () => {
  for (const [status, outcome] of [
    [400, 'configuration_failure'],
    [401, 'configuration_failure'],
    [404, 'configuration_failure'],
    [429, 'capacity_failure'],
    [500, 'provider_failure'],
  ]) {
    let calls = 0;
    const result = await measureRequest({}, 'synthetic-secret', chemical, {
      fetch: async () => {
        calls++;
        return new Response('synthetic-secret private prompt', { status });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.outcome, outcome);
    assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
    assert.equal(result.score, undefined);
  }
});

test('malformed JSON and transport failures receive distinct sanitized outcomes', async () => {
  assert.equal(
    (
      await measureRequest({}, 'synthetic-secret', chemical, {
        fetch: async () => new Response('not-json'),
      })
    ).outcome,
    'malformed_response',
  );
  for (const payload of [null, [], 'unexpected-string']) {
    assert.equal(
      (
        await measureRequest({}, 'synthetic-secret', chemical, {
          fetch: async () => Response.json(payload),
        })
      ).outcome,
      'malformed_response',
    );
  }
  const providerFailed = await measureRequest({}, 'synthetic-secret', chemical, {
    fetch: async () =>
      Response.json({ status: 'failed', error: { message: 'synthetic-secret upstream details' } }),
  });
  assert.equal(providerFailed.outcome, 'provider_failure');
  assert.equal(JSON.stringify(providerFailed).includes('synthetic-secret'), false);
  const failed = await measureRequest({}, 'synthetic-secret', chemical, {
    fetch: async () => {
      throw new Error('synthetic-secret upstream private error');
    },
  });
  assert.equal(failed.outcome, 'transport_failure');
  assert.equal(JSON.stringify(failed).includes('synthetic-secret'), false);
  assert.equal(
    (
      await measureRequest({}, 'synthetic-secret', chemical, {
        signal: AbortSignal.abort(),
        fetch: async () => {
          throw new Error();
        },
      })
    ).outcome,
    'timeout',
  );
});

test('oversized provider responses are cancelled without retaining their content', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await measureRequest({}, 'synthetic-secret', chemical, {
    fetch: async () => new Response(body),
  });
  assert.equal(result.outcome, 'malformed_response');
  assert.equal(cancelled, true);
  assert.equal(result.rawResponse, undefined);
});

test('abort during response-body read is a timeout after successful headers', async () => {
  const controller = new AbortController();
  const body = new ReadableStream({
    start(stream) {
      controller.signal.addEventListener('abort', () =>
        stream.error(new Error('synthetic-secret provider body aborted')),
      );
    },
  });
  const result = await measureRequest({}, 'synthetic-secret', chemical, {
    signal: controller.signal,
    fetch: async () => {
      setImmediate(() => controller.abort());
      return new Response(body, { status: 200 });
    },
  });
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.rawResponse, undefined);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});

test('paired aggregate compares matched cases and preserves unknown token coverage', () => {
  const score = scoreRaw(responseFor(rewrite), chemical);
  const records = [
    {
      pair: 'p1',
      profile: 'portal',
      arm: 'baseline',
      outcome: 'observed',
      latencyMs: 100,
      score,
      usage: tokenUsage({}),
    },
    {
      pair: 'p1',
      profile: 'portal',
      arm: 'candidate',
      outcome: 'observed',
      latencyMs: 60,
      score,
      usage: tokenUsage(responseFor(rewrite)),
    },
    {
      pair: 'p2',
      profile: 'portal',
      arm: 'baseline',
      outcome: 'configuration_failure',
      latencyMs: 3,
    },
  ];
  const summary = aggregate(records, 4);
  assert.equal(summary.completedSchedule, false);
  assert.equal(summary.pairs.length, 1);
  assert.equal(summary.pairedMedianDeltaMs.portal, -40);
  assert.equal(summary.acceptedPairedMedianDeltaMs.portal, -40);
  assert.deepEqual(
    summary.groups.find((group) => group.profile === 'portal' && group.arm === 'baseline').usage
      .total,
    { sum: null, known: 0 },
  );
});

test('invalid, incomplete and hard-failing outputs cannot contribute accepted speed wins', () => {
  const validScore = scoreRaw(responseFor(rewrite), chemical);
  const rejectedScores = [
    scoreRaw(responseFor({}), chemical),
    scoreRaw(responseFor(rewrite, { status: 'incomplete' }), chemical),
    scoreRaw(
      responseFor({ ...rewrite, fulltext_query_en: ['other'], fulltext_query_zh: ['其他'] }),
      chemical,
    ),
    scoreRaw(responseFor({ ...rewrite, fulltext_query_zh: ['methylene chloride'] }), chemical),
  ];
  const usage = tokenUsage(responseFor(rewrite));
  const records = rejectedScores.flatMap((score, index) => [
    {
      pair: `p${index}`,
      profile: 'portal',
      arm: 'baseline',
      outcome: 'observed',
      latencyMs: 100,
      score: validScore,
      usage,
    },
    {
      pair: `p${index}`,
      profile: 'portal',
      arm: 'candidate',
      outcome: 'observed',
      latencyMs: 1,
      score,
      usage,
    },
  ]);
  const before = JSON.stringify(records);
  const summary = aggregate(records, records.length);
  assert.equal(summary.pairs.length, 4);
  assert.equal(summary.pairedMedianDeltaMs.portal, -99);
  assert.equal(summary.acceptedPairs.length, 0);
  assert.equal(summary.acceptedPairedMedianDeltaMs.portal, null);
  const candidate = summary.groups.find(
    (group) => group.profile === 'portal' && group.arm === 'candidate',
  );
  assert.equal(candidate.acceptedOutputs, 0);
  assert.equal(candidate.acceptedMedianLatencyMs, null);
  assert.equal(JSON.stringify(records), before);
});

test('offline runner writes private unique evidence and stops after configuration failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewrite-eval-offline-'));
  try {
    let calls = 0;
    const options = { keyFile: 'not-read', outDir: root, repetitions: 2 };
    const dependencies = {
      fixture,
      readKey: () => 'synthetic-secret',
      fetch: async () => {
        calls++;
        return new Response('synthetic-secret upstream error', { status: 401 });
      },
    };
    const first = await runEvaluation(options, dependencies);
    const original = readFileSync(join(first.runDirectory, '001-baseline.json'), 'utf8');
    const second = await runEvaluation(options, dependencies);
    assert.notEqual(first.runDirectory, second.runDirectory);
    assert.equal(calls, 2);
    assert.equal(first.summary.attemptedRequests, 1);
    assert.equal(first.summary.plannedRequests, 64);
    assert.equal(readFileSync(join(first.runDirectory, '001-baseline.json'), 'utf8'), original);
    assert.equal(statSync(first.runDirectory).mode & 0o777, 0o700);
    for (const file of readdirSync(first.runDirectory)) {
      assert.equal(statSync(join(first.runDirectory, file)).mode & 0o777, 0o600);
      assert.equal(
        readFileSync(join(first.runDirectory, file), 'utf8').includes('synthetic-secret'),
        false,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uniform offline rescoring binds every source record and never reads credentials or fetches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rewrite-eval-rescore-'));
  try {
    const schedule = buildSchedule(fixture, 1);
    writeFileSync(join(root, 'manifest.json'), JSON.stringify({ fixture, schedule }));
    const before = new Map();
    for (const job of schedule) {
      const file = `${String(job.sequence).padStart(3, '0')}-${job.arm}.json`;
      const wrong = {
        semantic_query_en: 'quizalofop-P-tefuryl',
        fulltext_query_en: ['quizalofop-P-tefuryl', '111479-05-1'],
        fulltext_query_zh: ['111479-05-1'],
      };
      const rawResponse = responseFor(job.caseId === 'flow-long-chemical' ? wrong : rewrite);
      const record = {
        ...job,
        outcome: 'observed',
        latencyMs: 5,
        usage: tokenUsage(rawResponse),
        rawResponse,
        score: scoreRaw(
          rawResponse,
          fixture.cases.find((entry) => entry.id === job.caseId),
        ),
      };
      const text = JSON.stringify(record);
      writeFileSync(join(root, file), text);
      before.set(file, text);
    }
    const result = await runEvaluation(
      { rescoreDir: root, outDir: join(root, 'rescored'), phase: 'tuned' },
      {
        fixture: tunedFixture,
        readKey: () => {
          throw new Error('must not read a key');
        },
        fetch: () => {
          throw new Error('must not fetch');
        },
      },
    );
    assert.equal(result.summary.attemptedRequests, 32);
    assert.equal(result.summary.apiRequests, 0);
    assert.equal(result.summary.criteriaRevision, 'hybrid-rewrite-criteria.v3');
    for (const [file, text] of before) {
      assert.equal(readFileSync(join(root, file), 'utf8'), text);
      const rescored = JSON.parse(readFileSync(join(result.runDirectory, file), 'utf8'));
      assert.equal(rescored.sourceRecordSha256.length, 64);
      assert.deepEqual(rescored.previousScore, JSON.parse(text).score);
      if (rescored.caseId === 'flow-long-chemical')
        assert.ok(rescored.score.hardFailures.includes('forbidden_substitution'));
    }
    await assert.rejects(
      runEvaluation(
        { keyFile: 'never-read', rescoreDir: root, outDir: root },
        { fixture: tunedFixture },
      ),
      /must not receive a key/u,
    );
    const parsed = parseArguments(['--rescore-dir', root, '--out-dir', root, '--phase', 'tuned']);
    assert.equal(parsed.keyFile, undefined);
    assert.equal(parsed.phase, 'tuned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
