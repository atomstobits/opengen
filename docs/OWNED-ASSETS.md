# Owned input API candidate

This is the registered source/fixture contract for native HTTP and MCP `call` operations. It does not establish that a hosted installation has activated the current core, configured storage or applied the required migrations. Inspect that installation’s `/v1/operations` and `/openapi.json` before use. All operations require an authorized workspace identity and remain private. No SDK is required.

## Upload, inspect and reuse

1. `POST /v1/assets` with `{ "mediaType": "image/png", "size": 1234 }` using a token with `generate` scope. The response contains `key`, `uploadUrl`, required `headers` and `expiresAt`.
2. PUT the exact file to `uploadUrl`, including every returned header. Do not send the OpenGen token to storage. The size and MIME declaration are checked against the actual bounded bytes at completion.
3. `POST /v1/assets/complete` with `{ "key": "<returned key>" }`. Repeat completion after an interrupted response. Only a `ready` response can be used for a new generation.
4. Use `{ "assetKey": "<returned key>" }` at the model's exact canonical media role. Upload acceptance does not establish model/role/count support.
5. `GET /v1/assets?key=<URL-encoded key>` with `read` scope returns state and private hash/size facts. It does not mint a download URL or submit a generation.

Accepted storage MIME types are PNG, JPEG, WebP, MP4/WebM video and MPEG/WAV/Ogg/FLAC/MP4/WebM audio, with a 100 MiB per-file cap. Bounded container validation checks signatures/structure/track kinds; it is not a full decoder or a quality/safety certification. Model-specific media constraints remain separate. Decoded duration/dimensions are not provided by this input module; exact media-dependent admission must use qualified inspection or reject unsupported exact pricing rather than inventing facts.

To reuse an available private output, send `POST /v1/assets/reuse` with `{ "sourceJobId": "<owned job UUID>", "outputIndex": 0 }` and a stable `Idempotency-Key`. This authorizes the persisted job/output slot and copies identical retained bytes to an independent ready input identity. Its response has `assetKey`, `state`, `mediaType`, `byteLength`, `sha256`, `expiresAt` and `deletionPending`. It performs no generation or reservation. A signed output URL or raw output object key is not a reusable input identity. Missing, foreign, expired/unretained or invalid output slots fail.

`POST /v1/assets/import` accepts `{ "url": "https://public.example/synthetic.png", "type": "image" }` (or `video`/`audio`) with `generate` scope and a stable `Idempotency-Key`. It downloads a bounded public HTTPS file, checks actual bytes, and registers an immutable ready asset. Private/mixed DNS, redirects, credentials, unsupported types and oversized/mismatched bodies fail. Replays reuse the same bytes, even if the URL later changes. Changing the URL/type under that key conflicts. An interrupted import without any durable frozen bytes fails rather than fetching a possibly changed source again under the same identity. These operations do not reserve money or dispatch providers.

## Multipart

`POST /v1/assets/multipart` accepts the same media type/size declaration and returns `key`, `partSize` and `partCount`. Parts are 5 MiB except the last, with at most 20 parts under the shared 100 MiB cap. The storage upload ID stays server-side.

- `POST /v1/assets/multipart/part` with `{ "key": "...", "partNumber": 1 }` returns a bounded signed PUT for that exact part. Keep its returned ETag.
- `GET /v1/assets/multipart?key=<encoded key>` returns an array of `{partNumber,etag,size}` for resume.
- `POST /v1/assets/multipart/complete` with `{ "key": "...", "parts": [{ "partNumber": 1, "etag": "..." }] }` validates the exact part list and final object, then completes readiness. Completion is idempotent. Until it succeeds the asset cannot dispatch.
- `POST /v1/assets/multipart/abort` with `{ "key": "..." }` tombstones an unfinished upload and aborts its persisted session. Repeated abort remains safe. Complete and resume after abort fail.

Do not start new generation work while an upload is incomplete. Private-bucket CORS must allow the returned headers and expose `ETag`. Use `If-None-Match` on S3 and `x-goog-if-generation-match` on Google Cloud Storage as returned by the API. Browser CORS, create-only PUT and multipart completion still need deployed storage qualification.

## Deletion and accepted work

`DELETE /v1/assets` with `{ "key": "..." }` returns `{ "state": "deleted", "inUse": true|false }`. This immediately blocks new admissions and new unpinned reads. It tombstones first; physical cleanup waits for accepted-job pins, active write leases and outstanding upload capabilities. Already issued read capabilities remain usable until their bounded expiry. The accepted worker can read a tombstoned input through its existing private job pin; cancellation requests and unknown provider acceptance do not release that pin.

Cleanup retains minimal private lineage, hashes, preparation/idempotency rows and financial/attempt records. Replaying an accepted generation after deletion must return the original job and availability state. It must never create another paid render. Reused inputs are independent copies: deleting one does not delete its source output or other copies. Ready input expiry is configured through `MR_INPUT_RETENTION_MS` (integer milliseconds, at least one minute). When unset, ready inputs have no automatic expiry; no hosted retention duration is promised here. The shared worker performs bounded eligible input cleanup when no accepted generation/delivery/dispatch work is due. Tombstones, pins, write leases and outstanding upload capabilities still fence physical deletion. See [ASSET-PRIVACY.md](ASSET-PRIVACY.md).

## Retry decisions

| Outcome                                                     | Correct next action                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Upload/part request interrupted                             | Resume the same upload and part identities; do not generate.                                       |
| Completion response interrupted                             | Complete/get the same key; successful frozen bytes are retained.                                   |
| `input_preparation_in_progress` / `asset_write_in_progress` | Resume the same identity after the active bounded operation.                                       |
| `idempotency_conflict`                                      | Recover the original request or use a new identity for an intentionally changed request.           |
| `input_preparation_failed`                                  | Inspect/fix the input and begin a new preparation; no job/reservation was created by this service. |
| Generation submit response interrupted                      | Look up/resume the original job with the original idempotency key.                                 |
| Provider output delivery failed                             | Retry delivery of the same existing job; never regenerate automatically.                           |
