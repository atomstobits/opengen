# Local CLI login and client binding

Evidence date: 2026-11-04. The portable CLI, generated skill and native Claude Code plugin are prepared as private release candidates. Offline installation and protocol/configuration fixtures are distinct from real third-party client qualification; see [AGENT-SUPPORT.md](AGENT-SUPPORT.md).

## Choose the connection

- **Already connected MCP:** use its tools and existing authorization. Reinstallation is unnecessary.
- **Remote MCP in an agent client:** add your configured deployment's `/mcp` URL, then complete that client's browser OAuth and paying-workspace consent. The CLI profile is never exported into client JSON.
- **Portable CLI:** obtain the reviewed versioned onboarding bundle and install it without a source checkout using the [checkout-free release instructions](CLI-PACKAGING.md#checkout-free-onboarding-bundle). Public distribution is pending release review. Node 22.12+ is required; no runtime npm dependencies or global install are needed.
- **Restricted egress:** transfer the reviewed bundle through the approved channel. Discovery, OAuth and signed media transfer still require access to the configured gateway, issuer and storage origins. Report the blocked origin; do not bypass network policy or add tokens to URLs.

There is no local stdio MCP server or `opengen mcp` command. The native plugin declares only the remote HTTP endpoint and generated skill. A source checkout remains an optional development path (`npm run cli --` in place of `opengen`).

A usable deployment must expose MCP/OAuth metadata, registration, consent, token endpoints and authenticated native transport. Human sign-in requires configured identity. A configuration write or metadata response does not establish that service is operational.

## Login and diagnose

After installation, use the executable's full path or add its `bin` directory to PATH:

```sh
export MEDIA_ROUTER_URL=https://your-opengen.example
opengen doctor
opengen login
opengen doctor
opengen catalog search "image"
opengen balance
```

Bare `opengen`, `status` and `doctor` run read-only diagnosis. They distinguish locally configured credentials from authenticated and authorized access, and report the paying workspace, available account identity, scopes, balance, executable routes and next blocker. An API key may have no human identity. Environment credentials must pass the same server check; their presence alone never means connected.

The consent screen shows the client, permissions and paying workspace. A new account/workspace starts unfunded. `generate` scope permits billable submissions subject to funds/policy; installation/login/discovery is not spending authorization.

Tokens stay in a private `0600` profile at `$XDG_CONFIG_HOME/opengen/auth.json` or `~/.config/opengen/auth.json`, refreshed under an exclusive lock. The profile must remain outside Git and is not a setup snippet. `MEDIA_ROUTER_TOKEN` explicitly overrides it; there is no token argv flag. Never copy browser cookies, installation tokens or provider secrets into client configuration.

```sh
opengen logout
```

Logout revokes the CLI's remote authorization before removing its profile. If revocation fails, retain it and retry. Independent MCP client grants must be revoked separately through connected-app controls.

## Preview and apply client binding

The dispatcher is integrated: use `opengen bind`. Choose an explicit absolute destination in your project. Preview writes no files and returns only the proposed OpenGen entry, action and fingerprint, without unrelated settings or credentials:

```sh
opengen bind preview --client cursor \
  --config /absolute/path/to/project/.cursor/mcp.json \
  --url https://your-opengen.example

opengen bind preview --client claude-code \
  --config /absolute/path/to/project/.mcp.json \
  --url https://your-opengen.example
```

Claude Code receives `{"type":"http","url":"https://your-opengen.example/mcp"}`; Cursor receives `{"url":"https://your-opengen.example/mcp"}`. Review the destination and endpoint, then apply the same options with the returned fingerprint:

```sh
opengen bind apply --client cursor \
  --config /absolute/path/to/project/.cursor/mcp.json \
  --url https://your-opengen.example \
  --preview-id PREVIEW_ID_FROM_PREVIEW
```

The fingerprint binds destination, client, URL, replacement choice and exact old file bytes. Re-preview after any change. Replacing a different OpenGen entry requires `--replace` in both commands; this replaces only that entry, removing stale headers. Other JSON values remain intact. New directories use `0700`; files are replaced atomically as `0600`. Existing directory permissions are retained. An advisory lock serializes helper updates, but third-party editors do not honor it: stop configuration editing during apply.

The helper refuses symlinks/parent symlinks, files over 1 MB, non-regular files, JSONC, trailing commas and TOML. Use real absolute paths, including canonical temporary-directory paths. It does not guess a global destination or install a client.

Open the client's MCP settings and follow its own OAuth flow. In Claude Code, approve the project server and use `/mcp` to authenticate. In Cursor, review the server in settings and connect. Exact client version, callback, consent, tool use, refresh and revocation need a real test. Current Cursor documentation includes `localhost` and hosted callbacks; OpenGen accepts HTTPS and literal HTTP loopback redirects. A client choosing another callback may be blocked. Record it; never weaken redirect validation or insert a bearer header to bypass OAuth.

Codex uses its own MCP commands/TOML; hosted assistants use connector settings. Those formats are not edited by the JSON binding helper. See the [agent setup pages](../apps/web/app/agents) and [support matrix](AGENT-SUPPORT.md).

## Native Claude Code plugin

The bundle optionally installs a local plugin directory via `--plugin-dir /absolute/new/opengen-plugin`. It includes `.claude-plugin/plugin.json`, the same generated skill and a URL-only HTTP MCP declaration; no hooks, binaries, token headers or auto-installer are included. The prepared manifest points to `https://opengen.dev/mcp`; use explicit CLI binding for a different deployment rather than silently connecting to the public origin.

After reviewing that endpoint and files, load the local directory using Claude Code's documented `--plugin-dir /absolute/path/opengen-plugin`, then authenticate the OpenGen server in `/mcp`. No marketplace listing is published. Manifest/source validation is not real-client interoperability evidence. See [official plugin manifest reference](https://code.claude.com/docs/en/plugins-reference) and [remote MCP/OAuth documentation](https://code.claude.com/docs/en/mcp), reviewed 2026-11-04.

## Recovery and validation

`opengen bind status --url https://your-opengen.example` reads private profile metadata; it does not send the profile to a different origin. For full authenticated diagnosis use `opengen doctor`. A stale profile/binding lock requires first verifying no OpenGen process is active; never bypass refresh-reuse checks or loosen profile permissions.

For generation, save the original request and idempotency key before submission and keep the private receipt and returned job ID. Resume with the exact command printed in structured error metadata. If no job ID arrived, `opengen job recover --idempotency-key SAVED_KEY` performs lookup without submitting. A local timeout or unknown provider acceptance does not authorize replacement generation.

`tests/local-bindings.test.ts` exercises isolated preview/apply and safe profile metadata. `tests/cli-login.test.ts` covers PKCE/profile/refresh/logout fixtures. `tests/onboarding-distribution.test.ts` installs CLI/skill/plugin offline outside a checkout and checks tamper/overwrite refusal. None provisions identity or submits paid provider work. [CLI packaging evidence](CLI-PACKAGING.md) documents the reproducible artifacts.
