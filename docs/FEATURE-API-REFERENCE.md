# Generation HTTP and MCP feature reference

This reference describes the candidate's source contract, checked by `tests/http-feature-contracts.test.ts`. The executable examples use ordinary HTTP and synthetic prompts; they need no SDK. Fixture execution does not establish hosted availability, configured credentials, successful provider generation, residency or final cost. For account setup and agent/client installation use the [existing onboarding guide](AGENT-SUPPORT.md); for the selected OpenAI-style subset use [compatibility](COMPATIBILITY.md).

All generations, prompts, inputs, outputs, receipts, tags and comparisons belong to the authenticated workspace and its authorized identities/scopes. There is no public generation gallery, publish/share operation or visibility switch. Catalog/company/model metadata remains public.

## Discover the exact contract before spending

Use the configured API origin (`OPENGEN_API_URL`, for example `https://opengen.dev`). The origin identifies an installation; this document does not claim its managed-generation backend is deployed. Send an OpenGen workspace token in `Authorization: Bearer …`; a provider key is never an OpenGen token. Authentication selects the workspace. A caller cannot select a paying workspace or actor by adding body fields.

| HTTP operation                                | MCP `call` operation                                                        | Authorization                                                                    | Result / limits                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/catalog/search?q=…`                  | `catalog.search`, `{q}`                                                     | Public catalog                                                                   | Exact model/company/series/route discovery; no inference                                                                           |
| `GET /v1/models/schema?modelId=…&operation=…` | `models.schema`, `{modelId,operation}`                                      | Public catalog                                                                   | Effective model-operation argument schema, defaults, capabilities, sources and notices; unknown pair: 404                          |
| `GET /v1/routes?modelId=…`                    | `routes.list`, `{modelId}`                                                  | Public catalog                                                                   | Exact regional route records; documented support is separate from configured or live-verified support                              |
| `POST /v1/quotes`                             | `quotes.single`, canonical request                                          | Public for external media; authenticated `read` for owned assets or continuation | Estimate, candidate issues, executable flag, selected route and notices; no reservation or generation                              |
| `POST /v1/quotes/batch`                       | `quotes.batch`, request array                                               | Same quote rules                                                                 | 1–20 independent quote requests; this does not atomically submit a comparison                                                      |
| `POST /v1/assets`                             | `assets.prepare`, `{mediaType,size}`                                        | `generate`                                                                       | Prepare a private upload; integer byte size 1–104857600 (100 MiB); image/video/audio MIME types in [owned inputs](OWNED-ASSETS.md) |
| `POST /v1/assets/complete`                    | `assets.complete`, `{key}`                                                  | `generate`                                                                       | Verify owned upload; preparing a URL is not completing an upload                                                                   |
| `DELETE /v1/assets`                           | `assets.delete`, `{key}`                                                    | `generate`                                                                       | Delete an owned input; lifecycle/pinning changes follow the integrated asset contract                                              |
| `GET /v1/assets?key=…`                        | `assets.get`, `{key}`                                                       | `read`                                                                           | Owned readiness/hash/size facts; no download URL or generation                                                                     |
| `POST /v1/assets/import`                      | `assets.import`, `{url,type}` plus top-level `idempotencyKey`               | `generate`                                                                       | Freeze one bounded public HTTPS image/video/audio; no inference reservation                                                        |
| `POST /v1/assets/reuse`                       | `assets.reuse`, `{sourceJobId,outputIndex}` plus top-level `idempotencyKey` | `generate`                                                                       | Copy retained owned output to a ready input; no inference reservation                                                              |
| `POST /v1/assets/multipart`                   | `assets.multipart.prepare`, `{mediaType,size}`                              | `generate`                                                                       | Prepare at most 20 parts under the same 100 MiB cap; [part/complete/resume/abort](OWNED-ASSETS.md#multipart)                       |
| `POST /v1/generations`                        | `media.generate`, canonical request plus top-level `idempotencyKey`         | `generate`                                                                       | Billable admission; HTTP 202 returns a durable gateway job; HTTP requires `Idempotency-Key`                                        |
| `GET /v1/generations/lookup?idempotencyKey=…` | `jobs.lookup`, `{idempotencyKey}`                                           | `read`                                                                           | Read-only lost-submit recovery; 404 is not proof of rejection                                                                      |
| `GET /v1/generations/{id}/status`             | `jobs.status`, `{id,afterRevision?,waitMs?}`                                | `read`                                                                           | Compact private `{job,changed,timedOut}`; integer wait 0–25000 ms, default immediate                                               |
| `GET /v1/generations/{id}`                    | `jobs.get`, `{id}`; or `job_get` tool                                       | `read`                                                                           | Existing private job; missing/foreign ID: 404 on `jobs.get`; no generation                                                         |
| `POST /v1/generations/{id}/cancel`            | `jobs.cancel`, `{id}`; or `job_cancel` tool                                 | `generate`                                                                       | Cancellation request/result; no promise of upstream cancellation or refund                                                         |
| `GET /v1/balance`                             | `balance.get`, `{}`; or `balance` tool                                      | `read`                                                                           | Workspace balance and reserved funds                                                                                               |

`GET /v1/operations` is the current explicit allowlist; `/openapi.json` is the protocol reference. MCP never accepts an arbitrary method/origin/header/URL as an operation target. Complete setup/OAuth/client steps remain in the onboarding documentation. A generate-only token may submit but needs a separately authorized `read` scope to resume private jobs or quote owned assets.

## Canonical request fields

The envelope is strict. Generation arguments live in `input`; broker controls live beside it. Unknown fields and unsupported combinations fail before inference. A generic schema ceiling is not a model or route promise: query the exact model-operation schema and inspect route-specific quote issues.

| Envelope field           | Required / default                              | Meaning / limit                                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelId`                | Required                                        | Exact variant ID; 1–160 characters. `minimax/h3-max` is shared by the confirmed MiniMax/fal Max offerings; Max Turbo and H3 Flex remain different variants.                                                                           |
| `operation`              | Required                                        | `text-to-image`, `image-edit`, `text-to-video`, `image-to-video`, `reference-to-video`, `video-edit` or `video-extend`, only if registered for this exact model                                                                       |
| `input`                  | Required object                                 | Common plus model-specific arguments accepted by that pair; no arbitrary provider-options bag                                                                                                                                         |
| `billing`                | Optional; managed behavior when omitted         | `managed` debits OpenGen credit; `byok` uses a workspace provider connection and external provider billing                                                                                                                            |
| `routeId`                | Optional; 1–200 characters                      | Pin one exact regional route. It must serve the exact variant and every requested argument.                                                                                                                                           |
| `routing`                | Optional                                        | Narrow providers, deployments, endpoint regions, processing regions, fidelity, cost/speed/reliability preference and explicit fallback. Key/workspace policy still applies; endpoint location does not establish inference residency. |
| `maxCostMicros`          | Optional integer ≥0, ≤`Number.MAX_SAFE_INTEGER` | Micro-USD customer spending control; 1 USD = 1,000,000 micro-USD. It is not a quote, provider invoice or external BYOK billing guarantee.                                                                                             |
| `metadata`               | Optional strict object                          | Private `project` (1–80 characters) and up to 16 `tags`. Tag keys match `[A-Za-z][A-Za-z0-9_.-]{0,63}`, values are 1–160 characters. Immutable under the same idempotency key; never actor authority.                                 |
| `queueStartDeadlineAt`   | Optional ISO datetime                           | Local queue-start deadline before provider submission; never cancels already accepted upstream work or limits a client wait.                                                                                                          |
| `previousJobId`          | Optional UUID                                   | Owned continuation; executor verifies model, original deployment and ownership. It is not a raw provider task ID.                                                                                                                     |
| `Idempotency-Key` header | Required for HTTP submit; 1–200 characters      | Persist with the exact request before submission. Same workspace/key/request recovers the original job; a changed request conflicts. In MCP it is `call.arguments.idempotencyKey`, outside `input`.                                   |

