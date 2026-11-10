# OpenGen portable CLI

This is a locally built, private `opengen-cli` package. No npm namespace or published package is claimed. OpenGen code is Apache-2.0; bundled third-party notices are included. Node **22.12 or newer** is required. Node itself is not included.

Verify the archive's SHA-256 against the separately supplied `.tgz.sha256` file before local installation. Use an explicit private directory; no global install is needed:

```sh
npm install --prefix /absolute/private/opengen-client /absolute/path/opengen-cli-{{VERSION}}.tgz --ignore-scripts --no-audit --no-fund --offline
/absolute/private/opengen-client/node_modules/.bin/opengen --help
```

The package has no install scripts, runtime package dependencies, binary downloads or automatic client configuration writes. Its executable can also run directly after extraction:

```sh
node /absolute/path/package/bin/opengen.mjs --help
node /absolute/path/package/bin/opengen.mjs status
```

The reviewed onboarding release bundle also includes a checksum-verified offline Node installer, the generated installable skill and a token-free Claude Code plugin. See the release bundle instructions for the checkout-free installation path. No public downloads are available until release review.

Set `MEDIA_ROUTER_URL` to your configured OpenGen gateway. Sign in through `opengen login`, review the permissions and paying workspace in your browser, then use catalog discovery and quotes before generation. Account sign-in needs a configured gateway/identity provider; no credit is granted by login. This package has not established live identity-provider/client compatibility.

```sh
export MEDIA_ROUTER_URL=https://your-opengen.example
opengen login
opengen status
opengen catalog search image
opengen quote --input /absolute/private/request.json
opengen logout
```

Use the installed executable's full path if it is not on your PATH. Login tokens stay in the existing private OpenGen profile (`$XDG_CONFIG_HOME/opengen/auth.json`, or `~/.config/opengen/auth.json`). Never put credentials in command arguments, URLs, Git or agent settings. Environment credentials are an explicit transport override and are never printed by status. No provider credentials belong in ordinary sign-in.

Client configuration is an explicit, separate action. `bind preview` is read-only; it does not install a client or select a global destination:

```sh
opengen bind preview --client cursor --config /absolute/path/to/project/.cursor/mcp.json --url https://your-opengen.example
```

Only after reviewing that destination and URL, use `bind apply` with the same options and the returned `--preview-id`. Existing unrelated settings are preserved; replacing a different OpenGen entry needs explicit `--replace` in both commands. Plain JSON for Cursor and Claude Code is supported; JSONC/TOML are manual. Bindings contain the remote MCP URL only; the client obtains its own browser authorization. This is not a local stdio MCP bridge.

`BUILD-MANIFEST.json` records sanitized source/input hashes, bundled dependency/license versions, builder version, external Node imports and packaged file hashes. It is not a signature or a security audit. Zod's optional JIT is disabled through its public `jitless` setting; the standalone executable is tested with Node's string-code-generation prohibition. Source maps, source files, repository paths, `.env`, tests, server/engine/provider code and build-tool binaries are excluded.
