# Raw HTTP and MCP examples

Actual users need only curl or Node’s built-in fetch and the configured API origin, not this source checkout or an SDK. Start with the [feature API reference](../docs/FEATURE-API-REFERENCE.md) for copyable upload → schema → quote → stable submit → status/lookup → private retrieval requests and the [compatibility matrix](../docs/COMPATIBILITY.md) for owned edits, base64 and video Range limits. Use an OpenGen workspace token with `read` + `generate`; provider keys remain on the server. Keep requests, receipts and signed output links private.

The standalone `http-feature-contracts.mjs` can be copied to a private directory and run with Node, without installing dependencies. Its default command prints a synthetic plan and makes no requests. Set `OPENGEN_API_URL` explicitly for your installation; `--inspect` reads schema/routes and quotes only. `--submit` is a real billable command requiring an approved cap, `OPENGEN_TOKEN`, a ready input for media examples, and a persisted `OPENGEN_IDEMPOTENCY_KEY`. It prints the accepted ID before the first read and never automatically repeats a paid submission.

```sh
node http-feature-contracts.mjs text-to-image
node http-feature-contracts.mjs text-to-image --inspect
# After an explicitly authorized submission, resume by its saved gateway ID:
node http-feature-contracts.mjs --resume "$OPENGEN_JOB_ID"
# If the POST response was lost, retain the original key and perform read-only lookup:
node http-feature-contracts.mjs --lookup
```

`submission_not_found` does not establish rejection or release held exposure. Repeat lookup or ask the operator to reconcile. A new key is a separate billable request. Pending output recovery uses the same provider attempt; no customer delivery-retry operation is registered. Expired capabilities may be refreshed through the same owned job while bytes remain retained. Retention expiry/deletion cannot be repaired by replaying a generation.

## Internal source examples

The older TypeScript examples below maintain internal client compatibility. They are not a published SDK distribution path. Run them from a source checkout after `npm ci`, with the API running.

`MEDIA_ROUTER_URL` is your gateway, defaulting to `http://127.0.0.1:4310`. Configure `MEDIA_ROUTER_TOKEN` through an ignored local environment file or secret manager; use a workspace key with `read` and `generate` scopes for generation. Do not use a shared installation token in a public application, commit the key, or paste it into chat.

Read-only examples:

```sh
npm exec -- tsx examples/discover.ts "wan 3.0"
npm exec -- tsx examples/mcp-discover.ts
```

For a real generation, create a private JSON file containing an exact `GenerateInput` selected from your own catalog. This example is a possible configuration, not evidence that the route is live-tested or executable on your installation:

```json
{
  "modelId": "alibaba/wan-3.0",
  "operation": "text-to-video",
  "input": {
    "prompt": "A quiet sea under soft morning light.",
    "resolution": "480p",
    "duration": 5
  },
  "routeId": "alibaba/ap-southeast-1/wan-3.0",
  "routing": { "endpointRegions": ["ap-southeast-1"] }
}
```

Generation arguments belong inside `input`; routing, billing and cost controls remain outside it. For media inputs, put `{"assetKey": "inputs/workspace/source.png"}` or `{"url": "https://media.example.com/source.png"}` in the intended role, such as `input.firstFrame`. Use `input.references` for an ordered array of `{type, asset}` reference entries. Inspect the exact model/operation schema because supported roles, limits and advanced arguments vary.

Quote first, inspect the result, then explicitly execute using the **same** private receipt:

```sh
npm exec -- tsx examples/generate.ts --input /absolute/private/request.json --max-cost-micros 1000000
npm exec -- tsx examples/generate.ts --execute
```

The default receipt is `.local/examples/generation.json` (ignored by Git, mode `0600`). It contains the private prompt/input, stable idempotency key and returned job ID; it never contains the API/provider key. Preserve it until the operation is reconciled. `--receipt /absolute/private/job.json` selects a different location. The example refuses a changed input or gateway under the same receipt. New work requires a new receipt after any existing unknown outcome has been resolved.

Submitting may spend real provider money. The cap bounds the gateway's accepted estimate/reservation for managed billing; it is not proof of the provider's final charge. The example excludes BYOK because unknown provider charges cannot be enforced by the gateway. It is not the release team's cumulative live-test budget runner.

Once the receipt contains a job ID, rerunning the command reads/waits for that job. Before sending, the example marks its receipt as attempted. A network timeout before the ID is saved retains the same input/key; rerunning performs read-only `jobs.lookup` and never repeats the POST, even with `--execute`. Older receipts without attempt state also use lookup only. A missing lookup is not proof of rejection: repeat the read later or ask the operator to reconcile. The example never automatically resubmits, falls back or cancels. Review `status`, `deliveryStatus` and `settledMicros` separately. Retrieve the owned job again for current short-lived output URLs; the example avoids writing signed URLs into terminal logs.
