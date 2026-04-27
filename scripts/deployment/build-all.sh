#!/usr/bin/env bash
# Build all three container images locally (no push).
# Run from hyrelog-api or hyrelog-dashboard repo root as appropriate.
#
# Usage (API + worker, from hyrelog-api root):
#   ./scripts/deployment/build-all.sh
# Dashboard (from hyrelog-dashboard root):
#   (see dashboard image build in push-images or CI)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> Hyrelog-api root: $ROOT"
echo "==> Building API image..."
docker build -f services/api/Dockerfile -t hyrelog-api:local .
echo "==> Building worker image..."
docker build -f services/worker/Dockerfile -t hyrelog-worker:local .
echo "Done. Tags: hyrelog-api:local, hyrelog-worker:local"
echo "Dashboard: run from hyrelog-dashboard: docker build -t hyrelog-dashboard:local ."
