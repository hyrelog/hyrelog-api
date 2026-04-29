#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Bootstrap all required HyreLog Secrets Manager values from one template file.

Usage:
  bash scripts/deployment/bootstrap-secrets-from-template.sh <template-env-file>

Example:
  cp scripts/deployment/secrets-bootstrap.template.env .secrets.bootstrap.env
  # edit .secrets.bootstrap.env with real values
  bash scripts/deployment/bootstrap-secrets-from-template.sh .secrets.bootstrap.env

What this script does:
  1) Loads your template env file
  2) URL-encodes DB passwords
  3) Builds DATABASE_URL, DATABASE_URL_US/EU/UK/AU
  4) Validates and creates/updates required Secrets Manager secrets in PRIMARY_REGION
  5) Optionally creates S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY secrets
  6) Prints Name + ARN table for copy/paste into task definitions
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

TEMPLATE_FILE="$1"
if [[ ! -f "$TEMPLATE_FILE" ]]; then
  echo "Template file not found: $TEMPLATE_FILE" >&2
  exit 1
fi

# shellcheck source=/dev/null
source "$TEMPLATE_FILE"

bool_is_true() {
  [[ "${1:-}" == "true" || "${1:-}" == "TRUE" || "${1:-}" == "1" ]]
}

require_var() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    echo "Missing required value in template: $key" >&2
    exit 1
  fi
}

require_var PROJECT_PREFIX
require_var PRIMARY_REGION
require_var DB_USER
require_var DASHBOARD_DB_HOST
require_var DASHBOARD_DB_PORT
require_var DASHBOARD_DB_NAME
require_var DASHBOARD_DB_PASSWORD
require_var US_DB_HOST
require_var US_DB_PORT
require_var US_DB_NAME
require_var US_DB_PASSWORD
require_var EU_DB_HOST
require_var EU_DB_PORT
require_var EU_DB_NAME
require_var EU_DB_PASSWORD
require_var UK_DB_HOST
require_var UK_DB_PORT
require_var UK_DB_NAME
require_var UK_DB_PASSWORD
require_var AU_DB_HOST
require_var AU_DB_PORT
require_var AU_DB_NAME
require_var AU_DB_PASSWORD

if ! command -v python >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
  echo "python or python3 is required for URL encoding." >&2
  exit 1
fi

PYTHON_BIN="python"
if ! command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python3"
fi

urlencode() {
  local raw="$1"
  "$PYTHON_BIN" - "$raw" <<'PY'
import sys
import urllib.parse
print(urllib.parse.quote(sys.argv[1], safe=''))
PY
}

maybe_generate() {
  local key="$1"
  local bytes="$2"
  if [[ -n "${!key:-}" ]]; then
    return
  fi
  if bool_is_true "${AUTO_GENERATE_IF_MISSING:-false}"; then
    if ! command -v openssl >/dev/null 2>&1; then
      echo "openssl is required to auto-generate missing secret: $key" >&2
      exit 1
    fi
    printf -v "$key" '%s' "$(openssl rand -hex "$bytes")"
    echo "Generated missing value for ${key}"
  fi
}

maybe_generate DASHBOARD_SERVICE_TOKEN 24
maybe_generate API_KEY_SECRET 24
maybe_generate HYRELOG_API_KEY_SECRET 24
maybe_generate INTERNAL_TOKEN 24
maybe_generate WEBHOOK_SECRET_ENCRYPTION_KEY 32

require_var DASHBOARD_SERVICE_TOKEN
require_var API_KEY_SECRET
require_var HYRELOG_API_KEY_SECRET
require_var INTERNAL_TOKEN
require_var WEBHOOK_SECRET_ENCRYPTION_KEY

if [[ "$API_KEY_SECRET" != "$HYRELOG_API_KEY_SECRET" ]]; then
  echo "API_KEY_SECRET and HYRELOG_API_KEY_SECRET must be identical." >&2
  exit 1
fi

