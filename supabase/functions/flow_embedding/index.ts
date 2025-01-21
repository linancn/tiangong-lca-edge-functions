// Setup type definitions for built-in Supabase Runtime APIs
import '@supabase/functions-js/edge-runtime.d.ts';

import { createClient } from '@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

interface Name {
  baseName?: string;
  treatmentStandardsRoutes?: string;
  mixAndLocationTypes?: string;
  flowProperties?: string;
  other?: string;
}

interface Category {
  '@level': string;
  '#text': string;
}

interface FilteredContent {
  classificationInformation: {
    'common:elementaryFlowCategorization'?: {
      'common:category': Category[];
    };
  };
  name?: Name;
  synonyms?: string;
  generalComment?: string;
  CASNumber?: string;
  other?: Record<string, unknown>;
}

function filterEnContent(jsonContent: any, key: string): string | null {
  const value = jsonContent[key];
  if (!value) return null;

  if (Array.isArray(value)) {
    const enItem = value.find((item) => item['@xml:lang'] === 'en');
    return enItem ? enItem['#text'] : null;
  }

  return value['#text'] || null;
}

function processJsonRecordEn(jsonContent: any): FilteredContent | null {
  try {
    const filtered: FilteredContent = {
      classificationInformation:
        jsonContent.flowDataSet.flowInformation.dataSetInformation.classificationInformation,
    };

    const name = jsonContent.flowDataSet.flowInformation.dataSetInformation.name;
    const nameKeys = [
      'baseName',
      'treatmentStandardsRoutes',
      'mixAndLocationTypes',
      'flowProperties',
      'other',
    ];

    nameKeys.forEach((key) => {
      const value = filterEnContent(name, key);
      if (value) {
        if (!filtered.name) filtered.name = {};
        filtered.name[key as keyof Name] = value;
      }
    });

    const dataSetInformation = jsonContent.flowDataSet.flowInformation.dataSetInformation;

    const synonyms = filterEnContent(dataSetInformation, 'common:synonyms');
    if (synonyms) filtered.synonyms = synonyms;

    const generalComment = filterEnContent(dataSetInformation, 'common:generalComment');
    if (generalComment) filtered.generalComment = generalComment;

    const casNumber = dataSetInformation.CASNumber;
    if (casNumber) filtered.CASNumber = casNumber;

    const other = dataSetInformation['common:other'];
    if (other) filtered.other = other;

    return filtered;
  } catch (error) {
    console.error('Error processing JSON record:', error);
    return null;
  }
}

function dictToConciseString(data: FilteredContent): string {
  const parts: string[] = [];

  if (data.name?.baseName) {
    parts.push(`Name: ${data.name.baseName}.`);
  }

  if (data.CASNumber) {
    parts.push(`CAS Number: ${data.CASNumber}.`);
  }
  try {
    const categories =
      data.classificationInformation?.['common:elementaryFlowCategorization']?.['common:category'];
    if (categories) {
      const sortedCategories = [...categories].sort(
        (a, b) => parseInt(a['@level']) - parseInt(b['@level']),
      );
      const classificationPath = sortedCategories.map((c) => c['#text']).join(' > ');
      parts.push(`Classification: ${classificationPath}.`);
    }
  } catch (_error) {
    // Ignore classification parsing errors as they are not critical
  }

  if (data.synonyms) {
    parts.push(`Synonyms: ${data.synonyms}.`);
  }

  if (data.generalComment) {
    parts.push(`Comment: ${data.generalComment}`);
  }

  if (data.other) {
    const otherFormatted = Object.entries(data.other)
      .map(([k, v]) => `${k}: ${v}`)
      .join('; ');
    parts.push(`Other Information: ${otherFormatted}.`);
  }

  return parts.join('\n');
}

function flattenJson(jsonContent: any): string {
  const result: string[] = [];

  function traverse(value: any) {
    if (Array.isArray(value)) {
      value.forEach((item) => traverse(item));
    } else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach((val) => traverse(val));
    } else if (typeof value === 'string') {
      result.push(value.trim());
    }
  }

  traverse(jsonContent);
  return result.join('; ');
}

