'use client';

import { usePublicOrigin } from '../public-origin';
import { CopyButton } from '../ui';

export function buildDocsMarkdown(origin: string): string {
  const cleanOrigin = origin.replace(/\/$/, '');
  return `# OpenGen API, MCP & Self-Hosting Documentation

Canonical gateway origin: ${cleanOrigin}
Agent index: ${cleanOrigin}/llms.txt
Installable skill: ${cleanOrigin}/skill.md
OpenAPI 3.1 spec: ${cleanOrigin}/openapi.json
Interactive API reference: ${cleanOrigin}/docs/api
Agent setup & support evidence: ${cleanOrigin}/agents

## Quickstart (Raw HTTP)

Set \`OPENGEN_API_URL="${cleanOrigin}"\` and store a scoped workspace key privately as \`OPENGEN_API_KEY\` (create keys at ${cleanOrigin}/app#keys).

### 1. Inspect an exact model schema (free)
\`\`\`sh
curl --fail-with-body "$OPENGEN_API_URL/v1/models/schema?modelId=bytedance%2Fseedream-5.0-pro&operation=text-to-image"
\`\`\`

### 2. Verify workspace access & balance (free)
\`\`\`sh
curl --fail-with-body "$OPENGEN_API_URL/v1/doctor" \\
  -H "Authorization: Bearer $OPENGEN_API_KEY"
\`\`\`

### 3. Quote before spending (free)
\`\`\`sh
curl --fail-with-body "$OPENGEN_API_URL/v1/quotes" \\
  -H "Authorization: Bearer $OPENGEN_API_KEY" \\
  -H 'Content-Type: application/json' \\
  --data-binary @request.json
\`\`\`

### 4. Submit once with a persisted Idempotency-Key (billable)
\`\`\`sh
curl --fail-with-body "$OPENGEN_API_URL/v1/generations" \\
  -H "Authorization: Bearer $OPENGEN_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -H "Idempotency-Key: $OPENGEN_IDEMPOTENCY_KEY" \\
  --data-binary @request.json
\`\`\`

### 5. Poll compact status & retrieve refreshed private output links
\`\`\`sh
curl --fail-with-body "$OPENGEN_API_URL/v1/generations/$OPENGEN_JOB_ID/status" \\
  -H "Authorization: Bearer $OPENGEN_API_KEY"
curl --fail-with-body "$OPENGEN_API_URL/v1/generations/$OPENGEN_JOB_ID" \\
  -H "Authorization: Bearer $OPENGEN_API_KEY"
\`\`\`

### Recover a lost submit response (read-only)
\`\`\`sh
curl --fail-with-body --get "$OPENGEN_API_URL/v1/generations/lookup" \\
  -H "Authorization: Bearer $OPENGEN_API_KEY" \\
  --data-urlencode "idempotencyKey=$OPENGEN_IDEMPOTENCY_KEY"
\`\`\`

## MCP & CLI

- Remote MCP endpoint: \`${cleanOrigin}/mcp\`
- Shared MCP tool surface: \`catalog_search\`, \`catalog_get\`, \`quote\`, \`call\`, \`job_get\`, \`job_cancel\`, \`balance\`
- Registered operations list: \`GET ${cleanOrigin}/v1/operations\`
- Portable CLI: \`opengen login && opengen doctor\` (defaults to \`https://opengen.dev\`; accepts \`OPENGEN_API_URL\` and \`OPENGEN_API_KEY\`, with legacy \`MEDIA_ROUTER_URL\` / \`MEDIA_ROUTER_TOKEN\` aliases).

## Safety & Evidence Contracts

- Exact model variants and regional deployments are explicit execution choices; never substitute variants or treat an endpoint region as a residency guarantee.
- Unknown prices, latency and success metrics remain unknown (never zero/free/100%).
- Submit once with a persisted \`Idempotency-Key\`, retain the job ID, and resume on timeout. Never blindly resubmit when upstream acceptance is unknown.
- All generations, prompts and outputs are private to the owning workspace.
`;
}

export function CopyDocsMarkdownButton() {
  const origin = usePublicOrigin();
  return (
    <CopyButton
      text={buildDocsMarkdown(origin)}
      label="Copy page as Markdown"
      className="button button-outline"
    />
  );
}
