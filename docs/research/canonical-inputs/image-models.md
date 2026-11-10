# Image-model input inventory

Checked **2026-11-03** against primary provider/model documentation, exact public fal OpenAPI schemas, Replicate embedded schema and official SDK source. **No authenticated or paid calls were made.**

This covers all **10 initial image variants**, with **31 endpoint/protocol records** and **455 field records**. It includes upstream features beyond the current OpenGen adapters. Documentation support, public schema exposure, account eligibility, current adapter support and live verification are different states.

The machine-readable companion is [image-models.json](image-models.json). Exact fal input/definition structure is preserved without vendor prose/examples under [schemas/group3](schemas/group3). Raw HTML/SDK source is kept outside the repository.

## Scope and identity

| Exact OpenGen variant           | Audited surfaces                                                         | Important boundary                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `openai/gpt-image-2.5-sunburst` | OpenAI Images generation/edit, Responses image tool; fal generation/edit | Distinct image model; quality through xhigh/max; native markup overlay.                                      |
| `openai/gpt-image-2.5-flare`    | OpenAI Images generation/edit, Responses image tool; fal generation/edit | Distinct model rather than a Sunburst quality tier.                                                          |
| `openai/gpt-image-2`            | OpenAI Images/Responses; fal generation/edit                             | 2.0 is an alias; no xhigh/max; transparency preview; omit input_fidelity.                                    |
| `google/nano-banana-2.1`        | Google Interactions; fal generation/edit                                 | Text/image/video/PDF context, thinking and grounding; no audio input.                                        |
| `xai/grok-imagine-image-2.0`    | xAI REST/Python SDK; fal generation/edit                                 | Direct multi-edit5 references; fal current schema and landing disagree.                                      |
| `bytedance/seedream-5.0-pro`    | BytePlus generation/edit/decomposition; fal; Replicate                   | Native Pro streaming/sequential controls are not established; layer output is a separate semantic operation. |
| `qwen/image-2.1`                | Official weights/model card and Diffusers pipeline                       | No qualified hosted base-checkpoint API; research license is separate from service terms.                    |
| `qwen/image-2.1-turbo`          | Weights/pipeline and Alibaba hosted protocols                            | Turbo8-step schedule; hosted API does not expose the whole local pipeline.                                   |
| `alibaba/qwen-image-2.1-pro`    | Alibaba OpenAI-compatible, DashScope sync/async                          | Hosted identity is not assumed equal to the base weights.                                                    |
| `alibaba/qwen-image-3.0-pro`    | Alibaba OpenAI-compatible, DashScope sync/async                          | 3 references; negative prompt supported; do not equate fal Qwen Image3 naming with Pro.                      |

## Common arguments plus model-specific arguments

Use one composed input object, as fal does, while keeping transport options separate from generation semantics. A common argument is a stable candidate name and meaning, **not a promise that every model supports it**. Model capability data still controls which values and combinations are accepted.

| Classification     | Candidate arguments / examples                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commonGeneration` | Exact model, prompt, ordered source images, mask intent where supported, negative prompt where supported, output count, output size/ratio, seed and output format/compression.                             |
| `modelSpecific`    | OpenAI markup and quality extensions; Gemini thinking/grounding; Qwen prompt enhancement and thinking; Seedream layer decomposition and constrained transparent editing.                                   |
| `brokerTransport`  | Delivery URL/base64, queue/sync mode, streaming/previews, continuation identifiers, privacy-safe end-user identity, storage retention and webhooks. Some affect usage or history and must remain explicit. |

These classifications and `canonicalMappingCandidate` values are OpenGen design proposals. Raw field names, schemas and sourced bounds are the audited facts.

## Decisions the canonical contract must preserve

1. **Ordered mixed references.** Keep one ordered asset-reference list. The xAI Python helper concatenates file IDs before URLs; our existing split URL/upload arrays have a similar ordering hazard. Preserve caller roles/order rather than delegating them to helper-specific list concatenation.
2. **Mask representations differ.** OpenAI native edits describe an alpha mask on the first image; fal GPT edits use a white/black mask URL. Markup is a separate GPT2.5 overlay and is mutually exclusive with a mask. Do not alias those blindly.
3. **Transparency is not one universal switch.** OpenAI exposes a background field; Seedream allows transparent editing only with one alpha source and PNG; Qwen2.1 can produce RGBA through prompt/model behavior. Distinguish a native control, prompt-guided behavior and unsupported behavior.
4. **Defaults change results and bills.** fal GPT defaults high quality and landscape4:3 for generation, while native OpenAI defaults auto. fal Grok defaults medium, while native auto currently selects low for generation. Normalize deliberate defaults or return a machine-readable handling notice.
5. **Size is not one integer.** Explicit width/height, tier labels, aspect ratio and pixel-area constraints differ. `1K` is not a promise of1024×1024 for every ratio/model. Enforce model-level bounds in addition to a shared schema reference.
6. **Prose constraints matter.** fal Seedream silently retains only the last10 references above its limit although maxItems is absent. OpenGen must reject excess inputs before spending.
7. **Do not borrow fields from sibling models.** BytePlus generic docs list streaming, sequential image generation and max_images for Lite/4.x, not Pro. A generic Gemini response format lists512 while Nano2.1 advertises1K/2K/4K.
8. **Keep provider-bound continuation state.** OpenAI Responses uses previous_response_id/image IDs; Gemini uses previous_interaction_id and potentially continuation_token. A common OpenGen job reference must preserve original provider/model/owner authority.
9. **Provider wrappers may be narrower or richer.** Replicate restricts standard Seedream to1K/2K; BytePlus standard Pro also lists1.5K. fal adds output codecs, seed and bounded PDF/video URL loading to its Nano wrapper.
10. **Unknown is not unlimited.** Missing hard prompt/file dimensions or source conflicts remain explicit. Public schemas do not prove account access, regional inference location or successful execution.

## Source conflicts and unresolved boundaries

### fal-grok-stale-landing

Status: `source_conflict`.

- Landing copy says 3 references,4 outputs,1K/2K and 13 ratios; current exact OpenAPI says 5 references,10 outputs,1k/1.5k/2k and extra21:9/5:2 ratios.
- Action: Publish exact schema and source conflict; use conservative admission until runtime qualification.

### gpt-json-size-vs-binary-file

Status: `different_limits_not_equivalent`.

- The 20MiB serialized URI limit and under 50MB binary/mask limit concern different representations.

### fal-image-size-generic

Status: `schema_does_not_encode_all_constraints`.

- Shared ImageSize maximum 14142/default 512 is not a GPT or Seedream model guarantee; model-level area/ratio/edge rules narrow it.

### google-image-formats

Status: `source_conflict`.

- Formal ImageResponseFormat enum lists JPEG; image guide contains explicit PNG examples. Generic512 output is not qualified by Nano2.1 model card.

### seedream-1.5k-provider

Status: `provider_difference`.

- BytePlus standard Pro supports 1.5K; Replicate standard mode says 1K/2K and reserves1.5K for decomposition.

### seedream-stream-batch

Status: `model_applicability_boundary`.

- The generic BytePlus streaming/sequential/max_images fields exclude Pro; fal output count means multiple separate calls.

### qwen-native-vs-hosted

Status: `different_interfaces`.

- Weight pipeline exposes guidance/steps/sigma/RGBA controls; hosted API does not automatically expose them. Hosted Pro is not an open checkpoint alias.

### xai-regional-price-row

Status: `insufficient_capability_evidence`.

- A 1.5K price row does not qualify a native 1.5k request; generic endpoint regions do not establish image/video availability.

### xai-sdk-http-divergence

Status: `source_or_interface_difference`.

- SDK mapping excludes auto quality and 21:9/5:2 ratios that REST guide supports. Proto HIGH does not make high a supported model setting.
- Action: Keep SDK transport mappings separate from model and REST capability declarations.

## Complete audited field inventory

`Required` describes the audited request form; conditional semantics appear in constraints. `ND` means not documented. Status `unsupported`, `ignored` or `not_documented` must not be treated as a usable field. C/S/T mean common-generation candidate, model-specific and broker transport. Exact schema snapshots preserve union branches, references and UI property order where available.

### openai.gpt25.generate

**Models:** `openai/gpt-image-2.5-sunburst`, `openai/gpt-image-2.5-flare`.

**Operations:** `text-to-image`.

**Request:** `POST https://api.openai.com/v1/images/generations` · JSON.

