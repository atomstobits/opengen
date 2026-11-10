# Workspaces and team access

Every verified OpenID Connect identity receives a personal workspace with no managed credit. A browser user can create additional team workspaces; generations, credit, provider connections, keys and routing profiles belong to their selected workspace. Creating a team does not transfer funds or provider credentials.

In **Workspace → Settings**, create a workspace, accept an invitation or select an accepted workspace. Selection updates the opaque HttpOnly session and reloads the dashboard. An API key always remains bound to its issued workspace; a caller-supplied workspace header cannot change that boundary.

## Verified invitations

A teammate first signs in and copies their verified identity from workspace settings. An administrator invites that exact issuer/subject pair and selects a role. The recipient explicitly accepts the invitation before selecting the team. An email address or display name is never sufficient to claim an identity.

- A **member** can view workspace generations/usage and submit generations, subject to the workspace's available credit and the key's routing policy.
- An **administrator** can also manage workspace keys, routing profiles, provider connections, events and members. A scoped key cannot grant permissions it does not hold; a policy-constrained key cannot issue unrestricted invitations or credentials.
- A personal workspace owner cannot be removed or demoted. A team keeps at least one accepted administrator.

Member removal invalidates associated browser sessions and API keys. Reinviting the same identity does not reactivate old credentials. Role changes are checked on every key/session authentication; an old administrator browser session loses administrative permissions after demotion.

## HTTP operations

| Method         | Path                                | Purpose                                                                                                                         |
| -------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| GET            | `/v1/workspaces`                    | List a signed-in identity's memberships, or the current fixed-key workspace.                                                    |
| POST           | `/v1/teams`                         | Create an unfunded workspace from an unrestricted OIDC browser session or an explicitly enabled account-identified OAuth scope. |
| GET / POST     | `/v1/members`                       | List memberships or invite `{issuer, subject, role}`.                                                                           |
| PATCH / DELETE | `/v1/members/{id}`                  | Change `{role}` or remove access in the current workspace.                                                                      |
| POST           | `/v1/workspaces/{id}/accept-invite` | Accept the current verified identity's invitation.                                                                              |
| POST           | `/v1/session/workspace`             | Select `{workspaceId}` using the matching OIDC browser session.                                                                 |

Member administration requires `members:write`; ordinary member permissions remain `read` and `generate`. Bootstrap installation operators retain their existing operator-only funding/reconciliation authority. Team administrators do not become installation operators.

Browser session creation and workspace selection are HTTP identity flows. Agent applications use a separate scoped API key issued in the intended workspace. The key is returned once; store it in the agent's secret manager.

## Upgrade behavior

Keys issued before membership support remain fixed API credentials. Existing browser users sign in again to receive membership-bound browser sessions. The migration never infers browser authority from a key's display name: users can choose arbitrary names, including names resembling internal keys.

The OIDC issuer remains operator-configured, and no third-party identity provider is provisioned by this feature. Local fixture tests verify identity/workspace/scope boundaries; a deployed issuer's login, consent and redirect configuration needs its own verification.

A deployment may opt in to trusted-issuer OAuth `members:write` for agent-led team creation. It is disabled by default. This account-level authorization does not make workspace API keys portable or enable workspace switching through caller headers. The new team starts unfunded; obtain a separately scoped key in that workspace through the signed-in workspace onboarding flow.
