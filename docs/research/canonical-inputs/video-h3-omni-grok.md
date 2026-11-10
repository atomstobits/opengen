# Video input inventory: H3, Omni and Grok

Checked 2026-11-03. Complete property inventories are provided where a formal input schema is available. Omni is explicitly model-guided partial; xAI combines model guides with official SDK wire definitions because the public REST renderer hides optional request fields. Unknowns and contradictory statements are explicit. This is documentation evidence, not live verification or current adapter support. Raw source pages remain outside Git. Structural schemas strip vendor prose/examples.

The proposed OpenGen layers are **commonGeneration**, **modelSpecific** and **brokerTransport**. They classify semantic responsibilities; a common name does not imply universal availability.

## Exact variants

| Catalog ID                        | Documented endpoint records |
| --------------------------------- | --------------------------- |
| `minimax/h3`                      | 4                           |
| `minimax/h3-highspeed`            | 1                           |
| `minimax/h3-lite`                 | 1                           |
| `minimax/h3-max`                  | 1                           |
| `fal/h3-max`                      | 3                           |
| `fal/h3-max-turbo`                | 3                           |
| `pika/h3-flex`                    | 6                           |
| `google/gemini-omni-1.1-flash`    | 8                           |
| `xai/grok-imagine-video-1.5`      | 1                           |
| `xai/grok-imagine-video-1.5-lite` | 1                           |
| `xai/grok-imagine-video`          | 3                           |

## Findings that change the canonical contract

- fal H3 Max/Turbo have three operation endpoints each, including mixed references; direct MiniMax uses a typed content array. Max reference mode additionally allows pinned first/last/middle frames; Turbo does not declare those controls.
- Direct MiniMax integer4/5–15s versus fal fractional0.92–15s,50k versus7k prompt limits, and soundtrack pinning prove that derivative/route capabilities cannot be collapsed to a family-wide maximum.
- Pika Flex exposes last-only generation, mixed ordered references, audio stems, draft finishing and prompt rewriting. Its implicit resizing/cropping/compression and high-resolution upscaling must be disclosed.
- Grok1.5 accepts combined pinned frames+reference images/voices, last-only generation and four timed keyframes. Lite lacks these controls. Legacy edit/extend preserves source configuration and uses dedicated endpoints.
- Omni roles can be prompt tags, not merely input-array positions. First-frame+references and source-video+references are documented; an example uses6images, so the existing adapter limit4 is not a provider maximum.
- Common transport does not standardize model schemas. Preserve exact role/count/type/time constraints and surface model-specific parameters alongside common names.

## minimax.h3.generate

`POST https://api.minimax.io/v2/video_generation`

Operations: text-to-video, first-frame-to-video, last-frame-to-video, first-last-frame-to-video, reference-to-video.

