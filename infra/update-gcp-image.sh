#!/usr/bin/env bash
set -euo pipefail

# Build the Dockerfile server stage in Cloud Build, resolve its immutable
# Artifact Registry SHA-256 digest, and plan or apply infra/deploy-gcp.sh.
# Default mode is --plan (zero cloud builds or runtime mutations).
usage() {
  echo 'Usage: bash infra/update-gcp-image.sh [--env-file PATH] [--skip-build] [--plan|--build|--apply]' >&2
  exit 2
}

mode=""
skip_build=false
env_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan|--build|--apply)
      if [[ -n "$mode" ]]; then usage; fi
      mode="$1"
      shift
      ;;
    --skip-build)
      skip_build=true
      shift
      ;;
    --env-file)
      if [[ $# -lt 2 || -z "$2" || -n "$env_file" ]]; then usage; fi
      env_file="$2"
      shift 2
      ;;
    --env-file=*)
      val="${1#--env-file=}"
      if [[ -z "$val" || -n "$env_file" ]]; then usage; fi
      env_file="$val"
      shift
      ;;
    *)
      usage
      ;;
  esac
done
mode="${mode:---plan}"
if [[ "$mode" == "--build" && "$skip_build" == true ]]; then
  echo '--build and --skip-build cannot be combined.' >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js is required to validate deployment configuration.' >&2
  exit 2
fi
if ! command -v git >/dev/null 2>&1; then
  echo 'Git is required to verify repository state and source commit.' >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
for required_file in infra/deploy-gcp.sh Dockerfile .gcloudignore; do
  if [[ ! -f "$repo_root/$required_file" || -L "$repo_root/$required_file" ]]; then
    echo "Missing or symbolic deployment prerequisite: $required_file" >&2
    exit 2
  fi
done

env_file_helper='
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const ALLOWED_KEYS = new Set([
  "OPENGEN_PROJECT_ID",
  "OPENGEN_REGION",
  "OPENGEN_ARTIFACT_REPOSITORY",
  "OPENGEN_PUBLIC_URL",
  "OPENGEN_PROVIDER_EXECUTION_ENABLED",
  "OPENGEN_EXECUTION_SCOPE",
  "OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256",
  "OPENGEN_API_IMAGE",
  "OPENGEN_API_RUNTIME_SA",
  "OPENGEN_WORKER_RUNTIME_SA",
  "OPENGEN_CLOUDSQL_CONNECTION",
  "OPENGEN_DATABASE_SECRET",
  "OPENGEN_API_TOKEN_SECRET",
  "OPENGEN_SECRET_VERSION",
  "OPENGEN_PROVIDER_SECRET_BINDINGS",
  "OPENGEN_API_SECRET_BINDINGS",
  "MR_INPUT_RETENTION_MS",
  "OPENGEN_NOTIFICATION_EMAIL_ENDPOINT",
  "OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED",
  "STRIPE_LIVEMODE",
  "OPENGEN_BILLABLE_RUNTIME_APPROVED",
  "GCP_WORKLOAD_IDENTITY_PROVIDER",
  "GCP_SERVICE_ACCOUNT_EMAIL",
  "MEDIA_ROUTER_API_URL",
]);

function fail(message) {
  console.error(message);
  process.exit(2);
}

function checkRepoRelative(realRepo, candidate) {
  const rel = path.relative(realRepo, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;
  let current = realRepo;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      fail("Symbolic links are forbidden in --env-file paths.");
    }
  }
  const tracked = spawnSync("git", ["-C", realRepo, "ls-files", "--error-unmatch", "--", rel], {
    stdio: "ignore",
  });
  if (tracked.status === 0) {
    fail(
      "Tracked repository files cannot be used as --env-file; copy infra/opengen.env.example to git-ignored infra/.local/opengen.env.",
    );
  }
  const ignored = spawnSync("git", ["-C", realRepo, "check-ignore", "-q", "--", rel], {
    stdio: "ignore",
  });
  if (ignored.status !== 0) {
    fail("In-repository --env-file paths must be git-ignored (for example infra/.local/opengen.env).");
  }
}

