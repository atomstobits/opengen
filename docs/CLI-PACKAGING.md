# Standalone CLI packaging

Packaging audit updated 2026-11-11. The standalone artifact is packaged as `@opengen/cli`, version `0.1.1`, with `"publishConfig": { "access": "public" }` and an `opengen` executable (`opengen-cli-0.1.1.tgz`). It is separate from the source workspace package `@media-router/cli`. Local build/pack scripts remain deterministic and offline-safe; actual registry publication happens only as an explicit release step. [npm package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)

## Contents and dependencies

`bin/opengen.mjs` bundles the CLI, thin SDK, canonical contracts/operation registry, existing browser PKCE login/profile helpers and previewable remote-client binding helpers. It runs on Node **22.12 or newer**, without TypeScript loaders, workspace links or runtime npm dependencies. External runtime imports are restricted to Node builtins. The artifact does not contain the server, PostgreSQL engine, provider adapters, provider credentials, web app or `packages/catalog` dataset. Canonical model capability definitions from `packages/contracts/src/generation-models.ts` remain required validation code; omitting them would change the CLI's input contract.

| Component                          | Audited exact version | License    | Artifact handling                                                                                                                  |
| ---------------------------------- | --------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Original OpenGen CLI/SDK/contracts | 0.1.1                 | Apache-2.0 | Include repository `LICENSE` and `NOTICE`; preserve source attribution.                                                            |
| Zod                                | 4.6.7                 | MIT        | Bundled runtime validation code; include its complete installed copyright/permission/warranty notice in `THIRD-PARTY-NOTICES.txt`. |
| esbuild                            | 0.28.2                | MIT        | Build-time tool only. Pin and record its version; its JavaScript service/native executable are not runtime package contents.       |

The root development dependencies and lockfile pin esbuild **0.28.2** directly. The builder fails if the installed tool differs from its recorded pin. Clean-checkout CI runs the package tests, builds the reviewed tarball and uploads its checksum and manifests as private review artifacts.

Zod's full MIT notice is at `node_modules/zod/LICENSE`; esbuild's is at `node_modules/esbuild/LICENSE.md`. Copy the installed notice verbatim when required, rather than reconstructing it from a package metadata field or stripping it during minification. The original-code distribution carries Apache-2.0 `LICENSE` and the repository's readable `NOTICE`. Dependency upgrades require reviewing the actual resolved source and notices again. [Zod 4.6.7 license](https://raw.githubusercontent.com/colinhacks/zod/v4.6.7/LICENSE), [esbuild 0.28.2 license](https://raw.githubusercontent.com/evanw/esbuild/v0.28.2/LICENSE.md), [Apache-2.0 redistribution terms](https://www.apache.org/licenses/LICENSE-2.0)

## Build and pack locally

From a clean source checkout with the qualified dependencies installed:

```sh
node scripts/build-cli.mjs \
  --repo-root /absolute/path/to/opengen \
  --out-dir /absolute/private/output/new-cli-package
```

Use a new output directory. The package directory contains only the executable, package metadata, README, `LICENSE`, `NOTICE`, `THIRD-PARTY-NOTICES.txt` and `BUILD-MANIFEST.json`. Its manifest declares `bin.opengen` as `bin/opengen.mjs`, preserves the Node shebang and executable mode, and has no install scripts or runtime dependency downloads. npm documents the bin mapping/shebang behavior. [npm bin metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin)

To build the package and its reviewable release files in one operation:

```sh
node scripts/package-cli.mjs \
  --repo-root /absolute/path/to/opengen \
  --out-dir /absolute/private/output/new-cli-release
```

For version 0.1.1 the release directory holds:

- `opengen-cli-0.1.1.tgz`
- `opengen-cli-0.1.1.tgz.sha256`
- `opengen-cli-0.1.1.manifest.json`
- `package/`, retained for inspection, containing the exact packaged files.

The packer creates a deterministic USTAR/gzip archive for identical inputs and toolchain, using Node builtins and a fixed file list. The build manifest records the actual Node, V8 and zlib versions; cross-toolchain byte equivalence is not claimed. It does not run `npm pack`, lifecycle hooks, publication or a global installation. Generated artifacts stay outside the source release. The integration owner qualifies reproducibility using the pinned builder, source inputs and the exact archive; this document is not evidence that an untested artifact passed those checks.

