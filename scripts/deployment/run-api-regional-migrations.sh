#!/usr/bin/env bash
# Run `prisma migrate deploy` for all four API regional databases.
# Must be executed with network access to every RDS (VPN, same VPC, or ECS task).
#
# Required env (each a full postgresql:// URL, ssl as needed):
#   DATABASE_URL_US
#   DATABASE_URL_EU
#   DATABASE_URL_UK
#   DATABASE_URL_AU
#
# Optional:
#   API_ROOT  path to hyrelog-api repository root (default: two levels up from this script)
#   CONFIRM   must be YES to run (prevents accidents)
#
set -euo pipefail

if [[ "${CONFIRM:-}" != "YES" ]]; then
  echo "Set CONFIRM=YES to run migrations against the four regional URLs (destructive in wrong env)."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="${API_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
SVC_API="$API_ROOT/services/api"

for v in DATABASE_URL_US DATABASE_URL_EU DATABASE_URL_UK DATABASE_URL_AU; do
  if [[ -z "${!v:-}" ]]; then
    echo "Missing $v"
    exit 1
  fi
done

export PATH="$API_ROOT/node_modules/.bin:$PATH"
cd "$SVC_API"

for region in US EU UK AU; do
  var="DATABASE_URL_${region}"
  url="${!var}"
  echo "==> Migrating region $region"
  export DATABASE_URL="$url"
  npx prisma migrate deploy
done

echo "All four regions migrated successfully."
