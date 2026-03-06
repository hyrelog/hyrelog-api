#!/usr/bin/env bash
# HyreLog - Reset All Region Databases to Default (Zero Data)
# Clears all companies, workspaces, events, webhooks, etc. and re-seeds only plans.
#
# Prerequisites: Migrations applied to all regions (npm run prisma:migrate:all).
#
# Usage: from repo root
#   ./scripts/reset-all-regions.sh
#   or: npm run seed:reset:all
#
# Override defaults with env: DB_HOST, DB_USER, DB_PASS (defaults: localhost, hyrelog, hyrelog)

set -e

DB_HOST="${DB_HOST:-localhost}"
DB_USER="${DB_USER:-hyrelog}"
DB_PASS="${DB_PASS:-hyrelog}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
API_DIR="$ROOT_DIR/services/api"

echo "HyreLog - Reset All Regions to Default (Zero Data)"
echo "===================================================="
echo ""

for region in US EU UK AU; do
  case $region in
    US) port=54321; db=hyrelog_us ;;
    EU) port=54322; db=hyrelog_eu ;;
    UK) port=54323; db=hyrelog_uk ;;
    AU) port=54324; db=hyrelog_au ;;
  esac
  echo "Resetting $region region..."
  echo "  Database: $db on $DB_HOST:$port"
  export DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${port}/${db}"
  export SEED_RESET_REGION_LABEL="$region"
  (cd "$API_DIR" && npx tsx prisma/seed-reset.ts) || exit 1
  echo "  Success: $region reset"
  echo ""
done

echo "All regions reset successfully. No companies or API keys remain; plans only."
