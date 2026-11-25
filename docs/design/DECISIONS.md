# OpenGen visual direction

2026-11-02: the user chose the third initial concept, the dark terminal-inspired direction, and requested further iteration.

Subsequent feedback: **do not make OpenGen too geeky**. Designers and producers are expected to use the product directly.

Preserve dark forest surfaces, off-white text, magenta actions and a small retro/pixel brand detail. The latest palette refinement follows the user’s preferred forest-and-brights reference. Simplify hard terminal grids, avoid monospace body text and long code panels, increase visual discovery and use plain labels. **Agent / CLI / API onboarding remains front and center in the main hero.** The user clarified that approachable styling must not demote that onboarding priority. Use a clear, compact setup card with copyable instructions, readable sans-serif text and limited code; provide a visible Create in browser / Playground path for designers and producers alongside it. The creative flow is model selection, a prompt/reference, and creation through a normal authenticated web session; users should not need a terminal or provider key to use the managed web product.

Design previews are concepts, not claims about live model outputs or measured quality. Model lineage, exact variants, all documented regional routes and original-provider links remain part of the product regardless of visual style. Missing prices/metrics stay unknown.

The user approved the comparison-background hero layout on 2026-11-02. The design is selected but has not yet been applied to the live frontend. The live functional catalog retains its bootstrap styling until implementation.

Latest refinement: the hero is too busy. Use one full-bleed background video instead of a boxed preview beside a creation form. Above the fold, keep slim navigation, a short headline/supporting sentence, one compact Agent / CLI / API onboarding module, and a secondary Create in browser link. Move the composer, model cards and detailed comparisons below the hero. Preserve readable sans-serif copy and the selected palette with a dark overlay that keeps footage from competing with foreground text.

The current visual is a still concept for that video-backed layout, not a supplied playable hero asset. Implementation should use muted looping inline video with a strong poster, no visible pause button (explicit user decision), reduced-motion/loading fallbacks, and playback suspension offscreen. Keep headings, onboarding URL and discovery links as crawlable HTML; the video must not carry essential text or delay useful page content.

Comparison-video clarification: each hero clip is one finished Hyperframe edit showing the same input image/prompt and two model generations, split left/right or top/bottom. The site only plays that file. It does not construct the split, render prompt/model-label overlays, synchronize two players or add an interactive comparison slider.

The comparison is intentionally a **background**, partially covered by the headline and compact Agent / CLI / API onboarding card. Keep the full-bleed cinematic layering; do not turn the clip into a separate foreground stage or move all website UI into protected bands outside it. Use a readable dark scrim and leave enough surrounding footage visible for the comparison to remain recognizable. Embedded context may be obscured; preserving every comparison pixel is not a layout requirement. Keep site headings, onboarding URL and navigation as real HTML, while the input and output comparison stays baked into the supplied video.

Approved layout reference: the final revised concept has the pre-edited comparison video full-bleed behind the short headline, supporting sentence and compact Agent / CLI / API setup card. Partial coverage is intentional. Keep the secondary Create in browser path. **Do not add a visible pause button.** The supplied production clip/poster and responsive implementation are still outstanding.

## Dedicated discovery and creation pages — 2026-11-03

Models lives at `/models`: a crawlable directory of exact image/video variants with search, modality and endpoint-region filters. Cards lead to the existing model-series pages for provider, variation and regional comparison. Publisher names link to individual company pages. Companies has no primary-navigation tab; existing company URLs and the directory URL remain available.

Playground lives at `/playground`: model selection, generation inputs, route selection, quotes and job results. It is noindex and separate from catalog browsing. A provider's Try link preserves its exact model and regional route. The homepage keeps the approved comparison-background hero, agent/CLI/API entry and a compact featured collection. Legacy home query links redirect to the corresponding dedicated destination.

## Refined forest palette — 2026-11-03

The user clarified that the espresso direction was a larger change than intended. The preferred reference remains forest, magenta, citrus, sky/aqua, apricot and lilac. The current implementation makes a smaller refinement: retain that direction, align the supporting pastel intensities, soften the fluorescent citrus and shift sky toward aqua so it relates more closely to the green canvas.

Forest remains most of the interface. Magenta consistently marks primary actions and selections; its slightly darker value makes warm-white labels readable. Citrus belongs to summaries, aqua to video headers, apricot to image headers and lilac to selected supporting agent/CLI or open-weight details. Regions and source metadata use quiet neutral green tones, avoiding an additional geographic rainbow. All pastel panels share the same dark green ink. Typography, spacing, outlines, rounded panels and the approved hero composition are unchanged.

