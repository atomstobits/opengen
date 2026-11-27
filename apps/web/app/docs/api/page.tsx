import { operationTargets, type OperationId } from '@media-router/contracts';
import { Footer, SiteHeader } from '../../ui';
import { pageMetadata } from '../../seo';
import { OpenApiExplorer, type ExplorerEndpoint, type HttpMethod } from './openapi-explorer';
import styles from './explorer.module.css';

export const metadata = pageMetadata({
  title: 'Interactive OpenAPI reference | OpenGen',
  description:
    'Browse OpenGen REST and MCP endpoints directly from the gateway’s OpenAPI 3.1 specification. Zero external CDN dependencies.',
  path: '/docs/api',
});

const PUBLIC_OPERATIONS = new Set<string>([
  'catalog.list',
  'catalog.search',
  'companies.list',
  'companies.get',
  'series.list',
  'series.get',
  'models.list',
  'models.schema',
  'providers.list',
  'deployments.list',
  'routes.list',
  'metrics.list',
  'operations.list',
]);

const IDEMPOTENT_OPERATIONS = new Set<string>([
  'media.generate',
  'images.generate',
  'images.edit',
  'videos.create',
]);

function inferGroup(operationId: string): string {
  if (
    operationId.startsWith('catalog.') ||
    operationId.startsWith('companies.') ||
    operationId.startsWith('series.') ||
    operationId.startsWith('models.') ||
    operationId.startsWith('providers.') ||
    operationId.startsWith('deployments.') ||
    operationId.startsWith('routes.') ||
    operationId.startsWith('metrics.') ||
    operationId.startsWith('operations.')
  )
    return 'catalog';
  if (operationId.startsWith('quotes.')) return 'quotes';
  if (operationId === 'media.generate' || operationId.startsWith('jobs.')) return 'generations';
  if (operationId.startsWith('assets.')) return 'assets';
  if (
    operationId.startsWith('billing.') ||
    operationId.startsWith('balance.') ||
    operationId.startsWith('ledger.')
  )
    return 'billing';
  if (operationId.startsWith('images.') || operationId.startsWith('videos.'))
    return 'compatibility';
  if (
    operationId.startsWith('webhooks.') ||
    operationId.startsWith('alerts.') ||
    operationId.startsWith('notifications.')
  )
    return 'events';
  if (operationId.startsWith('operator.')) return 'operator';
  return 'workspace';
}

function buildBaselineEndpoints(): ExplorerEndpoint[] {
  return (
    Object.entries(operationTargets) as [OperationId, { method: HttpMethod; path: string }][]
  ).map(([operationId, target]) => {
    const openApiPath = target.path.replace(/:([a-zA-Z]+)/g, '{$1}');
    const pathParams = [...openApiPath.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => ({
      name: match[1]!,
      in: 'path',
      required: true,
      schemaType: 'string',
    }));
    const requiresIdempotencyKey = IDEMPOTENT_OPERATIONS.has(operationId);
    const parameters = requiresIdempotencyKey
      ? [
          ...pathParams,
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schemaType: 'string',
            description:
              'Persist this key with the exact original request before submission; reuse only for that request.',
          },
        ]
      : pathParams;
    return {
      id: `${target.method} ${openApiPath}`,
      method: target.method,
      path: openApiPath,
      operationId,
      summary: `Registered operation ${operationId}`,
      tags: [inferGroup(operationId)],
      publicAccess: PUBLIC_OPERATIONS.has(operationId),
      requiresIdempotencyKey,
      parameters,
      requestContentTypes: ['POST', 'PUT', 'PATCH'].includes(target.method)
        ? ['application/json']
        : [],
      responses: [],
    };
  });
}

export default function OpenApiDocsPage() {
  const initialEndpoints = buildBaselineEndpoints();
  const registeredOperationIds = Object.keys(operationTargets);

  return (
    <>
      <SiteHeader />
      <main className={`${styles.page} page-width`}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <a href="/">OpenGen</a>
          <span aria-hidden="true">/</span>
          <a href="/docs">Docs</a>
          <span aria-hidden="true">/</span>
          <span>Interactive API explorer</span>
        </nav>
        <header className={styles.hero}>
          <span className="eyebrow">OPENAPI 3.1 / MCP REGISTRY</span>
          <h1>Interactive API reference.</h1>
          <p>
            Search and inspect OpenGen’s native HTTP and MCP operations directly from this gateway’s
            OpenAPI 3.1 specification — no external CDN scripts, no proprietary SDK required. Set{' '}
            <code>OPENGEN_API_URL</code> and <code>OPENGEN_API_KEY</code> privately to run any
            copied cURL snippet.
          </p>
          <div className={styles.heroActions}>
            <a className="button button-outline" href="/docs#http-examples">
              ← Back to Quickstart
            </a>
            <a className="button button-outline" href="/openapi.json">
              Raw /openapi.json ↗
            </a>
            <a className="button button-outline" href="/llms.txt">
              Agent index (/llms.txt) ↗
            </a>
          </div>
        </header>
        <OpenApiExplorer
          initialEndpoints={initialEndpoints}
          registeredOperationIds={registeredOperationIds}
        />
      </main>
      <Footer />
    </>
  );
}
