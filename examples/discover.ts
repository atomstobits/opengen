import { OpenGen } from '@media-router/sdk';

// Read-only. Supply a gateway key only if this installation requires one for discovery.
const client = new OpenGen({
  baseUrl: process.env.MEDIA_ROUTER_URL ?? 'http://127.0.0.1:4310',
  apiKey: process.env.MEDIA_ROUTER_TOKEN,
});
const models = await client.search(process.argv.slice(2).join(' ') || 'wan 3.0');
console.table(models.map(({ id, name, modality, openness }) => ({ id, name, modality, openness })));
const series = await client.series('minimax', 'h3');
console.table(
  series.routes.map((route) => {
    const deployment = series.deployments.find((value) => value.id === route.deploymentId)!;
    return {
      model: route.modelId,
      route: route.id,
      endpointRegion: deployment.endpointRegion,
      status: route.status,
    };
  }),
);
