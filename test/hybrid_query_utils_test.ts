import { assertEquals } from 'jsr:@std/assert';

import {
  buildHybridFulltextQueryString,
  sanitizeHybridQueryOutput,
} from '../supabase/functions/_shared/hybrid_query_utils.ts';

Deno.test('sanitizeHybridQueryOutput preserves raw English query as fulltext fallback', () => {
  const sanitized = sanitizeHybridQueryOutput(
    {
      semantic_query_en: 'alternating current',
      fulltext_query_en: ['AC power', 'alternating current'],
      fulltext_query_zh: ['交流电'],
    },
    'electricity',
  );

  assertEquals(sanitized.semantic_query_en, 'alternating current');
  assertEquals(sanitized.fulltext_query_en.includes('electricity'), true);
  assertEquals(sanitized.fulltext_query_en[0], 'alternating current');
  assertEquals(sanitized.fulltext_query_en[1], 'electricity');
});

Deno.test('sanitizeHybridQueryOutput preserves raw Chinese query as fulltext fallback', () => {
  const sanitized = sanitizeHybridQueryOutput(
    {
      semantic_query_en: 'alternating current',
      fulltext_query_en: ['electricity'],
      fulltext_query_zh: ['电力'],
    },
    '交流电',
  );

  assertEquals(sanitized.fulltext_query_zh[0], '交流电');
  assertEquals(sanitized.fulltext_query_zh.includes('电力'), true);
});

Deno.test('sanitizeHybridQueryOutput keeps raw query within capped fulltext aliases', () => {
  const sanitized = sanitizeHybridQueryOutput(
    {
      semantic_query_en: 'alternating current',
      fulltext_query_en: [
        'AC power',
        'electric power',
        'grid power',
        'mains electricity',
        'power supply',
        'utility electricity',
        'voltage supply',
      ],
      fulltext_query_zh: [],
    },
    'electricity',
  );

  assertEquals(sanitized.fulltext_query_en.length, 6);
  assertEquals(sanitized.fulltext_query_en.includes('electricity'), true);
});

Deno.test('buildHybridFulltextQueryString preserves raw-query aliases in RPC query text', () => {
  const sanitized = sanitizeHybridQueryOutput(
    {
      semantic_query_en: 'alternating current',
      fulltext_query_en: ['AC power'],
      fulltext_query_zh: ['交流电'],
    },
    'electricity',
  );

  assertEquals(
    buildHybridFulltextQueryString(sanitized),
    '("交流电") OR ("alternating current") OR ("electricity") OR ("AC power")',
  );
});

Deno.test('buildHybridFulltextQueryString quotes PGroonga query-syntax characters', () => {
  const rawChemicalQuery =
    '(111479-05-1) OR (Propanoic acid, 2-[4-[(6-chloro-2-quinoxalinyl)oxy]phenoxy]-, 2-[[(1-methylethylidene)amino]oxy]ethyl ester, (2R)-)';

  const sanitized = sanitizeHybridQueryOutput(
    {
      semantic_query_en: 'quizalofop-P-tefuryl',
      fulltext_query_en: ['111479-05-1', 'quizalofop-P-tefuryl'],
      fulltext_query_zh: [],
    },
    rawChemicalQuery,
  );

  assertEquals(
    buildHybridFulltextQueryString(sanitized),
    `("${rawChemicalQuery}") OR ("quizalofop-P-tefuryl") OR ("${rawChemicalQuery}") OR ("111479-05-1")`,
  );
});

Deno.test('buildHybridFulltextQueryString escapes quotes and backslashes inside terms', () => {
  assertEquals(
    buildHybridFulltextQueryString({
      semantic_query_en: 'quoted solvent',
      fulltext_query_en: ['a "quoted" \\ solvent'],
      fulltext_query_zh: [],
    }),
    '("a \\"quoted\\" \\\\ solvent")',
  );
});
