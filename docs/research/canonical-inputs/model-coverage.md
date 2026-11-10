# Exact model coverage

Checked 2026-11-03. All 28 requested exact variants are represented. Profiles may be shared by variants; per-model profile counts therefore do not sum to the global profile count. A weights/inference-only or unresolved API profile is not an executable hosted offering.

| Exact model/variant               | Audited provider labels                         | Profiles | Detailed report                            |
| --------------------------------- | ----------------------------------------------- | -------: | ------------------------------------------ |
| `bytedance/seedance-2.5`          | fal, BytePlus ModelArk, Runway, Replicate       |       13 | [video group](video-seedance-kling-wan.md) |
| `bytedance/seedance-2.0`          | fal, BytePlus ModelArk, Runway                  |       10 | [video group](video-seedance-kling-wan.md) |
| `bytedance/seedance-2.0-fast`     | fal, BytePlus ModelArk, Runway                  |        7 | [video group](video-seedance-kling-wan.md) |
| `bytedance/seedance-2.0-mini`     | fal, BytePlus ModelArk, Runway                  |        7 | [video group](video-seedance-kling-wan.md) |
| `kling/kling-4.0`                 | Runway, Cloudflare AI, Kling AI direct, Runware |        8 | [video group](video-seedance-kling-wan.md) |
| `alibaba/wan-3.0`                 | fal, Alibaba ModelStudio                        |        9 | [video group](video-seedance-kling-wan.md) |
| `alibaba/wan-3.0-prime`           | fal, Alibaba ModelStudio                        |        9 | [video group](video-seedance-kling-wan.md) |
| `minimax/h3`                      | MiniMax                                         |        4 | [video group](video-h3-omni-grok.md)       |
| `minimax/h3-highspeed`            | MiniMax                                         |        1 | [video group](video-h3-omni-grok.md)       |
| `minimax/h3-lite`                 | MiniMax                                         |        1 | [video group](video-h3-omni-grok.md)       |
| `minimax/h3-max`                  | MiniMax                                         |        1 | [video group](video-h3-omni-grok.md)       |
| `fal/h3-max`                      | fal                                             |        3 | [video group](video-h3-omni-grok.md)       |
| `fal/h3-max-turbo`                | fal                                             |        3 | [video group](video-h3-omni-grok.md)       |
| `pika/h3-flex`                    | Pika                                            |        6 | [video group](video-h3-omni-grok.md)       |
| `google/gemini-omni-1.1-flash`    | Google                                          |        8 | [video group](video-h3-omni-grok.md)       |
| `xai/grok-imagine-video-1.5`      | xAI                                             |        1 | [video group](video-h3-omni-grok.md)       |
| `xai/grok-imagine-video-1.5-lite` | xAI                                             |        1 | [video group](video-h3-omni-grok.md)       |
| `xai/grok-imagine-video`          | xAI                                             |        3 | [video group](video-h3-omni-grok.md)       |
| `openai/gpt-image-2.5-sunburst`   | openai, fal                                     |        6 | [image group](image-models.md)             |
| `openai/gpt-image-2.5-flare`      | openai, fal                                     |        6 | [image group](image-models.md)             |
| `openai/gpt-image-2`              | openai, fal                                     |        6 | [image group](image-models.md)             |
| `google/nano-banana-2.1`          | fal, google                                     |        3 | [image group](image-models.md)             |
| `xai/grok-imagine-image-2.0`      | xai, fal                                        |        5 | [image group](image-models.md)             |
| `bytedance/seedream-5.0-pro`      | byteplus, fal, replicate                        |        5 | [image group](image-models.md)             |
| `qwen/image-2.1`                  | self-hosted-weights                             |        1 | [image group](image-models.md)             |
| `qwen/image-2.1-turbo`            | alibaba, self-hosted-weights                    |        4 | [image group](image-models.md)             |
| `alibaba/qwen-image-2.1-pro`      | alibaba                                         |        3 | [image group](image-models.md)             |
| `alibaba/qwen-image-3.0-pro`      | alibaba                                         |        3 | [image group](image-models.md)             |
