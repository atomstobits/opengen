# Seedance, Kling and Wan input audit

Checked **2026-11-03**. This is a fresh documentation audit of seven exact initial variants. It inventories the complete field sets in the fetched public contracts and records prose-only restrictions separately. A documented field, public schema or endpoint does not prove account access, model-equivalence guarantees, price qualification or a successful generation. No live or paid requests ran.

The companion JSON has **63 endpoint profiles and 808 field records** (including nested/union fields). The 42 schema snapshots contain functional types, enums, required flags, bounds and defaults only; vendor descriptions/examples were removed. Full raw pages remain outside the repository. `defaultSpecified: false` is different from a published `null` default. Required flags on nested objects apply only to the relevant parent/type branch.

The classifications below are **OpenGen normalization candidates**, not assertions that a common field works everywhere:

- `commonGeneration`: task/model selection, prompt, semantically named input media, duration, output dimensions/ratio, audio, seed and ordinary output properties where supported.
- `modelSpecific`: draft/finalization, explicit edit/extend intent, codecs, bitrate, provider reasoning/rewriting, camera switches and other model controls.
- `brokerTransport`: credentials, end-user pseudonyms, provider callbacks, service class, queue priority and expiry. These need explicit broker ownership rather than blind forwarding of arbitrary client values.

## Model and route coverage

| Exact variant                 | Audited route surfaces                                                          | Important native differences                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bytedance/seedance-2.5`      | BytePlus Singapore; fal standard + US; Runway; Replicate                        | 4–30s or smart duration, 480/720/1080p, 30 images + 10 videos + 10 audio (50 combined), audio-only allowed natively, edit/extend, 480p draft → 1080p final |
| `bytedance/seedance-2.0`      | BytePlus Singapore; fal standard + US; Runway                                   | 4–15s or smart duration; Standard adds 1080p/4K; 9 images/3 videos/3 audio with combined cap; audio needs visual input                                     |
| `bytedance/seedance-2.0-fast` | BytePlus Singapore; fal; Runway                                                 | Separate model ID, 480/720p only; no inference of Standard 4K support                                                                                      |
| `bytedance/seedance-2.0-mini` | BytePlus Singapore; fal; Runway                                                 | Separate model ID; fal now publishes all three Mini schemas; 480/720p only                                                                                 |
| `kling/kling-4.0`             | Runway full OAS + input guide; Cloudflare supplemental; direct Kling unresolved | 3–30s; first + up to eight middle + last keyframe on Runway, image references share a ten-image budget; native audio cannot be switched off                |
| `alibaba/wan-3.0`             | Alibaba's six documented regions; fal                                           | 2–30s or smart duration; multimodal refs plus document/web-page mode; frame control and omni mode cannot be mixed                                          |
| `alibaba/wan-3.0-prime`       | Alibaba's six documented regions; fal                                           | Standard-aligned capability surface, distinct model/rate; no region cross-product inferred from global company locations                                   |

The JSON profiles list the exact regional host for Beijing, Singapore, Tokyo, Frankfurt, Virginia and Hong Kong for each Wan model. Regional keys/workspaces are independent. BytePlus evidence here qualifies its Singapore endpoint only. Fal standard/US route labels are distinct; a US-labelled endpoint is documentation, not proof of an account's US contract or a storage-residency commitment.

## Findings that change the canonical input design

1. **Counts are only part of the constraint.** BytePlus Seedance and native Wan prohibit mixing strict first/last-frame roles with omni references. Runway Kling 4 permits keyframes and reference images together, under one combined image budget.
2. **A middle keyframe is not an ordinary reference image.** Kling's ordered middle frames need their own canonical role. An explicit second/time placement is not exposed; don't invent timestamp guarantees.
3. **Source-framing mode needs one stable meaning.** BytePlus 2.5 first-frame/edit/extend requires `adaptive`; fal's first-frame uses `auto`; Runway uses `auto_720p`/`auto_1080p` for source framing plus output quality. These combine different concerns.
4. **Smart duration uses different types.** Native Seedance/Wan use `-1`; fal Seedance uses string `auto`; fal Wan uses `null`; Runway uses integer-or-string `auto`. Native Seedance edit can preserve a non-integer source duration despite integer approximations in status output.
5. **Prompt optionality is route-specific.** BytePlus media input can omit text. Fal Seedance 2.0 requires `prompt`, but its 2.5 first-frame schema only requires `image_url`. Replicate defaults prompt to empty if media exists. Kling only requires text when references or video editing need an instruction.
6. **Draft completion is a different conditional operation.** It reuses provider/account-bound state and forbids many normal generation parameters. It is not a fresh text-to-video request with the prompt resent.
7. **Strict canonical validation must also cover provider coercion.** Examples include native Wan prompt truncation, fal edit-mode coercion and Runway image padding/cropping. A common request must not silently pretend that changed output settings were honored.
8. **A shared field name does not prove native support.** Native BytePlus's supported-model list excludes 2.x from its `seed`/`camera_fixed` controls, while reseller schemas expose seed. Record route support and reproducibility limitations rather than promise identical output.

## Native BytePlus contract

Primary references: [create task](https://docs.byteplus.com/en/docs/modelark/create-video-generation-task-api), [Seedance 2.5](https://docs.byteplus.com/en/docs/ModelArk/seedance-2-5), [2.0 family](https://docs.byteplus.com/en/docs/ModelArk/seedance-2-0). The actual public Markdown was read from the pages' embedded route data; the rendered JS shell alone is insufficient.

### All request fields

The following table uses the 2.5 profile; each of the four per-model JSON records carries the exact model ID, supported flags and variant resolution/duration enum. Unsupported fields in the shared native reference remain explicitly marked unsupported, rather than being silently omitted from the audit.

| Provider field             | Type            | Required                               | Default       | Enum / formal bounds                                                                          | Class            |
| -------------------------- | --------------- | -------------------------------------- | ------------- | --------------------------------------------------------------------------------------------- | ---------------- |
| `model`                    | `string`        | yes                                    | not published | profile model ID `dreamina-seedance-2-5-260628`; an enabled endpoint ID is also accepted      | commonGeneration |
| `content`                  | `array<object>` | yes                                    | not published | not encoded                                                                                   | commonGeneration |
| `content[].type`           | `string`        | yes                                    | not published | `{"enum":["text","image_url","video_url","audio_url","draft_task"]}`                          | commonGeneration |
| `content[].text`           | `string`        | no                                     | not published | not encoded                                                                                   | commonGeneration |
| `content[].image_url.url`  | `string`        | no                                     | not published | not encoded                                                                                   | commonGeneration |
| `content[].video_url.url`  | `string`        | no                                     | not published | not encoded                                                                                   | commonGeneration |
| `content[].audio_url.url`  | `string`        | no                                     | not published | not encoded                                                                                   | commonGeneration |
| `content[].role`           | `string`        | no                                     | not published | `{"enum":["first_frame","last_frame","reference_image","reference_video","reference_audio"]}` | commonGeneration |
| `content[].draft_task.id`  | `string`        | no                                     | not published | not encoded                                                                                   | commonGeneration |
| `omni_reference_task_type` | `string`        | no                                     | `auto`        | `{"enum":["auto","reference","edit","extend"]}`                                               | modelSpecific    |
| `resolution`               | `string`        | no                                     | `720p`        | `{"enum":["480p","720p","1080p"]}`                                                            | commonGeneration |
| `ratio`                    | `string`        | no                                     | `adaptive`    | `{"enum":["16:9","4:3","1:1","3:4","9:16","21:9","adaptive"]}`                                | commonGeneration |
| `duration`                 | `integer`       | no                                     | `-1`          | `{"enum":[-1,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30]}`    | commonGeneration |
| `frames`                   | `integer`       | no                                     | not published | `{"minimum":29,"maximum":289}`                                                                | commonGeneration |
| `generate_audio`           | `boolean`       | no                                     | true          | not encoded                                                                                   | commonGeneration |
| `watermark`                | `boolean`       | no                                     | false         | not encoded                                                                                   | commonGeneration |
| `output_format`            | `string`        | no                                     | `mp4`         | `{"enum":["mp4","mov"]}`                                                                      | commonGeneration |
| `seed`                     | `integer`       | no                                     | `-1`          | `{"minimum":-1,"maximum":2147483647}`                                                         | commonGeneration |
| `camera_fixed`             | `boolean`       | no                                     | false         | not encoded                                                                                   | modelSpecific    |
| `return_last_frame`        | `boolean`       | no                                     | false         | not encoded                                                                                   | commonGeneration |
| `draft`                    | `boolean`       | no                                     | false         | not encoded                                                                                   | modelSpecific    |
| `service_tier`             | `string`        | no                                     | `default`     | `{"enum":["default","flex"]}`                                                                 | brokerTransport  |
| `callback_url`             | `string`        | no                                     | not published | not encoded                                                                                   | brokerTransport  |
| `execution_expires_after`  | `integer`       | no                                     | `172800`      | `{"minimum":3600,"maximum":259200}`                                                           | brokerTransport  |
| `priority`                 | `integer`       | no                                     | `0`           | `{"minimum":0,"maximum":9}`                                                                   | brokerTransport  |
| `safety_identifier`        | `string`        | no                                     | not published | `{"maxLength":64}`                                                                            | brokerTransport  |
| `content[].image_url`      | `object`        | conditional: content[].type=image_url  | not published | not encoded                                                                                   | commonGeneration |
| `content[].video_url`      | `object`        | conditional: content[].type=video_url  | not published | not encoded                                                                                   | commonGeneration |
| `content[].audio_url`      | `object`        | conditional: content[].type=audio_url  | not published | not encoded                                                                                   | commonGeneration |
| `content[].draft_task`     | `object`        | conditional: content[].type=draft_task | not published | not encoded                                                                                   | commonGeneration |

### Native media and combination rules

| Property                | Seedance 2.5                                                                               | Seedance 2.0 / Fast / Mini                         |
| ----------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Reference images        | ≤30; combined omni ≤50                                                                     | ≤9; combined omni ≤12                              |
| Reference videos        | ≤10; each 2–30s, edit source 4–30s; total ≤30s                                             | ≤3; each 2–15s; total ≤15s                         |
| Reference audio         | ≤10; each 2–30s; total ≤30s                                                                | ≤3; each 2–15s; total ≤15s; cannot be audio-only   |
| Image files             | JPEG/PNG/WebP/BMP/TIFF/GIF/HEIC/HEIF; **<30MB**, each side 300–6000px, ratio 0.4–2.5       | same documented family limits                      |
| Video files             | MP4/MOV, H.264/H.265; ≤200MB; 24–60fps; each side 300–6000px and total 407,696–8,295,044px | same spatial/file limits; shorter time budget      |
| Audio files             | WAV/MP3; ≤15MB each                                                                        | same file limit                                    |
| Request body            | ≤64MB                                                                                      | ≤64MB                                              |
| Strict first/last mode  | one first, optional one last; cannot mix omni roles                                        | same exclusivity                                   |
| Output ratio default    | adaptive; first-frame/edit/extend cannot override source framing                           | adaptive, with explicit ratios also supported      |
| Output duration default | smart `-1`; explicit 4–30s for generation                                                  | 5s; explicit 4–15s or smart `-1`                   |
| Resolution              | 480p/720p/1080p, default 720p                                                              | Standard: 480p/720p/1080p/4k; Fast/Mini: 480p/720p |

The create-reference and tutorial differ on MOV input PCM audio support; preserve that source discrepancy. 2.5 1080p and 2.0 Standard 4K use 10-bit HEVC. The `frames` count control in the shared API belongs to older 1.0 variants, not these 2.x models. `camera_fixed` and the native `seed` supported-model lists also name older models; the 2.5 draft tutorial's seed-inheritance wording conflicts with that list.

Direct real-face uploads have provider asset-policy restrictions. Approved digital/authorized portrait assets and trusted original provider outputs have separate identity/account rules; an `asset://` URI is not a portable OpenGen upload ID. No typed negative prompt, CFG, shot list, edit time-range or camera-path parameter is published for these native 2.x schemas. Timestamp editing remains prompt-directed.

