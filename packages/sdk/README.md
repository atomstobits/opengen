# OpenGen TypeScript client

This private workspace package is part of the source release. It is **not published to npm**. From a checkout, run `npm ci` and use it through the repository's TypeScript runner:

```sh
npm exec -- tsx examples/discover.ts
```

The read-only `doctor()` returns authenticated account, paying workspace, scopes, balance, policy, configuration-only route evidence and the next blocker. It does not establish live provider availability or human authorization to spend; quote the exact request before submission.

The SDK forwards the shared `GenerateInput`, `Quote` and `Job` contracts to the native REST API. Generation arguments live in one `input` object, with common and typed model-specific fields. Routing, billing and budgets remain on the outer request. The SDK re-exports `GenerateInput`, `GenerationArguments`, `AssetRef` and capability types; it forwards the body without renaming or discarding fields. Routing, pricing, authorization and money remain server rules. The browser application uses its HttpOnly session; do not bundle a provider or installation key into browser code.

```ts
import { OpenGen } from '@media-router/sdk';

const client = new OpenGen({
  baseUrl: process.env.MEDIA_ROUTER_URL ?? 'http://127.0.0.1:4310',
  apiKey: process.env.MEDIA_ROUTER_TOKEN,
});
const family = await client.series('minimax', 'h3');
const matches = await client.search('wan 3.0');
const input = {
  modelId: 'bytedance/seedance-2.5',
  operation: 'image-to-video' as const,
  input: {
    prompt: 'A slow cinematic push-in.',
    firstFrame: { assetKey: 'inputs/workspace/source.png' },
    duration: 5,
    resolution: '720p',
    aspectRatio: 'source',
  },
};
const quote = await client.quote(input);
```

Methods: `catalog`, `search`, `models`, `companies`, `company`, `series`, `quote`, `quotes` (batch), `submit`, `doctor`, `lookupJob`, `job`, `wait`, `cancel`, `balance`, `metrics`, `operations` and `call` for the implemented upload/account/event operation allowlist. Prefer `submit(input, { idempotencyKey })` for native generation. The registered `media.generate`, `images.generate` and `videos.create` calls also require an explicit `idempotencyKey` option; every paid admission has the same single-submission behavior. The client and gateway share fixed HTTP operation targets; `operations()` discovers the installation's list. The transport accepts a scoped workspace key or an OpenGen access token through `apiKey`. Browser login and token refresh are separate from this thin client.

## Paid submission and recovery

Persist the exact input and idempotency key **before** calling `submit`. Persist the returned job ID before waiting. The [generation example](../../examples/generate.ts) writes a private local receipt, refuses to replace it with changed input, and resumes the existing job on subsequent runs. It requires an explicit `--execute` flag and maximum managed-credit estimate. It does not provide live-test budget accounting.

- An `OpenGenAPIError` preserves the server's code and structured generation `issues`, when supplied, so callers can identify the rejected argument.
- A `SubmissionUncertainError` retains the original `idempotencyKey`. A disconnect, unreadable generation response or HTTP 5xx/408 does not establish rejection. The SDK never repeats the POST automatically. Recover with `lookupJob(originalKey)` (registered `jobs.lookup`), a tenant-scoped read that never submits generation. A missing job is not proof of rejection: repeat lookup later or ask the operator to reconcile. Never switch keys or automatically repeat a paid POST after an unknown outcome.
- `wait(jobId)` performs status reads only. It returns on media success/failure/cancellation or `submission-unknown`; it never starts another generation. `JobWaitTimeoutError` contains the existing `jobId` and most recent `lastJob`; resume with that ID later. `JobWaitError` similarly retains known job state when a read fails or the caller interrupts.
- Request cancellation or timeout only stops the caller's wait. It does not cancel provider work. `cancel(jobId)` is a separate explicit operation; running tasks can reject cancellation and refunds are not implied.
- Successful media can still have `settledMicros: null`. Inspect delivery and settlement independently. Output URLs expire; retrieve the owned job again for refreshed access.
- `apiKey` accepts a workspace-scoped OpenGen key or an already-issued access token. The SDK does not refresh tokens; the CLI manages its private browser-login session separately. BYOK provider connections belong on the gateway, encrypted at rest. Select `billing: 'byok'` explicitly to use them. Unknown-priced BYOK charges cannot be guaranteed or capped by the gateway.

All methods accept `{ signal }`; `submit` requires `{ idempotencyKey, signal? }`. `wait` also accepts `timeoutMs` (default 15 minutes) and `pollIntervalMs` (default 2 seconds). Individual HTTP requests time out after 15 seconds by default. `fetch` and `requestTimeoutMs` can be supplied when constructing the client. There are no automatic request retries.

## Registered operations

```ts
const upload = await client.call('assets.prepare', {
  mediaType: 'image/png',
  size: image.byteLength,
});
// Upload exact bytes directly to the returned short-lived storage URL. Do not add
// the gateway Authorization header to a storage URL.
const response = await fetch(upload.uploadUrl, {
  method: 'PUT',
  headers: upload.headers,
  body: image,
});
if (!response.ok) throw new Error('Upload failed');
await client.call('assets.complete', { key: upload.key });
// Put {assetKey: upload.key} in the intended role, for example
// input.firstFrame = {assetKey: upload.key}, or in an ordered
// input.references entry {type: 'image', asset: {assetKey: upload.key}}.
// The gateway validates ownership and refreshes access at dispatch.
```

Administrative helpers include `keys.create`, `keys.revoke`, `policies.create`, `connections.put`, `webhooks.create` and the read operations returned by `operations()`. They require the corresponding scopes. Key and webhook-secret creation responses contain a secret **once**: put it into a secret manager and never log the whole response. This client does not retry those creation requests.

Operator helpers (`workspaces.create`, `workspaces.credit`, `operator.inspect`, `operator.reconcile`, `operator.reconciliations`) remain installation-operator only. Do not give an agent that authority by default. Reconciliation requires a stable evidence reference; it never authorizes a replacement paid submission. `ledger.export` returns paginated JSON through this SDK/MCP helper; the native HTTP endpoint also offers CSV. `videos.content` returns a 303 location without following it or forwarding the gateway credential to storage.
