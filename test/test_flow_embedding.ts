import { load } from 'https://deno.land/std@0.208.0/dotenv/mod.ts';

// 加载环境变量
await load({
  export: true, // 导出到 Deno.env
  envPath: './.env', // 指定 .env 文件路径
});

// 直接读取 JSON 文件
const flowData = JSON.parse(await Deno.readTextFile('./test/test_flow_data.json'));

const LOCAL_ENDPOINT = Deno.env.get('LOCAL_ENDPOINT');
const X_KEY = Deno.env.get('X_KEY');

interface EmbeddingResponse {
  embedding: number[];
  processedText: string;
}

Deno.test('Flow Embedding Local Test', async () => {
  console.log('Test data:', flowData);
  console.log('Endpoint:', LOCAL_ENDPOINT);
  console.log('X-Key:', X_KEY?.slice(0, 5) + '...'); // 只显示密钥的前5位

  const response = await fetch(`${LOCAL_ENDPOINT}/flow_embedding`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      x_key: X_KEY!,
    },
    body: JSON.stringify(flowData),
  });

  console.log('Response status:', response.status);

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Error response:', errorText);
    throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
  }

  const data: EmbeddingResponse = await response.json();
  console.log('Response data:', data);
});
