# Unified generation API and agent onboarding

Owner requirements recorded 2026-11-03: the same exact model must use the same OpenGen input across providers, and each generation kind must have one consistent request/lifecycle protocol across models. Image-to-video requests for Seedance 2.5 and Kling 4.0 should differ mainly in model choice and declared capabilities. MCP onboarding should follow treg's documented hosted/local experience, using an independent implementation.

The release candidate now has a canonical registry for all 27 exact model variants, shared request validation, named media mapping, provider translation fixtures, and native OAuth/CLI browser-login support. Cross-interface integration and release verification are still in progress; fixture coverage is not live-provider or managed-deployment verification. See [STATUS.md](STATUS.md).

## Decision: retain the current executor

Keep PostgreSQL durable jobs, attempts, reservations and polling for v1. API normalization is provided by canonical schemas, capability validation and provider adapters. Temporal would still require those components. Its workflow history, timers, message passing and activity orchestration become useful if OpenGen adds multi-stage pipelines, parallel storyboard generation, approvals, assembly and cross-job coordination.

If Temporal is introduced later, it should own orchestration while PostgreSQL owns catalog/auth/accounting and appropriate read projections. Do not keep two competing execution state machines. Paid submission still needs upstream idempotency or conservative unknown-acceptance reconciliation: a Temporal activity can execute more than once.

## Common arguments plus model-specific extensions

Owner refinement: mirror fal's schema mechanism. Define common generation arguments and typed model-specific extensions, composed into one input object. A common argument is reusable where supported, not automatically available on every model. Exact-model arguments keep the same OpenGen names across providers; provider field spelling/encoding and narrower route constraints stay behind adapters.

Keep broker metadata (authentication, payer, routing, budgets, deadlines, callbacks, retention and retries) separate from generation arguments. Do not expose an unvalidated arbitrary-options bag. The exhaustive source inventory and evidence conflicts are in [the input audit](research/canonical-inputs/README.md); it precedes implementation of new canonical schemas.

## One public contract

REST, MCP, CLI, SDK and the playground use the same operation request, validation, quote and job service. The native submission remains `POST /v1/generations`, with an operation discriminator. Compatibility endpoints translate into that native service.

Canonical image-to-video example:

```json
{
  "modelId": "bytedance/seedance-2.5",
  "operation": "image-to-video",
  "input": {
    "prompt": "A slow cinematic push-in.",
    "firstFrame": { "assetKey": "inputs/workspace/source.png" },
    "duration": 5,
    "resolution": "720p",
    "aspectRatio": "source"
  }
}
```

For common supported settings, changing the model to `kling/kling-4.0` is the only client change. Changing the serving provider for the same exact model changes only routing constraints. MiniMax H3 Max and fal H3 Max use the confirmed canonical model ID `minimax/h3-max`; the earlier `fal/h3-max` ID resolves as an alias. Their provider-specific names, upstream IDs, prices and narrower capabilities remain on separate routes. Select a provider with `routing.providerIds` or pin its `routeId`; the model alias resolves to this shared model identity. H3 Max Turbo, H3 Flex and genuinely different checkpoints retain distinct model IDs. The source audit retains the provider labels captured before this identity correction.

Use one asset-reference union for an owned private upload or an external HTTPS URL. Explicit operation fields identify first frame, optional last frame, reference elements and source video. Each reference keeps its semantic role while storage URLs are resolved. The `input.references` array contains ordered `{type: 'image' | 'video' | 'audio' | 'document', asset}` entries. Do not concatenate independent URL/upload arrays and infer roles by index.

Operations get discriminated schemas and common parameter names, units and meanings. A canonical `source` aspect ratio means inherit the source; adapters map it to an upstream omission or documented value. Image editing does not inject an inherited ratio without qualification. Omni image-to-video and editing default to `16:9`; inherited geometry is qualified for its extension operation. Exact `size` suppresses ratio/resolution defaults and cannot be combined with explicit ratio/resolution controls. Vendor-specific `adaptive` vocabulary is translated by adapters. Unsupported ratio overrides must be rejected rather than silently ignored or implemented through unrequested cropping.

## Capabilities and routing

Publish machine-readable per-operation model and route capabilities: required media roles, accepted media types, per-role and combined element limits, reference duration/size limits, supported output duration/resolution/ratio/audio and parameter defaults. Record evidence and unknowns. A reseller can narrow a model's supported capabilities.

The effective capabilities are the intersection of the exact model, operation, regional route, request and workspace/key policy. Catalog inspection exposes the input schema and those constraints so agents and the playground can construct a valid request before submission. The registered `models.schema` operation accepts `{modelId, operation}` and returns the corresponding definition with `inputSchema`; it has the same meaning across REST, CLI, SDK and MCP.

One shared validator runs before quoting and reserving money. Quotes expose structured route exclusions, for example `too_many_references` with field/limit/received counts, or `unsupported_argument` identifying a media role. Never discard elements, switch variants, alter requested duration or silently disable audio to make a route eligible. A valid broader canonical request may route to providers supporting all its requested capabilities.

Provider adapters translate validated canonical data into vendor field names, media encodings and task protocols. Responses continue to use one asynchronous job, output, route/cost, cancellation and reconciliation protocol, including providers whose upstream call is synchronous.

## treg-style onboarding parity

Hosted assistants must connect to the public OpenGen MCP URL and complete browser OAuth consent with an explicitly selected paying workspace. They must not install a local CLI or paste upstream provider credentials.

Local coding agents get a verifiable OpenGen installer/package, browser login, workspace choice, a status command and the OpenGen skill. Token-based setup remains available for already-issued scoped workspace keys. Installation and login are separate from a billable generation.

The public entry point is `set up opengen - https://opengen.dev/llms.txt`. Instructions distinguish hosted assistants, local coding agents and restricted sandboxes. The core discovery loop remains search, inspect and call; quotes, job retrieval and cancellation support asynchronous paid media safely. Catalog inspection returns the canonical input schema, limits, price evidence and an executable example.

Protocol parity includes authorization-code flow with S256 PKCE, client discovery/registration appropriate to supported clients, short-lived workspace-bound access, refresh/revocation and protected-resource metadata. The candidate implements authorization-code/PKCE, dynamic client registration, workspace-bound access and rotating refresh tokens, consent and local browser-login commands. Public hosted-client onboarding, deployment and client configuration still require their release checks. Do not copy treg code or hosted modules.

## Acceptance

- The same canonical request maps correctly across two providers of one exact model.
- The same image-to-video schema works for Seedance and Kling within their shared capabilities.
- Mixed owned/external first/last frames keep their correct roles.
- Limits and structured exclusions agree across catalog, quote, REST, MCP, CLI, SDK and playground.
- Incompatible requests fail before reservation or provider submission.
- Hosted MCP sign-in selects a workspace and binds token authority and billing to it.
- Local installation/login/status/skill onboarding is verified separately from generation.
- Existing idempotency, regional pinning, unknown acceptance and money invariants remain intact.

## Primary references

- [treg onboarding and tool loop](https://treg.to/llms.txt)
- [treg authorization metadata](https://treg.to/.well-known/oauth-authorization-server)
- [treg MCP resource metadata](https://treg.to/.well-known/oauth-protected-resource)
- [Temporal activity idempotency](https://docs.temporal.io/activity-definition)
- [Temporal retry policies](https://docs.temporal.io/encyclopedia/retry-policies)
