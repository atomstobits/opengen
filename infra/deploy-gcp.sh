#!/usr/bin/env bash
set -euo pipefail

# Run after reviewing docs/DEPLOYMENT.md and preparing approved resources.
# Default output is a reviewable plan; this script never links billing or creates a database.
mode="${1:---plan}"
if [[ "$mode" != "--plan" && "$mode" != "--apply" ]]; then
  echo 'Usage: bash infra/deploy-gcp.sh [--plan|--apply]' >&2
  exit 2
fi

required=(OPENGEN_PROJECT_ID OPENGEN_REGION OPENGEN_PUBLIC_URL OPENGEN_API_IMAGE OPENGEN_API_RUNTIME_SA OPENGEN_WORKER_RUNTIME_SA OPENGEN_CLOUDSQL_CONNECTION OPENGEN_DATABASE_SECRET OPENGEN_API_TOKEN_SECRET OPENGEN_SECRET_VERSION OPENGEN_EXECUTION_SCOPE)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then echo "Missing deployment identifier: $name" >&2; exit 2; fi
done
if [[ ! "$OPENGEN_PROJECT_ID" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || [[ ! "$OPENGEN_SECRET_VERSION" =~ ^[1-9][0-9]*$ ]]; then
  echo 'Use a valid GCP project ID and a pinned numeric secret version.' >&2
  exit 2
fi
if [[ ! "$OPENGEN_REGION" =~ ^[a-z]+(-[a-z0-9]+)+[0-9]$ ]] || [[ ! "$OPENGEN_CLOUDSQL_CONNECTION" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z]+(-[a-z0-9]+)+[0-9]:[a-z][a-z0-9-]{0,97}$ ]]; then
  echo 'Use a GCP region and a Cloud SQL project:region:instance identifier, never URLs or values.' >&2
  exit 2
fi
if [[ ! "$OPENGEN_API_IMAGE" =~ ^[a-z0-9][a-z0-9.-]+(:[1-9][0-9]*)?/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$ ]]; then
  echo 'Use an immutable registry image reference with an exact 64-character SHA-256 digest.' >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js is required to validate the canonical public origin.' >&2
  exit 2
fi
if ! node -e '
  try {
    const value = process.env.OPENGEN_PUBLIC_URL, url = new URL(value);
    const labels = url.hostname.split(".");
    if (url.protocol !== "https:" || url.origin !== value || url.username || url.password ||
        labels.length < 2 || !/^[a-z]/.test(labels.at(-1)) ||
        labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        /\.(local|localhost|internal)$/.test(url.hostname)) process.exit(1);
  } catch { process.exit(1); }
'; then
  echo 'OPENGEN_PUBLIC_URL must be a canonical HTTPS public origin without credentials, path, query or fragment.' >&2
  exit 2
fi
# Optional lifecycle/email settings are explicit controls, never arbitrary env passthrough.
# Retention stays unset by default; configuring email does not establish recipient consent.
if ! node -e '
  try {
    const retention = process.env.MR_INPUT_RETENTION_MS ?? "";
    if (retention && (!/^[1-9][0-9]*$/.test(retention) ||
        !Number.isSafeInteger(Number(retention)) || Number(retention) < 60000)) process.exit(1);
    const endpoint = process.env.OPENGEN_NOTIFICATION_EMAIL_ENDPOINT ?? "";
    const confirmed = process.env.OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED || "0";
    if (!["0", "1"].includes(confirmed) || (confirmed === "1" && !endpoint) ||
        process.env.OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN) process.exit(1);
    if (endpoint) {
      const url = new URL(endpoint), labels = url.hostname.split(".");
      if (endpoint.length > 2048 || /[\s,#?]/.test(endpoint) || url.protocol !== "https:" ||
          url.username || url.password || (url.port && url.port !== "443") ||
          url.search || url.hash || labels.length < 2 || !/^[a-z]/.test(labels.at(-1)) ||
          labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
          /\.(local|localhost|internal)$/.test(url.hostname)) process.exit(1);
    }
  } catch { process.exit(1); }
'; then
  echo 'Retention must be empty or decimal integer milliseconds >=60000 within the safe integer range. Optional email requires a public DNS HTTPS relay on port443 without credentials, query, fragment or literal commas, a 0/1 idempotency flag, and secret-reference-only authentication.' >&2
  exit 2
fi
input_retention="${MR_INPUT_RETENTION_MS:-}"
email_endpoint="${OPENGEN_NOTIFICATION_EMAIL_ENDPOINT:-}"
email_idempotency="${OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED:-0}"
for name in OPENGEN_DATABASE_SECRET OPENGEN_API_TOKEN_SECRET; do
  if [[ ! "${!name}" =~ ^[a-zA-Z0-9_-]{1,255}$ ]]; then
    echo 'Database and installation-token secrets must be Secret Manager names, never values or version aliases.' >&2
    exit 2
  fi
done
for name in OPENGEN_API_RUNTIME_SA OPENGEN_WORKER_RUNTIME_SA; do
  if [[ ! "${!name}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$ ]]; then
    echo 'API and worker identities must be explicit GCP service-account email identifiers.' >&2
    exit 2
  fi
done
if [[ "$OPENGEN_API_RUNTIME_SA" == "$OPENGEN_WORKER_RUNTIME_SA" ]]; then
  echo 'Use different runtime service accounts for the API and worker before planning or applying.' >&2
  exit 2
fi
# Optional relay auth uses the same server-only pinned shared reference path:
# OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN=notification-relay-auth:7
# Never export its literal token to this planner; Compose uses its private local env separately.
provider_bindings="${OPENGEN_PROVIDER_SECRET_BINDINGS:-}"
api_secret_bindings="${OPENGEN_API_SECRET_BINDINGS:-}"
seen=(DATABASE_URL MR_API_TOKEN)
email_auth_bound=false
shared_secret_names=("$OPENGEN_DATABASE_SECRET")
api_secret_names=("$OPENGEN_API_TOKEN_SECRET")
validate_bindings() {
  local value="$1" audience="$2" binding binding_name secret_ref previous
  local entries=()
  [[ -z "$value" ]] && return
  if [[ ! "$value" =~ ^[A-Z][A-Z0-9_]*=[a-zA-Z0-9_-]{1,255}:[1-9][0-9]*(,[A-Z][A-Z0-9_]*=[a-zA-Z0-9_-]{1,255}:[1-9][0-9]*)*$ ]]; then
    echo 'Secret bindings must contain only ENV_NAME=secret-name:numeric-version references.' >&2
    exit 2
  fi
  IFS=, read -r -a entries <<< "$value"
  for binding in "${entries[@]}"; do
    binding_name="${binding%%=*}"
    for previous in "${seen[@]}"; do
      if [[ "$previous" == "$binding_name" ]]; then
        echo 'A secret environment name cannot be bound more than once.' >&2
        exit 2
      fi
    done
    case "$binding_name" in
      OPENGEN_PROVIDER_EXECUTION_*|OPENGEN_EXECUTION_SCOPE|OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256)
        echo 'Provider execution controls are nonsecret runtime settings and cannot be secret bindings.' >&2; exit 2 ;;
    esac
    if [[ "$audience" == api ]]; then
      case "$binding_name" in
        MR_SESSION_SECRET|OIDC_ISSUER|OIDC_CLIENT_ID|OIDC_CLIENT_SECRET|OIDC_JWKS_URI|OIDC_API_AUDIENCE|OIDC_ALLOWED_SCOPES|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET) ;;
        # Guard flags, hosted legal publication JSON and reviewed billing configuration use pinned secret references too.
        # In particular, payment terms and legal publication JSON contain commas/newlines and never enter --set-env-vars.
        OPENGEN_BILLING_MANUAL|OPENGEN_BILLING_CHECKOUT|OPENGEN_BILLING_PROCESSOR_ENVIRONMENT|OPENGEN_BILLING_PROCESSOR_ACCOUNT|OPENGEN_BILLING_MANUAL_WORKSPACE|OPENGEN_BILLING_APPROVAL_REFERENCE|OPENGEN_BILLING_TERMS_VERSION|OPENGEN_BILLING_TERMS_TEXT|OPENGEN_BILLING_OPERATOR_BEARER|OPENGEN_BILLING_SANDBOX|OPENGEN_BILLING_SANDBOX_WORKSPACE|OPENGEN_LEGAL_PUBLICATION_JSON) ;;
        *) echo 'API-only bindings support the documented session, OIDC, Stripe, hosted legal publication and scoped billing secret/configuration names only.' >&2; exit 2 ;;
      esac
    else
      case "$binding_name" in
        MR_SESSION_SECRET|OIDC_*|STRIPE_*|OPENGEN_BILLING_*|OPENGEN_LEGAL_*|OPENGEN_PUBLIC_URL|HOST|MR_WORKSPACE_ID|MR_INITIAL_BALANCE_MICROS|MR_DATABASE_POOL_SIZE|METRICS_ORIGIN_REGION|MR_INPUT_RETENTION_MS|OPENGEN_NOTIFICATION_EMAIL_ENDPOINT|OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED)
          echo 'API-only authentication/payment settings and runtime control names cannot be shared with the worker.' >&2; exit 2 ;;
      esac
    fi
    if [[ "$binding_name" == OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN ]]; then email_auth_bound=true; fi
    seen+=("$binding_name")
    secret_ref="${binding#*=}"
    if [[ "$audience" == api ]]; then api_secret_names+=("${secret_ref%:*}"); else shared_secret_names+=("${secret_ref%:*}"); fi
  done
}
validate_bindings "$provider_bindings" shared
validate_bindings "$api_secret_bindings" api
if [[ "$email_auth_bound" == true && -z "$email_endpoint" ]]; then
  echo 'A notification email authentication reference requires its explicitly configured relay endpoint.' >&2
  exit 2
