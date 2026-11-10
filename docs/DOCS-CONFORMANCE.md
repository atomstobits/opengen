# Documentation conformance and manual test plan

The feature reference, public `/docs` examples and standalone HTTP program describe one canonical HTTP/MCP contract. This qualification is synthetic and private. It does not prove deployed storage, identity consent, actual agent clients, provider generation, native PostgreSQL races or final accounting.

## Automated fixture acceptance

From a source checkout with Node 22 and its own lockfile install:

```sh
node node_modules/vitest/vitest.mjs run tests/http-feature-contracts.test.ts tests/docs-schema-conformance.test.ts --maxWorkers=1 --no-file-parallelism
```

The tests parse the public docs’ actual JSON/curl template literals with TypeScript and check shell syntax, parse copyable reference requests, exercise real Fastify HTTP/MCP handlers and schema/quote logic with synthetic engine/storage boundaries, and validate multipart response shapes with Ajv. No provider or storage transport is called. Status uses the real compact projection with a synthetic database; admission/money remain fixture boundaries.

The server-rendered `/guides/image-to-video` page and its Markdown endpoint share the generated walkthrough source. `tests/image-to-video-guide.test.ts` checks fenced-example parity, canonical request validity and documented route links. `apps/web/e2e/docs.spec.ts` checks separate clipboard actions for quote, paid submit, status and recovery, plus phone readability with JavaScript disabled. Run the browser check against a local web build with its configured Playwright base URL. These checks make no generation requests.

## Manual review for the integrating PR

1. Use an isolated fixture installation, a synthetic workspace token with `read` + `generate`, and synthetic media. Read `/v1/operations`, `/openapi.json`, exact model/operation schema and regional routes before constructing the request. Confirm the public docs require no SDK import or source checkout for API users.
2. Prepare and PUT a synthetic input using only the returned storage headers, then complete/get the same key. Confirm only `ready` assets proceed. Check the integer byte limit (100 MiB), media MIME/role distinctions and multipart part numbers, ETags, interruption/resume/abort behavior. These upload operations never start inference.
3. Quote one request pinned to an exact model/route/endpoint region. Confirm private project/tags live outside `input`, amounts use micro-USD, unknown prices remain unknown and unsupported fields point to field/limit issues. Use only a fixture admission handler to submit once with a saved body/key. Changing metadata under that key must conflict.
4. Interrupt the submit response. Keep the original key; use read-only `jobs.lookup`, including a key requiring URL encoding. A missing result is not proof of rejection. Interrupt the first post-admission read and confirm the accepted job ID was already persisted. No replacement submit is permitted.
5. Compare HTTP and MCP `jobs.status` success and 401/403/404/429/503 envelopes. Confirm `waitMs` is milliseconds (0–25000), revision equality is opaque, compact status omits prompts/media, and a read timeout/disconnect never changes provider acceptance or settlement.
6. Exercise same-job `submission-unknown`, pending/partial delivery, terminal failure/expiry and retained output URL refresh fixtures. Check `structuredError.recovery` guidance. There is no customer delivery-retry endpoint; bounded worker recovery uses the original attempt and terminal outcomes need operator help.
7. Review compatibility fixtures for owned edits, 256 KiB/24-part text multipart bounds, 8 MiB decoded base64, single MP4 Range/If-Range 200/206/416 behavior and foreign-workspace denial. Errors retain the existing job identity; representation changes cannot trigger a generation.

Run hosted/client/storage steps only under the integration and onboarding owners’ separate authorization and evidence cohort. These manual steps do not authorize paid generation or deployment.
