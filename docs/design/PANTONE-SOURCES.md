# OpenGen visual research

Checked 2026-11-03. The user requested a coherent, high-contrast palette and permitted changing every color while retaining the current design language. The latest clarification retains the preferred forest-and-brights direction, with smaller adjustments to tint balance and usage.

## Recent Pantone Colors of the Year

| Year | Official name / identifier   | Primary source                                                                   |
| ---- | ---------------------------- | -------------------------------------------------------------------------------- |
| 2026 | PANTONE 11-4201 Cloud Dancer | https://www.pantone.com/na/en-us/color-of-the-year/2026                          |
| 2025 | PANTONE 17-1230 Mocha Mousse | https://connect.pantone.com/color-insider/the-story-of-color-of-the-year-2025    |
| 2024 | PANTONE 13-1023 Peach Fuzz   | https://www.pantone.com/na/en-us/color-of-the-year/2024                          |
| 2023 | PANTONE 18-1750 Viva Magenta | https://www.pantone.com/eu/en-de/articles/color-of-the-year/what-is-viva-magenta |

The interface uses independently selected screen-color approximations inspired by these references. They are not certified Pantone-to-hex conversions, print specifications, or endorsement claims. No 2027 color is assumed.

## Active screen palette

Pantone’s [2026 palette explorations](https://www.pantone.com/uk/en-gb/articles/color-of-the-year/color-of-the-year-2026-color-palettes) provide the main reference: Powdered Pastels combines related pastel and neutral tones, while Light & Shadow explores tonal depth. Our application keeps the user’s forest-and-brights direction and uses more closely related light tints against a dark canvas. These values are independently selected screen colors, not certified Pantone conversions.

| Role                         | Screen value | Token           |
| ---------------------------- | ------------ | --------------- |
| Forest canvas                | `#071c16`    | `--canvas`      |
| Dark green panel             | `#0d261e`    | `--surface`     |
| Magenta action and selection | `#d81757`    | `--accent`      |
| Warm-white action label      | `#fff8f0`    | `--on-accent`   |
| Soft citrus summary panel    | `#e1f2a9`    | `--panel-stat`  |
| Aqua video header            | `#94dde2`    | `--panel-video` |
| Apricot image header         | `#f6b79a`    | `--panel-image` |
| Lilac agent/CLI support      | `#c7b4e7`    | `--panel-agent` |
| Shared dark green panel text | `#123127`    | `--on-light`    |
| Quiet source metadata        | `#a6bcae`    | `--subtle`      |

The four supporting tints have less extreme saturation differences. Magenta has one clear role across actions and selected controls. Regional labels share a neutral treatment, and prices/source text do not add another hue to every row. Forest dominates the canvas, while pastel fills are limited to named interface roles. Actual success/warning/failure states retain separate semantic tokens and explicit labels; the palette does not establish provider health or verification.

Contrast for dark ink `#123127` on citrus / aqua / apricot / lilac is 11.69 / 9.17 / 8.14 / 7.44 to one. Magenta `#d81757` with its explicit warm-white label is 4.77 to one; the darker hover remains above 4.5 to one. All nested light-panel labels, IDs and glyphs use the shared dark ink. These checks cover the specified pairs rather than every existing state.

The [2025 Relaxed Elegance palette](https://www.pantone.com/na/en-us/articles/color-news/pantone-color-of-the-year-2025-mocha-mousse-at-lowes) and [2024 Libations](https://www.pantone.com.br/paletas-de-cores-cor-do-ano-2024-libations/) were also reviewed. The user preferred the earlier forest-and-brights direction to the warm-neutral experiment, so those references do not determine the active palette.

## AlleyBloom reference

Source: https://alleybloom.com/ . Public HTML and linked CSS were inspected; final visual capture is handled separately.

Observed source styling: white/light-grey paper, near-black ink, hot pink and cobalt accents; oversized Bricolage Grotesque headlines, Hanken Grotesk body text, Space Mono labels; 1.5px dark outlines, 12–16px rounded cards, hard offset shadows and pill actions. The hero arranges floating workflow cards around centered product copy. Its visual language is playful and graphic, rather than a literal terminal UI.

Transfer the bold outlines, clear hierarchy, precise accents and hard-shadow tactility into original 1990s programming-inspired concepts. Do not copy AlleyBloom branding, illustrations, source code or proprietary assets.

## Proposed directions

1. **OpenGen Workbench:** warm Macintosh/HyperCard-inspired monochrome windows with Cloud Dancer-like paper and Mocha Mousse-inspired selected states. Quiet, tactile, readable.
2. **IRIX Color Lab:** an early Unix graphics-workstation composition with teal desktop, light document windows, Peach Fuzz-inspired title bars and cobalt accents. The most colorful and media-oriented direction.
3. **Terminal Atlas:** a restrained DOS/BBS-inspired dark interface with structured monospace tables, Cloud Dancer-like text, pale phosphor green and a small Viva Magenta-inspired accent. The most developer-centric direction.

All concepts must preserve legible body text, company/series ownership, explicit variant authorship, separate regional routes, original-provider links and unknown measurements. Decorative retro styling cannot invent metrics or obscure generation costs.