Actor identities and internal connection IDs are server-owned. Authentication supplies attribution; callers may supply only the validated private metadata above. Metadata is outside `input` and is not forwarded upstream as an arbitrary option.

## Operation arguments, defaults and limits

The schema response contains `commonArguments`, `modelSpecificArguments`, `promptRequired`, `defaults`, `capabilities`, `notices`, `sources` and `inputSchema`. `inputSchema` describes the argument object, not the outer request. Defaults are applied by the canonical parser and shared across providers of the same exact variant. Runtime validation additionally checks combinations and exact regional constraints.

| Operation                    | Required media / prompt                             | Canonical defaults when supported                                            | Notes                                                                                                                          |
| ---------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `text-to-image`              | Nonempty `prompt`; no source media                  | Model resolution; `aspectRatio: "1:1"`; GPT Image quality `medium`           | `count`, quality, size, format, compression, seed and negative prompt are accepted only when present in that exact schema.     |
| `image-edit`                 | Nonempty `prompt` and nonempty ordered `references` | Model resolution; GPT Image quality `medium`; **no inherited ratio default** | Preserve reference roles/order. Masks/transparency/model controls have model-specific semantics; no universal mask conversion. |
| `text-to-video`              | Nonempty `prompt`; no source media                  | Model resolution; `duration: 5` seconds; `aspectRatio: "16:9"`               | Duration/audio support and permitted resolution/ratio remain model/route constraints.                                          |
| `image-to-video`             | Required qualified frame/keyframe combination       | Model resolution; 5 seconds; `source` ratio where qualified                  | A prompt is not universally required. Gemini Omni uses its qualified `16:9` default. A last frame may require a first frame.   |
| `reference-to-video`         | Nonempty supported references or elements           | Model resolution; 5 seconds; `16:9`                                          | Frame/reference mixing and combined reference limits differ by exact variant.                                                  |
| `video-edit`, `video-extend` | `sourceVideo` or owned outer `previousJobId`        | Model resolution; 5 seconds; source ratio where qualified                    | Continuation is deployment-bound. Prompt/source/ratio rules remain operation-specific.                                         |

