'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePublicOrigin } from '../../public-origin';
import { CopyButton } from '../../ui';
import styles from './explorer.module.css';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ExplorerParameter {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schemaType?: string;
}

export interface ExplorerResponse {
  status: string;
  description: string;
  contentTypes: string[];
  schemaSummary?: string;
}

export interface ExplorerEndpoint {
  id: string;
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary: string;
  description?: string;
  tags: string[];
  publicAccess: boolean;
  requiresIdempotencyKey: boolean;
  parameters: ExplorerParameter[];
  requestContentTypes: string[];
  requestSchemaJson?: string;
  responses: ExplorerResponse[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRef(node: unknown, components: JsonObject, seen: Set<string> = new Set()): unknown {
  if (!isObject(node)) return node;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/components/')) {
    const refPath = node.$ref;
    if (seen.has(refPath)) return { $ref: refPath };
    const [, , group, name] = refPath.split('/');
    const targetGroup =
      group && isObject(components[group]) ? (components[group] as JsonObject) : null;
    const resolved = targetGroup && name ? targetGroup[name] : undefined;
    if (resolved !== undefined) {
      const nextSeen = new Set(seen);
      nextSeen.add(refPath);
      return resolveRef(resolved, components, nextSeen);
    }
  }
  return node;
}

function summarizeSchema(
  schema: unknown,
  components: JsonObject,
  depth = 0,
  seen: Set<string> = new Set(),
): unknown {
  if (!isObject(schema) || depth > 2) return schema;
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').at(-1) ?? schema.$ref;
    if (depth >= 2 || seen.has(schema.$ref)) return { $ref: name };
    const resolved = resolveRef(schema, components, seen);
    const nextSeen = new Set(seen);
    nextSeen.add(schema.$ref);
    return summarizeSchema(resolved, components, depth + 1, nextSeen);
  }
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && isObject(value)) {
      const props: JsonObject = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = summarizeSchema(propSchema, components, depth + 1, seen);
      }
      out.properties = props;
    } else if (key === 'items' && isObject(value)) {
      out.items = summarizeSchema(value, components, depth + 1, seen);
    } else if ((key === 'oneOf' || key === 'anyOf' || key === 'allOf') && Array.isArray(value)) {
      out[key] = value.map((branch) => summarizeSchema(branch, components, depth + 1, seen));
    } else {
      out[key] = value;
    }
  }
  return out;
}

function schemaTypeLabel(schema: unknown): string {
  if (!isObject(schema)) return 'any';
  if (typeof schema.$ref === 'string') return schema.$ref.split('/').at(-1) ?? 'object';
  if (Array.isArray(schema.enum))
    return `enum(${schema.enum.slice(0, 4).join(' | ')}${schema.enum.length > 4 ? ' | …' : ''})`;
  if (Array.isArray(schema.type)) return schema.type.join(' | ');
  if (typeof schema.type === 'string') {
    return schema.format ? `${schema.type} (${String(schema.format)})` : schema.type;
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  return 'object';
}

function parseOpenApiDocument(doc: JsonObject): {
  version: string;
  specVersion: string;
  description?: string;
  endpoints: ExplorerEndpoint[];
} | null {
  if (typeof doc.openapi !== 'string' || !isObject(doc.paths)) return null;
  const info = isObject(doc.info) ? doc.info : {};
  const components = isObject(doc.components) ? doc.components : {};
  const endpoints: ExplorerEndpoint[] = [];
  const validMethods = new Set<HttpMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

  for (const [path, pathItem] of Object.entries(doc.paths)) {
    if (!isObject(pathItem)) continue;
    const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const [rawMethod, operation] of Object.entries(pathItem)) {
      const method = rawMethod.toUpperCase() as HttpMethod;
      if (!validMethods.has(method) || !isObject(operation)) continue;
      const rawParams = [
        ...sharedParams,
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ];
      const parameters: ExplorerParameter[] = [];
      let requiresIdempotencyKey = false;
      for (const rawParam of rawParams) {
        const resolved = resolveRef(rawParam, components);
        if (!isObject(resolved) || typeof resolved.name !== 'string') continue;
        if (resolved.name.toLowerCase() === 'idempotency-key') requiresIdempotencyKey = true;
        parameters.push({
          name: resolved.name,
          in: typeof resolved.in === 'string' ? resolved.in : 'query',
          required: Boolean(resolved.required),
          description: typeof resolved.description === 'string' ? resolved.description : undefined,
          schemaType: schemaTypeLabel(resolved.schema),
        });
      }

      const requestBody = isObject(operation.requestBody) ? operation.requestBody : null;
      const requestContent =
        requestBody && isObject(requestBody.content) ? requestBody.content : null;
      const requestContentTypes = requestContent ? Object.keys(requestContent) : [];
      let requestSchemaJson: string | undefined;
      if (requestContent) {
        const primaryType =
          requestContent['application/json'] ?? requestContent[requestContentTypes[0] ?? ''];
        if (isObject(primaryType) && primaryType.schema) {
          requestSchemaJson = JSON.stringify(
            summarizeSchema(primaryType.schema, components, 0),
            null,
            2,
          );
        }
      }

      const responsesObj = isObject(operation.responses) ? operation.responses : {};
      const responses: ExplorerResponse[] = Object.entries(responsesObj).map(([status, detail]) => {
        const entry = isObject(detail) ? detail : {};
        const content = isObject(entry.content) ? entry.content : null;
        const contentTypes = content ? Object.keys(content) : [];
        let schemaSummary: string | undefined;
        if (content && contentTypes.length > 0) {
          const media = content[contentTypes[0]!];
          if (isObject(media) && media.schema) schemaSummary = schemaTypeLabel(media.schema);
        }
        return {
          status,
          description: typeof entry.description === 'string' ? entry.description : '',
          contentTypes,
          schemaSummary,
        };
      });

      const security = operation.security;
      const publicAccess = Array.isArray(security) && security.length === 0;
      const tags =
        Array.isArray(operation.tags) && operation.tags.length > 0
          ? operation.tags.filter((tag): tag is string => typeof tag === 'string')
          : ['general'];

      const operationId =
        typeof operation.operationId === 'string' ? operation.operationId : undefined;
      endpoints.push({
        id: `${method} ${path}`,
        method,
        path,
        operationId,
        summary:
          typeof operation.summary === 'string'
            ? operation.summary
            : (operationId ?? `${method} ${path}`),
        description: typeof operation.description === 'string' ? operation.description : undefined,
        tags,
        publicAccess,
        requiresIdempotencyKey,
        parameters,
        requestContentTypes,
        requestSchemaJson,
        responses,
      });
    }
  }

  return {
    version: typeof info.version === 'string' ? info.version : '0.1.2',
    specVersion: doc.openapi,
    description: typeof info.description === 'string' ? info.description : undefined,
    endpoints,
  };
}

