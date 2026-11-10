# Hosted policy adoption and acceptance

This is a launch procedure, not evidence that OpenGen's proposed policies are effective or accepted. It covers hosted Terms, Privacy, prepaid-credit/refunds and any separately incorporated customer DPA. Independent self-hosting operators adopt their own operator details and applicable arrangements; the software license remains separate.

## Freeze and adopt the actual policy set

1. Identify the operator, verified public business/trader notice address and working legal/support contacts. Complete location-specific precontract information where required. Another company's address, an email-only precedent or an unverified registered-agent listing cannot supply the operator's actual details.
2. Review the exact Terms, credit/refund and Privacy bodies together. Record their version identifiers, full-text digests, effective dates, approving authority and any applicable preceding version/notice period. Keep an immutable copy outside ordinary mutable website content. A review date is not an effective date.
3. Verify the deployed facts and the applicable supplier/customer arrangements using [the provider review](PROVIDER-PRIVACY-REVIEW.md). A public DPA URL is not evidence of its incorporation into a particular account. Complete a customer DPA only for the agreed covered service and actually authorized chain.
4. Complete the private role, inbox, case-storage and rehearsal record in [Privacy Operations](PRIVACY-OPERATIONS.md). Confirm the admitted payment/refund procedure separately; policy copy cannot enable a financial operation.
5. Before activating per-identity Terms receipts, approve and qualify the scoped retention/disposition plan described in [IDENTITY-TERMS.md](IDENTITY-TERMS.md). The immutable029 table has no TTL or account-deletion path. Review actual retention criteria, restricted access, preservation/rights handling and a lawful disposition/correction mechanism; policy wording or a configured period does not supply that mechanism.
6. Publish only the adopted versions and their actual effective dates, with working Terms/Privacy/refund links in account entry, payment and documentation paths. Preserve access to relevant preceding versions and give required change notices. Do not remove a Draft/not-effective label while the adoption record is incomplete.

Use a small private release record, not a new general policy engine. It should contain the operator/address evidence reference; policy versions/digests/effective dates; authorized adoption decision; exact source/deployment reference; acceptance-notice wording; actual supplier/transfer scope; responsible support/privacy/security/billing roles; and rehearsal/activation evidence. No customer records, credentials or private generations belong in the source repository.

## A clear acceptance entry across browser and agents

The existing browser entry is `GatewayAccess` → `/auth/login` → OIDC callback. MCP login can also reach that server entry after saving the pending consent request. A frontend-only notice would not cover a direct backend or MCP entry.

For adopted policies, use the same `/auth/login` entry for a short clearly linked notice and a Continue-to-Google action. Show the identified active Terms and a separate Privacy Notice, plus the relevant age/authority statement. A suitable copy pattern is: “By continuing, you agree to the OpenGen Terms shown here and confirm you meet the eligibility requirements. Read our Privacy Notice for how information is handled.” The actual linked version, effective date and surrounding presentation must be reviewed together before use. A generic statement must not purport to accept unidentified future versions or an unfinished DPA.

Keep the existing signed PKCE/state/nonce transaction, callback validation and pending MCP return. Select policy identifiers on the server. Do not trust an arbitrary client-supplied version, reuse workspace invitation `accepted_at` as contract acceptance, or treat an OAuth grant as agreement by the account holder or organization.

If durable per-identity acceptance evidence is recorded, make that a bounded identity-owner change: actual authenticated identity, identified policy version/digest, presented notice/action and timestamp, with a defined retention purpose. Record only what is needed; avoid extra IP/device data by default. Complete the record only for a successful verified flow. A temporary login cookie is not a claim that a durable receipt already exists. No public assertion is made here about a competitor's internal database.

Keep four decisions distinct: Terms acceptance; privacy information and any genuinely necessary optional consent; agent scopes/workspace spending authority; and a payer's specific funding approval. A Continue action does not create an automatic card mandate, extinguish a statutory withdrawal right, execute transfer safeguards or confer authority the person does not possess.

## Focused acceptance checks

- Browser, direct login, MCP and local-agent entry reach the same identified notice; pending OAuth return is preserved.
- Draft or future policies are not represented as currently binding. Published metadata and linked HTML/Markdown identify the same adopted copy.
- Cross-origin/forged initiation, stale policy identifiers, failed callbacks and cancelled login cannot mint an acceptance receipt or bypass existing OIDC checks.
- Existing accepted jobs and lawful support/refund rights are not silently lost during a policy change. Read/Generate grants and manual payment authorization keep their existing meanings.
- Never perform a paid generation or payment as an acceptance UI test. Use synthetic identities and disposable local fixtures for software checks; qualify hosted identity separately.

The source candidate now implements the bounded notice/Continue and immutable receipt mechanism described in [IDENTITY-TERMS.md](IDENTITY-TERMS.md). Its current policy remains draft/inactive and produces no Terms receipt. Source fixtures do not establish customer acceptance, policy adoption or hosted activation.

## Reference patterns checked on 9 November 2026

[fal](https://fal.ai/legal/terms-of-service) uses acceptance-by-use/checking language; its anonymous login places linked Terms/Privacy notice near Continue buttons without a checkbox. [OpenRouter](https://openrouter.ai/terms) and [Higgsfield](https://higgsfield.ai/terms-of-use-agreement) display signup checkboxes in the inspected anonymous entries. [treg](https://treg.to/terms) treats account creation, sign-in or service calls as acceptance; its inspected sign-in modal has no checkbox or in-modal policy notice. These public observations support clear presentation choices, not a universal checkbox requirement or evidence of how they store acceptance.
