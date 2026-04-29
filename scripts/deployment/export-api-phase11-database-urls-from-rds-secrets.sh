#!/usr/bin/env bash
# Build DATABASE_URL_US|EU|UK|AU in the shell for Phase 11 / regional Prisma migrations.
# Uses the same ingredients as ECS (RDS-managed Secrets Manager secrets + static host/port/db).
#
# Prerequisites:
#   - aws CLI authenticated with permission to secretsmanager:GetSecretValue in EACH
#     region where RDS secrets live (us-east-1, eu-west-1, eu-west-2, ap-southeast-2).
#
# Configure by exporting the RDS secret identifiers and connection fields BEFORE sourcing this file:
#
#   export RDS_SECRET_ID_US="<arn-or-name from task-definition-api secrets DB_PASSWORD_US minus :password::>"
# Actually use the SAME secret ARN as in task-definition (without the :username::/:password:: suffix)
#
# Minimal example: paste ARNs from infra/ecs/task-definition-api.json ("DB_PASSWORD_*" valueFrom).
# Use the ARN only — drop any ECS suffix like ":password::" at the end.
#
#   export RDS_SECRET_ID_US='arn:aws:secretsmanager:us-east-1:ACCOUNT:secret:rds!db-xxxx'
#   export RDS_SECRET_ID_EU='arn:aws:secretsmanager:eu-west-1:ACCOUNT:secret:rds!db-xxxx'
#   ...
#   export DB_HOST_US='...'
#   export DB_PORT_US='5432'
#   ...
#
# Usage:
#   source scripts/deployment/export-api-phase11-database-urls-from-rds-secrets.sh
#
# Do NOT use errexit (set -e) in this file while it is meant to be sourced: if AWS or URL
# assembly fails inside $(...), bash would exit your entire Git Bash window.
set -uo pipefail

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "Source this script so it exports DATABASE_URL_* into your shell:" >&2
  echo '  source scripts/deployment/export-api-phase11-database-urls-from-rds-secrets.sh' >&2
  exit 1
fi

PYTHON_BIN="python3"
if command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
fi

urlencode() {
  "$PYTHON_BIN" - <<'PY' "$1"
import sys
import urllib.parse
print(urllib.parse.quote(sys.argv[1], safe=''))
PY
}

# build_url_from_rds_secret <aws_region_for_secret> <secret_id_arn_or_name> <host> <port> <dbname>
build_url_from_rds_secret() {
  local aws_region="$1"
  local secret_id="$2"
  local host="$3"
  local port="${4:-5432}"
  local dbname="$5"
  local json user raw_pass enc_pass
  if ! json="$(aws secretsmanager get-secret-value --secret-id "$secret_id" --region "$aws_region" --query SecretString --output text)"; then
    echo "export-api-phase11: aws get-secret-value failed (region=${aws_region} secret=${secret_id})" >&2
    return 1
  fi
  if [[ -z "$json" ]]; then
    echo "export-api-phase11: empty SecretString (region=${aws_region})" >&2
    return 1
  fi
  user="$(echo "$json" | "$PYTHON_BIN" -c 'import json,sys; print(json.load(sys.stdin)["username"])')"
  raw_pass="$(echo "$json" | "$PYTHON_BIN" -c 'import json,sys; print(json.load(sys.stdin)["password"])')"
  enc_pass="$(urlencode "$raw_pass")"
  printf 'postgresql://%s:%s@%s:%s/%s?sslmode=require' "$user" "$enc_pass" "$host" "$port" "$dbname"
}

require_var() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    echo "Missing required env: $key" >&2
    return 1
  fi
}

RDS_REGION_US="${RDS_REGION_US:-${DB_REGION_US:-us-east-1}}"
RDS_REGION_EU="${RDS_REGION_EU:-${DB_REGION_EU:-eu-west-1}}"
RDS_REGION_UK="${RDS_REGION_UK:-${DB_REGION_UK:-eu-west-2}}"
RDS_REGION_AU="${RDS_REGION_AU:-${DB_REGION_AU:-ap-southeast-2}}"

require_var RDS_SECRET_ID_US || return 1
require_var RDS_SECRET_ID_EU || return 1
require_var RDS_SECRET_ID_UK || return 1
require_var RDS_SECRET_ID_AU || return 1
require_var DB_HOST_US || return 1
require_var DB_HOST_EU || return 1
require_var DB_HOST_UK || return 1
require_var DB_HOST_AU || return 1

DB_PORT_US="${DB_PORT_US:-5432}"
DB_PORT_EU="${DB_PORT_EU:-5432}"
DB_PORT_UK="${DB_PORT_UK:-5432}"
DB_PORT_AU="${DB_PORT_AU:-5432}"

require_var DB_NAME_US || return 1
require_var DB_NAME_EU || return 1
require_var DB_NAME_UK || return 1
require_var DB_NAME_AU || return 1

if ! DATABASE_URL_US="$(build_url_from_rds_secret "$RDS_REGION_US" "$RDS_SECRET_ID_US" "$DB_HOST_US" "$DB_PORT_US" "$DB_NAME_US")"; then
  echo "Failed to build DATABASE_URL_US" >&2
  return 1
fi
if ! DATABASE_URL_EU="$(build_url_from_rds_secret "$RDS_REGION_EU" "$RDS_SECRET_ID_EU" "$DB_HOST_EU" "$DB_PORT_EU" "$DB_NAME_EU")"; then
  echo "Failed to build DATABASE_URL_EU" >&2
  return 1
fi
if ! DATABASE_URL_UK="$(build_url_from_rds_secret "$RDS_REGION_UK" "$RDS_SECRET_ID_UK" "$DB_HOST_UK" "$DB_PORT_UK" "$DB_NAME_UK")"; then
  echo "Failed to build DATABASE_URL_UK" >&2
  return 1
fi
if ! DATABASE_URL_AU="$(build_url_from_rds_secret "$RDS_REGION_AU" "$RDS_SECRET_ID_AU" "$DB_HOST_AU" "$DB_PORT_AU" "$DB_NAME_AU")"; then
  echo "Failed to build DATABASE_URL_AU" >&2
  return 1
fi

export DATABASE_URL_US DATABASE_URL_EU DATABASE_URL_UK DATABASE_URL_AU

echo "Exported DATABASE_URL_US DATABASE_URL_EU DATABASE_URL_UK DATABASE_URL_AU (values not printed)." >&2
