#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const CAPABILITY_PATH = 'supabase/functions/_shared/capabilities/lca_result_family.ts';
const LEGACY_WRAPPER_PATH = 'supabase/functions/_shared/db_rpc/lca_results.ts';
const OWNER_PATHS = new Set([
  CAPABILITY_PATH,
  'supabase/functions/_shared/lca_all_unit_solve_queue.ts',
  'supabase/functions/lca_solve/index.ts',
  'supabase/functions/lca_contribution_path/index.ts',
  'supabase/functions/lca_query_results/index.ts',
  'supabase/functions/lca_jobs/index.ts',
  'supabase/functions/lca_results/index.ts',
  'supabase/functions/lca_contribution_path_result/index.ts',
]);

const TARGET_RELATIONS = new Set([
  'lca_results',
  'lca_result_cache',
  'lca_latest_all_unit_results',
  'lca_factorization_registry',
]);
const LEGACY_ROUTINES = new Set([
  'lca_read_job_projection',
  'lca_read_result_projection',
  'lca_read_latest_single_solve_result',
]);
const STABLE_ROUTINES = new Set([
  'lca_read_job_projection_v1',
  'lca_read_result_projection_v1',
  'lca_read_latest_single_solve_result_v1',
  'lca_read_result_cache_v1',
  'cmd_lca_touch_result_cache_v1',
  'cmd_lca_admit_result_cache_v1',
  'cmd_lca_reconcile_result_cache_v1',
  'lca_read_latest_all_unit_result_v1',
]);

// Existing generic repositories have independently constrained identifiers. Any new dynamic
// Data API identifier must be reviewed here instead of silently becoming an escape hatch.
const DYNAMIC_FROM_ALLOWLIST = new Map([
  ['supabase/functions/_shared/update_data.ts', new Set(['table'])],
  ['supabase/functions/_shared/get_data_status.ts', new Set(['table'])],
  ['supabase/functions/_shared/get_data.ts', new Set(['table'])],
  ['supabase/functions/_shared/dataset_extraction_worker.ts', new Set(['table'])],
  ['supabase/functions/_shared/commands/dataset/review_submit_gate.ts', new Set(['request.table'])],
  ['supabase/functions/_shared/commands/dataset/verify_remote.ts', new Set(['reference.table'])],
  ['supabase/functions/_shared/tidas_package.ts', new Set(['table'])],
]);
const DYNAMIC_RPC_ALLOWLIST = new Map([
  ['supabase/functions/_shared/db_rpc/membership_commands.ts', new Set(['fn'])],
  ['supabase/functions/_shared/db_rpc/review_commands.ts', new Set(['fn'])],
  ['supabase/functions/_shared/db_rpc/lca_release_commands.ts', new Set(['fn'])],
  ['supabase/functions/_shared/db_rpc/data_product_commands.ts', new Set(['fn'])],
  ['supabase/functions/_shared/db_rpc/notification_commands.ts', new Set(['fn'])],
  ['supabase/functions/_shared/db_rpc/dataset_commands.ts', new Set(['fn'])],
  ['supabase/functions/_shared/capabilities/worker_jobs.ts', new Set(['fn'])],
  ['supabase/functions/_shared/hybrid_search_handler.ts', new Set(['config.rpcName'])],
  [
    'supabase/functions/_shared/capabilities/lca_snapshot_family.ts',
    new Set([
      'routines.activeRead',
      'routines.scopeRead',
      'routines.resolve',
      'routines.artifactRead',
      'routines.artifactLatest',
      'routines.create',
    ]),
  ],
]);
const CAPABILITY_DYNAMIC_RPC_ALLOWLIST = new Set([
  'routine',
  'routines.admitCache',
  'routines.reconcileCache',
]);

function normalizePath(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function collectTypeScriptFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...collectTypeScriptFiles(child));
    else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) files.push(child);
  }
  return files.sort();
}

function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