function buildCurlSnippet(endpoint: ExplorerEndpoint, origin: string): string {
  const samplePath = endpoint.path
    .replace(/\{id\}/g, endpoint.path.includes('/generations') ? '$OPENGEN_JOB_ID' : '<id>')
    .replace(/\{([a-zA-Z0-9_]+)\}/g, '<$1>');
  const lines = [`# Set OPENGEN_API_URL="${origin}"`];
  const methodFlag = endpoint.method === 'GET' ? '' : ` -X ${endpoint.method}`;
  lines.push(`curl --fail-with-body${methodFlag} "$OPENGEN_API_URL${samplePath}" \\`);
  if (!endpoint.publicAccess) {
    lines.push('  -H "Authorization: Bearer $OPENGEN_API_KEY" \\');
  }
  if (endpoint.requiresIdempotencyKey) {
    lines.push('  -H "Idempotency-Key: $OPENGEN_IDEMPOTENCY_KEY" \\');
  }
  if (
    ['POST', 'PUT', 'PATCH'].includes(endpoint.method) &&
    endpoint.requestContentTypes.includes('application/json')
  ) {
    lines.push("  -H 'Content-Type: application/json' \\");
    lines.push('  --data-binary @request.json');
  } else {
    // Strip trailing continuation backslash from the last line.
    const lastIndex = lines.length - 1;
    lines[lastIndex] = lines[lastIndex]!.replace(/ \\$/, '');
  }
  return lines.join('\n');
}

function buildMcpCallSnippet(endpoint: ExplorerEndpoint): string {
  const payload: Record<string, unknown> = {
    operationId: endpoint.operationId,
    input: {},
  };
  if (endpoint.requiresIdempotencyKey) {
    payload.idempotencyKey = 'REPLACE_WITH_PERSISTED_KEY';
  }
  return JSON.stringify(payload, null, 2);
}