### Native 2.5 modes and state

- `omni_reference_task_type`: `auto` / `reference` / `edit` / `extend`, default `auto`. Explicit type moves validation earlier; actual prompt intent can still produce an asynchronous mismatch.
- Edit: reference video required, source 4–30s, ratio `adaptive`, duration `-1`. Extend: reference video plus extension intent, ratio `adaptive`.
- Draft: `draft=true` requires 480p. Finalization uses the original model, `content[].draft_task.id`, and required `resolution=1080p`; omit draft or set false. Prompt, assets, duration, ratio, seed, audio and task type are inherited and must not be resent.
- Finalization can change `return_last_frame`, `output_format`, `watermark`, tier, expiry, priority, provider callback and end-user identifier.
- New drafts (created from 2026-10-28 10:00 UTC+8) last 14 days; older drafts last seven. Ordinary task IDs last seven days. Output links last 24h with a 100-download ceiling.
- Provider callbacks, priority 0–9, expiry 3600–259200s (default 172800), and `safety_identifier` ≤64 characters are execution/account controls. `service_tier=flex` is not supported by these 2.x models even though the shared endpoint describes it.

## fal exact request schemas

Every table below comes from its endpoint's public queue OpenAPI, not from the existing OpenGen adapter. Current schemas add explicit US endpoints, Mini endpoints, 1080p for 2.5 and draft completion. Some documented offerings are account-gated. US/global drafting has different retention. The native provider limits are not automatically the reseller's limits.

Fal Seedance 2.5 reference mode has image/video/audio arrays with 30/10/10 maxima and a 50-file total; video/audio prose tolerates 1.8–30.2s and a 30.2s combined budget. `task=editing` forces duration/ratio to auto; `extension` forces ratio to auto. Fal 2.0 reference video prose instead has three clips, 2–15s combined, **<50MB total** and an approximate 640×640–834×1112 resolution band. Its audio references need an image/video. These are narrower than merely forwarding the native API.

The small formal schemas often omit these cross-field bounds. Defaults and required fields in the tables remain the literal formal values; the JSON's `constraints` and `mediaLimits` hold the extra prose rules.

### `alibaba/wan-3.0-prime/image-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=alibaba%2Fwan-3.0-prime%2Fimage-to-video) · [API page](https://fal.ai/models/alibaba/wan-3.0-prime/image-to-video/api)

| Provider field            | Type                           | Required | Default       | Enum / formal bounds                                    | Class            |
| ------------------------- | ------------------------------ | -------- | ------------- | ------------------------------------------------------- | ---------------- |
| `start_image_url`         | `string`                       | yes      | not published | not encoded                                             | commonGeneration |
| `end_image_url`           | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                             | commonGeneration |
| `prompt`                  | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                             | commonGeneration |
| `enable_prompt_expansion` | `boolean`                      | no       | true          | not encoded                                             | modelSpecific    |
| `enable_safety_checker`   | `boolean`                      | no       | true          | not encoded                                             | modelSpecific    |
| `aspect_ratio`            | `string`                       | no       | `adaptive`    | `{"enum":["adaptive","16:9","4:3","1:1","3:4","9:16"]}` | commonGeneration |
| `enable_thinking`         | `boolean`                      | no       | false         | not encoded                                             | modelSpecific    |
| `resolution`              | `string`                       | no       | `1080p`       | `{"enum":["480p","720p","1080p"]}`                      | commonGeneration |
| `audio`                   | `boolean`                      | no       | true          | not encoded                                             | commonGeneration |
| `duration`                | `{"anyOf":["integer","null"]}` | no       | `5`           | not encoded                                             | commonGeneration |
| `seed`                    | `{"anyOf":["integer","null"]}` | no       | not published | not encoded                                             | commonGeneration |

### `alibaba/wan-3.0-prime/reference-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=alibaba%2Fwan-3.0-prime%2Freference-to-video) · [API page](https://fal.ai/models/alibaba/wan-3.0-prime/reference-to-video/api)

| Provider field            | Type                           | Required | Default       | Enum / formal bounds                                    | Class            |
| ------------------------- | ------------------------------ | -------- | ------------- | ------------------------------------------------------- | ---------------- |
| `resolution`              | `string`                       | no       | `1080p`       | `{"enum":["480p","720p","1080p"]}`                      | commonGeneration |
| `reference_video_urls`    | `array`                        | no       | not published | `{"maxItems":5}`                                        | commonGeneration |
| `enable_prompt_expansion` | `boolean`                      | no       | true          | not encoded                                             | modelSpecific    |
| `web_url`                 | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                             | commonGeneration |
| `prompt`                  | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                             | commonGeneration |
| `file_url`                | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                             | commonGeneration |
| `enable_safety_checker`   | `boolean`                      | no       | true          | not encoded                                             | modelSpecific    |
| `aspect_ratio`            | `string`                       | no       | `adaptive`    | `{"enum":["adaptive","16:9","4:3","1:1","3:4","9:16"]}` | commonGeneration |
| `enable_thinking`         | `boolean`                      | no       | false         | not encoded                                             | modelSpecific    |
| `reference_audio_urls`    | `array`                        | no       | not published | `{"maxItems":5}`                                        | commonGeneration |
| `reference_image_urls`    | `array`                        | no       | not published | `{"maxItems":10}`                                       | commonGeneration |
| `audio`                   | `boolean`                      | no       | true          | not encoded                                             | commonGeneration |
| `duration`                | `{"anyOf":["integer","null"]}` | no       | `5`           | not encoded                                             | commonGeneration |
| `seed`                    | `{"anyOf":["integer","null"]}` | no       | not published | not encoded                                             | commonGeneration |

### `alibaba/wan-3.0-prime/text-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=alibaba%2Fwan-3.0-prime%2Ftext-to-video) · [API page](https://fal.ai/models/alibaba/wan-3.0-prime/text-to-video/api)

| Provider field            | Type                           | Required | Default       | Enum / formal bounds                                    | Class            |
| ------------------------- | ------------------------------ | -------- | ------------- | ------------------------------------------------------- | ---------------- |
| `enable_prompt_expansion` | `boolean`                      | no       | true          | not encoded                                             | modelSpecific    |
| `prompt`                  | `string`                       | yes      | not published | `{"minLength":1,"maxLength":20000}`                     | commonGeneration |
| `enable_safety_checker`   | `boolean`                      | no       | true          | not encoded                                             | modelSpecific    |
| `aspect_ratio`            | `string`                       | no       | `adaptive`    | `{"enum":["adaptive","16:9","4:3","1:1","3:4","9:16"]}` | commonGeneration |
| `enable_thinking`         | `boolean`                      | no       | false         | not encoded                                             | modelSpecific    |
| `resolution`              | `string`                       | no       | `1080p`       | `{"enum":["480p","720p","1080p"]}`                      | commonGeneration |
| `audio`                   | `boolean`                      | no       | true          | not encoded                                             | commonGeneration |
| `duration`                | `{"anyOf":["integer","null"]}` | no       | `5`           | not encoded                                             | commonGeneration |
| `seed`                    | `{"anyOf":["integer","null"]}` | no       | not published | not encoded                                             | commonGeneration |

### `alibaba/wan-3.0/image-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=alibaba%2Fwan-3.0%2Fimage-to-video) · [API page](https://fal.ai/models/alibaba/wan-3.0/image-to-video/api)

| Provider field            | Type                           | Required | Default       | Enum / formal bounds                                    | Class            |
| ------------------------- | ------------------------------ | -------- | ------------- | ------------------------------------------------------- | ---------------- |
| `duration`                | `{"anyOf":["integer","null"]}` | no       | `5`           | not encoded                                             | commonGeneration |
| `resolution`              | `string`                       | no       | `1080p`       | `{"enum":["480p","720p","1080p"]}`                      | commonGeneration |
| `seed`                    | `{"anyOf":["integer","null"]}` | no       | not published | not encoded                                             | commonGeneration |
| `start_image_url`         | `string`                       | yes      | not published | not encoded                                             | commonGeneration |
| `enable_safety_checker`   | `boolean`                      | no       | true          | not encoded                                             | modelSpecific    |
| `prompt`                  | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                             | commonGeneration |
| `enable_prompt_expansion` | `boolean`                      | no       | true          | not encoded                                             | modelSpecific    |
| `audio`                   | `boolean`                      | no       | true          | not encoded                                             | commonGeneration |
| `end_image_url`           | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                             | commonGeneration |
| `enable_thinking`         | `boolean`                      | no       | false         | not encoded                                             | modelSpecific    |
| `aspect_ratio`            | `string`                       | no       | `adaptive`    | `{"enum":["adaptive","16:9","4:3","1:1","3:4","9:16"]}` | commonGeneration |

### `alibaba/wan-3.0/reference-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=alibaba%2Fwan-3.0%2Freference-to-video) · [API page](https://fal.ai/models/alibaba/wan-3.0/reference-to-video/api)

| Provider field            | Type                           | Required | Default       | Enum / formal bounds                                    | Class            |
| ------------------------- | ------------------------------ | -------- | ------------- | ------------------------------------------------------- | ---------------- |
| `file_url`                | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                             | commonGeneration |
| `resolution`              | `string`                       | no       | `1080p`       | `{"enum":["480p","720p","1080p"]}`                      | commonGeneration |
| `seed`                    | `{"anyOf":["integer","null"]}` | no       | not published | not encoded                                             | commonGeneration |
| `duration`                | `{"anyOf":["integer","null"]}` | no       | `5`           | not encoded                                             | commonGeneration |
| `enable_safety_checker`   | `boolean`                      | no       | true          | not encoded                                             | modelSpecific    |
| `reference_video_urls`    | `array`                        | no       | not published | `{"maxItems":5}`                                        | commonGeneration |
| `reference_audio_urls`    | `array`                        | no       | not published | `{"maxItems":5}`                                        | commonGeneration |
| `prompt`                  | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                             | commonGeneration |
| `enable_prompt_expansion` | `boolean`                      | no       | true          | not encoded                                             | modelSpecific    |
| `audio`                   | `boolean`                      | no       | true          | not encoded                                             | commonGeneration |
| `enable_thinking`         | `boolean`                      | no       | false         | not encoded                                             | modelSpecific    |
| `web_url`                 | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                             | commonGeneration |
| `reference_image_urls`    | `array`                        | no       | not published | `{"maxItems":10}`                                       | commonGeneration |
| `aspect_ratio`            | `string`                       | no       | `adaptive`    | `{"enum":["adaptive","16:9","4:3","1:1","3:4","9:16"]}` | commonGeneration |

### `alibaba/wan-3.0/text-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=alibaba%2Fwan-3.0%2Ftext-to-video) · [API page](https://fal.ai/models/alibaba/wan-3.0/text-to-video/api)