function validateEnvPath(repoRoot, inputPath) {
  let realRepo;
  try {
    realRepo = fs.realpathSync(repoRoot);
  } catch {
    fail("Repository root could not be resolved.");
  }
  const absEnv = path.resolve(inputPath);
  let stat, parentStat;
  try {
    stat = fs.lstatSync(absEnv);
    parentStat = fs.lstatSync(path.dirname(absEnv));
  } catch {
    fail("Unable to read --env-file; verify the file exists and is accessible.");
  }
  if (stat.isSymbolicLink() || parentStat.isSymbolicLink() || !stat.isFile() || stat.size > 65536) {
    fail("--env-file must be a bounded regular file without symbolic links.");
  }
  checkRepoRelative(realRepo, absEnv);
  const realEnv = fs.realpathSync(absEnv);
  checkRepoRelative(realRepo, realEnv);
  return realEnv;
}

function parseEnvContent(content) {
  if (content.includes("\0")) fail("Invalid NUL byte in --env-file.");
  const seen = new Set();
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      fail("Invalid --env-file syntax; use plain KEY=VALUE lines with secret references only.");
    }
    const [, key, raw] = match;
    if (!ALLOWED_KEYS.has(key)) {
      fail(
        "Unsupported or secret variable in --env-file; include only documented deployment identifiers and Secret Manager references.",
      );
    }
    if (seen.has(key)) fail(`Duplicate variable in --env-file: ${key}`);
    seen.add(key);
    if (/`|\$\(/.test(raw)) {
      fail("Shell command substitution is forbidden in --env-file.");
    }
    let value;
    if (raw.startsWith("\"") || raw.endsWith("\"")) {
      if (
        raw.length < 2 ||
        !raw.startsWith("\"") ||
        !raw.endsWith("\"") ||
        /["\\$]/.test(raw.slice(1, -1))
      ) {
        fail("Invalid double-quoted value in --env-file.");
      }
      value = raw.slice(1, -1);
    } else if (raw.startsWith("\x27") || raw.endsWith("\x27")) {
      if (
        raw.length < 2 ||
        !raw.startsWith("\x27") ||
        !raw.endsWith("\x27") ||
        raw.slice(1, -1).includes("\x27")
      ) {
        fail("Invalid single-quoted value in --env-file.");
      }
      value = raw.slice(1, -1);
    } else {
      if (raw.includes("$")) fail("Shell variable expansion is forbidden in --env-file.");
      value = raw;
    }
    entries.push([key, value]);
  }
  return entries;
}

const [, action, repoRoot, inputPath, resolvedImage] = process.argv;
const realEnv = validateEnvPath(repoRoot, inputPath);
const content = fs.readFileSync(realEnv, "utf8");
const entries = parseEnvContent(content);

if (action === "load") {
  for (const [key, value] of entries) {
    process.stdout.write(`${key}=${value}\n`);
  }
} else if (action === "write-image") {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let replaced = false;
  const updated = lines.map((line) => {
    if (/^\s*(?:export\s+)?OPENGEN_API_IMAGE=/.test(line)) {
      replaced = true;
      return `OPENGEN_API_IMAGE=${resolvedImage}`;
    }
    return line;
  });
  if (!replaced) updated.push(`OPENGEN_API_IMAGE=${resolvedImage}`);
  const tempPath = `${realEnv}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, `${updated.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(tempPath, realEnv);
} else {
  fail("Unknown internal env-file action.");
}
'

if [[ -n "$env_file" ]]; then
  parsed_env="$(node -e "$env_file_helper" load "$repo_root" "$env_file")"
  if [[ -n "$parsed_env" ]]; then
    while IFS= read -r entry; do
      [[ -z "$entry" ]] && continue
      key="${entry%%=*}"
      val="${entry#*=}"
      if [[ -z "${!key+x}" ]]; then
        export "$key=$val"
      fi
    done <<< "$parsed_env"
  fi
fi

if [[ ",${OPENGEN_PROVIDER_SECRET_BINDINGS:-}," =~ ,(OPENGEN_ARTIFACT_REPOSITORY|OPENGEN_API_IMAGE|OPENGEN_PROJECT_ID|OPENGEN_REGION|OPENGEN_CLOUDSQL_CONNECTION|OPENGEN_API_RUNTIME_SA|OPENGEN_WORKER_RUNTIME_SA|OPENGEN_DATABASE_SECRET|OPENGEN_API_TOKEN_SECRET|OPENGEN_SECRET_VERSION|OPENGEN_BILLABLE_RUNTIME_APPROVED)= ]]; then
  echo 'Deployment and image identifiers are nonsecret settings and cannot be secret bindings.' >&2
  exit 2
fi

artifact_repo="${OPENGEN_ARTIFACT_REPOSITORY:-opengen}"
if [[ ! "$artifact_repo" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo 'Use a valid Artifact Registry Docker repository name.' >&2
  exit 2
fi

if [[ "$skip_build" == false ]]; then
  if [[ -z "${OPENGEN_PROJECT_ID:-}" ]]; then
    echo 'Missing deployment identifier: OPENGEN_PROJECT_ID' >&2
    exit 2
  fi
  if [[ -z "${OPENGEN_REGION:-}" ]]; then
    echo 'Missing deployment identifier: OPENGEN_REGION' >&2
    exit 2
  fi
  if [[ ! "$OPENGEN_PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]]; then
    echo 'Use a valid GCP project ID and a pinned numeric secret version.' >&2
    exit 2
  fi
  if [[ ! "$OPENGEN_REGION" =~ ^[a-z]+(-[a-z0-9]+)+[0-9]$ ]]; then
    echo 'Use a GCP region and a Cloud SQL project:region:instance identifier, never URLs or values.' >&2
    exit 2
  fi
  git_top="$(git -C "$repo_root" rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -z "$git_top" || "$(cd "$git_top" && pwd -P)" != "$repo_root" ]]; then
    echo 'Image builds must run from a valid OpenGen Git checkout.' >&2
    exit 2
  fi
  if [[ -n "$(git -C "$repo_root" status --porcelain --untracked-files=normal)" ]]; then
    echo 'Repository checkout has uncommitted or untracked source changes. Commit or clean the tree before building a deployment image.' >&2
    exit 2
  fi
  commit_sha="$(git -C "$repo_root" rev-parse --verify HEAD 2>/dev/null || true)"
  if [[ ! "$commit_sha" =~ ^[a-f0-9]{40}$ ]]; then
    echo 'Unable to resolve a committed Git HEAD SHA.' >&2
    exit 2
  fi
  short_sha="${commit_sha:0:12}"
  image_repo="${OPENGEN_REGION}-docker.pkg.dev/${OPENGEN_PROJECT_ID}/${artifact_repo}/api"
  image_tag="${image_repo}:${short_sha}"
  placeholder_digest="0000000000000000000000000000000000000000000000000000000000000000"
  plan_preview="$(OPENGEN_API_IMAGE="${image_repo}@sha256:${placeholder_digest}" /bin/bash "$repo_root/infra/deploy-gcp.sh" --plan)"
else
  plan_preview="$(/bin/bash "$repo_root/infra/deploy-gcp.sh" --plan)"
fi

if [[ "$mode" == "--plan" ]]; then
  if [[ "$skip_build" == true ]]; then
    echo "Pinned server image (skip-build): $OPENGEN_API_IMAGE"
    printf '%s\n' "$plan_preview"
  else
    echo "Source commit: $commit_sha"
    echo "Planned Cloud Build target: server -> $image_tag"
    printf 'gcloud builds submit %q --project %q --config <temp-cloudbuild.yaml> --quiet\n' "$repo_root" "$OPENGEN_PROJECT_ID"
    printf 'gcloud artifacts docker images describe %q --project %q --format=%q --quiet\n' "$image_tag" "$OPENGEN_PROJECT_ID" 'value(image_summary.fully_qualified_digest)'
    printf '%s\n' "${plan_preview//$placeholder_digest/<resolved-64-hex-sha256>}"
    echo 'No cloud build or runtime mutation performed.'
  fi
  exit 0
fi

if [[ "$mode" == "--apply" && "${OPENGEN_BILLABLE_RUNTIME_APPROVED:-no}" != "yes" ]]; then
  echo 'Runtime deployment requires an explicit reviewed cost/region/resource decision. Set OPENGEN_BILLABLE_RUNTIME_APPROVED=yes after that review.' >&2
  exit 2
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo 'Google Cloud CLI (gcloud) is required for --build and --apply.' >&2
  exit 2
fi

if [[ "$mode" == "--apply" ]]; then
  if [[ "$(gcloud billing projects describe "$OPENGEN_PROJECT_ID" --format='value(billingEnabled)')" != 'True' ]]; then
    echo 'Billing is not enabled. This script does not attach a billing account.' >&2
    exit 2
  fi
fi

if [[ "$skip_build" == false ]]; then
  previous_image="${OPENGEN_API_IMAGE:-}"
  tmpdir_base="${TMPDIR:-/tmp}"
  tmpdir_base="${tmpdir_base%/}"
  tmp_dir="$(umask 077 && mktemp -d "${tmpdir_base:-/tmp}/opengen-cloudbuild.XXXXXX")"
  trap '[[ -n "${tmp_dir:-}" ]] && rm -rf "$tmp_dir"' EXIT
  cloudbuild_config="$tmp_dir/cloudbuild.yaml"
  (
    umask 077
    cat > "$cloudbuild_config" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    env:
      - DOCKER_BUILDKIT=1
    args:
      - build
      - --target
      - server
      - --tag
      - ${image_tag}
      - .
images:
  - ${image_tag}
EOF
  )

  gcloud builds submit "$repo_root" \
    --project "$OPENGEN_PROJECT_ID" \
    --config "$cloudbuild_config" \
    --quiet

  resolved_image="$(
    gcloud artifacts docker images describe "$image_tag" \
      --project "$OPENGEN_PROJECT_ID" \
      --format='value(image_summary.fully_qualified_digest)' \
      --quiet | tr -d '\r\n'
  )"
  if [[ "$resolved_image" != "${image_repo}@sha256:"* ]] || [[ ! "${resolved_image#${image_repo}@sha256:}" =~ ^[a-f0-9]{64}$ ]]; then
    echo 'Artifact Registry did not return a matching immutable 64-character SHA-256 image digest.' >&2
    exit 1
  fi

  if [[ -n "$env_file" ]]; then
    node -e "$env_file_helper" write-image "$repo_root" "$env_file" "$resolved_image"
  fi
  export OPENGEN_API_IMAGE="$resolved_image"

  if [[ "$previous_image" =~ ^[a-z0-9][a-z0-9.-]+(:[1-9][0-9]*)?/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$ && "$previous_image" != "$resolved_image" ]]; then
    echo "Previous OPENGEN_API_IMAGE: $previous_image"
  fi
  echo "Resolved OPENGEN_API_IMAGE: $OPENGEN_API_IMAGE"
fi

if [[ "$mode" == "--build" ]]; then
  /bin/bash "$repo_root/infra/deploy-gcp.sh" --plan
  echo 'Image built and pinned. Runtime services were not modified.'
  exit 0
fi

/bin/bash "$repo_root/infra/deploy-gcp.sh" --apply
