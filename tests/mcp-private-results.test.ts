import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AccountStore } from '@media-router/engine';
import { expect, it, vi } from 'vitest';
import { buildApp, type EngineLike } from '../apps/server/src/app';

it('adds a private MCP result card and links only to the authorized job lookup', async () => {
  const id = 'acb44a4c-3cc8-4c24-a44c-8c78829d585d';
  const storage = 'https://storage.example';
  const uri = 'ui://opengen/job-result';
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const video = {
    url: `${storage}/bucket/outputs/${id}/result.mp4?X-Amz-Signature=fixture`,
    mediaType: 'video/mp4',
    expiresAt,
  };
  const job = { id, status: 'succeeded', deliveryStatus: 'available', outputs: [video] };
  const submit = vi.fn(async () => {
    throw new Error('Job lookup must not submit another generation.');
  });
  const accounts = {
    authenticate: async (token: string) => {
      if (token === 'owner-fixture') return { workspaceId: 'owner', scopes: ['read'] };
      if (token === 'other-fixture') return { workspaceId: 'other', scopes: ['read'] };
      return null;
    },
  } as unknown as AccountStore;
  const engine: EngineLike = {
    accounts,
    getExecutableRouteIds: () => [],
    submit,
    getJob: async (workspace, requestedId) =>
      workspace === 'owner' && requestedId.toLowerCase() === id ? job : null,
    listJobs: async () => [],
    cancel: async () => {
      throw new Error('Job lookup must not cancel.');
    },
    getBalance: async () => ({ availableMicros: 0, reservedMicros: 0, currency: 'USD' }),
    routeMetrics: async () => [],
  };
  const app = await buildApp({ engine, env: { NODE_ENV: 'test', S3_ENDPOINT: storage } });
  const owner = new Client({ name: 'private-result-owner', version: '1' });
  const other = new Client({ name: 'private-result-other', version: '1' });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = new URL('/mcp', app.listeningOrigin);
    await owner.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: 'Bearer owner-fixture' } },
      }),
    );
    await other.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: 'Bearer other-fixture' } },
      }),
    );
    expect(owner.getInstructions()).toContain('first call job_get with that ID');
    expect(owner.getServerCapabilities()?.extensions?.['io.modelcontextprotocol/ui']).toEqual({
      mimeTypes: ['text/html;profile=mcp-app'],
    });
    const lookup = (await owner.listTools()).tools.find((tool) => tool.name === 'job_get');
    const uiMetadata = {
      ui: { resourceUri: uri, preferredModelDisplayMode: 'inline' },
      'ui/resourceUri': uri,
    };
    expect(lookup?._meta).toMatchObject(uiMetadata);
    const resource = (await owner.readResource({ uri })).contents[0];
    expect(resource).toMatchObject({
      uri,
      mimeType: 'text/html;profile=mcp-app',
      _meta: { ui: { csp: { resourceDomains: [storage] } } },
    });
    expect(JSON.stringify(resource)).not.toContain(video.url);

    const request = { name: 'job_get', arguments: { id } };
    const visible = await owner.callTool(request);
    expect(visible.structuredContent).toEqual(job);
    expect(visible.content).toMatchObject([
      { type: 'text', text: JSON.stringify(job) },
      { type: 'resource_link', uri: video.url, mimeType: 'video/mp4' },
    ]);
    expect(visible._meta).toMatchObject({
      ...uiMetadata,
      openGenPreview: { status: 'available', media: [video] },
    });
    const uppercase = await owner.callTool({ ...request, arguments: { id: id.toUpperCase() } });
    expect(uppercase.content).toEqual(visible.content);
    expect(uppercase._meta?.openGenPreview).toEqual(visible._meta?.openGenPreview);
    const hidden = await other.callTool(request);
    expect(hidden.isError).toBe(true);
    expect(hidden._meta).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toContain(video.url);

    job.outputs.push({ ...video, url: video.url.replace(storage, 'https://untrusted.example') });
    job.outputs.push({ ...video, expiresAt: '2000-01-01T00:00:00.000Z' });
    const filtered = await owner.callTool(request);
    expect(filtered._meta?.openGenPreview).toEqual({ status: 'available', media: [video] });
    expect(filtered.content).toHaveLength(2);
    job.deliveryStatus = 'pending';
    const pending = await owner.callTool(request);
    expect(pending._meta?.openGenPreview).toEqual({ status: 'pending', media: [] });
    expect(pending.content).toHaveLength(1);
    for (const [status, delivery] of [
      ['submission-unknown', 'pending'],
      ['cancelled', 'failed'],
    ]) {
      job.status = status!;
      job.deliveryStatus = delivery!;
      const incomplete = await owner.callTool(request);
      expect(incomplete._meta?.openGenPreview).toEqual({ status, media: [] });
    }
    expect(submit).not.toHaveBeenCalled();
  } finally {
    await owner.close();
    await other.close();
    await app.close();
  }
});