| Provider field            | Type                           | Required | Default       | Enum / formal bounds                                    | Class            |
| ------------------------- | ------------------------------ | -------- | ------------- | ------------------------------------------------------- | ---------------- |
| `duration`                | `{"anyOf":["integer","null"]}` | no       | `5`           | not encoded                                             | commonGeneration |
| `resolution`              | `string`                       | no       | `1080p`       | `{"enum":["480p","720p","1080p"]}`                      | commonGeneration |
| `seed`                    | `{"anyOf":["integer","null"]}` | no       | not published | not encoded                                             | commonGeneration |
| `enable_safety_checker`   | `boolean`                      | no       | true          | not encoded                                             | modelSpecific    |
| `prompt`                  | `string`                       | yes      | not published | `{"minLength":1,"maxLength":20000}`                     | commonGeneration |
| `enable_prompt_expansion` | `boolean`                      | no       | true          | not encoded                                             | modelSpecific    |
| `audio`                   | `boolean`                      | no       | true          | not encoded                                             | commonGeneration |
| `enable_thinking`         | `boolean`                      | no       | false         | not encoded                                             | modelSpecific    |
| `aspect_ratio`            | `string`                       | no       | `adaptive`    | `{"enum":["adaptive","16:9","4:3","1:1","3:4","9:16"]}` | commonGeneration |

### `bytedance/seedance-2.0/fast/image-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Ffast%2Fimage-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.0/fast/image-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                      | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------- | ---------------- |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `image_url`      | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | brokerTransport  |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15"]}` | commonGeneration |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                         | modelSpecific    |
| `end_image_url`  | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | commonGeneration |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p"]}`                                                | commonGeneration |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                               | commonGeneration |
| `bitrate_mode`   | `string`                      | no       | `standard`    | `{"enum":["standard","high"]}`                                            | modelSpecific    |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                | commonGeneration |

### `bytedance/seedance-2.0/fast/reference-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Ffast%2Freference-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.0/fast/reference-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                      | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------- | ---------------- |
| `video_urls`     | `array`                       | no       | not published | `{"maxItems":3}`                                                          | commonGeneration |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | brokerTransport  |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                         | modelSpecific    |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15"]}` | commonGeneration |
| `image_urls`     | `array`                       | no       | not published | `{"maxItems":9}`                                                          | commonGeneration |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p"]}`                                                | commonGeneration |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                               | commonGeneration |
| `bitrate_mode`   | `string`                      | no       | `standard`    | `{"enum":["standard","high"]}`                                            | modelSpecific    |
| `audio_urls`     | `array`                       | no       | not published | `{"maxItems":3}`                                                          | commonGeneration |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                | commonGeneration |

### `bytedance/seedance-2.0/fast/text-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Ffast%2Ftext-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                      | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------- | ---------------- |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | brokerTransport  |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                         | modelSpecific    |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15"]}` | commonGeneration |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p"]}`                                                | commonGeneration |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                | commonGeneration |
| `bitrate_mode`   | `string`                      | no       | `standard`    | `{"enum":["standard","high"]}`                                            | modelSpecific    |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                               | commonGeneration |

### `bytedance/seedance-2.0/image-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Fimage-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.0/image-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                      | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------- | ---------------- |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `image_url`      | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | brokerTransport  |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15"]}` | commonGeneration |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                         | modelSpecific    |
| `end_image_url`  | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | commonGeneration |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p","1080p","4k"]}`                                   | commonGeneration |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                               | commonGeneration |
| `bitrate_mode`   | `string`                      | no       | `standard`    | `{"enum":["standard","high"]}`                                            | modelSpecific    |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                | commonGeneration |

### `bytedance/seedance-2.0/mini/image-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Fmini%2Fimage-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.0/mini/image-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                      | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------- | ---------------- |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `image_url`      | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | brokerTransport  |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15"]}` | commonGeneration |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                         | modelSpecific    |
| `end_image_url`  | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | commonGeneration |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p"]}`                                                | commonGeneration |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                               | commonGeneration |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                | commonGeneration |

### `bytedance/seedance-2.0/mini/reference-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Fmini%2Freference-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.0/mini/reference-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                      | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------- | ---------------- |
| `video_urls`     | `array`                       | no       | not published | `{"maxItems":3}`                                                          | commonGeneration |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | brokerTransport  |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                         | modelSpecific    |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15"]}` | commonGeneration |
| `image_urls`     | `array`                       | no       | not published | `{"maxItems":9}`                                                          | commonGeneration |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p"]}`                                                | commonGeneration |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                               | commonGeneration |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                | commonGeneration |
| `audio_urls`     | `array`                       | no       | not published | `{"maxItems":3}`                                                          | commonGeneration |

### `bytedance/seedance-2.0/mini/text-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Fmini%2Ftext-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.0/mini/text-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                      | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------- | ---------------- |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                               | commonGeneration |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p"]}`                                                | commonGeneration |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | brokerTransport  |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15"]}` | commonGeneration |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                         | modelSpecific    |

### `bytedance/seedance-2.0/reference-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Freference-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.0/reference-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                      | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------- | ---------------- |
| `video_urls`     | `array`                       | no       | not published | `{"maxItems":3}`                                                          | commonGeneration |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | brokerTransport  |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                         | modelSpecific    |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15"]}` | commonGeneration |
| `image_urls`     | `array`                       | no       | not published | `{"maxItems":9}`                                                          | commonGeneration |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p","1080p","4k"]}`                                   | commonGeneration |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                               | commonGeneration |
| `bitrate_mode`   | `string`                      | no       | `standard`    | `{"enum":["standard","high"]}`                                            | modelSpecific    |
| `audio_urls`     | `array`                       | no       | not published | `{"maxItems":3}`                                                          | commonGeneration |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                | commonGeneration |

### `bytedance/seedance-2.0/text-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Ftext-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.0/text-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                      | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------- | ---------------- |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | brokerTransport  |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                         | modelSpecific    |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15"]}` | commonGeneration |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p","1080p","4k"]}`                                   | commonGeneration |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                | commonGeneration |
| `bitrate_mode`   | `string`                      | no       | `standard`    | `{"enum":["standard","high"]}`                                            | modelSpecific    |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                               | commonGeneration |

### `bytedance/seedance-2.0/us/image-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Fus%2Fimage-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.0/us/image-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                      | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------- | ---------------- |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `image_url`      | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | brokerTransport  |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15"]}` | commonGeneration |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                         | modelSpecific    |
| `end_image_url`  | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | commonGeneration |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p","1080p","4k"]}`                                   | commonGeneration |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                               | commonGeneration |
| `bitrate_mode`   | `string`                      | no       | `standard`    | `{"enum":["standard","high"]}`                                            | modelSpecific    |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                | commonGeneration |

### `bytedance/seedance-2.0/us/reference-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Fus%2Freference-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.0/us/reference-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                      | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------- | ---------------- |
| `video_urls`     | `array`                       | no       | not published | `{"maxItems":3}`                                                          | commonGeneration |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | brokerTransport  |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                         | modelSpecific    |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15"]}` | commonGeneration |
| `image_urls`     | `array`                       | no       | not published | `{"maxItems":9}`                                                          | commonGeneration |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p","1080p","4k"]}`                                   | commonGeneration |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                               | commonGeneration |
| `bitrate_mode`   | `string`                      | no       | `standard`    | `{"enum":["standard","high"]}`                                            | modelSpecific    |
| `audio_urls`     | `array`                       | no       | not published | `{"maxItems":3}`                                                          | commonGeneration |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                | commonGeneration |

### `bytedance/seedance-2.0/us/text-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.0%2Fus%2Ftext-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.0/us/text-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                      | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ------------------------------------------------------------------------- | ---------------- |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                               | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                               | brokerTransport  |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                         | modelSpecific    |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15"]}` | commonGeneration |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p","1080p","4k"]}`                                   | commonGeneration |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                | commonGeneration |
| `bitrate_mode`   | `string`                      | no       | `standard`    | `{"enum":["standard","high"]}`                                            | modelSpecific    |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                               | commonGeneration |

### `bytedance/seedance-2.5/draft/complete`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.5%2Fdraft%2Fcomplete) · [API page](https://fal.ai/models/bytedance/seedance-2.5/draft/complete/api)

| Provider field | Type     | Required | Default       | Enum / formal bounds               | Class            |
| -------------- | -------- | -------- | ------------- | ---------------------------------- | ---------------- |
| `draft_id`     | `string` | yes      | not published | `{"minLength":1,"maxLength":8192}` | modelSpecific    |
| `codec`        | `string` | no       | `auto`        | `{"enum":["auto","H264","H265"]}`  | modelSpecific    |
| `resolution`   | `string` | no       | `1080p`       | `{"const":"1080p"}`                | commonGeneration |

### `bytedance/seedance-2.5/image-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.5%2Fimage-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.5/image-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                                                                                                 | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                                                                                                    | modelSpecific    |
| `image_url`      | `string`                      | yes      | not published | not encoded                                                                                                                                          | commonGeneration |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                                                                                                          | commonGeneration |
| `end_image_url`  | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                                                                                                          | commonGeneration |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"const":"auto"}`                                                                                                                                   | commonGeneration |
| `draft`          | `boolean`                     | no       | false         | not encoded                                                                                                                                          | modelSpecific    |
| `prompt`         | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                                                                                                          | commonGeneration |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]}` | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                                                                                                          | brokerTransport  |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p","1080p"]}`                                                                                                                   | commonGeneration |
| `bitrate_mode`   | `string`                      | no       | `standard`    | `{"enum":["standard","high"]}`                                                                                                                       | modelSpecific    |

### `bytedance/seedance-2.5/reference-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.5%2Freference-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.5/reference-to-video/api)

| Provider field   | Type                           | Required | Default       | Enum / formal bounds                                                                                                                                 | Class            |
| ---------------- | ------------------------------ | -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `codec`          | `string`                       | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                                                                                                    | modelSpecific    |
| `bitrate_mode`   | `string`                       | no       | `standard`    | `{"enum":["standard","high"]}`                                                                                                                       | modelSpecific    |
| `task`           | `string`                       | no       | `reference`   | `{"enum":["auto","reference","editing","extension"]}`                                                                                                | modelSpecific    |
| `video_urls`     | `array`                        | no       | not published | not encoded                                                                                                                                          | commonGeneration |
| `generate_audio` | `boolean`                      | no       | true          | not encoded                                                                                                                                          | commonGeneration |
| `draft`          | `boolean`                      | no       | false         | not encoded                                                                                                                                          | modelSpecific    |
| `seed`           | `{"anyOf":["integer","null"]}` | no       | not published | not encoded                                                                                                                                          | commonGeneration |
| `prompt`         | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                                                                                                                          | commonGeneration |
| `audio_urls`     | `array`                        | no       | not published | not encoded                                                                                                                                          | commonGeneration |
| `aspect_ratio`   | `string`                       | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                                                                                           | commonGeneration |
| `duration`       | `string`                       | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]}` | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                                                                                                                          | brokerTransport  |
| `resolution`     | `string`                       | no       | `720p`        | `{"enum":["480p","720p","1080p"]}`                                                                                                                   | commonGeneration |
| `image_urls`     | `array`                        | no       | not published | not encoded                                                                                                                                          | commonGeneration |

### `bytedance/seedance-2.5/text-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.5%2Ftext-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.5/text-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                                                                                                 | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                                                                                                    | modelSpecific    |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                                                                                                          | commonGeneration |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                                                                                           | commonGeneration |
| `draft`          | `boolean`                     | no       | false         | not encoded                                                                                                                                          | modelSpecific    |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                                                                                                          | commonGeneration |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]}` | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                                                                                                          | brokerTransport  |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p","1080p"]}`                                                                                                                   | commonGeneration |
| `bitrate_mode`   | `string`                      | no       | `standard`    | `{"enum":["standard","high"]}`                                                                                                                       | modelSpecific    |

### `bytedance/seedance-2.5/us/draft/complete`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.5%2Fus%2Fdraft%2Fcomplete) · [API page](https://fal.ai/models/bytedance/seedance-2.5/us/draft/complete/api)

