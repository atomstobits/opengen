# OpenGen

An independent, Apache-2.0 image and video API router. Compare exact model variants across regional deployments, inspect source-linked prices and use configured routes through HTTP, MCP, the CLI or the private browser workspace.

**Open-source `0.1.0` source release.** User prompts, media, receipts and labels remain workspace-private; there is no public generation gallery or share toggle. The core implements immutable inputs, original-job delivery recovery, trusted admission/budgets/capacity and private Activity/settings with fixture coverage. Source publication, live provider route verification and managed service activation are separate gates; dated provider/runtime observations do not establish full model/region/client coverage. See [current status](docs/STATUS.md), [release gates](docs/RELEASE.md) and [hosted activation](docs/CORE-HOSTED-ACTIVATION.md).

Start with the [HTTP/MCP feature reference](docs/FEATURE-API-REFERENCE.md), [owned input lifecycle](docs/OWNED-ASSETS.md) and [image-to-video guide](docs/IMAGE-TO-VIDEO.md). No new SDK is needed. SDK distribution/new language bindings/framework adapters are deferred; the existing source-workspace client receives compatibility maintenance only.

## Run the catalog and public API

Requires Node.js 22.12+ and npm. No provider key, database, payment service or external authentication is needed to browse and quote.

```sh
npm ci
npm run dev:api
```

In a second terminal:

```sh
npm run dev
```

