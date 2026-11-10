# OpenGen brand assets

The owner-approved identity is **B / Opposing cuts** from the 2026-11-09 center-cut
study: the selected Even steps paired-corner frame and a 12 × 12 magenta center
with opposing 2 × 2 corner cuts. These SVGs copy the approved study's actual paths,
including the original Geist Pixel wordmark. Original artwork and refinements
follow the repository's Apache-2.0 license.

The wordmark outlines **Geist Pixel 400**, the original website display typeface,
at 25 px with −0.6 px tracking and a 10 px mark/type gap. Source:
`@fontsource/geist-pixel` 5.3.0, `geist-pixel-latin-400-normal.woff`. Geist Pixel is
copyright 2026 The Geist Project Authors; its existing SIL Open Font License 1.1
is retained at [`../licenses/geist-pixel.txt`](../licenses/geist-pixel.txt). The
social image also outlines existing Hanken Grotesk 400/500/700; its existing
notice remains at [`../licenses/hanken-grotesk.txt`](../licenses/hanken-grotesk.txt).
The SVGs contain document outlines, not embedded or modified font programs. No
additional runtime font or dependency is required.

| Asset                           | Use                                                                      |
| ------------------------------- | ------------------------------------------------------------------------ |
| `opengen-mark-on-light.svg`     | Forest/magenta symbol for light canvases                                 |
| `opengen-mark-on-dark.svg`      | Cream/magenta symbol for dark canvases                                   |
| `opengen-wordmark-on-light.svg` | Horizontal outlined logo for light canvases                              |
| `opengen-wordmark-on-dark.svg`  | Horizontal outlined logo for dark canvases; shared website header/footer |
| `opengen-mark-on-light.png`     | Transparent 512 × 512 symbol; Organization metadata                      |
| `opengen-mark-on-dark.png`      | Transparent 512 × 512 symbol for dark canvases                           |
| `opengen-wordmark-on-light.png` | Transparent 1600 × 384 horizontal logo for light canvases                |
| `opengen-wordmark-on-dark.png`  | Transparent 1600 × 384 cream/magenta logo; Stripe forest header          |
| `opengen-stripe-icon.png`       | Opaque 512 × 512 forest tile with cream/magenta symbol; Stripe icon      |
| `opengen-stripe-icon.svg`       | Editable vector source of the forest tile                                |

`on-light` and `on-dark` name the intended background, not the foreground color.
The PNGs were rendered directly from the approved SVG paths with librsvg
`rsvg-convert`. Transparent symbol PNGs use a padded square canvas and uniform
scaling; horizontal PNGs preserve the source aspect ratio. Stripe exports are
below 10 KiB. Keep the approved proportions and do not redraw the shapes in CSS.
Minimum recommended symbol size is 16 px; use the horizontal wordmark at 24 px
high or larger.

App metadata uses `app/icon.svg` (rounded forest tile), `app/favicon.ico`
(16/32/48 px) and `app/apple-icon.png` (180 px forest canvas; the OS supplies its
mask). `app/opengraph-image.png` is the 1200 × 630 standalone social image with
editable outlined source [`opengen-social.svg`](opengen-social.svg).

These files prepare the authorized website and Stripe rollout. Their presence
does not establish a deployment, upload or public source release.
