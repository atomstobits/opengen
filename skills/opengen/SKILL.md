---
name: opengen
description: Discover exact image and video model routes, inspect schemas, quote and run authorized OpenGen jobs with private media and safe resume.
---

# OpenGen

Use the user's configured OpenGen gateway; the canonical public entry is https://opengen.dev/llms.txt. This skill is version 0.1.1. Installation and account login do not authorize spending.

## Choose your runtime

- **Already connected MCP:** use the available OpenGen tools. Start with `catalog_search` and `balance`; inspect the selected exact model with `catalog_get`. Do not reinstall or export credentials.
- **Hosted assistant** (including its code sandbox): add `https://opengen.dev/mcp` through the assistant's remote connector settings. Complete its browser OAuth consent and choose the paying workspace. In Claude, choose Sign in now and Register automatically (DCR) for the OAuth client. Installing a CLI inside a sandbox does not connect that assistant. A public HTTPS gateway with configured identity is required.
- **Local coding agent:** prefer the client's remote HTTP MCP integration and browser OAuth. Alternatively, install the portable `@opengen/cli@0.1.1` package into an isolated prefix (`npm install --prefix /absolute/private/client @opengen/cli@0.1.1 --ignore-scripts --no-audit --no-fund`) or use the reviewed offline release bundle (`node install-opengen.mjs --release-dir /absolute/download --expected-manifest-sha256 REVIEWED_DIGEST --prefix /absolute/private/client --skill-dir /absolute/agent/skills/opengen`) on Node 22.12+. Set `MEDIA_ROUTER_URL` to the selected gateway first (`export MEDIA_ROUTER_URL='https://opengen.dev'`), then run `/absolute/private/client/node_modules/.bin/opengen doctor`, `login`, and `doctor` (or `/absolute/private/client/bin/opengen.mjs` for offline bundle installs). See https://opengen.dev/agents/cli for installation details.
- **Restricted egress:** check whether the existing remote connector can reach the gateway. For a local runtime, transfer the reviewed offline release bundle through the approved channel and use the same installer. Do not bypass network policy, fetch an unreviewed bridge or copy credentials into client JSON. If gateway/storage/OAuth egress is blocked, report that exact blocker and have the operator allow the needed origins or provide an approved deployment.

The prepared CLI, skill and Claude Code plugin are private release candidates. Client configuration, protocol fixtures and public catalog access do not establish a working hosted generation service. Public generation, MCP and identity require the configured backend and fail closed when unavailable. Check https://opengen.dev/agents for dated client evidence.

## Diagnose and discover

`opengen doctor` (also bare `opengen` or `opengen status`) performs read-only checks. Credential presence is different from authenticated/authorized service access. Review the account when disclosed, selected paying workspace, scopes, balance, executable routes and next blocker. An API key may identify a workspace without identifying a human account. Never infer identity or available funds from a local profile alone.

Use `catalog_search` with modality/provider/endpoint region/operation/input-role filters as needed, then `catalog_get` for an exact model ID. The REST equivalents are `GET https://opengen.dev/v1/catalog/search` and `GET https://opengen.dev/v1/models/schema?modelId=<exact-id>&operation=<generation-kind>`. Through MCP `call`, use `models.schema` with the exact `modelId` and `operation`. Inspect the effective common and model-specific fields, required media roles, counts, MIME/size/duration limits, route capabilities and schema-derived minimal request before quoting. Do not guess an exact model or derivative from a marketing name.

Catalog listings include comparison-only routes. Check `executable`, source evidence and notices; unknown prices/performance are unknown, never free or reliable. An endpoint region is distinct from inference scope and storage residency. Keep exact model, regional pin and user policy; do not silently replace variants or discard requested arguments.

For the full upload → schema → quote → authorize → submit → resume → retrieve walkthrough, read https://opengen.dev/guides/image-to-video.md.

## Private image and video inputs

Use only media the user owns or has permission to use. Through registered operations, `assets.prepare` returns a short-lived upload URL; PUT only the file bytes and required storage headers to that URL, without the gateway Authorization header. Complete with `assets.complete` before generation and require its owned lifecycle `state` to be `ready`; failed, deleted, expired or processing assets cannot dispatch. Keep `{assetKey}` in the appropriate `input.firstFrame`, `input.lastFrame`, `input.sourceVideo`, `input.mask` or ordered `input.references` entry. Reference entries use `{type, asset: {assetKey}}`; roles and limits depend on the inspected model/operation. Do not upload secrets, unrelated local files or publicize references. External `{url}` references require an explicitly supported route and user-approved source; private owned uploads are the normal onboarding path.

