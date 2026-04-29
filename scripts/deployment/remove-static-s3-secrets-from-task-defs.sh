#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Remove static S3 key secrets from ECS task definition JSON files.

This script performs only Step B:
  - removes secrets named S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY
  - keeps all other env vars and secrets untouched

Default target files:
  infra/ecs/task-definition-api.json
  infra/ecs/task-definition-worker.json
  infra/ecs/task-definition-dashboard.json

Usage:
  bash scripts/deployment/remove-static-s3-secrets-from-task-defs.sh

Optional:
  TARGET_FILES="infra/ecs/task-definition-api.json infra/ecs/task-definition-worker.json" \
  bash scripts/deployment/remove-static-s3-secrets-from-task-defs.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

if [[ -n "${TARGET_FILES:-}" ]]; then
  # shellcheck disable=SC2206
  files=( ${TARGET_FILES} )
else
  files=(
    "infra/ecs/task-definition-api.json"
    "infra/ecs/task-definition-worker.json"
    "infra/ecs/task-definition-dashboard.json"
  )
fi

if ! command -v python >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
  echo "python or python3 is required." >&2
  exit 1
fi

PYTHON_BIN="python"
if ! command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python3"
fi

for f in "${files[@]}"; do
  if [[ ! -f "$f" ]]; then
    echo "Skip (not found): $f"
    continue
  fi

  "$PYTHON_BIN" - "$f" <<'PY'
import json
import sys
from pathlib import Path

target = Path(sys.argv[1])
obj = json.loads(target.read_text(encoding="utf-8"))

remove_names = {"S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"}
removed = 0

for container in obj.get("containerDefinitions", []):
    secrets = container.get("secrets")
    if not isinstance(secrets, list):
        continue
    before = len(secrets)
    container["secrets"] = [
        s for s in secrets
        if not (isinstance(s, dict) and s.get("name") in remove_names)
    ]
    removed += before - len(container["secrets"])

target.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")
print(f"{target}: removed {removed} static S3 secret entries")
PY
done

echo
echo "Done. Step B complete (task-definition files updated)."
echo "Next (later, after Phase 7 image push): register task definitions and redeploy services."
