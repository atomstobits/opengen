# Runway Kling 4.0 and Pika H3 Flex

Source check: 2026-11-02 (America/Los_Angeles). Protocols are fixture-tested, not live-verified. No provider credentials or paid calls were used for these fixtures.

## Runway

[Official Kling 4.0 guide](https://dev.runwayml.com/learn/kling-4-0-api) and [API reference](https://docs.dev.runwayml.com/api/) establish bearer authentication, `X-Runway-Version: 2024-11-06`, async submission to `/v1/text_to_video` or `/v1/image_to_video`, and polling `/v1/tasks/{id}`. The adapter implements text generation and one first-frame image. It preserves exact resolution, shape and 3–30-second integer duration. Image-to-video inherits input framing. Unsupported multi-frame and video-edit requests are rejected before dispatch.

The guide lists output-only rates of $0.157/s at 720p and $0.235/s at 1080p; input images add no charge. Video-input billing is different and is not executed by this adapter. Task `estimatedCost` is never recorded as actual spend. No authoritative charge is established from the implemented task response: managed reservations remain visibly unsettled until operator reconciliation. BYOK uses the caller’s provider account. THROTTLED remains queued work; failed or cancelled tasks do not establish refundability. Only `kling_4` is executable by this adapter; another model on Runway is not implicitly compatible.

## Pika

The [H3 Flex API](https://dev.pika.art/models/pika/pika-h3-flex/text-to-video), [reference API](https://dev.pika.art/models/pika/pika-h3-flex/reference-to-video), [pricing](https://dev.pika.art/models/pika/pika-h3-flex/text-to-video/pricing) and [quickstart](https://dev.pika.art/models/quick-start) establish `X-API-Key`, async `/v1/media/{model}` submission and `/v1/media/jobs/{id}` polling. The adapter implements text generation and ordered image-only reference generation (1–9 images). Mixed audio/video references and their input charges are not supported.

Prompt rewriting is explicitly disabled to preserve the caller’s prompt and avoid its separate fee. Audio stems are not requested. 480p/768p are native; higher supported resolutions use an upscaler and fail a native-fidelity request. Native audio remains in the output. Text rates per output second are $0.01/$0.02/$0.035/$0.04/$0.08 at 480p/768p/1080p/2K/4K. Image-only reference rates are $0.03/$0.06/$0.075/$0.08/$0.10.

The settled `billing.charge_micro_usd` is authoritative, including zero. Pending/unavailable billing leaves the charge unknown and explicitly requests a later poll at least 30 seconds later. Completed media and final settlement are separate events. Raw provider error text is not exposed. A provider job DELETE erases its media/prompt and is not implemented as a cancellation/refund shortcut.
