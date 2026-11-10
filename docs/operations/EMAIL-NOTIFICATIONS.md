# Optional operational email notifications

This module sends a minimal notice for the existing `alert.triggered` and `alert.resolved` outbox events. It does not create another event system or send invitations, generation results, prompts, media, key information, balances or arbitrary event payloads. All records are private to their workspace/member. The source and fixtures are not proof of a configured or delivered real email.

Email remains unavailable unless an operator configures a fixed relay, a currently accepted workspace member has an address verified by the server's signed identity provider, and that member explicitly opts in. No address is guessed from an OIDC subject, API-key name, invitation or request body. In-app preferences and email opt-in remain separate; both use the member's selected existing alert event types.

## Runtime configuration and relay contract

The operator may supply `NotificationEmailConfiguration` directly, or use `notificationEmailConfiguration(env)` with:

- `OPENGEN_NOTIFICATION_EMAIL_ENDPOINT`: fixed public HTTPS relay endpoint on port443, without credentials, query parameters or fragments.
- `OPENGEN_PUBLIC_URL`: the public HTTPS application origin. Every notice links only to `/app#activity`; it carries no token or signed capability and requires the recipient to sign in.
- `OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN`: optional server-only bearer credential, sent in a header.
- `OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED=1`: set only after the operator has qualified the relay's durable idempotency contract. A repeated delivery ID with the same body must produce at most one real email, including lost responses and concurrent requests. A name or HTTP header alone does not establish this behavior.

Without endpoint configuration, capability reports `emailAvailable:false` and the worker performs no transport request. A configured relay is not a live delivery claim. Sender account, domain/SPF/DKIM/DMARC, recipient policy, inbox acceptance and operating cost remain separately configured/qualified. This source provisions no provider and sends no real test mail.

The relay receives a closed JSON object containing `deliveryId`, verified `to`, constant `subject`, constant plain `text`, `appUrl` and the allowlisted `eventType`. It receives `Idempotency-Key: <deliveryId>` and the optional Authorization header. The default HTTP transport reuses the existing DNS-pinned public HTTPS sender: every request resolves public addresses, validates TLS, rejects redirects, uses a ten-second bound and discards the bounded response body. Members cannot choose a relay URL or insert subject/body/payload fields. The HTTP transport independently reconstructs the closed template.

A 2xx response means **relay accepted**, represented internally as `sent`; it does not prove inbox delivery. The documented relay must reject 3xx/4xx without accepting mail;429 schedules bounded retry. A timeout, disconnected/failed request, malformed response or 5xx is **unknown acceptance**. Unknown work is retried only when durable relay idempotency was explicitly confirmed, always with the original delivery ID and exact message. Otherwise it remains `unknown` for operator reconciliation. Expired sender leases have the same conservative semantics. Retry exhaustion does not turn an unknown send into proof of nondelivery.

The endpoint/auth/application configuration has a private fingerprint frozen with each delivery. Changing that fingerprint never silently sends old work through another relay/account: never-attempted work is cancelled; attempted work remains unknown. Secret rotation therefore needs an explicit operating plan for pending/unknown requests. Do not manually replay an unknown request through a different endpoint without establishing what happened at the original relay.

## Verified identity and consent

The authentication owner calls `notificationEmailIdentityFromVerifiedOidcClaims(claims)` **only after** the OIDC/JWT library verifies signature, issuer, audience, nonce and its normal authentication requirements. The signed `email_verified` claim must be boolean `true`, with a valid supported address and issuer/subject. The function creates an internal Symbol-branded identity; a JSON object with `verified:true` cannot substitute for it.

The sign-in producer enumerates only the freshly authenticated identity's currently accepted memberships and records/clears each one; `identity()` alone selects a personal workspace and cannot establish team recipients. A newly accepted membership needs a fresh email-scoped sign-in before email becomes available.

`recordVerifiedRecipient(actor, identity)` rechecks active accepted membership and its exact issuer/subject, records the private verified address and resets consent when that address changes. It is an internal authentication producer hook, never a caller-writable verification API. A fresh, trusted, email-scoped identity response which loses verification calls `clearVerifiedRecipient(actor)`; the service must not fall back to an old verified address. Do not treat omission in an arbitrary bearer token without email scope as a fresh email-verification result.

`setEmailOptIn(actor,true)` requires configured delivery and that member's verified recipient. Opt-in uses the database clock after its preference lock and is bound to the recipient revision. Only later existing alert events are eligible; enabling email does not backfill historical alerts. Repeated enablement preserves the original consent time. Recipient changes require fresh explicit opt-in. `false` always disables future work and cancels queued/retrying delivery bookkeeping.

The worker checks current membership, consent, selected event types, recipient revision and frozen transport before claiming and immediately before outbound. It holds no database transaction during HTTP. Disabling email, changing recipient or removing membership cancels pending work. An already claimed/sent request can still arrive; cancellation is not a recall or a proof of nondelivery. A late response cannot revive cancelled work. Unique `(event_id,membership_id)` prevents the same alert from being rerouted or resent to a new address after consent changes.

## Integration checkpoint

The existing explicit migration loader owns the full `001.sql`–`021.sql` sequence and applies pending migrations in order. Registered migration `021.sql` adds private recipients, consent and durable email delivery state over the alert events and member preferences established by earlier migrations, including `018.sql`. Old rows remain opted out; no verification or consent is backfilled. Never apply the schema proposal manually or edit/reuse an applied migration version. Follow the [hosted core activation gate](../CORE-HOSTED-ACTIVATION.md) for the actual current-core upgrade and qualification.

The engine already constructs `NotificationEmailStore` and connects it to `NotificationStore`; the bounded worker loop invokes `workOnce()` alongside event delivery and alert scanning. It stages committed eligible events and claims at most one email per call. Configuration remains server-only, and the optional trusted transport injection supports deterministic fixtures. There is no generation submit, money settlement or provider inference dependency.

Preferences already use `getEmailOptInInTransaction(client,actor)` and `setEmailOptInInTransaction(client,actor,input.email)` on the same client, avoiding a nested pool checkout. The strict shared schema accepts optional boolean `email` and no caller-supplied recipient or verification fields; omission preserves consent. Member/read authorization and no-store caching remain enforced. The mounted member-only checkbox shows that member's verified recipient and is enabled only for `emailAvailable:true`. Operators must configure a trusted relay, and a currently accepted member must have a verified recipient and explicitly opt in. Defaults remain off; missing configuration or recipient keeps the control disabled. Actual relay and inbox delivery remain separately unqualified by source fixtures.

Private email/history retention durations are an operator policy; this source makes no hosted retention promise and performs no real-data deletion. Delivery records contain private destination/operational receipt state for deduplication and audit; they do not contain arbitrary event data, transport response bodies or auth credentials. Unknown outcomes must survive operational cleanup until reconciled.

## Meaningful qualification and manual plan

The focused tests use injected transports and synthetic addresses. They exercise actual PostgreSQL-compatible SQL for consent, strict verification, changed/removed members, per-member deduplication, recipient changes, cancellation during a claimed request, stable retries, unknown acceptance, expired leases, frozen relay identity and closed content. Native CI additionally runs multi-connection concurrent fan-out/claim proof. PGlite is not native concurrency or real mail proof.

After integrating the exact candidate, run the focused suite on native PostgreSQL and verify populated migration/restore. In the browser, sign in through the reviewed verified-email identity path, confirm recipient/availability, opt in and out, and switch workspace/member while reads are delayed. Confirm old queued events do not backfill or reroute, and in-app preferences remain independent. Only an independently authorized configured test may send real mail; this implementation and its fixtures do not authorize that action.
