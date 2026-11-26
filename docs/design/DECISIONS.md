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

## Site-wide readability, v3 high-contrast Pantone 2022–2026 palette and typography overhaul — 2026-11-24

A whole-site readability and visual-hierarchy audit found compounding typography
and color-system issues across public and authenticated pages: severe
micro-typography (`7px–11px` labels, table headers, route IDs and mobile
overrides, plus an unstated body `line-height`), cramped display headings
(`0.99–1.05` line-height and `-0.055em` to `-0.06em` tracking, plus Geist Pixel
on a multi-word homepage H2 and plain-text OAuth brand), pervasive neon-cyan
`--link` styling on non-link UI (model card titles, prices, glyphs, monograms,
outline buttons, hero chrome and plain status copy), wireframe border clutter
alongside dark recessed inline-code cages, and repetitive Viva Magenta card
stripes diluting primary CTA focus.

An intermediate muted charcoal-pine experiment (`v2`, which desaturated the
canvas to `#0e1714`, dulled inks to `#cbc6bc` / `#a8a59c`, and replaced solid
Pantone color-blocked headers, stats and badges with dark-tinted grey washes)
was **rejected by the owner as too muted and low-energy**. In response, the
finalized **v3 High-Contrast Editorial Pantone 2022–2026 Color System** keeps
the typography overhaul, strict link restraint, border cleanup and focal
discipline while restoring vibrant, high-contrast Pantone color-blocking on a
lush deeper jewel emerald forest canvas:

- **Lush deep jewel emerald forest canvas and AAA Cloud Dancer ink ladder**:
  dark surfaces move to a deeper, richer jewel emerald hierarchy
  (`--surface-code: #04130e`, `--canvas: #061c15` seamlessly matching the
  untouched `#071c16` Stripe brand icon, `--surface: #0c271e`,
  `--raised: #14372b`), with deep jewel role washes (`--surface-stat: #112b1b`,
  `--surface-video: #0a2a2a`, `--surface-image: #251e18`,
  `--surface-agent: #191c2b`) retained as optional fallbacks only. Text uses a
  high-contrast 3-tier Cloud Dancer ink ladder that passes **WCAG AAA across
  every dark emerald surface** (`--ink: #faf8f2` `16.69:1` / `Lc -102.0`,
  `--muted: #e2dfd6` _Cannoli Cream_ `13.30:1` / `Lc -86.1`,
  `--subtle: #b8c9bf` `10.25:1` / `Lc -70.2` on `--canvas`), cleanly separating
  headings, body prose and metadata/table `th` headers/inactive sidebar links.
  Structural card, table and seam borders use crisp Cloud Dancer translucent
  lines (`--line-subtle: rgba(246, 243, 236, 0.12)`,
  `--line: rgba(246, 243, 236, 0.22)`), reserving high-visibility
  `--control-line: #8eb3a0` / `--control-line-hover: #c4e0d2` strictly for
  interactive inputs, selects, textareas, outline buttons and segmented
  controls. Inline `<code>` renders as elevated translucent pills
  (`rgba(246, 243, 236, 0.10)` with `1px solid rgba(246, 243, 236, 0.20)` and
  `--ink`) instead of recessed dark boxes. Standalone server HTML templates
  (`apps/server/src/terms-login.ts` and `apps/server/src/mcp-job-preview.ts`)
  are synced to the exact v3 palette.
- **Restored bold solid Pantone 2022–2026 color-blocked panels**: restores
  OpenGen’s joyful, AlleyBloom-tactile solid Pantone blocks across public and
  authenticated surfaces, all sharing razor-sharp deep forest ink
  (`--on-light: #071e16`, `--muted-on-light: #193c30`,
  `--line-on-light: #294f41`, `--line-on-light-subtle: rgba(7, 30, 22, 0.20)`)
  so **both primary and muted ink pass WCAG AAA on all five solid panels** (with
  solid `2px solid var(--on-light)` focus rings inside light panels):
  - **Lemon Icing (`--panel-stat: #e6f598`)**: `.company-stats` summary strips,
    dark-surface `.official-tag` pills, `.series-sidebar-overview span` counts,
    OAuth `.assuranceMark` and operational/activation/secret/billing-review
    banners (`.activation`, `.secret`, `.preview`).
  - **Almost Aqua (`--panel-video: #8ee5ea`)**: solid video variant and
    playground headers (`.variant-section-heading`, `.playground-model-heading`)
    paired with inverted dark-forest `.model-glyph` tiles, dark official pills
    (`#071e16` / `#e6f598`) and solid dark `Try this variant →` CTAs (`#f6f3ec`
    label on `#071e16` fill, hover `#123428`).
  - **Peach Fuzz (`--panel-image: #ffbe98`)**: solid image variant and
    playground headers and OAuth `.billable` badges.
  - **Very Peri / Orchid Tint lilac (`--panel-agent: #cebdf7`)**: solid
    open-weight pills (`.weight-tag`), OAuth `.clientMark` and alternating agent
    setup monograms (`.client:nth-child(3n) .monogram`).
  - **Cloud Dancer (`--panel-light: #f6f3ec`)**: paper plates for the hero
    `Copy` button, default agent monograms and billing top-up paper.