Open [the catalog](http://127.0.0.1:4320). The API is at `http://127.0.0.1:4310`; Streamable HTTP MCP is at `/mcp`.

Browse [companies](http://127.0.0.1:4320/companies), [ByteDance](http://127.0.0.1:4320/bytedance), [Seedance 2.5](http://127.0.0.1:4320/bytedance/seedance-2.5), or [MiniMax H3](http://127.0.0.1:4320/minimax/h3). Series pages list every exact variant and its regional serving routes. H3 derivatives retain fal/Pika authorship while belonging to the MiniMax series. Try actions preserve the selected exact model and regional route.

```sh
npm run cli -- catalog search 'wan 3.0'
npm run cli -- deployments
npm run cli -- quote '{"modelId":"alibaba/wan-3.0","operation":"text-to-video","input":{"prompt":"A red kite in the wind","resolution":"720p","duration":10},"routing":{"endpointRegions":["ap-southeast-1"]}}'
```

Generation requests put common and typed model-specific arguments in one `input` object. Model identity, operation, routing, billing and budgets stay on the outer request. Owned media use `{"assetKey": "OWNED_INPUT_KEY"}` in an explicit role such as `input.firstFrame`; external media use `{"url": "https://media.example.com/source.png"}`. Inspect the exact model/operation schema through registered operation `models.schema` before quoting.

The API supports public catalog/model/deployment/route discovery, single and batch estimates, and observed provider-attempt metrics with separate end-to-end job timing. Metrics remain unknown without installation observations. Unknown prices remain null. Regions and scope labels are provider documentation, not proof of residency or live account access.

`GET /v1/companies`, `GET /v1/companies/{company}`, `GET /v1/series`, and `GET /v1/series/{company}/{slug}` expose the same ownership and variant membership as the website. MCP `catalog_get` and CLI `catalog get` accept company and series IDs as well as exact model/route IDs.

## Enable durable jobs

1. Run `npm run setup:local` to create a private `.env` with random local database/gateway/vault/session secrets. It refuses to overwrite existing configuration and prints no values.
2. Configure PostgreSQL and review the local settings; see [the self-hosting runbook](docs/OPERATIONS.md).
3. Set `MR_INITIAL_BALANCE_MICROS` deliberately (1,000,000 micro-USD = $1); it only applies when a workspace is first created. It is operator-granted credit, not a payment integration.
4. Configure credentials for the exact provider region you intend to use. Alibaba requires a matching region, workspace and API key. BytePlus uses its Singapore key.
5. Start `npm run dev:api` and `npm run worker`. Schema initialization is idempotent.

The installation token is an operator bootstrap credential. The account layer adds workspace-scoped API keys, saved policies, encrypted provider connections, revocable browser sessions and optional OIDC sign-in. Configure the session/vault secrets privately. Team membership and operator reconciliation are implemented; production identity/authorization verification remains a release gate; keep the managed backend private until its deployment gates pass.

Generation is an explicit authenticated action. Send `Authorization: Bearer <workspace-key>` and `Idempotency-Key: <stable-key>` to `POST /v1/generations`. Use `generate` scope for admission and `read` scope for later retrieval. Store the returned job ID and poll `GET /v1/generations/{id}`. Reusing a key with a changed request returns a conflict. A submission of unknown acceptance keeps its reservation and requires reconciliation rather than a blind paid retry. See [authentication and funding](docs/AUTH.md) for operator bootstrap, scoped keys, browser/OAuth configuration and replay-safe operator credit.

The browser supports HttpOnly sessions; a self-hosted operator can bootstrap a session privately, while a configured OIDC provider supplies normal sign-in. The frontend proxy forwards the caller identity and never injects an operator token for anonymous visitors. Operator-funded provider secrets stay server-side. BYOK values are submitted privately to the API, encrypted at rest and never returned by connection-list APIs.

## MCP

Connect a Streamable HTTP client to `http://127.0.0.1:4310/mcp`. Discovery and quotes are read-only. Authenticated operations carry the same bearer token.

Tools: `catalog_search`, `catalog_get`, `quote`, `call`, `job_get`, `job_cancel`, `balance`. `call` accepts registered operations for generation, uploads, history, keys, policies, encrypted connections, webhooks and alerts. `media.generate` requires a stable idempotency key. No arbitrary upstream URL proxy is exposed. Agent entry points are `/llms.txt` and `/skill.md`; inspect `/v1/operations` and `/openapi.json` on the gateway for the actual allowlist/schema. See [webhooks and alerts](docs/WEBHOOKS.md) for signed events and [output/provenance](docs/PROVENANCE.md) for private archival and optional C2PA verification boundaries.

## SDK and examples

The [TypeScript SDK](packages/sdk/README.md) is a private source-workspace package, not an npm publication. It reuses the native generation/quote/job contracts and never automatically retries a paid submission. [Executable examples](examples/README.md) cover REST discovery, MCP discovery and private-receipt generation/recovery. [Compatibility documentation](docs/COMPATIBILITY.md) records the strict OpenAI-style subset, including asynchronous image and redirect-content extensions; full drop-in compatibility is not claimed.

## Regional catalog

Company, regional deployment and exact model route have separate identities. Wan 3.0 Standard and Prime have six documented Alibaba regions each. Price, capability, credential requirements and observations belong to each route; an endpoint in Frankfurt with Global scope does not imply EU-only inference.

Model metadata includes Seedance 2.5; Seedance 2.0 Standard/Fast/Mini; Kling 4.0; Wan 3.0 Standard/Prime; official and third-party H3 variants; Gemini Omni Flash; Grok Imagine Video; GPT Image 2.5 Sunburst/Flare; GPT Image 2; Nano Banana 2.1; Grok Imagine Image 2; Seedream 5 Pro; and Qwen Image 2.1/3.0 offerings. Exact source and license evidence lives in the catalog. Most non-Alibaba regional audits remain pending.

## Verification

```sh
npm run typecheck
npm run catalog:check
npm test
npm run build
node packages/engine/scripts/test-pglite.mjs
```

SQL integration tests run against `TEST_DATABASE_URL` when set. The PGlite script runs real PostgreSQL SQL in a local WASM/socket process using injected no-network provider fixtures, then shuts it down. It does not prove native multi-connection PostgreSQL concurrency. CI runs the same invariants against a native PostgreSQL service.

Browser tests live in `apps/web/e2e`; start the API and web services, then run `npx playwright test --config apps/web/playwright.config.ts`. They do not trigger paid generation.

## Self-hosting and contributions

`deploy/compose.yaml` provides PostgreSQL, API, worker and web with loopback-only ports and separate secret boundaries. Run `npm run setup:local`, then `docker compose --env-file .env -f deploy/compose.yaml up --build --detach --wait`. Follow [operations](docs/OPERATIONS.md) for private backups, restore, upgrades and credential handling. Container and native-PostgreSQL CI must pass on the exact release commit before claiming those procedures are verified.

Keep facts and executable support separate. An added manifest is not a live integration. New adapters need request/response fixtures, regional credential tests and idempotency/unknown-outcome coverage. Publish neither invented metrics nor customer prompts. Read [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) before contributing. Follow [SECURITY.md](SECURITY.md) for private reports and [the release checklist](docs/RELEASE.md) before publication.

The visual language is inspired by [treg](https://treg.to/). This repository uses original code, catalog records and branding; it does not include treg source or assets.

## License

Apache-2.0. Model weights and provider services retain their own licenses and terms.
