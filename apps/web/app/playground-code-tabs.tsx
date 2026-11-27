'use client';

import { useId, useState } from 'react';
import type { GenerateInput } from '@media-router/contracts';
import { CopyButton } from './ui';
import styles from './private-playground.module.css';

export type CodeTabId = 'curl' | 'javascript' | 'python' | 'mcp';
export type PythonClient = 'urllib' | 'httpx';

const tabs: readonly { id: CodeTabId; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'python', label: 'Python' },
  { id: 'mcp', label: 'Agent / MCP' },
];

function heredocDelimiter(content: string): string {
  let delimiter = 'OPENGEN_REQUEST';
  let suffix = 1;
  while (content.includes(delimiter)) {
    delimiter = `OPENGEN_REQUEST_${suffix++}`;
  }
  return delimiter;
}

function toPythonLiteral(value: unknown, depth = 0): string {
  const indent = '  '.repeat(depth);
  const childIndent = '  '.repeat(depth + 1);
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => `${childIndent}${toPythonLiteral(item, depth + 1)}`);
    return `[\n${items.join(',\n')}\n${indent}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, entry]) => entry !== undefined,
    );
    if (entries.length === 0) return '{}';
    const lines = entries.map(
      ([key, entry]) =>
        `${childIndent}${JSON.stringify(key)}: ${toPythonLiteral(entry, depth + 1)}`,
    );
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return 'None';
}

function trimTrailingSlash(origin: string): string {
  return origin.replace(/\/+$/, '');
}

export function buildCurlSnippet(gatewayOrigin: string, request: GenerateInput): string {
  const origin = trimTrailingSlash(gatewayOrigin);
  const json = JSON.stringify(request, null, 2);
  const eof = heredocDelimiter(json);
  return [
    `export OPENGEN_API_URL="\${OPENGEN_API_URL:-${origin}}"`,
    '',
    '# 1. Save the canonical request body without shell expansion',
    `cat <<'${eof}' > request.json`,
    json,
    eof,
    '',
    '# 2. Check the quote (read-only, no credits spent)',
    'curl -sS "${OPENGEN_API_URL}/v1/quotes" \\',
    '  -H "Authorization: Bearer ${OPENGEN_API_KEY:?Set OPENGEN_API_KEY privately}" \\',
    "  -H 'Content-Type: application/json' \\",
    '  --data-binary @request.json',
    '',
    '# 3. Submit when ready (billable — save OPENGEN_REQUEST_ID for retries)',
    'curl -sS "${OPENGEN_API_URL}/v1/generations" \\',
    '  -H "Authorization: Bearer ${OPENGEN_API_KEY:?Set OPENGEN_API_KEY privately}" \\',
    '  -H "Idempotency-Key: ${OPENGEN_REQUEST_ID:?Set and save a unique ID}" \\',
    "  -H 'Content-Type: application/json' \\",
    '  --data-binary @request.json',
  ].join('\n');
}

export function buildJavaScriptSnippet(gatewayOrigin: string, request: GenerateInput): string {
  const origin = trimTrailingSlash(gatewayOrigin);
  const payload = JSON.stringify(request, null, 2);
  return [
    `const apiUrl = (process.env.OPENGEN_API_URL ?? ${JSON.stringify(origin)}).replace(/\\/+$/, '');`,
    'const apiKey = process.env.OPENGEN_API_KEY;',
    "if (!apiKey) throw new Error('Set OPENGEN_API_KEY privately.');",
    '',
    `const request = ${payload};`,
    '',
    '// 1. Check the quote (no credits spent)',
    'const quoteResponse = await fetch(`${apiUrl}/v1/quotes`, {',
    "  method: 'POST',",
    '  headers: {',
    '    Authorization: `Bearer ${apiKey}`,',
    "    'Content-Type': 'application/json',",
    '  },',
    '  body: JSON.stringify(request),',
    '});',
    'if (!quoteResponse.ok) throw new Error(`Quote failed: ${quoteResponse.status}`);',
    'const quote = await quoteResponse.json();',
    "console.log('Quote:', quote);",
    '',
    '// 2. Submit when ready (billable — generate and persist OPENGEN_REQUEST_ID before running)',
    'const idempotencyKey = process.env.OPENGEN_REQUEST_ID?.trim();',
    "if (!idempotencyKey) throw new Error('Set and save a unique OPENGEN_REQUEST_ID before submitting.');",
    'const jobResponse = await fetch(`${apiUrl}/v1/generations`, {',
    "  method: 'POST',",
    '  headers: {',
    '    Authorization: `Bearer ${apiKey}`,',
    "    'Content-Type': 'application/json',",
    "    'Idempotency-Key': idempotencyKey,",
    '  },',
    '  body: JSON.stringify(request),',
    '});',
    'if (!jobResponse.ok) throw new Error(`Submit failed: ${jobResponse.status}`);',
    'const job = await jobResponse.json();',
    "console.log('Job:', job.id, job.status);",
  ].join('\n');
}

export function buildPythonSnippet(
  gatewayOrigin: string,
  request: GenerateInput,
  client: PythonClient = 'urllib',
): string {
  const origin = trimTrailingSlash(gatewayOrigin);
  const payload = toPythonLiteral(request);
  if (client === 'httpx') {
    return [
      'import os',
      'import httpx',
      '',
      `api_url = os.environ.get("OPENGEN_API_URL", ${JSON.stringify(origin)}).rstrip("/")`,
      'api_key = os.environ["OPENGEN_API_KEY"]',
      'headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}',
      '',
      `payload = ${payload}`,
      '',
      'with httpx.Client(timeout=60.0) as client:',
      '    # 1. Check the quote (no credits spent)',
      '    quote_res = client.post(f"{api_url}/v1/quotes", headers=headers, json=payload)',
      '    quote_res.raise_for_status()',
      '    print("Quote:", quote_res.json())',
      '',
      '    # 2. Submit when ready (billable — generate and persist OPENGEN_REQUEST_ID before running)',
      '    idempotency_key = os.environ.get("OPENGEN_REQUEST_ID", "").strip()',
      '    if not idempotency_key:',
      '        raise SystemExit("Set and save a unique OPENGEN_REQUEST_ID before submitting.")',
      '    job_res = client.post(',
      '        f"{api_url}/v1/generations",',
      '        headers={**headers, "Idempotency-Key": idempotency_key},',
      '        json=payload,',
      '    )',
      '    job_res.raise_for_status()',
      '    job = job_res.json()',
      '    print("Job:", job["id"], job["status"])',
    ].join('\n');
  }
  return [
    'import json',
    'import os',
    'import urllib.request',
    '',
    `api_url = os.environ.get("OPENGEN_API_URL", ${JSON.stringify(origin)}).rstrip("/")`,
    'api_key = os.environ["OPENGEN_API_KEY"]',
    '',
    `payload = ${payload}`,
    'body = json.dumps(payload).encode("utf-8")',
    '',
    '# 1. Check the quote (no credits spent)',
    'quote_req = urllib.request.Request(',
    '    f"{api_url}/v1/quotes",',
    '    data=body,',
    '    method="POST",',
    '    headers={',
    '        "Authorization": f"Bearer {api_key}",',
    '        "Content-Type": "application/json",',
    '    },',
    ')',
    'with urllib.request.urlopen(quote_req, timeout=60) as response:',
    '    print("Quote:", json.loads(response.read().decode("utf-8")))',
    '',
    '# 2. Submit when ready (billable — generate and persist OPENGEN_REQUEST_ID before running)',
    'idempotency_key = os.environ.get("OPENGEN_REQUEST_ID", "").strip()',
    'if not idempotency_key:',
    '    raise SystemExit("Set and save a unique OPENGEN_REQUEST_ID before submitting.")',
    'job_req = urllib.request.Request(',
    '    f"{api_url}/v1/generations",',
    '    data=body,',
    '    method="POST",',
    '    headers={',
    '        "Authorization": f"Bearer {api_key}",',
    '        "Content-Type": "application/json",',
    '        "Idempotency-Key": idempotency_key,',
    '    },',
    ')',
    'with urllib.request.urlopen(job_req, timeout=60) as response:',
    '    job = json.loads(response.read().decode("utf-8"))',
    '    print("Job:", job["id"], job["status"])',
  ].join('\n');
}

export function buildMcpSnippet(gatewayOrigin: string, request: GenerateInput): string {
  const origin = trimTrailingSlash(gatewayOrigin);
  return JSON.stringify(
    {
      mcpEndpoint: `${origin}/mcp`,
      steps: [
        {
          tool: 'quote',
          arguments: {
            input: request,
          },
        },
        {
          tool: 'call',
          arguments: {
            operationId: 'media.generate',
            idempotencyKey: '<save-unique-request-id>',
            input: request,
          },
        },
      ],
    },
    null,
    2,
  );
}

export function PlaygroundCodeTabs({
  gatewayOrigin,
  buildRequest,
}: {
  gatewayOrigin: string;
  buildRequest: () => GenerateInput;
}) {
  const [activeTab, setActiveTab] = useState<CodeTabId>('curl');
  const [pythonClient, setPythonClient] = useState<PythonClient>('urllib');
  const baseId = useId();

  let request: GenerateInput | null = null;
  let requestError = '';
  try {
    request = buildRequest();
  } catch (cause) {
    requestError = cause instanceof Error ? cause.message : 'Complete your inputs above.';
  }

  let code = '';
  if (request) {
    if (activeTab === 'curl') code = buildCurlSnippet(gatewayOrigin, request);
    else if (activeTab === 'javascript') code = buildJavaScriptSnippet(gatewayOrigin, request);
    else if (activeTab === 'python')
      code = buildPythonSnippet(gatewayOrigin, request, pythonClient);
    else code = buildMcpSnippet(gatewayOrigin, request);
  }

  const copyLabel =
    activeTab === 'curl'
      ? 'Copy cURL'
      : activeTab === 'javascript'
        ? 'Copy JavaScript'
        : activeTab === 'python'
          ? `Copy Python (${pythonClient})`
          : 'Copy MCP JSON';

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex]!;
    setActiveTab(nextTab.id);
    document.getElementById(`${baseId}-tab-${nextTab.id}`)?.focus();
  }

  return (
    <section
      className={styles.codeTabs}
      aria-label="Raw HTTP and MCP code snippets"
      data-testid="playground-code-tabs"
    >
      <div className={styles.codeTabsHeader}>
        <div>
          <span className="eyebrow">RAW HTTP &amp; MCP · NO SDK REQUIRED</span>
          <h3>Run this exact request from code or an agent</h3>
        </div>
        <a className="text-link" href={activeTab === 'mcp' ? '/agents' : '/app#keys'}>
          {activeTab === 'mcp' ? 'Connect an agent ↗' : 'Create API key ↗'}
        </a>
      </div>
      <div className={styles.codeTabList} role="tablist" aria-label="Code language">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`${baseId}-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`${baseId}-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id={`${baseId}-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${activeTab}`}
        className={styles.codeTabPanel}
      >
        {activeTab === 'python' && (
          <div className={styles.codeSubBar} role="group" aria-label="Python HTTP client">
            <span>HTTP client:</span>
            {(['urllib', 'httpx'] as const).map((client) => (
              <button
                key={client}
                type="button"
                aria-pressed={pythonClient === client}
                onClick={() => setPythonClient(client)}
              >
                {client === 'urllib' ? 'urllib (stdlib)' : 'httpx'}
              </button>
            ))}
          </div>
        )}
        {requestError ? (
          <p className={styles.codePlaceholder}>
            {requestError} Pick a starter prompt or enter your inputs above to generate live
            raw-HTTP and MCP snippets.
          </p>
        ) : (
          <div className={styles.codeBox}>
            <div className={styles.codeBoxBar}>
              <span>
                {activeTab === 'mcp'
                  ? 'MCP Streamable HTTP · quote then call (media.generate)'
                  : 'Uses OPENGEN_API_URL, OPENGEN_API_KEY, and saved OPENGEN_REQUEST_ID'}
              </span>
              <CopyButton text={code} label={copyLabel} />
            </div>
            <pre tabIndex={0}>
              <code>{code}</code>
            </pre>
          </div>
        )}
      </div>
    </section>
  );
}