The builder uses a closed virtual module graph: explicit source aliases and an input allowlist are checked before source loading, then the esbuild metafile is checked for the resulting inputs and external imports. Source files outside the approved CLI/SDK/contracts prefixes, outside/symlinked inputs, new dependencies and external package imports must fail the build rather than silently expand the artifact. `BUILD-MANIFEST.json` records sanitized input labels/hashes and builder/dependency evidence derived from the metafile; raw developer filesystem paths, source maps, environment values and private files do not belong in the distributed manifest. esbuild documents JSON metafiles for machine inspection and legal-comment preservation; retaining a comment alone does not replace shipping a required complete license notice. [esbuild API](https://esbuild.github.io/api/#metafile)

Zod 4's optional parser JIT is disabled by the packaging wrapper before CLI initialization. Validate the resulting executable under `node --disallow-code-generation-from-strings`, including canonical request validation. A passing `--help` alone does not execute a schema parser. The wrapper directly dispatches commands instead of relying on the source modules' direct-execution guards, so the installed npm `.bin` symlink must be tested as well as the direct `.mjs` path.

## Verify and install into a private local project

Obtain the archive and checksum from the same reviewed build, and compare the checksum with the expected value supplied through the trusted release channel. A matching sidecar proves byte agreement; it does not establish the publisher's identity on its own.

```sh
cd /absolute/private/output/new-cli-release
shasum -a 256 -c opengen-cli-0.1.1.tgz.sha256
tar -tzf opengen-cli-0.1.1.tgz
```

The archive should contain the expected package files only, under `package/`, with regular files/directories, no traversal paths and no links, `.env`, profile, source checkout or `node_modules` tree. Inspect the package/release manifests and third-party notice before installation.

Choose an empty private project directory for this local install:

```sh
npm install --prefix /absolute/private/project \
  /absolute/private/output/new-cli-release/opengen-cli-0.1.1.tgz \
  --ignore-scripts --no-audit --no-fund
/absolute/private/project/node_modules/.bin/opengen --help
```

This writes local project metadata and `node_modules` under the selected prefix, without a global install. It uses the local tarball, not an `opengen-cli` registry lookup. `--ignore-scripts` suppresses package lifecycle scripts; it does not audit the code subsequently executed. The standalone package needs no runtime dependency installation. [npm local tarball installation and script handling](https://docs.npmjs.com/cli/v11/commands/npm-install/)

On POSIX systems use the local bin path above. Platform-specific executable shims, browser launching and filesystem behavior require their own tests; no Windows client test is recorded here.

## Use the installed CLI

Set your configured gateway's public origin, then use the local executable:

```sh
export MEDIA_ROUTER_URL=https://your-opengen.example
/absolute/private/project/node_modules/.bin/opengen login
/absolute/private/project/node_modules/.bin/opengen status
/absolute/private/project/node_modules/.bin/opengen catalog search "image"
/absolute/private/project/node_modules/.bin/opengen operations
/absolute/private/project/node_modules/.bin/opengen balance
```

Account sign-in and consent require a configured deployment. The existing login helper stores scoped OAuth credentials in the private local OpenGen profile; the package contains no credentials and setup requires no installation/provider secret. `status` prints safe connection metadata. `logout` revokes that CLI authorization before deleting its profile. See [authentication](AUTH.md) and [local-agent recovery](LOCAL-AGENTS.md).

The installed entry also exposes `bind preview`, `bind apply` and `bind status` through the bundled binding command helper. For example:

```sh
/absolute/private/project/node_modules/.bin/opengen bind preview \
  --client cursor \
  --config /absolute/path/to/your-project/.cursor/mcp.json \
  --url https://your-opengen.example
```

Review the returned destination/entry and use `bind apply` with identical options plus `--preview-id` from that preview. Only documented Cursor/Claude Code remote JSON configuration is automated. The private CLI profile is never copied into client settings. [Local binding details](LOCAL-AGENTS.md) and [dated client evidence](AGENT-SUPPORT.md) distinguish configuration fixtures from actual client tests. This package does not add a stdio MCP bridge, provision an identity provider or establish a working public hosted service.

Before generation, inspect the canonical schema/operation, quote the exact input and obtain spending authorization. Persist the original request, idempotency key and returned job ID; use the same accepted job for resume. No packaging or installation check submits paid generations. Source and standalone CLI must share those same command/business rules.

## Qualification evidence to retain

Release qualification retains the archive SHA-256, release/build manifests, clean-checkout dependency evidence, source/license/secret scans, exact npm file list and reproducible-build comparison. The 11 packaging tests cover isolated local installation outside the monorepo, direct bundle and npm bin execution, malformed/unknown argument handling, fixture-backed native requests and schema rejection, token-free binding preview and no-code-generation mode. Login/profile and binding tests run separately. Tests use temporary profiles/configuration and no global client settings.

These are packaging gates. Real identity-provider login, deployed transport authorization, paid provider generation and a third-party client/version connection remain separate evidence gates. Nothing in the tarball or its local-install mechanism authorizes npm publication, a public release or deployment.

## Checkout-free onboarding bundle

The 2026-11-04 candidate adds one staged release containing version-matched CLI, installable skill and local Claude Code plugin. Build it privately:

```sh
node scripts/build-onboarding.mjs --check
node scripts/package-onboarding.mjs \
  --repo-root /absolute/path/to/opengen \
  --out-dir /absolute/private/new-onboarding-release
```

`docs/agent/SKILL.md` is the sole instruction source. `scripts/build-onboarding.mjs` generates `skills/opengen/SKILL.md`, the native plugin skill/manifest and shared REST/web instruction module. Run it without `--check` after editing the source. CI/tests fail if outputs drift. Both web and server `/llms.txt` lead directly to `/skill.md` and use the generated runtime decision guidance.

The staged directory contains `opengen-cli-VERSION.tgz`, `opengen-skill-VERSION.tgz`, `opengen-plugin-VERSION.tgz`, `install-opengen.mjs`, `RELEASE-MANIFEST.json`, `PROVENANCE.json`, `SHA256SUMS` and an inspection-only `cli/` folder. Artifacts have fixed paths/modes, no lifecycle hooks and no timestamps in archives. Provenance records exact source/input hashes, Git revision plus dirty/unavailable state, Node/zlib versions and subjects. It is unsigned local evidence, not publisher identity or a SLSA certification. Rebuild the exact reviewed clean commit on the pinned toolchain before public release; commit identity by itself does not describe uncommitted source changes.

Transfer the release files through a trusted channel to a clean machine with Node 22.12+. Obtain the expected manifest and installer hashes through that channel; a sidecar downloaded with an archive is insufficient proof of authenticity. Verify the installer before running it and all files before installation:

```sh
cd /absolute/reviewed/download
shasum -a 256 install-opengen.mjs
shasum -a 256 -c SHA256SUMS
node install-opengen.mjs \
  --release-dir /absolute/reviewed/download \
  --expected-manifest-sha256 EXPECTED_DIGEST_FROM_TRUSTED_CHANNEL \
  --prefix /absolute/private/new-client \
  --skill-dir /absolute/agent/skills/opengen \
  --plugin-dir /absolute/private/new-opengen-plugin
/absolute/private/new-client/bin/opengen.mjs --version
```

The `--plugin-dir` option is optional. Destination parents must already exist as real directories. All destination directories must be new, distinct and outside one another; the installer refuses overwrite/symlinks rather than changing existing agent settings. It validates the trusted manifest digest, artifact hashes, exact tar file list and per-file hashes/modes before creating anything. It uses only Node builtins, with no network/npm/checkout dependency, and rolls back directories created by a failed installation. It does not edit PATH, grant OAuth, alter client configuration or submit generation. Browser login and remote binding remain explicit actions in [LOCAL-AGENTS.md](LOCAL-AGENTS.md).

Public release preparation is complete at the artifact level; the repository, archives and plugin remain unpublished. The future release can distribute this exact bundle from an approved versioned download origin without exposing the private source repository. Release approval must establish artifact hosting/access, expected digest/signature channel, source/license/secret checks, real client qualification and configured hosted identity/backend. No currently usable public download URL, owned npm namespace, signed attestation or marketplace approval is claimed.