| Provider field | Type     | Required | Default       | Enum / formal bounds               | Class            |
| -------------- | -------- | -------- | ------------- | ---------------------------------- | ---------------- |
| `draft_id`     | `string` | yes      | not published | `{"minLength":1,"maxLength":8192}` | modelSpecific    |
| `codec`        | `string` | no       | `auto`        | `{"enum":["auto","H264","H265"]}`  | modelSpecific    |
| `resolution`   | `string` | no       | `1080p`       | `{"const":"1080p"}`                | commonGeneration |

### `bytedance/seedance-2.5/us/image-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.5%2Fus%2Fimage-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.5/us/image-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                                                                                                 | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                                                                                                    | modelSpecific    |
| `image_url`      | `string`                      | yes      | not published | not encoded                                                                                                                                          | commonGeneration |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                                                                                                          | commonGeneration |
| `end_image_url`  | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                                                                                                          | commonGeneration |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"const":"auto"}`                                                                                                                                   | commonGeneration |
| `draft`          | `boolean`                     | no       | false         | not encoded                                                                                                                                          | modelSpecific    |
| `prompt`         | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                                                                                                          | commonGeneration |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]}` | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                                                                                                          | brokerTransport  |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p","1080p"]}`                                                                                                                   | commonGeneration |
| `bitrate_mode`   | `string`                      | no       | `standard`    | `{"enum":["standard","high"]}`                                                                                                                       | modelSpecific    |

### `bytedance/seedance-2.5/us/reference-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.5%2Fus%2Freference-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.5/us/reference-to-video/api)

| Provider field   | Type                           | Required | Default       | Enum / formal bounds                                                                                                                                 | Class            |
| ---------------- | ------------------------------ | -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `codec`          | `string`                       | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                                                                                                    | modelSpecific    |
| `bitrate_mode`   | `string`                       | no       | `standard`    | `{"enum":["standard","high"]}`                                                                                                                       | modelSpecific    |
| `task`           | `string`                       | no       | `reference`   | `{"enum":["auto","reference","editing","extension"]}`                                                                                                | modelSpecific    |
| `video_urls`     | `array`                        | no       | not published | not encoded                                                                                                                                          | commonGeneration |
| `generate_audio` | `boolean`                      | no       | true          | not encoded                                                                                                                                          | commonGeneration |
| `draft`          | `boolean`                      | no       | false         | not encoded                                                                                                                                          | modelSpecific    |
| `seed`           | `{"anyOf":["integer","null"]}` | no       | not published | not encoded                                                                                                                                          | commonGeneration |
| `prompt`         | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                                                                                                                          | commonGeneration |
| `audio_urls`     | `array`                        | no       | not published | not encoded                                                                                                                                          | commonGeneration |
| `aspect_ratio`   | `string`                       | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                                                                                           | commonGeneration |
| `duration`       | `string`                       | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]}` | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}`  | no       | not published | not encoded                                                                                                                                          | brokerTransport  |
| `resolution`     | `string`                       | no       | `720p`        | `{"enum":["480p","720p","1080p"]}`                                                                                                                   | commonGeneration |
| `image_urls`     | `array`                        | no       | not published | not encoded                                                                                                                                          | commonGeneration |

### `bytedance/seedance-2.5/us/text-to-video`

