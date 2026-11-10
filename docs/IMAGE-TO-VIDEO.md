# Image to video with an owned reference

Reviewed 2026-11-06. This guide describes the canonical API and CLI workflow with a private reference image. Use your configured OpenGen origin and inspect the exact model, executable route and quote before submitting. See [agent setup and support evidence](https://opengen.dev/agents) for dated client and deployment status.

## 1. Connect and diagnose

Install the reviewed, versioned OpenGen package using the checkout-free instructions at `/skill.md`. A hosted assistant uses its already connected MCP tools or adds `/mcp` and completes native OAuth; it does not install a CLI in its sandbox. A local CLI uses:

```sh
export MEDIA_ROUTER_URL=https://opengen.dev
opengen login
opengen doctor
```

Choose the paying workspace during browser consent. Diagnosis distinguishes configured credentials, successful authentication, granted scopes, balance/holds and configured routes. A configured route is not live-provider qualification and does not guarantee that this image request is executable. `read` allows discovery, quote and retrieval; upload/submission requires `generate`. Sign-in grants no credit. If no route is executable, stop and resolve the reported blocker.

## 2. Inspect the exact model and route

```sh
opengen catalog search --operation image-to-video --input-role firstFrame --modality video
opengen catalog get bytedance/seedance-2.5
opengen call models.schema --input - <<'JSON'
{"modelId":"bytedance/seedance-2.5","operation":"image-to-video"}
JSON
```

Read the effective common/model schema, required roles, resolution/duration/aspect-ratio enums, reference counts and route-specific limits. Use its schema-derived example as the starting point; replace placeholders before quoting. This walkthrough uses one first frame, five seconds and 720p. Select a route that supports all three; do not infer support for another model or region. Endpoint region is distinct from inference scope and residency.

The upload service accepts PNG/JPEG/WebP images, MP4/WebM video and supported MPEG/WAV/Ogg/FLAC/MP4/WebM audio up to 100 MiB. Individual models/routes may impose stricter roles, bytes, geometry or duration limits; upload acceptance does not establish model support. Completion freezes actual bytes and records type, size and SHA-256 with bounded container checks; it does not establish full decoded conformance. Require the returned `state: "ready"` before using its owned key. Prepare a valid image you own or have permission to use and inspect it locally. Do not upload credentials, private logs or unrelated files.

## 3. Upload privately and complete ownership checks

```sh
opengen upload /absolute/path/owned-reference.png --media-type image/png
```

The CLI performs `assets.prepare` → PUT exact bytes to the returned signed storage URL with its supplied headers → `assets.complete`. It verifies the completed asset and returns its workspace-owned `asset.assetKey`. Preparation expires after ten minutes; prepare a fresh upload if that plan expired. Uploading does not create a generation or reserve credits. The workspace prefix is enforced; another workspace’s key is rejected.

Equivalent MCP/API operations:

```json
{ "operationId": "assets.prepare", "input": { "mediaType": "image/png", "size": 12345 } }
```

Use the real file size, PUT only to the returned `uploadUrl`, then complete:

```json
{ "operationId": "assets.complete", "input": { "key": "KEY_RETURNED_BY_PREPARE" } }
```

A hosted client that cannot PUT local bytes should ask the user to upload in the browser Playground. Do not put a local filesystem path in `assetKey`, publish the reference to a public host, or send the signed URL to a URL proxy. Use the returned owned storage key rather than a temporary input GET URL.

## 4. Build and quote the canonical request

Save this as `request.json`, replacing the owned key and selecting an exact inspected route. Choose the exact documented regional route returned by inspection; it is executable only when the configured deployment and this request qualify.

```json
{
  "modelId": "bytedance/seedance-2.5",
  "operation": "image-to-video",
  "input": {
    "prompt": "A slow camera push toward the subject, keeping the original composition.",
    "firstFrame": { "assetKey": "inputs/YOUR_WORKSPACE/RETURNED_UUID.png" },
    "duration": 5,
    "resolution": "720p",
    "aspectRatio": "source"
  },
  "routeId": "REPLACE_WITH_EXACT_INSPECTED_ROUTE_ID",
  "billing": "managed",
  "maxCostMicros": 1000000
}
```

The one-dollar request cap above is an illustrative customer ceiling, not a quote or permission to spend it. Set an explicit budget suitable for the actual quote. Use `billing: "byok"` only after selecting the workspace’s provider connection and confirming that provider-account payer separately. A managed quote does not authorize BYOK charges or vice versa.

```sh
opengen quote --input request.json
```

Inspect `executable`, route/deployment, pricing units, maximum customer charge, notices/exclusions and balance. A public estimate with no executable route is comparison-only. Change incompatible options deliberately and quote again; do not silently drop the reference, switch variants or relax region/payer policy. Obtain explicit user authorization for the exact request, payer and bounded charge before submission.

## 5. Submit once and keep the receipt

Persist the canonical request and one idempotency key in a private directory before calling. Reuse the same key only for this identical request. The installed CLI requires you to preserve the request, key and returned job ID. Save stdout in a private file with a restrictive umask (it can include signed output URLs). The source-only `examples/generate.ts` helper additionally automates private receipt persistence; it is separate from the installed CLI:

```sh
umask 077
opengen generate --input request.json --idempotency-key ORIGINAL_UNIQUE_KEY > /absolute/private/render-result.json
```

MCP uses the same request:

```json
{
  "operationId": "media.generate",
  "input": {
    "modelId": "bytedance/seedance-2.5",
    "operation": "image-to-video",
    "input": {
      "prompt": "A slow camera push toward the subject.",
      "firstFrame": { "assetKey": "OWNED_KEY" },
      "duration": 5,
      "resolution": "720p",
      "aspectRatio": "source"
    },
    "billing": "managed",
    "maxCostMicros": 1000000
  },
  "idempotencyKey": "ORIGINAL_UNIQUE_KEY"
}
```

Supply the same inspected routing constraints in the actual MCP request. Save its returned job ID before waiting. A timeout or lost response can mean the paid job was accepted. Never create a new key or submit a replacement merely because the local wait expired.

## 6. Wait, recover and retrieve

```sh
opengen job wait EXISTING_JOB_ID --timeout-ms 900000
opengen job resume EXISTING_JOB_ID --timeout-ms 900000
```

These commands read the existing job. In MCP, use `call` with `jobs.status` and the original job ID. For a bounded wait, send the latest `job.revision` as `afterRevision` and set `waitMs` to at most 25000. If the host times out while work is pending, give the user the last known status and job ID. Continue with another read of that ID.

When delivery is `available` or `partial`, use `job_get` on the same job to surface the private result card in an MCP Apps host. In other hosts, present an **Open video** or **Download** link from the returned output in the authorized chat. Show which files are ready if delivery is partial. Generation success, usable delivery and billing settlement are separate observations. `submission-unknown` requires reconciliation of the accepted attempt. Keep the reservation and contact the installation operator with the job ID.

If submission returned no job ID, retain the receipt and original key. Use MCP `call` with `jobs.lookup` and the original `idempotencyKey`, or use the CLI lookup:

```sh
opengen job recover --idempotency-key ORIGINAL_UNIQUE_KEY
```

A not-yet-found response does not prove that a concurrent submission was rejected. Keep recovery read-only and inspect the original job/receipt rather than resubmitting. A changed request under the old key is an idempotency conflict.

For delivered outputs, retrieve the existing job immediately before downloading:

```sh
opengen job get EXISTING_JOB_ID
```

Use each output’s current `url`, `expiresAt` and `mediaType`. Signed retrieval URLs expire after roughly fifteen minutes; fetch the job again to receive fresh URLs while the private object is retained. URL refresh does not recreate deleted or retention-expired objects. Download privately, check that the file decodes and matches the expected duration/geometry, and keep delivery errors distinct from upstream generation status. Never expose signed input/output URLs in public feedback, commits or agent configuration. Record actual settled cost separately from the original estimate; an unknown charge is not zero.

## Review evidence

Local fixtures cover schema validity, owned-upload API contracts, quotes, admission, receipts, read-only recovery and expiring output URL refresh with synthetic data. Live support is established separately for each exact model, route and request configuration. The Seedance 2.5 request above is a worked template. Review the dated [client support evidence](https://opengen.dev/agents#support-matrix) and the selected model’s provider evidence before authorizing a real request.
