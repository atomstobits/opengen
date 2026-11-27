# Hero media

The approved home layout keeps Agent / CLI / API onboarding front and center over a full-bleed 50/50 split comparison background clip (12 interleaved clips pairing Seedance 2.5 left against 6 frontier models right — Kling 4.0, Gemini Omni 1.2 Flash, FLUX 3 Video, Wan 3.0, Seedance 2.0, and Seedance 2.5 Flash — generated from the exact same shared input images and prompts), with live model + cheapest price + discount badges on each side and an ultra-compact bottom prompt capsule (`Generate` opens the lazy side-by-side inspection modal). There is no visible pause control. Reduced-motion, data-saver/2G, and narrow-mobile preferences stay on the static poster; hidden/offscreen video pauses automatically.

## 3-tier CDN storage (recommended: Cloudflare R2 behind `media.opengen.dev`)

Keep public hero media in a dedicated public bucket separate from private customer generation storage and outside Git/Vercel deployments. Set these public build/runtime environment variables (no credentials or signed tokens):

- `OPENGEN_HERO_MEDIA_BASE_URL` — public origin/base URL (e.g. `https://media.opengen.dev`) or repo-owned root-relative path.
- `OPENGEN_HERO_MEDIA_VERSION` — immutable version segment under `/hero/<version>/...` (default `v3`).

Each comparison clip uses three renditions built by `scripts/build-hero-media.mjs` and published via `scripts/publish-hero-r2.mjs`:

1. **Tier 1 (LCP Poster + Thumbs)**: `hero-poster.avif` + `hero-poster.webp` (`1920×1080` first-frame split extracted directly from raw sources, rendered immediately in SSR HTML for fast LCP and zero CLS), plus `input-thumb.webp` (`128×128`), `input.webp` (plus `input-2.webp`..`input-N.webp` for multi-reference clips, fetched lazily inside the modal only), and modal posters.
2. **Tier 2 (Hero Background Loop)**: single pre-composited `1920×1080` 50/50 split video (`hero-split.av1.mp4` primary + `hero-split.h264.mp4` fallback), muted (`-an`), 24 fps, `+faststart`, trimmed to `<= 10s` highlight, mounted only after hydration and initial poster load so video bytes never compete with LCP.
3. **Tier 3 (Lazy Modal Clips)**: separate `<left-slug>.mp4` (`seedance-2.5.mp4`) and `<right-slug>.mp4` (`kling-4.0.mp4`, `gemini-omni-1.2-flash.mp4`, `flux-3-video.mp4`, `wan-3.0.mp4`, `seedance-2.0.mp4`, `seedance-2.5-flash.mp4`; up to `1440px` long edge, H.264 + AAC, full duration), fetched strictly when the user opens the comparison modal (0 bytes on initial homepage load).

## Fallback mode (when `OPENGEN_HERO_MEDIA_BASE_URL` is unset)

Legacy single-clip configuration (`OPENGEN_HERO_VIDEO_URL` and optional `OPENGEN_HERO_POSTER_URL`) remains supported. When neither is configured, `apps/web/public/hero-poster.png` (original illustrative promotional artwork with no provider/model labels or quality claims attached) remains visible.

Final fallback artwork prompt: Create a clean cinematic website background photograph, using the approved layout screenshot only as composition/atmosphere reference: a red-raincoat adult woman on a rainy neon street toward the far left quarter, a related view toward the far right quarter, center mostly dark emerald city bokeh. Wide 16:9 editorial diptych, realistic film texture, red/magenta neon, deep green-black shadows. No website UI, type, labels, graphics, icons, borders, logos, letters, buttons or watermark. Original illustrative promotional artwork, not a model benchmark or actual comparison result.
