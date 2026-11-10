# OpenGen CLI

After installing the private portable release candidate, run `opengen <command>` without a checkout. Source developers may use `npm run cli -- <command>`. The CLI uses the shared SDK and fixed native operation registry; it contains no separate routing, pricing, account or settlement rules. It is not a globally published npm binary.

`MEDIA_ROUTER_URL` selects the gateway, default `http://127.0.0.1:4310`. Run browser login or supply your workspace key through `MEDIA_ROUTER_TOKEN` in an ignored local environment file or secret manager. An explicit environment token takes precedence over saved browser login. Credentials have no command-line option. Keep provider-connection input in a private file or stdin rather than shell history. Do not share the installation operator token as a customer key.

## Browser login

```sh
npm run cli -- login
npm run cli -- status
npm run cli -- logout
```

`login` opens the gateway's browser consent flow to select a paying workspace. It saves the scoped session in a private local profile; `status`, `doctor` and bare `opengen` perform read-only gateway diagnosis without refreshing or changing credentials. They distinguish credentials present from authenticated access and generation scope, then report account, paying workspace, scopes, balance, configured routes, policy and the next blocker. A configured token alone never means connected. Other authenticated commands refresh the session when needed. `logout` revokes and removes the saved authorization. An independently configured `MEDIA_ROUTER_TOKEN` remains active until you remove it from your environment.

Portable packages are prepared privately for release review. Public distribution and actual client qualification still require separate release verification. Login itself does not submit a generation.

## Discover and quote

```sh
npm run cli -- catalog search "wan 3.0"
npm run cli -- catalog get minimax/h3
npm run cli -- deployments
npm run cli -- operations
npm run cli -- quote --input /absolute/private/request.json
```

`request.json` contains the native `GenerateInput`: `{modelId, operation, input: {common and model-specific generation arguments}, routing?, routeId?, billing?, maxCostMicros?}`. Inspect `models.schema` with the exact `{modelId, operation}` to discover supported fields and limits. Inspect quote notices, `executable`, selected route and `reservationMicros`. A documented catalog entry is not live account verification. Inline canonical JSON is also accepted for quote/generate; private files avoid putting prompts in shell history.

## Upload a reference

```sh
npm run cli -- upload /absolute/private/source.png
```

The CLI accepts PNG, JPEG, WebP and MP4 files up to 100 MiB. Use `--media-type` with one of those exact MIME types when the filename does not identify its format. The gateway validates the uploaded object and the selected generation operation/provider remains authoritative about allowed references.

Upload runs prepare → one storage PUT → complete and prints `asset: {assetKey}`, media type and size. It never forwards your gateway Authorization header to storage or prints signed storage URLs. Put the returned asset in a named role such as `input.firstFrame`, `input.lastFrame`, `input.sourceVideo` or `input.mask`, or in an ordered `input.references` entry `{type: 'image', asset: {assetKey}}`. Select a role/type supported by the inspected model; do not persist a temporary preview URL. A failed upload attempts to remove its newly prepared object and never starts generation or repeats the PUT automatically.

## Submit once, then resume

```sh
npm run cli -- generate --input /absolute/private/request.json --idempotency-key my-persisted-request-key
npm run cli -- job recover --idempotency-key my-persisted-request-key
npm run cli -- job get RETURNED_JOB_ID
npm run cli -- job wait RETURNED_JOB_ID --timeout-ms 900000
npm run cli -- job resume RETURNED_JOB_ID --timeout-ms 900000
```

Persist the **exact input and key before** generation. Persist the returned job ID before waiting. The CLI never retries paid submission automatically. After a disconnect, retain that input/key and use `opengen job recover --idempotency-key KEY`, which performs read-only lookup and returns the existing ID when visible. A missing job is not proof of rejection: repeat lookup later or ask the operator to reconcile. Never replace an uncertain submission with a new key or automatically repeat the paid POST. The receipt-based [generation example](../../examples/README.md) automates local persistence if desired.

`job wait` and `job resume` default to 15 minutes and only read the existing ID. Results and structured JSON errors include the known job ID, independent acceptance/delivery/billing states and an exact origin-pinned safe resume command. Generic errors preserve server codes and canonical argument issues when available. Timeout or Ctrl-C stops the client wait; it does not cancel provider work. `submission-unknown` returns for reconciliation rather than starting another job. `job get` returns the full route, attempt, delivery, provenance and cost state. Media success, delivery availability and `settledMicros` are independent; a null settlement is not a refund. Refreshed output URLs can be obtained through a later authenticated job read.

Cancellation is separate and explicit:

```sh
npm run cli -- job cancel RETURNED_JOB_ID
```

Running provider tasks may reject cancellation. A cancellation request does not establish refundability.

## Registered operations

```sh
npm run cli -- call keys.list
npm run cli -- call policies.create --input /absolute/private/profile.json
npm run cli -- call connections.put --input /absolute/private/connection.json
npm run cli -- call ledger.export --input /absolute/private/page.json
```

`call` accepts only IDs in the shared fixed allowlist. It cannot select arbitrary methods, origins, URLs or headers. Use `--input -` to read JSON from stdin. The SDK forwards every operation to the native handler, so key scopes, regional policies, membership and installation-operator boundaries remain unchanged. Paid `media.generate`, `images.generate` and `videos.create` operations also require `--idempotency-key`.

Creation responses for API keys and webhook secrets contain a secret once. Save that output privately in your secret manager and never publish the complete response. JSON ledger export is available through the SDK/CLI operation; the HTTP endpoint also supports CSV. The browser-session APIs and workspace management remain available through the HTTP service. CLI browser login selects its authorized workspace through OAuth consent.