[Public schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.5%2Fus%2Ftext-to-video) · [API page](https://fal.ai/models/bytedance/seedance-2.5/us/text-to-video/api)

| Provider field   | Type                          | Required | Default       | Enum / formal bounds                                                                                                                                 | Class            |
| ---------------- | ----------------------------- | -------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `codec`          | `string`                      | no       | `auto`        | `{"enum":["auto","H264","H265"]}`                                                                                                                    | modelSpecific    |
| `generate_audio` | `boolean`                     | no       | true          | not encoded                                                                                                                                          | commonGeneration |
| `aspect_ratio`   | `string`                      | no       | `auto`        | `{"enum":["auto","21:9","16:9","4:3","1:1","3:4","9:16"]}`                                                                                           | commonGeneration |
| `draft`          | `boolean`                     | no       | false         | not encoded                                                                                                                                          | modelSpecific    |
| `prompt`         | `string`                      | yes      | not published | not encoded                                                                                                                                          | commonGeneration |
| `duration`       | `string`                      | no       | `auto`        | `{"enum":["auto","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"]}` | commonGeneration |
| `end_user_id`    | `{"anyOf":["string","null"]}` | no       | not published | not encoded                                                                                                                                          | brokerTransport  |
| `resolution`     | `string`                      | no       | `720p`        | `{"enum":["480p","720p","1080p"]}`                                                                                                                   | commonGeneration |
| `bitrate_mode`   | `string`                      | no       | `standard`    | `{"enum":["standard","high"]}`                                                                                                                       | modelSpecific    |

## Runway exact model branches

Primary references: [full API OAS](https://docs.dev.runwayml.com/api/), [input restrictions](https://docs.dev.runwayml.com/assets/inputs/), [Kling 4 guide](https://dev.runwayml.com/learn/kling-4-0-api). The API page embeds a real OpenAPI document; the audit extracted the exact `kling_4`, `seedance2_5`, `seedance2`, `seedance2_fast`, and `seedance2_mini` branches rather than applying another model's schema.

Generic transport ceilings are **16MB image URL**, **32MB video/audio URL**, **5MB encoded data URI**, and **200MB ephemeral upload** (minimum 512 bytes, URI lasts 24h). These are transport limits, not proof that a model accepts the maximum payload. HTTPS domain URLs need HEAD, exact Content-Type/Content-Length, ≤2048 characters and no redirect. Images are JPEG/PNG/WebP, not GIF. The input guide lists modern and discouraged video codecs separately; full transport encodings are summarized below.

- MP4/MOV: H.264/H.265/AV1; MOV also ProRes variants.
- MKV/WebM: VP8/VP9/AV1 (MKV also H.264/H.265); 3GP H.264; Ogg Theora.
- Discouraged legacy options include MJPEG, MPEG2, AVI/Flash variants. A model-specific limitation still takes precedence.

Kling uses one first, at most eight middle and one last frame, and **keyframes + image references ≤10**. Reference videos are ≤5 and ≤30s combined. One guide says each ≥3s; the input page says 3–31s with clips above 30s trimmed, 24–60fps and ≥700px/side. Use a conservative ≤30s clip ceiling until verified. Images need ≥300px/side and ratio 0.4–2.5. Native audio is always on; no negative-prompt/CFG/seed/audio-off field is in the strict Kling 4 branch. Do not inherit Kling 3 fields.

Kling prompt budget is 26,000 English or 11,000 non-English characters, with a mixed-script budget whose exact weighting is not specified. I2V frame-only input may omit text; references require it. V2V keeps source duration/framing and has no duration parameter. Defaults from the prose guide are 5s, landscape 720p.

Seedance Runway contracts differ from native/fal: prompts are ≤15,000 characters for 2.5 and ≤3500 for 2.0 variants, seed is 0–2³²−1, and resolution is encoded as a pixel `ratio` enum. 2.0 Standard's 4K pixel enum differs from BytePlus's native dimension table. `auto` duration is initially billed at variant maximum and reconciled afterward. First/last and unpositioned image-reference modes cannot mix; audio references cannot accompany strict first/last mode. 2.5 edit/extend prohibit ratio, edit requires duration `auto`, and the source determines the output size tier. Draft completion lasts seven days and is MP4-only. OAS requires a T2V prompt even though `draftTaskId` says other generation fields are forbidden—this is a conditional-schema gap, not permission to resend a prompt.

### `seedance2` · text-to-video

`POST https://api.dev.runwayml.com/v1/text_to_video` · [Schema snapshot](schemas/group1/runway-seedance2-text-to-video.json)

| Provider field           | Type                                     | Required                         | Default       | Enum / formal bounds                                                                                                                                                                                                                                                                     | Class            |
| ------------------------ | ---------------------------------------- | -------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `promptText`             | `string`                                 | yes                              | not published | `{"minLength":1,"maxLength":3500}`                                                                                                                                                                                                                                                       | commonGeneration |
| `audio`                  | `boolean`                                | no                               | true          | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `seed`                   | `integer`                                | no                               | not published | `{"minimum":0,"maximum":4294967295}`                                                                                                                                                                                                                                                     | commonGeneration |
| `bitrate`                | `string`                                 | no                               | `standard`    | `{"enum":["standard","high"]}`                                                                                                                                                                                                                                                           | modelSpecific    |
| `duration`               | `{"anyOf":["integer","string"]}`         | no                               | not published | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `ratio`                  | `string`                                 | no                               | not published | `{"enum":["992:432","864:496","752:560","640:640","560:752","496:864","1470:630","1280:720","1112:834","960:960","834:1112","720:1280","2206:946","1920:1080","1664:1248","1440:1440","1248:1664","1080:1920","3840:1646","3840:2160","3840:2880","3840:3840","2880:3840","2160:3840"]}` | commonGeneration |
| `references`             | `array`                                  | no                               | not published | `{"maxItems":9}`                                                                                                                                                                                                                                                                         | commonGeneration |
| `references[].uri`       | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `referenceVideos`        | `array`                                  | no                               | not published | `{"maxItems":3}`                                                                                                                                                                                                                                                                         | commonGeneration |
| `referenceVideos[].type` | `string`                                 | yes (when parent branch applies) | not published | `{"const":"video"}`                                                                                                                                                                                                                                                                      | commonGeneration |
| `referenceVideos[].uri`  | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `referenceAudio`         | `array`                                  | no                               | not published | `{"maxItems":3}`                                                                                                                                                                                                                                                                         | commonGeneration |
| `referenceAudio[].type`  | `string`                                 | yes (when parent branch applies) | not published | `{"const":"audio"}`                                                                                                                                                                                                                                                                      | commonGeneration |
| `referenceAudio[].uri`   | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `model`                  | `string`                                 | yes                              | not published | `{"const":"seedance2"}`                                                                                                                                                                                                                                                                  | commonGeneration |

### `seedance2_fast` · text-to-video

`POST https://api.dev.runwayml.com/v1/text_to_video` · [Schema snapshot](schemas/group1/runway-seedance2_fast-text-to-video.json)

| Provider field           | Type                                     | Required                         | Default       | Enum / formal bounds                                                                                                                      | Class            |
| ------------------------ | ---------------------------------------- | -------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `promptText`             | `string`                                 | yes                              | not published | `{"minLength":1,"maxLength":3500}`                                                                                                        | commonGeneration |
| `audio`                  | `boolean`                                | no                               | true          | not encoded                                                                                                                               | commonGeneration |
| `seed`                   | `integer`                                | no                               | not published | `{"minimum":0,"maximum":4294967295}`                                                                                                      | commonGeneration |
| `bitrate`                | `string`                                 | no                               | `standard`    | `{"enum":["standard","high"]}`                                                                                                            | modelSpecific    |
| `duration`               | `{"anyOf":["integer","string"]}`         | no                               | not published | not encoded                                                                                                                               | commonGeneration |
| `ratio`                  | `string`                                 | no                               | not published | `{"enum":["992:432","864:496","752:560","640:640","560:752","496:864","1470:630","1280:720","1112:834","960:960","834:1112","720:1280"]}` | commonGeneration |
| `references`             | `array`                                  | no                               | not published | `{"maxItems":9}`                                                                                                                          | commonGeneration |
| `references[].uri`       | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `referenceVideos`        | `array`                                  | no                               | not published | `{"maxItems":3}`                                                                                                                          | commonGeneration |
| `referenceVideos[].type` | `string`                                 | yes (when parent branch applies) | not published | `{"const":"video"}`                                                                                                                       | commonGeneration |
| `referenceVideos[].uri`  | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `referenceAudio`         | `array`                                  | no                               | not published | `{"maxItems":3}`                                                                                                                          | commonGeneration |
| `referenceAudio[].type`  | `string`                                 | yes (when parent branch applies) | not published | `{"const":"audio"}`                                                                                                                       | commonGeneration |
| `referenceAudio[].uri`   | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `model`                  | `string`                                 | yes                              | not published | `{"const":"seedance2_fast"}`                                                                                                              | commonGeneration |

### `seedance2_mini` · text-to-video

`POST https://api.dev.runwayml.com/v1/text_to_video` · [Schema snapshot](schemas/group1/runway-seedance2_mini-text-to-video.json)

| Provider field           | Type                                     | Required                         | Default       | Enum / formal bounds                                                                                                                      | Class            |
| ------------------------ | ---------------------------------------- | -------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `promptText`             | `string`                                 | yes                              | not published | `{"minLength":1,"maxLength":3500}`                                                                                                        | commonGeneration |
| `audio`                  | `boolean`                                | no                               | true          | not encoded                                                                                                                               | commonGeneration |
| `seed`                   | `integer`                                | no                               | not published | `{"minimum":0,"maximum":4294967295}`                                                                                                      | commonGeneration |
| `bitrate`                | `string`                                 | no                               | `standard`    | `{"enum":["standard","high"]}`                                                                                                            | modelSpecific    |
| `duration`               | `{"anyOf":["integer","string"]}`         | no                               | not published | not encoded                                                                                                                               | commonGeneration |
| `ratio`                  | `string`                                 | no                               | not published | `{"enum":["992:432","864:496","752:560","640:640","560:752","496:864","1470:630","1280:720","1112:834","960:960","834:1112","720:1280"]}` | commonGeneration |
| `references`             | `array`                                  | no                               | not published | `{"maxItems":9}`                                                                                                                          | commonGeneration |
| `references[].uri`       | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `referenceVideos`        | `array`                                  | no                               | not published | `{"maxItems":3}`                                                                                                                          | commonGeneration |
| `referenceVideos[].type` | `string`                                 | yes (when parent branch applies) | not published | `{"const":"video"}`                                                                                                                       | commonGeneration |
| `referenceVideos[].uri`  | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `referenceAudio`         | `array`                                  | no                               | not published | `{"maxItems":3}`                                                                                                                          | commonGeneration |
| `referenceAudio[].type`  | `string`                                 | yes (when parent branch applies) | not published | `{"const":"audio"}`                                                                                                                       | commonGeneration |
| `referenceAudio[].uri`   | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `model`                  | `string`                                 | yes                              | not published | `{"const":"seedance2_mini"}`                                                                                                              | commonGeneration |

### `seedance2_5` · text-to-video

`POST https://api.dev.runwayml.com/v1/text_to_video` · [Schema snapshot](schemas/group1/runway-seedance2_5-text-to-video.json)

| Provider field           | Type                                     | Required                         | Default       | Enum / formal bounds                                                                                                                                                                                             | Class            |
| ------------------------ | ---------------------------------------- | -------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `promptText`             | `string`                                 | no                               | not published | `{"minLength":1,"maxLength":15000}`                                                                                                                                                                              | commonGeneration |
| `audio`                  | `boolean`                                | no                               | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `seed`                   | `integer`                                | no                               | not published | `{"minimum":0,"maximum":4294967295}`                                                                                                                                                                             | commonGeneration |
| `outputFormat`           | `string`                                 | no                               | not published | `{"enum":["mp4","mov"]}`                                                                                                                                                                                         | commonGeneration |
| `duration`               | `{"anyOf":["integer","string"]}`         | no                               | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `ratio`                  | `string`                                 | no                               | not published | `{"enum":["992:432","854:480","752:560","640:640","560:752","480:854","1470:630","1280:720","1112:834","960:960","834:1112","720:1280","2206:946","1920:1080","1664:1248","1440:1440","1248:1664","1080:1920"]}` | commonGeneration |
| `references`             | `array`                                  | no                               | not published | `{"maxItems":30}`                                                                                                                                                                                                | commonGeneration |
| `references[].uri`       | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `referenceVideos`        | `array`                                  | no                               | not published | `{"maxItems":10}`                                                                                                                                                                                                | commonGeneration |
| `referenceVideos[].type` | `string`                                 | yes (when parent branch applies) | not published | `{"const":"video"}`                                                                                                                                                                                              | commonGeneration |
| `referenceVideos[].uri`  | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `referenceAudio`         | `array`                                  | no                               | not published | `{"maxItems":10}`                                                                                                                                                                                                | commonGeneration |
| `referenceAudio[].type`  | `string`                                 | yes (when parent branch applies) | not published | `{"const":"audio"}`                                                                                                                                                                                              | commonGeneration |
| `referenceAudio[].uri`   | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `draft`                  | `boolean`                                | no                               | not published | not encoded                                                                                                                                                                                                      | modelSpecific    |
| `draftTaskId`            | `string`                                 | no                               | not published | `{"pattern":"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$","format":"uuid"}`                                                                                         | modelSpecific    |
| `model`                  | `string`                                 | yes                              | not published | `{"const":"seedance2_5"}`                                                                                                                                                                                        | commonGeneration |

### `kling_4` · text-to-video

`POST https://api.dev.runwayml.com/v1/text_to_video` · [Schema snapshot](schemas/group1/runway-kling_4-text-to-video.json)

| Provider field     | Type                                     | Required                         | Default       | Enum / formal bounds                                                                                                            | Class            |
| ------------------ | ---------------------------------------- | -------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `promptText`       | `string`                                 | yes                              | not published | `{"minLength":1,"maxLength":26000}`                                                                                             | commonGeneration |
| `ratio`            | `string`                                 | no                               | not published | `{"enum":["1280:720","720:1280","940:940","1460:624","1920:1080","1080:1920","1440:1440","2200:940","auto_720p","auto_1080p"]}` | commonGeneration |
| `duration`         | `integer`                                | no                               | not published | `{"minimum":3,"maximum":30}`                                                                                                    | commonGeneration |
| `references`       | `array`                                  | no                               | not published | `{"minItems":0,"maxItems":10}`                                                                                                  | commonGeneration |
| `references[].uri` | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                     | commonGeneration |
| `referenceVideos`  | `array`                                  | no                               | not published | `{"minItems":0,"maxItems":5}`                                                                                                   | commonGeneration |
| `model`            | `string`                                 | yes                              | not published | `{"const":"kling_4"}`                                                                                                           | commonGeneration |

### `seedance2` · image-to-video

`POST https://api.dev.runwayml.com/v1/image_to_video` · [Schema snapshot](schemas/group1/runway-seedance2-image-to-video.json)

| Provider field           | Type                                                         | Required                         | Default       | Enum / formal bounds                                                                                                                                                                                                                                                                     | Class            |
| ------------------------ | ------------------------------------------------------------ | -------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `promptImage`            | `{"anyOf":[{"anyOf":["string","string","string"]},"array"]}` | yes                              | not published | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `promptImage[].uri`      | `{"anyOf":["string","string","string"]}`                     | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `promptImage[].position` | `string`                                                     | no (when parent branch applies)  | not published | `{"enum":["first","last"]}`                                                                                                                                                                                                                                                              | commonGeneration |
| `promptText`             | `string`                                                     | no                               | not published | `{"minLength":1,"maxLength":3500}`                                                                                                                                                                                                                                                       | commonGeneration |
| `audio`                  | `boolean`                                                    | no                               | true          | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `seed`                   | `integer`                                                    | no                               | not published | `{"minimum":0,"maximum":4294967295}`                                                                                                                                                                                                                                                     | commonGeneration |
| `bitrate`                | `string`                                                     | no                               | `standard`    | `{"enum":["standard","high"]}`                                                                                                                                                                                                                                                           | modelSpecific    |
| `duration`               | `{"anyOf":["integer","string"]}`                             | no                               | not published | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `ratio`                  | `string`                                                     | no                               | not published | `{"enum":["992:432","864:496","752:560","640:640","560:752","496:864","1470:630","1280:720","1112:834","960:960","834:1112","720:1280","2206:946","1920:1080","1664:1248","1440:1440","1248:1664","1080:1920","3840:1646","3840:2160","3840:2880","3840:3840","2880:3840","2160:3840"]}` | commonGeneration |
| `referenceAudio`         | `array`                                                      | no                               | not published | `{"maxItems":3}`                                                                                                                                                                                                                                                                         | commonGeneration |
| `referenceAudio[].type`  | `string`                                                     | yes (when parent branch applies) | not published | `{"const":"audio"}`                                                                                                                                                                                                                                                                      | commonGeneration |
| `referenceAudio[].uri`   | `{"anyOf":["string","string","string"]}`                     | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `model`                  | `string`                                                     | yes                              | not published | `{"const":"seedance2"}`                                                                                                                                                                                                                                                                  | commonGeneration |

### `seedance2_fast` · image-to-video

`POST https://api.dev.runwayml.com/v1/image_to_video` · [Schema snapshot](schemas/group1/runway-seedance2_fast-image-to-video.json)

| Provider field           | Type                                                         | Required                         | Default       | Enum / formal bounds                                                                                                                      | Class            |
| ------------------------ | ------------------------------------------------------------ | -------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `promptImage`            | `{"anyOf":[{"anyOf":["string","string","string"]},"array"]}` | yes                              | not published | not encoded                                                                                                                               | commonGeneration |
| `promptImage[].uri`      | `{"anyOf":["string","string","string"]}`                     | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `promptImage[].position` | `string`                                                     | no (when parent branch applies)  | not published | `{"enum":["first","last"]}`                                                                                                               | commonGeneration |
| `promptText`             | `string`                                                     | no                               | not published | `{"minLength":1,"maxLength":3500}`                                                                                                        | commonGeneration |
| `audio`                  | `boolean`                                                    | no                               | true          | not encoded                                                                                                                               | commonGeneration |
| `seed`                   | `integer`                                                    | no                               | not published | `{"minimum":0,"maximum":4294967295}`                                                                                                      | commonGeneration |
| `bitrate`                | `string`                                                     | no                               | `standard`    | `{"enum":["standard","high"]}`                                                                                                            | modelSpecific    |
| `duration`               | `{"anyOf":["integer","string"]}`                             | no                               | not published | not encoded                                                                                                                               | commonGeneration |
| `ratio`                  | `string`                                                     | no                               | not published | `{"enum":["992:432","864:496","752:560","640:640","560:752","496:864","1470:630","1280:720","1112:834","960:960","834:1112","720:1280"]}` | commonGeneration |
| `referenceAudio`         | `array`                                                      | no                               | not published | `{"maxItems":3}`                                                                                                                          | commonGeneration |
| `referenceAudio[].type`  | `string`                                                     | yes (when parent branch applies) | not published | `{"const":"audio"}`                                                                                                                       | commonGeneration |
| `referenceAudio[].uri`   | `{"anyOf":["string","string","string"]}`                     | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `model`                  | `string`                                                     | yes                              | not published | `{"const":"seedance2_fast"}`                                                                                                              | commonGeneration |

### `seedance2_mini` · image-to-video

`POST https://api.dev.runwayml.com/v1/image_to_video` · [Schema snapshot](schemas/group1/runway-seedance2_mini-image-to-video.json)

| Provider field           | Type                                                         | Required                         | Default       | Enum / formal bounds                                                                                                                      | Class            |
| ------------------------ | ------------------------------------------------------------ | -------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `promptImage`            | `{"anyOf":[{"anyOf":["string","string","string"]},"array"]}` | yes                              | not published | not encoded                                                                                                                               | commonGeneration |
| `promptImage[].uri`      | `{"anyOf":["string","string","string"]}`                     | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `promptImage[].position` | `string`                                                     | no (when parent branch applies)  | not published | `{"enum":["first","last"]}`                                                                                                               | commonGeneration |
| `promptText`             | `string`                                                     | no                               | not published | `{"minLength":1,"maxLength":3500}`                                                                                                        | commonGeneration |
| `audio`                  | `boolean`                                                    | no                               | true          | not encoded                                                                                                                               | commonGeneration |
| `seed`                   | `integer`                                                    | no                               | not published | `{"minimum":0,"maximum":4294967295}`                                                                                                      | commonGeneration |
| `bitrate`                | `string`                                                     | no                               | `standard`    | `{"enum":["standard","high"]}`                                                                                                            | modelSpecific    |
| `duration`               | `{"anyOf":["integer","string"]}`                             | no                               | not published | not encoded                                                                                                                               | commonGeneration |
| `ratio`                  | `string`                                                     | no                               | not published | `{"enum":["992:432","864:496","752:560","640:640","560:752","496:864","1470:630","1280:720","1112:834","960:960","834:1112","720:1280"]}` | commonGeneration |
| `referenceAudio`         | `array`                                                      | no                               | not published | `{"maxItems":3}`                                                                                                                          | commonGeneration |
| `referenceAudio[].type`  | `string`                                                     | yes (when parent branch applies) | not published | `{"const":"audio"}`                                                                                                                       | commonGeneration |
| `referenceAudio[].uri`   | `{"anyOf":["string","string","string"]}`                     | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `model`                  | `string`                                                     | yes                              | not published | `{"const":"seedance2_mini"}`                                                                                                              | commonGeneration |

### `seedance2_5` · image-to-video

`POST https://api.dev.runwayml.com/v1/image_to_video` · [Schema snapshot](schemas/group1/runway-seedance2_5-image-to-video.json)

| Provider field           | Type                                                         | Required                         | Default       | Enum / formal bounds                                                                                                                                                                                             | Class            |
| ------------------------ | ------------------------------------------------------------ | -------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `promptImage`            | `{"anyOf":[{"anyOf":["string","string","string"]},"array"]}` | yes                              | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `promptImage[].uri`      | `{"anyOf":["string","string","string"]}`                     | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `promptImage[].position` | `string`                                                     | no (when parent branch applies)  | not published | `{"enum":["first","last"]}`                                                                                                                                                                                      | commonGeneration |
| `promptText`             | `string`                                                     | no                               | not published | `{"minLength":1,"maxLength":15000}`                                                                                                                                                                              | commonGeneration |
| `audio`                  | `boolean`                                                    | no                               | true          | not encoded                                                                                                                                                                                                      | commonGeneration |
| `seed`                   | `integer`                                                    | no                               | not published | `{"minimum":0,"maximum":4294967295}`                                                                                                                                                                             | commonGeneration |
| `outputFormat`           | `string`                                                     | no                               | not published | `{"enum":["mp4","mov"]}`                                                                                                                                                                                         | commonGeneration |
| `duration`               | `{"anyOf":["integer","string"]}`                             | no                               | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `ratio`                  | `string`                                                     | no                               | not published | `{"enum":["992:432","854:480","752:560","640:640","560:752","480:854","1470:630","1280:720","1112:834","960:960","834:1112","720:1280","2206:946","1920:1080","1664:1248","1440:1440","1248:1664","1080:1920"]}` | commonGeneration |
| `referenceAudio`         | `array`                                                      | no                               | not published | `{"maxItems":10}`                                                                                                                                                                                                | commonGeneration |
| `referenceAudio[].type`  | `string`                                                     | yes (when parent branch applies) | not published | `{"const":"audio"}`                                                                                                                                                                                              | commonGeneration |
| `referenceAudio[].uri`   | `{"anyOf":["string","string","string"]}`                     | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `draft`                  | `boolean`                                                    | no                               | not published | not encoded                                                                                                                                                                                                      | modelSpecific    |
| `model`                  | `string`                                                     | yes                              | not published | `{"const":"seedance2_5"}`                                                                                                                                                                                        | commonGeneration |

### `kling_4` · image-to-video

`POST https://api.dev.runwayml.com/v1/image_to_video` · [Schema snapshot](schemas/group1/runway-kling_4-image-to-video.json)

| Provider field     | Type                                                         | Required                         | Default       | Enum / formal bounds                  | Class            |
| ------------------ | ------------------------------------------------------------ | -------------------------------- | ------------- | ------------------------------------- | ---------------- |
| `promptImage`      | `{"anyOf":[{"anyOf":["string","string","string"]},"array"]}` | yes                              | not published | not encoded                           | commonGeneration |
| `ratio`            | `string`                                                     | no                               | not published | `{"enum":["auto_720p","auto_1080p"]}` | commonGeneration |
| `promptText`       | `string`                                                     | no                               | not published | `{"minLength":1,"maxLength":26000}`   | commonGeneration |
| `duration`         | `integer`                                                    | no                               | not published | `{"minimum":3,"maximum":30}`          | commonGeneration |
| `references`       | `array`                                                      | no                               | not published | `{"minItems":0,"maxItems":10}`        | commonGeneration |
| `references[].uri` | `{"anyOf":["string","string","string"]}`                     | yes (when parent branch applies) | not published | not encoded                           | commonGeneration |
| `referenceVideos`  | `array`                                                      | no                               | not published | `{"minItems":0,"maxItems":5}`         | commonGeneration |
| `model`            | `string`                                                     | yes                              | not published | `{"const":"kling_4"}`                 | commonGeneration |

### `seedance2` · video-to-video

`POST https://api.dev.runwayml.com/v1/video_to_video` · [Schema snapshot](schemas/group1/runway-seedance2-video-to-video.json)

| Provider field           | Type                                     | Required                         | Default       | Enum / formal bounds                                                                                                                                                                                                                                                                     | Class            |
| ------------------------ | ---------------------------------------- | -------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `promptVideo`            | `{"anyOf":["string","string","string"]}` | yes                              | not published | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `promptText`             | `string`                                 | no                               | not published | `{"minLength":1,"maxLength":3500}`                                                                                                                                                                                                                                                       | commonGeneration |
| `audio`                  | `boolean`                                | no                               | true          | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `seed`                   | `integer`                                | no                               | not published | `{"minimum":0,"maximum":4294967295}`                                                                                                                                                                                                                                                     | commonGeneration |
| `bitrate`                | `string`                                 | no                               | `standard`    | `{"enum":["standard","high"]}`                                                                                                                                                                                                                                                           | modelSpecific    |
| `duration`               | `{"anyOf":["integer","string"]}`         | no                               | not published | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `ratio`                  | `string`                                 | no                               | not published | `{"enum":["992:432","864:496","752:560","640:640","560:752","496:864","1470:630","1280:720","1112:834","960:960","834:1112","720:1280","2206:946","1920:1080","1664:1248","1440:1440","1248:1664","1080:1920","3840:1646","3840:2160","3840:2880","3840:3840","2880:3840","2160:3840"]}` | commonGeneration |
| `references`             | `array`                                  | no                               | not published | `{"maxItems":9}`                                                                                                                                                                                                                                                                         | commonGeneration |
| `references[].uri`       | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `referenceVideos`        | `array`                                  | no                               | not published | `{"maxItems":2}`                                                                                                                                                                                                                                                                         | commonGeneration |
| `referenceVideos[].type` | `string`                                 | yes (when parent branch applies) | not published | `{"const":"video"}`                                                                                                                                                                                                                                                                      | commonGeneration |
| `referenceVideos[].uri`  | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `referenceAudio`         | `array`                                  | no                               | not published | `{"maxItems":3}`                                                                                                                                                                                                                                                                         | commonGeneration |
| `referenceAudio[].type`  | `string`                                 | yes (when parent branch applies) | not published | `{"const":"audio"}`                                                                                                                                                                                                                                                                      | commonGeneration |
| `referenceAudio[].uri`   | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                                                                                              | commonGeneration |
| `model`                  | `string`                                 | yes                              | not published | `{"const":"seedance2"}`                                                                                                                                                                                                                                                                  | commonGeneration |

### `seedance2_fast` · video-to-video

`POST https://api.dev.runwayml.com/v1/video_to_video` · [Schema snapshot](schemas/group1/runway-seedance2_fast-video-to-video.json)

| Provider field           | Type                                     | Required                         | Default       | Enum / formal bounds                                                                                                                      | Class            |
| ------------------------ | ---------------------------------------- | -------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `promptVideo`            | `{"anyOf":["string","string","string"]}` | yes                              | not published | not encoded                                                                                                                               | commonGeneration |
| `promptText`             | `string`                                 | no                               | not published | `{"minLength":1,"maxLength":3500}`                                                                                                        | commonGeneration |
| `audio`                  | `boolean`                                | no                               | true          | not encoded                                                                                                                               | commonGeneration |
| `seed`                   | `integer`                                | no                               | not published | `{"minimum":0,"maximum":4294967295}`                                                                                                      | commonGeneration |
| `bitrate`                | `string`                                 | no                               | `standard`    | `{"enum":["standard","high"]}`                                                                                                            | modelSpecific    |
| `duration`               | `{"anyOf":["integer","string"]}`         | no                               | not published | not encoded                                                                                                                               | commonGeneration |
| `ratio`                  | `string`                                 | no                               | not published | `{"enum":["992:432","864:496","752:560","640:640","560:752","496:864","1470:630","1280:720","1112:834","960:960","834:1112","720:1280"]}` | commonGeneration |
| `references`             | `array`                                  | no                               | not published | `{"maxItems":9}`                                                                                                                          | commonGeneration |
| `references[].uri`       | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `referenceVideos`        | `array`                                  | no                               | not published | `{"maxItems":2}`                                                                                                                          | commonGeneration |
| `referenceVideos[].type` | `string`                                 | yes (when parent branch applies) | not published | `{"const":"video"}`                                                                                                                       | commonGeneration |
| `referenceVideos[].uri`  | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `referenceAudio`         | `array`                                  | no                               | not published | `{"maxItems":3}`                                                                                                                          | commonGeneration |
| `referenceAudio[].type`  | `string`                                 | yes (when parent branch applies) | not published | `{"const":"audio"}`                                                                                                                       | commonGeneration |
| `referenceAudio[].uri`   | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `model`                  | `string`                                 | yes                              | not published | `{"const":"seedance2_fast"}`                                                                                                              | commonGeneration |

### `seedance2_mini` · video-to-video

`POST https://api.dev.runwayml.com/v1/video_to_video` · [Schema snapshot](schemas/group1/runway-seedance2_mini-video-to-video.json)

| Provider field           | Type                                     | Required                         | Default       | Enum / formal bounds                                                                                                                      | Class            |
| ------------------------ | ---------------------------------------- | -------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `promptVideo`            | `{"anyOf":["string","string","string"]}` | yes                              | not published | not encoded                                                                                                                               | commonGeneration |
| `promptText`             | `string`                                 | no                               | not published | `{"minLength":1,"maxLength":3500}`                                                                                                        | commonGeneration |
| `audio`                  | `boolean`                                | no                               | true          | not encoded                                                                                                                               | commonGeneration |
| `seed`                   | `integer`                                | no                               | not published | `{"minimum":0,"maximum":4294967295}`                                                                                                      | commonGeneration |
| `bitrate`                | `string`                                 | no                               | `standard`    | `{"enum":["standard","high"]}`                                                                                                            | modelSpecific    |
| `duration`               | `{"anyOf":["integer","string"]}`         | no                               | not published | not encoded                                                                                                                               | commonGeneration |
| `ratio`                  | `string`                                 | no                               | not published | `{"enum":["992:432","864:496","752:560","640:640","560:752","496:864","1470:630","1280:720","1112:834","960:960","834:1112","720:1280"]}` | commonGeneration |
| `references`             | `array`                                  | no                               | not published | `{"maxItems":9}`                                                                                                                          | commonGeneration |
| `references[].uri`       | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `referenceVideos`        | `array`                                  | no                               | not published | `{"maxItems":2}`                                                                                                                          | commonGeneration |
| `referenceVideos[].type` | `string`                                 | yes (when parent branch applies) | not published | `{"const":"video"}`                                                                                                                       | commonGeneration |
| `referenceVideos[].uri`  | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `referenceAudio`         | `array`                                  | no                               | not published | `{"maxItems":3}`                                                                                                                          | commonGeneration |
| `referenceAudio[].type`  | `string`                                 | yes (when parent branch applies) | not published | `{"const":"audio"}`                                                                                                                       | commonGeneration |
| `referenceAudio[].uri`   | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                               | commonGeneration |
| `model`                  | `string`                                 | yes                              | not published | `{"const":"seedance2_mini"}`                                                                                                              | commonGeneration |

### `seedance2_5` · video-to-video

`POST https://api.dev.runwayml.com/v1/video_to_video` · [Schema snapshot](schemas/group1/runway-seedance2_5-video-to-video.json)

| Provider field           | Type                                     | Required                         | Default       | Enum / formal bounds                                                                                                                                                                                             | Class            |
| ------------------------ | ---------------------------------------- | -------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `promptVideo`            | `{"anyOf":["string","string","string"]}` | yes                              | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `promptText`             | `string`                                 | no                               | not published | `{"minLength":1,"maxLength":15000}`                                                                                                                                                                              | commonGeneration |
| `audio`                  | `boolean`                                | no                               | true          | not encoded                                                                                                                                                                                                      | commonGeneration |
| `seed`                   | `integer`                                | no                               | not published | `{"minimum":0,"maximum":4294967295}`                                                                                                                                                                             | commonGeneration |
| `outputFormat`           | `string`                                 | no                               | not published | `{"enum":["mp4","mov"]}`                                                                                                                                                                                         | commonGeneration |
| `mode`                   | `string`                                 | no                               | `reference`   | `{"enum":["reference","extend","edit"]}`                                                                                                                                                                         | modelSpecific    |
| `duration`               | `{"anyOf":["integer","string"]}`         | no                               | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `ratio`                  | `string`                                 | no                               | not published | `{"enum":["992:432","854:480","752:560","640:640","560:752","480:854","1470:630","1280:720","1112:834","960:960","834:1112","720:1280","2206:946","1920:1080","1664:1248","1440:1440","1248:1664","1080:1920"]}` | commonGeneration |
| `references`             | `array`                                  | no                               | not published | `{"maxItems":30}`                                                                                                                                                                                                | commonGeneration |
| `references[].uri`       | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `referenceVideos`        | `array`                                  | no                               | not published | `{"maxItems":9}`                                                                                                                                                                                                 | commonGeneration |
| `referenceVideos[].type` | `string`                                 | yes (when parent branch applies) | not published | `{"const":"video"}`                                                                                                                                                                                              | commonGeneration |
| `referenceVideos[].uri`  | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `referenceAudio`         | `array`                                  | no                               | not published | `{"maxItems":10}`                                                                                                                                                                                                | commonGeneration |
| `referenceAudio[].type`  | `string`                                 | yes (when parent branch applies) | not published | `{"const":"audio"}`                                                                                                                                                                                              | commonGeneration |
| `referenceAudio[].uri`   | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                                                                                                                                                                                                      | commonGeneration |
| `draft`                  | `boolean`                                | no                               | not published | not encoded                                                                                                                                                                                                      | modelSpecific    |
| `model`                  | `string`                                 | yes                              | not published | `{"const":"seedance2_5"}`                                                                                                                                                                                        | commonGeneration |

### `kling_4` · video-to-video

`POST https://api.dev.runwayml.com/v1/video_to_video` · [Schema snapshot](schemas/group1/runway-kling_4-video-to-video.json)

| Provider field     | Type                                     | Required                         | Default       | Enum / formal bounds                  | Class            |
| ------------------ | ---------------------------------------- | -------------------------------- | ------------- | ------------------------------------- | ---------------- |
| `videoUri`         | `{"anyOf":["string","string","string"]}` | yes                              | not published | not encoded                           | commonGeneration |
| `promptText`       | `string`                                 | yes                              | not published | `{"minLength":1,"maxLength":26000}`   | commonGeneration |
| `ratio`            | `string`                                 | no                               | not published | `{"enum":["auto_720p","auto_1080p"]}` | commonGeneration |
| `references`       | `array`                                  | no                               | not published | `{"minItems":0,"maxItems":10}`        | commonGeneration |
| `references[].uri` | `{"anyOf":["string","string","string"]}` | yes (when parent branch applies) | not published | not encoded                           | commonGeneration |
| `model`            | `string`                                 | yes                              | not published | `{"const":"kling_4"}`                 | commonGeneration |

## Alibaba Wan 3.0 / Prime

Primary references: [API](https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference), [usage guide](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/wan3-video-generation-guide), [Standard model card](https://www.alibabacloud.com/help/en/model-studio/wan3-0-video), [Prime model card](https://www.alibabacloud.com/help/en/model-studio/wan3-0-video-prime).

Both model IDs are explicitly present in the API reference, which also lists all six regional hosts. This establishes documentation, not actual account availability. The API, key and workspace must belong to the same region. Body/input semantics are shared; each exact model/region has its own JSON profile.

| Region    | Regional host prefix                             |
| --------- | ------------------------------------------------ |
| Beijing   | `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`     |
| Singapore | `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com` |
| Tokyo     | `{WorkspaceId}.ap-northeast-1.maas.aliyuncs.com` |
| Frankfurt | `{WorkspaceId}.eu-central-1.maas.aliyuncs.com`   |
| Virginia  | `{WorkspaceId}.us-east-1.maas.aliyuncs.com`      |
| Hong Kong | `{WorkspaceId}.cn-hongkong.maas.aliyuncs.com`    |

Append `/api/v1/services/aigc/video-generation/video-synthesis`. Required headers are Bearer authorization, JSON Content-Type and `X-DashScope-Async: enable`.

| Provider field             | Type            | Required | Default       | Enum / formal bounds                                                                                        | Class            |
| -------------------------- | --------------- | -------- | ------------- | ----------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                    | `string`        | yes      | not published | `{"enum":["wan3.0-video"]}`                                                                                 | commonGeneration |
| `input`                    | `object`        | yes      | not published | not encoded                                                                                                 | commonGeneration |
| `input.prompt`             | `string`        | no       | not published | not encoded                                                                                                 | commonGeneration |
| `input.media`              | `array<object>` | no       | not published | not encoded                                                                                                 | commonGeneration |
| `input.media[].type`       | `string`        | yes      | not published | `{"enum":["first_frame","last_frame","reference_image","reference_video","reference_audio","file","link"]}` | commonGeneration |
| `input.media[].url`        | `string`        | yes      | not published | not encoded                                                                                                 | commonGeneration |
| `parameters`               | `object`        | no       | not published | not encoded                                                                                                 | commonGeneration |
| `parameters.resolution`    | `string`        | no       | `1080P`       | `{"enum":["480P","720P","1080P"]}`                                                                          | commonGeneration |
| `parameters.ratio`         | `string`        | no       | `adaptive`    | `{"enum":["adaptive","21:9","16:9","4:3","1:1","3:4","9:16"]}`                                              | commonGeneration |
| `parameters.duration`      | `integer`       | no       | `5`           | `{"enum":[-1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30]}`              | commonGeneration |
| `parameters.audio`         | `boolean`       | no       | true          | not encoded                                                                                                 | commonGeneration |
| `parameters.seed`          | `integer`       | no       | `-1`          | `{"minimum":-1,"maximum":2147483647}`                                                                       | commonGeneration |
| `parameters.prompt_extend` | `boolean`       | no       | true          | not encoded                                                                                                 | modelSpecific    |
| `parameters.watermark`     | `boolean`       | no       | false         | not encoded                                                                                                 | commonGeneration |

| Media role         | Count   | Documented limits                                                                                 |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------- |
| first / last frame | ≤1 each | Image rules; cannot mix omni references or file/link                                              |
| reference image    | ≤10     | JPEG/JPG/PNG/BMP/WebP, no PNG transparency; ≤20MB; sides 240–8000px; ratio ≤8:1                   |
| reference video    | ≤5      | MP4/MOV, ≤100MB/clip; 1–15s each and ≤15s total; ≥16fps; sides 240–4096px; ratio ≤8:1             |
| reference audio    | ≤5      | WAV/MP3, ≤15MB each; 1–15s each and ≤15s total                                                    |
| document           | ≤1      | ≤100MB; DOC(X)/XLS(X)/PPT(X)/PDF/TXT/KEY/PAGES/NUMBERS/MD; ≤50 pages on listed page-based formats |
| public web link    | ≤1      | No login required; file and link mutually exclusive                                               |

Image/video/audio can combine. A document or link can combine with references but requires `prompt_extend=true`. The guide advertises 20 materials overall; that is prose, not a formal maxItems validator. Prompt or media is required, so a media-only request is possible. Mode is inferred from media roles and text intent; edit/extend are not separate model IDs. Reference aliases count images, video and audio separately in source array order.

Output defaults: 1080P, adaptive ratio, 5s, audio on, prompt rewriting on, no watermark, random seed. A requested `-1` duration means smart mode; with video input, input video seconds + output seconds ≤30. Hard prompt budget is 20,000 characters and the provider truncates overflow; the broker should not claim unchanged text beyond that. No typed negative prompt, CFG, shot list, codec/container or camera control is exposed in this reference.

Task IDs and output URLs last 24h. Poll same regional host `/api/v1/tasks/{id}` (15s recommended; query default 20RPS). Successful output is MP4/H.264 at 30fps. `usage.duration` includes input video plus output when video references exist, so output-only price multiplication is incomplete.

## Replicate Seedance 2.5

[Public schema](https://replicate.com/bytedance/seedance-2.5/api/schema), extracted from the official model page's embedded dereferenced OpenAPI. This single input schema covers several modes. It is not equivalent to the fal or native schema.

| Provider field     | Type      | Required | Default       | Enum / formal bounds                                           | Class            |
| ------------------ | --------- | -------- | ------------- | -------------------------------------------------------------- | ---------------- |
| `seed`             | `integer` | no       | not published | not encoded                                                    | commonGeneration |
| `image`            | `string`  | no       | not published | `{"format":"uri"}`                                             | commonGeneration |
| `prompt`           | `string`  | no       | ``            | `{"maxLength":2000}`                                           | commonGeneration |
| `duration`         | `integer` | no       | `5`           | `{"minimum":-1,"maximum":30}`                                  | commonGeneration |
| `watermark`        | `boolean` | no       | false         | not encoded                                                    | commonGeneration |
| `resolution`       | `string`  | no       | `720p`        | `{"enum":["480p","720p"]}`                                     | commonGeneration |
| `aspect_ratio`     | `string`  | no       | `16:9`        | `{"enum":["16:9","4:3","1:1","3:4","9:16","21:9","adaptive"]}` | commonGeneration |
| `output_format`    | `string`  | no       | `mp4`         | `{"enum":["mp4","mov"]}`                                       | commonGeneration |
| `generate_audio`   | `boolean` | no       | true          | not encoded                                                    | commonGeneration |
| `last_frame_image` | `string`  | no       | not published | `{"format":"uri"}`                                             | commonGeneration |
| `reference_audios` | `array`   | no       | `[]`          | not encoded                                                    | commonGeneration |
| `reference_images` | `array`   | no       | `[]`          | not encoded                                                    | commonGeneration |
| `reference_videos` | `array`   | no       | `[]`          | not encoded                                                    | commonGeneration |

First/last frames exclude all reference arrays; last requires first. Reference arrays permit 30 images / 10 videos / 10 audio, with 30s combined video and audio budgets. Audio needs an image/video, unlike native 2.5 audio-only support. Prompt is ≤2000 characters and can be empty when media is present. First/last/edit/extend use adaptive framing; edit needs duration −1. The formal numeric bound permits 0–3 even though native generation starts at 4s; treat that as an unresolved schema/prose mismatch. No typed task selector, draft controls or full per-file constraints appear here. An operation must not be inferred from native capabilities alone.

## Direct Kling and supplemental Cloudflare

The [official direct Kling 4 usage URL](https://kling.ai/document-api/api/usage-guide/kling-4-0) returned a client-rendered shell without an inspectable request contract in this audit. Its detailed request schema remains unresolved; the availability release and supplemental Runware section below add newer evidence. Do not substitute direct Kling3/O3 IDs or claim reseller field names as the native contract.

[Cloudflare's Kling 4 page](https://developers.cloudflare.com/ai/models/klingai/kling-v4/) is an additional independently documented provider surface. Its default differs from Runway: 1080p, explicit `aspect_ratio` and `resolution`, and provider-specific named frames. It is researched here without claiming an implemented OpenGen adapter.

| Provider field        | Type            | Required | Default       | Enum / formal bounds                    | Class            |
| --------------------- | --------------- | -------- | ------------- | --------------------------------------- | ---------------- |
| `model`               | `string`        | yes      | not published | `{"enum":["klingai/kling-v4"]}`         | commonGeneration |
| `input.prompt`        | `string`        | yes      | not published | `{"minLength":1,"maxLength":26000}`     | commonGeneration |
| `input.first_frame`   | `string`        | no       | not published | not encoded                             | commonGeneration |
| `input.middle_frames` | `array<string>` | no       | not published | `{"maxItems":9}`                        | commonGeneration |
| `input.last_frame`    | `string`        | no       | not published | not encoded                             | commonGeneration |
| `input.duration`      | `integer`       | yes      | `5`           | `{"minimum":3,"maximum":30}`            | commonGeneration |
| `input.aspect_ratio`  | `string`        | yes      | `16:9`        | `{"enum":["21:9","16:9","9:16","1:1"]}` | commonGeneration |
| `input.resolution`    | `string`        | yes      | `1080p`       | `{"enum":["720p","1080p"]}`             | commonGeneration |

Cloudflare documents JPG/PNG, ≤30MB, ≥300px/side and ratio 0.4–2.5. It formally allows nine middle frames while describing ten total keyframes. With first + last, the total could exceed that description; retain this conflict and do not borrow Runway's eight-middle rule without qualification. `aspect_ratio` is ignored for keyframe input. Generated parameter cards mark duration/ratio/resolution required while examples omit ratio; default handling needs verification.

## Cross-provider constraints to preserve

- Common arguments must mean the same thing; support is still conditional. Model-specific arguments retain the model's full published controls, and route capabilities can narrow them.
- Named frames, middle-keyframe sequences, identity/style image references, driving audio, source/reference video, document/web source, draft ID and provider asset URI are separate roles/state, not one untyped image list.
- Never infer 4K pixel dimensions from a coarse tier. BytePlus and Runway expose different 2.0 Standard 4K square dimensions.
- Never infer hard bounds from a recommendation or a missing JSON-Schema keyword. Conversely, don't ignore prose cross-field restrictions.
- Keep direct/native, reseller, US-hosted and regional profiles separate, even when the model display name matches.
- Existing adapters implement a subset. This audit includes advanced modes and new documented route surfaces that remain unimplemented, account-gated or unverified.

For machine consumption, use [the JSON inventory](video-seedance-kling-wan.json) and its referenced structural snapshots. Explicit unknowns and source conflicts are release work, not default values or proof of support.

## Additional native Kling evidence and Runware route

The [official API changelog](https://kling.ai/document-api/updates/api?date=2026-02-11) now announces **2026-10-28 full API availability**, with relative paths `/text-to-video/kling-4.0`, `/image-to-video/kling-4.0` and `/omni-video/kling-4.0`. It establishes 720P/1080P, up to ten keyframes, ten reference images, five reference videos, voice references and fifteen combined assets. Exact body field names/defaults and absolute API URLs remain unresolved because the direct reference renders a JS shell. The [consumer guide](https://kling.ai/quickstart/kling-4-model-user-guide) describes seven elements including three video elements and stereo output; its 4K/HDR claims must not override the API changelog saying 4K is coming soon.

[Runware Kling VIDEO4.0](https://runware.ai/docs/models/klingai-video-4-0) is an additional independent request surface. It exposes reusable elements and voice associations absent from the audited Runway branch, and different defaults: **10s/1080p**. This is documentation research, not a newly enabled provider.

| Provider field                   | Type                  | Required                   | Default       | Enum/bounds                            | Class            |
| -------------------------------- | --------------------- | -------------------------- | ------------- | -------------------------------------- | ---------------- |
| `taskType`                       | string                | yes / conditional creation | not published | `{"enum":["videoInference"]}`          | brokerTransport  |
| `taskUUID`                       | string                | yes / conditional creation | not published | `{"format":"UUIDv4"}`                  | brokerTransport  |
| `outputType`                     | string                | conditional or optional    | `"URL"`       | `{"enum":["URL"]}`                     | brokerTransport  |
| `outputFormat`                   | string                | conditional or optional    | `"MP4"`       | `{"enum":["MP4","WEBM","MOV"]}`        | commonGeneration |
| `outputQuality`                  | integer               | conditional or optional    | `95`          | `{"minimum":20,"maximum":99}`          | commonGeneration |
| `webhookURL`                     | string                | conditional or optional    | not published | `{"format":"uri"}`                     | brokerTransport  |
| `deliveryMethod`                 | string                | conditional or optional    | `"async"`     | `{"enum":["sync","async"]}`            | brokerTransport  |
| `uploadEndpoint`                 | string                | conditional or optional    | not published | `{"format":"uri"}`                     | brokerTransport  |
| `safety`                         | object                | conditional or optional    | not published | not encoded                            | modelSpecific    |
| `safety.checkContent`            | boolean               | conditional or optional    | not published | not encoded                            | modelSpecific    |
| `safety.mode`                    | string                | conditional or optional    | `"fast"`      | `{"enum":["fast","full"]}`             | modelSpecific    |
| `ttl`                            | integer               | conditional or optional    | not published | `{"minimum":60}`                       | brokerTransport  |
| `includeCost`                    | boolean               | conditional or optional    | not published | not encoded                            | brokerTransport  |
| `numberResults`                  | integer               | conditional or optional    | `1`           | `{"minimum":1,"maximum":4}`            | commonGeneration |
| `routing`                        | object                | conditional or optional    | not published | not encoded                            | brokerTransport  |
| `routing.preferences`            | object                | conditional or optional    | not published | not encoded                            | brokerTransport  |
| `routing.preferences.quality`    | integer               | conditional or optional    | not published | `{"minimum":0,"maximum":5}`            | brokerTransport  |
| `routing.preferences.speed`      | integer               | conditional or optional    | not published | `{"minimum":0,"maximum":5}`            | brokerTransport  |
| `routing.preferences.cost`       | integer               | conditional or optional    | not published | `{"minimum":0,"maximum":5}`            | brokerTransport  |
| `routing.maxPrice`               | number                | conditional or optional    | not published | `{"minimum":0}`                        | brokerTransport  |
| `routing.requirements`           | string                | conditional or optional    | not published | `{"maxLength":3000}`                   | brokerTransport  |
| `inputs`                         | object                | conditional or optional    | not published | not encoded                            | commonGeneration |
| `inputs.referenceImages`         | array<string>         | conditional or optional    | not published | `{"minItems":1,"maxItems":10}`         | commonGeneration |
| `inputs.frameImages`             | array<string\|object> | conditional or optional    | not published | `{"minItems":1,"maxItems":10}`         | commonGeneration |
| `inputs.frameImages[].image`     | string                | yes / conditional creation | not published | not encoded                            | commonGeneration |
| `inputs.frameImages[].frame`     | string\|integer       | conditional or optional    | not published | `{"enum":["first","last",0,-1]}`       | commonGeneration |
| `inputs.video`                   | string                | conditional or optional    | not published | not encoded                            | commonGeneration |
| `inputs.referenceVideos`         | array<string>         | conditional or optional    | not published | `{"minItems":1,"maxItems":5}`          | commonGeneration |
| `inputs.elements`                | array<object>         | conditional or optional    | not published | `{"minItems":1,"maxItems":7}`          | modelSpecific    |
| `inputs.elements[].id`           | string                | yes / conditional creation | not published | `{"minLength":1,"maxLength":20}`       | modelSpecific    |
| `inputs.elements[].description`  | string                | yes / conditional creation | not published | `{"minLength":1,"maxLength":100}`      | modelSpecific    |
| `inputs.elements[].frontalImage` | string                | conditional or optional    | not published | not encoded                            | modelSpecific    |
| `inputs.elements[].images`       | array<string>         | conditional or optional    | not published | `{"minItems":1,"maxItems":3}`          | modelSpecific    |
| `inputs.elements[].videos`       | array<string>         | conditional or optional    | not published | `{"minItems":1,"maxItems":1}`          | modelSpecific    |
| `inputs.elements[].voices`       | array<string>         | conditional or optional    | not published | `{"minItems":1,"maxItems":1}`          | modelSpecific    |
| `inputs.elements[].tags`         | array<string>         | conditional or optional    | not published | `{"minItems":1}`                       | modelSpecific    |
| `model`                          | string                | yes / conditional creation | not published | `{"enum":["klingai:kling-video@4.0"]}` | commonGeneration |
| `positivePrompt`                 | string                | conditional or optional    | not published | `{"minLength":1,"maxLength":26000}`    | commonGeneration |
| `width`                          | integer               | conditional or optional    | not published | not encoded                            | commonGeneration |
| `height`                         | integer               | conditional or optional    | not published | not encoded                            | commonGeneration |
| `resolution`                     | string                | conditional or optional    | `"1080p"`     | `{"enum":["720p","1080p"]}`            | commonGeneration |
| `duration`                       | integer               | conditional or optional    | `10`          | `{"minimum":3,"maximum":30}`           | commonGeneration |

The HTML tooltips specify image minimum300px/side, maximum30MB and ratio0.4–2.5. Video tooltips specify700–4553px/side, ≤8.29MP,24–60fps,3–30s and≤300MB. These are Runware facts, not inherited native/Runway limits.

Combined budgets: ten frame/reference images, five input videos and thirty combined video seconds, fifteen combined media/elements. The primary video and videos inside elements count toward video budgets. Each element can be image-based (frontal plus up to three angles), video-based (one video), or image plus voice (one voice); video cannot combine with images/voice within an element.

Prompt weighting is explicitly `E/26000 + N/11000 <= 1` (ASCII versus non-ASCII). Prompts are required except frame-only generation. Width/height form a pair, are required for pure text without media, and cannot combine with the resolution preset. The latter requires media and preserves source framing. A batch can request1–4 results.

Keep source inconsistencies: element prose says extra angles are optional, while dependency text requires frontal and images together; ID-only reuse omits the creation-required description. Frame position is labelled object while enumerating scalar first/last/0/−1. Generic prose mentions timestamps depending on model support, but no timestamp property is exposed for this exact branch. Do not invent exact keyframe timing.

Fal2.0 family access terms also require verified business customers and end-user identification; a nullable field in a public schema is not a waiver of account access conditions.

Schema preservation QA: 42 snapshots checked against raw contracts, including 1,139 property declarations, 172 required arrays and 667 default/enum/const values. None of these raw contracts declares an input property named `description`, `title`, `example` or `examples`; a synthetic edge case verified that such property names and literal default data survive the schema-aware sanitizer.