function EndpointCard({
  endpoint,
  origin,
  isMcpOperation,
}: {
  endpoint: ExplorerEndpoint;
  origin: string;
  isMcpOperation: boolean;
}) {
  const [snippetMode, setSnippetMode] = useState<'curl' | 'mcp'>('curl');
  const curlSnippet = buildCurlSnippet(endpoint, origin);
  const mcpSnippet = isMcpOperation ? buildMcpCallSnippet(endpoint) : null;
  const activeSnippet = snippetMode === 'mcp' && mcpSnippet ? mcpSnippet : curlSnippet;
  const methodClass = styles[`method${endpoint.method}` as keyof typeof styles] ?? '';

  return (
    <details className={styles.endpoint} data-testid="openapi-endpoint">
      <summary className={styles.endpointSummary}>
        <span className={`${styles.method} ${methodClass}`}>{endpoint.method}</span>
        <code className={styles.endpointPath}>{endpoint.path}</code>
        <span className={styles.endpointTitle}>{endpoint.summary}</span>
        <span className={styles.endpointMeta}>
          {endpoint.operationId && <span className={styles.opTag}>{endpoint.operationId}</span>}
          {isMcpOperation && <span className={styles.mcpBadge}>MCP call</span>}
        </span>
      </summary>
      <div className={styles.endpointBody}>
        {endpoint.description && <p className={styles.description}>{endpoint.description}</p>}
        <div className={styles.badgesRow}>
          <span>
            Auth:{' '}
            <code>
              {endpoint.publicAccess ? 'Public (no auth required)' : 'Bearer token or session'}
            </code>
          </span>
          {endpoint.requiresIdempotencyKey && (
            <span>
              Header: <code>Idempotency-Key</code> required
            </span>
          )}
          <span>
            Tags: <code>{endpoint.tags.join(', ')}</code>
          </span>
        </div>

        {endpoint.parameters.length > 0 && (
          <div className={styles.sectionBlock}>
            <h3>Parameters</h3>
            <div className={styles.tableWrap}>
              <table className={styles.paramTable}>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">In</th>
                    <th scope="col">Type</th>
                    <th scope="col">Required</th>
                    <th scope="col">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {endpoint.parameters.map((param) => (
                    <tr key={`${param.in}:${param.name}`}>
                      <td>
                        <code>{param.name}</code>
                      </td>
                      <td>{param.in}</td>
                      <td>
                        <code>{param.schemaType ?? 'string'}</code>
                      </td>
                      <td>{param.required ? 'Yes' : 'No'}</td>
                      <td>{param.description ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {endpoint.requestSchemaJson && (
          <div className={styles.sectionBlock}>
            <h3>
              Request body
              {endpoint.requestContentTypes.length > 0
                ? ` (${endpoint.requestContentTypes.join(', ')})`
                : ''}
            </h3>
            <div className={styles.codePanel}>
              <div className={styles.codeHeader}>
                <span>JSON Schema</span>
                <CopyButton text={endpoint.requestSchemaJson} label="Copy schema" />
              </div>
              <pre className={styles.schemaPre} tabIndex={0} aria-label="Request JSON Schema">
                <code>{endpoint.requestSchemaJson}</code>
              </pre>
            </div>
          </div>
        )}

        {endpoint.responses.length > 0 && (
          <div className={styles.sectionBlock}>
            <h3>Responses</h3>
            <div className={styles.tableWrap}>
              <table className={styles.paramTable}>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Description</th>
                    <th scope="col">Payload</th>
                  </tr>
                </thead>
                <tbody>
                  {endpoint.responses.map((response) => (
                    <tr key={response.status}>
                      <td>
                        <code>{response.status}</code>
                      </td>
                      <td>{response.description || '—'}</td>
                      <td>
                        {response.schemaSummary ? (
                          <code>{response.schemaSummary}</code>
                        ) : response.contentTypes.length > 0 ? (
                          <code>{response.contentTypes.join(', ')}</code>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className={styles.sectionBlock}>
          <h3>Executable example</h3>
          <div className={styles.codePanel}>
            <div className={styles.codeHeader}>
              <div className={styles.snippetTabs} role="tablist" aria-label="Snippet format">
                <button
                  type="button"
                  role="tab"
                  aria-selected={snippetMode === 'curl'}
                  className={styles.snippetTab}
                  onClick={() => setSnippetMode('curl')}
                >
                  cURL
                </button>
                {mcpSnippet && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={snippetMode === 'mcp'}
                    className={styles.snippetTab}
                    onClick={() => setSnippetMode('mcp')}
                  >
                    MCP call
                  </button>
                )}
              </div>
              <CopyButton
                text={activeSnippet}
                label={snippetMode === 'mcp' ? 'Copy MCP JSON' : 'Copy cURL'}
              />
            </div>
            <pre>
              <code>{activeSnippet}</code>
            </pre>
          </div>
        </div>
      </div>
    </details>
  );
}

const METHODS: readonly ('ALL' | HttpMethod)[] = ['ALL', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function OpenApiExplorer({
  initialEndpoints,
  registeredOperationIds,
}: {
  initialEndpoints: ExplorerEndpoint[];
  registeredOperationIds: string[];
}) {
  const origin = usePublicOrigin();
  const mcpOps = useMemo(() => new Set(registeredOperationIds), [registeredOperationIds]);
  const [endpoints, setEndpoints] = useState<ExplorerEndpoint[]>(initialEndpoints);
  const [specState, setSpecState] = useState<'loading' | 'live' | 'fallback'>('loading');
  const [specMeta, setSpecMeta] = useState<{
    specVersion: string;
    version: string;
    description?: string;
  } | null>(null);
  const [query, setQuery] = useState('');
  const [selectedMethod, setSelectedMethod] = useState<'ALL' | HttpMethod>('ALL');
  const [selectedTag, setSelectedTag] = useState<string>('all');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/openapi.json', {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) {
          setSpecState('fallback');
          return;
        }
        const json: unknown = await response.json();
        const parsed = isObject(json) ? parseOpenApiDocument(json) : null;
        if (parsed && parsed.endpoints.length > 0) {
          setEndpoints(parsed.endpoints);
          setSpecMeta({
            specVersion: parsed.specVersion,
            version: parsed.version,
            description: parsed.description,
          });
          setSpecState('live');
        } else {
          setSpecState('fallback');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setSpecState('fallback');
      });
    return () => controller.abort();
  }, []);

  const tags = useMemo(() => {
    const unique = new Set<string>();
    for (const ep of endpoints) {
      for (const tag of ep.tags) unique.add(tag);
    }
    return ['all', ...Array.from(unique).sort()];
  }, [endpoints]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return endpoints.filter((ep) => {
      if (selectedMethod !== 'ALL' && ep.method !== selectedMethod) return false;
      if (selectedTag !== 'all' && !ep.tags.includes(selectedTag)) return false;
      if (!needle) return true;
      return (
        ep.path.toLowerCase().includes(needle) ||
        (ep.operationId?.toLowerCase().includes(needle) ?? false) ||
        ep.summary.toLowerCase().includes(needle) ||
        (ep.description?.toLowerCase().includes(needle) ?? false) ||
        ep.tags.some((t) => t.toLowerCase().includes(needle))
      );
    });
  }, [endpoints, query, selectedMethod, selectedTag]);

  return (
    <section className={styles.explorer} aria-label="Interactive OpenAPI explorer">
      <div className={styles.statusBar} data-testid="openapi-status">
        <div className={styles.statusLead}>
          <span
            className={`${styles.specBadge} ${specState === 'live' ? styles.specBadgeLive : ''}`}
          >
            {specState === 'live'
              ? `OpenAPI ${specMeta?.specVersion ?? '3.1.0'} · v${specMeta?.version ?? '0.1.2'}`
              : 'Contract operation registry'}
          </span>
          <span>
            {specState === 'live'
              ? `Loaded live from /openapi.json (${endpoints.length} endpoints).`
              : specState === 'loading'
                ? `Showing ${endpoints.length} registered operations while checking /openapi.json…`
                : `Live /openapi.json is unavailable in this preview; showing ${endpoints.length} registered operations from @media-router/contracts.`}
          </span>
        </div>
        <a href="/openapi.json">Download /openapi.json ↗</a>
      </div>

      <div className={styles.controls}>
        <div className={styles.searchRow}>
          <input
            type="search"
            className={styles.searchInput}
            aria-label="Filter endpoints"
            placeholder="Search path, operationId, or description (e.g. quotes, generations, models.schema)…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className={styles.count}>
            {filtered.length} of {endpoints.length} endpoints
          </span>
        </div>

        <div className={styles.filterRow} role="group" aria-label="Filter by HTTP method">
          <span className={styles.filterLabel}>Method</span>
          {METHODS.map((method) => (
            <button
              key={method}
              type="button"
              className={styles.filterPill}
              aria-pressed={selectedMethod === method}
              onClick={() => setSelectedMethod(method)}
            >
              {method}
            </button>
          ))}
        </div>

        <div className={styles.filterRow} role="group" aria-label="Filter by API group">
          <span className={styles.filterLabel}>Group</span>
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={styles.filterPill}
              aria-pressed={selectedTag === tag}
              onClick={() => setSelectedTag(tag)}
            >
              {tag === 'all' ? 'All groups' : tag}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className={styles.emptyState}>
          No endpoints match your current filters. Clear the search or choose “All groups”.
        </div>
      ) : (
        <div className={styles.endpointList}>
          {filtered.map((endpoint) => (
            <EndpointCard
              key={endpoint.id}
              endpoint={endpoint}
              origin={origin}
              isMcpOperation={Boolean(endpoint.operationId && mcpOps.has(endpoint.operationId))}
            />
          ))}
        </div>
      )}
    </section>
  );
}