function processJsonRecordAllLanguages(jsonContent: any): string | null {
  try {
    const filtered: FilteredContent = {
      classificationInformation: {} as any,
    };

    const classificationInformation =
      jsonContent.flowDataSet.flowInformation.dataSetInformation.classificationInformation;
    if (classificationInformation) {
      const categories =
        classificationInformation['common:elementaryFlowCategorization']?.['common:category'];
      if (Array.isArray(categories) && categories.length > 0) {
        (filtered.classificationInformation as any).categories = categories.map((category: any) =>
          category['#text'].trim(),
        );
      }
    }

    const name = jsonContent.flowDataSet.flowInformation.dataSetInformation.name;
    const nameKeys = [
      'baseName',
      'treatmentStandardsRoutes',
      'mixAndLocationTypes',
      'flowProperties',
      'other',
    ];

    if (name) {
      nameKeys.forEach((key) => {
        const value = name[key];
        if (value) {
          if (!filtered.name) filtered.name = {};
          filtered.name[key as keyof Name] = Array.isArray(value)
            ? value.map((item: any) => item['#text'].trim()).join('; ')
            : value['#text'].trim();
        }
      });
    }

    const dataSetInformation = jsonContent.flowDataSet.flowInformation.dataSetInformation;

    const synonyms = dataSetInformation['common:synonyms'];
    if (synonyms) {
      filtered.synonyms = Array.isArray(synonyms)
        ? synonyms.map((item: any) => item['#text'].trim()).join('; ')
        : synonyms['#text'].trim();
    }

    const generalComment = dataSetInformation['common:generalComment'];
    if (generalComment) {
      filtered.generalComment = Array.isArray(generalComment)
        ? generalComment.map((item: any) => item['#text'].trim()).join('; ')
        : generalComment['#text'].trim();
    }

    const casNumber = dataSetInformation.CASNumber;
    if (casNumber) filtered.CASNumber = casNumber;

    const other = dataSetInformation['common:other'];
    if (other) filtered.other = other;

    Object.keys(filtered).forEach((key) => {
      const filteredKey = key as keyof FilteredContent; // Assert the key is a valid key of FilteredContent
      if (
        filtered[filteredKey] === undefined ||
        filtered[filteredKey] === null ||
        (typeof filtered[filteredKey] === 'object' &&
          Object.keys(filtered[filteredKey]).length === 0)
      ) {
        delete filtered[filteredKey];
      }
    });

    return flattenJson(filtered);
  } catch (error) {
    console.error('Error processing JSON record:', error);
    return null;
  }
}

const session = new Supabase.ai.Session('gte-small');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  const xKey = req.headers.get('x_key');

  if (!authHeader && !xKey) {
    return new Response('Unauthorized Request', { status: 401 });
  }

  let user;
  if (xKey == Deno.env.get('X_KEY')) {
    user = { role: 'authenticated' };
  } else {
    const token = authHeader?.replace('Bearer ', '') ?? '';

    const supabaseClient = createClient(
      Deno.env.get('REMOTE_SUPABASE_URL') ?? Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('REMOTE_SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    );

    const { data } = await supabaseClient.auth.getUser(token);
    if (!data || !data.user) {
      return new Response('User Not Found', { status: 404 });
    }
    user = data.user;
  }

  if (user?.role !== 'authenticated') {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    let requestData = await req.json();
    if (typeof requestData === 'string') {
      requestData = JSON.parse(requestData);
    }

    // Process JSON data for both English and all language content
    // const filteredContentEn = processJsonRecordEn(requestData);
    // if (!filteredContentEn) {
    //   throw new Error('Failed to process JSON data');
    // }

    // const filteredContentAll = processJsonRecordAllLanguages(requestData);
    // if (!filteredContentAll) {
    //   throw new Error('Failed to process JSON data');
    // }

    // Generate the extracted text and embedding concurrently
    const [filteredContentEn, extractedText] = await Promise.all([
      processJsonRecordEn(requestData),
      processJsonRecordAllLanguages(requestData),
    ]);

    if (!filteredContentEn) {
      throw new Error('Failed to process JSON data');
    }
    const stringDataEn = dictToConciseString(filteredContentEn);

    // Run embedding calculation
    const embedding = await session.run(stringDataEn, {
      mean_pool: true,
      normalize: true,
    });

    // Ensure both 'embedding' and 'extracted_text' are part of the response
    return new Response(
      JSON.stringify({
        embedding: embedding, // Include the embedding
        extracted_text: extractedText, // Include the extracted text
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      },
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error(errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