| Argument / category                                                                                   | Units / generic broker bounds                                                           | Exact-contract behavior                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`, `negativePrompt` / common                                                                   | Strings; generic ceilings 100,000 / 20,000 characters                                   | Prompt may have a smaller model maximum. Whitespace is not a required prompt. Negative prompt is not universal.                                                     |
| `firstFrame`, `lastFrame`, `sourceVideo`, `mask` / common media                                       | One `{assetKey}` **or** one `{url}` each                                                | Asset key is private and workspace-owned. External URL must be HTTPS without embedded credentials and is subject to safe bounded retrieval. Preserve semantic role. |
| `references` / common media                                                                           | Ordered `{type,asset}` list; generic maximum 50                                         | Supported types and per-type/combined counts come from `capabilities.references`; a missing documented ceiling is unknown, not unlimited.                           |
| `duration` / common video                                                                             | Seconds; positive number or qualified `"auto"`; generic maximum 300                     | Model minimum/maximum, integer/grid rules and route restrictions narrow this. `auto` is not a priced fixed duration.                                                |
| `resolution`, `aspectRatio` / common                                                                  | Model tier names such as `1K` or `720p`; qualified ratio string                         | `source` needs source media/continuation. No cropping, duration change or reference dropping is implied.                                                            |
| `size` / common image                                                                                 | `{width,height}` in pixels; generic edge maximum 16,384                                 | Exact size suppresses ratio/resolution defaults; cannot combine with explicit resolution or ratio. Model area/edge/grid limits still apply.                         |
| `count` / common                                                                                      | Integer 1–15 generic ceiling                                                            | Model/route may allow less. Compatibility currently selects one output.                                                                                             |
| `quality`, `outputFormat`, `outputCompression`, `background` / common or model-specific               | Model quality vocabulary; png/jpeg/webp/mp4; compression 0–100; auto/opaque/transparent | Only accepted for qualified model/operation combinations. Transparency/output-codec constraints are checked.                                                        |
| `seed`, `audio` / common                                                                              | Integer −1 through max safe integer; boolean                                            | Unsupported seeds/audio modes are rejected. Same seed across models does not establish equal randomness.                                                            |
| `thinkingLevel`, `grounding`, `layers`, `shots`, `elements`, `keyframes`, other model-specific fields | Inspect exact schema                                                                    | Keep the schema's names, counts/defaults/units; no inferred sibling-model support.                                                                                  |

For primary source and region evidence, inspect each profile's `sources` and each route's deployment, capability, pricing and verification records. The source inventory is in [canonical inputs](research/canonical-inputs/README.md), with [image](research/canonical-inputs/image-models.md), [Seedance/Kling/Wan](research/canonical-inputs/video-seedance-kling-wan.md) and [H3/Omni/Grok](research/canonical-inputs/video-h3-omni-grok.md) evidence. Do not treat an old audit snapshot as current account entitlement or runtime qualification.

## Private owned input → quote → submit → resume

Use a real uploaded file and replace the synthetic input key. Upload transport does not spend inference credit. The example does not create an asset from a raw output object key. Output reuse/import and multipart lifecycle are registered in this source candidate; see [owned inputs](OWNED-ASSETS.md). Inspect `/v1/operations` on your installation before using them. Import/reuse require an HTTP `Idempotency-Key` or MCP top-level `idempotencyKey`, although they do not spend inference credit.

```sh
# OPENGEN_API_URL is the configured installation; the public product origin is https://opengen.dev.
# OPENGEN_TOKEN is an OpenGen workspace token with read + generate.
curl --fail-with-body "$OPENGEN_API_URL/v1/assets" \
  -H "Authorization: Bearer $OPENGEN_TOKEN" -H 'Content-Type: application/json' \
  --data '{"mediaType":"image/png","size":1024}'
