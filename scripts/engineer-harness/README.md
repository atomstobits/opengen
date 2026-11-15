# Engineer Harness

Coordinates the Codex review, CI gate, repair prompt, and GitHub Merge Queue loop for OpenGen pull requests, hardened for public open-source operation.

## What it does

- Evaluates pull request readiness across `.github/workflows/check.yml` (`Isolated C2PA integration / provenance`, `verify`, `secrets`, `containers`), inline review threads, and `@codex` review receipts/findings (`P0`–`P3`).
- Requests `@codex review current head <sha>` automatically once per non-draft head via `.github/workflows/codex-auto-review.yml` **only** for same-repository branches authored by `admin`/`write` collaborators (preventing external fork PRs from consuming Codex review quota).
- Forces `human-approval-required` on any fork PR or non-collaborator PR even when `ENGINEER_HARNESS_MERGE_POLICY=auto-merge`, so external code never auto-enqueues without a human collaborator `APPROVED` review on the exact current `headSha`.
- Accepts harness machine-state comments (`<!-- engineer-harness-state:start -->`) exclusively from `github-actions[bot]`, and requires Codex clean issue-comment receipts to match `**Reviewed commit:**` and a collaborator/workflow review request.
- Publishes `engineer-harness/ready` and lands `ready-merge` pull requests targeting `main` exclusively through GitHub's Merge Queue (`enqueuePullRequest` with `expectedHeadOid` via `ENGINEER_HARNESS_QUEUE_TOKEN`). Stacked PRs (`baseRefName !== "main"`) keep `engineer-harness/ready` green with a retarget notice and exit 0 without merging.
- Holds heads removed from `main`'s merge queue for `failed_checks` until either a new commit is pushed or a collaborator with `write`/`admin` permission comments `/harness-requeue <head sha>`.

## Required GitHub configuration

Repository variables:

- `CODEX_REVIEW_ACTOR`: optional, defaults in workflow to `chatgpt-codex-connector`.
- `ENGINEER_HARNESS_MERGE_POLICY`: optional, defaults to `auto-merge` (collaborator same-repo PRs auto-enqueue when clean; external/fork PRs always require human approval on `headSha`). Set to `human-approval-required` to require human approval on all PRs.
- `ENGINEER_HARNESS_MAX_ROUNDS`: optional, defaults to `5` (`0` disables repair rounds and halts immediately on blockers).

Repository secrets:

- `CODEX_REVIEW_REQUEST_TOKEN`: fine-grained personal access token owned by a Codex-connected repository collaborator, scoped to repository Pull Requests / Issues comment write.
- `ENGINEER_HARNESS_QUEUE_TOKEN`: fine-grained personal access token scoped to repository `contents: write` and `pull-requests: write` so the harness can call GraphQL `enqueuePullRequest` and trigger `merge_group` runs on `check.yml`.

Recommended `main` ruleset settings (matching `apob-landing` live configuration):

- Require pull request before merging (`required_approving_review_count: 0`, `dismiss_stale_reviews_on_push: true`, `required_review_thread_resolution: true`, `require_extra_approval_for_unattributed_changes: true`).
- Require merge queue (`merge_method: "SQUASH"`, `grouping_strategy: "ALLGREEN"`, `check_response_timeout_minutes: 60`, `max_entries_to_build: 5`, `max_entries_to_merge: 5`, `min_entries_to_merge: 1`, `min_entries_to_merge_wait_minutes: 5`) — enable **after** `.github/workflows/check.yml` with `on.merge_group` has landed on `main`.
- Require status checks to pass on both pull requests and `merge_group` commits (do **not** add `engineer-harness/ready` here when Merge Queue is enabled, because `engineer-harness.yml` gates PR enqueueing rather than `merge_group` runs):
  - `Isolated C2PA integration / provenance`
  - `verify`
  - `secrets`
  - `containers`
- Enable "Automatically delete head branches" (`delete_branch_on_merge: true`) and set Actions fork PR approval policy to `all_external_contributors`.

## Local commands

```sh
GH_TOKEN="$(gh auth token)" PR_NUMBER=42 node --import tsx scripts/engineer-harness/src/cli.ts sync
GH_TOKEN="$(gh auth token)" PR_NUMBER=42 node --import tsx scripts/engineer-harness/src/cli.ts merge
GH_TOKEN="$(gh auth token)" node --import tsx scripts/engineer-harness/src/cli.ts create-plan-issue \
  --title "Feature: ..." \
  --request-file /tmp/request.md \
  --plan-file /tmp/plan.md \
  --acceptance-file /tmp/acceptance.md \
  --risks-file /tmp/risks.md \
  --validation-file /tmp/validation.md
```

When resolving the final inline review thread without a new commit or comment (GitHub does not emit a workflow trigger on thread resolution), dispatch a re-sync manually:

```sh
gh workflow run engineer-harness.yml --ref main -f pr_number=<PR_NUMBER>
```
