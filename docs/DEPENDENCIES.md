# Dependency and asset notices

OpenGen's original source is Apache-2.0. Its dependencies, fonts, model weights and external services retain their own licenses and terms. `package-lock.json` records exact resolved dependency versions, integrity hashes and package license metadata. `npm run release:check` reports missing metadata and flags restricted licenses for review; it is not legal clearance.

## Bundled dependencies

The current lockfile includes MIT, Apache-2.0, BSD, ISC and 0BSD packages, plus these additional license families:

| Component                                  | License                                                                               | Release handling                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sharp's optional libvips platform packages | LGPL-3.0-or-later; some Sharp platform packages have combined Apache/MIT/LGPL notices | Keep the libraries unmodified and retain their included notices/license files. Review corresponding-source and replacement/relinking obligations before distributing container/binary builds. [libvips source](https://github.com/libvips/libvips), [Sharp platform packaging](https://github.com/lovell/sharp-libvips). |
| Lightning CSS platform packages            | MPL-2.0                                                                               | Preserve included notices and identify upstream source; modifications to MPL-covered files need the applicable source disclosure. [Source](https://github.com/parcel-bundler/lightningcss).                                                                                                                              |
| caniuse-lite data                          | CC-BY-4.0                                                                             | Retain package attribution and the license. [Source and notice](https://github.com/browserslist/caniuse-lite).                                                                                                                                                                                                           |
| Locally served Fontsource fonts            | OFL-1.1                                                                               | Keep each font package's license and attribution with redistributed font files; do not imply exclusive ownership of the typeface. [Fontsource](https://fontsource.org/).                                                                                                                                                 |

The source repository does not vendor node_modules. Container images include installed dependencies and their license files, plus the OpenGen LICENSE and NOTICE. Verify the exact final image and platform components, rather than assuming the source license covers those files. A new runtime dependency or media asset may require updating this review.

## Playground example media

The Playground uses OpenAI Cookbook material pinned to revision `d310dfa05d20fb653caa9c1c4b89ac1a4aeeeae4`. The bundled [MIT notice](../apps/web/public/licenses/openai-cookbook.txt) accompanies the resized previews. The sample input points to the full reference image at the same pinned revision. [Pinned example notebook](https://github.com/openai/openai-cookbook/blob/d310dfa05d20fb653caa9c1c4b89ac1a4aeeeae4/examples/multimodal/image-gen-models-prompting-guide.ipynb), [pinned input image](https://raw.githubusercontent.com/openai/openai-cookbook/d310dfa05d20fb653caa9c1c4b89ac1a4aeeeae4/images/output_images/billboard_gpt-image-2.png), [upstream license](https://github.com/openai/openai-cookbook/blob/d310dfa05d20fb653caa9c1c4b89ac1a4aeeeae4/LICENSE).

- [billboard-sunset.webp](../apps/web/public/playground-examples/billboard-sunset.webp) is a resized preview of the reference used by the image-edit and Wan first-frame examples. Its SHA-256 is `484d592f47766503c57b5a6f9a59465378876a4a5d8dca44ca92eb40594c8582`.
- [billboard-winter.webp](../apps/web/public/playground-examples/billboard-winter.webp) is a resized preview of the Cookbook's published image-edit result. Its SHA-256 is `af35f1f3641d2002de9d91b9fb884a9f3bae352e864fe95c3479124b4efaf406`.
- The MIT notice has SHA-256 `13df7812ca53ecaae1cb4a868844bb598373047ae1d580e4debfbef1dd5b6915` and matches the pinned upstream license.

The Wan example contains an original OpenGen prompt and prepares a two-second 480p image-to-video draft from that licensed reference. Its disclosure shows the input image. The image-edit example separately attributes its prompt, reference and published result to the Cookbook. Generation and private delivery are verified through the dated provider evidence, and the final owner-supplied hero clip remains a separate release asset.

## Catalog and hero media

The homepage agent marks come from [Lobe Icons static SVG 1.102.0](https://www.npmjs.com/package/@lobehub/icons-static-svg/v/1.102.0). Monochrome marks use OpenGen's off-white for the dark panel. The [MIT notice](../apps/web/public/licenses/lobe-icons.txt) ships with the SVGs. The marks identify the clients covered by the linked setup guides and remain the property of their respective owners.

Provider/model names and links identify their original publishers. OpenGen does not distribute model weights through this repository and does not grant access or commercial rights to a provider service. Exact model license/source fields remain authoritative for the catalog entry.

The finished Hyperframe comparison video has not been supplied. Do not publish example outputs as verified benchmark evidence or bundle a third party's clip without rights. The video background is a website asset, separate from provider execution and performance measurements. Original CSS fallback artwork can be distributed with the project source.

The source also includes `apps/web/public/hero-poster.png`, the illustrative ImageGen promotional artwork documented in [HERO-ASSET.md](design/HERO-ASSET.md). Its SHA-256 is `0bfb3baa2b2498e1d983c8fddb075d310b0984e1251374dda3230872337b7809`. It is not a provider output or comparison benchmark. This inventory records the existing provenance statement; human approval of final production media and redistribution rights remains an open release gate. No finished comparison video is bundled.