## Quote, authorize, submit once

Use one canonical request: `{modelId, operation, input, routeId?, routing?, billing?, maxCostMicros?}`. `input` contains shared and typed model-specific arguments. Quote that exact request (`quote`, `POST https://opengen.dev/v1/quotes` or `opengen quote --input /absolute/private/request.json`). Check selected route, executable status, price/reservation, notices, billing owner and budget before submission. Request examples are templates, not spending authorization.

Managed billing uses operator provider connections and workspace credit. BYOK requires explicit `billing: "byok"` and the workspace's encrypted regional provider connection; the provider bills that account directly. Unknown upstream prices cannot be promised as capped by OpenGen. Do not select a payer silently. Provider secrets remain server-side; local CLI profiles stay private, tokens never go in argv, URLs, Git, prompts or agent JSON.

Obtain authorization for the selected request and bounded spend. Persist the original request and a new stable idempotency key before submitting. Call `media.generate` with `{input: <request>, idempotencyKey: <persisted-key>}`, or use `opengen generate --input /absolute/private/request.json --idempotency-key SAVED_KEY`. Persist the returned job ID and private receipt immediately. Reusing the key with changed input is a conflict, not a retry strategy.

## Wait, resume and retrieve

When the user provides an existing job ID and asks to check, show, play, or download the result, start with the dedicated read-only MCP `job_get` tool using `{id: JOB_ID}`. It attaches the result card and refreshes temporary links.

When the user asks for a finished generation, keep following the accepted job in the conversation. Use MCP `call` with `{operationId: "jobs.status", input: {id: JOB_ID}}` for a compact read. While the job is queued, submitting or running, or a successful generation is still being delivered, repeat the read with the latest `job.revision` as `afterRevision` and a bounded `waitMs` of at most 25000. Use a shorter wait if the host requires it. The REST equivalent is authenticated `GET https://opengen.dev/v1/generations/{id}/status`. If compact status is unavailable, read the same job with `job_get` or the full job REST endpoint.

When `deliveryStatus` is `available` or `partial`, call `job_get` with the same ID to show the private result card in hosts that support MCP Apps. If the host cannot display the card, give the user an **Open image**, **Open video**, or **Download** link to the current returned output in the authorized chat. Show only usable outputs and say when delivery is partial. Keep the job ID so a later `job_get` can refresh expired links while the private files are retained. Use the returned `expiresAt` when available. Keep signed links in the authorized conversation.

If the host runs out of time, report the last known status and job ID and continue with read-only recovery when possible. Use the exact safe command in `recovery.resume.command` (or `error.resume.command` on failure), with its returned args/environment. A timeout, lost connection, or unknown acceptance never authorizes another paid submission. If no job ID arrived, use MCP `call` with `{operationId: "jobs.lookup", input: {idempotencyKey: SAVED_KEY}}`, or `opengen job recover --idempotency-key SAVED_KEY` with the same gateway/profile. Reconcile through the operator if acceptance stays unknown. Preserve the original request, key and receipts.

Generation, delivery and billing are separate. Report a failed or expired delivery even when generation succeeded, and show delivered media without waiting for settlement. Cancellation does not imply refund. An expiring link is temporary access to an existing file. No or unknown C2PA evidence establishes no authenticity claim.

## Private feedback and missing routes

When the user requests feedback or a catalog addition, prepare a short sanitized report linked to relevant public model/route IDs and owned job ID. Preview the content and submit only when the user has authorized that report. Do not automatically send prompts, credentials, media, conversations or logs. OpenGen feedback is private to the workspace/operator; it is not a public ranking or third-party message. Feedback submission requires a separately scoped workspace key with `feedback:write`; the current OAuth `read`/`generate` grant does not include that permission.

The fixed operation registry is at `GET https://opengen.dev/v1/operations`, OpenAPI at `https://opengen.dev/openapi.json`. MCP `call` accepts those operations only; there is no unrestricted URL proxy. The future public OpenAI plugin has a separate narrower profile and review process.