```

Use the **actual** byte length, media type and response's `key`, `uploadUrl`, required `headers` and expiry. PUT the exact file to `uploadUrl`, using only its required storage headers. Do not send the OpenGen bearer token, cookies or provider keys to storage. Then complete the owned upload:

```sh
curl --fail-with-body "$OPENGEN_API_URL/v1/assets/complete" \
  -H "Authorization: Bearer $OPENGEN_TOKEN" -H 'Content-Type: application/json' \
  --data '{"key":"inputs/WORKSPACE/UPLOAD_UUID.png"}'
```

Write a request file so prompt punctuation is not interpreted by a shell. This is the canonical image-to-video example, validated against the actual parser and handlers:

```json
{
  "modelId": "kling/kling-4.0",
  "operation": "image-to-video",
  "input": {
    "prompt": "A slow push-in toward the paper lighthouse.",
    "firstFrame": { "assetKey": "inputs/fixture/00000000-0000-4000-8000-000000000001.png" },
    "duration": 5,
    "resolution": "720p",
    "aspectRatio": "source"
  },
  "billing": "managed",
  "maxCostMicros": 1000000
}
```

Save the replaced body as `request.json`. Inspect its schema and regional route evidence, then quote it:

```sh
curl --fail-with-body "$OPENGEN_API_URL/v1/models/schema?modelId=kling%2Fkling-4.0&operation=image-to-video"
curl --fail-with-body "$OPENGEN_API_URL/v1/routes?modelId=kling%2Fkling-4.0"
curl --fail-with-body "$OPENGEN_API_URL/v1/quotes" \
  -H "Authorization: Bearer $OPENGEN_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @request.json
```

A quote includes `estimateOnly: true`, `selectedRouteId`, `candidates[]` with `executable`, `estimatedCostMicros` (possibly null), structured `issues`, `reason`, `source` and `notices`. No executable candidate means stop and resolve input, configuration, price or policy. The example uses exact Kling 4.0 because the baseline Seedance 2.5 routes have no qualified managed tariff. Reference-based editing currently has incomplete input pricing; the managed example deliberately stops when its quote is comparison-only. BYOK may allow unknown externally billed charges without a cap; it must not be described as a bounded managed call.

After authorization to spend, persist a new stable `OPENGEN_IDEMPOTENCY_KEY` with this body, then submit **once**:

```sh
curl --fail-with-body "$OPENGEN_API_URL/v1/generations" \
  -H "Authorization: Bearer $OPENGEN_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $OPENGEN_IDEMPOTENCY_KEY" --data-binary @request.json
