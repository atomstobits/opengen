# Claude hosted connector qualification — 2026-11-04

Status: **actual client preflight attempted; OpenGen authorization and tool use not yet qualified**.

The native About dialog identifies **Claude for Mac 4.4212.0 (cbfe3c)**. The app was already signed in. Its Customize → Connectors interface exposes Add connector → Add custom connector. No application update, existing connector change or conversation modification was performed.

Remote connectors on this desktop surface are brokered through Anthropic's cloud, according to the [current official custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp). A local CLI installation cannot make a private laptop endpoint reachable through that hosted connector.

## Observed client behavior

The unsaved test connector is named `OpenGen qualification 2026-11-04` and targets the public, credential-free URL `https://opengen.dev/mcp`.

| Check                         | Actual observation                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| Remote server preflight       | **HTTP 404 — Not found**, returned in Claude's own connector dialog                  |
| Looking up sign-in settings   | Skipped after the server check failed                                                |
| Checking sign-in provider     | Skipped after the server check failed                                                |
| Authentication choices        | Sign in now; Sign in when needed; No sign-in                                         |
| OAuth identity choices        | Published identity/CIMD (default); Register automatically/DCR; Own registered client |
| Transport choices             | Streamable HTTP (selected); SSE legacy                                               |
| Prepared choice               | Sign in now, Register automatically/DCR, Streamable HTTP, no request headers         |
| Saved connector / OAuth grant | Neither performed                                                                    |
| Chat prompt / paid generation | Neither sent                                                                         |

OpenGen advertises dynamic registration and does not advertise CIMD. Therefore use **Register automatically** in this client. The live UI's default published-identity choice is not evidence that OpenGen supports it. Current official [connector instructions](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities) document these configuration choices; source implementation and actual authorization remain separate evidence.

The form was left at Step 2 without clicking Add. No API/provider key, bearer header, client secret or private profile data was entered.

## Remaining qualification

The 404 is a concrete public-endpoint blocker at observation time, not an OAuth success or an unsupported-client verdict. Once the public deployment exposes MCP and its authorization metadata, return to Step 1 and repeat Claude's check. Then open the connector's OAuth flow and inspect its exact permissions and paying workspace before granting new access.

A new security-sensitive grant requires action-time user confirmation under the native-computer-use policy. No such grant has been accepted in this inspection. A saved URL or successful metadata lookup would still leave discovery, owned upload, schema inspection, quote, explicitly authorized submission, wait/resume, private retrieval, refresh and revocation unproven. Any later synthetic Claude prompt or generation test needs its own authorized test scope; this inspection sent neither.

Record actual step outcomes and exact deployment/client version when continuing. Do not turn this partial preflight or source/transport fixtures into a completed hosted-client journey.