- **Modality-coded catalog/featured cards and Lemon Icing tabular route
  prices**: homepage `.series-card` and `/models` `.model-series-group` cards
  use a `3px` top modality bar in `var(--model-panel)` (Almost Aqua `#8ee5ea`
  for video, Peach Fuzz `#ffbe98` for image — eliminating repetitive decorative
  Viva Magenta card stripes) with solid jewel `.model-glyph` tiles and solid
  `.modality-tag` pills. Route table prices (`.price-details strong`) use bold
  **Lemon Icing (`var(--panel-stat)` `#e6f598`, `13.50:1` on `--surface`)** with
  `tabular-nums`, uniting prices with OpenGen’s Citrus financial/summary role
  without cyan clash, while strictly cheapest apples-to-apples cohorts use
  botanical `--success` (`#7ceba3`) with crisp `12px` mono `CHEAPEST` badges.
- **Electric Viva Magenta focal discipline and strictly disciplined Luminous
  Aqua links**: electric Pantone 2023 Viva Magenta (`--accent: #d81757`,
  `--accent-hover: #b51047`, `--accent-text: #ff94bc`, `--on-accent: #ffffff`)
  matches the untouched `#d81757` **Opposing cuts** brand mark exactly and stays
  within `<= 5%` viewport focal discipline for primary CTAs, active selections,
  hero highlight, callout left rails and `::selection` (never decorative card
  stripes or competing variant-section top bars). Luminous Pantone 2026 Ice Melt
  / Almost Aqua links (`--link: #8ee5ea`, hover `--link-hover: #cff9fb`, `55%`
  underline mix, solid `--focus-ring: #f6f3ec`) beat Peach Fuzz links on
  contrast (`12.28:1` vs `11.03:1` on `--canvas`), universal hyperlink
  recognition and non-interference with amber `--warning` (`#f7d472`) or Image
  modality (`#ffbe98`). To eliminate cyan fatigue, `--link` is restricted
  **strictly** to inline prose links and explicit outbound/navigation links —
  never `/models` series/variant headings (`--ink`), prices (`--panel-stat`),
  publisher/breadcrumb chrome (`--muted`), hero `Create in browser →` (`--ink`
  with Cloud Dancer underline hovering to Lemon Icing `#e6f598`), outline
  buttons (`--control-line`), eyebrows, monograms or plain status copy. Vibrant
  botanical semantic tokens (`--success`, `--warning`, `--danger`) remain
  separate from brand accents. All screen hex values are independently
  calibrated digital approximations inspired by Pantone 2022–2026 references,
  not certified Pantone conversions, print specifications, or endorsement
  claims.
- **Typography and self-hosted font stack**: self-hosted SIL OFL-1.1 Fontsource
  packages upgrade headings to `Plus Jakarta Sans` (`--heading`), body and UI
  copy to `Inter` (`--sans`, with `'cv05' 1, 'cv08' 1` glyph disambiguation for
  `I`/`l`/`1`), and code/CLI/IDs to `JetBrains Mono` 400/500 (`--mono`). In v3,
  `Geist Pixel` (`--display`) was restricted to 1–2 character decorative
  monograms and brackets while `.home-pricing h2` moved to `--heading` (both
  refined in v4 below); OAuth consent uses the approved
  `/brand/opengen-wordmark-on-dark.svg` wordmark, and monospace is removed from
  plain UI controls, table `th` headers and plain text inputs.
- **Readable scale, measure and mobile parity**: base body text rises to
  `16px / 1.6`, long-form prose caps at `68ch`, headings relax to comfortable
  leading and tracking (`line-height: 1.15; letter-spacing: -0.02em` for page
  H1s), prices/metrics/billing tables use `tabular-nums`, and **zero** rules
  below `12px` remain on desktop or mobile (with `>= 16px` mobile inputs to
  prevent iOS Safari auto-zoom). Documentation and legal tables are wrapped in
  horizontal scroll containers (`.docs-table-wrap`) and agent support matrices
  scroll cleanly so `390px` mobile maintains zero horizontal page overflow.
