# Future OpenAI plugin submission

Checked 2026-11-03 against official OpenAI documentation. This is a planned review track, not an application, approval or live-compatibility claim. The open-source release and public directory submission have separate acceptance gates.

## First resolve product eligibility

OpenAI's [plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines) restrict unofficial third-party connectors and pass-through intermediary layers. OpenGen's router/reseller business needs an explicit eligibility assessment, authorized provider integrations and an accurate demonstration of its independent functionality. API access or source links alone do not establish public-directory eligibility. Resolve uncertainty with OpenAI before making approval a launch dependency.

The same guidelines prohibit digital-goods/credit/subscription sales and upgrade checkout through plugins. Existing paid-account features may be used, but OpenGen's prepaid, per-generation model needs a specific review interpretation. The plugin profile must exclude top-up, checkout and upgrade flows; do not treat an external checkout link as a workaround. This does not require removing website billing.

## Authentication and public tool profile

The [MCP authentication guide](https://developers.openai.com/plugins/build/auth) explicitly includes Auth0 and recommends established identity providers. Auth0 remains a hosted-sign-in candidate. Preserve the separation between human OIDC login, OpenGen sessions and workspace-bound MCP authorization; human-login credentials are not connector credentials. Validate the selected hosted authorization arrangement end to end before freezing it.

Current code has discovery, DCR, S256 PKCE, resource/workspace-bound grants, refresh/revocation and pending-consent recovery. It is fixture-backed. DCR remains supported; CIMD and issuer-response identification are compatibility improvements to evaluate, not assumed mandatory blockers. Never advertise issuer-response support before returning the matching issuer on success and error callbacks.

Before submission, add explicit tool auth/side-effect metadata and tool-level auth challenges. Prepare a narrow public plugin tool/schema profile for catalog, schema inspection, quote, generation, owned jobs and cancellation. Keep credential entry, key/member administration, operator funding and checkout out of that profile. The general private API/MCP can retain its authorized operations. Optional stable-profile discovery should use a persisted opaque identity, not email or a token/grant ID. These changes are planned, not implemented by this research update.

## Review deployment and evidence

The [remote-server review requirements](https://developers.openai.com/plugins/deploy/app-review) call for a reachable production MCP endpoint and a working review account that needs no additional setup or one-time verification. Prepare an isolated review workspace, synthetic data and separately approved test entitlements. Preserve normal customer security policies. Localhost, protocol fixtures and a provider choice are insufficient review evidence.

The [submission guide](https://developers.openai.com/plugins/deploy/submission) specifies publisher verification, domain verification, website/support/privacy/terms URLs, five positive cases, three negative cases and a walkthrough. Capture actual ChatGPT desktop/mobile results, including asynchronous media recovery, refusal cases and account switching. Enter reviewer credentials privately in the portal; keep client secrets and tokens out of the package. Recheck the current package/schema requirements immediately before submission.

Privacy disclosures must accurately cover prompts/media, downstream providers, retention and user controls. Do not invent provider permissions, processing residency or deletion guarantees. Public listing and publishing remain explicit later actions.

## Optional ChatGPT identity sign-in

[Sign in with ChatGPT for plugins](https://developers.openai.com/siwc/chatgpt-plugin) is currently a limited commercial-partner trial. It is optional and distinct from authorizing ChatGPT to call OpenGen. Preserve independent transactions and verified account linking if added. Identity linking does not grant funding for third-party generation.