```

HTTP 202 admits the existing job; it does not mean inference or delivery completed. A minimal synthetic queued response is:

```json
{
  "id": "00000000-0000-4000-8000-000000000002",
  "workspaceId": "fixture",
  "status": "queued",
  "input": {
    "modelId": "kling/kling-4.0",
    "operation": "image-to-video",
    "input": {
      "prompt": "A slow push-in toward the paper lighthouse.",
      "firstFrame": { "assetKey": "inputs/fixture/00000000-0000-4000-8000-000000000001.png" },
      "duration": 5,
      "resolution": "720p",
      "aspectRatio": "source"
    },
    "billing": "managed",
    "maxCostMicros": 1000000
  },
  "routeId": "fixture/route",
  "deploymentId": "fixture/region",
  "upstreamId": null,
  "outputs": [],
  "error": null,
  "createdAt": "2026-11-04T00:00:00.000Z",
  "updatedAt": "2026-11-04T00:00:00.000Z",
  "reservedMicros": 100,
  "settledMicros": null,
  "attemptCount": 1
}
```

This is a synthetic accepted response, not a live generation receipt. Persist `id` as soon as it arrives. Wait by polling `GET /v1/generations/{id}` with `read` authorization and bounded backoff, or use compact status below. Closing the connection or reaching a client wait timeout only ends waiting. `upstreamId: null` carries no provider task identity; internal upstream IDs and recovery receipts are not customer retrieval inputs.

```sh
curl --fail-with-body "$OPENGEN_API_URL/v1/generations/$OPENGEN_JOB_ID" \
  -H "Authorization: Bearer $OPENGEN_TOKEN"
```

If the POST response is lost before you save an ID, use the original key in a read-only lookup. URL-encode it with `--data-urlencode`; keep query logs private. A `404 submission_not_found` means no job is visible yet, not that acceptance or a charge is impossible. Repeat the same lookup or ask the operator to reconcile; do not mint a replacement key.

```sh
curl --fail-with-body --get "$OPENGEN_API_URL/v1/generations/lookup" \
  -H "Authorization: Bearer $OPENGEN_TOKEN" \
  --data-urlencode "idempotencyKey=$OPENGEN_IDEMPOTENCY_KEY"
```

For a compact read, call `GET /v1/generations/{id}/status`. It returns `{job,changed,timedOut}` without prompts, media URLs or private receipts. Omit `afterRevision` for an immediate snapshot. To wait, pass the last `job.revision` (64 lowercase hexadecimal characters) and `waitMs` (integer 0–25000 milliseconds). Revisions are equality tokens, not ordered sequence numbers. A timed-out wait is read-only; the job and held funds remain unchanged. Use full `jobs.get` when you need fresh owned output capabilities. See [compact status](EXECUTION-STATUS.md).

Read only owned outputs authorized by this job. Signed capabilities expire; GET the same job to request a fresh capability when retained bytes remain available. Retention expiry/deletion is different from signed-URL expiry. Issued capabilities are bearer links: do not put them in public pages, logs, analytics, prompts or social previews. Private OpenGen access does not establish provider zero retention or guarantee instant revocation of an issued URL.

## Copyable fetch and executable fixture-backed examples

`examples/http-feature-contracts.mjs` generates text-image, image-video and edit requests from the same examples used by the tests. Its default command prints a request plan and makes **no HTTP calls**:

```sh
node examples/http-feature-contracts.mjs image-to-video
```

Set `OPENGEN_API_URL`, `OPENGEN_TOKEN`, and a ready owned `OPENGEN_ASSET_KEY` for source-media examples. `--inspect` only discovers/schema-inspects/quotes. `--submit` additionally requires a persisted `OPENGEN_IDEMPOTENCY_KEY`; `OPENGEN_CAP_MICROS` defaults to 1000000 micro-USD in the synthetic example. This is a real spending command on a configured installation. It makes one submit attempt, immediately prints a safe accepted receipt (`jobId`, original `idempotencyKey` and `resumePath`), then performs one same-job read. Save stdout privately if using the command for recovery. Transport/read failures never initiate another paid job; post-admission errors retain the job ID/key and print a same-job resume command. A lost POST response retains the original key and instructs recovery of the original request, without inventing a job ID.

```sh
node examples/http-feature-contracts.mjs image-to-video --inspect
# Lost POST response: retain OPENGEN_IDEMPOTENCY_KEY and read only
node examples/http-feature-contracts.mjs --lookup
# Explicitly billable, after inspecting the quote and approving this request:
node examples/http-feature-contracts.mjs image-to-video --submit
# Read-only recovery of an already admitted job:
node examples/http-feature-contracts.mjs --resume "$OPENGEN_JOB_ID"
```

The core fetch pattern is ordinary HTTP:

```js
import {
  featureRequest,
  httpClient,
  runFeatureExample,
} from './examples/http-feature-contracts.mjs';
const send = httpClient({ apiUrl: process.env.OPENGEN_API_URL, token: process.env.OPENGEN_TOKEN });
const request = featureRequest('image-to-video', { assetKey: process.env.OPENGEN_ASSET_KEY });
const inspected = await runFeatureExample({ request, send }); // no inference
// After approving spending and durably saving the request + key:
const result = await runFeatureExample({
  request,
  send,
  submit: true,
  idempotencyKey: process.env.OPENGEN_IDEMPOTENCY_KEY,
  // Persist privately; this callback is awaited before the first same-job read.
  onAccepted: async (receipt) => persistPrivateReceipt(receipt),
});
```

`persistPrivateReceipt` is your application's durable receipt write, not another OpenGen operation. It receives only the accepted identity, original key and same-job path. The example awaits this callback before reading. If persistence or the first read fails, the thrown error retains `jobId`, `idempotencyKey` and `resumePath`; preserve that identity and recover the existing job. Do not catch the error by generating a new key. Persist the original request/key before the initial POST so even a lost acceptance response remains recoverable.

## MCP request bodies and parity

POST JSON-RPC to `/mcp` using the configured OpenGen token or authorized workspace OAuth grant. Include `Content-Type: application/json` and `Accept: application/json, text/event-stream`. A standard MCP client initializes first; the existing onboarding guide owns client setup. Raw initialization body:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": { "name": "private-http-example", "version": "1" }
  }
}
```

