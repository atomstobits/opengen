# Published tariffs and quote qualification

Initial audit checked **2026-11-02, America/Los_Angeles**, using public primary sources. Scoped tariff qualifications below were rechecked on **2026-11-03**. The initial audit and tariff-qualification work did not read provider keys or make paid requests; separate live evidence is recorded in [dated validation](VALIDATION-2026-11-03.md). Currency below is USD; account discounts, taxes and individually negotiated terms were not established.

Several routes currently have empty `rates` because OpenGen has not qualified their full request-price formula. That must not be presented as “the provider publishes no price.” A published token tariff, tentative price or approximate worked example can be displayed with its conditions even when the request quote remains unavailable.

## Singapore Qwen text-to-image qualification — November 6, 2026

The Singapore International public list prices support text-only 1K/2K estimates for three exact routes. The current pricing table lists Turbo at $0.016 per output, 2.1 Pro at $0.04, and 3.0 Pro at $0.04 for 1K or $0.075 for 2K. The Turbo model card independently confirms its Singapore rate. [Model pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing) · [Turbo model card](https://www.alibabacloud.com/help/en/model-studio/qwen-image-2-1-turbo.md)

These rates apply to one text-generated output through the Singapore adapter. Qwen 3.0 Pro also charges $0.003 per input image. Edits/references, exact sizes and thinking modes keep unknown estimates, and other deployments keep their existing pricing restrictions. Account promotions and free quota do not replace standard estimates. The adapter retains unknown upstream cost until reconciled. Regression checks in `tests/qwen-pricing.test.ts` cover estimates, regional scope and exclusions; the existing Qwen response fixture in `tests/provider-coverage.test.ts` preserves the unknown cost. This qualification establishes source pricing; generation and hosted delivery still need dated evidence. [Model pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing)

## Interpretation and region boundary

- **Published tariff:** a provider's stated billing components, units and conditions. Suitable for a source-linked comparison display.
- **Complete configuration estimate:** every billable component is determined for a specific supported request. A fixed output-only price can fit the current `image` / `output-second` `Rate` units; a token or input-plus-output formula generally cannot.
- **Enforceable spending ceiling:** a provider-side mechanism that prevents a charge above a specified amount. **No per-request provider charge ceiling was established in this audit.** A complete list-price estimate is still not that mechanism.

These sources describe the named provider's public API offering. Except where stated below, they do not bind image/video pricing to a disclosed inference region. Do not copy prices onto unqualified regional routes or treat a provider's office address, API hostname, generic region list or batch availability as a model-specific residency guarantee.

## MiniMax first-party H3

The [official pricing overview](https://platform.minimax.io/docs/pricing/overview#video) publishes these output rates:

| Exact hosted variant | Resolution | Output / second | Input-video / second | Each image beyond free quota |
| -------------------- | ---------- | --------------: | -------------------: | ---------------------------: |
| H3                   | 768P       |           $0.08 |                $0.08 |                        $0.04 |
| H3                   | 2K         |           $0.13 |                $0.13 |                        $0.04 |
| H3 Highspeed         | 480P       |           $0.04 |                $0.04 |                        $0.03 |
| H3 Highspeed         | 768P       |           $0.06 |                $0.06 |                        $0.03 |
| H3 Lite              | 480P       |          $0.025 |               $0.025 |                        $0.02 |
| H3 Lite              | 768P       |           $0.04 |                $0.04 |                        $0.02 |
| H3 Max               | 480P       |           $0.05 |              $0.0553 |                       $0.074 |
| H3 Max               | 768P       |           $0.08 |               $0.143 |                       $0.074 |

H3/Highspeed/Lite include five input images per task; Max includes two. Audio input is free. Video references add duration-based input charges. A **text-only** five-second request therefore has a complete output-only estimate: H3 768P **$0.40**, Highspeed 480P **$0.20**, Lite 480P **$0.125**, Max 480P **$0.25**. These are hosted variants, not interchangeable checkpoints. The cited tariff does not establish separate regional pricing.

## xAI Imagine

The [official Imagine pricing table](https://docs.x.ai/developers/pricing#imagine-api) publishes:

| Model/configuration                            | Output tariff                    |
| ---------------------------------------------- | -------------------------------- |
| Grok Imagine Video 1.5, 480p / 720p / 1080p    | $0.08 / $0.14 / $0.25 per second |
| Video 1.5 Lite, 480p / 720p / 1080p            | $0.02 / $0.03 / $0.14 per second |
| Grok Imagine Image 2.0, low, 1K / 1.5K / 2K    | $0.04 / $0.05 / $0.06 per image  |
| Grok Imagine Image 2.0, medium, 1K / 1.5K / 2K | $0.06 / $0.07 / $0.08 per image  |

Image inputs add **$0.01 each** for these models. Text-only examples have complete list estimates: one 1K text-generated image at the adapter's low quality **$0.04**; five seconds at 480p **$0.40** for Video 1.5 or **$0.10** for Lite. Reference/edit requests must include input charges. The legacy editing model has different input/output units and remains a separate formula.

The [regional endpoint specification](https://docs.x.ai/developers/advanced-api-usage/regions) explicitly excludes image/video/voice from the US endpoint. Media uses the global endpoint, whose processing region is not guaranteed. Do not add a US media route or apply the text-token US premium to these media prices.

The [November 2 migration notice](https://docs.x.ai/developers/migration/imagine-image-quality-nov-2) concerns the retired `grok-imagine-image-quality` slug redirecting to Image 2.0 at low quality; it does not retire Image 2.0's medium-quality parameter.

## OpenAI GPT Image 2 and 2.5

[Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) and [Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst) list standard prices per **one million tokens**: text input **$5**, cached text **$1.25**, image input **$8**, cached image input **$2**, image output **$30**. Their documentation says the token rates match GPT Image 2. The [pricing page](https://developers.openai.com/api/docs/pricing#image-generation-models) separately lists half-price Batch rates; the synchronous Images adapter does not invoke Batch.

These are displayable tariffs, not fixed per-image prices. Size, quality, input token usage and image-output consumption determine the total. OpenAI specifically warns that the GPT Image 2 calculator does **not** estimate GPT Image 2.5 token consumption. Do not promote an earlier model's per-image table into a 2.5 quote. A maximum-quality or medium-quality image request alone does not establish a dollar ceiling; the audit did not qualify a complete token bound. No regional image tariff was established here.

## Google Gemini Developer API

The [official pricing page](https://aistudio.google.com/docs/pricing#gemini-omni-1.1-flash) lists Omni 1.1 Flash standard rates per million tokens: all input modalities **$1.50**, text output including thinking **$9**, video output **$17.50**. Its **5,792 tokens/second at 720p** conversion makes the video-output component approximately **$0.10136/second**; input and text/thinking costs remain additional. Displaying “about $0.10/second” as the complete generation price would omit components.

The [Nano Banana 2.1 section](https://aistudio.google.com/docs/pricing#gemini-nano-banana-2.1) lists standard input **$1.50/million**, output text/thinking **$7.50/million**, image output **$30/million**. Published image-output equivalents are **$0.0336 at 1K**, **$0.0504 at 2K**, approximately **$0.113 at 4K**. They exclude input/thinking. Batch is discounted; search grounding can add fees. The current adapter uses standard Interactions, not Batch or grounding. Neither model has a complete request-dollar bound from these output components alone. The cited Developer API tariffs do not establish Vertex regional availability or residency.

## fal reseller tariffs

Some model pages load pricing through public React server-component data rather than crawler-visible text. This audit read the named model's `pricingInfoOverride`/billing description from the public HTML, without authentication. Endpoint-specific pricing and editorial examples must be kept distinct.

| Exact endpoint family                                                                         | Published billing                                                                                                                                                                                                 | Quote consequence                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [H3 Max text-to-video](https://fal.ai/models/minimax/h3-max/text-to-video)                    | Standard 480p/768p/1080p **$0.05/$0.08/$0.16 per second**. **November 1–15** promotion: **$0.035/$0.056/$0.112**; standard resumes **November 16, 2026**.                                                         | Text-only fixed duration can use a complete output estimate. The page's general description also explains pooled reference-token charges, so do not apply output-only prices to arbitrary references.                                                                                           |
| [H3 Max Turbo text-to-video](https://fal.ai/models/minimax/h3-max-turbo/text-to-video)        | Standard **$0.025/$0.04/$0.08 per second** at 480p/768p/1080p. November 1–15: **$0.0175/$0.028/$0.056**, then standard November 16.                                                                               | Five seconds at 480p: current promo **$0.0875**, standard **$0.125**. Preserve promotion dates; the page does not specify a cutoff timezone.                                                                                                                                                    |
| [Seedance 2.0 standard](https://fal.ai/models/bytedance/seedance-2.0/text-to-video)           | **$0.014/1,000 video tokens**; displayed 720p **$0.3034/second**, 1080p **$0.682/second**.                                                                                                                        | Token formula depends on actual frame dimensions and duration. Approximate `/second` figures cannot cover every aspect ratio.                                                                                                                                                                   |
| [Seedance 2.0 Fast](https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video)          | Endpoint billing field: **$0.0112/1,000 tokens**, displayed 720p **$0.2419/second**. An editorial table elsewhere on the page says $0.014/1,000.                                                                  | Record this source inconsistency; do not silently choose one field as a guaranteed quote.                                                                                                                                                                                                       |
| [Seedance 2.5](https://fal.ai/models/bytedance/seedance-2.5/text-to-video)                    | **$0.0214/1,000 tokens** for 480p/720p. Token count is frame area × duration × 24 ÷ 1,024, with input-video duration included where applicable.                                                                   | The same page's approximate per-second figures and examples are not numerically identical to its authoritative formula. Show the token tariff; qualify dimensions/rounding before execution pricing.                                                                                            |
| [Seedream 5 Pro text-to-image](https://fal.ai/models/bytedance/seedream/v5/pro/text-to-image) | **Tentative** $0.0675/output image through 1536² pixels, $0.135 above that through 2048². The page explicitly says final pricing is unconfirmed.                                                                  | Display as tentative, with pixel-area bounds. Keep an execution quote unqualified until final/account pricing is established.                                                                                                                                                                   |
| [GPT Image 2.5](https://fal.ai/gpt-image-2.5)                                                 | Text input **$5/million**; image input/output **$8/$30/million**; cached text/image **$1.25/$2**; rounded up to **$0.0001**. Published short-prompt square-1024 medium example **$0.0133** is a measured example. | Token-based, not a flat image fee. Long prompts and edits add cost. The [endpoint billing override](https://fal.ai/models/openai/gpt-image-2.5/flare/text-to-image) mentions $10/million text output, while this landing page says text output is not charged; resolve before a complete quote. |
| [Nano Banana 2.1](https://fal.ai/models/google/nano-banana-2.1)                               | Input text/image **$1.764/million**, output text/thinking **$8.823/million**, output image **$35.294/million**. Representative short-prompt medium-thinking 1K/2K/4K totals **$0.040/$0.059/$0.134**.             | Examples depend on prompt/thinking usage. Do not flatten them into per-image guarantees or copy Google's first-party tariff onto fal.                                                                                                                                                           |

These fal prices do not establish an inference region. The separately documented [US-hosted Seedance 2.0](https://fal.ai/seedance-2.0-us-hosting) is account-enabled and has different pricing; do not copy global endpoint prices onto it.

## Replicate

The [Seedream 5 Pro model README](https://replicate.com/bytedance/seedream-5-pro#pricing) states **$0.045/output image at 1K**, **$0.09 at 2K**. This is a complete single-output standard text-to-image list estimate, with the model's exact resolution mapping; layer decomposition is a separate operation.

The public [Seedance 2.5 model page](https://replicate.com/bytedance/seedance-2.5) embeds a conditional pricing table in `react-component-props`. Its `video_output_duration_seconds` prices are:

| Input category | 480p / output second | 720p / output second |
| -------------- | -------------------: | -------------------: |
| `non_video_in` |              $0.1028 |              $0.2312 |
| `video_in`     |              $0.4304 |              $0.9676 |

Text-only, explicit-duration/no-video-input generation therefore has an output-only estimate: four seconds at 480p **$0.4112**. Video-input mode must select its own category. Do not use the page's unrelated generic hardware price or cached median as this model's output tariff. Replicate's [pricing policy](https://replicate.com/pricing) distinguishes runtime/hardware billing from model-specific input/output billing. These pages do not disclose a serving-region commitment.

## Recommended qualification sequence

1. Add source-linked display-only tariff metadata for token units, conditions, tentative status, dates and promotions. Preserve the current null request quote until the exact configuration has a supported calculation. Do not build a general user-programmable pricing interpreter.
2. Qualify simple **text-only** output-priced configurations first: MiniMax H3 variants; xAI image/video with explicit quality/resolution; fal H3 Max/Turbo with dated standard/promo handling; Replicate Seedream and non-video-input Seedance.
3. Test quote admission against exact adapter defaults. A model's public price table does not establish account access, output dimensions, supported operations or actual settlement.
4. Keep Google, OpenAI, fal token formulas and tentative fal Seedream outside flat-rate execution quotes until all required usage components and rounding rules are represented. Continue to display their published tariffs honestly.
5. Recheck prices immediately before a live test. Use the existing budget receipt and never reset earlier holds to make an unpriced provider fit a test allowance. Final settlement still needs authoritative usage/charge evidence.

The initial audit did not change catalog `Rate` records or executable eligibility. The scoped qualifications below record subsequent tariff/quote updates; they do not provide spending authorization.

## Scoped qualification — 2026-11-03

The exact [fal H3 Max Turbo text-to-video page](https://fal.ai/models/minimax/h3-max-turbo/text-to-video) and its [API schema](https://fal.ai/models/minimax/h3-max-turbo/text-to-video/api) were rechecked. Only that route now has fixed output-second estimates, conservatively using standard rates of **$0.025 / $0.04 / $0.08** at **480p / 768p / 1080p**. The November 1–15 promotion is separately documented at $0.0175 / $0.028 / $0.056; it is not baked into a timeless quote. Standard rates resume November 16, 2026, according to the checked page.

Qualification covers text-only generation with prompt expansion disabled (including the adapter default). Target audio, frames, references, edit operations and other expansion modes remain outside the qualified estimate. H3 Max Turbo remains separate from `minimax/h3-max`; neither native nor fal H3 Max receives these rates. The provider bills generated video seconds and warns output can run about 0.7 seconds longer than requested, so a requested-duration quote remains an estimate. Settled charges, account access, processing/storage regions and output fidelity are separate evidence; this tariff update does not mark the route live-verified.

## Native MiniMax H3 text-only qualification — 2026-11-03

The first-party [pricing overview](https://platform.minimax.io/docs/pricing/overview#video) and [V2 create reference](https://platform.minimax.io/docs/api-reference/video-generation-v2-create) were rechecked independently. The four native routes now qualify the exact output-second tariffs above for **text-to-video only**, without any input media. Native H3 Max is the canonical `minimax/h3-max` variant; its first-party rates are not copied onto the separate fal route. H3 Max Turbo and H3 Flex remain distinct variants.

The documented integer duration is **4–15 seconds** for native H3, Highspeed and Lite, and **5–15 seconds** for native Max. Catalog route bounds and canonical Highspeed/Lite discovery now agree with the adapter's existing four-second support. The shared five-second default is unchanged; the smoke planner explicitly selects the shortest allowed duration. The smallest native request is therefore **Lite, 480p, four seconds: USD 0.10**; its conservative smoke-budget reservation is **USD 0.20**. The shortest other output-only estimates are H3 768p USD 0.32, Highspeed 480p USD 0.16 and Max 480p USD 0.25.

This qualification does not price frames, reference media, video input, Context-IR or regeneration. Even source-described free-image allowances are not extrapolated into a complete reference quote. Native Max quotes cover only the adapter's explicitly disabled/default prompt-expansion setting; other expansion settings remain unpriced. No provider processing/storage region, account entitlement, output success or charge ceiling is established by these rates. The [task-query API](https://platform.minimax.io/docs/api-reference/video-generation-v2-query) reports usage, but the adapter deliberately keeps billed cost unknown until actual charges are reconciled; a requested-duration quote is not a settled charge. These tariff changes are fixture-backed until separately dated live evidence is recorded.

## xAI Image 2.0 low-quality text generation — 2026-11-03

The [official Imagine tariff](https://docs.x.ai/developers/pricing#imagine-api) and [image-generation guide](https://docs.x.ai/developers/model-capabilities/images/generation) were rechecked. The exact `grok-imagine-image-2.0` route now qualifies **one text-generated image at low quality: USD 0.04 at 1K or USD 0.06 at 2K**. Omitting quality is covered because the adapter explicitly sends `low` for text generation. The smoke planner proposes one 1K image, USD 0.04 estimated and USD 0.08 conservatively reserved.

The current `Rate` structure has no quality dimension. A scoped quote guard therefore excludes explicit `auto` and `medium`, even though those values remain discoverable and adapter-supported; they must not inherit the lower low-quality price. Editing, references, multiple outputs, 1.5K and xAI video remain unpriced by this qualification. No input-image fee, regional entitlement or eventual settled charge is inferred. This global media API does not promise a fixed inference region. Provider polling preserves unknown billing when the documented charge field is missing or invalid, as qualified below.

## xAI provider-reported cost ticks — 2026-11-03

The official [cost-tracking guide](https://docs.x.ai/developers/cost-tracking) identifies `usage.cost_in_usd_ticks` as the actual per-request amount charged after discounts for both image and video responses, with **10,000,000,000 ticks per USD**. The [deferred-image result example](https://docs.x.ai/developers/rest-api-reference/inference/images) and [video-result example](https://docs.x.ai/developers/rest-api-reference/inference/videos) include that same field. It is independent of the catalog quote: for example, 400,000,000 ticks reports USD 0.04, whether or not a matching fixed tariff exists.

The xAI adapter now reads this field from terminal generation responses, including explicit failed/policy outcomes when a valid charge is reported. It accepts only nonnegative safe integer JSON numbers. Conversion uses integer arithmetic at 10,000 ticks per micro-USD and rounds any sub-micro remainder upward, avoiding an understated reservation settlement or floating-point conversion error. Explicit zero remains a reported zero; absent, fractional, negative, unsafe or otherwise malformed values remain unknown. Pending/expired responses do not settle billing, and output delivery remains separate from the provider charge. This source/fixture qualification does not imply new paid calls or an invoice reconciliation.

## fal H3 Max, xAI Video 1.5 / Lite and bounded first-party token reservations — 2026-11-13

- **fal H3 Max (`fal-undisclosed/fal-h3-max`)** now qualifies standard text-to-video output-second rates (**$0.05 / $0.08 / $0.16** at **480p / 768p / 1080p**) with prompt expansion disabled, excluding the temporary November 1–15 promotion and excluding media inputs or other expansion modes.
- **xAI Grok Imagine Video 1.5 and 1.5 Lite (`xai-undisclosed/xai-grok-imagine-video-1.5`, `1.5-lite`)** now qualify text-to-video output-second rates (**$0.08 / $0.14 / $0.25** and **$0.02 / $0.03 / $0.14** at **480p / 720p / 1080p**). Image-to-video, reference-to-video and legacy video editing/extension remain unpriced because media inputs incur separate charges.
- **First-party OpenAI (`gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`) and Google (`gemini-nano-banana-2.1`, `gemini-omni-1.1-flash`)** keep `route.rates = []` (no flat per-output fee) while `packages/catalog/src/token-pricing.ts` computes deterministic conservative max-token reservations for text-only generation from UTF-8 prompt byte bounds plus resolution/quality/thinking/duration output-token ceilings. On completion, `packages/engine/src/openai.ts` and `packages/engine/src/google-usage.ts` settle exact micro-USD (rounded upward from nano-USD) only when all token buckets are nonnegative safe integers and strictly conserved (`input + output [+ thought] === total_tokens`), releasing unused reservation; incomplete or ambiguous usage fails closed to `null` for reconciliation. Image edits, custom pixel boxes, grounding and media-reference video modes remain unpriced, and route verification status remains `documented` until live-generation evidence is recorded.

## Alibaba six-region Qwen, BytePlus ModelArk expansion and fal six-family routes — 2026-11-13

- **Alibaba Model Studio regional Qwen Image (`ap-southeast-1`, `us-east-1`, `eu-central-1`, `cn-hongkong`, `ap-northeast-1`, `cn-beijing`)**: All six regions expose dedicated `{workspaceId}.{region}.maas.aliyuncs.com` endpoints for `qwen-image-2.1-turbo`, `qwen-image-2.1-pro` and `qwen-image-3.0-pro`. Singapore International text-to-image list rates remain **$0.016** (Turbo), **$0.04** (2.1 Pro) and **$0.04 / $0.075** (3.0 Pro 1K / 2K); the other five regions list **$0.014133**, **$0.035333** and **$0.034380 / $0.068761** respectively ([Model Studio billing](https://www.alibabacloud.com/help/en/model-studio/billing-for-model-studio)). Image edits, exact custom sizes and thinking modes remain unpriced (`3.0-pro` adds $0.003 per input image in Singapore and $0.00275 in the other five regions).
- **BytePlus ModelArk Seedance bounded token quotes & Seedream 4.0–5.5**: Non-video-input Singapore ModelArk Seedance requests (`2.5`, `2.0`, `2.0-fast`, `2.0-mini`, `1.0-pro`, `1.0-pro-fast`) keep `route.rates = []` and reserve deterministic max-token ceilings `(max_tier_pixels × 24 × duration) ÷ 1,024` at published per-million-token rates (**$10.70 / $11.70** on 2.5, **$7.00 / $7.70 / $4.00** on 2.0, **$5.60** on 2.0 Fast, **$3.50** on 2.0 Mini, **$2.50** on 1.0 Pro, **$1.00** on 1.0 Pro Fast), settling exact reported `usage.completion_tokens` on completion while keeping video-input tasks unpriced. Seedream Singapore text-to-image list tariffs add **5.5** ($0.02 at 1K/1.5K, $0.035 at 2K), **5.0 Flash** ($0.018), **5.0 Lite** ($0.035 at 2K/3K/4K), **4.5** ($0.04 at 2K/4K) and **4.0** ($0.03 at 1K/2K/4K).
- **fal six-family reseller routes**: Adds output-priced text-to-video / image-to-video routes where fal publishes deterministic non-token rates — **Gemini Omni Flash v1.1** ($0.03 / $0.10 / $0.15 / $0.30 per second at 360p / 720p / 1080p / 4K), **Alibaba Wan 3.0** ($0.05 / $0.10 / $0.20) and **Wan 3.0 Prime** ($0.068 / $0.14 / $0.28), **MiniMax H3** ($0.05 / $0.06 / $0.13 / $0.16 at 480p / 768p / 2K / 4K with prompt expansion disabled), **Grok Imagine Video 1.5 / 1.5 Lite** text-to-video ($0.08 / $0.14 / $0.25 and $0.02 / $0.03 / $0.14), **Grok Imagine Image 2.0** single low-quality text-to-image ($0.04 / $0.05 / $0.06 at 1K / 1.5K / 2K), **Seedream v5.5 / v5 Lite / v4.5** text-to-image, and **Qwen Image 3** (`fal/qwen-image-3`, $0.04 / $0.075 at 1K / 2K). Token-billed or variable-input fal routes (`openai/gpt-image-2*`, `bytedance/seedance-*`, `seedream/v5/flash`, `seedream/v4`, `minimax/h3-max*` I2V/R2V, `xai` video I2V/R2V/edit/extend, and `image-edit` endpoints) keep `rates: []` with source-linked `publishedPricing`.