Sources: [minimax-create](https://platform.minimax.io/docs/api-reference/video-generation-v2-create).

| Upstream field                | Type        | Required             | Default        | Bounds / choices                                                                            | Proposed layer   |
| ----------------------------- | ----------- | -------------------- | -------------- | ------------------------------------------------------------------------------------------- | ---------------- |
| `model`                       | ["string"]  | yes                  | not documented | {"enum":["MiniMax-H3","MiniMax-H3-Highspeed","MiniMax-H3-Lite","MiniMax-H3-Max"]}           | brokerTransport  |
| `content`                     | ["array"]   | yes                  | not documented | —                                                                                           | commonGeneration |
| `content[].type`              | ["string"]  | yes                  | not documented | {"enum":["text","image_url","video_url","audio_url"]}                                       | commonGeneration |
| `content[].text`              | ["string"]  | optional/conditional | not documented | —                                                                                           | commonGeneration |
| `content[].image_url`         | ["object"]  | optional/conditional | not documented | —                                                                                           | commonGeneration |
| `content[].image_url.url`     | ["string"]  | when parent present  | not documented | —                                                                                           | commonGeneration |
| `content[].video_url`         | ["object"]  | optional/conditional | not documented | —                                                                                           | commonGeneration |
| `content[].video_url.url`     | ["string"]  | when parent present  | not documented | —                                                                                           | commonGeneration |
| `content[].audio_url`         | ["object"]  | optional/conditional | not documented | —                                                                                           | commonGeneration |
| `content[].audio_url.url`     | ["string"]  | when parent present  | not documented | —                                                                                           | commonGeneration |
| `content[].role`              | ["string"]  | optional/conditional | not documented | {"enum":["first_frame","last_frame","reference_image","reference_video","reference_audio"]} | commonGeneration |
| `resolution`                  | ["string"]  | yes                  | not documented | {"enum":["480P","768P","2K"]}                                                               | commonGeneration |
| `duration`                    | ["integer"] | yes                  | not documented | {"enum":[4,5,6,7,8,9,10,11,12,13,14,15]}                                                    | commonGeneration |
| `ratio`                       | ["string"]  | optional/conditional | not documented | {"enum":["adaptive","21:9","16:9","4:3","1:1","3:4","9:16"]}                                | commonGeneration |
| `extra`                       | ["object"]  | optional/conditional | not documented | {"additionalProperties":false}                                                              | commonGeneration |
| `extra.prompt_expansion_mode` | ["string"]  | optional/conditional | balanced       | {"enum":["disabled","balanced","quality"]}                                                  | modelSpecific    |
| `callback_url`                | ["string"]  | optional/conditional | not documented | —                                                                                           | brokerTransport  |

Variant constraints:

```json
{
  "minimax/h3": {
    "resolution": ["768P", "2K"],
    "durationSeconds": {
      "minimum": 4,
      "maximum": 15,
      "integer": true
    },
    "nativeAudio": "not an exposed create toggle; supported generated soundtrack",
    "adaptiveReferenceRatioSupported": true,
    "promptCharsPerTextItemMax": 7000
  },
  "minimax/h3-highspeed": {
    "resolution": ["480P", "768P"],
    "durationSeconds": {
      "minimum": 4,
      "maximum": 15,
      "integer": true
    },
    "nativeAudio": "not an exposed create toggle; supported generated soundtrack",
    "adaptiveReferenceRatioSupported": true,
    "promptCharsPerTextItemMax": 7000
  },
  "minimax/h3-lite": {
    "resolution": ["480P", "768P"],
    "durationSeconds": {
      "minimum": 4,
      "maximum": 15,
      "integer": true
    },
    "nativeAudio": "not an exposed create toggle; supported generated soundtrack",
    "adaptiveReferenceRatioSupported": false,
    "promptCharsPerTextItemMax": 7000
  },
  "minimax/h3-max": {
    "resolution": ["480P", "768P"],
    "durationSeconds": {
      "minimum": 5,
      "maximum": 15,
      "integer": true
    },
    "nativeAudio": "not an exposed create toggle; supported generated soundtrack",
    "adaptiveReferenceRatioSupported": true,
    "promptCharsPerTextItemMax": 7000
  }
}
```

Media constraints:

```json
{
  "requestBody": {
    "maximum": 64,
    "unit": "MB",
    "exactBytes": "not documented"
  },
  "images": {
    "formats": ["JPG", "JPEG", "PNG", "WEBP", "HEIC", "HEIF"],
    "maxFileSize": {
      "value": 30,
      "unit": "MB"
    },
    "widthAndHeightPx": [256, 5760],
    "widthHeightRatio": [0.4, 2.5],
    "maxFirstFrames": 1,
    "maxLastFrames": 1,
    "maxReferences": 9
  },
  "videos": {
    "formats": ["MP4", "MOV"],
    "videoCodecs": ["H.264/AVC", "H.265/HEVC"],
    "audioCodecs": ["AAC", "MP3"],
    "maxFileSize": {
      "value": 50,
      "unit": "MB"
    },
    "maxReferences": 3,
    "perClipSeconds": [2, 15],
    "totalSeconds": 15,
    "widthAndHeightPx": [256, 5760],
    "widthHeightRatio": [0.4, 2.5],
    "fps": [23.976, 60]
  },
  "audio": {
    "formats": ["WAV", "MP3"],
    "maxFileSize": {
      "value": 15,
      "unit": "MB"
    },
    "maxReferences": 3,
    "perClipSeconds": [2, 15],
    "totalSeconds": 15
  },
  "combinedReferenceFileCount": {
    "status": "not_documented",
    "doNotInfer": 12
  },
  "locations": ["public URL", "mm_file:// platform file ID", "base64 data URI"]
}
```

Rules:

- Every request contains non-empty text; each text item <=7000 characters.
- First/last-frame mode cannot be mixed with reference-image/video/audio roles.
- T2V requires a concrete ratio; adaptive is invalid.
- I2V inherits source ratio and ignores any other valid ratio.
- R2V defaults adaptive, except H3 Lite requires a concrete ratio.
- Only H3 Max accepts extra.prompt_expansion_mode (disabled/balanced/quality); default balanced.
- No negative-prompt, seed, FPS, safety-disable, separate voice ID, quality tier or batch count is declared in this create schema.

Unresolved / undocumented:

- No aggregate image+video+audio file-count ceiling is stated for direct MiniMax.
- H3 base model-row does not enumerate video/audio references, while shared content schema and base-model reference example include them. Preserve the scope discrepancy rather than infer exclusion.

Structural schema: [schemas/group2/minimax-h3-generate.input.json](schemas/group2/minimax-h3-generate.input.json).

## minimax.H3ContextIRReq

`POST https://api.minimax.io/v2/h3_context_ir`

Operations: prompt-context-rewrite.

Sources: [minimax-ir](https://platform.minimax.io/docs/api-reference/video-generation-v2-h3-context-ir).

| Upstream field            | Type        | Required             | Default        | Bounds / choices                                                                            | Proposed layer   |
| ------------------------- | ----------- | -------------------- | -------------- | ------------------------------------------------------------------------------------------- | ---------------- |
| `model`                   | ["string"]  | yes                  | not documented | {"enum":["MiniMax-H3"]}                                                                     | brokerTransport  |
| `content`                 | ["array"]   | yes                  | not documented | —                                                                                           | commonGeneration |
| `content[].type`          | ["string"]  | yes                  | not documented | {"enum":["text","image_url","video_url","audio_url"]}                                       | commonGeneration |
| `content[].text`          | ["string"]  | optional/conditional | not documented | —                                                                                           | commonGeneration |
| `content[].image_url`     | ["object"]  | optional/conditional | not documented | —                                                                                           | commonGeneration |
| `content[].image_url.url` | ["string"]  | when parent present  | not documented | —                                                                                           | commonGeneration |
| `content[].video_url`     | ["object"]  | optional/conditional | not documented | —                                                                                           | commonGeneration |
| `content[].video_url.url` | ["string"]  | when parent present  | not documented | —                                                                                           | commonGeneration |
| `content[].audio_url`     | ["object"]  | optional/conditional | not documented | —                                                                                           | commonGeneration |
| `content[].audio_url.url` | ["string"]  | when parent present  | not documented | —                                                                                           | commonGeneration |
| `content[].role`          | ["string"]  | optional/conditional | not documented | {"enum":["first_frame","last_frame","reference_image","reference_video","reference_audio"]} | commonGeneration |
| `duration`                | ["integer"] | yes                  | not documented | {"enum":[4,5,6,7,8,9,10,11,12,13,14,15]}                                                    | commonGeneration |
| `ratio`                   | ["string"]  | optional/conditional | not documented | {"enum":["adaptive","21:9","16:9","4:3","1:1","3:4","9:16"]}                                | commonGeneration |
| `callback_url`            | ["string"]  | optional/conditional | not documented | —                                                                                           | brokerTransport  |

Media constraints:

```json
{
  "requestBody": {
    "maximum": 64,
    "unit": "MB",
    "exactBytes": "not documented"
  },
  "images": {
    "formats": ["JPG", "JPEG", "PNG", "WEBP", "HEIC", "HEIF"],
    "maxFileSize": {
      "value": 30,
      "unit": "MB"
    },
    "widthAndHeightPx": [256, 5760],
    "widthHeightRatio": [0.4, 2.5],
    "maxFirstFrames": 1,
    "maxLastFrames": 1,
    "maxReferences": 9
  },
  "videos": {
    "formats": ["MP4", "MOV"],
    "videoCodecs": ["H.264/AVC", "H.265/HEVC"],
    "audioCodecs": ["AAC", "MP3"],
    "maxFileSize": {
      "value": 50,
      "unit": "MB"
    },
    "maxReferences": 3,
    "perClipSeconds": [2, 15],
    "totalSeconds": 15,
    "widthAndHeightPx": [256, 5760],
    "widthHeightRatio": [0.4, 2.5],
    "fps": [23.976, 60]
  },
  "audio": {
    "formats": ["WAV", "MP3"],
    "maxFileSize": {
      "value": 15,
      "unit": "MB"
    },
    "maxReferences": 3,
    "perClipSeconds": [2, 15],
    "totalSeconds": 15
  },
  "combinedReferenceFileCount": {
    "status": "not_documented",
    "doNotInfer": 12
  },
  "locations": ["public URL", "mm_file:// platform file ID", "base64 data URI"]
}
```

Rules:

- H3 base only; duration is an integer from 4 to 15 seconds; there is no output-resolution input.
- Uses the same text/frame/reference mutual exclusion and media limits as the native generation endpoint.
- Returns an asynchronous context-rewrite task. Its final prompt and reference context, not the pre-rewrite prompt, must be retained for regeneration.

Structural schema: [schemas/group2/H3ContextIRReq.input.json](schemas/group2/H3ContextIRReq.input.json).

## minimax.VideoRegenerationSourceTaskReq

`POST https://api.minimax.io/v2/video_regeneration`

Operations: video-regenerate-upscale.

Sources: [minimax-regenerate](https://platform.minimax.io/docs/api-reference/video-generation-v2-regeneration).

| Upstream field   | Type        | Required             | Default        | Bounds / choices        | Proposed layer   |
| ---------------- | ----------- | -------------------- | -------------- | ----------------------- | ---------------- |
| `model`          | ["string"]  | yes                  | not documented | {"enum":["MiniMax-H3"]} | brokerTransport  |
| `source_task_id` | ["string"]  | yes                  | not documented | —                       | commonGeneration |
| `resolution`     | ["string"]  | yes                  | not documented | {"enum":["2K"]}         | commonGeneration |
| `callback_url`   | ["string"]  | optional/conditional | not documented | —                       | brokerTransport  |
| `aigc_watermark` | ["boolean"] | optional/conditional | False          | —                       | commonGeneration |

Rules:

- Access is whitelist-gated. The source task must belong to the account, have succeeded and remain queryable within its 7-day lifetime.
- Only H3 base and target 2K are declared. The source task supplies the original generation context.
- aigc_watermark defaults to false.

Structural schema: [schemas/group2/VideoRegenerationSourceTaskReq.input.json](schemas/group2/VideoRegenerationSourceTaskReq.input.json).

## minimax.VideoRegenerationBaseVideoReq

`POST https://api.minimax.io/v2/video_regeneration`

Operations: video-regenerate-upscale.

Sources: [minimax-regenerate](https://platform.minimax.io/docs/api-reference/video-generation-v2-regeneration).

| Upstream field            | Type        | Required             | Default        | Bounds / choices                                                                                         | Proposed layer   |
| ------------------------- | ----------- | -------------------- | -------------- | -------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                   | ["string"]  | yes                  | not documented | {"enum":["MiniMax-H3"]}                                                                                  | brokerTransport  |
| `content`                 | ["array"]   | yes                  | not documented | —                                                                                                        | commonGeneration |
| `content[].type`          | ["string"]  | yes                  | not documented | {"enum":["text","image_url","video_url","audio_url"]}                                                    | commonGeneration |
| `content[].text`          | ["string"]  | optional/conditional | not documented | —                                                                                                        | commonGeneration |
| `content[].image_url`     | ["object"]  | optional/conditional | not documented | —                                                                                                        | commonGeneration |
| `content[].image_url.url` | ["string"]  | when parent present  | not documented | —                                                                                                        | commonGeneration |
| `content[].video_url`     | ["object"]  | optional/conditional | not documented | —                                                                                                        | commonGeneration |
| `content[].video_url.url` | ["string"]  | when parent present  | not documented | —                                                                                                        | commonGeneration |
| `content[].audio_url`     | ["object"]  | optional/conditional | not documented | —                                                                                                        | commonGeneration |
| `content[].audio_url.url` | ["string"]  | when parent present  | not documented | —                                                                                                        | commonGeneration |
| `content[].role`          | ["string"]  | optional/conditional | not documented | {"enum":["base_video","first_frame","last_frame","reference_image","reference_video","reference_audio"]} | commonGeneration |
| `resolution`              | ["string"]  | yes                  | not documented | {"enum":["2K"]}                                                                                          | commonGeneration |
| `callback_url`            | ["string"]  | optional/conditional | not documented | —                                                                                                        | brokerTransport  |
| `aigc_watermark`          | ["boolean"] | optional/conditional | False          | —                                                                                                        | commonGeneration |

Media constraints:

```json
{
  "requestBody": {
    "maximum": 64,
    "unit": "MB",
    "exactBytes": "not documented"
  },
  "images": {
    "formats": ["JPG", "JPEG", "PNG", "WEBP", "HEIC", "HEIF"],
    "maxFileSize": {
      "value": 30,
      "unit": "MB"
    },
    "widthAndHeightPx": [256, 5760],
    "widthHeightRatio": [0.4, 2.5],
    "maxFirstFrames": 1,
    "maxLastFrames": 1,
    "maxReferences": 9
  },
  "videos": {
    "formats": ["MP4", "MOV"],
    "videoCodecs": ["H.264/AVC", "H.265/HEVC"],
    "audioCodecs": ["AAC", "MP3"],
    "maxFileSize": {
      "value": 50,
      "unit": "MB"
    },
    "maxReferences": 3,
    "perClipSeconds": [2, 15],
    "totalSeconds": 15,
    "widthAndHeightPx": [256, 5760],
    "widthHeightRatio": [0.4, 2.5],
    "fps": [23.976, 60]
  },
  "audio": {
    "formats": ["WAV", "MP3"],
    "maxFileSize": {
      "value": 15,
      "unit": "MB"
    },
    "maxReferences": 3,
    "perClipSeconds": [2, 15],
    "totalSeconds": 15
  },
  "combinedReferenceFileCount": {
    "status": "not_documented",
    "doNotInfer": 12
  },
  "locations": ["public URL", "mm_file:// platform file ID", "base64 data URI"]
}
```

Rules:

- Submit exactly the final prompt and every reference actually sent for the native 768P generation, plus exactly one base_video item.
- Source requires audio, 24 FPS, both dimensions divisible by 32, area 589824–1032192 pixels and 107–362 total frames in increments of 17. Arbitrary uploaded videos are not valid source generations.
- Only target 2K is declared; aigc_watermark defaults to false.

Structural schema: [schemas/group2/VideoRegenerationBaseVideoReq.input.json](schemas/group2/VideoRegenerationBaseVideoReq.input.json).

## fal.h3-max.text-to-video

`POST https://queue.fal.run/minimax/h3-max/text-to-video`

Operations: text-to-video.

Sources: [https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max/text-to-video](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max/text-to-video).

| Upstream field          | Type               | Required             | Default        | Bounds / choices                                                                   | Proposed layer   |
| ----------------------- | ------------------ | -------------------- | -------------- | ---------------------------------------------------------------------------------- | ---------------- |
| `enable_safety_checker` | ["boolean"]        | optional/conditional | True           | —                                                                                  | commonGeneration |
| `prompt_expansion_mode` | ["string"]         | yes                  | balanced       | {"enumDocumentation":["disabled","balanced","quality"],"enumInFormalSchema":false} | modelSpecific    |
| `seed`                  | ["integer","null"] | optional/conditional | not documented | {"alternatives":[{"type":"integer"},{"type":"null"}]}                              | commonGeneration |
| `prompt`                | ["string"]         | yes                  | not documented | {"minLength":1,"maxLength":50000}                                                  | commonGeneration |
| `duration`              | ["number"]         | optional/conditional | 5              | {"minimum":0.92,"maximum":15}                                                      | commonGeneration |
| `resolution`            | ["string"]         | optional/conditional | 768P           | {"enum":["480P","768P","1080P"]}                                                   | commonGeneration |
| `target_audio_url`      | ["string","null"]  | optional/conditional | not documented | {"alternatives":[{"minLength":1,"pattern":"\\S","type":"string"},{"type":"null"}]} | commonGeneration |
| `aspect_ratio`          | ["string"]         | optional/conditional | 16:9           | {"enum":["21:9","16:9","4:3","1:1","3:4","9:16"]}                                  | commonGeneration |
| `sync_mode`             | ["boolean"]        | optional/conditional | False          | —                                                                                  | brokerTransport  |

Media constraints:

```json
{
  "targetAudio": {
    "minSeconds": 2,
    "maxFileSize": {
      "value": 15,
      "unit": "MB"
    },
    "locations": ["HTTP(S)", "base64 data URI"]
  }
}
```

Rules:

- This is the endpoint-specific schema; generic fal argument documentation does not establish universal model support.
- Duration is a number from 0.92 to 15 seconds (default 5). Actual output may be approximately 0.7 seconds longer.
- prompt_expansion_mode is marked required despite its balanced default. Documented modes are disabled, balanced and quality; the formal OAS uses examples rather than enum.
- 480P/768P are native tiers; 1080P is latent refinement from a 768P source. Omitted seed is random.
- target_audio_url replaces the soundtrack rather than merely providing voice guidance: audio >=2 seconds and <=15 MB; requested video duration must be >=2 seconds. Excess audio is beginning-trimmed; short audio is silence-padded without speed change. Very high sample rates may be resampled to 96 kHz.

Unresolved / undocumented:

- Per-file image/video dimensions/bytes not stated in the selected endpoint schema; do not import direct MiniMax or generic fal caps.

Structural schema: [schemas/group2/fal-h3-max-text-to-video.input.json](schemas/group2/fal-h3-max-text-to-video.input.json).

## fal.h3-max.image-to-video

`POST https://queue.fal.run/minimax/h3-max/image-to-video`

Operations: image-to-video.

Sources: [https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max/image-to-video](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max/image-to-video).

| Upstream field          | Type               | Required             | Default        | Bounds / choices                                                                   | Proposed layer   |
| ----------------------- | ------------------ | -------------------- | -------------- | ---------------------------------------------------------------------------------- | ---------------- |
| `enable_safety_checker` | ["boolean"]        | optional/conditional | True           | —                                                                                  | commonGeneration |
| `prompt_expansion_mode` | ["string"]         | yes                  | balanced       | {"enumDocumentation":["disabled","balanced","quality"],"enumInFormalSchema":false} | modelSpecific    |
| `seed`                  | ["integer","null"] | optional/conditional | not documented | {"alternatives":[{"type":"integer"},{"type":"null"}]}                              | commonGeneration |
| `prompt`                | ["string"]         | yes                  | not documented | {"minLength":1,"maxLength":50000}                                                  | commonGeneration |
| `image_url`             | ["string","null"]  | optional/conditional | not documented | {"alternatives":[{"type":"string"},{"type":"null"}]}                               | commonGeneration |
| `end_image_url`         | ["string","null"]  | optional/conditional | not documented | {"alternatives":[{"type":"string"},{"type":"null"}]}                               | commonGeneration |
| `duration`              | ["number"]         | optional/conditional | 5              | {"minimum":0.92,"maximum":15}                                                      | commonGeneration |
| `resolution`            | ["string"]         | optional/conditional | 768P           | {"enum":["480P","768P","1080P"]}                                                   | commonGeneration |
| `target_audio_url`      | ["string","null"]  | optional/conditional | not documented | {"alternatives":[{"minLength":1,"pattern":"\\S","type":"string"},{"type":"null"}]} | commonGeneration |
| `sync_mode`             | ["boolean"]        | optional/conditional | False          | —                                                                                  | brokerTransport  |

Media constraints:

```json
{
  "targetAudio": {
    "minSeconds": 2,
    "maxFileSize": {
      "value": 15,
      "unit": "MB"
    },
    "locations": ["HTTP(S)", "base64 data URI"]
  }
}
```

Rules:

- This is the endpoint-specific schema; generic fal argument documentation does not establish universal model support.
- Duration is a number from 0.92 to 15 seconds (default 5). Actual output may be approximately 0.7 seconds longer.
- prompt_expansion_mode is marked required despite its balanced default. Documented modes are disabled, balanced and quality; the formal OAS uses examples rather than enum.
- 480P/768P are native tiers; 1080P is latent refinement from a 768P source. Omitted seed is random.
- target_audio_url replaces the soundtrack rather than merely providing voice guidance: audio >=2 seconds and <=15 MB; requested video duration must be >=2 seconds. Excess audio is beginning-trimmed; short audio is silence-padded without speed change. Very high sample rates may be resampled to 96 kHz.
- First and last image URLs are independently optional. Last-only generation is explicit. With neither supplied, the handler falls back to text-to-video (default 16:9).
- Canvas follows the first image, otherwise the last image; no aspect_ratio input is declared for this endpoint.

Unresolved / undocumented:

- Per-file image/video dimensions/bytes not stated in the selected endpoint schema; do not import direct MiniMax or generic fal caps.

Structural schema: [schemas/group2/fal-h3-max-image-to-video.input.json](schemas/group2/fal-h3-max-image-to-video.input.json).

## fal.h3-max.reference-to-video

`POST https://queue.fal.run/minimax/h3-max/reference-to-video`

Operations: reference-to-video.

Sources: [https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max/reference-to-video](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max/reference-to-video).

| Upstream field                | Type               | Required             | Default        | Bounds / choices                                                                                | Proposed layer   |
| ----------------------------- | ------------------ | -------------------- | -------------- | ----------------------------------------------------------------------------------------------- | ---------------- |
| `enable_safety_checker`       | ["boolean"]        | optional/conditional | True           | —                                                                                               | commonGeneration |
| `reference_audio_urls`        | ["array"]          | optional/conditional | not documented | {"maxItems":3}                                                                                  | commonGeneration |
| `seed`                        | ["integer","null"] | optional/conditional | not documented | {"alternatives":[{"type":"integer"},{"type":"null"}]}                                           | commonGeneration |
| `prompt`                      | ["string"]         | yes                  | not documented | {"minLength":1,"maxLength":50000}                                                               | commonGeneration |
| `sync_mode`                   | ["boolean"]        | optional/conditional | False          | —                                                                                               | brokerTransport  |
| `duration`                    | ["number"]         | optional/conditional | 5              | {"minimum":0.92,"maximum":15}                                                                   | commonGeneration |
| `reference_conditions`        | ["array"]          | optional/conditional | not documented | {"maxItems":12}                                                                                 | commonGeneration |
| `reference_conditions[].url`  | ["string"]         | when parent present  | not documented | {"minLength":1}                                                                                 | commonGeneration |
| `reference_conditions[].type` | ["string"]         | when parent present  | not documented | {"enum":["image","video","audio"]}                                                              | commonGeneration |
| `prompt_expansion_mode`       | ["string"]         | yes                  | balanced       | {"enumDocumentation":["disabled","balanced","quality"],"enumInFormalSchema":false}              | modelSpecific    |
| `end_image_url`               | ["string","null"]  | optional/conditional | not documented | {"alternatives":[{"minLength":1,"type":"string"},{"type":"null"}]}                              | commonGeneration |
| `image_url`                   | ["string","null"]  | optional/conditional | not documented | {"alternatives":[{"minLength":1,"type":"string"},{"type":"null"}]}                              | commonGeneration |
| `middle_frame_time`           | ["number","null"]  | optional/conditional | not documented | {"alternatives":[{"exclusiveMaximum":15,"type":"number","exclusiveMinimum":0},{"type":"null"}]} | modelSpecific    |
| `reference_image_urls`        | ["array"]          | optional/conditional | not documented | {"maxItems":9}                                                                                  | commonGeneration |
| `resolution`                  | ["string"]         | optional/conditional | 768P           | {"enum":["480P","768P","1080P"]}                                                                | commonGeneration |
| `aspect_ratio`                | ["string"]         | optional/conditional | adaptive       | {"enum":["adaptive","21:9","16:9","4:3","1:1","3:4","9:16"]}                                    | commonGeneration |
| `reference_video_urls`        | ["array"]          | optional/conditional | not documented | {"maxItems":3}                                                                                  | commonGeneration |
| `middle_image_url`            | ["string","null"]  | optional/conditional | not documented | {"alternatives":[{"minLength":1,"type":"string"},{"type":"null"}]}                              | commonGeneration |

Media constraints:

```json
{
  "maxImageRefs": 9,
  "maxVideoRefs": 3,
  "maxAudioRefs": 3,
  "maxCombinedRefs": 12,
  "videoPerClipSeconds": [2, 15],
  "videoTotalSeconds": 15,
  "audioPerClipSeconds": [2, 15],
  "audioTotalSeconds": 15,
  "perFileBytes": {
    "status": "not_documented_in_selected_OAS"
  },
  "imageDimensions": {
    "status": "not_documented_in_selected_OAS"
  }
}
```

Rules:

- This is the endpoint-specific schema; generic fal argument documentation does not establish universal model support.
- Duration is a number from 0.92 to 15 seconds (default 5). Actual output may be approximately 0.7 seconds longer.
- prompt_expansion_mode is marked required despite its balanced default. Documented modes are disabled, balanced and quality; the formal OAS uses examples rather than enum.
- 480P/768P are native tiers; 1080P is latent refinement from a 768P source. Omitted seed is random.
- reference_conditions preserves cross-modality ordering and cannot be combined with reference_*_urls arrays.
- Separate modality lists are referenced as Image 1, Video 1 and Audio 1 in the prompt. Combined reference count is at most 12, with at most 9 images, 3 videos and 3 audio files; each video/audio type totals at most 15 seconds.
- Unlike the native MiniMax frame/reference exclusion, fal Max reference mode declares first/end frames alongside reference assets.
- middle_image_url requires first/end frames and native 480P or 768P; middle_frame_time must be supplied, lies strictly inside duration, and is rounded to the nearest 24 FPS frame.

Unresolved / undocumented:

- Per-file image/video dimensions/bytes not stated in the selected endpoint schema; do not import direct MiniMax or generic fal caps.

Structural schema: [schemas/group2/fal-h3-max-reference-to-video.input.json](schemas/group2/fal-h3-max-reference-to-video.input.json).

## fal.h3-max-turbo.text-to-video

`POST https://queue.fal.run/minimax/h3-max-turbo/text-to-video`

Operations: text-to-video.

Sources: [https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/text-to-video](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/text-to-video).

| Upstream field          | Type               | Required             | Default        | Bounds / choices                                                                   | Proposed layer   |
| ----------------------- | ------------------ | -------------------- | -------------- | ---------------------------------------------------------------------------------- | ---------------- |
| `enable_safety_checker` | ["boolean"]        | optional/conditional | True           | —                                                                                  | commonGeneration |
| `prompt_expansion_mode` | ["string"]         | yes                  | balanced       | {"enumDocumentation":["disabled","balanced","quality"],"enumInFormalSchema":false} | modelSpecific    |
| `seed`                  | ["integer","null"] | optional/conditional | not documented | {"alternatives":[{"type":"integer"},{"type":"null"}]}                              | commonGeneration |
| `prompt`                | ["string"]         | yes                  | not documented | {"minLength":1,"maxLength":50000}                                                  | commonGeneration |
| `duration`              | ["number"]         | optional/conditional | 5              | {"minimum":0.92,"maximum":15}                                                      | commonGeneration |
| `resolution`            | ["string"]         | optional/conditional | 768P           | {"enum":["480P","768P","1080P"]}                                                   | commonGeneration |
| `target_audio_url`      | ["string","null"]  | optional/conditional | not documented | {"alternatives":[{"minLength":1,"pattern":"\\S","type":"string"},{"type":"null"}]} | commonGeneration |
| `aspect_ratio`          | ["string"]         | optional/conditional | 16:9           | {"enum":["21:9","16:9","4:3","1:1","3:4","9:16"]}                                  | commonGeneration |
| `sync_mode`             | ["boolean"]        | optional/conditional | False          | —                                                                                  | brokerTransport  |

Media constraints:

```json
{
  "targetAudio": {
    "minSeconds": 2,
    "maxFileSize": {
      "value": 15,
      "unit": "MB"
    },
    "locations": ["HTTP(S)", "base64 data URI"]
  }
}
```

Rules:

- This is the endpoint-specific schema; generic fal argument documentation does not establish universal model support.
- Duration is a number from 0.92 to 15 seconds (default 5). Actual output may be approximately 0.7 seconds longer.
- prompt_expansion_mode is marked required despite its balanced default. Documented modes are disabled, balanced and quality; the formal OAS uses examples rather than enum.
- 480P/768P are native tiers; 1080P is latent refinement from a 768P source. Omitted seed is random.
- target_audio_url replaces the soundtrack rather than merely providing voice guidance: audio >=2 seconds and <=15 MB; requested video duration must be >=2 seconds. Excess audio is beginning-trimmed; short audio is silence-padded without speed change. Very high sample rates may be resampled to 96 kHz.

Unresolved / undocumented:

- Per-file image/video dimensions/bytes not stated in the selected endpoint schema; do not import direct MiniMax or generic fal caps.

Structural schema: [schemas/group2/fal-h3-max-turbo-text-to-video.input.json](schemas/group2/fal-h3-max-turbo-text-to-video.input.json).

## fal.h3-max-turbo.image-to-video

`POST https://queue.fal.run/minimax/h3-max-turbo/image-to-video`

Operations: image-to-video.

Sources: [https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/image-to-video](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/image-to-video).

| Upstream field          | Type               | Required             | Default        | Bounds / choices                                                                   | Proposed layer   |
| ----------------------- | ------------------ | -------------------- | -------------- | ---------------------------------------------------------------------------------- | ---------------- |
| `enable_safety_checker` | ["boolean"]        | optional/conditional | True           | —                                                                                  | commonGeneration |
| `prompt_expansion_mode` | ["string"]         | yes                  | balanced       | {"enumDocumentation":["disabled","balanced","quality"],"enumInFormalSchema":false} | modelSpecific    |
| `seed`                  | ["integer","null"] | optional/conditional | not documented | {"alternatives":[{"type":"integer"},{"type":"null"}]}                              | commonGeneration |
| `prompt`                | ["string"]         | yes                  | not documented | {"minLength":1,"maxLength":50000}                                                  | commonGeneration |
| `image_url`             | ["string","null"]  | optional/conditional | not documented | {"alternatives":[{"type":"string"},{"type":"null"}]}                               | commonGeneration |
| `end_image_url`         | ["string","null"]  | optional/conditional | not documented | {"alternatives":[{"type":"string"},{"type":"null"}]}                               | commonGeneration |
| `duration`              | ["number"]         | optional/conditional | 5              | {"minimum":0.92,"maximum":15}                                                      | commonGeneration |
| `resolution`            | ["string"]         | optional/conditional | 768P           | {"enum":["480P","768P","1080P"]}                                                   | commonGeneration |
| `target_audio_url`      | ["string","null"]  | optional/conditional | not documented | {"alternatives":[{"minLength":1,"pattern":"\\S","type":"string"},{"type":"null"}]} | commonGeneration |
| `sync_mode`             | ["boolean"]        | optional/conditional | False          | —                                                                                  | brokerTransport  |

Media constraints:

```json
{
  "targetAudio": {
    "minSeconds": 2,
    "maxFileSize": {
      "value": 15,
      "unit": "MB"
    },
    "locations": ["HTTP(S)", "base64 data URI"]
  }
}
```

Rules:

- This is the endpoint-specific schema; generic fal argument documentation does not establish universal model support.
- Duration is a number from 0.92 to 15 seconds (default 5). Actual output may be approximately 0.7 seconds longer.
- prompt_expansion_mode is marked required despite its balanced default. Documented modes are disabled, balanced and quality; the formal OAS uses examples rather than enum.
- 480P/768P are native tiers; 1080P is latent refinement from a 768P source. Omitted seed is random.
- target_audio_url replaces the soundtrack rather than merely providing voice guidance: audio >=2 seconds and <=15 MB; requested video duration must be >=2 seconds. Excess audio is beginning-trimmed; short audio is silence-padded without speed change. Very high sample rates may be resampled to 96 kHz.
- First and last image URLs are independently optional. Last-only generation is explicit. With neither supplied, the handler falls back to text-to-video (default 16:9).
- Canvas follows the first image, otherwise the last image; no aspect_ratio input is declared for this endpoint.

Unresolved / undocumented:

- Per-file image/video dimensions/bytes not stated in the selected endpoint schema; do not import direct MiniMax or generic fal caps.

Structural schema: [schemas/group2/fal-h3-max-turbo-image-to-video.input.json](schemas/group2/fal-h3-max-turbo-image-to-video.input.json).

## fal.h3-max-turbo.reference-to-video

`POST https://queue.fal.run/minimax/h3-max-turbo/reference-to-video`

Operations: reference-to-video.

Sources: [https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/reference-to-video](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max-turbo/reference-to-video).

| Upstream field                | Type               | Required             | Default        | Bounds / choices                                                                   | Proposed layer   |
| ----------------------------- | ------------------ | -------------------- | -------------- | ---------------------------------------------------------------------------------- | ---------------- |
| `enable_safety_checker`       | ["boolean"]        | optional/conditional | True           | —                                                                                  | commonGeneration |
| `reference_audio_urls`        | ["array"]          | optional/conditional | not documented | {"maxItems":3}                                                                     | commonGeneration |
| `seed`                        | ["integer","null"] | optional/conditional | not documented | {"alternatives":[{"type":"integer"},{"type":"null"}]}                              | commonGeneration |
| `prompt`                      | ["string"]         | yes                  | not documented | {"minLength":1,"maxLength":50000}                                                  | commonGeneration |
| `prompt_expansion_mode`       | ["string"]         | yes                  | balanced       | {"enumDocumentation":["disabled","balanced","quality"],"enumInFormalSchema":false} | modelSpecific    |
| `duration`                    | ["number"]         | optional/conditional | 5              | {"minimum":0.92,"maximum":15}                                                      | commonGeneration |
| `reference_image_urls`        | ["array"]          | optional/conditional | not documented | {"maxItems":9}                                                                     | commonGeneration |
| `resolution`                  | ["string"]         | optional/conditional | 768P           | {"enum":["480P","768P","1080P"]}                                                   | commonGeneration |
| `reference_conditions`        | ["array"]          | optional/conditional | not documented | {"maxItems":12}                                                                    | commonGeneration |
| `reference_conditions[].url`  | ["string"]         | when parent present  | not documented | {"minLength":1}                                                                    | commonGeneration |
| `reference_conditions[].type` | ["string"]         | when parent present  | not documented | {"enum":["image","video","audio"]}                                                 | commonGeneration |
| `reference_video_urls`        | ["array"]          | optional/conditional | not documented | {"maxItems":3}                                                                     | commonGeneration |
| `aspect_ratio`                | ["string"]         | optional/conditional | adaptive       | {"enum":["adaptive","21:9","16:9","4:3","1:1","3:4","9:16"]}                       | commonGeneration |
| `sync_mode`                   | ["boolean"]        | optional/conditional | False          | —                                                                                  | brokerTransport  |

Media constraints:

```json
{
  "maxImageRefs": 9,
  "maxVideoRefs": 3,
  "maxAudioRefs": 3,
  "maxCombinedRefs": 12,
  "videoPerClipSeconds": [2, 15],
  "videoTotalSeconds": 15,
  "audioPerClipSeconds": [2, 15],
  "audioTotalSeconds": 15,
  "perFileBytes": {
    "status": "not_documented_in_selected_OAS"
  },
  "imageDimensions": {
    "status": "not_documented_in_selected_OAS"
  }
}
```

Rules:

- This is the endpoint-specific schema; generic fal argument documentation does not establish universal model support.
- Duration is a number from 0.92 to 15 seconds (default 5). Actual output may be approximately 0.7 seconds longer.
- prompt_expansion_mode is marked required despite its balanced default. Documented modes are disabled, balanced and quality; the formal OAS uses examples rather than enum.
- 480P/768P are native tiers; 1080P is latent refinement from a 768P source. Omitted seed is random.
- reference_conditions preserves cross-modality ordering and cannot be combined with reference_*_urls arrays.
- Separate modality lists are referenced as Image 1, Video 1 and Audio 1 in the prompt. Combined reference count is at most 12, with at most 9 images, 3 videos and 3 audio files; each video/audio type totals at most 15 seconds.
- The Turbo reference schema does not declare first/end/middle-frame controls; do not inherit them from Max.

Unresolved / undocumented:

- Per-file image/video dimensions/bytes not stated in the selected endpoint schema; do not import direct MiniMax or generic fal caps.

Structural schema: [schemas/group2/fal-h3-max-turbo-reference-to-video.input.json](schemas/group2/fal-h3-max-turbo-reference-to-video.input.json).

## pika.text-to-video

`POST https://api.dev.pika.art/v1/media/pika/pika-h3-flex/text-to-video`

Operations: text-to-video.

Sources: [pika-oas](https://dev.pika.art/openapi.json), [pika-t2v](https://dev.pika.art/models/pika/pika-h3-flex/text-to-video).

| Upstream field | Type              | Required             | Default        | Bounds / choices                                                                                                                           | Proposed layer   |
| -------------- | ----------------- | -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `prompt`       | ["string"]        | yes                  | not documented | {"minLength":1,"maxLength":8000}                                                                                                           | commonGeneration |
| `duration`     | ["integer"]       | optional/conditional | 5              | {"minimum":5.0,"maximum":15.0}                                                                                                             | commonGeneration |
| `aspect_ratio` | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","enum":["auto","21:9","16:9","3:2","4:3","5:4","1:1","4:5","3:4","2:3","9:16","9:21"]},{"type":"null"}]} | commonGeneration |
| `resolution`   | ["string"]        | optional/conditional | 768p           | {"enum":["480p","768p","1080p","2k","4k"]}                                                                                                 | commonGeneration |
| `seed`         | ["integer"]       | optional/conditional | 0              | {"minimum":0.0,"maximum":9.223372036854776e+18}                                                                                            | commonGeneration |
| `rewrite`      | ["boolean"]       | optional/conditional | True           | —                                                                                                                                          | modelSpecific    |
| `output_mode`  | ["string"]        | optional/conditional | video          | {"enum":["video","audio-stems"]}                                                                                                           | modelSpecific    |
| `channel_mode` | ["string"]        | optional/conditional | mono           | {"enum":["stereo","mono"]}                                                                                                                 | modelSpecific    |
| `webhook_url`  | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string"},{"type":"null"}]}                                                                                       | brokerTransport  |

Rules:

- Undeclared request properties are rejected. webhook_url is an HTTPS terminal callback and participates in idempotency identity.
- Prompt length is 1–8000 characters. Duration is an integer 5–15 seconds (default 5). Seed defaults to 0; the OAS ceiling is represented as a rounded 9.223372036854776e18 floating value, so the exact integer boundary needs clarification before exposing it as a JavaScript-safe number.
- 480p/768p are native. 1080p/2k/4k first generate 768p and then upscale once, preserving audio/frame rate.
- rewrite defaults true. With ratio omitted, rewriting enables Auto; without rewriting, the first supplied keyframe determines the ratio, otherwise 16:9. Explicit fixed ratio wins and can resize/center-crop keyframes.
- output_mode defaults video; audio-stems additionally returns Dialogue/Music/Effect WAVs with separate charges. channel_mode mono(default)/stereo affects stem separation, not the original video soundtrack. No generation-audio-off field is declared.

Structural schema: [schemas/group2/PikaH3FlexRequest.input.json](schemas/group2/PikaH3FlexRequest.input.json).

## pika.image-to-video

`POST https://api.dev.pika.art/v1/media/pika/pika-h3-flex/image-to-video`

Operations: image-to-video.

Sources: [pika-oas](https://dev.pika.art/openapi.json), [pika-t2v](https://dev.pika.art/models/pika/pika-h3-flex/text-to-video).

| Upstream field     | Type              | Required             | Default        | Bounds / choices                                                                                                                           | Proposed layer   |
| ------------------ | ----------------- | -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `prompt`           | ["string"]        | yes                  | not documented | {"minLength":1,"maxLength":8000}                                                                                                           | commonGeneration |
| `duration`         | ["integer"]       | optional/conditional | 5              | {"minimum":5.0,"maximum":15.0}                                                                                                             | commonGeneration |
| `aspect_ratio`     | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","enum":["auto","21:9","16:9","3:2","4:3","5:4","1:1","4:5","3:4","2:3","9:16","9:21"]},{"type":"null"}]} | commonGeneration |
| `resolution`       | ["string"]        | optional/conditional | 768p           | {"enum":["480p","768p","1080p","2k","4k"]}                                                                                                 | commonGeneration |
| `seed`             | ["integer"]       | optional/conditional | 0              | {"minimum":0.0,"maximum":9.223372036854776e+18}                                                                                            | commonGeneration |
| `rewrite`          | ["boolean"]       | optional/conditional | True           | —                                                                                                                                          | modelSpecific    |
| `output_mode`      | ["string"]        | optional/conditional | video          | {"enum":["video","audio-stems"]}                                                                                                           | modelSpecific    |
| `channel_mode`     | ["string"]        | optional/conditional | mono           | {"enum":["stereo","mono"]}                                                                                                                 | modelSpecific    |
| `image`            | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","maxLength":8192,"pattern":"^https?://","media_kinds":["image"]},{"type":"null"}]}                       | commonGeneration |
| `last_frame_image` | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","maxLength":8192,"pattern":"^https?://","media_kinds":["image"]},{"type":"null"}]}                       | commonGeneration |
| `webhook_url`      | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string"},{"type":"null"}]}                                                                                       | brokerTransport  |

Media constraints:

```json
{
  "frames": {
    "formats": ["JPEG", "PNG", "WebP"],
    "maxFileMiB": 24,
    "maxPixels": 40000000,
    "urlMaxChars": 8192,
    "locations": ["HTTP(S)"]
  }
}
```

Rules:

- Undeclared request properties are rejected. webhook_url is an HTTPS terminal callback and participates in idempotency identity.
- Prompt length is 1–8000 characters. Duration is an integer 5–15 seconds (default 5). Seed defaults to 0; the OAS ceiling is represented as a rounded 9.223372036854776e18 floating value, so the exact integer boundary needs clarification before exposing it as a JavaScript-safe number.
- 480p/768p are native. 1080p/2k/4k first generate 768p and then upscale once, preserving audio/frame rate.
- rewrite defaults true. With ratio omitted, rewriting enables Auto; without rewriting, the first supplied keyframe determines the ratio, otherwise 16:9. Explicit fixed ratio wins and can resize/center-crop keyframes.
- output_mode defaults video; audio-stems additionally returns Dialogue/Music/Effect WAVs with separate charges. channel_mode mono(default)/stereo affects stem separation, not the original video soundtrack. No generation-audio-off field is declared.
- Supply image, last_frame_image or both. Last-only is explicitly allowed. Both frames use the declared URL format/size rules.

Structural schema: [schemas/group2/PikaH3FlexImageRequest.input.json](schemas/group2/PikaH3FlexImageRequest.input.json).

## pika.reference-to-video

`POST https://api.dev.pika.art/v1/media/pika/pika-h3-flex/reference-to-video`

Operations: reference-to-video.

Sources: [pika-oas](https://dev.pika.art/openapi.json), [pika-ref](https://dev.pika.art/models/pika/pika-h3-flex/reference-to-video).

| Upstream field      | Type              | Required             | Default        | Bounds / choices                                                                                                                           | Proposed layer   |
| ------------------- | ----------------- | -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `prompt`            | ["string"]        | yes                  | not documented | {"minLength":1,"maxLength":8000}                                                                                                           | commonGeneration |
| `duration`          | ["integer"]       | optional/conditional | 5              | {"minimum":5.0,"maximum":15.0}                                                                                                             | commonGeneration |
| `aspect_ratio`      | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","enum":["auto","21:9","16:9","3:2","4:3","5:4","1:1","4:5","3:4","2:3","9:16","9:21"]},{"type":"null"}]} | commonGeneration |
| `resolution`        | ["string"]        | optional/conditional | 768p           | {"enum":["480p","768p","1080p","2k","4k"]}                                                                                                 | commonGeneration |
| `seed`              | ["integer"]       | optional/conditional | 0              | {"minimum":0.0,"maximum":9.223372036854776e+18}                                                                                            | commonGeneration |
| `rewrite`           | ["boolean"]       | optional/conditional | True           | —                                                                                                                                          | modelSpecific    |
| `output_mode`       | ["string"]        | optional/conditional | video          | {"enum":["video","audio-stems"]}                                                                                                           | modelSpecific    |
| `channel_mode`      | ["string"]        | optional/conditional | mono           | {"enum":["stereo","mono"]}                                                                                                                 | modelSpecific    |
| `references`        | ["array"]         | yes                  | not documented | {"minItems":1,"maxItems":12}                                                                                                               | commonGeneration |
| `references[].type` | ["string"]        | when parent present  | not documented | {"const":"image"}                                                                                                                          | commonGeneration |
| `references[].url`  | ["string"]        | when parent present  | not documented | {"maxLength":8192,"pattern":"^https?://"}                                                                                                  | commonGeneration |
| `references[].type` | ["string"]        | when parent present  | not documented | {"const":"video"}                                                                                                                          | commonGeneration |
| `references[].url`  | ["string"]        | when parent present  | not documented | {"maxLength":8192,"pattern":"^https?://"}                                                                                                  | commonGeneration |
| `references[].type` | ["string"]        | when parent present  | not documented | {"const":"audio"}                                                                                                                          | commonGeneration |
| `references[].url`  | ["string"]        | when parent present  | not documented | {"maxLength":8192,"pattern":"^https?://"}                                                                                                  | commonGeneration |
| `webhook_url`       | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string"},{"type":"null"}]}                                                                                       | brokerTransport  |

Media constraints:

```json
{
  "maxTotal": 12,
  "minTotal": 1,
  "maxImages": 9,
  "maxVideos": 3,
  "maxAudio": 3,
  "requireImageOrVideo": true,
  "imageFormats": ["PNG", "JPEG", "WebP"],
  "imageSourceMaxPixels": 40000000,
  "imagePreparedMaxPixels": 16000000,
  "imageSourceAspect": [0.25, 4],
  "imagePreparedShortSideMaxPx": 2048,
  "videoSourceMaxPixelsPerFrame": 16000000,
  "videoSourceMaxTotalPixels": 4000000000,
  "videoSourceMaxFrames": 2000,
  "videoAudioClipSeconds": [2, 15],
  "videoSecondsTotal": 15,
  "audioSecondsTotal": 15,
  "originalFileMiBGuide": 50,
  "preparedFileMiBSchema": 24,
  "preparedAggregateBase64MiB": 64,
  "preparedRawMiBApprox": 48
}
```

Rules:

- Undeclared request properties are rejected. webhook_url is an HTTPS terminal callback and participates in idempotency identity.
- Prompt length is 1–8000 characters. Duration is an integer 5–15 seconds (default 5). Seed defaults to 0; the OAS ceiling is represented as a rounded 9.223372036854776e18 floating value, so the exact integer boundary needs clarification before exposing it as a JavaScript-safe number.
- 480p/768p are native. 1080p/2k/4k first generate 768p and then upscale once, preserving audio/frame rate.
- rewrite defaults true. With ratio omitted, rewriting enables Auto; without rewriting, the first supplied keyframe determines the ratio, otherwise 16:9. Explicit fixed ratio wins and can resize/center-crop keyframes.
- output_mode defaults video; audio-stems additionally returns Dialogue/Music/Effect WAVs with separate charges. channel_mode mono(default)/stereo affects stem separation, not the original video soundtrack. No generation-audio-off field is declared.
- References are ordered and typed. At least one image or video is required; audio-only input is invalid.
- The guide permits original files up to 50 MiB followed by CPU preparation, while OAS describes 24 MiB per file. Treat original and prepared budgets separately and preserve this discrepancy.

Structural schema: [schemas/group2/PikaH3FlexReferenceRequest.input.json](schemas/group2/PikaH3FlexReferenceRequest.input.json).

## pika.draft-to-video

`POST https://api.dev.pika.art/v1/media/pika/pika-h3-flex/draft-to-video`

Operations: video-upscale.

Sources: [pika-oas](https://dev.pika.art/openapi.json), [pika-t2v](https://dev.pika.art/models/pika/pika-h3-flex/text-to-video).

| Upstream field | Type              | Required             | Default        | Bounds / choices                                                                                                     | Proposed layer   |
| -------------- | ----------------- | -------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `draft_job_id` | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","maxLength":128,"minLength":1},{"type":"null"}]}                                   | commonGeneration |
| `video`        | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","maxLength":2083,"pattern":"^https?://","media_kinds":["video"]},{"type":"null"}]} | commonGeneration |
| `resolution`   | ["string"]        | optional/conditional | 2k             | {"enum":["1080p","2k","4k"]}                                                                                         | commonGeneration |
| `webhook_url`  | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string"},{"type":"null"}]}                                                                 | brokerTransport  |

Rules:

- Undeclared request properties are rejected. webhook_url is an HTTPS terminal callback and participates in idempotency identity.
- Supply exactly one draft_job_id or external video URL. An owned draft must be completed native Flex 480p/768p. External video requires short edge <=768 pixels, <=512 MiB compressed and <=1441 frames.
- Only upscaling runs to 1080p/2k/4k (default 2k); frames, frame rate and audio are preserved. No prompt/duration/seed input is declared.

Structural schema: [schemas/group2/PikaH3FlexDraftRequest.input.json](schemas/group2/PikaH3FlexDraftRequest.input.json).

## pika.audio-stems

`POST https://api.dev.pika.art/v1/media/pika/pika-h3-flex/audio-stems`

Operations: audio-separate.

Sources: [pika-oas](https://dev.pika.art/openapi.json), [pika-t2v](https://dev.pika.art/models/pika/pika-h3-flex/text-to-video).

| Upstream field | Type              | Required             | Default        | Bounds / choices                                                                                                             | Proposed layer   |
| -------------- | ----------------- | -------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `input_url`    | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","maxLength":4096,"pattern":"^https?://","media_kinds":["audio","video"]},{"type":"null"}]} | commonGeneration |
| `request_id`   | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","maxLength":128,"minLength":1},{"type":"null"}]}                                           | commonGeneration |
| `channel_mode` | ["string"]        | optional/conditional | mono           | {"enum":["stereo","mono"]}                                                                                                   | modelSpecific    |
| `webhook_url`  | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string"},{"type":"null"}]}                                                                         | brokerTransport  |

Rules:

- Undeclared request properties are rejected. webhook_url is an HTTPS terminal callback and participates in idempotency identity.
- Supply exactly one input_url or request_id. Input is audio/video with sound <=120 seconds, or an owned completed Flex output.
- Mono(default)/stereo preserves the documented channel behavior; both are billed by summed output-stem duration.

Structural schema: [schemas/group2/PikaH3AudioStemsRequest.input.json](schemas/group2/PikaH3AudioStemsRequest.input.json).

## pika.prompt-rewriter

`POST https://api.dev.pika.art/v1/media/pika/pika-h3-flex/prompt-rewriter`

Operations: prompt-rewrite.

Sources: [pika-oas](https://dev.pika.art/openapi.json), [pika-t2v](https://dev.pika.art/models/pika/pika-h3-flex/text-to-video).

| Upstream field      | Type              | Required             | Default        | Bounds / choices                                                                                                                           | Proposed layer   |
| ------------------- | ----------------- | -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `mode`              | ["string"]        | optional/conditional | fl2va          | {"enum":["fl2va","ref2va"]}                                                                                                                | commonGeneration |
| `prompt`            | ["string"]        | yes                  | not documented | {"minLength":1,"maxLength":8000}                                                                                                           | commonGeneration |
| `duration`          | ["integer"]       | optional/conditional | 5              | {"minimum":5.0,"maximum":15.0}                                                                                                             | commonGeneration |
| `aspect_ratio`      | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","enum":["auto","21:9","16:9","3:2","4:3","5:4","1:1","4:5","3:4","2:3","9:16","9:21"]},{"type":"null"}]} | commonGeneration |
| `image`             | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","maxLength":8192,"pattern":"^https?://","media_kinds":["image"]},{"type":"null"}]}                       | commonGeneration |
| `last_frame_image`  | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","maxLength":8192,"pattern":"^https?://","media_kinds":["image"]},{"type":"null"}]}                       | commonGeneration |
| `references`        | ["array"]         | optional/conditional | not documented | {"maxItems":12}                                                                                                                            | commonGeneration |
| `references[].type` | ["string"]        | when parent present  | not documented | {"const":"image"}                                                                                                                          | commonGeneration |
| `references[].url`  | ["string"]        | when parent present  | not documented | {"maxLength":8192,"pattern":"^https?://"}                                                                                                  | commonGeneration |
| `references[].role` | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","pattern":"^[a-z][a-z0-9_]{0,47}$"},{"type":"null"}]}                                                    | commonGeneration |
| `references[].type` | ["string"]        | when parent present  | not documented | {"const":"video"}                                                                                                                          | commonGeneration |
| `references[].url`  | ["string"]        | when parent present  | not documented | {"maxLength":8192,"pattern":"^https?://"}                                                                                                  | commonGeneration |
| `references[].role` | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","pattern":"^[a-z][a-z0-9_]{0,47}$"},{"type":"null"}]}                                                    | commonGeneration |
| `references[].type` | ["string"]        | when parent present  | not documented | {"const":"audio"}                                                                                                                          | commonGeneration |
| `references[].url`  | ["string"]        | when parent present  | not documented | {"maxLength":8192,"pattern":"^https?://"}                                                                                                  | commonGeneration |
| `references[].role` | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string","pattern":"^[a-z][a-z0-9_]{0,47}$"},{"type":"null"}]}                                                    | commonGeneration |
| `webhook_url`       | ["string","null"] | optional/conditional | not documented | {"alternatives":[{"type":"string"},{"type":"null"}]}                                                                                       | brokerTransport  |

Rules:

- Undeclared request properties are rejected. webhook_url is an HTTPS terminal callback and participates in idempotency identity.
- fl2va(default) uses text and optional first/last keyframes; ref2va uses ordered typed references.
- An optional reference role is a lowercase identifier matching ^[a-z][a-z0-9_]{0,47}$, e.g. identity or voice_timbre. The rewriter does not transcribe or listen to reference audio. Generation reference size/duration/decoded-pixel budgets still apply.

Structural schema: [schemas/group2/PikaH3PromptRewriterRequest.input.json](schemas/group2/PikaH3PromptRewriterRequest.input.json).

## google.omni.text-to-video

`POST https://generativelanguage.googleapis.com/v1beta/interactions`

Operations: text-to-video.

Sources: [omni-model](https://aistudio.google.com/docs/models/gemini-omni-flash), [omni-guide](https://aistudio.google.com/docs/omni), [omni-api](https://aistudio.google.com/api-reference/interactions-api), [omni-duration](https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-omni-flash-api/scripts/video/generate_video.py).

| Upstream field                        | Type                               | Required             | Default        | Bounds / choices                                                                                                                                                                                                                                      | Proposed layer   |
| ------------------------------------- | ---------------------------------- | -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                               | string                             | yes                  | not documented | {"enum":["gemini-omni-1.1-flash"]}                                                                                                                                                                                                                    | brokerTransport  |
| `input`                               | string\|Content\|Content[]\|Step[] | yes                  | not documented | {"evidenceScope":"Generic Interactions create union; Omni guide demonstrates string and text/image/video content arrays. Step[] model applicability remains unverified."}                                                                             | commonGeneration |
| `input[].type`                        | string                             | yes                  | not documented | {"enum":["text","image","video"]}                                                                                                                                                                                                                     | commonGeneration |
| `input[].text`                        | string                             | optional/conditional | not documented | {"conditionalRequired":"type=text"}                                                                                                                                                                                                                   | commonGeneration |
| `input[].data`                        | base64 string                      | optional/conditional | not documented | {"conditionalRequired":"inline image/video"}                                                                                                                                                                                                          | commonGeneration |
| `input[].mime_type`                   | string                             | optional/conditional | not documented | {"conditionalRequired":"inline media"}                                                                                                                                                                                                                | commonGeneration |
| `input[].uri`                         | string                             | optional/conditional | not documented | {"conditionalRequired":"Files API media instead of inline bytes","notes":["Omni examples establish uploaded Files API URIs. Arbitrary remote HTTPS URI acceptance is not proven by those examples; the broker can safely load/inline owned assets."]} | commonGeneration |
| `previous_interaction_id`             | string                             | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | modelSpecific    |
| `generation_config.video_config.task` | string                             | optional/conditional | not documented | {"enum":["text_to_video","image_to_video","reference_to_video","edit","extend"]}                                                                                                                                                                      | commonGeneration |
| `response_format.type`                | string                             | optional/conditional | not documented | {"enum":["video"]}                                                                                                                                                                                                                                    | commonGeneration |
| `response_format.delivery`            | string                             | optional/conditional | not documented | {"enum":["inline","uri"]}                                                                                                                                                                                                                             | brokerTransport  |
| `response_format.aspect_ratio`        | string                             | optional/conditional | 16:9           | {"enum":["16:9","9:16"]}                                                                                                                                                                                                                              | commonGeneration |
| `response_format.duration`            | duration string                    | optional/conditional | not documented | {"bounds":{"minimumSeconds":3,"maximumSeconds":10},"formatExample":"5s","defaultStatus":"not_documented_in_checked_modelguide"}                                                                                                                       | commonGeneration |
| `response_format.resolution`          | string                             | optional/conditional | 720p           | {"enum":["360p","720p","1080p","4k"]}                                                                                                                                                                                                                 | commonGeneration |
| `background`                          | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `store`                               | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `stream`                              | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |

Media constraints:

```json
{
  "outputSeconds": [3, 10],
  "outputFPS": 24,
  "contextTokens": 1048576,
  "uploadedEditExtendVideoMaxSeconds": 10,
  "videoReferenceMaxClips": 3,
  "videoReferenceClipMaxSeconds": 3,
  "videoReferenceAudio": "ignored",
  "imageReferenceMaxCount": {
    "status": "not_documented",
    "lowerBoundExample": 6,
    "priorAdapterLimit": 4,
    "doNotInferMaximumFromExample": true
  },
  "perFileSizeFormatsDimensions": {
    "status": "not_documented_in_checked_modelguide",
    "usePlatformFilesDocsSeparately": true
  }
}
```

Rules:

- Use stable gemini-omni-1.1-flash. Gemini Omni Flash is its marketing alias; gemini-omni-flash-preview is shut down.
- Input roles can be explicit prompt tags: FIRST_FRAME, LAST_FRAME(paired with first), IMAGE_REF_N and VIDEO_REF_N, indexed from zero. Source/reference declarations allow a first frame plus subject references and a source video plus reference images.
- A plain input image is not intrinsically a first-frame instruction: model interpretation follows the prompt unless an explicit task/role is supplied.
- Standalone audio references, voice editing, system instructions, temperature, top_p, stop sequences and negative-prompt controls are unsupported. Negatives can be ordinary prompt text.
- 1080p and 4k outputs are upscaled; the model card lists 24 FPS and a 3–10 second output range.
- Extension appends to the end only. It preserves source ratio; uploaded edit/extend video must be <=10 seconds. Multi-turn extensions of model outputs have separate exceptions.
- Uploaded-video edit/extend is unavailable in EEA, Switzerland and UK, while model-generated-video continuation is supported. Recognizable-person and minors restrictions also vary by region.
- An uploaded talking video cannot be extended to add dialogue; speech extension through previous_interaction_id is documented.
- Reference-video audio is ignored; up to 3 reference clips of <=3 seconds are stated. The separate warning against reasoning over multiple videos is retained as a scope caution.
- Outputs carry SynthID; no watermark-disable field is declared.
- Stored interaction state is required for continuation. store=false removes that path. URI delivery is recommended for outputs >4 MB.
- No model-specific seed, FPS, batch-count or quality control is documented. General Interactions parameters are not proof of Omni support.

Unresolved / undocumented:

- Maximum image references and per-media size/dimensions are not stated in the checked Omni model guide; do not retain the adapter limit4 as a provider fact.
- GenericInteractionfields suchastools/systeminstruction areplatformlevelonly; Omni explicitlyrejects severalgenericLLMcontrols.
- Promptcharacterceiling notdocumented; contextwindow is not a character limit.

## google.omni.image-to-video

`POST https://generativelanguage.googleapis.com/v1beta/interactions`

Operations: image-to-video.

Sources: [omni-model](https://aistudio.google.com/docs/models/gemini-omni-flash), [omni-guide](https://aistudio.google.com/docs/omni), [omni-api](https://aistudio.google.com/api-reference/interactions-api), [omni-duration](https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-omni-flash-api/scripts/video/generate_video.py).

| Upstream field                        | Type                               | Required             | Default        | Bounds / choices                                                                                                                                                                                                                                      | Proposed layer   |
| ------------------------------------- | ---------------------------------- | -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                               | string                             | yes                  | not documented | {"enum":["gemini-omni-1.1-flash"]}                                                                                                                                                                                                                    | brokerTransport  |
| `input`                               | string\|Content\|Content[]\|Step[] | yes                  | not documented | {"evidenceScope":"Generic Interactions create union; Omni guide demonstrates string and text/image/video content arrays. Step[] model applicability remains unverified."}                                                                             | commonGeneration |
| `input[].type`                        | string                             | yes                  | not documented | {"enum":["text","image","video"]}                                                                                                                                                                                                                     | commonGeneration |
| `input[].text`                        | string                             | optional/conditional | not documented | {"conditionalRequired":"type=text"}                                                                                                                                                                                                                   | commonGeneration |
| `input[].data`                        | base64 string                      | optional/conditional | not documented | {"conditionalRequired":"inline image/video"}                                                                                                                                                                                                          | commonGeneration |
| `input[].mime_type`                   | string                             | optional/conditional | not documented | {"conditionalRequired":"inline media"}                                                                                                                                                                                                                | commonGeneration |
| `input[].uri`                         | string                             | optional/conditional | not documented | {"conditionalRequired":"Files API media instead of inline bytes","notes":["Omni examples establish uploaded Files API URIs. Arbitrary remote HTTPS URI acceptance is not proven by those examples; the broker can safely load/inline owned assets."]} | commonGeneration |
| `previous_interaction_id`             | string                             | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | modelSpecific    |
| `generation_config.video_config.task` | string                             | optional/conditional | not documented | {"enum":["text_to_video","image_to_video","reference_to_video","edit","extend"]}                                                                                                                                                                      | commonGeneration |
| `response_format.type`                | string                             | optional/conditional | not documented | {"enum":["video"]}                                                                                                                                                                                                                                    | commonGeneration |
| `response_format.delivery`            | string                             | optional/conditional | not documented | {"enum":["inline","uri"]}                                                                                                                                                                                                                             | brokerTransport  |
| `response_format.aspect_ratio`        | string                             | optional/conditional | 16:9           | {"enum":["16:9","9:16"]}                                                                                                                                                                                                                              | commonGeneration |
| `response_format.duration`            | duration string                    | optional/conditional | not documented | {"bounds":{"minimumSeconds":3,"maximumSeconds":10},"formatExample":"5s","defaultStatus":"not_documented_in_checked_modelguide"}                                                                                                                       | commonGeneration |
| `response_format.resolution`          | string                             | optional/conditional | 720p           | {"enum":["360p","720p","1080p","4k"]}                                                                                                                                                                                                                 | commonGeneration |
| `background`                          | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `store`                               | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `stream`                              | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |

Media constraints:

```json
{
  "outputSeconds": [3, 10],
  "outputFPS": 24,
  "contextTokens": 1048576,
  "uploadedEditExtendVideoMaxSeconds": 10,
  "videoReferenceMaxClips": 3,
  "videoReferenceClipMaxSeconds": 3,
  "videoReferenceAudio": "ignored",
  "imageReferenceMaxCount": {
    "status": "not_documented",
    "lowerBoundExample": 6,
    "priorAdapterLimit": 4,
    "doNotInferMaximumFromExample": true
  },
  "perFileSizeFormatsDimensions": {
    "status": "not_documented_in_checked_modelguide",
    "usePlatformFilesDocsSeparately": true
  }
}
```

Rules:

- Use stable gemini-omni-1.1-flash. Gemini Omni Flash is its marketing alias; gemini-omni-flash-preview is shut down.
- Input roles can be explicit prompt tags: FIRST_FRAME, LAST_FRAME(paired with first), IMAGE_REF_N and VIDEO_REF_N, indexed from zero. Source/reference declarations allow a first frame plus subject references and a source video plus reference images.
- A plain input image is not intrinsically a first-frame instruction: model interpretation follows the prompt unless an explicit task/role is supplied.
- Standalone audio references, voice editing, system instructions, temperature, top_p, stop sequences and negative-prompt controls are unsupported. Negatives can be ordinary prompt text.
- 1080p and 4k outputs are upscaled; the model card lists 24 FPS and a 3–10 second output range.
- Extension appends to the end only. It preserves source ratio; uploaded edit/extend video must be <=10 seconds. Multi-turn extensions of model outputs have separate exceptions.
- Uploaded-video edit/extend is unavailable in EEA, Switzerland and UK, while model-generated-video continuation is supported. Recognizable-person and minors restrictions also vary by region.
- An uploaded talking video cannot be extended to add dialogue; speech extension through previous_interaction_id is documented.
- Reference-video audio is ignored; up to 3 reference clips of <=3 seconds are stated. The separate warning against reasoning over multiple videos is retained as a scope caution.
- Outputs carry SynthID; no watermark-disable field is declared.
- Stored interaction state is required for continuation. store=false removes that path. URI delivery is recommended for outputs >4 MB.
- No model-specific seed, FPS, batch-count or quality control is documented. General Interactions parameters are not proof of Omni support.

Unresolved / undocumented:

- Maximum image references and per-media size/dimensions are not stated in the checked Omni model guide; do not retain the adapter limit4 as a provider fact.
- GenericInteractionfields suchastools/systeminstruction areplatformlevelonly; Omni explicitlyrejects severalgenericLLMcontrols.
- Promptcharacterceiling notdocumented; contextwindow is not a character limit.

## google.omni.first-last-frame-interpolation

`POST https://generativelanguage.googleapis.com/v1beta/interactions`

Operations: first-last-frame-interpolation.

Sources: [omni-model](https://aistudio.google.com/docs/models/gemini-omni-flash), [omni-guide](https://aistudio.google.com/docs/omni), [omni-api](https://aistudio.google.com/api-reference/interactions-api), [omni-duration](https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-omni-flash-api/scripts/video/generate_video.py).

| Upstream field                        | Type                               | Required             | Default        | Bounds / choices                                                                                                                                                                                                                                      | Proposed layer   |
| ------------------------------------- | ---------------------------------- | -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                               | string                             | yes                  | not documented | {"enum":["gemini-omni-1.1-flash"]}                                                                                                                                                                                                                    | brokerTransport  |
| `input`                               | string\|Content\|Content[]\|Step[] | yes                  | not documented | {"evidenceScope":"Generic Interactions create union; Omni guide demonstrates string and text/image/video content arrays. Step[] model applicability remains unverified."}                                                                             | commonGeneration |
| `input[].type`                        | string                             | yes                  | not documented | {"enum":["text","image","video"]}                                                                                                                                                                                                                     | commonGeneration |
| `input[].text`                        | string                             | optional/conditional | not documented | {"conditionalRequired":"type=text"}                                                                                                                                                                                                                   | commonGeneration |
| `input[].data`                        | base64 string                      | optional/conditional | not documented | {"conditionalRequired":"inline image/video"}                                                                                                                                                                                                          | commonGeneration |
| `input[].mime_type`                   | string                             | optional/conditional | not documented | {"conditionalRequired":"inline media"}                                                                                                                                                                                                                | commonGeneration |
| `input[].uri`                         | string                             | optional/conditional | not documented | {"conditionalRequired":"Files API media instead of inline bytes","notes":["Omni examples establish uploaded Files API URIs. Arbitrary remote HTTPS URI acceptance is not proven by those examples; the broker can safely load/inline owned assets."]} | commonGeneration |
| `previous_interaction_id`             | string                             | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | modelSpecific    |
| `generation_config.video_config.task` | string                             | optional/conditional | not documented | {"enum":["text_to_video","image_to_video","reference_to_video","edit","extend"]}                                                                                                                                                                      | commonGeneration |
| `response_format.type`                | string                             | optional/conditional | not documented | {"enum":["video"]}                                                                                                                                                                                                                                    | commonGeneration |
| `response_format.delivery`            | string                             | optional/conditional | not documented | {"enum":["inline","uri"]}                                                                                                                                                                                                                             | brokerTransport  |
| `response_format.aspect_ratio`        | string                             | optional/conditional | 16:9           | {"enum":["16:9","9:16"]}                                                                                                                                                                                                                              | commonGeneration |
| `response_format.duration`            | duration string                    | optional/conditional | not documented | {"bounds":{"minimumSeconds":3,"maximumSeconds":10},"formatExample":"5s","defaultStatus":"not_documented_in_checked_modelguide"}                                                                                                                       | commonGeneration |
| `response_format.resolution`          | string                             | optional/conditional | 720p           | {"enum":["360p","720p","1080p","4k"]}                                                                                                                                                                                                                 | commonGeneration |
| `background`                          | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `store`                               | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `stream`                              | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |

Media constraints:

```json
{
  "outputSeconds": [3, 10],
  "outputFPS": 24,
  "contextTokens": 1048576,
  "uploadedEditExtendVideoMaxSeconds": 10,
  "videoReferenceMaxClips": 3,
  "videoReferenceClipMaxSeconds": 3,
  "videoReferenceAudio": "ignored",
  "imageReferenceMaxCount": {
    "status": "not_documented",
    "lowerBoundExample": 6,
    "priorAdapterLimit": 4,
    "doNotInferMaximumFromExample": true
  },
  "perFileSizeFormatsDimensions": {
    "status": "not_documented_in_checked_modelguide",
    "usePlatformFilesDocsSeparately": true
  }
}
```

Rules:

- Use stable gemini-omni-1.1-flash. Gemini Omni Flash is its marketing alias; gemini-omni-flash-preview is shut down.
- Input roles can be explicit prompt tags: FIRST_FRAME, LAST_FRAME(paired with first), IMAGE_REF_N and VIDEO_REF_N, indexed from zero. Source/reference declarations allow a first frame plus subject references and a source video plus reference images.
- A plain input image is not intrinsically a first-frame instruction: model interpretation follows the prompt unless an explicit task/role is supplied.
- Standalone audio references, voice editing, system instructions, temperature, top_p, stop sequences and negative-prompt controls are unsupported. Negatives can be ordinary prompt text.
- 1080p and 4k outputs are upscaled; the model card lists 24 FPS and a 3–10 second output range.
- Extension appends to the end only. It preserves source ratio; uploaded edit/extend video must be <=10 seconds. Multi-turn extensions of model outputs have separate exceptions.
- Uploaded-video edit/extend is unavailable in EEA, Switzerland and UK, while model-generated-video continuation is supported. Recognizable-person and minors restrictions also vary by region.
- An uploaded talking video cannot be extended to add dialogue; speech extension through previous_interaction_id is documented.
- Reference-video audio is ignored; up to 3 reference clips of <=3 seconds are stated. The separate warning against reasoning over multiple videos is retained as a scope caution.
- Outputs carry SynthID; no watermark-disable field is declared.
- Stored interaction state is required for continuation. store=false removes that path. URI delivery is recommended for outputs >4 MB.
- No model-specific seed, FPS, batch-count or quality control is documented. General Interactions parameters are not proof of Omni support.

Unresolved / undocumented:

- Maximum image references and per-media size/dimensions are not stated in the checked Omni model guide; do not retain the adapter limit4 as a provider fact.
- GenericInteractionfields suchastools/systeminstruction areplatformlevelonly; Omni explicitlyrejects severalgenericLLMcontrols.
- Promptcharacterceiling notdocumented; contextwindow is not a character limit.

## google.omni.reference-to-video

`POST https://generativelanguage.googleapis.com/v1beta/interactions`

Operations: reference-to-video.

Sources: [omni-model](https://aistudio.google.com/docs/models/gemini-omni-flash), [omni-guide](https://aistudio.google.com/docs/omni), [omni-api](https://aistudio.google.com/api-reference/interactions-api), [omni-duration](https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-omni-flash-api/scripts/video/generate_video.py).

| Upstream field                        | Type                               | Required             | Default        | Bounds / choices                                                                                                                                                                                                                                      | Proposed layer   |
| ------------------------------------- | ---------------------------------- | -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                               | string                             | yes                  | not documented | {"enum":["gemini-omni-1.1-flash"]}                                                                                                                                                                                                                    | brokerTransport  |
| `input`                               | string\|Content\|Content[]\|Step[] | yes                  | not documented | {"evidenceScope":"Generic Interactions create union; Omni guide demonstrates string and text/image/video content arrays. Step[] model applicability remains unverified."}                                                                             | commonGeneration |
| `input[].type`                        | string                             | yes                  | not documented | {"enum":["text","image","video"]}                                                                                                                                                                                                                     | commonGeneration |
| `input[].text`                        | string                             | optional/conditional | not documented | {"conditionalRequired":"type=text"}                                                                                                                                                                                                                   | commonGeneration |
| `input[].data`                        | base64 string                      | optional/conditional | not documented | {"conditionalRequired":"inline image/video"}                                                                                                                                                                                                          | commonGeneration |
| `input[].mime_type`                   | string                             | optional/conditional | not documented | {"conditionalRequired":"inline media"}                                                                                                                                                                                                                | commonGeneration |
| `input[].uri`                         | string                             | optional/conditional | not documented | {"conditionalRequired":"Files API media instead of inline bytes","notes":["Omni examples establish uploaded Files API URIs. Arbitrary remote HTTPS URI acceptance is not proven by those examples; the broker can safely load/inline owned assets."]} | commonGeneration |
| `previous_interaction_id`             | string                             | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | modelSpecific    |
| `generation_config.video_config.task` | string                             | optional/conditional | not documented | {"enum":["text_to_video","image_to_video","reference_to_video","edit","extend"]}                                                                                                                                                                      | commonGeneration |
| `response_format.type`                | string                             | optional/conditional | not documented | {"enum":["video"]}                                                                                                                                                                                                                                    | commonGeneration |
| `response_format.delivery`            | string                             | optional/conditional | not documented | {"enum":["inline","uri"]}                                                                                                                                                                                                                             | brokerTransport  |
| `response_format.aspect_ratio`        | string                             | optional/conditional | 16:9           | {"enum":["16:9","9:16"]}                                                                                                                                                                                                                              | commonGeneration |
| `response_format.duration`            | duration string                    | optional/conditional | not documented | {"bounds":{"minimumSeconds":3,"maximumSeconds":10},"formatExample":"5s","defaultStatus":"not_documented_in_checked_modelguide"}                                                                                                                       | commonGeneration |
| `response_format.resolution`          | string                             | optional/conditional | 720p           | {"enum":["360p","720p","1080p","4k"]}                                                                                                                                                                                                                 | commonGeneration |
| `background`                          | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `store`                               | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `stream`                              | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |

Media constraints:

```json
{
  "outputSeconds": [3, 10],
  "outputFPS": 24,
  "contextTokens": 1048576,
  "uploadedEditExtendVideoMaxSeconds": 10,
  "videoReferenceMaxClips": 3,
  "videoReferenceClipMaxSeconds": 3,
  "videoReferenceAudio": "ignored",
  "imageReferenceMaxCount": {
    "status": "not_documented",
    "lowerBoundExample": 6,
    "priorAdapterLimit": 4,
    "doNotInferMaximumFromExample": true
  },
  "perFileSizeFormatsDimensions": {
    "status": "not_documented_in_checked_modelguide",
    "usePlatformFilesDocsSeparately": true
  }
}
```

Rules:

- Use stable gemini-omni-1.1-flash. Gemini Omni Flash is its marketing alias; gemini-omni-flash-preview is shut down.
- Input roles can be explicit prompt tags: FIRST_FRAME, LAST_FRAME(paired with first), IMAGE_REF_N and VIDEO_REF_N, indexed from zero. Source/reference declarations allow a first frame plus subject references and a source video plus reference images.
- A plain input image is not intrinsically a first-frame instruction: model interpretation follows the prompt unless an explicit task/role is supplied.
- Standalone audio references, voice editing, system instructions, temperature, top_p, stop sequences and negative-prompt controls are unsupported. Negatives can be ordinary prompt text.
- 1080p and 4k outputs are upscaled; the model card lists 24 FPS and a 3–10 second output range.
- Extension appends to the end only. It preserves source ratio; uploaded edit/extend video must be <=10 seconds. Multi-turn extensions of model outputs have separate exceptions.
- Uploaded-video edit/extend is unavailable in EEA, Switzerland and UK, while model-generated-video continuation is supported. Recognizable-person and minors restrictions also vary by region.
- An uploaded talking video cannot be extended to add dialogue; speech extension through previous_interaction_id is documented.
- Reference-video audio is ignored; up to 3 reference clips of <=3 seconds are stated. The separate warning against reasoning over multiple videos is retained as a scope caution.
- Outputs carry SynthID; no watermark-disable field is declared.
- Stored interaction state is required for continuation. store=false removes that path. URI delivery is recommended for outputs >4 MB.
- No model-specific seed, FPS, batch-count or quality control is documented. General Interactions parameters are not proof of Omni support.

Unresolved / undocumented:

- Maximum image references and per-media size/dimensions are not stated in the checked Omni model guide; do not retain the adapter limit4 as a provider fact.
- GenericInteractionfields suchastools/systeminstruction areplatformlevelonly; Omni explicitlyrejects severalgenericLLMcontrols.
- Promptcharacterceiling notdocumented; contextwindow is not a character limit.

## google.omni.video-edit

`POST https://generativelanguage.googleapis.com/v1beta/interactions`

Operations: video-edit.

Sources: [omni-model](https://aistudio.google.com/docs/models/gemini-omni-flash), [omni-guide](https://aistudio.google.com/docs/omni), [omni-api](https://aistudio.google.com/api-reference/interactions-api), [omni-duration](https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-omni-flash-api/scripts/video/generate_video.py).

| Upstream field                        | Type                               | Required             | Default        | Bounds / choices                                                                                                                                                                                                                                      | Proposed layer   |
| ------------------------------------- | ---------------------------------- | -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                               | string                             | yes                  | not documented | {"enum":["gemini-omni-1.1-flash"]}                                                                                                                                                                                                                    | brokerTransport  |
| `input`                               | string\|Content\|Content[]\|Step[] | yes                  | not documented | {"evidenceScope":"Generic Interactions create union; Omni guide demonstrates string and text/image/video content arrays. Step[] model applicability remains unverified."}                                                                             | commonGeneration |
| `input[].type`                        | string                             | yes                  | not documented | {"enum":["text","image","video"]}                                                                                                                                                                                                                     | commonGeneration |
| `input[].text`                        | string                             | optional/conditional | not documented | {"conditionalRequired":"type=text"}                                                                                                                                                                                                                   | commonGeneration |
| `input[].data`                        | base64 string                      | optional/conditional | not documented | {"conditionalRequired":"inline image/video"}                                                                                                                                                                                                          | commonGeneration |
| `input[].mime_type`                   | string                             | optional/conditional | not documented | {"conditionalRequired":"inline media"}                                                                                                                                                                                                                | commonGeneration |
| `input[].uri`                         | string                             | optional/conditional | not documented | {"conditionalRequired":"Files API media instead of inline bytes","notes":["Omni examples establish uploaded Files API URIs. Arbitrary remote HTTPS URI acceptance is not proven by those examples; the broker can safely load/inline owned assets."]} | commonGeneration |
| `previous_interaction_id`             | string                             | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | modelSpecific    |
| `generation_config.video_config.task` | string                             | optional/conditional | not documented | {"enum":["text_to_video","image_to_video","reference_to_video","edit","extend"]}                                                                                                                                                                      | commonGeneration |
| `response_format.type`                | string                             | optional/conditional | not documented | {"enum":["video"]}                                                                                                                                                                                                                                    | commonGeneration |
| `response_format.delivery`            | string                             | optional/conditional | not documented | {"enum":["inline","uri"]}                                                                                                                                                                                                                             | brokerTransport  |
| `response_format.aspect_ratio`        | string                             | optional/conditional | 16:9           | {"enum":["16:9","9:16"]}                                                                                                                                                                                                                              | commonGeneration |
| `response_format.duration`            | duration string                    | optional/conditional | not documented | {"bounds":{"minimumSeconds":3,"maximumSeconds":10},"formatExample":"5s","defaultStatus":"not_documented_in_checked_modelguide"}                                                                                                                       | commonGeneration |
| `response_format.resolution`          | string                             | optional/conditional | 720p           | {"enum":["360p","720p","1080p","4k"]}                                                                                                                                                                                                                 | commonGeneration |
| `background`                          | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `store`                               | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `stream`                              | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |

Media constraints:

```json
{
  "outputSeconds": [3, 10],
  "outputFPS": 24,
  "contextTokens": 1048576,
  "uploadedEditExtendVideoMaxSeconds": 10,
  "videoReferenceMaxClips": 3,
  "videoReferenceClipMaxSeconds": 3,
  "videoReferenceAudio": "ignored",
  "imageReferenceMaxCount": {
    "status": "not_documented",
    "lowerBoundExample": 6,
    "priorAdapterLimit": 4,
    "doNotInferMaximumFromExample": true
  },
  "perFileSizeFormatsDimensions": {
    "status": "not_documented_in_checked_modelguide",
    "usePlatformFilesDocsSeparately": true
  }
}
```

Rules:

- Use stable gemini-omni-1.1-flash. Gemini Omni Flash is its marketing alias; gemini-omni-flash-preview is shut down.
- Input roles can be explicit prompt tags: FIRST_FRAME, LAST_FRAME(paired with first), IMAGE_REF_N and VIDEO_REF_N, indexed from zero. Source/reference declarations allow a first frame plus subject references and a source video plus reference images.
- A plain input image is not intrinsically a first-frame instruction: model interpretation follows the prompt unless an explicit task/role is supplied.
- Standalone audio references, voice editing, system instructions, temperature, top_p, stop sequences and negative-prompt controls are unsupported. Negatives can be ordinary prompt text.
- 1080p and 4k outputs are upscaled; the model card lists 24 FPS and a 3–10 second output range.
- Extension appends to the end only. It preserves source ratio; uploaded edit/extend video must be <=10 seconds. Multi-turn extensions of model outputs have separate exceptions.
- Uploaded-video edit/extend is unavailable in EEA, Switzerland and UK, while model-generated-video continuation is supported. Recognizable-person and minors restrictions also vary by region.
- An uploaded talking video cannot be extended to add dialogue; speech extension through previous_interaction_id is documented.
- Reference-video audio is ignored; up to 3 reference clips of <=3 seconds are stated. The separate warning against reasoning over multiple videos is retained as a scope caution.
- Outputs carry SynthID; no watermark-disable field is declared.
- Stored interaction state is required for continuation. store=false removes that path. URI delivery is recommended for outputs >4 MB.
- No model-specific seed, FPS, batch-count or quality control is documented. General Interactions parameters are not proof of Omni support.

Unresolved / undocumented:

- Maximum image references and per-media size/dimensions are not stated in the checked Omni model guide; do not retain the adapter limit4 as a provider fact.
- GenericInteractionfields suchastools/systeminstruction areplatformlevelonly; Omni explicitlyrejects severalgenericLLMcontrols.
- Promptcharacterceiling notdocumented; contextwindow is not a character limit.

## google.omni.video-extend

`POST https://generativelanguage.googleapis.com/v1beta/interactions`

Operations: video-extend.

Sources: [omni-model](https://aistudio.google.com/docs/models/gemini-omni-flash), [omni-guide](https://aistudio.google.com/docs/omni), [omni-api](https://aistudio.google.com/api-reference/interactions-api), [omni-duration](https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-omni-flash-api/scripts/video/generate_video.py).

| Upstream field                        | Type                               | Required             | Default        | Bounds / choices                                                                                                                                                                                                                                      | Proposed layer   |
| ------------------------------------- | ---------------------------------- | -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                               | string                             | yes                  | not documented | {"enum":["gemini-omni-1.1-flash"]}                                                                                                                                                                                                                    | brokerTransport  |
| `input`                               | string\|Content\|Content[]\|Step[] | yes                  | not documented | {"evidenceScope":"Generic Interactions create union; Omni guide demonstrates string and text/image/video content arrays. Step[] model applicability remains unverified."}                                                                             | commonGeneration |
| `input[].type`                        | string                             | yes                  | not documented | {"enum":["text","image","video"]}                                                                                                                                                                                                                     | commonGeneration |
| `input[].text`                        | string                             | optional/conditional | not documented | {"conditionalRequired":"type=text"}                                                                                                                                                                                                                   | commonGeneration |
| `input[].data`                        | base64 string                      | optional/conditional | not documented | {"conditionalRequired":"inline image/video"}                                                                                                                                                                                                          | commonGeneration |
| `input[].mime_type`                   | string                             | optional/conditional | not documented | {"conditionalRequired":"inline media"}                                                                                                                                                                                                                | commonGeneration |
| `input[].uri`                         | string                             | optional/conditional | not documented | {"conditionalRequired":"Files API media instead of inline bytes","notes":["Omni examples establish uploaded Files API URIs. Arbitrary remote HTTPS URI acceptance is not proven by those examples; the broker can safely load/inline owned assets."]} | commonGeneration |
| `previous_interaction_id`             | string                             | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | modelSpecific    |
| `generation_config.video_config.task` | string                             | optional/conditional | not documented | {"enum":["text_to_video","image_to_video","reference_to_video","edit","extend"]}                                                                                                                                                                      | commonGeneration |
| `response_format.type`                | string                             | optional/conditional | not documented | {"enum":["video"]}                                                                                                                                                                                                                                    | commonGeneration |
| `response_format.delivery`            | string                             | optional/conditional | not documented | {"enum":["inline","uri"]}                                                                                                                                                                                                                             | brokerTransport  |
| `response_format.aspect_ratio`        | string                             | optional/conditional | 16:9           | {"enum":["16:9","9:16"]}                                                                                                                                                                                                                              | commonGeneration |
| `response_format.duration`            | duration string                    | optional/conditional | not documented | {"bounds":{"minimumSeconds":3,"maximumSeconds":10},"formatExample":"5s","defaultStatus":"not_documented_in_checked_modelguide"}                                                                                                                       | commonGeneration |
| `response_format.resolution`          | string                             | optional/conditional | 720p           | {"enum":["360p","720p","1080p","4k"]}                                                                                                                                                                                                                 | commonGeneration |
| `background`                          | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `store`                               | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `stream`                              | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |

Media constraints:

```json
{
  "outputSeconds": [3, 10],
  "outputFPS": 24,
  "contextTokens": 1048576,
  "uploadedEditExtendVideoMaxSeconds": 10,
  "videoReferenceMaxClips": 3,
  "videoReferenceClipMaxSeconds": 3,
  "videoReferenceAudio": "ignored",
  "imageReferenceMaxCount": {
    "status": "not_documented",
    "lowerBoundExample": 6,
    "priorAdapterLimit": 4,
    "doNotInferMaximumFromExample": true
  },
  "perFileSizeFormatsDimensions": {
    "status": "not_documented_in_checked_modelguide",
    "usePlatformFilesDocsSeparately": true
  }
}
```

Rules:

- Use stable gemini-omni-1.1-flash. Gemini Omni Flash is its marketing alias; gemini-omni-flash-preview is shut down.
- Input roles can be explicit prompt tags: FIRST_FRAME, LAST_FRAME(paired with first), IMAGE_REF_N and VIDEO_REF_N, indexed from zero. Source/reference declarations allow a first frame plus subject references and a source video plus reference images.
- A plain input image is not intrinsically a first-frame instruction: model interpretation follows the prompt unless an explicit task/role is supplied.
- Standalone audio references, voice editing, system instructions, temperature, top_p, stop sequences and negative-prompt controls are unsupported. Negatives can be ordinary prompt text.
- 1080p and 4k outputs are upscaled; the model card lists 24 FPS and a 3–10 second output range.
- Extension appends to the end only. It preserves source ratio; uploaded edit/extend video must be <=10 seconds. Multi-turn extensions of model outputs have separate exceptions.
- Uploaded-video edit/extend is unavailable in EEA, Switzerland and UK, while model-generated-video continuation is supported. Recognizable-person and minors restrictions also vary by region.
- An uploaded talking video cannot be extended to add dialogue; speech extension through previous_interaction_id is documented.
- Reference-video audio is ignored; up to 3 reference clips of <=3 seconds are stated. The separate warning against reasoning over multiple videos is retained as a scope caution.
- Outputs carry SynthID; no watermark-disable field is declared.
- Stored interaction state is required for continuation. store=false removes that path. URI delivery is recommended for outputs >4 MB.
- No model-specific seed, FPS, batch-count or quality control is documented. General Interactions parameters are not proof of Omni support.

Unresolved / undocumented:

- Maximum image references and per-media size/dimensions are not stated in the checked Omni model guide; do not retain the adapter limit4 as a provider fact.
- GenericInteractionfields suchastools/systeminstruction areplatformlevelonly; Omni explicitlyrejects severalgenericLLMcontrols.
- Promptcharacterceiling notdocumented; contextwindow is not a character limit.

## google.omni.conversational-video-edit

`POST https://generativelanguage.googleapis.com/v1beta/interactions`

Operations: conversational-video-edit.

Sources: [omni-model](https://aistudio.google.com/docs/models/gemini-omni-flash), [omni-guide](https://aistudio.google.com/docs/omni), [omni-api](https://aistudio.google.com/api-reference/interactions-api), [omni-duration](https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-omni-flash-api/scripts/video/generate_video.py).

| Upstream field                        | Type                               | Required             | Default        | Bounds / choices                                                                                                                                                                                                                                      | Proposed layer   |
| ------------------------------------- | ---------------------------------- | -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                               | string                             | yes                  | not documented | {"enum":["gemini-omni-1.1-flash"]}                                                                                                                                                                                                                    | brokerTransport  |
| `input`                               | string\|Content\|Content[]\|Step[] | yes                  | not documented | {"evidenceScope":"Generic Interactions create union; Omni guide demonstrates string and text/image/video content arrays. Step[] model applicability remains unverified."}                                                                             | commonGeneration |
| `input[].type`                        | string                             | yes                  | not documented | {"enum":["text","image","video"]}                                                                                                                                                                                                                     | commonGeneration |
| `input[].text`                        | string                             | optional/conditional | not documented | {"conditionalRequired":"type=text"}                                                                                                                                                                                                                   | commonGeneration |
| `input[].data`                        | base64 string                      | optional/conditional | not documented | {"conditionalRequired":"inline image/video"}                                                                                                                                                                                                          | commonGeneration |
| `input[].mime_type`                   | string                             | optional/conditional | not documented | {"conditionalRequired":"inline media"}                                                                                                                                                                                                                | commonGeneration |
| `input[].uri`                         | string                             | optional/conditional | not documented | {"conditionalRequired":"Files API media instead of inline bytes","notes":["Omni examples establish uploaded Files API URIs. Arbitrary remote HTTPS URI acceptance is not proven by those examples; the broker can safely load/inline owned assets."]} | commonGeneration |
| `previous_interaction_id`             | string                             | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | modelSpecific    |
| `generation_config.video_config.task` | string                             | optional/conditional | not documented | {"enum":["text_to_video","image_to_video","reference_to_video","edit","extend"]}                                                                                                                                                                      | commonGeneration |
| `response_format.type`                | string                             | optional/conditional | not documented | {"enum":["video"]}                                                                                                                                                                                                                                    | commonGeneration |
| `response_format.delivery`            | string                             | optional/conditional | not documented | {"enum":["inline","uri"]}                                                                                                                                                                                                                             | brokerTransport  |
| `response_format.aspect_ratio`        | string                             | optional/conditional | 16:9           | {"enum":["16:9","9:16"]}                                                                                                                                                                                                                              | commonGeneration |
| `response_format.duration`            | duration string                    | optional/conditional | not documented | {"bounds":{"minimumSeconds":3,"maximumSeconds":10},"formatExample":"5s","defaultStatus":"not_documented_in_checked_modelguide"}                                                                                                                       | commonGeneration |
| `response_format.resolution`          | string                             | optional/conditional | 720p           | {"enum":["360p","720p","1080p","4k"]}                                                                                                                                                                                                                 | commonGeneration |
| `background`                          | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `store`                               | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `stream`                              | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |

Media constraints:

```json
{
  "outputSeconds": [3, 10],
  "outputFPS": 24,
  "contextTokens": 1048576,
  "uploadedEditExtendVideoMaxSeconds": 10,
  "videoReferenceMaxClips": 3,
  "videoReferenceClipMaxSeconds": 3,
  "videoReferenceAudio": "ignored",
  "imageReferenceMaxCount": {
    "status": "not_documented",
    "lowerBoundExample": 6,
    "priorAdapterLimit": 4,
    "doNotInferMaximumFromExample": true
  },
  "perFileSizeFormatsDimensions": {
    "status": "not_documented_in_checked_modelguide",
    "usePlatformFilesDocsSeparately": true
  }
}
```

Rules:

- Use stable gemini-omni-1.1-flash. Gemini Omni Flash is its marketing alias; gemini-omni-flash-preview is shut down.
- Input roles can be explicit prompt tags: FIRST_FRAME, LAST_FRAME(paired with first), IMAGE_REF_N and VIDEO_REF_N, indexed from zero. Source/reference declarations allow a first frame plus subject references and a source video plus reference images.
- A plain input image is not intrinsically a first-frame instruction: model interpretation follows the prompt unless an explicit task/role is supplied.
- Standalone audio references, voice editing, system instructions, temperature, top_p, stop sequences and negative-prompt controls are unsupported. Negatives can be ordinary prompt text.
- 1080p and 4k outputs are upscaled; the model card lists 24 FPS and a 3–10 second output range.
- Extension appends to the end only. It preserves source ratio; uploaded edit/extend video must be <=10 seconds. Multi-turn extensions of model outputs have separate exceptions.
- Uploaded-video edit/extend is unavailable in EEA, Switzerland and UK, while model-generated-video continuation is supported. Recognizable-person and minors restrictions also vary by region.
- An uploaded talking video cannot be extended to add dialogue; speech extension through previous_interaction_id is documented.
- Reference-video audio is ignored; up to 3 reference clips of <=3 seconds are stated. The separate warning against reasoning over multiple videos is retained as a scope caution.
- Outputs carry SynthID; no watermark-disable field is declared.
- Stored interaction state is required for continuation. store=false removes that path. URI delivery is recommended for outputs >4 MB.
- No model-specific seed, FPS, batch-count or quality control is documented. General Interactions parameters are not proof of Omni support.

Unresolved / undocumented:

- Maximum image references and per-media size/dimensions are not stated in the checked Omni model guide; do not retain the adapter limit4 as a provider fact.
- GenericInteractionfields suchastools/systeminstruction areplatformlevelonly; Omni explicitlyrejects severalgenericLLMcontrols.
- Promptcharacterceiling notdocumented; contextwindow is not a character limit.

## google.omni.video-upscale

`POST https://generativelanguage.googleapis.com/v1beta/interactions`

Operations: video-upscale.

Sources: [omni-model](https://aistudio.google.com/docs/models/gemini-omni-flash), [omni-guide](https://aistudio.google.com/docs/omni), [omni-api](https://aistudio.google.com/api-reference/interactions-api), [omni-duration](https://github.com/google-gemini/gemini-skills/blob/main/skills/gemini-omni-flash-api/scripts/video/generate_video.py).

| Upstream field                        | Type                               | Required             | Default        | Bounds / choices                                                                                                                                                                                                                                      | Proposed layer   |
| ------------------------------------- | ---------------------------------- | -------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                               | string                             | yes                  | not documented | {"enum":["gemini-omni-1.1-flash"]}                                                                                                                                                                                                                    | brokerTransport  |
| `input`                               | string\|Content\|Content[]\|Step[] | yes                  | not documented | {"evidenceScope":"Generic Interactions create union; Omni guide demonstrates string and text/image/video content arrays. Step[] model applicability remains unverified."}                                                                             | commonGeneration |
| `input[].type`                        | string                             | yes                  | not documented | {"enum":["text","image","video"]}                                                                                                                                                                                                                     | commonGeneration |
| `input[].text`                        | string                             | optional/conditional | not documented | {"conditionalRequired":"type=text"}                                                                                                                                                                                                                   | commonGeneration |
| `input[].data`                        | base64 string                      | optional/conditional | not documented | {"conditionalRequired":"inline image/video"}                                                                                                                                                                                                          | commonGeneration |
| `input[].mime_type`                   | string                             | optional/conditional | not documented | {"conditionalRequired":"inline media"}                                                                                                                                                                                                                | commonGeneration |
| `input[].uri`                         | string                             | optional/conditional | not documented | {"conditionalRequired":"Files API media instead of inline bytes","notes":["Omni examples establish uploaded Files API URIs. Arbitrary remote HTTPS URI acceptance is not proven by those examples; the broker can safely load/inline owned assets."]} | commonGeneration |
| `previous_interaction_id`             | string                             | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | modelSpecific    |
| `generation_config.video_config.task` | string                             | optional/conditional | not documented | {"enum":["text_to_video","image_to_video","reference_to_video","edit","extend"]}                                                                                                                                                                      | commonGeneration |
| `response_format.type`                | string                             | optional/conditional | not documented | {"enum":["video"]}                                                                                                                                                                                                                                    | commonGeneration |
| `response_format.delivery`            | string                             | optional/conditional | not documented | {"enum":["inline","uri"]}                                                                                                                                                                                                                             | brokerTransport  |
| `response_format.aspect_ratio`        | string                             | optional/conditional | 16:9           | {"enum":["16:9","9:16"]}                                                                                                                                                                                                                              | commonGeneration |
| `response_format.duration`            | duration string                    | optional/conditional | not documented | {"bounds":{"minimumSeconds":3,"maximumSeconds":10},"formatExample":"5s","defaultStatus":"not_documented_in_checked_modelguide"}                                                                                                                       | commonGeneration |
| `response_format.resolution`          | string                             | optional/conditional | 720p           | {"enum":["360p","720p","1080p","4k"]}                                                                                                                                                                                                                 | commonGeneration |
| `background`                          | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `store`                               | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |
| `stream`                              | boolean                            | optional/conditional | not documented | —                                                                                                                                                                                                                                                     | brokerTransport  |

Media constraints:

```json
{
  "outputSeconds": [3, 10],
  "outputFPS": 24,
  "contextTokens": 1048576,
  "uploadedEditExtendVideoMaxSeconds": 10,
  "videoReferenceMaxClips": 3,
  "videoReferenceClipMaxSeconds": 3,
  "videoReferenceAudio": "ignored",
  "imageReferenceMaxCount": {
    "status": "not_documented",
    "lowerBoundExample": 6,
    "priorAdapterLimit": 4,
    "doNotInferMaximumFromExample": true
  },
  "perFileSizeFormatsDimensions": {
    "status": "not_documented_in_checked_modelguide",
    "usePlatformFilesDocsSeparately": true
  }
}
```

Rules:

- Use stable gemini-omni-1.1-flash. Gemini Omni Flash is its marketing alias; gemini-omni-flash-preview is shut down.
- Input roles can be explicit prompt tags: FIRST_FRAME, LAST_FRAME(paired with first), IMAGE_REF_N and VIDEO_REF_N, indexed from zero. Source/reference declarations allow a first frame plus subject references and a source video plus reference images.
- A plain input image is not intrinsically a first-frame instruction: model interpretation follows the prompt unless an explicit task/role is supplied.
- Standalone audio references, voice editing, system instructions, temperature, top_p, stop sequences and negative-prompt controls are unsupported. Negatives can be ordinary prompt text.
- 1080p and 4k outputs are upscaled; the model card lists 24 FPS and a 3–10 second output range.
- Extension appends to the end only. It preserves source ratio; uploaded edit/extend video must be <=10 seconds. Multi-turn extensions of model outputs have separate exceptions.
- Uploaded-video edit/extend is unavailable in EEA, Switzerland and UK, while model-generated-video continuation is supported. Recognizable-person and minors restrictions also vary by region.
- An uploaded talking video cannot be extended to add dialogue; speech extension through previous_interaction_id is documented.
- Reference-video audio is ignored; up to 3 reference clips of <=3 seconds are stated. The separate warning against reasoning over multiple videos is retained as a scope caution.
- Outputs carry SynthID; no watermark-disable field is declared.
- Stored interaction state is required for continuation. store=false removes that path. URI delivery is recommended for outputs >4 MB.
- No model-specific seed, FPS, batch-count or quality control is documented. General Interactions parameters are not proof of Omni support.

Unresolved / undocumented:

- Maximum image references and per-media size/dimensions are not stated in the checked Omni model guide; do not retain the adapter limit4 as a provider fact.
- GenericInteractionfields suchastools/systeminstruction areplatformlevelonly; Omni explicitlyrejects severalgenericLLMcontrols.
- Promptcharacterceiling notdocumented; contextwindow is not a character limit.

## xai/grok-imagine-video-1.5.generate

`POST https://api.x.ai/v1/videos/generations`

Operations: text-to-video, image-to-video, reference-to-video, last-frame-to-video, keyframe-to-video.

Sources: [xai-generation](https://docs.x.ai/developers/model-capabilities/video/generation), [xai-overview](https://docs.x.ai/developers/model-capabilities/video/overview), [xai-image](https://docs.x.ai/developers/model-capabilities/video/image-to-video), [xai-reference](https://docs.x.ai/developers/model-capabilities/video/reference-to-video), [xai-proto](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/video_pb2.pyi), [xai-sdk](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/video.py), [https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/image_pb2.pyi](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/image_pb2.pyi), [https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/files.py](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/files.py).

| Upstream field                             | Type            | Required             | Default        | Bounds / choices                                                                                                                                                                                          | Proposed layer   |
| ------------------------------------------ | --------------- | -------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                                    | string          | yes                  | not documented | —                                                                                                                                                                                                         | brokerTransport  |
| `prompt`                                   | string          | optional/conditional | not documented | {"conditionalRequired":"text-only; optional with image/reference_images/last_frame/keyframes"}                                                                                                            | commonGeneration |
| `duration`                                 | integer         | optional/conditional | 8              | {"minimum":1,"maximum":15}                                                                                                                                                                                | commonGeneration |
| `aspect_ratio`                             | string          | optional/conditional | 16:9           | {"enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","21:9","5:2"]}                                                                                                                                       | commonGeneration |
| `resolution`                               | string          | optional/conditional | 480p           | {"enum":["480p","720p","1080p"]}                                                                                                                                                                          | commonGeneration |
| `generate_audio`                           | boolean         | optional/conditional | True           | —                                                                                                                                                                                                         | commonGeneration |
| `image`                                    | object          | optional/conditional | not documented | {"conditionalRequired":"first-frame mode"}                                                                                                                                                                | commonGeneration |
| `image.url`                                | string          | optional/conditional | not documented | {"locations":["public URL","base64 data URI"]}                                                                                                                                                            | commonGeneration |
| `image.file_id`                            | string          | optional/conditional | not documented | {"mutuallyExclusiveWith":"image.url"}                                                                                                                                                                     | commonGeneration |
| `reference_images`                         | object[]        | optional/conditional | not documented | {"maxItems":14,"combinedWithPinnedFramesMax":{"status":"not_documented"}}                                                                                                                                 | commonGeneration |
| `reference_images[].url`                   | string          | optional/conditional | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `reference_images[].file_id`               | string          | optional/conditional | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `reference_audios`                         | object[]        | optional/conditional | not documented | {"maxItems":3}                                                                                                                                                                                            | modelSpecific    |
| `reference_audios[].voice_id`              | string          | yes                  | not documented | —                                                                                                                                                                                                         | modelSpecific    |
| `last_frame`                               | object          | optional/conditional | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `last_frame.url`                           | string          | optional/conditional | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `last_frame.file_id`                       | string          | optional/conditional | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `keyframes`                                | object[]        | optional/conditional | not documented | {"maxItems":4}                                                                                                                                                                                            | commonGeneration |
| `keyframes[].image`                        | object          | yes                  | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `keyframes[].image.url`                    | string          | optional/conditional | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `keyframes[].image.file_id`                | string          | optional/conditional | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `keyframes[].timestamp_s`                  | number          | yes                  | not documented | {"exclusiveMinimum":0,"maximumConstraint":"strictly less than requested duration","quantization":"nearest1/3second; duplicate slots rejected"}                                                            | commonGeneration |
| `storage_options`                          | object          | optional/conditional | not documented | {"scope":"platform delivery; detailed fields shared with image audit"}                                                                                                                                    | brokerTransport  |
| `storage_options.filename`                 | string          | when parent present  | not documented | {"notes":["Required when storage_options is used."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}                              | brokerTransport  |
| `storage_options.expires_after`            | integer seconds | optional/conditional | not documented | {"notes":["SDK also accepts timedelta; omitted file expiry can be indefinite."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}  | brokerTransport  |
| `storage_options.public_url`               | boolean\|object | optional/conditional | False          | {"notes":["Omission creates private file. true inherits file TTL or no expiry."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."} | brokerTransport  |
| `storage_options.public_url.expires_after` | integer seconds | optional/conditional | not documented | {"notes":["Independent public URL TTL does not delete the file."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}                | brokerTransport  |

Variant constraints:

```json
{
  "xai/grok-imagine-video-1.5": {
    "textToVideo": true,
    "imageToVideo": true,
    "referenceImagesMax": 14,
    "referenceVoicesMax": 3,
    "lastFrame": true,
    "keyframesMax": 4,
    "resolutions": ["480p", "720p", "1080p"],
    "referenceMaxResolution": "720p",
    "native1080p": true,
    "durationSeconds": [1, 15]
  }
}
```

Rules:

- The field inventory is narrowed by the exact variant capabilities; Lite/legacy do not inherit 1.5-only controls.
- 1.5 may combine pinned first/last/keyframes with reference images and preset voices. A combined image field is a pinned first frame, not a style reference.
- The classic model rejects last_frame/keyframes and combining a first image with reference inputs.
- Image-to-video inherits image ratio and ignores an explicit aspect_ratio upstream; OpenGen must validate or disclose that behavior.
- Each asset uses a URL/data URI or Files API ID; those alternatives are mutually exclusive per asset.
- 1.5 accepts up to 3 case-insensitive preset voice IDs. User audio-file voice references are trusted-partner/account-gated, not a public custom-upload feature.
- Keyframes lie strictly inside the clip, snap to a 1/3-second grid and reject duplicate grid slots. The aggregate image cap across references and pinned frames is not stated.
- No seed, negative_prompt, camera, FPS, batch-count, watermark-off or safety-disable generation input is documented.
- Python SDK names differ from REST. Poll timeout/interval and storage options are transport controls.

Unresolved / undocumented:

- Per-imagebytes/dimensions/formats and promptmaxchars are not specified in checked video generation guide.

## xai/grok-imagine-video-1.5-lite.generate

`POST https://api.x.ai/v1/videos/generations`

Operations: text-to-video, image-to-video.

Sources: [xai-generation](https://docs.x.ai/developers/model-capabilities/video/generation), [xai-overview](https://docs.x.ai/developers/model-capabilities/video/overview), [xai-image](https://docs.x.ai/developers/model-capabilities/video/image-to-video), [xai-reference](https://docs.x.ai/developers/model-capabilities/video/reference-to-video), [xai-proto](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/video_pb2.pyi), [xai-sdk](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/video.py), [https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/image_pb2.pyi](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/image_pb2.pyi), [https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/files.py](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/files.py).

| Upstream field                             | Type            | Required             | Default        | Bounds / choices                                                                                                                                                                                          | Proposed layer   |
| ------------------------------------------ | --------------- | -------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                                    | string          | yes                  | not documented | —                                                                                                                                                                                                         | brokerTransport  |
| `prompt`                                   | string          | optional/conditional | not documented | {"conditionalRequired":"text-only; optional with image/reference_images/last_frame/keyframes"}                                                                                                            | commonGeneration |
| `duration`                                 | integer         | optional/conditional | 8              | {"minimum":1,"maximum":15}                                                                                                                                                                                | commonGeneration |
| `aspect_ratio`                             | string          | optional/conditional | 16:9           | {"enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","21:9","5:2"]}                                                                                                                                       | commonGeneration |
| `resolution`                               | string          | optional/conditional | 480p           | {"enum":["480p","720p","1080p"]}                                                                                                                                                                          | commonGeneration |
| `generate_audio`                           | boolean         | optional/conditional | True           | —                                                                                                                                                                                                         | commonGeneration |
| `image`                                    | object          | optional/conditional | not documented | {"conditionalRequired":"first-frame mode"}                                                                                                                                                                | commonGeneration |
| `image.url`                                | string          | optional/conditional | not documented | {"locations":["public URL","base64 data URI"]}                                                                                                                                                            | commonGeneration |
| `image.file_id`                            | string          | optional/conditional | not documented | {"mutuallyExclusiveWith":"image.url"}                                                                                                                                                                     | commonGeneration |
| `storage_options`                          | object          | optional/conditional | not documented | {"scope":"platform delivery; detailed fields shared with image audit"}                                                                                                                                    | brokerTransport  |
| `storage_options.filename`                 | string          | when parent present  | not documented | {"notes":["Required when storage_options is used."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}                              | brokerTransport  |
| `storage_options.expires_after`            | integer seconds | optional/conditional | not documented | {"notes":["SDK also accepts timedelta; omitted file expiry can be indefinite."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}  | brokerTransport  |
| `storage_options.public_url`               | boolean\|object | optional/conditional | False          | {"notes":["Omission creates private file. true inherits file TTL or no expiry."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."} | brokerTransport  |
| `storage_options.public_url.expires_after` | integer seconds | optional/conditional | not documented | {"notes":["Independent public URL TTL does not delete the file."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}                | brokerTransport  |

Variant constraints:

```json
{
  "xai/grok-imagine-video-1.5-lite": {
    "textToVideo": true,
    "imageToVideo": true,
    "referenceImages": false,
    "referenceVoices": false,
    "lastFrame": false,
    "keyframes": false,
    "resolutions": ["480p", "720p", "1080p"],
    "1080p": "upscaled720p",
    "durationSeconds": [1, 15]
  }
}
```

Rules:

- The field inventory is narrowed by the exact variant capabilities; Lite/legacy do not inherit 1.5-only controls.
- 1.5 may combine pinned first/last/keyframes with reference images and preset voices. A combined image field is a pinned first frame, not a style reference.
- The classic model rejects last_frame/keyframes and combining a first image with reference inputs.
- Image-to-video inherits image ratio and ignores an explicit aspect_ratio upstream; OpenGen must validate or disclose that behavior.
- Each asset uses a URL/data URI or Files API ID; those alternatives are mutually exclusive per asset.
- 1.5 accepts up to 3 case-insensitive preset voice IDs. User audio-file voice references are trusted-partner/account-gated, not a public custom-upload feature.
- Keyframes lie strictly inside the clip, snap to a 1/3-second grid and reject duplicate grid slots. The aggregate image cap across references and pinned frames is not stated.
- No seed, negative_prompt, camera, FPS, batch-count, watermark-off or safety-disable generation input is documented.
- Python SDK names differ from REST. Poll timeout/interval and storage options are transport controls.

Unresolved / undocumented:

- Per-imagebytes/dimensions/formats and promptmaxchars are not specified in checked video generation guide.

## xai/grok-imagine-video.generate

`POST https://api.x.ai/v1/videos/generations`

Operations: text-to-video, image-to-video, reference-to-video.

Sources: [xai-generation](https://docs.x.ai/developers/model-capabilities/video/generation), [xai-overview](https://docs.x.ai/developers/model-capabilities/video/overview), [xai-image](https://docs.x.ai/developers/model-capabilities/video/image-to-video), [xai-reference](https://docs.x.ai/developers/model-capabilities/video/reference-to-video), [xai-proto](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/video_pb2.pyi), [xai-sdk](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/video.py), [https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/image_pb2.pyi](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/image_pb2.pyi), [https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/files.py](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/files.py).

| Upstream field                             | Type            | Required             | Default        | Bounds / choices                                                                                                                                                                                          | Proposed layer   |
| ------------------------------------------ | --------------- | -------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                                    | string          | yes                  | not documented | —                                                                                                                                                                                                         | brokerTransport  |
| `prompt`                                   | string          | optional/conditional | not documented | {"conditionalRequired":"text-only; optional with image/reference_images/last_frame/keyframes"}                                                                                                            | commonGeneration |
| `duration`                                 | integer         | optional/conditional | 8              | {"minimum":1,"maximum":15}                                                                                                                                                                                | commonGeneration |
| `aspect_ratio`                             | string          | optional/conditional | 16:9           | {"enum":["1:1","16:9","9:16","4:3","3:4","3:2","2:3","21:9","5:2"]}                                                                                                                                       | commonGeneration |
| `resolution`                               | string          | optional/conditional | 480p           | {"enum":["480p","720p"]}                                                                                                                                                                                  | commonGeneration |
| `generate_audio`                           | boolean         | optional/conditional | True           | —                                                                                                                                                                                                         | commonGeneration |
| `image`                                    | object          | optional/conditional | not documented | {"conditionalRequired":"first-frame mode"}                                                                                                                                                                | commonGeneration |
| `image.url`                                | string          | optional/conditional | not documented | {"locations":["public URL","base64 data URI"]}                                                                                                                                                            | commonGeneration |
| `image.file_id`                            | string          | optional/conditional | not documented | {"mutuallyExclusiveWith":"image.url"}                                                                                                                                                                     | commonGeneration |
| `reference_images`                         | object[]        | optional/conditional | not documented | {"maxItems":7,"combinedWithPinnedFramesMax":{"status":"not_documented"}}                                                                                                                                  | commonGeneration |
| `reference_images[].url`                   | string          | optional/conditional | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `reference_images[].file_id`               | string          | optional/conditional | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `storage_options`                          | object          | optional/conditional | not documented | {"scope":"platform delivery; detailed fields shared with image audit"}                                                                                                                                    | brokerTransport  |
| `storage_options.filename`                 | string          | when parent present  | not documented | {"notes":["Required when storage_options is used."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}                              | brokerTransport  |
| `storage_options.expires_after`            | integer seconds | optional/conditional | not documented | {"notes":["SDK also accepts timedelta; omitted file expiry can be indefinite."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}  | brokerTransport  |
| `storage_options.public_url`               | boolean\|object | optional/conditional | False          | {"notes":["Omission creates private file. true inherits file TTL or no expiry."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."} | brokerTransport  |
| `storage_options.public_url.expires_after` | integer seconds | optional/conditional | not documented | {"notes":["Independent public URL TTL does not delete the file."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}                | brokerTransport  |

Variant constraints:

```json
{
  "xai/grok-imagine-video": {
    "textToVideo": true,
    "imageToVideo": true,
    "referenceImagesMax": 7,
    "referenceDurationMaxSeconds": 10,
    "lastFrame": false,
    "keyframes": false,
    "referenceVoices": false,
    "resolutions": ["480p", "720p"],
    "durationSeconds": [1, 15],
    "editSourceMaxSeconds": 8.7,
    "extendSourceSeconds": [2, 15],
    "extendAddedSeconds": [2, 10]
  }
}
```

Rules:

- The field inventory is narrowed by the exact variant capabilities; Lite/legacy do not inherit 1.5-only controls.
- 1.5 may combine pinned first/last/keyframes with reference images and preset voices. A combined image field is a pinned first frame, not a style reference.
- The classic model rejects last_frame/keyframes and combining a first image with reference inputs.
- Image-to-video inherits image ratio and ignores an explicit aspect_ratio upstream; OpenGen must validate or disclose that behavior.
- Each asset uses a URL/data URI or Files API ID; those alternatives are mutually exclusive per asset.
- 1.5 accepts up to 3 case-insensitive preset voice IDs. User audio-file voice references are trusted-partner/account-gated, not a public custom-upload feature.
- Keyframes lie strictly inside the clip, snap to a 1/3-second grid and reject duplicate grid slots. The aggregate image cap across references and pinned frames is not stated.
- No seed, negative_prompt, camera, FPS, batch-count, watermark-off or safety-disable generation input is documented.
- Python SDK names differ from REST. Poll timeout/interval and storage options are transport controls.

Unresolved / undocumented:

- Per-imagebytes/dimensions/formats and promptmaxchars are not specified in checked video generation guide.

## xai.legacy.video-edit

`POST https://api.x.ai/v1/videos/edits`

Operations: video-edit.

Sources: [xai-edit](https://docs.x.ai/developers/model-capabilities/video/editing), [xai-rest](https://docs.x.ai/developers/rest-api-reference/inference/videos), [xai-proto](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/video_pb2.pyi), [https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/image_pb2.pyi](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/image_pb2.pyi), [https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/files.py](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/files.py).

| Upstream field                             | Type            | Required             | Default        | Bounds / choices                                                                                                                                                                                          | Proposed layer   |
| ------------------------------------------ | --------------- | -------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                                    | string          | yes                  | not documented | {"enum":["grok-imagine-video"]}                                                                                                                                                                           | brokerTransport  |
| `prompt`                                   | string          | yes                  | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `video`                                    | object          | yes                  | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `video.url`                                | string          | optional/conditional | not documented | {"locations":["public URL","base64 data URI"]}                                                                                                                                                            | commonGeneration |
| `video.file_id`                            | string          | optional/conditional | not documented | {"mutuallyExclusiveWith":"video.url"}                                                                                                                                                                     | commonGeneration |
| `storage_options`                          | object          | optional/conditional | not documented | —                                                                                                                                                                                                         | brokerTransport  |
| `storage_options.filename`                 | string          | when parent present  | not documented | {"notes":["Required when storage_options is used."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}                              | brokerTransport  |
| `storage_options.expires_after`            | integer seconds | optional/conditional | not documented | {"notes":["SDK also accepts timedelta; omitted file expiry can be indefinite."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}  | brokerTransport  |
| `storage_options.public_url`               | boolean\|object | optional/conditional | False          | {"notes":["Omission creates private file. true inherits file TTL or no expiry."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."} | brokerTransport  |
| `storage_options.public_url.expires_after` | integer seconds | optional/conditional | not documented | {"notes":["Independent public URL TTL does not delete the file."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}                | brokerTransport  |

Media constraints:

```json
{
  "sourceFormats": ["MP4"],
  "sourceCodecsExamples": ["H.264", "H.265", "AV1"],
  "sourceSeconds": {
    "maximum": 8.7
  }
}
```

Rules:

- Output inherits source aspect ratio and resolution, capped at 720p; explicit ratio/resolution controls are unsupported.
- Editing retains source duration and does not accept duration override.
- These operations use legacy grok-imagine-video, not 1.5/Lite. Their source can be generated by a different model.

Unresolved / undocumented:

- Sourcebytes/dimensions/FPS limits not stated in checked edit/extension guide.

## xai.legacy.video-extend

`POST https://api.x.ai/v1/videos/extensions`

Operations: video-extend.

Sources: [xai-extend](https://docs.x.ai/developers/model-capabilities/video/extension), [xai-rest](https://docs.x.ai/developers/rest-api-reference/inference/videos), [xai-proto](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/video_pb2.pyi), [https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/image_pb2.pyi](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/proto/v6/image_pb2.pyi), [https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/files.py](https://github.com/xai-org/xai-sdk-python/blob/main/src/xai_sdk/files.py).

| Upstream field                             | Type            | Required             | Default        | Bounds / choices                                                                                                                                                                                          | Proposed layer   |
| ------------------------------------------ | --------------- | -------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `model`                                    | string          | yes                  | not documented | {"enum":["grok-imagine-video"]}                                                                                                                                                                           | brokerTransport  |
| `prompt`                                   | string          | yes                  | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `video`                                    | object          | yes                  | not documented | —                                                                                                                                                                                                         | commonGeneration |
| `video.url`                                | string          | optional/conditional | not documented | {"locations":["public URL","base64 data URI"]}                                                                                                                                                            | commonGeneration |
| `video.file_id`                            | string          | optional/conditional | not documented | {"mutuallyExclusiveWith":"video.url"}                                                                                                                                                                     | commonGeneration |
| `storage_options`                          | object          | optional/conditional | not documented | —                                                                                                                                                                                                         | brokerTransport  |
| `duration`                                 | integer         | optional/conditional | 6              | {"minimum":2,"maximum":10}                                                                                                                                                                                | commonGeneration |
| `storage_options.filename`                 | string          | when parent present  | not documented | {"notes":["Required when storage_options is used."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}                              | brokerTransport  |
| `storage_options.expires_after`            | integer seconds | optional/conditional | not documented | {"notes":["SDK also accepts timedelta; omitted file expiry can be indefinite."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}  | brokerTransport  |
| `storage_options.public_url`               | boolean\|object | optional/conditional | False          | {"notes":["Omission creates private file. true inherits file TTL or no expiry."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."} | brokerTransport  |
| `storage_options.public_url.expires_after` | integer seconds | optional/conditional | not documented | {"notes":["Independent public URL TTL does not delete the file."],"evidenceScope":"Official SDK/storage schema; public video REST optional fields are not expanded in the page renderer."}                | brokerTransport  |

Media constraints:

```json
{
  "sourceFormats": ["MP4"],
  "sourceCodecsExamples": ["H.264", "H.265", "AV1"],
  "sourceSeconds": {
    "minimum": 2,
    "maximum": 15
  }
}
```

Rules:

- Output inherits source aspect ratio and resolution, capped at 720p; explicit ratio/resolution controls are unsupported.
- Extension duration is the added portion, not final length; it appends from the source last frame.
- These operations use legacy grok-imagine-video, not 1.5/Lite. Their source can be generated by a different model.

Unresolved / undocumented:

- Sourcebytes/dimensions/FPS limits not stated in checked edit/extension guide.

## Source conflicts

- **minimax-last-only**: Main content combinations explicitly allow a last-frame-only image. The child role description says last_frame must be paired with first_frame. Unresolved documentation conflict; test/clarify with provider before advertising last-only execution as qualified.
- **pika-original-vs-prepared-file**: The model guide permits an original file <=50 MiB followed by CPU preparation to24 MiB. OAS text states24 MiB/file. Keep original/prepared budgets separate and verify admission before claiming one universal limit.
- **fal-ui-vs-oas-expansion**: The OAS marks prompt_expansion_mode required and provides default balanced. Its formal schema is string with examples, not enum. Preserve both requiredness and default; do not invent a formal enum.
- **xai-sdk-ratio-enum-lag**: REST guide lists 21:9 and 5:2 alongside seven other ratios. Checked generated v6 VideoAspectRatio enum lists only the seven earlier ratios. Record REST and SDK surfaces separately; do not downgrade REST capability or claim every SDK version exposes all ratios.
- **omni-format-type-requiredness**: Omni guide marks response_format.type optional in examples. The generic VideoResponseFormat resource marks its discriminator required. Explicitly send type=video in OpenGen translation; retain the documented discrepancy.

## General unknowns

- A field absent from a selected public schema is not proof that no private/account-gated feature exists. It remains unsupported/unqualified until documented.
- Native media pixel dimensions, byte limits, sample rates and frame rates are only recorded where an exact provider source states them; generic fal transport limits are not model limits.
- No account access, generation success, actual latency, measured quality or real charge has been verified.

## Coverage qualification

- MiniMax, fal H3 and Pika Flex: selected formal input schemas and reachable request references are audited.
- Omni: **model-guided partial**, not an exhaustive accepted generic Interactions union. The JSON records unverified Step/content/processing paths and explicitly unsupported generic LLM controls. Input-processing FPS is not output video FPS.
- xAI: model-guide plus official SDK/wire audit. REST optional-field coercions are not invented; storage and media-detail distinctions remain qualified.

## Current adapter subset gaps

- Official H3 adapters currently accept image-only references; native video/audio references, last-only, context IR and regeneration are not implemented.
- fal H3 adapters currently cover text-only routes; all four image/reference endpoints and their keyframe/soundtrack controls are absent.
- Pika adapter currently covers text and image-only references; first/last/draft/stem/rewriter and mixed references need implementation.
- Google adapter currently caps references at4, which is not a documented provider maximum; guide demonstrates6 and mixed explicit roles. URI delivery and model-specific advanced roles remain incomplete.
- xAI adapter currently rejects last/keyframes, combined first-frame references and preset voices; legacy edit/extend remain comparison-only.

## Additional discovered Pika offering

The Pika OpenAPI also documents `/v1/media/minimax/h3/{text-to-video,image-to-video,reference-to-video}`. These are separate provider wrappers, not the Pika H3 Flex derivative. Their complete stripped schemas and field inventories are in the JSON under `additionalProviderDiscoveries`. They expose seed/watermark controls absent from the checked direct v2 schema and require a first frame for image mode. They are not added to executable catalog coverage by this research.

MiniMax callback transport: an initial challenge must be echoed unchanged within 3 seconds. Status pushes use queued/running/succeeded/failed/cancelled. The selected schema does not specify a callback URL scheme restriction; OpenGen should enforce its own outbound callback policy separately.
