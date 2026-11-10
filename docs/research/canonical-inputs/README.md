# Generation input audit

Checked **2026-11-03**. This is the documentation inventory for OpenGen's 28 planned exact variants across 14 series. It extends the earlier catalog/adapter review with complete field lists from the public contracts inspected here. It does not change executable support, prices, runtime validators or claim live verification.

Identity correction recorded 2026-11-03: the owner confirmed that fal H3 Max and MiniMax H3 Max name the same variant. The current catalog therefore has 27 canonical variants; `fal/h3-max` resolves to `minimax/h3-max`. This historical provider-documentation snapshot retains its original labels, separate provider schemas and baseline counts.

## Start here

- [Every model and its audited interfaces](model-coverage.md)
- [All parameter records — filterable CSV](all-fields.csv)
- [Machine-readable index, sources and conflicts](index.json)
- [fal mechanism and OpenGen mapping](fal-reference.md)
- [Seedance / Kling / Wan detailed report](video-seedance-kling-wan.md) and [JSON](video-seedance-kling-wan.json)
- [H3 / Omni / Grok video detailed report](video-h3-omni-grok.md) and [JSON](video-h3-omni-grok.json)
- [Image models detailed report](image-models.md) and [JSON](image-models.json)

The selected-model inventory contains **123 model/provider/operation profiles and 1,659 parameter records from 128 source URLs**. Counts include repeated shared fields, nested branches and regional/mode profiles; they are not 123 unique HTTP URLs or 1,659 unique controls. Three additional, not-yet-qualified Pika H3 offerings have 25 separate fields. There are 77 sanitized structural schema files, including mechanism examples and supplemental offerings.

The [scope manifest](scope.json) pins all 28 target variants and the 67-route catalog baseline. Additional newly documented endpoints are research findings, not silently added runtime routes.

## What each record contains

The group JSON files preserve the authoritative research detail. The CSV joins their model IDs, provider, endpoint profile, operation, region, field path, type, required/conditional status, documented default, enum/bounds, proposed layer, source URL and original field detail. Required flags on nested/union fields are conditional on the corresponding parent/type branch. Missing documented defaults remain distinct from an explicit null default.

Endpoint records also contain media types, file/dimension/duration limits, combined budgets, mutual exclusions, variant-specific restrictions, unknowns and evidence conflicts. Read these with the field rows: individual maxima do not imply every maximum can be used simultaneously.

## Chosen schema mechanism

Follow the owner's refinement: **common arguments plus typed model-specific arguments, composed into one input object**. Keep broker controls separate.

| Layer                       | Candidate content                                                                                                                                     | Rule                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Common generation arguments | Prompt; named media/assets; duration; output sizing/ratio; count; quality; seed; format/audio where meaningful                                        | Reused names and meanings, with explicit support/limits per model                   |
| Model-specific extensions   | Draft/finalization; reasoning/thinking; custom entities/voices; keyframe/shot controls; layer decomposition; special codec/bitrate/rewriting controls | Typed and discoverable for the exact variant; adapters translate provider spellings |
| Broker/transport            | Model/route selection; credentials; payer/budget; idempotency; callbacks; deadlines; privacy/retention; polling/retries; safety attribution           | Not an arbitrary model-input/header passthrough                                     |

These field classifications are design candidates, not proof of universal support. For example, generic guidance controls do not have an equivalent numerical meaning across every model. An optional common argument can be unsupported or fixed on a particular model. A model-specific argument may be unavailable on one reseller's route.

Do not add an unvalidated `extra` bag. Compose the effective schema from the common base, exact-model extensions and qualified route restrictions. The REST/SDK/MCP/playground must inspect and enforce the same resulting contract.

## Important findings

- **Combinations differ, not only counts.** Strict frame and multimodal-reference modes can exclude one another on Seedance/Wan, while Kling wrappers support different mixed combinations.
- **There are multiple media roles.** First/last/middle frames, timed keyframes, grouped elements, source videos, voice references and soundtrack replacement cannot be treated as one unordered URL array.
- **Media is broader than images/video.** Some image-generation interfaces accept PDF/video context. Base weights and hosted models expose different controls.
- **Defaults differ across suppliers.** Prompt rewriting, quality, shape, smart duration and resolution can change when the provider changes unless OpenGen supplies a deliberate compatible default.
- **Encoding is not delivery.** An image codec, URL-versus-base64 representation and a response modality tag are different controls even when vendors call them `format`.
- **Transparent output is not one boolean capability.** Native transparency, constrained alpha-image editing and prompt-guided RGBA have different guarantees.
- **Silent handling exists upstream.** Some wrappers truncate references or ignore unsupported fields. OpenGen should reject incompatible input before spending rather than inherit those behaviors.
- **Marketing tiers are not exact pixels.** A 4K label can correspond to different square dimensions between routes. Preserve exact-size versus tier requests separately.

The full sources and exact limits for these findings are in the relevant group report, not inferred from this summary.

## Coverage boundaries and unresolved evidence

All requested variants have a record, including inference-only/no-qualified-hosted-API cases. Formal schemas are complete for the inspected selected contracts; public documentation is not complete for every vendor channel.

**24 evidence conflicts/applicability boundaries** are retained in the index rather than resolved by guessing. Important remaining qualifications:

- Direct Kling 4 API availability is established by its release notes, but its native detailed payload was not recovered from the public JavaScript documentation. Runway/Runware/other wrapper fields are not substituted for it.
- Gemini Omni is **model-guided partial**: supported model controls are recorded, and generic Interactions nesting/media-processing fields lacking model-specific proof remain unverified. Generic LLM controls are not automatically attributed to Omni.
- Qwen 2.1 base weights/inference parameters do not establish a hosted base-model API. Hosted Pro and Turbo identities stay distinct.
- A formal schema, prose guide, landing page and pricing table may disagree. Pricing alone does not establish a generation option. Promotion/retention/channel and model-version scope must stay explicit.
- No account access, regional processing/storage guarantee, provider cost or generation quality was tested. No keys or paid inference were used.

## Rebuild and validation

After dependency installation, run from the repository root:

```sh
node docs/research/canonical-inputs/build-index.mjs
```

The builder checks exact-model coverage, unique profile IDs, source references, field paths/types/classifications and schema-file references before regenerating the CSV, index and coverage table. Group authors separately validated schema pointers, snapshot hashes and source-specific constraints. Raw pages and unstripped documents remain outside the repository; redistributed snapshots remove long vendor prose and examples.
