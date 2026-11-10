import {
  billingOperationTargets,
  operationTargets,
  canonicalModelId,
} from '@media-router/contracts';
import {
  catalog,
  generationProfiles,
  catalogSearchQuerySchema,
  companies,
  modelSeries,
  getCompanyDetail,
  getSeriesDetail,
  searchCatalog,
} from '@media-router/catalog';
import { forward } from './proxy';
import {
  generationSchema,
  getGenerationDefinition,
  getGenerationSchema,
} from '@media-router/contracts/generation';

import { nativeRoute, pathSegments } from './registered-http';
export { nativeRoute } from './registered-http';

const publicJson = (value: unknown, method: string, status = 200) =>
  new Response(method === 'HEAD' ? null : JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=0, s-maxage=60',
    },
  });
const missing = (method: string) =>
  publicJson({ error: { code: 'not_found', message: 'Catalog entry not found.' } }, method, 404);
export function localCatalog(request: Request): Response | undefined {
  const url = new URL(request.url),
    method = request.method;
  if (!['GET', 'HEAD'].includes(method)) return undefined;
  const input = pathSegments(url.pathname);
  if (!input) return undefined;
  if (url.pathname === '/v1/catalog')
    return publicJson(
      {
        ...catalog,
        models: catalog.models.map((model) => ({
          ...model,
          generationProfiles: generationProfiles(model.id),
        })),
        companies,
        series: modelSeries,
      },
      method,
    );
  if (url.pathname === '/v1/catalog/search') {
    const parsed = catalogSearchQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (
      !parsed.success ||
      [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)
    )
      return publicJson(
        {
          error: {
            code: 'invalid_input',
            message: 'Request parameters do not match the documented schema.',
          },
        },
        method,
        400,
      );
    const { q, ...filters } = parsed.data;
    return publicJson(searchCatalog(q, filters), method);
  }
  if (url.pathname === '/v1/companies') return publicJson({ data: companies }, method);
  if (input[1] === 'companies' && input.length === 3) {
    const entry = getCompanyDetail(input[2]!);
    return entry
      ? publicJson(
          {
            ...entry,
            models: entry.models.map((model) => ({
              ...model,
              generationProfiles: generationProfiles(model.id),
            })),
          },
          method,
        )
      : missing(method);
  }
  if (url.pathname === '/v1/series') return publicJson({ data: modelSeries }, method);
  if (input[1] === 'series' && input.length === 4) {
    const entry = getSeriesDetail(`${input[2]}/${input[3]}`);
    return entry
      ? publicJson(
          {
            ...entry,
            models: entry.models.map((model) => ({
              ...model,
              generationProfiles: generationProfiles(model.id),
            })),
          },
          method,
        )
      : missing(method);
  }
  if (url.pathname === '/v1/models')
    return publicJson(
      {
        data: catalog.models.map((model) => ({
          ...model,
          generationProfiles: generationProfiles(model.id),
        })),
      },
      method,
    );
  if (url.pathname === '/v1/models/schema') {
    const model = generationSchema.shape.modelId.safeParse(url.searchParams.get('modelId'));
    const operation = generationSchema.shape.operation.safeParse(url.searchParams.get('operation'));
    if (
      !model.success ||
      !operation.success ||
      [...url.searchParams.keys()].some((key) => key !== 'modelId' && key !== 'operation') ||
      url.searchParams.getAll('modelId').length !== 1 ||
      url.searchParams.getAll('operation').length !== 1
    )
      return publicJson(
        {
          error: {
            code: 'invalid_input',
            message: 'Request parameters do not match the documented schema.',
          },
        },
        method,
        400,
      );
    const definition = getGenerationDefinition(model.data, operation.data);
    const inputSchema = getGenerationSchema(model.data, operation.data);
    return definition && inputSchema
      ? publicJson(
          generationProfiles(model.data).find((profile) => profile.operation === operation.data),
          method,
        )
      : publicJson(
          {
            error: {
              code: 'generation_schema_not_found',
              message: 'No schema is registered for this exact model and operation.',
            },
          },
          method,
          404,
        );
  }
  if (url.pathname === '/v1/providers') return publicJson({ data: catalog.providers }, method);
  if (url.pathname === '/v1/deployments') return publicJson({ data: catalog.deployments }, method);
  if (url.pathname === '/v1/routes')
    return publicJson(
      {
        data: catalog.routes.filter(
          (route) =>
            !url.searchParams.get('modelId') ||
            route.modelId === canonicalModelId(url.searchParams.get('modelId')!),
        ),
      },
      method,
    );
  if (url.pathname === '/v1/operations')
    return publicJson(
      {
        data: Object.entries(operationTargets)
          .filter(([id]) => !Object.hasOwn(billingOperationTargets, id))
          .map(([id, target]) => ({ id, ...target })),
      },
      method,
    );
  return undefined;
}
export async function nativeGateway(request: Request): Promise<Response> {
  const url = new URL(request.url),
    route = nativeRoute(url.pathname);
  if (!route)
    return Response.json(
      { error: { code: 'not_found', message: 'Unknown registered API path.' } },
      { status: 404 },
    );
  const methods = [...route.methods, ...(route.methods.includes('GET') ? ['HEAD'] : [])];
  if (request.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: { Allow: methods.join(', ') } });
  if (!methods.includes(request.method as (typeof route.methods)[number]))
    return Response.json(
      {
        error: {
          code: 'method_not_allowed',
          message: 'This method is not registered for this path.',
        },
      },
      { status: 405, headers: { Allow: methods.join(', ') } },
    );
  if (!process.env.MEDIA_ROUTER_API_URL) {
    const local = localCatalog(request);
    if (local) return local;
  }
  return forward(request, route.path + url.search);
}