fi
for api_secret_name in "${api_secret_names[@]}"; do
  for shared_secret_name in "${shared_secret_names[@]}"; do
    if [[ "$api_secret_name" == "$shared_secret_name" ]]; then
      echo 'An API-only secret cannot also be shared with the worker under another environment name.' >&2
      exit 2
    fi
  done
done
provider_execution_enabled="${OPENGEN_PROVIDER_EXECUTION_ENABLED-true}"
if [[ "$provider_execution_enabled" != true && "$provider_execution_enabled" != false ]]; then
  echo 'OPENGEN_PROVIDER_EXECUTION_ENABLED must be exactly true or false; true is the default.' >&2
  exit 2
fi
execution_scope="$OPENGEN_EXECUTION_SCOPE"
if [[ "$execution_scope" != unrestricted && "$execution_scope" != qualification-sg-v1 ]]; then
  echo 'OPENGEN_EXECUTION_SCOPE must explicitly select unrestricted or qualification-sg-v1.' >&2
  exit 2
fi
qualification_first_frame_sha256="${OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256-}"
if [[ "${OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256+x}" == x ]] &&
   [[ "$execution_scope" != qualification-sg-v1 || ! "$qualification_first_frame_sha256" =~ ^[a-fA-F0-9]{64}$ ]]; then
  echo 'A first-frame digest requires qualification-sg-v1 and exactly 64 hexadecimal characters, or must be unset.' >&2
  exit 2
