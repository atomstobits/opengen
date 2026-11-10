# fal mechanism and OpenGen mapping

Checked 2026-11-03 against fal's public documentation and endpoint OpenAPI. This report contains interface facts and OpenGen recommendations. No inference request or provider account was used.

## Finding

fal standardizes authentication, SDK calling patterns, queue operations and file transport. Its model request body is one JSON input object composed from commonly reused arguments and an endpoint-specific schema. Support, defaults and constraints remain endpoint-specific. There is no universal fal generation body that every model implements. [Model API overview](https://fal.ai/docs/documentation/model-apis/overview), [common arguments](https://fal.ai/docs/documentation/model-apis/model-arguments).

This matches the owner's chosen OpenGen direction: common generation arguments plus model-specific extensions, composed into one input. The same exact OpenGen model gets a stable schema across its providers; adapters translate names and route capabilities may narrow support.

## Shared argument conventions

These are conventions to check on each endpoint, not guaranteed capabilities:

| fal argument                                     | Reused meaning                | Endpoint qualification needed                          |
| ------------------------------------------------ | ----------------------------- | ------------------------------------------------------ |
| `prompt`                                         | Generation instructions       | Requiredness, size, conditional omission and rewriting |
| `seed`                                           | Sampling seed                 | Support, integer range and reproducibility limits      |
| `num_images`                                     | Requested image count         | Range, batching and billing                            |
| `image_size`                                     | Preset or explicit dimensions | Pixel bounds; not interchangeable with ratio           |
| `aspect_ratio`                                   | Output shape                  | Enum, inherited/automatic behavior                     |
| `output_format`                                  | File encoding                 | Supported codecs and defaults                          |
| `enable_safety_checker` / `enable_safety_checks` | Output filtering              | Availability and fixed settings                        |
| `enable_prompt_expansion` / `expand_prompt`      | Prompt enhancement            | Supported names, defaults and extra cost               |
| `user`                                           | End-user safety attribution   | Broker metadata; pseudonymous, at most 256 characters  |

fal notes that an unsupported size argument may have no effect. OpenGen should validate it explicitly. Generic defaults, such as a typical image-count range, must not override model evidence. [Common arguments](https://fal.ai/docs/documentation/model-apis/model-arguments).

## Schema discovery and typed clients

Public per-endpoint OpenAPI is available through:

```text
https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<URL-encoded endpoint ID>
```

The document identifies input/output components, required properties, enums, bounds and nested references. Store the source URL, checked date and raw-source hash; retain API facts while removing long vendor prose/examples from redistributed snapshots. Limits appearing only in prose still require explicit evidence records. [Example: Seedance 2.5 image-to-video OpenAPI](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.5%2Fimage-to-video).

The JavaScript client associates endpoint IDs with `InputType<Id>` and `OutputType<Id>`. Its queue methods share submit/status/result/cancel interfaces while input types differ. [QueueClient reference](https://fal-ai.github.io/fal-js/reference/interfaces/QueueClient.html).

Sanitized examples are indexed in [fal-schema-examples.json](fal-schema-examples.json): Seedance 2.5, Nano Banana 2.1 editing and a clearly out-of-scope Kling 3 example illustrating fal conventions. These snapshots are not an assertion that Kling 3 belongs in OpenGen's initial catalog.

## Endpoint-specific example

The current Seedance 2.5 image-to-video schema exposes `image_url`, `end_image_url`, `prompt`, `duration`, `resolution`, `aspect_ratio`, `generate_audio`, `draft`, `codec`, `bitrate_mode` and `end_user_id`. Only `image_url` is formally required. Duration is a string enum (`auto` or 4–30 seconds); resolution includes 480p/720p/1080p. Codec and bitrate have separate enums. This is evidence for this endpoint, not a rule for other Seedance routes. [Input schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance%2Fseedance-2.5%2Fimage-to-video).

## Transport and execution controls

Keep these outside generation arguments:

| Control                             | Purpose                                                |
| ----------------------------------- | ------------------------------------------------------ |
| `Authorization: Key …`              | Credential and permission scopes                       |
| Full `owner/app/endpoint`           | Submit/run target                                      |
| `request_id`                        | Persisted asynchronous identity                        |
| `fal_webhook`                       | Completion callback                                    |
| `fal_max_queue_length`              | Queue admission ceiling                                |
| `start_timeout` / `client_timeout`  | Queue-start versus client-wait deadline                |
| `X-Fal-Runner-Hint`                 | Best-effort affinity                                   |
| `X-Fal-Queue-Priority`              | Normal/low scheduling                                  |
| `X-Fal-No-Retry`                    | Disable supplier retries                               |
| `X-Fal-Retry-Config`                | Own-app retry settings; not public-model configuration |
| `x-app-fal-disable-fallback`        | Request no model fallback                              |
| `X-Fal-Store-IO`                    | Request-history retention                              |
| `X-Fal-Object-Lifecycle-Preference` | Media expiration and output ACL                        |
| `X-Fal-Tags`                        | Account-enabled attribution                            |
| `X-Fal-Workflow-Envelope`           | Workflow step identities/output wrapper                |

Exact types/defaults belong in the referenced transport documentation. These controls must not become a generic arbitrary-header passthrough. [Inference API](https://fal.ai/docs/api-reference/inference-api), [platform headers](https://fal.ai/docs/documentation/model-apis/common-parameters).

The queue uses `IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`; completed also includes failed/cancelled work, so status alone is insufficient. Retrieve the result/error. Submit uses the full endpoint; the HTTP guide specifies owner/app management paths. Generated endpoint OpenAPI may show full endpoint management paths: retain that discrepancy and verify rather than blindly generating URLs. [Inference API](https://fal.ai/docs/api-reference/inference-api).

## Media and lifecycle

fal accepts reachable URLs and some inline data inputs. Private media can use presigned URLs; arbitrary caller auth headers are not supplied to model downloads. Upload limits and model file limits are separate. [CDN guide](https://fal.ai/docs/documentation/model-apis/fal-cdn).

Request history, CDN retention and deployment logs are distinct. Disabling history does not by itself establish zero retention. Input-upload ACLs are separate from generated-output ACLs, and deletion of an input affects every request using it. OpenGen should preserve owned asset identities and issue provider-access URLs at dispatch. [Retention](https://fal.ai/docs/documentation/model-apis/media-expiration), [file ACLs](https://fal.ai/docs/documentation/model-apis/file-access-controls).

## OpenGen design rules from this audit

1. Compose each operation/model's schema from a shared base and typed model-specific extensions.
2. Expose effective constraints through catalog inspection and the playground.
3. Normalize meaningful shared names/units; preserve exceptional controls in that exact model's extension.
4. Translate provider aliases and file representations inside adapters.
5. Return structured unsupported-option/combination errors before spending; never truncate references or silently ignore controls.
6. Make optional argument support explicit. A common name is not universal support or a promise of equivalent visual results.
7. Keep routing, billing, privacy, identity, deadlines and retries in a separate broker control plane.
8. Preserve exact model identity when configuring supplier retries/fallbacks; document supplier behavior and verification limitations.

Per-model reports carry the exhaustive field inventories and conflicts. This document is the mechanism reference, not a replacement for them.
