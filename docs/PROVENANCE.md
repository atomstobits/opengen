# Output delivery and provenance

Provider generation status and output delivery status are separate. An upstream success may still have an inaccessible, malformed or expired output. OpenGen never converts that delivery failure into an assumed upstream refund.

With private object storage configured, `archiveOutputs` downloads the exact provider bytes over public HTTPS with DNS/IP pinning, rejects redirects, applies a 30-second deadline and a 100 MiB limit, and checks supported media signatures/types. It stores accepted PNG/JPEG/WebP/MP4 bytes privately, records SHA-256/byte length, and returns short-lived signed URLs. Existing output keys are read only from the current job's prefix through the configured storage SDK. Download credentials are restricted to explicit caller-supplied host bindings; they cannot follow a redirect.

Delivery is `available` when all output byte objects were retained, `partial` when some were retained, `failed` when none could be retained, and `unverified` without configured storage. These labels do not promise visual quality, complete codec decoding, parameter fidelity or permanent retention. Failed output URLs are not returned as archived results. Storage retention and backups remain operator responsibilities.

## Optional C2PA verifier

Set an absolute trusted `C2PA_TOOL_PATH` only for a worker whose verifier execution is externally isolated from network access. Set `C2PA_TOOL_NETWORK_ISOLATED=true` only after that isolation exists. This setting is an operator assertion; OpenGen does not create an OS/container sandbox. Keep the verifier image/version reviewed and immutable. It is not downloaded automatically or shipped in the default image.

The verifier receives a private temporary local file, isolated settings/home, a minimal environment with no provider/cloud secrets, a 15-second timeout and a 2 MiB output limit. It runs directly without a shell. Remote manifests, OCSP fetches, identity decoding and allowed network hosts are disabled; trust anchors must be local files. The upstream settings reference documents a CAWG network-allowlist limitation, which is why external network isolation is also required. [SDK settings](https://opensource.contentauthenticity.org/docs/manifest/json-ref/settings-schema/).

Optional `C2PA_TRUST_ANCHORS_PATH` and `C2PA_TSA_TRUST_ANCHORS_PATH` provide local PEM trust bundles for signer and timestamp validation. Anchor maintenance is an operator task; verification performs no trust-list download. CLI behavior and settings support must be checked against the pinned executable. [C2PA Tool usage](https://github.com/contentauth/c2patool/blob/main/docs/usage.md).

Each checked file records a result:

| Status        | Meaning in OpenGen                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `trusted`     | Explicit trusted verifier state with configured signer anchors and no contradictory untrusted codes. |
| `valid`       | Explicit valid integrity state; signer trust has not been established by this installation.          |
| `invalid`     | Explicit invalid state or integrity failures.                                                        |
| `absent`      | The verifier explicitly reported no embedded claim.                                                  |
| `unknown`     | Unsupported/error/limited verification report.                                                       |
| `unavailable` | No usable verifier configuration or required network isolation.                                      |

Missing error fields do not establish validity. New SDKs expose explicit `validation_state` and structured results; the parser uses those rather than treating an empty legacy status array as success. [Manifest validation](https://opensource.contentauthenticity.org/docs/manifest/reading/manifest-validation/).

C2PA results describe the observed credentials and bytes. They do not establish model identity, human authorship, prompt adherence or requested resolution. Absence does not establish that media is original, unmodified or human-created. `fidelity` remains unverified. Unit tests use synthetic reports and fake verifier runners; live provider provenance has not been verified.

## Real-tool integration smoke

The separately dispatched **Isolated C2PA integration** workflow runs `node --import tsx scripts/provenance-smoke.ts` on a non-root Linux x64 runner with Docker. It downloads [official C2PA Tool v0.28.4](https://github.com/contentauth/c2patool/releases/tag/v0.28.4), verifies the Linux archive SHA-256 `097e9efaff765baf7738a40c640012419cad419ce3e1aa36cf68e0576309c971`, and extracts only the executable and public development trust bundle. The source pin is commit `a014983807cd4ff08c65c119fc21ebe560162fca`; the bundled public anchors are independently checked against SHA-256 `a800641aeb9d04c603ba4d20ef676a3da2c243ab8267318356737f7afb189fcf`.

The script creates original PNG pixels in a private temporary directory. It signs one copy using the pinned tool's documented [built-in development signer](https://github.com/contentauth/c2patool/blob/v0.28.4/docs/signing.md#settings-only-signing-testing-only), with no timestamp authority configured. No signing-key file is copied into the source tree or committed. A tampered copy preserves the embedded manifest while replacing valid PNG image data and recomputing its CRC; the image stream still decompresses successfully.

Every real verifier invocation runs in an immutable locally built Docker image ID with `--network=none`, a read-only root filesystem and fixture mount, all capabilities dropped, no new privileges, a non-root UID, resource limits and a bounded timeout. Signing has a writable **temporary fixture mount** for its output, while retaining the same network/root-filesystem restrictions. The test passes `networkIsolated: true` to `verifyC2pa` only through this actual Docker runner. It does not loosen the production isolation guard or execute untrusted media directly on the CI host.

The integration asserts unsigned `absent`, signed integrity `valid`, signed `trusted` using **development-only local anchors**, and tampered `invalid` from the real binary's reports. A local development trust result is not public C2PA trust-list conformance, production signer identity, or evidence about a generation provider. Only the sanitized synthetic result/report and isolation metadata are retained as a short-lived workflow artifact; the downloaded executable, generated fixture directory and dedicated verifier image are removed.

**Execution status:** workflow definitions and TypeScript checks can be prepared without Docker, but this smoke is not passed until the exact candidate's manually dispatched job succeeds. Docker is unavailable on the development workstation, so no local real-binary integration pass is claimed. Preserve the workflow URL/commit in release evidence after execution; failure remains a verification gap rather than an assumed pass.
