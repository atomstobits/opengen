# Contributing to OpenGen

OpenGen is an independent Apache-2.0 implementation. Read [AGENTS.md](AGENTS.md), the [plan](docs/PLAN.md), [current status](docs/STATUS.md) and [security policy](SECURITY.md) before making a change. Contributions are provided under Apache-2.0; model weights and provider services keep their separate terms.

## Local development

Use Node.js 22.12+ and `npm ci`. Run `npm run dev:api` and `npm run dev` in separate terminals for the public catalog. Provider credentials and a database are unnecessary for catalog development. See [README.md](README.md) and [operations](docs/OPERATIONS.md) for durable jobs and containers.

Keep changes small and explicit. REST, MCP, CLI and web must use the same application rules. Add abstractions only when they remove meaningful duplication. Never send a paid request from a unit/browser test.

## Catalog and adapters

A company, model-series owner, exact variant author, regional deployment and serving route are different identities. Add original-provider links and dated primary sources. Do not infer processing residency from the endpoint location, merge derivative models with similar names, invent prices or substitute zero for unknown metrics.

A new adapter needs synthetic request/response fixtures, exact-region credential tests, unsupported-parameter preflight, a bounded timeout and conservative unknown-submission handling. A timeout after submit is not permission to retry a billable call. Mark support as fixture-tested until a separately authorized live smoke has dated evidence. Private prompts, asset URLs and keys do not belong in fixtures.

## Validation and pull requests

Run the relevant checks, then the release checks before proposing a release:

```sh
npm run format:check
npm run typecheck
npm run catalog:check
npm test
npm run test:sql
npm run build
npm run release:check
npm run scan:secrets
```

The SQL helper uses PGlite; native PostgreSQL CI is still required for concurrency. Browser tests are in `apps/web/e2e`; start the services and run `npx playwright test --config apps/web/playwright.config.ts --workers=1`.

Describe the problem, resulting behavior and checks performed. Include a manual testing plan in every pull request. Disclose limitations and provider evidence without publishing credential values. UI changes should include desktop and phone review evidence. Do not copy treg source, assets or catalog content.

## Reporting problems

Use a bug report for reproducible non-sensitive failures. Use the private channel in [SECURITY.md](SECURITY.md) for security issues, and never attach `.env`, private inputs, signed URLs or real provider responses to a public issue.