function buildBindings(sourceFile) {
  const bindings = new Map();
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      node.parent &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      const existing = bindings.get(node.name.text);
      // Shadowing is intentionally treated as unresolved rather than guessed.
      bindings.set(node.name.text, existing ? null : node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return bindings;
}

function buildMethodAliases(sourceFile, bindings) {
  const aliases = new Map();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isObjectBindingPattern(node.name)) {
        const storage = chainContainsMember(node.initializer, 'storage', bindings);
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const importedName = propertyName(element.propertyName ?? element.name, bindings);
          if (['from', 'rpc', 'schema', 'query', 'unsafe'].includes(importedName)) {
            aliases.set(element.name.text, { method: importedName, storage });
          }
        }
      } else if (ts.isIdentifier(node.name)) {
        let initializer = unwrap(node.initializer);
        if (
          ts.isCallExpression(initializer) &&
          memberName(initializer.expression, bindings) === 'bind'
        ) {
          initializer = unwrap(memberReceiver(initializer.expression));
        }
        const method = memberName(initializer, bindings);
        if (['from', 'rpc', 'schema', 'query', 'unsafe'].includes(method)) {
          aliases.set(node.name.text, {
            method,
            storage: chainContainsMember(memberReceiver(initializer), 'storage', bindings),
          });
        } else if (
          ts.isCallExpression(initializer) &&
          ts.isPropertyAccessExpression(unwrap(initializer.expression)) &&
          unwrap(initializer.expression).expression.getText(sourceFile) === 'Reflect' &&
          unwrap(initializer.expression).name.text === 'get'
        ) {
          const reflected = evaluatePrimitive(initializer.arguments[1], bindings);
          if (['from', 'rpc', 'schema', 'query', 'unsafe'].includes(reflected)) {
            aliases.set(node.name.text, { method: reflected, storage: false });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return aliases;
}

function propertyName(node, bindings, seen) {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return evaluatePrimitive(node, bindings, seen);
}

function objectProperty(objectNode, name, bindings, seen) {
  let object = unwrap(objectNode);
  if (ts.isCallExpression(object)) {
    const callee = unwrap(object.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.expression.getText() === 'Object' &&
      callee.name.text === 'freeze' &&
      object.arguments.length === 1
    ) {
      object = unwrap(object.arguments[0]);
    }
  }
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const candidate = propertyName(property.name, bindings, seen);
    if (candidate !== name) continue;
    return ts.isShorthandPropertyAssignment(property)
      ? bindings.get(property.name.text)
      : property.initializer;
  }
  return undefined;
}

function evaluatePrimitive(node, bindings, seen = new Set()) {
  const current = unwrap(node);
  if (!current) return undefined;
  if (ts.isStringLiteralLike(current) || ts.isNumericLiteral(current)) return current.text;
  if (current.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (current.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (current.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return undefined;
    const initializer = bindings.get(current.text);
    if (!initializer) return undefined;
    const next = new Set(seen);
    next.add(current.text);
    return evaluatePrimitive(initializer, bindings, next);
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluatePrimitive(current.left, bindings, seen);
    const right = evaluatePrimitive(current.right, bindings, seen);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  if (ts.isTemplateExpression(current)) {
    let result = current.head.text;
    for (const span of current.templateSpans) {
      const value = evaluatePrimitive(span.expression, bindings, seen);
      if (value === undefined) return undefined;
      result += `${value}${span.literal.text}`;
    }
    return result;
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const object = current.expression;
    const name = ts.isPropertyAccessExpression(current)
      ? current.name.text
      : propertyName(current.argumentExpression, bindings, seen);
    if (name === undefined) return undefined;
    let resolvedObject = unwrap(object);
    if (ts.isIdentifier(resolvedObject)) {
      const initializer = bindings.get(resolvedObject.text);
      if (!initializer) return undefined;
      resolvedObject = initializer;
    }
    const initializer = objectProperty(resolvedObject, `${name}`, bindings, seen);
    return initializer ? evaluatePrimitive(initializer, bindings, seen) : undefined;
  }
  return undefined;
}

function memberName(expression, bindings) {
  const current = unwrap(expression);
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  if (ts.isElementAccessExpression(current)) {
    const value = evaluatePrimitive(current.argumentExpression, bindings);
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

function memberReceiver(expression) {
  const current = unwrap(expression);
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return current.expression;
  }
  return undefined;
}

function chainContainsMember(expression, wanted, bindings) {
  let current = unwrap(expression);
  while (current) {
    if (memberName(current, bindings) === wanted) return true;
    if (ts.isCallExpression(current)) current = unwrap(current.expression);
    else if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = unwrap(current.expression);
    } else break;
  }
  return false;
}

function normalizedIdentifier(value) {
  if (typeof value !== 'string') return undefined;
  const parts = value.toLowerCase().split('.');
  return parts[parts.length - 1].replace(/^['"`]|['"`]$/g, '');
}

function isAllowlisted(allowlist, filePath, expressionText) {
  return allowlist.get(filePath)?.has(expressionText.replace(/\s+/g, '')) ?? false;
}

function lineAndColumn(sourceFile, node) {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${location.line + 1}:${location.character + 1}`;
}

function analyzeSource(source, filePath) {
  const normalizedFile = normalizePath(filePath);
  const sourceFile = ts.createSourceFile(
    normalizedFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    normalizedFile.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = buildBindings(sourceFile);
  const methodAliases = buildMethodAliases(sourceFile, bindings);
  const findings = [];
  const add = (node, kind, message) =>
    findings.push({
      file: normalizedFile,
      location: lineAndColumn(sourceFile, node),
      kind,
      message,
    });

  function inspectCall(node) {
    const calledExpression = unwrap(node.expression);
    const alias = ts.isIdentifier(calledExpression)
      ? methodAliases.get(calledExpression.text)
      : undefined;
    const name = alias?.method ?? memberName(node.expression, bindings);
    if (!name || !['from', 'rpc', 'schema', 'query', 'unsafe'].includes(name)) return;
    const receiver = memberReceiver(node.expression);
    if (name === 'from' && alias?.storage) return;
    if (name === 'from' && receiver) {
      if (chainContainsMember(receiver, 'storage', bindings)) return;
      const receiverText = unwrap(receiver).getText(sourceFile);
      if (receiverText === 'Array') return;
    }

    const argument = node.arguments[0];
    const value = argument ? evaluatePrimitive(argument, bindings) : undefined;
    const expressionText = argument ? argument.getText(sourceFile).replace(/\s+/g, '') : '';

    if (name === 'from') {
      const relation = normalizedIdentifier(value);
      if (relation && TARGET_RELATIONS.has(relation)) {
        add(node, 'target-relation', `direct relation consumer ${String(value)}`);
      } else if (
        value === undefined &&
        !isAllowlisted(DYNAMIC_FROM_ALLOWLIST, normalizedFile, expressionText)
      ) {
        add(node, 'dynamic-relation', `unreviewed dynamic relation identifier ${expressionText}`);
      }
      return;
    }

    if (name === 'rpc') {
      const routine = normalizedIdentifier(value);
      if (routine && LEGACY_ROUTINES.has(routine)) {
        add(node, 'legacy-rpc', `legacy result-family RPC ${String(value)}`);
      } else if (routine && STABLE_ROUTINES.has(routine) && normalizedFile !== CAPABILITY_PATH) {
        add(node, 'escaped-stable-rpc', `stable result-family RPC escaped capability ${routine}`);
      } else if (
        value === undefined &&
        ((normalizedFile === CAPABILITY_PATH &&
          !CAPABILITY_DYNAMIC_RPC_ALLOWLIST.has(expressionText)) ||
          (normalizedFile !== CAPABILITY_PATH &&
            !isAllowlisted(DYNAMIC_RPC_ALLOWLIST, normalizedFile, expressionText)))
      ) {
        add(node, 'dynamic-rpc', `unreviewed dynamic RPC identifier ${expressionText}`);
      }
      if (OWNER_PATHS.has(normalizedFile) && normalizedFile !== CAPABILITY_PATH) {
        add(
          node,
          'owner-direct-rpc',
          'result-family owner must use the typed capability repository',
        );
      }
      return;
    }

    if (name === 'schema' && OWNER_PATHS.has(normalizedFile)) {
      if (value !== 'api') {
        add(
          node,
          value === undefined ? 'dynamic-schema' : 'schema-fallback',
          `result-family schema must be the fixed api profile, received ${expressionText}`,
        );
      }
      return;
    }

    if (name === 'query' || name === 'unsafe') {
      if (value === undefined && OWNER_PATHS.has(normalizedFile)) {
        add(node, 'dynamic-raw-sql', `dynamic raw SQL in result-family owner ${expressionText}`);
      } else if (value !== undefined) {
        inspectRawText(node, `${value}`);
      }
    }
  }

  function inspectRawText(node, text) {
    const lowered = text.toLowerCase();
    for (const relation of TARGET_RELATIONS) {
      if (
        new RegExp(`(?:^|[^a-z0-9_])(?:public\\.|private\\.)?${relation}(?:$|[^a-z0-9_])`).test(
          lowered,
        )
      ) {
        add(node, 'raw-sql-relation', `raw SQL references ${relation}`);
      }
    }
    for (const routine of LEGACY_ROUTINES) {
      if (new RegExp(`(?:^|[^a-z0-9_])${routine}(?:$|[^a-z0-9_])`).test(lowered)) {
        add(node, 'raw-sql-legacy-rpc', `raw SQL references legacy routine ${routine}`);
      }
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const imported = node.moduleSpecifier.text.replace(/\\/g, '/');
      if (
        imported.endsWith('/_shared/db_rpc/lca_results.ts') ||
        imported.endsWith('/db_rpc/lca_results.ts')
      ) {
        add(node, 'legacy-import', `legacy result wrapper import ${imported}`);
      }
    }
    if (ts.isCallExpression(node)) {
      inspectCall(node);
      const calledExpression = unwrap(node.expression);
      const effectiveName = ts.isIdentifier(calledExpression)
        ? methodAliases.get(calledExpression.text)?.method
        : memberName(node.expression, bindings);
      const genericCallName = ts.isIdentifier(calledExpression)
        ? calledExpression.text
        : (memberName(node.expression, bindings) ?? '');
      if (effectiveName !== 'rpc') {
        for (const argument of node.arguments) {
          const value = evaluatePrimitive(argument, bindings);
          const identifier = normalizedIdentifier(value);
          if (identifier && LEGACY_ROUTINES.has(identifier)) {
            add(node, 'legacy-rpc', `legacy result-family RPC passed through helper ${identifier}`);
          } else if (
            identifier &&
            STABLE_ROUTINES.has(identifier) &&
            normalizedFile !== CAPABILITY_PATH
          ) {
            add(
              node,
              'escaped-stable-rpc',
              `stable result-family RPC passed outside capability ${identifier}`,
            );
          }
          if (
            typeof value === 'string' &&
            /\b(select|insert|update|delete|from|join|call)\b/i.test(value) &&
            /(sql|query|execute|exec|unsafe)/i.test(genericCallName) &&
            effectiveName !== 'query' &&
            effectiveName !== 'unsafe'
          ) {
            inspectRawText(node, value);
          }
        }
      }
    }
    if (ts.isTaggedTemplateExpression(node)) {
      const value = evaluatePrimitive(node.template, bindings);
      if (value === undefined && OWNER_PATHS.has(normalizedFile)) {
        add(node, 'dynamic-raw-sql', 'dynamic tagged SQL in result-family owner');
      } else if (value !== undefined) inspectRawText(node, `${value}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

function analyzeRepository(root = process.cwd()) {
  const findings = [];
  const runtimeRoot = path.join(root, 'supabase/functions');
  const files = collectTypeScriptFiles(runtimeRoot);
  for (const absolutePath of files) {
    const relativePath = normalizePath(path.relative(root, absolutePath));
    findings.push(...analyzeSource(fs.readFileSync(absolutePath, 'utf8'), relativePath));
  }

  const capability = path.join(root, CAPABILITY_PATH);
  if (!fs.existsSync(capability)) {
    findings.push({
      file: CAPABILITY_PATH,
      location: '1:1',
      kind: 'missing-capability',
      message: 'typed LCA result-family capability is missing',
    });
  } else {
    const source = fs.readFileSync(capability, 'utf8');
    for (const routine of STABLE_ROUTINES) {
      const matches = source.match(new RegExp(`['"\`]${routine}['"\`]`, 'g')) ?? [];
      if (matches.length !== 1) {
        findings.push({
          file: CAPABILITY_PATH,
          location: '1:1',
          kind: 'routine-contract',
          message: `${routine} must occur exactly once in the capability contract; found ${matches.length}`,
        });
      }
    }
  }
  if (fs.existsSync(path.join(root, LEGACY_WRAPPER_PATH))) {
    findings.push({
      file: LEGACY_WRAPPER_PATH,
      location: '1:1',
      kind: 'legacy-wrapper',
      message: 'legacy LCA projection wrapper must be removed after consumer cutover',
    });
  }
  return findings;
}

function main() {
  const rootArgument = process.argv.find((argument) => argument.startsWith('--root='));
  const root = rootArgument ? path.resolve(rootArgument.slice('--root='.length)) : process.cwd();
  const findings = analyzeRepository(root);
  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(
        `${finding.file}:${finding.location} [${finding.kind}] ${finding.message}\n`,
      );
    }
    process.stderr.write(
      `LCA result-family consumer-zero failed: ${findings.length} finding(s).\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `LCA result-family consumer-zero passed: 4 relations and 3 legacy RPCs are zero; 8 api v1 routines are capability-confined.\n`,
  );
}

if (require.main === module) main();

module.exports = {
  CAPABILITY_PATH,
  LEGACY_ROUTINES,
  OWNER_PATHS,
  STABLE_ROUTINES,
  TARGET_RELATIONS,
  analyzeRepository,
  analyzeSource,
  evaluatePrimitive,
};
