import { assertStringIncludes } from 'jsr:@std/assert';

async function readSource(relativePath: string): Promise<string> {
  return Deno.readTextFile(new URL(relativePath, import.meta.url));
}

Deno.test('normal Flow extracted_md queue path shares projection primitives', async () => {
  const worker = await readSource('../supabase/functions/_shared/dataset_extraction_worker.ts');
  const flowExtraction = await readSource('../supabase/functions/_shared/flow_extraction.ts');

  assertStringIncludes(worker, "from './flow_extraction.ts'");
  assertStringIncludes(worker, 'generator: generateFlowMarkdown');
  assertStringIncludes(flowExtraction, "from './projection_primitives.ts'");
  assertStringIncludes(flowExtraction, 'sharedReadLocalizedText');
  assertStringIncludes(flowExtraction, 'sharedReadClassificationPath');
  assertStringIncludes(flowExtraction, 'sharedReadReferenceShortDescription');
});