fi
stripe_livemode="${STRIPE_LIVEMODE:-false}"
if [[ "$stripe_livemode" != false && "$stripe_livemode" != true ]]; then
  echo 'STRIPE_LIVEMODE must be exactly false or true; sandbox is the default.' >&2
  exit 2
fi
database_binding="DATABASE_URL=${OPENGEN_DATABASE_SECRET}:${OPENGEN_SECRET_VERSION}"
api_bindings="${database_binding},MR_API_TOKEN=${OPENGEN_API_TOKEN_SECRET}:${OPENGEN_SECRET_VERSION}"
worker_bindings="$database_binding"
if [[ -n "$provider_bindings" ]]; then
  api_bindings+=",${provider_bindings}"
  worker_bindings+=",${provider_bindings}"
fi
if [[ -n "$api_secret_bindings" ]]; then api_bindings+=",${api_secret_bindings}"; fi
shared_runtime_env=",OPENGEN_PROVIDER_EXECUTION_ENABLED=${provider_execution_enabled},OPENGEN_EXECUTION_SCOPE=${execution_scope}"
if [[ -n "$qualification_first_frame_sha256" ]]; then shared_runtime_env+=",OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256=${qualification_first_frame_sha256}"; fi
if [[ -n "$input_retention" ]]; then shared_runtime_env+=",MR_INPUT_RETENTION_MS=${input_retention}"; fi
if [[ -n "$email_endpoint" ]]; then
  shared_runtime_env+=",OPENGEN_NOTIFICATION_EMAIL_ENDPOINT=${email_endpoint},OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED=${email_idempotency}"
