#!/usr/bin/env bash
# Run Prisma migrate deploy for the dashboard database (hyrelog-dashboard repo).
#
# Required:
#   DATABASE_URL   postgresql://... for dashboard RDS
#   DASHBOARD_ROOT path to hyrelog-dashboard repository root
#
# Optional:
#   CONFIRM=YES
#
set -euo pipefail

if [[ "${CONFIRM:-}" != "YES" ]]; then
  echo "Set CONFIRM=YES to run."
  exit 1
fi

: "${DATABASE_URL:?Set DATABASE_URL for dashboard DB}"
: "${DASHBOARD_ROOT:?Set DASHBOARD_ROOT to hyrelog-dashboard repo path}"

cd "$DASHBOARD_ROOT"
npx prisma migrate deploy
echo "Dashboard migrations complete."
