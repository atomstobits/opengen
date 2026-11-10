# Support, privacy requests and incident handling

Candidate operator procedure, 9 November 2026. This document describes a manual workflow to adopt and operate; it is not evidence that a particular request, deletion, notification or refund has been completed. It creates no new application endpoint or automatic response service. Self-hosting operators replace the hosted contacts and record their own staffing, contracts and deployed controls.

For hosted OpenGen, use **support@opengen.dev** for access, generation and payment support, and **legal@opengen.dev** for privacy requests, rights/content complaints and sensitive security reports. A requester need not have an account to report that a generation affects their rights. Do not ask someone to publish private media, credentials or exploit details in an issue. Ordinary reproducible bugs can use a public issue only after removing private information.

## 1. Operator readiness

Before representing this process as staffed, record privately who monitors both inboxes, the primary and backup support/privacy/security/billing roles, the escalation method, monitoring hours, deployed retention settings and applicable contractual/legal deadlines. One person may hold more than one role; the record identifies the actual responsible people without publishing their personal details. Confirm mailbox access and a non-sensitive intake rehearsal. Do not infer monitoring or delivery from DNS alone.

Keep the readiness record and individual case files outside Git, source archives and public issue/CI systems. This public runbook contains no real contacts beyond the chosen service inboxes, customer identifiers, secrets or case evidence. Where staffing or a required procedure is unconfirmed, record it as pending rather than claim coverage, a response-time SLA or round-the-clock support.

## 2. Intake and triage

Create one private case reference and record: receipt time, request type, safe contact, requested scope, responsible role, identity/authority status, applicable response deadline, next update, actions/evidence references, decision and closure. Link related support, security and billing cases without duplicating sensitive attachments. Ask for existing workspace/order/job references if available; help locate records when the requester lacks them. Never request a password, live API/OAuth token, full card/bank number or unnecessary identity document.

Proposed internal targets are acknowledgement within one business day and initial scope/deadline triage within two business days. They require an actually staffed process and owner adoption; they are not a new public SLA. Suspected compromise, exposed private media or imminent harm requires immediate escalation when discovered, not the routine queue. Any earlier legal or agreed customer deadline controls.

At triage, classify the request as ordinary support, privacy access/correction/export/deletion/restriction/objection, authorized-agent request, security incident, rights/content complaint or billing/refund. Route mistakes internally; do not make the customer restart a timely request. Record whether OpenGen acts for its own account/security/billing purposes or on a business customer's instructions for the affected processing.

## 3. Proportionate verification

Use existing authenticated access or another independently verified account contact where appropriate. Do not trust a newly supplied email, screenshot or guessed identifier by itself for sensitive disclosure or destructive action. Verification must be proportionate to the action and reveal no additional data before it succeeds. Information collected solely for verification stays limited to that purpose and follows the case's minimal retention plan.

A representative supplies reasonable evidence of their authority; confirm with the person through an existing trusted channel when appropriate. An API scope or agent Generate grant is not general authority to exercise another person's privacy rights or redirect a refund. Workspace administration also does not automatically authorize disclosure of every member's personal information.

For a non-user depicted or named in submitted material, collect only enough information to identify the concern and investigate safely. Do not require ownership of the uploading workspace. For an opt-out or objection that law permits without identity verification, do not add a verification barrier. If optional advertising or a covered signal is not used in the deployed service, explain the actual scope rather than invent a preference switch.

## 4. Rights, export, deletion and restrictions

For access/export, define the person and data scope first. Existing workspace-authorized activity and ledger reads/exports can assist; they are not a complete personal-data export. A reviewed manual export may also be needed. Exclude other people's data, secret values, internal bearer URLs and unrelated records; explain lawful limitations. Deliver only to the verified recipient through an authorized private channel. A failed export does not justify a privileged token, public bucket or public issue attachment.

For correction, identify the source of the fact. Use a supported update where one exists, or prepare a narrowly scoped reviewed correction. An identity-provider record or independently controlled provider record may need action there. Correcting an error does not permit rewriting immutable financial history; record the appropriate audited adjustment separately.

For deletion/restriction, agree the requested scope and consequences, and reconfirm a destructive account/workspace instruction through a trusted channel. Individual rights, organization authority and other members' legitimate access are assessed separately. Do not assume that removing one membership deletes a workspace, that logout erases data, or that disconnecting a provider revokes the upstream key.

Reuse existing authorized key/grant revocation, membership, connection and owned-asset operations where applicable. Asset deletion tombstones new reads/admission; accepted-job pins may retain necessary bytes until safe cleanup. Already issued bearer capabilities, client downloads, provider copies and storage backup/soft-delete windows require separate handling. Do not remove pins or fabricate cancellation merely to claim physical erasure.

The current source has no complete self-service account/workspace erasure or complete privacy-export job. A request beyond supported operations requires a scoped, reviewed manual action plan with readback evidence. Preserve only records lawfully needed for accepted work, unknown supplier cost, replay-safe accounting, fraud/legal claims or valid retention obligations; restrict them to those purposes. Record the reason, scope and next review date. A financial hold does not justify keeping every unrelated prompt or image forever.

Coordinate downstream instructions with applicable processors and the business customer where OpenGen acts on its instructions. Independently controlled providers receive their own requests where appropriate. Do not claim every supplier deleted data because OpenGen removed its copy. If a backup is restored, reapply unresolved deletion/restriction records before normal access resumes. The [asset privacy contract](ASSET-PRIVACY.md) and deployed configuration govern technical retention; this runbook supplies no universal retention period.

