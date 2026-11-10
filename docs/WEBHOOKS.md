# Webhooks and alerts

Webhook settings and history belong to a workspace and require `webhooks:write`. A scoped key or authenticated session uses the same authorization boundary. Secrets are encrypted with `MR_VAULT_KEY` and are returned only when created or rotated; store that response privately. Responses containing new secrets use `Cache-Control: no-store`.

## API

- `GET /v1/webhooks`: list up to 100 subscription records without signing secrets.
- `POST /v1/webhooks`: create `{name,url,eventTypes}`. Valid types are `generation.completed`, `billing.settled`, `alert.triggered`, and `alert.resolved`.
- `PATCH /v1/webhooks/{id}`: update `{name?,url?,eventTypes?,enabled?,pending?}`. At least one subscription field is required. Changing an endpoint or event selection requires `pending: "cancel"`; all queued deliveries/retries are cancelled, including events still selected by the new configuration. Future events use the new configuration. An active delivery returns `409 webhook_delivery_in_flight` for endpoint/event edits; wait for it to finish or disable first. Name-only edits preserve queued work.
- `POST /v1/webhooks/{id}/rotate-secret`: replace and return the signing secret once.
- `GET /v1/webhook-deliveries`: latest 100 delivery records with attempt/status metadata, without receiver response bodies.
- `GET/PUT /v1/alerts/settings`: read or replace alert settings.
- `GET /v1/alerts`: latest 100 condition states and transition metadata.

Destinations must resolve exclusively to public HTTPS addresses on port 443. Every delivery resolves again, validates all answers and pins its connection to a validated address. No redirects are followed. Local/private, link-local, mapped, transition and reserved addresses are rejected. Credential-bearing URL user information and fragments are rejected.

Disabling cancels queued work and stops retry bookkeeping for an in-flight request. It cannot recall HTTP that has already started; a receiver may still accept that request. Re-enabling affects future events and never revives cancelled deliveries. The change/claim paths serialize on the subscription; events are never silently rerouted to an edited URL.

For example, this explicitly cancels old queued deliveries before selecting future billing events:

```json
{
  "url": "https://hooks.example.com/billing",
  "eventTypes": ["billing.settled"],
  "pending": "cancel"
}
```

## Receiving an event

The raw JSON envelope contains `id`, `type`, `createdAt` and `data`. Job events contain IDs/status/cost metadata; prompts, credentials and signed output URLs are excluded. Fetch the authenticated job separately for its outputs. `generation.completed` is a terminal generation outcome; `billing.settled` is a distinct money transition and may arrive before or after it. A succeeded upstream generation does not itself establish delivery success or final billing.

Headers are `OpenGen-Event-Id`, `OpenGen-Event-Timestamp` (Unix seconds) and `OpenGen-Signature` (`v1=` plus lowercase hex). Compute HMAC-SHA256 with the **literal signing-secret string** as key over:

```text
{timestamp}.{event-id}.{exact raw UTF-8 request body}
```

Compare equal-length digests in constant time before parsing/using the payload. Require a fresh timestamp, for example a five-minute tolerance, and confirm the envelope/header IDs match. Persist deduplication by event ID transactionally with your business side effect. Parsing and reserializing JSON before checking the signature changes the signed bytes.

Deliveries are at least once. A receiver timeout may happen after it accepted the event. Retries keep the event ID/body, generate a fresh timestamp/signature and stop after eight attempts. Delays are 30 seconds, 2 minutes, 10 minutes, 30 minutes, 2 hours, 6 hours and 24 hours. Redirects and all non-2xx responses are unsuccessful acknowledgements. A worker crash recovers a leased delivery without duplicating the event record. History stores only an HTTP status or redacted error code; response content is discarded and bounded to 8 KiB.

After secret rotation, queued attempts use the new secret. A request already claimed may still use the prior secret; coordinate a short receiver grace period before dropping it. The webhook API does not offer automatic historical replay, SMS delivery or exactly-once processing.

## Alerts

Replace settings with `enabled`, nullable `lowBalanceMicros`, nullable `spendingLimitMicros`, nullable `keyExpiryHours` (1–720), and `webhookFailures`. Amounts are integer micro-USD. Spending observes settled charges in a rolling 24-hour window; it is an alert, not a spending authorization limit. Configure key/request policies for enforcement.

The worker scans at most once a minute. Persisted state emits `alert.triggered` only on a newly active condition and `alert.resolved` when it clears, including disabled conditions. Expired keys stay active until revoked. A webhook failure condition reflects the latest delivered/dead non-alert job event for an enabled subscription, preventing recursively failing alert notifications from generating more alerts. State details record the transition snapshot rather than a live balance dashboard.

Per-member in-app notifications reuse these persisted alert transition events; see [notification behavior](operations/notifications.md). Optional email defaults off and requires a configured relay, a current verified recipient from signed OIDC claims and that member's explicit opt-in; see the [operational email runbook](operations/EMAIL-NOTIFICATIONS.md). Source fixtures send no real mail and do not qualify actual relay or inbox delivery. Live destination delivery, operator secret configuration and worker deployment still require deployment verification.