Inspect the same argument contract through the allowlisted `call` tool:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "call",
    "arguments": {
      "operationId": "models.schema",
      "input": { "modelId": "kling/kling-4.0", "operation": "image-to-video" }
    }
  }
}
```

Use `quotes.single` with the complete request above as `arguments.input`. Billable submission uses `media.generate` with **the identical request** and a separate stable key:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "call",
    "arguments": {
      "operationId": "media.generate",
      "idempotencyKey": "PERSISTED_REQUEST_KEY",
      "input": {
        "modelId": "kling/kling-4.0",
        "operation": "image-to-video",
        "input": {
          "prompt": "A slow push-in toward the paper lighthouse.",
          "firstFrame": { "assetKey": "inputs/fixture/00000000-0000-4000-8000-000000000001.png" },
          "duration": 5,
          "resolution": "720p",
          "aspectRatio": "source"
        },
        "billing": "managed",
        "maxCostMicros": 1000000
      }
    }
  }
}
```

Recover through `jobs.get` (or `job_get`), never another `media.generate` with a new key:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "call",
    "arguments": {
      "operationId": "jobs.get",
      "input": { "id": "00000000-0000-4000-8000-000000000002" }
    }
  }
}
```

Compact status uses the same allowlisted `call` shape. This request reads immediately; add the returned `job.revision` as `afterRevision` with `waitMs: 25000` for a bounded wait. For lost-submit recovery use `jobs.lookup` with `{ "idempotencyKey": "PERSISTED_REQUEST_KEY" }` in `arguments.input` (no new submit key).

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "call",
    "arguments": {
      "operationId": "jobs.status",
      "input": { "id": "00000000-0000-4000-8000-000000000002", "waitMs": 0 }
    }
  }
}
```

`call` wraps the same HTTP handler result in `result.content[0].text` as JSON; HTTP errors set `result.isError: true`. JSON-RPC/tool-schema validation errors have MCP's own envelope. A compatibility content redirect is structured `{statusCode:303,location}` in MCP; it is not fetched, and credentials are not forwarded. Native `jobs.get` gives explicit HTTP not-found semantics through this shared handler.

## Generation, delivery, money and retry decisions

Generation `status` is `queued`, `submitting`, `running`, `submission-unknown`, `succeeded`, `failed` or `cancelled`. A generation can succeed upstream while private delivery fails. `reservedMicros` is held exposure, `settledMicros: null` is unknown/unsettled, and zero is only a known zero. Never infer refundability from cancellation or delivery failure. Missing progress is unknown, not zero percent.