- **Unchanged brand identity**: the owner-approved 2026-11-09 **Opposing cuts**
  brand SVGs, PNGs, favicons and social image under `apps/web/public/brand/`
  remain completely unchanged, and their `Hanken Grotesk` and `Geist Pixel`
  license files remain in `apps/web/public/licenses/` alongside the new font
  licenses.

## v4 80s retro-futuristic high-contrast Pantone polish — 2026-11-25

Following owner feedback requesting more unmistakable 1980s retro-futuristic
character without giving back the v3 readability overhaul, **v4** layers
restrained hardware-instrument details directly onto the locked v3 palette and
typographic scale, harmonized across the grouped `/models` directory,
feature-split route filters, cheapest-route tooltips, billing breakdowns and
playground conflict actions:

- **Preserved v3 color, contrast and readability contract**: keeps 100% of the
  v3 High-Contrast Pantone 2022–2026 `:root` token table, Python-verified WCAG
  2.1 AAA / APCA `Lc` contrast ratios, `Inter` (`16px / 1.6`, `68ch` prose cap)
  and `Plus Jakarta Sans` page/section/card headings, the strict `>= 12px`
  font-size floor (`>= 16px` mobile inputs), `tabular-nums` alignment, solid
  `:focus-visible` outlines, untouched 2026-11-09 **Opposing cuts** brand SVGs
  and zero horizontal page overflow at `1440px` and `390px`.
- **Targeted `Geist Pixel` display moments and numeric counters**: restores
  `Geist Pixel` (`--display`, weight `400`) on the homepage pricing heading
  (`.home-pricing h2` at generous `clamp(2rem, 3.8vw, 3.125rem)`, `1.2`
  leading) and giant numeric counters/step indices (`.company-stats strong`,
  `/models` `.model-directory-route-stat strong` and `.model-directory-offerings strong`,
  `.workspace-stats strong`, `/agents` `01`–`03` step numbers and numeric
  onboarding indices, with `tabular-nums`), alongside 1–2 character decorative
  monograms/brackets. Other multi-word headings remain on `Plus Jakarta Sans`,
  OAuth consent keeps the approved SVG wordmark, and all prose stays on `Inter`.
- **1980s hardware-stencil eyebrows and compact mono badges**: switches
  `.eyebrow`, `.hero-kicker` and CSS-module `.eyebrow` labels to `13px`
  `JetBrains Mono` (`500`, `0.12em` tracking, uppercase), `.home-pricing-equation`
  to `14px` `JetBrains Mono` (`500`), the hero command `$` prompt to Lemon Icing
  (`--panel-stat`) paired with a `13px` uppercase mono `Copy` button, and
  compact micro-badges (`.official-tag`, `.modality-tag`, `.weight-tag`,
  `.variant-count-tag`, `.cheapest-tag`, `.series-sidebar-overview span`, OAuth
  `.billable`) to `12px` `JetBrains Mono` (`600`, `0.05em` tracking, uppercase,
  `4px` radius). Plain form controls, table `th` headers and plain text inputs
  remain on `Inter`.
- **Whisper-quiet optical workstation textures**: adds a faint aqua CAD
  dot-matrix background (`rgba(142, 229, 234, 0.065)` on a `28px × 28px` grid)
  strictly behind the open `body` `--canvas` while cards stay solid opaque
  surfaces; layers subtle `1px`-per-`4px` broadcast-monitor scanlines
  (`rgba(6, 28, 21, 0.14)`) inside `.hero-scrim` strictly behind foreground
  HTML copy while preserving scrim contrast; and places a soft Viva Magenta /
  Almost Aqua radial horizon halo behind `.home-pricing`.
- **Crisper geometric radii, tactile hard-offset shadows and pilot-lamp glows**:
  sharpens corners to `4–12px` echoing the stepped square **Opposing cuts**
  mark (`12px` `.hero-agent-setup`, `10px` `.site-header-overlay`, `8px`
  cards/panels/command deck/tables/code blocks/series groups/variant cards,
  `5–6px` buttons/inputs/equations/notices/feature filters, `4px`
  micro-badges/monograms/glyphs). Applies restrained `3–6px` hard-offset tactile
  shadows to flagship plates, solid highlight banners, callouts and primary
  actions with subtle hover lift disabled under
  `@media (prefers-reduced-motion: reduce)`, plus subtle pilot-lamp glows on
  `.hero-kicker .tiny-dot` (Viva Magenta) and active `.status-dot` indicators
  (Lemon Icing).

See `PANTONE-SOURCES.md` for the 2022–2026 Pantone reference table, active v3
`:root` tokens, Python-verified WCAG 2.1 & APCA `Lc` contrast matrices,
typography roles and v4 hardware-instrument surface notes.