Semantic success/warning/failure colors remain separate from brand accents, with explicit labels. Forms, onboarding, billing and share images use the shared semantic tokens. Pantone’s 2026 pastel and light/shadow explorations inform the application; the screen colors are our own choices. See PANTONE-SOURCES.md for roles, references and contrast notes.

## Approved opposing-cut identity — 2026-11-09

The owner selected **B / Opposing cuts** after iterating on the original bracket
and pixel identity. The final mark keeps the selected Even steps paired-corner
frame and a bold 12 × 12 magenta center whose top-left and bottom-right corners
have 2 × 2 cuts. The original Geist Pixel 400 wordmark remains, outlined at 25 px
with −0.6 px tracking and a 10 px mark/type gap. These are the approved study's
actual vector paths; no alternate cut pattern or frame is substituted.

Forest ink on light canvases and warm-white ink on dark canvases share the
existing magenta accent. The page palette, body fonts and layout stay unchanged.
The prior rounded G files are removed so the common header/footer, native icons,
Organization logo and 1200 × 630 social image have one identity. Stripe exports
include a 512 px forest tile with cream/magenta artwork and a transparent cream
wordmark for a forest header. The owner authorized website and Stripe rollout;
source integration and exports do not themselves establish either external
action. Asset names, editable SVGs and original/font-license notes are documented
in `apps/web/public/brand/README.md`.

## Distinguishing feature-split routes for the same variant — 2026-11-24

Providers such as fal and Pika often serve one exact model variant through multiple routes on the same deployment — one per operation (for example `text-to-video`, `image-to-video`, `reference-to-video` or `image-edit`) or per sub-operation capability — while other providers serve multiple operations from a single route.

- **Contract & catalog mechanism:** Every `Route` declares its supported `operations` plus an optional structured `feature?: { id, label, summary? }` for sub-operation splits (such as layer decomposition, audio stems or draft finishing). `validateCatalog()` requires every non-retired sibling route sharing `(modelId, deploymentId)` to have a distinct `(operations, feature.id)` signature, and rejects rates or published output-rate examples referencing unsupported operations. `publishedPricingFor()` supports route-ID and operation-scoped overrides and filters inherited deployment `outputRates` to the route's supported operations so text-only figures never bleed onto image/reference routes.
- **Quotes & discovery:** Automatic quotes (`routeId` omitted) omit irrelevant sibling-operation routes from a deployment once another eligible route on that same deployment matches `input.operation`, while preserving explicit exclusion diagnostics for pinned routes and for deployments that lack any route supporting the operation. `QuoteCandidate` carries `operations` (and optional `feature`), and `GET /v1/routes` / `routes.list` accept an optional `operation` filter across REST, local fallback, MCP and CLI.
- **Variant `ProviderTable` UI:** Multi-operation variants show a compact **Filter routes by feature** bar (`All` selected by default to preserve full SSR/SEO crawlability, plus each supported operation). In `All` view, same-deployment split routes are grouped contiguously under one provider header with a subtle rail and prominent sans-serif feature pills (`Text to video`, `Image to video`, `Reference to video`, plus optional sub-feature badges) rather than repeating identical provider headers or relying on 7 px route IDs. Multi-feature unified routes on heterogeneous variants list their supported feature pills inline so partial provider coverage stays obvious. Filtering to one feature yields a side-by-side comparison with operation-scoped pricing and feature-aware Playground handoff links.
- **Playground consistency:** Shared `routeIdentity()` and `PlaygroundResult` include the route's feature discriminator whenever a deployment splits routes, differs in coverage, or declares `route.feature`. Switching `Operation` while pinned to a feature-split route switches to the unique matching sibling route on the same deployment with an explicit status notice, or resets to `Automatic routing` with a notice when none or multiple sibling routes match.
- **Cheapest route highlight per model variant:** Inside each variant's `ProviderTable`, routes that are strictly cheapest by at least 1% within an apples-to-apples `(operation, resolution, unit)` cohort (requiring at least two positive priced routes — never comparing across different operations, resolutions, or unknown prices) receive a `Cheapest` tag with `XX% off` (or `Up to XX% off` when savings vary across resolutions) next to it in the `Published price` cell. Hovering, focusing, or tapping the tag opens a detail tooltip comparing the cheapest rate directly against the highest-priced route for each matching resolution/feature cohort, noting ties and whether estimates are published approximations.
