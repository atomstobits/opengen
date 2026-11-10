import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = new URL(process.env.MEDIA_ROUTER_URL ?? 'http://127.0.0.1:4310');
if (!base.pathname.endsWith('/')) base.pathname += '/';
const headers = process.env.MEDIA_ROUTER_TOKEN
  ? { Authorization: `Bearer ${process.env.MEDIA_ROUTER_TOKEN}` }
  : undefined;
const client = new Client({ name: 'opengen-discovery-example', version: '0.1.0' });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL('mcp', base), { requestInit: { headers } }),
  );
  const tools = await client.listTools();
  console.log(tools.tools.map((tool) => tool.name).join(', '));
  // Read-only discovery. Never call media.generate without a persisted request/key and spending authorization.
  const result = await client.callTool({ name: 'catalog_get', arguments: { id: 'minimax/h3' } });
  for (const content of result.content as { type: string; text?: string }[])
    if (content.type === 'text') console.log(content.text);
} finally {
  await client.close();
}
