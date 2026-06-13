import { assertEquals } from 'jsr:@std/assert';

import {
  buildHybridFulltextQueryTerms,
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

Deno.test('buildHybridFulltextQueryTerms preserves simple Chinese and English aliases', () => {
  const sanitized = sanitizeHybridQueryOutput(
    {
      semantic_query_en: 'alternating current',
      fulltext_query_en: ['AC power'],
      fulltext_query_zh: ['交流电'],
    },
    'electricity',
  );

  assertEquals(buildHybridFulltextQueryTerms(sanitized), [
    '交流电',
    'alternating current',
    'electricity',
    'AC power',
  ]);
});

Deno.test('buildHybridFulltextQueryTerms splits only top-level OR in chemical queries', () => {
  const rawChemicalQuery =
    '(111479-05-1) OR (Propanoic acid, 2-[4-[(6-chloro-2-quinoxalinyl)oxy]phenoxy]-, 2-[[(1-methylethylidene)amino]oxy]ethyl ester, (2R)-)';
  const rawChemicalName =
    'Propanoic acid, 2-[4-[(6-chloro-2-quinoxalinyl)oxy]phenoxy]-, 2-[[(1-methylethylidene)amino]oxy]ethyl ester, (2R)-';

  const sanitized = sanitizeHybridQueryOutput(
    {
      semantic_query_en: 'quizalofop-P-tefuryl',
      fulltext_query_en: ['111479-05-1', 'quizalofop-P-tefuryl'],
      fulltext_query_zh: [],
    },
    rawChemicalQuery,
  );

  assertEquals(buildHybridFulltextQueryTerms(sanitized), [
    '111479-05-1',
    rawChemicalName,
    'quizalofop-P-tefuryl',
  ]);
});

Deno.test('buildHybridFulltextQueryTerms splits ordinary top-level OR expressions', () => {
  assertEquals(
    buildHybridFulltextQueryTerms({
      semantic_query_en: '',
      fulltext_query_en: ['sodium chloride OR NaCl'],
      fulltext_query_zh: [],
    }),
    ['sodium chloride', 'NaCl'],
  );
});

Deno.test('buildHybridFulltextQueryTerms does not split words containing or', () => {
  assertEquals(
    buildHybridFulltextQueryTerms({
      semantic_query_en: '',
      fulltext_query_en: ['chlorinated organic solvent'],
      fulltext_query_zh: [],
    }),
    ['chlorinated organic solvent'],
  );
});

Deno.test('buildHybridFulltextQueryTerms preserves quotes and backslashes as raw terms', () => {
  assertEquals(
    buildHybridFulltextQueryTerms({
      semantic_query_en: 'quoted solvent',
      fulltext_query_en: ['a "quoted" \\ solvent'],
      fulltext_query_zh: [],
    }),
    ['a "quoted" \\ solvent'],
  );
});