fi
common=(--project "$OPENGEN_PROJECT_ID" --region "$OPENGEN_REGION" --image "$OPENGEN_API_IMAGE" --set-cloudsql-instances "$OPENGEN_CLOUDSQL_CONNECTION" --cpu 1 --memory 512Mi --quiet)
api=(gcloud run deploy opengen-api "${common[@]}" --service-account "$OPENGEN_API_RUNTIME_SA" --port 4310 --min-instances 0 --max-instances 2 --concurrency 40 --execution-environment gen2 --invoker-iam-check --no-allow-unauthenticated --set-env-vars "HOST=0.0.0.0,MR_WORKSPACE_ID=local,MR_INITIAL_BALANCE_MICROS=0,MR_DATABASE_POOL_SIZE=4,METRICS_ORIGIN_REGION=${OPENGEN_REGION},OPENGEN_PUBLIC_URL=${OPENGEN_PUBLIC_URL},STRIPE_LIVEMODE=${stripe_livemode}${shared_runtime_env}" --set-secrets "$api_bindings")
worker=(gcloud run worker-pools deploy opengen-worker "${common[@]}" --service-account "$OPENGEN_WORKER_RUNTIME_SA" --instances 1 --command npm --args run,worker --set-env-vars "MR_DATABASE_POOL_SIZE=4,METRICS_ORIGIN_REGION=${OPENGEN_REGION},OPENGEN_PUBLIC_URL=${OPENGEN_PUBLIC_URL}${shared_runtime_env}" --set-secrets "$worker_bindings")

if [[ "$mode" == "--plan" ]]; then
  echo 'Planned commands (identifiers and secret references only):'
  printf '%q ' "${api[@]}"; printf '\n'
  printf '%q ' "${worker[@]}"; printf '\n'
  echo 'No cloud mutation performed. Cloud SQL, IAM, federation and production authentication are prerequisites.'
  exit 0
fi
if [[ "${OPENGEN_BILLABLE_RUNTIME_APPROVED:-no}" != "yes" ]]; then
  echo 'Runtime deployment requires an explicit reviewed cost/region/resource decision. Set OPENGEN_BILLABLE_RUNTIME_APPROVED=yes after that review.' >&2
  exit 2
fi
if [[ "$(gcloud billing projects describe "$OPENGEN_PROJECT_ID" --format='value(billingEnabled)')" != 'True' ]]; then
  echo 'Billing is not enabled. This script does not attach a billing account.' >&2
  exit 2
fi
"${api[@]}"
"${worker[@]}"
