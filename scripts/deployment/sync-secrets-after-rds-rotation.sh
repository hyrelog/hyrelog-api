#!/usr/bin/env bash
# After RDS master password rotation:
# - API/worker: pick up new password via DB_* secrets on ECS redeploy (entrypoint builds DATABASE_URL_*).
# - Dashboard: still uses hyrelog-prod/DATABASE_URL (full URL) — must be rebuilt from the dashboard RDS secret.
#
# Usage (from hyrelog-api repo root, AWS CLI authenticated):
#   bash scripts/deployment/sync-secrets-after-rds-rotation.sh
#
# Optional overrides:
#   PRIMARY_REGION=ap-southeast-2 ECS_CLUSTER=hyrelog-prod-ecs
#   DASHBOARD_RDS_SECRET_ARN='arn:aws:secretsmanager:...'
#   DASHBOARD_DB_HOST='hyrelog-prod-dashboard....rds.amazonaws.com'
#   DASHBOARD_DB_PORT=5432 DASHBOARD_DB_NAME=hyrelog_dashboard
#   SYNC_REGIONAL_URL_SECRETS=true   # also refresh hyrelog-prod/DATABASE_URL_US|EU|UK|AU (migration tooling)
#   REDEPLOY_SERVICES=true           # force-new-deployment api, worker, dashboard
set -euo pipefail

PRIMARY_REGION="${PRIMARY_REGION:-ap-southeast-2}"
PROJECT_PREFIX="${PROJECT_PREFIX:-hyrelog-prod}"
ECS_CLUSTER="${ECS_CLUSTER:-hyrelog-prod-ecs}"
ECS_SERVICES="${ECS_SERVICES:-hyrelog-api,hyrelog-worker,hyrelog-dashboard}"

DASHBOARD_RDS_SECRET_ARN="${DASHBOARD_RDS_SECRET_ARN:-arn:aws:secretsmanager:ap-southeast-2:163436765242:secret:rds!db-8790c16b-e0de-4e58-b2d6-200c1221aa86-6PHmH7}"
DASHBOARD_DB_HOST="${DASHBOARD_DB_HOST:-hyrelog-prod-dashboard.c9umosqssoce.ap-southeast-2.rds.amazonaws.com}"
DASHBOARD_DB_PORT="${DASHBOARD_DB_PORT:-5432}"
DASHBOARD_DB_NAME="${DASHBOARD_DB_NAME:-hyrelog_dashboard}"

SYNC_REGIONAL_URL_SECRETS="${SYNC_REGIONAL_URL_SECRETS:-false}"
REDEPLOY_SERVICES="${REDEPLOY_SERVICES:-true}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

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

build_url_from_rds_secret() {
  local aws_region="$1"
  local secret_id="$2"
  local host="$3"
  local port="${4:-5432}"
  local dbname="$5"
  local json user raw_pass enc_pass
  json="$(aws secretsmanager get-secret-value --secret-id "$secret_id" --region "$aws_region" --query SecretString --output text)"
  user="$(echo "$json" | "$PYTHON_BIN" -c 'import json,sys; print(json.load(sys.stdin)["username"])')"
  raw_pass="$(echo "$json" | "$PYTHON_BIN" -c 'import json,sys; print(json.load(sys.stdin)["password"])')"
  enc_pass="$(urlencode "$raw_pass")"
  printf 'postgresql://%s:%s@%s:%s/%s?sslmode=require' "$user" "$enc_pass" "$host" "$port" "$dbname"
}

upsert_secret() {
  local name="$1"
  local value="$2"
  local region="$3"
  if aws secretsmanager describe-secret --secret-id "$name" --region "$region" >/dev/null 2>&1; then
    aws secretsmanager update-secret --secret-id "$name" --secret-string "$value" --region "$region" >/dev/null
    echo "Updated secret: ${name}"
  else
    aws secretsmanager create-secret --name "$name" --secret-string "$value" --region "$region" >/dev/null
    echo "Created secret: ${name}"
  fi
}

echo "==> Syncing ${PROJECT_PREFIX}/DATABASE_URL from dashboard RDS secret..."
dashboard_url="$(build_url_from_rds_secret "$PRIMARY_REGION" "$DASHBOARD_RDS_SECRET_ARN" "$DASHBOARD_DB_HOST" "$DASHBOARD_DB_PORT" "$DASHBOARD_DB_NAME")"
upsert_secret "${PROJECT_PREFIX}/DATABASE_URL" "$dashboard_url" "$PRIMARY_REGION"

if [[ "$SYNC_REGIONAL_URL_SECRETS" == "true" ]]; then
  echo "==> Syncing regional DATABASE_URL_* secrets (optional; API runtime uses RDS JSON secrets)..."
  # shellcheck source=/dev/null
  source "$SCRIPT_DIR/export-api-phase11-database-urls-from-rds-secrets.sh"
  upsert_secret "${PROJECT_PREFIX}/DATABASE_URL_US" "$DATABASE_URL_US" "$PRIMARY_REGION"
  upsert_secret "${PROJECT_PREFIX}/DATABASE_URL_EU" "$DATABASE_URL_EU" "$PRIMARY_REGION"
  upsert_secret "${PROJECT_PREFIX}/DATABASE_URL_UK" "$DATABASE_URL_UK" "$PRIMARY_REGION"
  upsert_secret "${PROJECT_PREFIX}/DATABASE_URL_AU" "$DATABASE_URL_AU" "$PRIMARY_REGION"
fi

if [[ "$REDEPLOY_SERVICES" == "true" ]]; then
  echo "==> Forcing ECS redeploy: ${ECS_SERVICES}"
  IFS=',' read -r -a services <<<"$ECS_SERVICES"
  for svc in "${services[@]}"; do
    svc="$(echo "$svc" | xargs)"
    [[ -z "$svc" ]] && continue
    aws ecs update-service \
      --region "$PRIMARY_REGION" \
      --cluster "$ECS_CLUSTER" \
      --service "$svc" \
      --force-new-deployment >/dev/null
    echo "  triggered: ${svc}"
  done
  echo "==> Waiting for services-stable..."
  aws ecs wait services-stable \
    --region "$PRIMARY_REGION" \
    --cluster "$ECS_CLUSTER" \
    --services "${services[@]}"
  echo "All services stable."
fi

echo "Done. Dashboard tasks will use the updated ${PROJECT_PREFIX}/DATABASE_URL on next start."
