#!/usr/bin/env bash
# Light HTTP smoke checks for production URLs (no secrets in output).
# Usage:
#   DASHBOARD_URL=https://app.hyrelog.com API_URL=https://api.hyrelog.com ./scripts/deployment/smoke-test-production.sh
#
set -euo pipefail

DASHBOARD_URL="${DASHBOARD_URL:-https://app.hyrelog.com}"
API_URL="${API_URL:-https://api.hyrelog.com}"

code_dash=$(curl -sS -o /dev/null -w "%{http_code}" "$DASHBOARD_URL" || true)
code_health=$(curl -sS -o /dev/null -w "%{http_code}" "$API_URL/health" || true)
body_health=$(curl -sS "$API_URL/health" || true)

echo "Dashboard $DASHBOARD_URL -> HTTP $code_dash"
echo "API $API_URL/health -> HTTP $code_health"
echo "Body: $body_health"

if [[ "$code_health" != "200" ]]; then
  echo "FAIL: /health not 200"
  exit 1
fi
echo "OK (basic). Run manual /dashboard and authenticated tests (see docs/deployment/smoke-tests.md)."