if [[ ! "$WEBHOOK_SECRET_ENCRYPTION_KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "WEBHOOK_SECRET_ENCRYPTION_KEY must be exactly 64 hex characters." >&2
  exit 1
fi

build_database_url() {
  local user="$1"
  local raw_password="$2"
  local host="$3"
  local port="$4"
  local dbname="$5"
  local encoded_password
  encoded_password="$(urlencode "$raw_password")"
  printf 'postgresql://%s:%s@%s:%s/%s?sslmode=require' \
    "$user" "$encoded_password" "$host" "$port" "$dbname"
}

DATABASE_URL="$(build_database_url "$DB_USER" "$DASHBOARD_DB_PASSWORD" "$DASHBOARD_DB_HOST" "$DASHBOARD_DB_PORT" "$DASHBOARD_DB_NAME")"
DATABASE_URL_US="$(build_database_url "$DB_USER" "$US_DB_PASSWORD" "$US_DB_HOST" "$US_DB_PORT" "$US_DB_NAME")"
DATABASE_URL_EU="$(build_database_url "$DB_USER" "$EU_DB_PASSWORD" "$EU_DB_HOST" "$EU_DB_PORT" "$EU_DB_NAME")"
DATABASE_URL_UK="$(build_database_url "$DB_USER" "$UK_DB_PASSWORD" "$UK_DB_HOST" "$UK_DB_PORT" "$UK_DB_NAME")"
DATABASE_URL_AU="$(build_database_url "$DB_USER" "$AU_DB_PASSWORD" "$AU_DB_HOST" "$AU_DB_PORT" "$AU_DB_NAME")"

upsert_secret() {
  local name="$1"
  local value="$2"
  local region="$3"

  if aws secretsmanager describe-secret --secret-id "$name" --region "$region" >/dev/null 2>&1; then
    aws secretsmanager update-secret \
      --secret-id "$name" \
      --secret-string "$value" \
      --region "$region" >/dev/null
    echo "Updated: ${name}"
  else
    aws secretsmanager create-secret \
      --name "$name" \
      --secret-string "$value" \
      --region "$region" >/dev/null
    echo "Created: ${name}"
  fi
}

upsert_secret "${PROJECT_PREFIX}/DATABASE_URL" "${DATABASE_URL}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/DATABASE_URL_US" "${DATABASE_URL_US}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/DATABASE_URL_EU" "${DATABASE_URL_EU}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/DATABASE_URL_UK" "${DATABASE_URL_UK}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/DATABASE_URL_AU" "${DATABASE_URL_AU}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/DASHBOARD_SERVICE_TOKEN" "${DASHBOARD_SERVICE_TOKEN}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/API_KEY_SECRET" "${API_KEY_SECRET}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/HYRELOG_API_KEY_SECRET" "${HYRELOG_API_KEY_SECRET}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/INTERNAL_TOKEN" "${INTERNAL_TOKEN}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/WEBHOOK_SECRET_ENCRYPTION_KEY" "${WEBHOOK_SECRET_ENCRYPTION_KEY}" "${PRIMARY_REGION}"

if bool_is_true "${INCLUDE_STATIC_S3_KEYS:-false}"; then
  require_var S3_ACCESS_KEY_ID
  require_var S3_SECRET_ACCESS_KEY
  upsert_secret "${PROJECT_PREFIX}/S3_ACCESS_KEY_ID" "${S3_ACCESS_KEY_ID}" "${PRIMARY_REGION}"
  upsert_secret "${PROJECT_PREFIX}/S3_SECRET_ACCESS_KEY" "${S3_SECRET_ACCESS_KEY}" "${PRIMARY_REGION}"
fi

echo
echo "Done. Secret ARNs:"
aws secretsmanager list-secrets \
  --region "${PRIMARY_REGION}" \
  --query "SecretList[?starts_with(Name, '${PROJECT_PREFIX}/')].[Name,ARN]" \
  --output table