**Sources:** [openai.generate](https://developers.openai.com/api/reference/resources/images/methods/generate), [openai.guide](https://developers.openai.com/api/docs/guides/image-generation).

| Raw field            | Type          | Required | Default | Enum / bounds                                                             | Class | Status      |
| -------------------- | ------------- | -------- | ------- | ------------------------------------------------------------------------- | ----- | ----------- |
| `model`              | string        | yes      | ND      | enum=["gpt-image-2.5-sunburst","gpt-image-2.5-flare"]                     | C     | documented  |
| `prompt`             | string        | yes      | ND      | {"maxLength":32000}                                                       | C     | documented  |
| `background`         | string\|null  | no       | auto    | enum=["auto","opaque","transparent"]                                      | S     | documented  |
| `moderation`         | string\|null  | no       | auto    | enum=["auto","low"]                                                       | S     | documented  |
| `n`                  | integer\|null | no       | 1       | {"minimum":1,"maximum":10}                                                | C     | documented  |
| `output_compression` | integer\|null | no       | 100     | {"minimum":0,"maximum":100}                                               | C     | documented  |
| `output_format`      | string\|null  | no       | png     | enum=["png","jpeg","webp"]                                                | C     | documented  |
| `partial_images`     | integer\|null | no       | 0       | {"minimum":0,"maximum":3}                                                 | T     | documented  |
| `quality`            | string\|null  | no       | auto    | enum=["auto","low","medium","high","xhigh","max"]                         | S     | documented  |
| `safety_identifier`  | string\|null  | no       | ND      | {"maxLength":128}                                                         | T     | documented  |
| `size`               | string\|null  | no       | auto    | ND                                                                        | C     | documented  |
| `stream`             | boolean\|null | no       | no      | ND                                                                        | T     | documented  |
| `user`               | string        | no       | ND      | Fallback end-user identity; non-empty safety_identifier takes precedence. | T     | deprecated  |
| `response_format`    | string\|null  | no       | ND      | ND                                                                        | T     | unsupported |
| `style`              | string\|null  | no       | ND      | ND                                                                        | S     | unsupported |

**Constraints and applicability:**

- Use an exact image model ID. Sunburst and Flare are distinct models, not quality tiers.
- Output dimensions: multiples of 16, maximum edge 3840, area 655360–8294400 pixels, aspect ratio 1:3–3:1. Above 2560x1440 is experimental.
- Transparent background requires PNG or WebP; GPT Image 2 transparency remains preview.
- No documented Images API seed, negative prompt or CFG parameter.
- GPT Image 2.5 quality adds xhigh/max; GPT Image 2 supports through high. Native quality default is auto.

**Unknown / needs qualification:**

- Input codec/byte constraints must be validated against the exact request representation; never import retired DALL·E requirements.

### openai.gpt25.edit-json

**Models:** `openai/gpt-image-2.5-sunburst`, `openai/gpt-image-2.5-flare`.

**Operations:** `image-edit`, `masked-edit`, `outpaint-by-prompt`.

**Request:** `POST https://api.openai.com/v1/images/edits` · JSON.

**Sources:** [openai.edit](https://developers.openai.com/api/reference/resources/images/methods/edit), [openai.guide](https://developers.openai.com/api/docs/guides/image-generation).

| Raw field            | Type            | Required                            | Default                | Enum / bounds                                                                                                                                                                              | Class | Status         |
| -------------------- | --------------- | ----------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | -------------- |
| `model`              | string          | no                                  | gpt-image-2.5-sunburst | enum=["gpt-image-2.5-sunburst","gpt-image-2.5-flare"]; Default belongs to the generic endpoint and can select a different model; OpenGen must send the exact requested model explicitly.   | C     | documented     |
| `prompt`             | string          | yes                                 | ND                     | {"maxLength":32000,"minLength":1}                                                                                                                                                          | C     | documented     |
| `background`         | string\|null    | no                                  | auto                   | enum=["auto","opaque","transparent"]                                                                                                                                                       | S     | documented     |
| `moderation`         | string\|null    | no                                  | auto                   | enum=["auto","low"]                                                                                                                                                                        | S     | documented     |
| `n`                  | integer\|null   | no                                  | 1                      | {"minimum":1,"maximum":10}                                                                                                                                                                 | C     | documented     |
| `output_compression` | integer\|null   | no                                  | ND                     | {"minimum":0,"maximum":100}                                                                                                                                                                | C     | documented     |
| `output_format`      | string\|null    | no                                  | png                    | enum=["png","jpeg","webp"]                                                                                                                                                                 | C     | documented     |
| `partial_images`     | integer\|null   | no                                  | 0                      | {"minimum":0,"maximum":3}                                                                                                                                                                  | T     | documented     |
| `quality`            | string\|null    | no                                  | auto                   | enum=["auto","low","medium","high","xhigh","max"]                                                                                                                                          | S     | documented     |
| `safety_identifier`  | string\|null    | no                                  | ND                     | {"maxLength":128}                                                                                                                                                                          | T     | documented     |
| `size`               | string\|null    | no                                  | auto                   | ND                                                                                                                                                                                         | C     | documented     |
| `stream`             | boolean\|null   | no                                  | no                     | ND                                                                                                                                                                                         | T     | documented     |
| `user`               | string          | no                                  | ND                     | Fallback end-user identity; non-empty safety_identifier takes precedence.                                                                                                                  | T     | deprecated     |
| `images`             | array<AssetRef> | yes                                 | ND                     | {"minItems":1,"maxItems":16}                                                                                                                                                               | C     | documented     |
| `images[].file_id`   | string          | exactly_one_of_file_id_or_image_url | ND                     | ND                                                                                                                                                                                         | S     | documented     |
| `images[].image_url` | string          | exactly_one_of_file_id_or_image_url | ND                     | {"maxLength":20971520}                                                                                                                                                                     | S     | documented     |
| `mask`               | AssetRef        | no                                  | ND                     | ND                                                                                                                                                                                         | C     | documented     |
| `mask.file_id`       | string          | conditional                         | ND                     | ND                                                                                                                                                                                         | S     | documented     |
| `mask.image_url`     | string          | conditional                         | ND                     | {"maxLength":20971520}                                                                                                                                                                     | S     | documented     |
| `input_fidelity`     | string\|null    | no                                  | ND                     | enum=["high","low"]; GPT Image 2: omit (automatic high fidelity). GPT Image 2.5: current reference does not establish applicability; generic enum is for older supported GPT Image models. | S     | not_documented |
| `markup`             | AssetRef        | no                                  | ND                     | ND                                                                                                                                                                                         | S     | documented     |
| `markup.file_id`     | string          | conditional                         | ND                     | ND                                                                                                                                                                                         | S     | documented     |
| `markup.image_url`   | string          | conditional                         | ND                     | {"maxLength":20971520}                                                                                                                                                                     | S     | documented     |

**Constraints and applicability:**

- Use an exact image model ID. Sunburst and Flare are distinct models, not quality tiers.
- Output dimensions: multiples of 16, maximum edge 3840, area 655360–8294400 pixels, aspect ratio 1:3–3:1. Above 2560x1440 is experimental.
- Transparent background requires PNG or WebP; GPT Image 2 transparency remains preview.
- No documented Images API seed, negative prompt or CFG parameter.
- GPT Image 2.5 quality adds xhigh/max; GPT Image 2 supports through high. Native quality default is auto.
- Up to 16 references. Mask targets the first image and guides rather than guarantees pixel-exact edits.
- JSON references choose exactly one file_id or image_url. The serialized image_url limit 20MiB and binary/mask guide limit under 50MB describe different representations.
- GPT Image 2 automatically uses high input fidelity; input_fidelity must be omitted. GPT Image 2.5 input_fidelity support is not established by the current field description.
- GPT Image 2.5 markup is a transparent PNG overlay matching the first image after orientation; markup and mask are mutually exclusive.

Media limit details:

```json
{
  "images": {
    "maxCount": 16,
    "formats": {
      "status": "not_documented_in_audited_current_edit_reference"
    },
    "maxFileSizeBytes": 50000000,
    "maxFileSizeOperator": "less_than",
    "transport": ["URL", "data URI", "file_id"]
  },
  "mask": {
    "alphaRequired": true,
    "sameSizeAndFormatAsInput": true,
    "appliesTo": "first input image",
    "precision": "guidance, not pixel-exact guarantee"
  },
  "markup": {
    "supported": true,
    "format": "png",
    "alphaRequired": true,
    "sameOrientedDimensionsAsFirstInput": true
  }
}
```

**Unknown / needs qualification:**

- Input codec/byte constraints must be validated against the exact request representation; never import retired DALL·E requirements.

### openai.gpt25.edit-multipart

**Models:** `openai/gpt-image-2.5-sunburst`, `openai/gpt-image-2.5-flare`.

**Operations:** `image-edit`, `masked-edit`.

**Request:** `POST https://api.openai.com/v1/images/edits` · multipart/form-data.

**Sources:** [openai.edit](https://developers.openai.com/api/reference/resources/images/methods/edit), [openai.guide](https://developers.openai.com/api/docs/guides/image-generation).

| Raw field            | Type          | Required | Default                | Enum / bounds                                                                                                                                                                              | Class | Status         |
| -------------------- | ------------- | -------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | -------------- |
| `model`              | string        | no       | gpt-image-2.5-sunburst | enum=["gpt-image-2.5-sunburst","gpt-image-2.5-flare"]; Default belongs to the generic endpoint and can select a different model; OpenGen must send the exact requested model explicitly.   | C     | documented     |
| `prompt`             | string        | yes      | ND                     | {"maxLength":32000,"minLength":1}                                                                                                                                                          | C     | documented     |
| `background`         | string\|null  | no       | auto                   | enum=["auto","opaque","transparent"]                                                                                                                                                       | S     | documented     |
| `moderation`         | string\|null  | no       | auto                   | enum=["auto","low"]                                                                                                                                                                        | S     | documented     |
| `n`                  | integer\|null | no       | 1                      | {"minimum":1,"maximum":10}                                                                                                                                                                 | C     | documented     |
| `output_compression` | integer\|null | no       | ND                     | {"minimum":0,"maximum":100}                                                                                                                                                                | C     | documented     |
| `output_format`      | string\|null  | no       | png                    | enum=["png","jpeg","webp"]                                                                                                                                                                 | C     | documented     |
| `partial_images`     | integer\|null | no       | 0                      | {"minimum":0,"maximum":3}                                                                                                                                                                  | T     | documented     |
| `quality`            | string\|null  | no       | auto                   | enum=["auto","low","medium","high","xhigh","max"]                                                                                                                                          | S     | documented     |
| `safety_identifier`  | string\|null  | no       | ND                     | {"maxLength":128}                                                                                                                                                                          | T     | documented     |
| `size`               | string\|null  | no       | auto                   | ND                                                                                                                                                                                         | C     | documented     |
| `stream`             | boolean\|null | no       | no                     | ND                                                                                                                                                                                         | T     | documented     |
| `user`               | string        | no       | ND                     | Fallback end-user identity; non-empty safety_identifier takes precedence.                                                                                                                  | T     | deprecated     |
| `mask`               | file          | no       | ND                     | Multipart upload, alpha mask with matching first-source dimensions/format.                                                                                                                 | C     | documented     |
| `input_fidelity`     | string\|null  | no       | ND                     | enum=["high","low"]; GPT Image 2: omit (automatic high fidelity). GPT Image 2.5: current reference does not establish applicability; generic enum is for older supported GPT Image models. | S     | not_documented |
| `image[]`            | file[]        | yes      | ND                     | {"maxItems":16}                                                                                                                                                                            | C     | documented     |

**Constraints and applicability:**

- Use an exact image model ID. Sunburst and Flare are distinct models, not quality tiers.
- Output dimensions: multiples of 16, maximum edge 3840, area 655360–8294400 pixels, aspect ratio 1:3–3:1. Above 2560x1440 is experimental.
- Transparent background requires PNG or WebP; GPT Image 2 transparency remains preview.
- No documented Images API seed, negative prompt or CFG parameter.
- GPT Image 2.5 quality adds xhigh/max; GPT Image 2 supports through high. Native quality default is auto.
- Up to 16 references. Mask targets the first image and guides rather than guarantees pixel-exact edits.
- GPT Image 2 automatically uses high input fidelity; input_fidelity must be omitted. GPT Image 2.5 input_fidelity support is not established by the current field description.

Media limit details:

```json
{
  "inputImagesMax": 16,
  "binaryFileMaxBytesExclusive": 50000000
}
```

**Unknown / needs qualification:**

- Input codec/byte constraints must be validated against the exact request representation; never import retired DALL·E requirements.
- The audited multipart examples do not establish the representation of GPT Image 2.5 markup; JSON AssetRef markup support is documented separately.

### openai.gpt25.responses-tool

**Models:** `openai/gpt-image-2.5-sunburst`, `openai/gpt-image-2.5-flare`.

**Operations:** `text-to-image`, `image-edit`, `masked-edit`, `multi-turn-edit`.

**Request:** `POST https://api.openai.com/v1/responses` · JSON.

**Sources:** [openai.tool](https://developers.openai.com/api/docs/guides/tools-image-generation), [openai.guide](https://developers.openai.com/api/docs/guides/image-generation).

| Raw field                    | Type                     | Required    | Default | Enum / bounds                                         | Class | Status     |
| ---------------------------- | ------------------------ | ----------- | ------- | ----------------------------------------------------- | ----- | ---------- |
| `model`                      | mainline model ID        | yes         | ND      | ND                                                    | C     | documented |
| `input`                      | string\|content[]        | yes         | ND      | ND                                                    | S     | documented |
| `input[].image_url`          | string                   | conditional | ND      | ND                                                    | S     | documented |
| `input[].file_id`            | string                   | conditional | ND      | ND                                                    | S     | documented |
| `previous_response_id`       | string                   | no          | ND      | ND                                                    | T     | documented |
| `tools[].type`               | literal:image_generation | yes         | ND      | ND                                                    | S     | documented |
| `tools[].model`              | exact image model ID     | yes         | ND      | enum=["gpt-image-2.5-sunburst","gpt-image-2.5-flare"] | T     | documented |
| `tools[].action`             | string                   | no          | auto    | enum=["auto","generate","edit"]                       | S     | documented |
| `tools[].size`               | string                   | no          | auto    | ND                                                    | C     | documented |
| `tools[].quality`            | string                   | no          | auto    | enum=["auto","low","medium","high","xhigh","max"]     | S     | documented |
| `tools[].background`         | string                   | no          | auto    | enum=["auto","opaque","transparent"]                  | S     | documented |
| `tools[].output_format`      | string                   | no          | png     | enum=["png","jpeg","webp"]                            | C     | documented |
| `tools[].output_compression` | integer                  | no          | ND      | {"minimum":0,"maximum":100}                           | C     | documented |
| `tools[].input_image_mask`   | AssetRef                 | no          | ND      | ND                                                    | S     | documented |
| `tools[].partial_images`     | integer                  | no          | ND      | {"minimum":0,"maximum":3}                             | T     | documented |
| `stream`                     | boolean                  | no          | no      | ND                                                    | T     | documented |
| `safety_identifier`          | string                   | no          | ND      | {"maxLength":128}                                     | T     | documented |

**Constraints and applicability:**

- Top-level model is a supported mainline orchestrator; tools[].model selects the exact GPT Image model.
- Image tool action auto/generate/edit; image parameters retain their model-specific constraints.
- The mainline model can rewrite the prompt. Preserve revised_prompt separately.
- Multi-turn edits use previous_response_id or image IDs; those IDs are provider/context-bound.
- Images-only n is not established as a tool argument. Generic mainline model controls are not image-model controls.

**Unknown / needs qualification:**

- The full generic Responses schema is outside image-operation scope; use its own reference for text/tool platform controls.

### openai.gpt2.generate

**Models:** `openai/gpt-image-2`.

**Operations:** `text-to-image`.

**Request:** `POST https://api.openai.com/v1/images/generations` · JSON.

**Sources:** [openai.generate](https://developers.openai.com/api/reference/resources/images/methods/generate), [openai.guide](https://developers.openai.com/api/docs/guides/image-generation).

| Raw field            | Type          | Required | Default | Enum / bounds                                                             | Class | Status      |
| -------------------- | ------------- | -------- | ------- | ------------------------------------------------------------------------- | ----- | ----------- |
| `model`              | string        | yes      | ND      | enum=["gpt-image-2"]                                                      | C     | documented  |
| `prompt`             | string        | yes      | ND      | {"maxLength":32000}                                                       | C     | documented  |
| `background`         | string\|null  | no       | auto    | enum=["auto","opaque","transparent"]                                      | S     | documented  |
| `moderation`         | string\|null  | no       | auto    | enum=["auto","low"]                                                       | S     | documented  |
| `n`                  | integer\|null | no       | 1       | {"minimum":1,"maximum":10}                                                | C     | documented  |
| `output_compression` | integer\|null | no       | 100     | {"minimum":0,"maximum":100}                                               | C     | documented  |
| `output_format`      | string\|null  | no       | png     | enum=["png","jpeg","webp"]                                                | C     | documented  |
| `partial_images`     | integer\|null | no       | 0       | {"minimum":0,"maximum":3}                                                 | T     | documented  |
| `quality`            | string\|null  | no       | auto    | enum=["auto","low","medium","high"]                                       | S     | documented  |
| `safety_identifier`  | string\|null  | no       | ND      | {"maxLength":128}                                                         | T     | documented  |
| `size`               | string\|null  | no       | auto    | ND                                                                        | C     | documented  |
| `stream`             | boolean\|null | no       | no      | ND                                                                        | T     | documented  |
| `user`               | string        | no       | ND      | Fallback end-user identity; non-empty safety_identifier takes precedence. | T     | deprecated  |
| `response_format`    | string\|null  | no       | ND      | ND                                                                        | T     | unsupported |
| `style`              | string\|null  | no       | ND      | ND                                                                        | S     | unsupported |

**Constraints and applicability:**

- Use an exact image model ID. Sunburst and Flare are distinct models, not quality tiers.
- Output dimensions: multiples of 16, maximum edge 3840, area 655360–8294400 pixels, aspect ratio 1:3–3:1. Above 2560x1440 is experimental.
- Transparent background requires PNG or WebP; GPT Image 2 transparency remains preview.
- No documented Images API seed, negative prompt or CFG parameter.
- GPT Image 2.5 quality adds xhigh/max; GPT Image 2 supports through high. Native quality default is auto.

**Unknown / needs qualification:**

- Input codec/byte constraints must be validated against the exact request representation; never import retired DALL·E requirements.

### openai.gpt2.edit-json

**Models:** `openai/gpt-image-2`.

**Operations:** `image-edit`, `masked-edit`, `outpaint-by-prompt`.

**Request:** `POST https://api.openai.com/v1/images/edits` · JSON.

**Sources:** [openai.edit](https://developers.openai.com/api/reference/resources/images/methods/edit), [openai.guide](https://developers.openai.com/api/docs/guides/image-generation).

| Raw field            | Type            | Required                            | Default                | Enum / bounds                                                                                                                                                                              | Class | Status      |
| -------------------- | --------------- | ----------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ----------- |
| `model`              | string          | no                                  | gpt-image-2.5-sunburst | enum=["gpt-image-2"]; Default belongs to the generic endpoint and can select a different model; OpenGen must send the exact requested model explicitly.                                    | C     | documented  |
| `prompt`             | string          | yes                                 | ND                     | {"maxLength":32000,"minLength":1}                                                                                                                                                          | C     | documented  |
| `background`         | string\|null    | no                                  | auto                   | enum=["auto","opaque","transparent"]                                                                                                                                                       | S     | documented  |
| `moderation`         | string\|null    | no                                  | auto                   | enum=["auto","low"]                                                                                                                                                                        | S     | documented  |
| `n`                  | integer\|null   | no                                  | 1                      | {"minimum":1,"maximum":10}                                                                                                                                                                 | C     | documented  |
| `output_compression` | integer\|null   | no                                  | ND                     | {"minimum":0,"maximum":100}                                                                                                                                                                | C     | documented  |
| `output_format`      | string\|null    | no                                  | png                    | enum=["png","jpeg","webp"]                                                                                                                                                                 | C     | documented  |
| `partial_images`     | integer\|null   | no                                  | 0                      | {"minimum":0,"maximum":3}                                                                                                                                                                  | T     | documented  |
| `quality`            | string\|null    | no                                  | auto                   | enum=["auto","low","medium","high"]                                                                                                                                                        | S     | documented  |
| `safety_identifier`  | string\|null    | no                                  | ND                     | {"maxLength":128}                                                                                                                                                                          | T     | documented  |
| `size`               | string\|null    | no                                  | auto                   | ND                                                                                                                                                                                         | C     | documented  |
| `stream`             | boolean\|null   | no                                  | no                     | ND                                                                                                                                                                                         | T     | documented  |
| `user`               | string          | no                                  | ND                     | Fallback end-user identity; non-empty safety_identifier takes precedence.                                                                                                                  | T     | deprecated  |
| `images`             | array<AssetRef> | yes                                 | ND                     | {"minItems":1,"maxItems":16}                                                                                                                                                               | C     | documented  |
| `images[].file_id`   | string          | exactly_one_of_file_id_or_image_url | ND                     | ND                                                                                                                                                                                         | S     | documented  |
| `images[].image_url` | string          | exactly_one_of_file_id_or_image_url | ND                     | {"maxLength":20971520}                                                                                                                                                                     | S     | documented  |
| `mask`               | AssetRef        | no                                  | ND                     | ND                                                                                                                                                                                         | C     | documented  |
| `mask.file_id`       | string          | conditional                         | ND                     | ND                                                                                                                                                                                         | S     | documented  |
| `mask.image_url`     | string          | conditional                         | ND                     | {"maxLength":20971520}                                                                                                                                                                     | S     | documented  |
| `input_fidelity`     | string\|null    | no                                  | ND                     | enum=["high","low"]; GPT Image 2: omit (automatic high fidelity). GPT Image 2.5: current reference does not establish applicability; generic enum is for older supported GPT Image models. | S     | unsupported |

**Constraints and applicability:**

- Use an exact image model ID. Sunburst and Flare are distinct models, not quality tiers.
- Output dimensions: multiples of 16, maximum edge 3840, area 655360–8294400 pixels, aspect ratio 1:3–3:1. Above 2560x1440 is experimental.
- Transparent background requires PNG or WebP; GPT Image 2 transparency remains preview.
- No documented Images API seed, negative prompt or CFG parameter.
- GPT Image 2.5 quality adds xhigh/max; GPT Image 2 supports through high. Native quality default is auto.
- Up to 16 references. Mask targets the first image and guides rather than guarantees pixel-exact edits.
- JSON references choose exactly one file_id or image_url. The serialized image_url limit 20MiB and binary/mask guide limit under 50MB describe different representations.
- GPT Image 2 automatically uses high input fidelity; input_fidelity must be omitted. GPT Image 2.5 input_fidelity support is not established by the current field description.
- GPT Image 2.5 markup is a transparent PNG overlay matching the first image after orientation; markup and mask are mutually exclusive.

Media limit details:

```json
{
  "images": {
    "maxCount": 16,
    "formats": {
      "status": "not_documented_in_audited_current_edit_reference"
    },
    "maxFileSizeBytes": 50000000,
    "maxFileSizeOperator": "less_than",
    "transport": ["URL", "data URI", "file_id"]
  },
  "mask": {
    "alphaRequired": true,
    "sameSizeAndFormatAsInput": true,
    "appliesTo": "first input image",
    "precision": "guidance, not pixel-exact guarantee"
  },
  "markup": {
    "supported": false,
    "format": "png",
    "alphaRequired": true,
    "sameOrientedDimensionsAsFirstInput": true
  }
}
```

**Unknown / needs qualification:**

- Input codec/byte constraints must be validated against the exact request representation; never import retired DALL·E requirements.

### openai.gpt2.edit-multipart

**Models:** `openai/gpt-image-2`.

**Operations:** `image-edit`, `masked-edit`.

**Request:** `POST https://api.openai.com/v1/images/edits` · multipart/form-data.

**Sources:** [openai.edit](https://developers.openai.com/api/reference/resources/images/methods/edit), [openai.guide](https://developers.openai.com/api/docs/guides/image-generation).

| Raw field            | Type          | Required | Default                | Enum / bounds                                                                                                                                                                              | Class | Status      |
| -------------------- | ------------- | -------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ----------- |
| `model`              | string        | no       | gpt-image-2.5-sunburst | enum=["gpt-image-2"]; Default belongs to the generic endpoint and can select a different model; OpenGen must send the exact requested model explicitly.                                    | C     | documented  |
| `prompt`             | string        | yes      | ND                     | {"maxLength":32000,"minLength":1}                                                                                                                                                          | C     | documented  |
| `background`         | string\|null  | no       | auto                   | enum=["auto","opaque","transparent"]                                                                                                                                                       | S     | documented  |
| `moderation`         | string\|null  | no       | auto                   | enum=["auto","low"]                                                                                                                                                                        | S     | documented  |
| `n`                  | integer\|null | no       | 1                      | {"minimum":1,"maximum":10}                                                                                                                                                                 | C     | documented  |
| `output_compression` | integer\|null | no       | ND                     | {"minimum":0,"maximum":100}                                                                                                                                                                | C     | documented  |
| `output_format`      | string\|null  | no       | png                    | enum=["png","jpeg","webp"]                                                                                                                                                                 | C     | documented  |
| `partial_images`     | integer\|null | no       | 0                      | {"minimum":0,"maximum":3}                                                                                                                                                                  | T     | documented  |
| `quality`            | string\|null  | no       | auto                   | enum=["auto","low","medium","high"]                                                                                                                                                        | S     | documented  |
| `safety_identifier`  | string\|null  | no       | ND                     | {"maxLength":128}                                                                                                                                                                          | T     | documented  |
| `size`               | string\|null  | no       | auto                   | ND                                                                                                                                                                                         | C     | documented  |
| `stream`             | boolean\|null | no       | no                     | ND                                                                                                                                                                                         | T     | documented  |
| `user`               | string        | no       | ND                     | Fallback end-user identity; non-empty safety_identifier takes precedence.                                                                                                                  | T     | deprecated  |
| `mask`               | file          | no       | ND                     | Multipart upload, alpha mask with matching first-source dimensions/format.                                                                                                                 | C     | documented  |
| `input_fidelity`     | string\|null  | no       | ND                     | enum=["high","low"]; GPT Image 2: omit (automatic high fidelity). GPT Image 2.5: current reference does not establish applicability; generic enum is for older supported GPT Image models. | S     | unsupported |
| `image[]`            | file[]        | yes      | ND                     | {"maxItems":16}                                                                                                                                                                            | C     | documented  |

**Constraints and applicability:**

- Use an exact image model ID. Sunburst and Flare are distinct models, not quality tiers.
- Output dimensions: multiples of 16, maximum edge 3840, area 655360–8294400 pixels, aspect ratio 1:3–3:1. Above 2560x1440 is experimental.
- Transparent background requires PNG or WebP; GPT Image 2 transparency remains preview.
- No documented Images API seed, negative prompt or CFG parameter.
- GPT Image 2.5 quality adds xhigh/max; GPT Image 2 supports through high. Native quality default is auto.
- Up to 16 references. Mask targets the first image and guides rather than guarantees pixel-exact edits.
- GPT Image 2 automatically uses high input fidelity; input_fidelity must be omitted. GPT Image 2.5 input_fidelity support is not established by the current field description.

Media limit details:

```json
{
  "inputImagesMax": 16,
  "binaryFileMaxBytesExclusive": 50000000
}
```

**Unknown / needs qualification:**

- Input codec/byte constraints must be validated against the exact request representation; never import retired DALL·E requirements.
- The audited multipart examples do not establish the representation of GPT Image 2.5 markup; JSON AssetRef markup support is documented separately.

### openai.gpt2.responses-tool

**Models:** `openai/gpt-image-2`.

**Operations:** `text-to-image`, `image-edit`, `masked-edit`, `multi-turn-edit`.

**Request:** `POST https://api.openai.com/v1/responses` · JSON.

**Sources:** [openai.tool](https://developers.openai.com/api/docs/guides/tools-image-generation), [openai.guide](https://developers.openai.com/api/docs/guides/image-generation).

| Raw field                    | Type                     | Required    | Default | Enum / bounds                        | Class | Status     |
| ---------------------------- | ------------------------ | ----------- | ------- | ------------------------------------ | ----- | ---------- |
| `model`                      | mainline model ID        | yes         | ND      | ND                                   | C     | documented |
| `input`                      | string\|content[]        | yes         | ND      | ND                                   | S     | documented |
| `input[].image_url`          | string                   | conditional | ND      | ND                                   | S     | documented |
| `input[].file_id`            | string                   | conditional | ND      | ND                                   | S     | documented |
| `previous_response_id`       | string                   | no          | ND      | ND                                   | T     | documented |
| `tools[].type`               | literal:image_generation | yes         | ND      | ND                                   | S     | documented |
| `tools[].model`              | exact image model ID     | yes         | ND      | enum=["gpt-image-2"]                 | T     | documented |
| `tools[].action`             | string                   | no          | auto    | enum=["auto","generate","edit"]      | S     | documented |
| `tools[].size`               | string                   | no          | auto    | ND                                   | C     | documented |
| `tools[].quality`            | string                   | no          | auto    | enum=["auto","low","medium","high"]  | S     | documented |
| `tools[].background`         | string                   | no          | auto    | enum=["auto","opaque","transparent"] | S     | documented |
| `tools[].output_format`      | string                   | no          | png     | enum=["png","jpeg","webp"]           | C     | documented |
| `tools[].output_compression` | integer                  | no          | ND      | {"minimum":0,"maximum":100}          | C     | documented |
| `tools[].input_image_mask`   | AssetRef                 | no          | ND      | ND                                   | S     | documented |
| `tools[].partial_images`     | integer                  | no          | ND      | {"minimum":0,"maximum":3}            | T     | documented |
| `stream`                     | boolean                  | no          | no      | ND                                   | T     | documented |
| `safety_identifier`          | string                   | no          | ND      | {"maxLength":128}                    | T     | documented |

**Constraints and applicability:**

- Top-level model is a supported mainline orchestrator; tools[].model selects the exact GPT Image model.
- Image tool action auto/generate/edit; image parameters retain their model-specific constraints.
- The mainline model can rewrite the prompt. Preserve revised_prompt separately.
- Multi-turn edits use previous_response_id or image IDs; those IDs are provider/context-bound.
- Images-only n is not established as a tool argument. Generic mainline model controls are not image-model controls.

**Unknown / needs qualification:**

- The full generic Responses schema is outside image-operation scope; use its own reference for text/tool platform controls.

### xai.image.generate

**Models:** `xai/grok-imagine-image-2.0`.

**Operations:** `text-to-image`.

**Request:** `POST https://api.x.ai/v1/images/generations` · JSON.

**Sources:** [xai.generate](https://docs.x.ai/developers/model-capabilities/images/generation), [xai.reference](https://docs.x.ai/developers/rest-api-reference/inference/images), [xai.model](https://docs.x.ai/developers/models/grok-imagine-image-2.0).

| Raw field         | Type    | Required | Default | Enum / bounds                                                                                                      | Class | Status     |
| ----------------- | ------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------ | ----- | ---------- |
| `model`           | string  | yes      | ND      | enum=["grok-imagine-image-2.0"]                                                                                    | C     | documented |
| `prompt`          | string  | yes      | ND      | ND                                                                                                                 | C     | documented |
| `n`               | integer | no       | 1       | {"minimum":1,"maximum":10}                                                                                         | C     | documented |
| `aspect_ratio`    | string  | no       | auto    | enum=["auto","1:1","16:9","9:16","4:3","3:4","3:2","2:3","2:1","1:2","19.5:9","9:19.5","20:9","9:20","21:9","5:2"] | C     | documented |
| `resolution`      | string  | no       | 1k      | enum=["1k","2k"]                                                                                                   | C     | documented |
| `quality`         | string  | no       | auto    | enum=["auto","low","medium"]                                                                                       | S     | documented |
| `response_format` | string  | no       | url     | enum=["url","b64_json"]                                                                                            | T     | documented |
| `deferred`        | boolean | no       | no      | ND                                                                                                                 | T     | documented |

**Constraints and applicability:**

- Native request uses JSON; xAI does not accept OpenAI SDK multipart edits.
- quality auto currently selects low for generation and medium for editing; choose a supported explicit tier for repeatable estimates.
- Deferred mode returns request_id; poll GET/v1/images/{id}; results retained 24h; response_format must be url.
- No documented native seed, CFG, custom width/height, output compression, transparency, mask or layer-control fields.
- The Nov 2 retirement concerns grok-imagine-image-quality slug, not removal of the quality parameter.

**Unknown / needs qualification:**

- The fully expanded REST request schema is client-rendered. Native hard prompt length and file byte/pixel bounds were not established by the guide.
- Native generation guide and Python SDK qualify 1k/2k; the model price table lists 1.5K and fal exposes it. Retain this discrepancy.

### xai.image.edit

**Models:** `xai/grok-imagine-image-2.0`.

**Operations:** `image-edit`, `multi-reference-edit`, `iterative-output-as-input-edit`.

**Request:** `POST https://api.x.ai/v1/images/edits` · JSON.

**Sources:** [xai.edit](https://docs.x.ai/developers/model-capabilities/images/editing), [xai.multiedit](https://docs.x.ai/developers/model-capabilities/images/multi-image-editing), [xai.generate](https://docs.x.ai/developers/model-capabilities/images/generation), [xai.reference](https://docs.x.ai/developers/rest-api-reference/inference/images).

| Raw field          | Type          | Required          | Default | Enum / bounds                                                                                                      | Class | Status     |
| ------------------ | ------------- | ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------ | ----- | ---------- |
| `model`            | string        | yes               | ND      | enum=["grok-imagine-image-2.0"]                                                                                    | C     | documented |
| `prompt`           | string        | yes               | ND      | ND                                                                                                                 | C     | documented |
| `n`                | integer       | no                | 1       | {"minimum":1,"maximum":10}                                                                                         | C     | documented |
| `aspect_ratio`     | string        | no                | auto    | enum=["auto","1:1","16:9","9:16","4:3","3:4","3:2","2:3","2:1","1:2","19.5:9","9:19.5","20:9","9:20","21:9","5:2"] | C     | documented |
| `resolution`       | string        | no                | 1k      | enum=["1k","2k"]                                                                                                   | C     | documented |
| `quality`          | string        | no                | auto    | enum=["auto","low","medium"]                                                                                       | S     | documented |
| `response_format`  | string        | no                | url     | enum=["url","b64_json"]                                                                                            | T     | documented |
| `deferred`         | boolean       | no                | no      | ND                                                                                                                 | T     | documented |
| `image`            | object        | single_image_form | ND      | ND                                                                                                                 | C     | documented |
| `image.type`       | string        | conditional       | ND      | enum=["image_url","file"]                                                                                          | S     | documented |
| `image.url`        | string        | conditional       | ND      | ND                                                                                                                 | S     | documented |
| `image.file_id`    | string        | conditional       | ND      | ND                                                                                                                 | S     | documented |
| `images`           | array<object> | multi_image_form  | ND      | {"minItems":1,"maxItems":5}                                                                                        | C     | documented |
| `images[].type`    | string        | conditional       | ND      | ND                                                                                                                 | S     | documented |
| `images[].url`     | string        | conditional       | ND      | ND                                                                                                                 | S     | documented |
| `images[].file_id` | string        | conditional       | ND      | ND                                                                                                                 | S     | documented |

**Constraints and applicability:**

- Native request uses JSON; xAI does not accept OpenAI SDK multipart edits.
- quality auto currently selects low for generation and medium for editing; choose a supported explicit tier for repeatable estimates.
- Deferred mode returns request_id; poll GET/v1/images/{id}; results retained 24h; response_format must be url.
- No documented native seed, CFG, custom width/height, output compression, transparency, mask or layer-control fields.
- The Nov 2 retirement concerns grok-imagine-image-quality slug, not removal of the quality parameter.
- Single image or ordered images list; up to 5 sources. Can mix URL/data URI/file-ID sources in the REST list.
- Default edit framing follows the first source. Explicit supported aspect ratios can override it.
- Iterative editing feeds a prior output as the next source; no native image-conversation ID is documented in this flow.

Media limit details:

```json
{
  "maxReferenceImages": 5,
  "inputKinds": ["URL", "dataURI", "file_id"],
  "orderSignificant": true
}
```

**Unknown / needs qualification:**

- The fully expanded REST request schema is client-rendered. Native hard prompt length and file byte/pixel bounds were not established by the guide.
- Native generation guide and Python SDK qualify 1k/2k; the model price table lists 1.5K and fal exposes it. Retain this discrepancy.

### byteplus.seedream-pro.generate-edit

**Models:** `bytedance/seedream-5.0-pro`.

**Operations:** `text-to-image`, `image-edit`, `multi-reference-edit`, `transparent-image-edit`.

**Request:** `POST https://ark.ap-southeast.bytepluses.com/api/v3/images/generations` · JSON.

**Sources:** [byteplus.image](https://docs.byteplus.com/en/docs/modelark/image-generation-api).

| Raw field                                        | Type                  | Required                                 | Default  | Enum / bounds                          | Class | Status      |
| ------------------------------------------------ | --------------------- | ---------------------------------------- | -------- | -------------------------------------- | ----- | ----------- |
| `model`                                          | string                | yes                                      | ND       | ND                                     | C     | documented  |
| `prompt`                                         | string                | required_standard_optional_decomposition | ND       | ND                                     | C     | documented  |
| `image`                                          | string\|array<string> | no                                       | ND       | ND                                     | C     | documented  |
| `layer_decomposition`                            | boolean               | no                                       | no       | ND                                     | S     | documented  |
| `size`                                           | string                | no                                       | 2K       | enum=["1K","1.5K","2K","WIDTHxHEIGHT"] | C     | documented  |
| `optimize_prompt_options`                        | object                | no                                       | ND       | ND                                     | S     | documented  |
| `optimize_prompt_options.mode`                   | string                | no                                       | standard | enum=["standard","fast"]               | S     | documented  |
| `output_format`                                  | string                | no                                       | jpeg     | enum=["png","jpeg"]                    | C     | documented  |
| `background`                                     | string                | no                                       | opaque   | enum=["opaque","transparent"]          | S     | documented  |
| `response_format`                                | string                | no                                       | url      | enum=["url","b64_json"]                | T     | documented  |
| `watermark`                                      | boolean               | no                                       | yes      | ND                                     | S     | documented  |
| `sequential_image_generation`                    | string                | no                                       | disabled | enum=["auto","disabled"]               | S     | unsupported |
| `sequential_image_generation_options.max_images` | integer               | no                                       | 15       | {"minimum":1,"maximum":15}             | S     | unsupported |
| `stream`                                         | boolean               | no                                       | no       | ND                                     | T     | unsupported |

**Constraints and applicability:**

- The same /images/generations request selects standard generation/editing or layer decomposition.
- Standard Pro supports size tiers 1K/1.5K/2K (default 2K), or exact widthxheight; output area 921600–4624220 and ratio 1/16–16.
- Prompt recommendations are 300 Chinese characters or 600 English words; no hard maximum was established.
- Prompt optimization modes standard(default) and fast; fast is explicitly available for Pro.
- Transparent output requires exactly one alpha-channel input and PNG; JPEG is rejected. This is not general text-to-image transparency.
- Visible watermark defaults true. Image URLs expire after 24h.
- The generic reference lists sequential generation, max_images and streaming, but its supported-model lists exclude Pro; do not inherit Lite/4.x controls.
- No Pro seed, negative_prompt or guidance_scale field appears in this request reference.

Media limit details:

```json
{
  "referenceImages": {
    "maxCount": 10,
    "formats": ["jpeg", "png", "webp", "bmp", "tiff", "gif", "heic", "heif"],
    "maxBytes": 30000000,
    "widthAndHeightExclusiveMinimum": 14,
    "minPixels": 196,
    "maxPixels": 36000000,
    "minAspectRatio": 0.0625,
    "maxAspectRatio": 16
  }
}
```

**Unknown / needs qualification:**

- Hard prompt length and total request byte cap are not documented.
- Local edit capability does not establish an independent structured point/bbox input parameter in this API.

### byteplus.seedream-pro.decompose

**Models:** `bytedance/seedream-5.0-pro`.

**Operations:** `layer-decomposition`.

**Request:** `POST https://ark.ap-southeast.bytepluses.com/api/v3/images/generations` · JSON.

**Sources:** [byteplus.image](https://docs.byteplus.com/en/docs/modelark/image-generation-api).

| Raw field                                        | Type                  | Required                                 | Default  | Enum / bounds                          | Class | Status      |
| ------------------------------------------------ | --------------------- | ---------------------------------------- | -------- | -------------------------------------- | ----- | ----------- |
| `model`                                          | string                | yes                                      | ND       | ND                                     | C     | documented  |
| `prompt`                                         | string                | required_standard_optional_decomposition | ND       | ND                                     | C     | documented  |
| `image`                                          | string\|array<string> | no                                       | ND       | ND                                     | C     | documented  |
| `layer_decomposition`                            | boolean               | no                                       | no       | ND                                     | S     | documented  |
| `size`                                           | string                | no                                       | 2K       | enum=["1K","1.5K","2K","WIDTHxHEIGHT"] | C     | documented  |
| `optimize_prompt_options`                        | object                | no                                       | ND       | ND                                     | S     | documented  |
| `optimize_prompt_options.mode`                   | string                | no                                       | standard | enum=["standard","fast"]               | S     | documented  |
| `output_format`                                  | string                | no                                       | jpeg     | enum=["png","jpeg"]                    | C     | documented  |
| `background`                                     | string                | no                                       | opaque   | enum=["opaque","transparent"]          | S     | documented  |
| `response_format`                                | string                | no                                       | url      | enum=["url","b64_json"]                | T     | documented  |
| `watermark`                                      | boolean               | no                                       | yes      | ND                                     | S     | documented  |
| `sequential_image_generation`                    | string                | no                                       | disabled | enum=["auto","disabled"]               | S     | unsupported |
| `sequential_image_generation_options.max_images` | integer               | no                                       | 15       | {"minimum":1,"maximum":15}             | S     | unsupported |
| `stream`                                         | boolean               | no                                       | no       | ND                                     | T     | unsupported |

**Constraints and applicability:**

- The same /images/generations request selects standard generation/editing or layer decomposition.
- Standard Pro supports size tiers 1K/1.5K/2K (default 2K), or exact widthxheight; output area 921600–4624220 and ratio 1/16–16.
- Prompt recommendations are 300 Chinese characters or 600 English words; no hard maximum was established.
- Prompt optimization modes standard(default) and fast; fast is explicitly available for Pro.
- Transparent output requires exactly one alpha-channel input and PNG; JPEG is rejected. This is not general text-to-image transparency.
- Visible watermark defaults true. Image URLs expire after 24h.
- The generic reference lists sequential generation, max_images and streaming, but its supported-model lists exclude Pro; do not inherit Lite/4.x controls.
- No Pro seed, negative_prompt or guidance_scale field appears in this request reference.
- Set layer_decomposition=true; exactly one image, PNG/JPEG,30MB maximum,262144–36000000 pixels, ratio 1/16–16.
- Prompt is optional; omitted prompt lets the model identify major elements.
- Size defaults auto, and accepts only auto/1K/1.5K/2K; base keeps source ratio and layers keep their source-region ratios.
- Base plus up to 16 alpha PNG layers; metadata includes stacking order and absolute/normalized boxes. Any failed layer fails the request.
- output_format controls only the base image.

Media limit details:

```json
{
  "images": {
    "requiredCount": 1,
    "formats": ["png", "jpeg"],
    "maxBytes": 30000000,
    "minPixels": 262144,
    "maxPixels": 36000000,
    "aspectRatioRange": [0.0625, 16]
  },
  "output": {
    "basePlusLayers": true,
    "maxLayers": 16,
    "layerCodec": "png",
    "layerAlpha": true,
    "metadata": [
      "z_index",
      "bounding_box.absolute",
      "bounding_box.normalized",
      "name",
      "description"
    ]
  }
}
```

**Unknown / needs qualification:**

- Hard prompt length and total request byte cap are not documented.
- Local edit capability does not establish an independent structured point/bbox input parameter in this API.

### alibaba.qwen.openai-compatible

**Models:** `qwen/image-2.1-turbo`, `alibaba/qwen-image-2.1-pro`, `alibaba/qwen-image-3.0-pro`.

**Operations:** `text-to-image`, `image-edit`, `multi-reference-edit`.

**Request:** `POST https://{workspace}.{region}.maas.aliyuncs.com/compatible-mode/v1/images/generations` · JSON.

**Sources:** [qwen.api](https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference), [qwen.select](https://www.alibabacloud.com/help/en/model-studio/text-to-image).

| Raw field            | Type                  | Required | Default                   | Enum / bounds                                                           | Class | Status     |
| -------------------- | --------------------- | -------- | ------------------------- | ----------------------------------------------------------------------- | ----- | ---------- |
| `model`              | string                | yes      | ND                        | enum=["qwen-image-2.1-turbo","qwen-image-2.1-pro","qwen-image-3.0-pro"] | C     | documented |
| `prompt`             | string                | yes      | ND                        | ND                                                                      | C     | documented |
| `image`              | string\|array<string> | no       | ND                        | ND                                                                      | C     | documented |
| `n`                  | integer               | no       | 1                         | {"minimum":1,"maximum":6}                                               | C     | documented |
| `size`               | string                | no       | provider_auto_from_prompt | ND                                                                      | C     | documented |
| `negative_prompt`    | string                | no       | ND                        | ND                                                                      | C     | documented |
| `seed`               | integer               | no       | ND                        | {"minimum":0,"maximum":2147483647}                                      | C     | documented |
| `prompt_extend`      | boolean               | no       | yes                       | ND                                                                      | S     | documented |
| `prompt_extend_mode` | string                | no       | direct                    | enum=["direct","agent"]                                                 | S     | documented |
| `enable_thinking`    | boolean               | no       | yes                       | ND                                                                      | S     | documented |
| `watermark`          | boolean               | no       | no                        | ND                                                                      | S     | documented |
| `response_format`    | string                | no       | ND                        | ND                                                                      | T     | ignored    |

**Constraints and applicability:**

- Qwen2.1 Pro/Turbo accept 1–10 references; Qwen3Pro accepts1–3. Reference order is significant.
- Input formats JPEG/PNG/BMP/TIFF/WebP/GIF; each up to 10MB, edges 1–8000, long/short ratio<=10. Recommended edges 384–2048 are not hard bounds.
- Output PNG, area 262144–4194304 pixels and ratio 1:8–8:1. Omitted size is inferred from the prompt.
- Positive prompt is required; 4500 tokens is a recommendation, not a verified hard cap.
- prompt_extend defaults true; mode direct(default) supports T2I/I2I, agent only T2I; agent I2I returns400.
- enable_thinking defaults true and requires prompt_extend=true.
- negative_prompt is Qwen3-only. Seed 0–2147483647. Output count 1–6(default 1). Watermark defaultfalse.
- Qwen2.1 can choose RGBA from prompt; no dedicated background field. Qwen3Pro transparency is unqualified.
- Only one conversational round; DashScope requires one user message and one text content object.
- Six model-specific regional API URLs are shown, but docs still require checking model availability and matching region/workspace/key; do not claim every account can run every region.
- Parameters are top-level. Size uses widthxheight or auto, not DashScope width*height.
- Uses /images/generations for both T2I/I2I; /images/edits, multipart, stream and partial images unsupported. response_format=b64_json is silently ignored and URLs are returned.

Media limit details:

```json
{
  "images": {
    "maxCountByModel": {
      "qwen/image-2.1-turbo": 10,
      "alibaba/qwen-image-2.1-pro": 10,
      "alibaba/qwen-image-3.0-pro": 3
    },
    "formats": ["jpg", "jpeg", "png", "bmp", "tiff", "webp", "gif"],
    "maxBytes": 10000000,
    "minEdge": 1,
    "maxEdge": 8000,
    "maxLongShortRatio": 10,
    "recommendedEdgeRange": [384, 2048],
    "transport": ["HTTP URL", "HTTPS URL", "base64dataURI"],
    "orderSignificant": true
  }
}
```

**Unknown / needs qualification:**

- No mask/markup, quality, CFG, steps, codec/compression or multi-turn request controls are documented for these hosted variants.

### alibaba.qwen.sync

**Models:** `qwen/image-2.1-turbo`, `alibaba/qwen-image-2.1-pro`, `alibaba/qwen-image-3.0-pro`.

**Operations:** `text-to-image`, `image-edit`, `multi-reference-edit`.

**Request:** `POST https://{workspace}.{region}.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` · JSON.

**Sources:** [qwen.api](https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference).

| Raw field                          | Type         | Required | Default                   | Enum / bounds                                                           | Class | Status     |
| ---------------------------------- | ------------ | -------- | ------------------------- | ----------------------------------------------------------------------- | ----- | ---------- |
| `model`                            | string       | yes      | ND                        | enum=["qwen-image-2.1-turbo","qwen-image-2.1-pro","qwen-image-3.0-pro"] | C     | documented |
| `input`                            | object       | yes      | ND                        | ND                                                                      | S     | documented |
| `input.messages`                   | array        | yes      | ND                        | {"minItems":1,"maxItems":1}                                             | S     | documented |
| `input.messages[].role`            | literal:user | yes      | ND                        | ND                                                                      | S     | documented |
| `input.messages[].content`         | array        | yes      | ND                        | ND                                                                      | S     | documented |
| `input.messages[].content[].text`  | string       | yes      | ND                        | ND                                                                      | S     | documented |
| `input.messages[].content[].image` | string       | I2I      | ND                        | ND                                                                      | C     | documented |
| `parameters`                       | object       | no       | ND                        | ND                                                                      | S     | documented |
| `parameters.n`                     | integer      | no       | 1                         | {"minimum":1,"maximum":6}                                               | C     | documented |
| `parameters.size`                  | string       | no       | provider_auto_from_prompt | ND                                                                      | C     | documented |
| `parameters.negative_prompt`       | string       | no       | ND                        | ND                                                                      | C     | documented |
| `parameters.seed`                  | integer      | no       | ND                        | {"minimum":0,"maximum":2147483647}                                      | C     | documented |
| `parameters.prompt_extend`         | boolean      | no       | yes                       | ND                                                                      | S     | documented |
| `parameters.prompt_extend_mode`    | string       | no       | direct                    | enum=["direct","agent"]                                                 | S     | documented |
| `parameters.enable_thinking`       | boolean      | no       | yes                       | ND                                                                      | S     | documented |
| `parameters.watermark`             | boolean      | no       | no                        | ND                                                                      | S     | documented |

**Constraints and applicability:**

- Qwen2.1 Pro/Turbo accept 1–10 references; Qwen3Pro accepts1–3. Reference order is significant.
- Input formats JPEG/PNG/BMP/TIFF/WebP/GIF; each up to 10MB, edges 1–8000, long/short ratio<=10. Recommended edges 384–2048 are not hard bounds.
- Output PNG, area 262144–4194304 pixels and ratio 1:8–8:1. Omitted size is inferred from the prompt.
- Positive prompt is required; 4500 tokens is a recommendation, not a verified hard cap.
- prompt_extend defaults true; mode direct(default) supports T2I/I2I, agent only T2I; agent I2I returns400.
- enable_thinking defaults true and requires prompt_extend=true.
- negative_prompt is Qwen3-only. Seed 0–2147483647. Output count 1–6(default 1). Watermark defaultfalse.
- Qwen2.1 can choose RGBA from prompt; no dedicated background field. Qwen3Pro transparency is unqualified.
- Only one conversational round; DashScope requires one user message and one text content object.
- Six model-specific regional API URLs are shown, but docs still require checking model availability and matching region/workspace/key; do not claim every account can run every region.
- Request uses input.messages and parameters; size uses width*height.
- Async URL differs from synchronous multimodal endpoint and requires X-DashScope-Async:enable; task retention24h.

Media limit details:

```json
{
  "images": {
    "maxCountByModel": {
      "qwen/image-2.1-turbo": 10,
      "alibaba/qwen-image-2.1-pro": 10,
      "alibaba/qwen-image-3.0-pro": 3
    },
    "formats": ["jpg", "jpeg", "png", "bmp", "tiff", "webp", "gif"],
    "maxBytes": 10000000,
    "minEdge": 1,
    "maxEdge": 8000,
    "maxLongShortRatio": 10,
    "recommendedEdgeRange": [384, 2048],
    "transport": ["HTTP URL", "HTTPS URL", "base64dataURI"],
    "orderSignificant": true
  }
}
```

**Unknown / needs qualification:**

- No mask/markup, quality, CFG, steps, codec/compression or multi-turn request controls are documented for these hosted variants.

### alibaba.qwen.async

**Models:** `qwen/image-2.1-turbo`, `alibaba/qwen-image-2.1-pro`, `alibaba/qwen-image-3.0-pro`.

**Operations:** `text-to-image`, `image-edit`, `multi-reference-edit`.

**Request:** `POST https://{workspace}.{region}.maas.aliyuncs.com/api/v1/services/aigc/image-generation/generation` · JSON.

**Sources:** [qwen.api](https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference).

| Raw field                          | Type         | Required | Default                   | Enum / bounds                                                           | Class | Status     |
| ---------------------------------- | ------------ | -------- | ------------------------- | ----------------------------------------------------------------------- | ----- | ---------- |
| `model`                            | string       | yes      | ND                        | enum=["qwen-image-2.1-turbo","qwen-image-2.1-pro","qwen-image-3.0-pro"] | C     | documented |
| `input`                            | object       | yes      | ND                        | ND                                                                      | S     | documented |
| `input.messages`                   | array        | yes      | ND                        | {"minItems":1,"maxItems":1}                                             | S     | documented |
| `input.messages[].role`            | literal:user | yes      | ND                        | ND                                                                      | S     | documented |
| `input.messages[].content`         | array        | yes      | ND                        | ND                                                                      | S     | documented |
| `input.messages[].content[].text`  | string       | yes      | ND                        | ND                                                                      | S     | documented |
| `input.messages[].content[].image` | string       | I2I      | ND                        | ND                                                                      | C     | documented |
| `parameters`                       | object       | no       | ND                        | ND                                                                      | S     | documented |
| `parameters.n`                     | integer      | no       | 1                         | {"minimum":1,"maximum":6}                                               | C     | documented |
| `parameters.size`                  | string       | no       | provider_auto_from_prompt | ND                                                                      | C     | documented |
| `parameters.negative_prompt`       | string       | no       | ND                        | ND                                                                      | C     | documented |
| `parameters.seed`                  | integer      | no       | ND                        | {"minimum":0,"maximum":2147483647}                                      | C     | documented |
| `parameters.prompt_extend`         | boolean      | no       | yes                       | ND                                                                      | S     | documented |
| `parameters.prompt_extend_mode`    | string       | no       | direct                    | enum=["direct","agent"]                                                 | S     | documented |
| `parameters.enable_thinking`       | boolean      | no       | yes                       | ND                                                                      | S     | documented |
| `parameters.watermark`             | boolean      | no       | no                        | ND                                                                      | S     | documented |

**Constraints and applicability:**

- Qwen2.1 Pro/Turbo accept 1–10 references; Qwen3Pro accepts1–3. Reference order is significant.
- Input formats JPEG/PNG/BMP/TIFF/WebP/GIF; each up to 10MB, edges 1–8000, long/short ratio<=10. Recommended edges 384–2048 are not hard bounds.
- Output PNG, area 262144–4194304 pixels and ratio 1:8–8:1. Omitted size is inferred from the prompt.
- Positive prompt is required; 4500 tokens is a recommendation, not a verified hard cap.
- prompt_extend defaults true; mode direct(default) supports T2I/I2I, agent only T2I; agent I2I returns400.
- enable_thinking defaults true and requires prompt_extend=true.
- negative_prompt is Qwen3-only. Seed 0–2147483647. Output count 1–6(default 1). Watermark defaultfalse.
- Qwen2.1 can choose RGBA from prompt; no dedicated background field. Qwen3Pro transparency is unqualified.
- Only one conversational round; DashScope requires one user message and one text content object.
- Six model-specific regional API URLs are shown, but docs still require checking model availability and matching region/workspace/key; do not claim every account can run every region.
- Request uses input.messages and parameters; size uses width*height.
- Async URL differs from synchronous multimodal endpoint and requires X-DashScope-Async:enable; task retention24h.

Media limit details:

```json
{
  "images": {
    "maxCountByModel": {
      "qwen/image-2.1-turbo": 10,
      "alibaba/qwen-image-2.1-pro": 10,
      "alibaba/qwen-image-3.0-pro": 3
    },
    "formats": ["jpg", "jpeg", "png", "bmp", "tiff", "webp", "gif"],
    "maxBytes": 10000000,
    "minEdge": 1,
    "maxEdge": 8000,
    "maxLongShortRatio": 10,
    "recommendedEdgeRange": [384, 2048],
    "transport": ["HTTP URL", "HTTPS URL", "base64dataURI"],
    "orderSignificant": true
  }
}
```

**Unknown / needs qualification:**

- No mask/markup, quality, CFG, steps, codec/compression or multi-turn request controls are documented for these hosted variants.

### qwen.weights.local-inference

**Models:** `qwen/image-2.1`, `qwen/image-2.1-turbo`.

**Operations:** `text-to-image`, `image-conditioned-edit`, `multi-reference-edit`, `RGBA-generation`.

**Request:** `QwenImage21Pipeline.__call__` · Python local inference.

**Sources:** [qwen.base](https://huggingface.co/Qwen/Qwen-Image-2.1), [qwen.turbo](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo), [qwen.pipeline](https://huggingface.co/docs/diffusers/v0.42.0/en/api/pipelines/qwenimage21), [qwen.pipeline.source](https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py).

| Raw field                            | Type                       | Required                    | Default     | Enum / bounds                                | Class | Status     |
| ------------------------------------ | -------------------------- | --------------------------- | ----------- | -------------------------------------------- | ----- | ---------- |
| `prompt`                             | string\|array<string>      | prompt_or_prompt_embeds     | ND          | ND                                           | C     | documented |
| `image`                              | PILImage\|numpyArray\|list | no                          | ND          | ND                                           | C     | documented |
| `negative_prompt`                    | string\|array<string>      | no                          | ND          | ND                                           | C     | documented |
| `true_cfg_scale`                     | number                     | no                          | 1.0         | ND                                           | S     | documented |
| `height`                             | integer                    | no                          | ND          | ND                                           | C     | documented |
| `width`                              | integer                    | no                          | ND          | ND                                           | C     | documented |
| `num_inference_steps`                | integer                    | no                          | 40          | ND                                           | S     | documented |
| `sigmas`                             | array<number>              | no                          | ND          | ND                                           | S     | documented |
| `num_images_per_prompt`              | integer                    | no                          | 1           | ND                                           | C     | documented |
| `generator`                          | torch.Generator\|list      | no                          | ND          | ND                                           | C     | documented |
| `latents`                            | torch.Tensor               | no                          | ND          | ND                                           | S     | documented |
| `prompt_embeds`                      | torch.Tensor               | alternative_to_prompt       | ND          | ND                                           | S     | documented |
| `prompt_embeds_mask`                 | boolTensor                 | required_with_prompt_embeds | ND          | ND                                           | S     | documented |
| `use_kv_cache`                       | boolean                    | no                          | yes         | ND                                           | S     | documented |
| `output_type`                        | string                     | no                          | pil         | enum=["pil","np","pt","latent"]              | S     | documented |
| `return_dict`                        | boolean                    | no                          | yes         | ND                                           | S     | documented |
| `callback_on_step_end`               | callable                   | no                          | ND          | ND                                           | S     | documented |
| `callback_on_step_end_tensor_inputs` | array<string>              | no                          | ["latents"] | {"allowedItems":["latents","prompt_embeds"]} | S     | documented |
| `negative_prompt_embeds`             | torch.Tensor               | no                          | ND          | ND                                           | S     | documented |
| `negative_prompt_embeds_mask`        | boolTensor                 | no                          | ND          | ND                                           | S     | documented |
| `attention_kwargs`                   | dict                       | no                          | ND          | ND                                           | S     | documented |
| `output_resolution`                  | integer                    | no                          | 1024        | ND                                           | C     | documented |

**Constraints and applicability:**

- Base author recommendation:40 steps and CFG1. Turbo uses a configured8-step sigma schedule, CFG1; configured/explicit sigmas determine steps instead of num_inference_steps.
- prompt and prompt_embeds are mutually exclusive; one is required. Embeddings need their valid-token masks.
- Negative prompt or negative embeddings take effect with true_cfg_scale>1; this adds compute.
- A flat image list is one ordered condition set shared by all prompts; nested per-prompt condition lists are rejected.
- height/width are rounded/resized to the VAE scale-factor grid; avoid silently treating requested pixels as exact.
- The current pipeline signature has output_resolution(default 1024), negative embeddings and attention/callback controls; no max_sequence_length or dedicated mask argument.
- Fix seed and use_kv_cache for reproducibility; changing cache layout can visibly affect reduced-precision results.
- Model cards advertise annotations/separate-mask local edits, but this is not an independent mask argument or hosted API proof.
- Qwen Research License applies to weights; hosted Pro/Turbo API terms are separate.

Media limit details:

```json
{
  "referenceImages": {
    "maxCountModelCard": 10,
    "nativeRGBA": true
  },
  "hostedAPINotImplied": true
}
```

**Unknown / needs qualification:**

- No qualified hosted API for the exact base checkpoint.
- No universal provider-independent file size/prompt/edge bounds for all self-hosted runtimes.

### fal.bytedance/seedream/v5/pro/edit

**Models:** `bytedance/seedream-5.0-pro`.

**Operations:** `image-edit`.

**Request:** `POST https://queue.fal.run/bytedance/seedream/v5/pro/edit` · JSON.

**Sources:** [fal.bytedance/seedream/v5/pro/edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedream/v5/pro/edit).

Structural snapshot: [schemas/group3/bytedance__seedream__v5__pro__edit.openapi.json](schemas/group3/bytedance__seedream__v5__pro__edit.openapi.json).

| Raw field               | Type              | Required | Default  | Enum / bounds                                                                                    | Class | Status     |
| ----------------------- | ----------------- | -------- | -------- | ------------------------------------------------------------------------------------------------ | ----- | ---------- |
| `output_format`         | string            | no       | jpeg     | enum=["jpeg","png"]                                                                              | C     | documented |
| `image_size`            | ImageSize\|string | no       | auto_2K  | {"x-fal":{"max_aspect_ratio":16,"max_area":4624220,"min_area":921600,"min_aspect_ratio":0.0625}} | C     | documented |
| `image_size.width`      | integer           | no       | 512      | {"maximum":14142,"exclusiveMinimum":0}                                                           | C     | documented |
| `image_size.height`     | integer           | no       | 512      | {"maximum":14142,"exclusiveMinimum":0}                                                           | C     | documented |
| `prompt`                | string            | yes      | ND       | ND                                                                                               | C     | documented |
| `num_images`            | integer           | no       | 1        | {"minimum":1,"maximum":6}                                                                        | C     | documented |
| `image_urls`            | array             | yes      | ND       | ND                                                                                               | C     | documented |
| `background`            | string            | no       | opaque   | enum=["opaque","transparent"]                                                                    | S     | documented |
| `watermark`             | boolean           | no       | no       | ND                                                                                               | S     | documented |
| `enable_safety_checker` | boolean           | no       | yes      | ND                                                                                               | S     | documented |
| `enhance_prompt_mode`   | string            | no       | standard | enum=["standard","fast"]                                                                         | S     | documented |
| `sync_mode`             | boolean           | no       | no       | ND                                                                                               | T     | documented |

**Constraints and applicability:**

- Exact endpoint schema is the composed input object. Shared SDK and queue protocol do not imply identical model inputs.
- sync_mode changes data-URI delivery/history availability, not model image quality.
- Schema snapshots contain structural validation only; prose/model-level constraints below also matter.
- Output area 921600–4624220 and ratio 1/16–16; generic ImageSize bound cannot override them.
- num_images1–6 means separate generations, not native Pro sequential output.
- Edit image_urls has no formal maxItems, but prose says excess references silently keep the last10. OpenGen must reject excess input.
- Transparent edit needs exactly one alpha reference plus PNG. fal visible watermark defaults false; BytePlus defaults true.
- No layer_decomposition field in these two fal endpoints.

Media limit details:

```json
{
  "referenceImages": {
    "maxCountFromDescription": 10,
    "formalMaxItems": null,
    "excessBehavior": "silently keeps last10"
  },
  "backgroundTransparent": {
    "exactInputCount": 1,
    "alphaRequired": true,
    "outputFormat": "png"
  }
}
```

**Unknown / needs qualification:**

- Account access, exact processing location, successful execution and billing are not established by public schema.
- Schema omissions are not proof of unlimited input; source conflicts require conservative admission or live qualification.

### fal.bytedance/seedream/v5/pro/text-to-image

**Models:** `bytedance/seedream-5.0-pro`.

**Operations:** `text-to-image`.

**Request:** `POST https://queue.fal.run/bytedance/seedream/v5/pro/text-to-image` · JSON.

**Sources:** [fal.bytedance/seedream/v5/pro/text-to-image](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedream/v5/pro/text-to-image).

Structural snapshot: [schemas/group3/bytedance__seedream__v5__pro__text-to-image.openapi.json](schemas/group3/bytedance__seedream__v5__pro__text-to-image.openapi.json).

| Raw field               | Type              | Required | Default  | Enum / bounds                                                                                    | Class | Status     |
| ----------------------- | ----------------- | -------- | -------- | ------------------------------------------------------------------------------------------------ | ----- | ---------- |
| `output_format`         | string            | no       | jpeg     | enum=["jpeg","png"]                                                                              | C     | documented |
| `image_size`            | ImageSize\|string | no       | auto_2K  | {"x-fal":{"max_aspect_ratio":16,"max_area":4624220,"min_area":921600,"min_aspect_ratio":0.0625}} | C     | documented |
| `image_size.width`      | integer           | no       | 512      | {"maximum":14142,"exclusiveMinimum":0}                                                           | C     | documented |
| `image_size.height`     | integer           | no       | 512      | {"maximum":14142,"exclusiveMinimum":0}                                                           | C     | documented |
| `prompt`                | string            | yes      | ND       | ND                                                                                               | C     | documented |
| `num_images`            | integer           | no       | 1        | {"minimum":1,"maximum":6}                                                                        | C     | documented |
| `watermark`             | boolean           | no       | no       | ND                                                                                               | S     | documented |
| `enable_safety_checker` | boolean           | no       | yes      | ND                                                                                               | S     | documented |
| `enhance_prompt_mode`   | string            | no       | standard | enum=["standard","fast"]                                                                         | S     | documented |
| `sync_mode`             | boolean           | no       | no       | ND                                                                                               | T     | documented |

**Constraints and applicability:**

- Exact endpoint schema is the composed input object. Shared SDK and queue protocol do not imply identical model inputs.
- sync_mode changes data-URI delivery/history availability, not model image quality.
- Schema snapshots contain structural validation only; prose/model-level constraints below also matter.
- Output area 921600–4624220 and ratio 1/16–16; generic ImageSize bound cannot override them.
- num_images1–6 means separate generations, not native Pro sequential output.
- Edit image_urls has no formal maxItems, but prose says excess references silently keep the last10. OpenGen must reject excess input.
- Transparent edit needs exactly one alpha reference plus PNG. fal visible watermark defaults false; BytePlus defaults true.
- No layer_decomposition field in these two fal endpoints.

**Unknown / needs qualification:**

- Account access, exact processing location, successful execution and billing are not established by public schema.
- Schema omissions are not proof of unlimited input; source conflicts require conservative admission or live qualification.

### fal.fal-ai/gpt-image-2

**Models:** `openai/gpt-image-2`.

**Operations:** `text-to-image`.

**Request:** `POST https://queue.fal.run/fal-ai/gpt-image-2` · JSON.

**Sources:** [fal.fal-ai/gpt-image-2](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/gpt-image-2).

Structural snapshot: [schemas/group3/fal-ai__gpt-image-2.openapi.json](schemas/group3/fal-ai__gpt-image-2.openapi.json).

| Raw field               | Type              | Required | Default       | Enum / bounds                          | Class | Status     |
| ----------------------- | ----------------- | -------- | ------------- | -------------------------------------- | ----- | ---------- |
| `num_images`            | integer           | no       | 1             | {"minimum":1,"maximum":10}             | C     | documented |
| `image_size`            | ImageSize\|string | no       | landscape_4_3 | ND                                     | C     | documented |
| `image_size.height`     | integer           | no       | 512           | {"maximum":14142,"exclusiveMinimum":0} | C     | documented |
| `image_size.width`      | integer           | no       | 512           | {"maximum":14142,"exclusiveMinimum":0} | C     | documented |
| `background`            | string            | no       | auto          | enum=["auto","transparent","opaque"]   | S     | documented |
| `output_format`         | string            | no       | png           | enum=["jpeg","png","webp"]             | C     | documented |
| `prompt`                | string            | yes      | ND            | {"minLength":1,"maxLength":32000}      | C     | documented |
| `enable_safety_checker` | boolean           | no       | yes           | ND                                     | S     | documented |
| `output_compression`    | integer\|null     | no       | ND            | ND                                     | C     | documented |
| `sync_mode`             | boolean           | no       | no            | ND                                     | T     | documented |
| `quality`               | string            | no       | high          | enum=["auto","low","medium","high"]    | S     | documented |

**Constraints and applicability:**

- Exact endpoint schema is the composed input object. Shared SDK and queue protocol do not imply identical model inputs.
- sync_mode changes data-URI delivery/history availability, not model image quality.
- Schema snapshots contain structural validation only; prose/model-level constraints below also matter.
- Concrete size: multiples of 16, edge<=3840, area 655360–8294400, ratio<=3:1. Generic ImageSize edge 14142 is not the model cap.
- T2I default landscape_4_3 and high quality; edit defaults auto size and high quality. Native OpenAI defaults auto for both.
- Edit up to 16 refs; mask_url uses white=edit and black=keep. Native alpha-mask representation is different; markup is not exposed here.

**Unknown / needs qualification:**

- Account access, exact processing location, successful execution and billing are not established by public schema.
- Schema omissions are not proof of unlimited input; source conflicts require conservative admission or live qualification.

### fal.fal-ai/gpt-image-2/edit

**Models:** `openai/gpt-image-2`.

**Operations:** `image-edit`.

**Request:** `POST https://queue.fal.run/fal-ai/gpt-image-2/edit` · JSON.

**Sources:** [fal.fal-ai/gpt-image-2/edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/gpt-image-2/edit).

Structural snapshot: [schemas/group3/fal-ai__gpt-image-2__edit.openapi.json](schemas/group3/fal-ai__gpt-image-2__edit.openapi.json).

| Raw field               | Type              | Required | Default | Enum / bounds                          | Class | Status     |
| ----------------------- | ----------------- | -------- | ------- | -------------------------------------- | ----- | ---------- |
| `num_images`            | integer           | no       | 1       | {"minimum":1,"maximum":10}             | C     | documented |
| `image_urls`            | array             | yes      | ND      | {"maxItems":16}                        | C     | documented |
| `prompt`                | string            | yes      | ND      | {"minLength":1,"maxLength":32000}      | C     | documented |
| `background`            | string            | no       | auto    | enum=["auto","transparent","opaque"]   | S     | documented |
| `output_format`         | string            | no       | png     | enum=["jpeg","png","webp"]             | C     | documented |
| `image_size`            | ImageSize\|string | no       | auto    | ND                                     | C     | documented |
| `image_size.height`     | integer           | no       | 512     | {"maximum":14142,"exclusiveMinimum":0} | C     | documented |
| `image_size.width`      | integer           | no       | 512     | {"maximum":14142,"exclusiveMinimum":0} | C     | documented |
| `enable_safety_checker` | boolean           | no       | yes     | ND                                     | S     | documented |
| `output_compression`    | integer\|null     | no       | ND      | ND                                     | C     | documented |
| `mask_url`              | string\|null      | no       | ND      | ND                                     | C     | documented |
| `sync_mode`             | boolean           | no       | no      | ND                                     | T     | documented |
| `quality`               | string            | no       | high    | enum=["auto","low","medium","high"]    | S     | documented |

**Constraints and applicability:**

- Exact endpoint schema is the composed input object. Shared SDK and queue protocol do not imply identical model inputs.
- sync_mode changes data-URI delivery/history availability, not model image quality.
- Schema snapshots contain structural validation only; prose/model-level constraints below also matter.
- Concrete size: multiples of 16, edge<=3840, area 655360–8294400, ratio<=3:1. Generic ImageSize edge 14142 is not the model cap.
- T2I default landscape_4_3 and high quality; edit defaults auto size and high quality. Native OpenAI defaults auto for both.
- Edit up to 16 refs; mask_url uses white=edit and black=keep. Native alpha-mask representation is different; markup is not exposed here.

Media limit details:

```json
{
  "referenceImages": {
    "maxCount": 16,
    "formalMinItems": null
  },
  "markup": {
    "status": "not_exposed"
  }
}
```

**Unknown / needs qualification:**

- Account access, exact processing location, successful execution and billing are not established by public schema.
- Schema omissions are not proof of unlimited input; source conflicts require conservative admission or live qualification.

### fal.google/nano-banana-2.1

**Models:** `google/nano-banana-2.1`.

**Operations:** `text-to-image`.

**Request:** `POST https://queue.fal.run/google/nano-banana-2.1` · JSON.

**Sources:** [fal.google/nano-banana-2.1](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=google/nano-banana-2.1).

Structural snapshot: [schemas/group3/google__nano-banana-2.1.openapi.json](schemas/group3/google__nano-banana-2.1.openapi.json).

| Raw field           | Type          | Required | Default | Enum / bounds                     | Class | Status     |
| ------------------- | ------------- | -------- | ------- | --------------------------------- | ----- | ---------- |
| `thinking_level`    | string\|null  | no       | medium  | ND                                | S     | documented |
| `output_format`     | string        | no       | png     | enum=["jpeg","png","webp"]        | C     | documented |
| `sync_mode`         | boolean       | no       | no      | ND                                | T     | documented |
| `resolution`        | string        | no       | 1K      | enum=["1K","2K","4K"]             | C     | documented |
| `seed`              | integer\|null | no       | ND      | ND                                | C     | documented |
| `limit_generations` | boolean       | no       | yes     | ND                                | S     | documented |
| `prompt`            | string        | yes      | ND      | {"minLength":3,"maxLength":50000} | C     | documented |
| `aspect_ratio`      | string\|null  | no       | auto    | ND                                | C     | documented |
| `enable_web_search` | boolean       | no       | no      | ND                                | S     | documented |
| `num_images`        | integer       | no       | 1       | {"minimum":1,"maximum":4}         | C     | documented |
| `safety_tolerance`  | string        | no       | 4       | enum=["1","2","3","4","5","6"]    | S     | documented |
| `system_prompt`     | string        | no       |         | {"maxLength":50000}               | S     | documented |

**Constraints and applicability:**

- Exact endpoint schema is the composed input object. Shared SDK and queue protocol do not imply identical model inputs.
- sync_mode changes data-URI delivery/history availability, not model image quality.
- Schema snapshots contain structural validation only; prose/model-level constraints below also matter.
- Prompt 3–50000 characters and system_prompt 0–50000. Image count 14 from native model guide; fal array has no formal maxItems.
- Edit schema requires only prompt. image_urls can be replaced by video_url or pdf_url.
- Video/PDF downloads cap 15MB; a YouTube URL is passed through.
- thinking_level minimal/medium/high(defaultmedium), limit_generations true, web search false, output count 1–4, safety_tolerance strings1–6(default 4).
- limit_generations can disregard prompt count and intermediate images and may change quality.
- fal exposes a seed, but native reproducibility/bounds are not established by this schema.

Media limit details:

```json
{
  "referenceImages": {
    "maxCountNativeGuide": 14,
    "formalMaxItems": null
  },
  "videoAndPdfDownloadMaxBytes": 15000000,
  "youtubePassthrough": true
}
```

**Unknown / needs qualification:**

- Account access, exact processing location, successful execution and billing are not established by public schema.
- Schema omissions are not proof of unlimited input; source conflicts require conservative admission or live qualification.

### fal.google/nano-banana-2.1/edit

**Models:** `google/nano-banana-2.1`.

**Operations:** `image-edit`.

**Request:** `POST https://queue.fal.run/google/nano-banana-2.1/edit` · JSON.

**Sources:** [fal.google/nano-banana-2.1/edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=google/nano-banana-2.1/edit).

Structural snapshot: [schemas/group3/google__nano-banana-2.1__edit.openapi.json](schemas/group3/google__nano-banana-2.1__edit.openapi.json).

| Raw field           | Type          | Required | Default | Enum / bounds                     | Class | Status     |
| ------------------- | ------------- | -------- | ------- | --------------------------------- | ----- | ---------- |
| `thinking_level`    | string\|null  | no       | medium  | ND                                | S     | documented |
| `sync_mode`         | boolean       | no       | no      | ND                                | T     | documented |
| `pdf_url`           | string\|null  | no       | ND      | ND                                | S     | documented |
| `image_urls`        | array         | no       | ND      | ND                                | C     | documented |
| `num_images`        | integer       | no       | 1       | {"minimum":1,"maximum":4}         | C     | documented |
| `system_prompt`     | string        | no       |         | {"maxLength":50000}               | S     | documented |
| `resolution`        | string        | no       | 1K      | enum=["1K","2K","4K"]             | C     | documented |
| `seed`              | integer\|null | no       | ND      | ND                                | C     | documented |
| `video_url`         | string\|null  | no       | ND      | ND                                | S     | documented |
| `output_format`     | string        | no       | png     | enum=["jpeg","png","webp"]        | C     | documented |
| `limit_generations` | boolean       | no       | yes     | ND                                | S     | documented |
| `prompt`            | string        | yes      | ND      | {"minLength":3,"maxLength":50000} | C     | documented |
| `aspect_ratio`      | string\|null  | no       | auto    | ND                                | C     | documented |
| `enable_web_search` | boolean       | no       | no      | ND                                | S     | documented |
| `safety_tolerance`  | string        | no       | 4       | enum=["1","2","3","4","5","6"]    | S     | documented |

**Constraints and applicability:**

- Exact endpoint schema is the composed input object. Shared SDK and queue protocol do not imply identical model inputs.
- sync_mode changes data-URI delivery/history availability, not model image quality.
- Schema snapshots contain structural validation only; prose/model-level constraints below also matter.
- Prompt 3–50000 characters and system_prompt 0–50000. Image count 14 from native model guide; fal array has no formal maxItems.
- Edit schema requires only prompt. image_urls can be replaced by video_url or pdf_url.
- Video/PDF downloads cap 15MB; a YouTube URL is passed through.
- thinking_level minimal/medium/high(defaultmedium), limit_generations true, web search false, output count 1–4, safety_tolerance strings1–6(default 4).
- limit_generations can disregard prompt count and intermediate images and may change quality.
- fal exposes a seed, but native reproducibility/bounds are not established by this schema.

Media limit details:

```json
{
  "referenceImages": {
    "maxCountNativeGuide": 14,
    "formalMaxItems": null
  },
  "videoAndPdfDownloadMaxBytes": 15000000,
  "youtubePassthrough": true
}
```

**Unknown / needs qualification:**

- Account access, exact processing location, successful execution and billing are not established by public schema.
- Schema omissions are not proof of unlimited input; source conflicts require conservative admission or live qualification.

### fal.openai/gpt-image-2.5/flare/edit

**Models:** `openai/gpt-image-2.5-flare`.

**Operations:** `image-edit`.

**Request:** `POST https://queue.fal.run/openai/gpt-image-2.5/flare/edit` · JSON.

**Sources:** [fal.openai/gpt-image-2.5/flare/edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2.5/flare/edit).

Structural snapshot: [schemas/group3/openai__gpt-image-2.5__flare__edit.openapi.json](schemas/group3/openai__gpt-image-2.5__flare__edit.openapi.json).

| Raw field               | Type              | Required | Default | Enum / bounds                                     | Class | Status     |
| ----------------------- | ----------------- | -------- | ------- | ------------------------------------------------- | ----- | ---------- |
| `prompt`                | string            | yes      | ND      | {"minLength":1,"maxLength":32000}                 | C     | documented |
| `sync_mode`             | boolean           | no       | no      | ND                                                | T     | documented |
| `background`            | string            | no       | auto    | enum=["auto","transparent","opaque"]              | S     | documented |
| `image_size`            | ImageSize\|string | no       | auto    | ND                                                | C     | documented |
| `image_size.height`     | integer           | no       | 512     | {"maximum":14142,"exclusiveMinimum":0}            | C     | documented |
| `image_size.width`      | integer           | no       | 512     | {"maximum":14142,"exclusiveMinimum":0}            | C     | documented |
| `output_compression`    | integer\|null     | no       | ND      | ND                                                | C     | documented |
| `quality`               | string            | no       | high    | enum=["auto","low","medium","high","xhigh","max"] | S     | documented |
| `output_format`         | string            | no       | png     | enum=["jpeg","png","webp"]                        | C     | documented |
| `image_urls`            | array             | yes      | ND      | {"maxItems":16}                                   | C     | documented |
| `num_images`            | integer           | no       | 1       | {"minimum":1,"maximum":10}                        | C     | documented |
| `mask_url`              | string\|null      | no       | ND      | ND                                                | C     | documented |
| `enable_safety_checker` | boolean           | no       | yes     | ND                                                | S     | documented |

**Constraints and applicability:**

- Exact endpoint schema is the composed input object. Shared SDK and queue protocol do not imply identical model inputs.
- sync_mode changes data-URI delivery/history availability, not model image quality.
- Schema snapshots contain structural validation only; prose/model-level constraints below also matter.
- Concrete size: multiples of 16, edge<=3840, area 655360–8294400, ratio<=3:1. Generic ImageSize edge 14142 is not the model cap.
- T2I default landscape_4_3 and high quality; edit defaults auto size and high quality. Native OpenAI defaults auto for both.
- Edit up to 16 refs; mask_url uses white=edit and black=keep. Native alpha-mask representation is different; markup is not exposed here.

Media limit details:

```json
{
  "referenceImages": {
    "maxCount": 16,
    "formalMinItems": null
  },
  "markup": {
    "status": "not_exposed"
  }
}
```

**Unknown / needs qualification:**

- Account access, exact processing location, successful execution and billing are not established by public schema.
- Schema omissions are not proof of unlimited input; source conflicts require conservative admission or live qualification.

### fal.openai/gpt-image-2.5/flare/text-to-image

**Models:** `openai/gpt-image-2.5-flare`.

**Operations:** `text-to-image`.

**Request:** `POST https://queue.fal.run/openai/gpt-image-2.5/flare/text-to-image` · JSON.

**Sources:** [fal.openai/gpt-image-2.5/flare/text-to-image](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2.5/flare/text-to-image).

Structural snapshot: [schemas/group3/openai__gpt-image-2.5__flare__text-to-image.openapi.json](schemas/group3/openai__gpt-image-2.5__flare__text-to-image.openapi.json).

| Raw field               | Type              | Required | Default       | Enum / bounds                                     | Class | Status     |
| ----------------------- | ----------------- | -------- | ------------- | ------------------------------------------------- | ----- | ---------- |
| `prompt`                | string            | yes      | ND            | {"minLength":1,"maxLength":32000}                 | C     | documented |
| `sync_mode`             | boolean           | no       | no            | ND                                                | T     | documented |
| `background`            | string            | no       | auto          | enum=["auto","transparent","opaque"]              | S     | documented |
| `image_size`            | ImageSize\|string | no       | landscape_4_3 | ND                                                | C     | documented |
| `image_size.height`     | integer           | no       | 512           | {"maximum":14142,"exclusiveMinimum":0}            | C     | documented |
| `image_size.width`      | integer           | no       | 512           | {"maximum":14142,"exclusiveMinimum":0}            | C     | documented |
| `output_compression`    | integer\|null     | no       | ND            | ND                                                | C     | documented |
| `quality`               | string            | no       | high          | enum=["auto","low","medium","high","xhigh","max"] | S     | documented |
| `output_format`         | string            | no       | png           | enum=["jpeg","png","webp"]                        | C     | documented |
| `num_images`            | integer           | no       | 1             | {"minimum":1,"maximum":10}                        | C     | documented |
| `enable_safety_checker` | boolean           | no       | yes           | ND                                                | S     | documented |

**Constraints and applicability:**

- Exact endpoint schema is the composed input object. Shared SDK and queue protocol do not imply identical model inputs.
- sync_mode changes data-URI delivery/history availability, not model image quality.
- Schema snapshots contain structural validation only; prose/model-level constraints below also matter.
- Concrete size: multiples of 16, edge<=3840, area 655360–8294400, ratio<=3:1. Generic ImageSize edge 14142 is not the model cap.
- T2I default landscape_4_3 and high quality; edit defaults auto size and high quality. Native OpenAI defaults auto for both.
- Edit up to 16 refs; mask_url uses white=edit and black=keep. Native alpha-mask representation is different; markup is not exposed here.

**Unknown / needs qualification:**

- Account access, exact processing location, successful execution and billing are not established by public schema.
- Schema omissions are not proof of unlimited input; source conflicts require conservative admission or live qualification.

### fal.openai/gpt-image-2.5/sunburst/edit

**Models:** `openai/gpt-image-2.5-sunburst`.

**Operations:** `image-edit`.

**Request:** `POST https://queue.fal.run/openai/gpt-image-2.5/sunburst/edit` · JSON.

**Sources:** [fal.openai/gpt-image-2.5/sunburst/edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2.5/sunburst/edit).

Structural snapshot: [schemas/group3/openai__gpt-image-2.5__sunburst__edit.openapi.json](schemas/group3/openai__gpt-image-2.5__sunburst__edit.openapi.json).

| Raw field               | Type              | Required | Default | Enum / bounds                                     | Class | Status     |
| ----------------------- | ----------------- | -------- | ------- | ------------------------------------------------- | ----- | ---------- |
| `prompt`                | string            | yes      | ND      | {"minLength":1,"maxLength":32000}                 | C     | documented |
| `sync_mode`             | boolean           | no       | no      | ND                                                | T     | documented |
| `background`            | string            | no       | auto    | enum=["auto","transparent","opaque"]              | S     | documented |
| `image_size`            | ImageSize\|string | no       | auto    | ND                                                | C     | documented |
| `image_size.height`     | integer           | no       | 512     | {"maximum":14142,"exclusiveMinimum":0}            | C     | documented |
| `image_size.width`      | integer           | no       | 512     | {"maximum":14142,"exclusiveMinimum":0}            | C     | documented |
| `output_compression`    | integer\|null     | no       | ND      | ND                                                | C     | documented |
| `quality`               | string            | no       | high    | enum=["auto","low","medium","high","xhigh","max"] | S     | documented |
| `output_format`         | string            | no       | png     | enum=["jpeg","png","webp"]                        | C     | documented |
| `image_urls`            | array             | yes      | ND      | {"maxItems":16}                                   | C     | documented |
| `num_images`            | integer           | no       | 1       | {"minimum":1,"maximum":10}                        | C     | documented |
| `mask_url`              | string\|null      | no       | ND      | ND                                                | C     | documented |
| `enable_safety_checker` | boolean           | no       | yes     | ND                                                | S     | documented |

**Constraints and applicability:**

- Exact endpoint schema is the composed input object. Shared SDK and queue protocol do not imply identical model inputs.
- sync_mode changes data-URI delivery/history availability, not model image quality.
- Schema snapshots contain structural validation only; prose/model-level constraints below also matter.
- Concrete size: multiples of 16, edge<=3840, area 655360–8294400, ratio<=3:1. Generic ImageSize edge 14142 is not the model cap.
- T2I default landscape_4_3 and high quality; edit defaults auto size and high quality. Native OpenAI defaults auto for both.
- Edit up to 16 refs; mask_url uses white=edit and black=keep. Native alpha-mask representation is different; markup is not exposed here.

Media limit details:

```json
{
  "referenceImages": {
    "maxCount": 16,
    "formalMinItems": null
  },
  "markup": {
    "status": "not_exposed"
  }
}
```

**Unknown / needs qualification:**

- Account access, exact processing location, successful execution and billing are not established by public schema.
- Schema omissions are not proof of unlimited input; source conflicts require conservative admission or live qualification.

### fal.openai/gpt-image-2.5/sunburst/text-to-image

**Models:** `openai/gpt-image-2.5-sunburst`.

**Operations:** `text-to-image`.

**Request:** `POST https://queue.fal.run/openai/gpt-image-2.5/sunburst/text-to-image` · JSON.

**Sources:** [fal.openai/gpt-image-2.5/sunburst/text-to-image](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2.5/sunburst/text-to-image).

Structural snapshot: [schemas/group3/openai__gpt-image-2.5__sunburst__text-to-image.openapi.json](schemas/group3/openai__gpt-image-2.5__sunburst__text-to-image.openapi.json).

| Raw field               | Type              | Required | Default       | Enum / bounds                                     | Class | Status     |
| ----------------------- | ----------------- | -------- | ------------- | ------------------------------------------------- | ----- | ---------- |
| `prompt`                | string            | yes      | ND            | {"minLength":1,"maxLength":32000}                 | C     | documented |
| `sync_mode`             | boolean           | no       | no            | ND                                                | T     | documented |
| `background`            | string            | no       | auto          | enum=["auto","transparent","opaque"]              | S     | documented |
| `image_size`            | ImageSize\|string | no       | landscape_4_3 | ND                                                | C     | documented |
| `image_size.height`     | integer           | no       | 512           | {"maximum":14142,"exclusiveMinimum":0}            | C     | documented |
| `image_size.width`      | integer           | no       | 512           | {"maximum":14142,"exclusiveMinimum":0}            | C     | documented |
| `output_compression`    | integer\|null     | no       | ND            | ND                                                | C     | documented |
| `quality`               | string            | no       | high          | enum=["auto","low","medium","high","xhigh","max"] | S     | documented |
| `output_format`         | string            | no       | png           | enum=["jpeg","png","webp"]                        | C     | documented |
| `num_images`            | integer           | no       | 1             | {"minimum":1,"maximum":10}                        | C     | documented |
| `enable_safety_checker` | boolean           | no       | yes           | ND                                                | S     | documented |

**Constraints and applicability:**

- Exact endpoint schema is the composed input object. Shared SDK and queue protocol do not imply identical model inputs.
- sync_mode changes data-URI delivery/history availability, not model image quality.
- Schema snapshots contain structural validation only; prose/model-level constraints below also matter.
- Concrete size: multiples of 16, edge<=3840, area 655360–8294400, ratio<=3:1. Generic ImageSize edge 14142 is not the model cap.
- T2I default landscape_4_3 and high quality; edit defaults auto size and high quality. Native OpenAI defaults auto for both.
- Edit up to 16 refs; mask_url uses white=edit and black=keep. Native alpha-mask representation is different; markup is not exposed here.

**Unknown / needs qualification:**

- Account access, exact processing location, successful execution and billing are not established by public schema.
- Schema omissions are not proof of unlimited input; source conflicts require conservative admission or live qualification.

### fal.xai/grok-imagine-image/v2.0/edit

**Models:** `xai/grok-imagine-image-2.0`.

**Operations:** `image-edit`.

**Request:** `POST https://queue.fal.run/xai/grok-imagine-image/v2.0/edit` · JSON.

**Sources:** [fal.xai/grok-imagine-image/v2.0/edit](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=xai/grok-imagine-image/v2.0/edit).

Structural snapshot: [schemas/group3/xai__grok-imagine-image__v2.0__edit.openapi.json](schemas/group3/xai__grok-imagine-image__v2.0__edit.openapi.json).

| Raw field               | Type    | Required | Default | Enum / bounds                                                                                                      | Class | Status     |
| ----------------------- | ------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------ | ----- | ---------- |
| `quality`               | string  | no       | medium  | enum=["low","medium","auto"]                                                                                       | S     | documented |
| `sync_mode`             | boolean | no       | no      | ND                                                                                                                 | T     | documented |
| `num_images`            | integer | no       | 1       | {"minimum":1,"maximum":10}                                                                                         | C     | documented |
| `enable_safety_checker` | boolean | no       | yes     | ND                                                                                                                 | S     | documented |
| `aspect_ratio`          | string  | no       | auto    | enum=["2:1","20:9","19.5:9","16:9","4:3","3:2","1:1","2:3","3:4","9:16","9:19.5","9:20","1:2","auto","21:9","5:2"] | C     | documented |
| `prompt`                | string  | yes      | ND      | {"maxLength":8000}                                                                                                 | C     | documented |
| `output_format`         | string  | no       | jpeg    | enum=["jpeg","png","webp"]                                                                                         | C     | documented |
| `resolution`            | string  | no       | 1k      | enum=["1k","1.5k","2k"]                                                                                            | C     | documented |
| `image_urls`            | array   | no       | ND      | ND                                                                                                                 | C     | documented |

**Constraints and applicability:**

- Exact endpoint schema is the composed input object. Shared SDK and queue protocol do not imply identical model inputs.
- sync_mode changes data-URI delivery/history availability, not model image quality.
- Schema snapshots contain structural validation only; prose/model-level constraints below also matter.
- Current schema: output count 1–10, resolution1k/1.5k/2k and ratios including 21:9/5:2. Older landing copy says 1–4,1K/2K and 13 ratios.
- Current edit description allows 5 sources, but formal maxItems and required image_urls are absent. Older landing copy says 3.
- Do not import fal-only 1.5k or output codecs into native xAI capabilities without direct evidence.

Media limit details:

```json
{
  "referenceImages": {
    "maxCountFromDescription": 5,
    "formalMaxItems": null,
    "requiredInOAS": false
  }
}
```

**Unknown / needs qualification:**

- Account access, exact processing location, successful execution and billing are not established by public schema.
- Schema omissions are not proof of unlimited input; source conflicts require conservative admission or live qualification.

### fal.xai/grok-imagine-image/v2.0/text-to-image

**Models:** `xai/grok-imagine-image-2.0`.

**Operations:** `text-to-image`.

**Request:** `POST https://queue.fal.run/xai/grok-imagine-image/v2.0/text-to-image` · JSON.

**Sources:** [fal.xai/grok-imagine-image/v2.0/text-to-image](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=xai/grok-imagine-image/v2.0/text-to-image).

Structural snapshot: [schemas/group3/xai__grok-imagine-image__v2.0__text-to-image.openapi.json](schemas/group3/xai__grok-imagine-image__v2.0__text-to-image.openapi.json).

| Raw field               | Type    | Required | Default | Enum / bounds                                                                                                      | Class | Status     |
| ----------------------- | ------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------ | ----- | ---------- |
| `sync_mode`             | boolean | no       | no      | ND                                                                                                                 | T     | documented |
| `num_images`            | integer | no       | 1       | {"minimum":1,"maximum":10}                                                                                         | C     | documented |
| `enable_safety_checker` | boolean | no       | yes     | ND                                                                                                                 | S     | documented |
| `aspect_ratio`          | string  | no       | 1:1     | enum=["2:1","20:9","19.5:9","16:9","4:3","3:2","1:1","2:3","3:4","9:16","9:19.5","9:20","1:2","auto","21:9","5:2"] | C     | documented |
| `prompt`                | string  | yes      | ND      | {"maxLength":8000}                                                                                                 | C     | documented |
| `output_format`         | string  | no       | jpeg    | enum=["jpeg","png","webp"]                                                                                         | C     | documented |
| `resolution`            | string  | no       | 1k      | enum=["1k","1.5k","2k"]                                                                                            | C     | documented |
| `quality`               | string  | no       | medium  | enum=["low","medium","auto"]                                                                                       | S     | documented |

**Constraints and applicability:**

- Exact endpoint schema is the composed input object. Shared SDK and queue protocol do not imply identical model inputs.
- sync_mode changes data-URI delivery/history availability, not model image quality.
- Schema snapshots contain structural validation only; prose/model-level constraints below also matter.
- Current schema: output count 1–10, resolution1k/1.5k/2k and ratios including 21:9/5:2. Older landing copy says 1–4,1K/2K and 13 ratios.
- Current edit description allows 5 sources, but formal maxItems and required image_urls are absent. Older landing copy says 3.
- Do not import fal-only 1.5k or output codecs into native xAI capabilities without direct evidence.

**Unknown / needs qualification:**

- Account access, exact processing location, successful execution and billing are not established by public schema.
- Schema omissions are not proof of unlimited input; source conflicts require conservative admission or live qualification.

### replicate.seedream-pro

**Models:** `bytedance/seedream-5.0-pro`.

**Operations:** `text-to-image`, `image-edit`, `multi-reference-edit`, `layer-decomposition`.

**Request:** `POST https://api.replicate.com/v1/models/bytedance/seedream-5-pro/predictions` · JSON.

**Sources:** [replicate.seedream](https://replicate.com/bytedance/seedream-5-pro/api/schema).

Structural snapshot: [schemas/group3/replicate-seedream-pro.input.json](schemas/group3/replicate-seedream-pro.input.json).

| Raw field             | Type    | Required | Default           | Enum / bounds                                                                 | Class | Status     |
| --------------------- | ------- | -------- | ----------------- | ----------------------------------------------------------------------------- | ----- | ---------- |
| `size`                | string  | no       | 2K                | enum=["1K","1.5K","2K","auto"]                                                | C     | documented |
| `prompt`              | string  | no       |                   | {"maxLength":4000}                                                            | C     | documented |
| `image_input`         | array   | no       | []                | ND                                                                            | C     | documented |
| `aspect_ratio`        | string  | no       | match_input_image | enum=["match_input_image","1:1","4:3","3:4","16:9","9:16","3:2","2:3","21:9"] | C     | documented |
| `output_format`       | string  | no       | png               | enum=["png","jpeg"]                                                           | C     | documented |
| `layer_decomposition` | boolean | no       | no                | ND                                                                            | S     | documented |

**Constraints and applicability:**

- Standard size supports 1K/2K only;1.5K and auto are decomposition-only despite the broader enum.
- Standard prompt is semantically required; formal schema defaults to empty and has no required list. Decomposition prompt can be empty.
- Standard edit takes1–10 ordered image_input references; decomposition requires exactly one.
- aspect_ratio is ignored in decomposition; base/source-region ratios determine output.
- output_format controls the base only; layers are alpha PNG with stacking/box/name metadata.
- No seed, prompt enhancement, safety, watermark, compression or background input fields in this exact model schema.

Media limit details:

```json
{
  "standardMaxImages": 10,
  "decompositionExactlyOneImage": true,
  "maxLayers": 16
}
```

**Unknown / needs qualification:**

- Reseller input byte/format/pixel limits are not specified; do not automatically import BytePlus limits.

### google.nano-banana.interactions

**Models:** `google/nano-banana-2.1`.

**Operations:** `text-to-image`, `image-edit`, `multi-reference-edit`, `conversational-edit`, `video-or-PDF-context-to-image`, `search-grounded-image`.

**Request:** `POST https://generativelanguage.googleapis.com/v1beta/interactions` · JSON.

**Sources:** [google.model](https://aistudio.google.com/docs/models/gemini-nano-banana-2.1), [google.guide](https://aistudio.google.com/docs/image-generation), [google.interactions](https://aistudio.google.com/api-reference/interactions-api/create-interaction), [google.format](https://aistudio.google.com/api-reference/interactions-api#Resource:ResponseFormat).

| Raw field                              | Type                                  | Required                  | Default                | Enum / bounds                                                                                                                   | Class | Status         |
| -------------------------------------- | ------------------------------------- | ------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------- |
| `model`                                | literal:gemini-nano-banana-2.1        | yes                       | ND                     | ND                                                                                                                              | C     | documented     |
| `input`                                | string\|Content\|Content[]\|Step[]    | yes                       | ND                     | ND                                                                                                                              | S     | documented     |
| `input[].type`                         | string                                | content_block             | ND                     | enum=["text","image","video","document"]                                                                                        | S     | documented     |
| `input[].text`                         | string                                | text_block                | ND                     | ND                                                                                                                              | S     | documented     |
| `input[].data`                         | base64string                          | inline_media              | ND                     | ND                                                                                                                              | S     | documented     |
| `input[].uri`                          | string                                | uploaded_or_supported_URI | ND                     | ND                                                                                                                              | S     | documented     |
| `system_instruction`                   | string                                | no                        | ND                     | ND                                                                                                                              | S     | documented     |
| `previous_interaction_id`              | string                                | no                        | ND                     | ND                                                                                                                              | T     | documented     |
| `generation_config.seed`               | integer                               | no                        | ND                     | ND                                                                                                                              | C     | documented     |
| `generation_config.thinking_level`     | string                                | no                        | medium                 | enum=["minimal","medium","high"]                                                                                                | S     | documented     |
| `generation_config.thinking_summaries` | string                                | no                        | ND                     | enum=["auto","none"]                                                                                                            | S     | documented     |
| `generation_config.max_output_tokens`  | integer                               | no                        | ND                     | {"modelOutputTokenLimit":32768}                                                                                                 | S     | documented     |
| `generation_config.stop_sequences`     | array<string>                         | no                        | ND                     | ND                                                                                                                              | S     | not_documented |
| `generation_config.tool_choice`        | string\|object                        | no                        | ND                     | enum=["auto","any","none","validated"]                                                                                          | S     | documented     |
| `tools[]`                              | object                                | no                        | ND                     | ND                                                                                                                              | S     | documented     |
| `tools[].type`                         | literal:google_search                 | no                        | ND                     | ND                                                                                                                              | S     | documented     |
| `tools[].search_types`                 | array<string>                         | no                        | ND                     | enum=["web_search","image_search"]                                                                                              | S     | documented     |
| `response_format`                      | ImageResponseFormat\|ResponseFormat[] | no                        | ND                     | ND                                                                                                                              | T     | documented     |
| `response_format.type`                 | literal:image                         | yes                       | ND                     | ND                                                                                                                              | S     | documented     |
| `response_format.mime_type`            | string                                | no                        | ND                     | enum=["image/jpeg"]                                                                                                             | S     | documented     |
| `response_format.delivery`             | string                                | no                        | ND                     | enum=["inline","uri"]                                                                                                           | S     | documented     |
| `response_format.aspect_ratio`         | string                                | no                        | matches_input_else_1:1 | enum=["1:1","2:3","3:2","3:4","4:3","4:5","5:4","9:16","16:9","21:9","1:4","4:1","1:8","8:1"]                                   | C     | documented     |
| `response_format.image_size`           | string                                | no                        | 1K                     | enum=["1K","2K","4K"]                                                                                                           | C     | documented     |
| `stream`                               | boolean                               | no                        | ND                     | ND                                                                                                                              | T     | documented     |
| `store`                                | boolean                               | no                        | ND                     | ND                                                                                                                              | T     | documented     |
| `background`                           | boolean                               | no                        | ND                     | ND                                                                                                                              | T     | documented     |
| `continuation_token`                   | string                                | no                        | ND                     | ND                                                                                                                              | T     | documented     |
| `webhook_config.uris`                  | array<string>                         | no                        | ND                     | ND                                                                                                                              | S     | documented     |
| `webhook_config.user_metadata`         | object                                | no                        | ND                     | ND                                                                                                                              | S     | documented     |
| `labels`                               | object                                | no                        | ND                     | {"maxKeyAndValueCodepoints":63}                                                                                                 | T     | documented     |
| `service_tier`                         | string                                | no                        | ND                     | enum=["standard"]                                                                                                               | T     | documented     |
| `safety_settings[]`                    | object                                | no                        | ND                     | ND                                                                                                                              | S     | documented     |
| `safety_settings[].type`               | string                                | yes                       | ND                     | enum=["hate_speech","dangerous_content","harassment","sexually_explicit","jailbreak"]                                           | S     | documented     |
| `safety_settings[].threshold`          | string                                | yes                       | ND                     | enum=["block_low_and_above","block_medium_and_above","block_only_high","off"]                                                   | S     | documented     |
| `safety_settings[].method`             | string                                | no                        | ND                     | enum=["probability","severity"]                                                                                                 | S     | documented     |
| `input[].resolution`                   | string                                | no                        | ND                     | enum=["low","medium","high","ultra_high"]                                                                                       | S     | documented     |
| `input[].mime_type`                    | string                                | no                        | ND                     | enum=["image/png","image/jpeg","image/webp","image/heic","image/heif","image/gif","image/bmp","image/tiff"]; input[].type=image | S     | documented     |

**Constraints and applicability:**

- Image count up to 14, with high-fidelity guidance for up to 10 objects and 4 character references.
- Inputs text/image/video/PDF; no audio input or generated audio. Token context131072, output 32768.
- Default output text+image; explicit image format can request image only. Requested output count in prose is not guaranteed.
- Native multi-turn editing uses previous_interaction_id; preserve provider/model/owner binding.
- SynthID applies to all generated images; no documented disable switch.
- Only minimal/medium/high thinking levels are qualified for this model; medium is default. Generic low does not establish model support.
- Batch supported; model card excludes caching, code execution, function calling, Maps/FileSearch/URL-context tools, flex/priority, structured outputs and Live API.
- Google Web/Image Search grounding is supported; search_types is an array with web_search/image_search. Display required search_suggestions/citations in downstream clients.
- Image output defaults1K;1K/2K/4K supported. Generic response schema also lists 512, but the2.1 card does not.
- Formal ImageResponseFormat mime enum lists JPEG while guide examples use PNG. WebP is exposed by fal, not established in audited native format enum.

Media limit details:

```json
{
  "maxReferenceImages": 14,
  "objectFidelityImages": 10,
  "characterConsistencyImages": 4,
  "inputTypes": ["text", "image", "video", "PDF"],
  "audioInput": false,
  "audioOutput": false,
  "inputTokenLimit": 131072,
  "outputTokenLimit": 32768,
  "imageInputFormats": ["png", "jpeg", "webp", "heic", "heif", "gif", "bmp", "tiff"],
  "inputFileBytes": {
    "status": "not_documented_in_model_specific_audited_page"
  }
}
```

**Unknown / needs qualification:**

- Model-specific native input bytes, video seconds, PDF pages and exact combined-media limits are not established by these image-specific pages.
- Generic interaction parameters can be valid JSON but unsupported by this image model; do not infer support from shared API schema.

### xai.image.python-grpc

**Models:** `xai/grok-imagine-image-2.0`.

**Operations:** `text-to-image`, `image-edit`, `multi-reference-edit`.

**Request:** `xai_sdk.Client.image.sample / sample_batch` · Python SDK / gRPC.

**Sources:** [xai.sdk](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/image.py), [xai.proto](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/image_pb2.pyi), [xai.files](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/files.py).

| Raw field                                  | Type               | Required              | Default | Enum / bounds                                                                                         | Class | Status     |
| ------------------------------------------ | ------------------ | --------------------- | ------- | ----------------------------------------------------------------------------------------------------- | ----- | ---------- |
| `prompt`                                   | string             | yes                   | ND      | ND                                                                                                    | C     | documented |
| `model`                                    | string             | yes                   | ND      | ND                                                                                                    | C     | documented |
| `n`                                        | integer            | no                    | 1       | ND                                                                                                    | C     | documented |
| `image_url`                                | string             | no                    | ND      | ND                                                                                                    | C     | documented |
| `image_file_id`                            | string             | no                    | ND      | ND                                                                                                    | C     | documented |
| `image_urls`                               | array<string>      | no                    | ND      | ND                                                                                                    | C     | documented |
| `image_file_ids`                           | array<string>      | no                    | ND      | ND                                                                                                    | C     | documented |
| `user`                                     | string             | no                    | ND      | ND                                                                                                    | T     | documented |
| `image_format`                             | string             | no                    | url     | enum=["url","base64"]                                                                                 | T     | documented |
| `aspect_ratio`                             | string             | no                    | ND      | enum=["1:1","3:4","4:3","9:16","16:9","2:3","3:2","auto","9:19.5","19.5:9","9:20","20:9","1:2","2:1"] | C     | documented |
| `resolution`                               | string             | no                    | ND      | enum=["1k","2k"]                                                                                      | C     | documented |
| `quality`                                  | string             | no                    | ND      | enum=["low","medium"]                                                                                 | S     | documented |
| `storage_options`                          | object             | no                    | ND      | ND                                                                                                    | T     | documented |
| `storage_options.filename`                 | string             | required_when_storage | ND      | ND                                                                                                    | T     | documented |
| `storage_options.expires_after`            | seconds\|timedelta | no                    | ND      | ND                                                                                                    | T     | documented |
| `storage_options.public_url`               | boolean\|object    | no                    | ND      | ND                                                                                                    | T     | documented |
| `storage_options.public_url.expires_after` | seconds\|timedelta | no                    | ND      | ND                                                                                                    | T     | documented |

**Constraints and applicability:**

- Single image URL and single file ID are mutually exclusive. Single-input and multi-input forms are mutually exclusive.
- Multi file-ID and URL lists can be supplied together, but SDK appends file IDs first, then URLs. Canonical ordered references must not be split into two reordered lists.
- Python helper accepts quality low/medium and resolution1k/2k; REST guide additionally documents auto quality and 21:9/5:2 ratios. Do not assume language-SDK parity.
- Storage filename required; file TTL and public-URL TTL are independent. Omitted public_url stores privately; true inherits file TTL or no expiry.
- Proto has quality HIGH but this helper does not accept high; do not derive model capability from a broad enum alone.

**Unknown / needs qualification:**

- Storage expiry numeric min/max not established by this typed mapping.

## Evidence index

| Source                                            | Checked    | URL                                                                                                                                                                  |
| ------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai.generate`                                 | 2026-11-03 | [Official Images generation reference](https://developers.openai.com/api/reference/resources/images/methods/generate)                                                |
| `openai.edit`                                     | 2026-11-03 | [Official Images edit JSON/multipart reference](https://developers.openai.com/api/reference/resources/images/methods/edit)                                           |
| `openai.guide`                                    | 2026-11-03 | [Official image generation guide](https://developers.openai.com/api/docs/guides/image-generation)                                                                    |
| `openai.tool`                                     | 2026-11-03 | [Official Responses image tool guide](https://developers.openai.com/api/docs/guides/tools-image-generation)                                                          |
| `google.model`                                    | 2026-11-03 | [Official Nano Banana 2.1 model card](https://aistudio.google.com/docs/models/gemini-nano-banana-2.1)                                                                |
| `google.guide`                                    | 2026-11-03 | [Official native image generation guide](https://aistudio.google.com/docs/image-generation)                                                                          |
| `google.interactions`                             | 2026-11-03 | [Official CreateInteraction reference](https://aistudio.google.com/api-reference/interactions-api/create-interaction)                                                |
| `google.format`                                   | 2026-11-03 | [Official output format reference](https://aistudio.google.com/api-reference/interactions-api#Resource:ResponseFormat)                                               |
| `xai.generate`                                    | 2026-11-03 | [Official image generation guide](https://docs.x.ai/developers/model-capabilities/images/generation)                                                                 |
| `xai.edit`                                        | 2026-11-03 | [Official single-image edit guide](https://docs.x.ai/developers/model-capabilities/images/editing)                                                                   |
| `xai.multiedit`                                   | 2026-11-03 | [Official multi-image edit guide](https://docs.x.ai/developers/model-capabilities/images/multi-image-editing)                                                        |
| `xai.reference`                                   | 2026-11-03 | [Official Images REST reference](https://docs.x.ai/developers/rest-api-reference/inference/images)                                                                   |
| `xai.model`                                       | 2026-11-03 | [Official exact model card](https://docs.x.ai/developers/models/grok-imagine-image-2.0)                                                                              |
| `xai.retirement`                                  | 2026-11-03 | [Retired slug routing notice; quality parameter remains supported](https://docs.x.ai/developers/migration/imagine-image-quality-nov-2)                               |
| `byteplus.image`                                  | 2026-11-03 | [Official Seedream generation and decomposition reference; embedded MDContent read](https://docs.byteplus.com/en/docs/modelark/image-generation-api)                 |
| `qwen.api`                                        | 2026-11-03 | [Official Qwen protocol and input reference](https://www.alibabacloud.com/help/en/model-studio/qwen-image-generation-and-editing-api-reference)                      |
| `qwen.select`                                     | 2026-11-03 | [Official model selection and examples](https://www.alibabacloud.com/help/en/model-studio/text-to-image)                                                             |
| `qwen.base`                                       | 2026-11-03 | [Official base weight model card](https://huggingface.co/Qwen/Qwen-Image-2.1)                                                                                        |
| `qwen.turbo`                                      | 2026-11-03 | [Official Turbo weight model card](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo)                                                                                 |
| `qwen.repo`                                       | 2026-11-03 | [Official model repository](https://github.com/QwenLM/Qwen-Image-2.1)                                                                                                |
| `qwen.pipeline`                                   | 2026-11-03 | [Primary Diffusers QwenImage21Pipeline reference](https://huggingface.co/docs/diffusers/v0.42.0/en/api/pipelines/qwenimage21)                                        |
| `qwen.pipeline.source`                            | 2026-11-03 | [Primary pipeline function signature/implementation](https://github.com/huggingface/diffusers/blob/main/src/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py) |
| `replicate.seedream`                              | 2026-11-03 | [Official Replicate model input schema; embedded dereferenced OpenAPI read](https://replicate.com/bytedance/seedream-5-pro/api/schema)                               |
| `fal.bytedance/seedream/v5/pro/edit`              | 2026-11-03 | [Public exact endpoint OpenAPI3.1 snapshot](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedream/v5/pro/edit)                                |
| `fal.bytedance/seedream/v5/pro/text-to-image`     | 2026-11-03 | [Public exact endpoint OpenAPI3.1 snapshot](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedream/v5/pro/text-to-image)                       |
| `fal.fal-ai/gpt-image-2`                          | 2026-11-03 | [Public exact endpoint OpenAPI3.1 snapshot](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/gpt-image-2)                                            |
| `fal.fal-ai/gpt-image-2/edit`                     | 2026-11-03 | [Public exact endpoint OpenAPI3.1 snapshot](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/gpt-image-2/edit)                                       |
| `fal.google/nano-banana-2.1`                      | 2026-11-03 | [Public exact endpoint OpenAPI3.1 snapshot](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=google/nano-banana-2.1)                                        |
| `fal.google/nano-banana-2.1/edit`                 | 2026-11-03 | [Public exact endpoint OpenAPI3.1 snapshot](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=google/nano-banana-2.1/edit)                                   |
| `fal.openai/gpt-image-2.5/flare/edit`             | 2026-11-03 | [Public exact endpoint OpenAPI3.1 snapshot](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2.5/flare/edit)                               |
| `fal.openai/gpt-image-2.5/flare/text-to-image`    | 2026-11-03 | [Public exact endpoint OpenAPI3.1 snapshot](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2.5/flare/text-to-image)                      |
| `fal.openai/gpt-image-2.5/sunburst/edit`          | 2026-11-03 | [Public exact endpoint OpenAPI3.1 snapshot](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2.5/sunburst/edit)                            |
| `fal.openai/gpt-image-2.5/sunburst/text-to-image` | 2026-11-03 | [Public exact endpoint OpenAPI3.1 snapshot](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=openai/gpt-image-2.5/sunburst/text-to-image)                   |
| `fal.xai/grok-imagine-image/v2.0/edit`            | 2026-11-03 | [Public exact endpoint OpenAPI3.1 snapshot](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=xai/grok-imagine-image/v2.0/edit)                              |
| `fal.xai/grok-imagine-image/v2.0/text-to-image`   | 2026-11-03 | [Public exact endpoint OpenAPI3.1 snapshot](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=xai/grok-imagine-image/v2.0/text-to-image)                     |
| `xai.sdk`                                         | 2026-11-03 | [Official Python image request builder](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/image.py)                                                    |
| `xai.proto`                                       | 2026-11-03 | [Official generated v6 image protobuf declarations](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/image_pb2.pyi)                          |
| `xai.files`                                       | 2026-11-03 | [Official storage option mapping](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/files.py)                                                          |