Delivery states are `pending`, `available`, `partial`, `failed`, `expired` and legacy `unverified`. Only an available authorized owned capability is usable media. Raw provider URLs, inline provider payloads, storage keys, credentials and recovery receipts are internal. Do not treat upstream success, an empty output list or legacy unverified delivery as completed media.

| Observation                                        | Safe next action                                                                                                              | Paid resubmission?                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Invalid field/model/route or quote issue           | Correct the field/limit and obtain a fresh quote before admitting a new request                                               | Only after an explicit corrected request is authorized                                           |
| HTTP 202 / queued / submitting / running           | Persist ID and resume GET / `jobs.get` with bounded backoff                                                                   | No                                                                                               |
| Submit connection timeout or lost response         | Keep original body/key; use read-only `jobs.lookup`; a missing result does not prove rejection                                | Never replace with a fresh key automatically                                                     |
| `submission-unknown`                               | Read `jobs.status` / `jobs.get`; `submission_unknown` requires operator reconciliation; acceptance and cost stay unknown/held | No blind retry                                                                                   |
| Upstream success + pending/partial/failed delivery | Read the same job while bounded worker delivery retries run; terminal failed/expired delivery needs operator help             | No; delivery retry archives missing outputs of the same attempt and must not submit/settle again |
| Read timeout / 429 / temporary 5xx                 | Retry that read with bounded backoff (`Retry-After` where supplied)                                                           | No                                                                                               |
| Expired capability URL                             | Authenticated GET same job for a fresh owned capability if retained                                                           | No                                                                                               |
| Retention expiry/deletion                          | Report unavailable retained media honestly; replay cannot regenerate deleted bytes                                            | No automatic generation                                                                          |
| Cancellation requested                             | Continue reading the accepted job and ledger; late success/billing may still arrive                                           | No inferred refund or replacement                                                                |
| Confirmed failure                                  | Inspect safe error/receipt and funding state; any replacement is a separate authorized request                                | Never implicit                                                                                   |

There is no customer delivery-retry endpoint/tool in this candidate. The worker retries eligible missing outputs from the original attempt; it never regenerates or settles again. `structuredError` is nullable and contains `code`, `category` (`invalid_input|policy|technical|unknown`), safe `message`, `retryable`, `recovery`, and optional `field`/`providerCode`. Legacy error text does not supply structured evidence. A retryable error authorizes same-job observation/recovery only.

| `structuredError.recovery` | Field-level action                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `same_job`                 | Keep ID/key and read the same job. For `capacity_full` wait for capacity; `input_preparation_unavailable` needs original-input restoration; `delivery_unavailable` waits for bounded worker recovery. |
| `edit_request`             | Inspect `field` and schema/quote issues, correct the request and quote again. A new billable request requires explicit approval and a new key; it does not edit the old job.                          |
| `operator`                 | Keep the job/held exposure. `submission_unknown`, `credentials_unavailable`, `delivery_failed` and `delivery_expired` need operator reconciliation; never substitute provider accounts or regenerate. |
| `none`                     | No automatic recovery. `start_deadline_exceeded` is a local pre-submit expiry; inspect the existing job/ledger before intentionally authorizing any new work.                                         |

HTTP errors use an `error` envelope. For canonical validation the response includes field-addressed issues, for example:

```json
{
  "error": {
    "code": "invalid_generation",
    "message": "input.duration: Duration is outside this model capability.",
    "issues": [
      {
        "code": "unsupported_duration",
        "field": "input.duration",
        "message": "Duration is outside this model capability.",
        "limit": "3–30",
        "received": 50
      }
    ]
  }
}
```

The precise limit/message comes from the selected model. Schema-invalid fields can use `invalid_value`; protocol/Zod mismatch uses `invalid_input`. Authentication is 401, insufficient scope/policy is 403, foreign/missing media/job is 404, changed idempotency request is 409, insufficient managed balance/budget is 402, no executable route is 422, backpressure may be 429, and missing service configuration is 503. Error code/category/field is the decision input; raw provider bodies/logs are never a customer recovery interface. Tests cover the concrete handlers; final combined admission, ledger, native PostgreSQL, storage and hosted-client proof remain separate qualification gates.