## 5. Deadlines, decisions and appeals

Calendar the deadline under the law and actual agreement that apply to the specific request. Do not substitute a competitor's 30/45-day rule for that assessment, reset the original receipt time, or assume verification pauses the clock. Set internal checkpoints early enough to act. If a lawful extension is needed, give the required explanation and revised deadline within the original notice period. The proposed acknowledgement target does not replace a substantive response deadline.

Respond with what was done, what remains and why; explain any partial refusal or retained-data exception, the applicable review/retention period, how to appeal by replying or contacting legal@opengen.dev, and the appropriate external complaint route where applicable. Do not require a person to waive a regulator complaint or consumer remedy to obtain support. An appeal receives a fresh recorded review by a different available reviewer where practical, without requiring an account or charging a routine request fee. Escalate missed deadlines and unresolved exceptions to the responsible legal/privacy role, retain the next update date and keep the requester informed.

## 6. Security and personal-data incidents

Use [SECURITY.md](../SECURITY.md) and [OPERATIONS.md](OPERATIONS.md) for secrets, recovery, access and deployment boundaries. Record discovery and legally relevant awareness times, the affected environment, known scope, evidence sources, containment owner and next update. Preserve minimal restricted evidence without logging credentials, private prompts/media, provider bodies or signed URLs.

Contain using the actual authorized controls: revoke affected OpenGen keys/grants, secure compromised sessions or memberships, rotate/revoke the relevant upstream credential and update its runtime reference through the established maintenance procedure. Scope any admission fence to the risk; preserve original accepted task IDs, ledger and unknown-acceptance records so recovery cannot create another paid submission. Do not delete evidence, blindly replay jobs or erase money records as incident cleanup.

The security/privacy role assesses affected people, processing roles, risk, executed customer contracts and relevant notification obligations. Record each recipient, legal/contract basis and deadline independently. Notify the business customer, affected person or regulator when required, with known facts and later updates; do not wait for every forensic detail if the applicable deadline requires an earlier notice. A competitor's contractual 72-hour promise is not evidence OpenGen has adopted one, and regulator and customer notice clocks may differ. No certification or guaranteed immunity is implied.

After containment, verify the affected access path is closed, reconcile ongoing accepted work, restore only a reviewed version/data state, document cause and corrective actions, and review whether unrelated private data can be removed from the case. Public communications use redacted information and an authorized decision; sensitive incident details never go into a public bug report by default.

## 7. Refunds and payment complaints

Route payments to the existing [payment runbook](PAYMENTS.md) and the adopted credit/refund policy. Record a timely refund/withdrawal request when received; do not delay that timestamp until ownership verification finishes. Verify original payment, payer/workspace authority, eligible unspent amount, accepted reservations, previous returns, statutory rights and the relevant processor state before any financial action.

This procedure does not authorize a charge, cash refund, refund destination change, credit grant, ledger debit or hold release. Existing signed-event holds are not themselves refund issuance or a wallet reversal. Staff must use the reviewed refund/earmark/reconciliation implementation actually admitted for the deployment; if unavailable, escalate that operational gap rather than issue cash first or use generic hold resolution to simulate a debit. Preserve the original immutable records and references, and never make a new provider generation to investigate a refund.

## 8. Source-supported mechanisms and adoption record

Source inspection confirms scoped key and OAuth-grant revocation, current-session logout, membership removal, provider-connection deletion, workspace activity reads, paginated ledger export and owned-asset tombstoning with pin-aware cleanup. Their authorization requirements remain in force; this runbook does not grant an operator or support worker broader access. It does not establish hosted rollout or a completed request.

Still requiring an actual operator record: staffed inbox/backup coverage, applicable deadline and incident decisions, secure case/evidence storage and retention, reviewed manual full-export/account-erasure procedure, customer/provider coordination, and deployment-qualified financial adjustments. Do not represent those items as already executed merely because this file exists.

## Reference mechanisms

- [fal Privacy: access, correction, deletion, appeals and authorized agents](https://fal.ai/legal/privacy-policy): email intake, proportionate identity checks, representative authorization and reply-to-denial appeals.
- [Higgsfield Privacy §§11.6 and 15](https://higgsfield.ai/privacy-policy): request/extension communication, representative checks and external complaint information. Its regional deadlines are contextual examples, not OpenGen's universal clock.
- [OpenRouter Privacy: accuracy and deletion](https://openrouter.ai/privacy): trusted account confirmation and retained-record exceptions; its [DPA §7](https://openrouter.ai/data-processing-agreement) illustrates a separate contractual incident clock. Its [support page](https://openrouter.ai/support/) gives billing/account entry points.
- [treg Support](https://treg.to/support) separates private security reports from public bugs and distinguishes an aspirational response target from an SLA. [treg Privacy §§9–10](https://treg.to/privacy) separates live-system deletion and backups and offers email rights handling.
- [Higgsfield refund help](https://higgsfield.ai/creator-hub/help-center/refunds/how-do-i-request-a-refund) illustrates useful intake fields and a bank-timing explanation; OpenGen's own adopted financial rules control eligibility and fees.

References were read on 9 November 2026. This is original process text adapted to current OpenGen capabilities; it copies no competitor clause and adopts none of their differing products, tracking or broad data-use rights.
