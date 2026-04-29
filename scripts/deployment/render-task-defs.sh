#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Render ECS task definition templates with real account/region/secret values.

Usage:
  bash scripts/deployment/render-task-defs.sh [--register]

Required environment variables:
  AWS_ACCOUNT_ID
  PRIMARY_REGION
  PROJECT_PREFIX
  IMAGE_TAG

Optional environment variables:
  ECR_API_REPO            (default: hyrelog-api)
  ECR_WORKER_REPO         (default: hyrelog-worker)
  ECR_DASHBOARD_REPO      (default: hyrelog-dashboard)
  EXECUTION_ROLE_NAME     (default: ${PROJECT_PREFIX}-ecs-execution-role)
  TASK_ROLE_NAME          (default: ${PROJECT_PREFIX}-ecs-task-role)
  S3_BUCKET_US            (default: unchanged placeholder)
  S3_BUCKET_EU            (default: unchanged placeholder)
  S3_BUCKET_UK            (default: unchanged placeholder)
  S3_BUCKET_AU            (default: unchanged placeholder)

Output:
  infra/ecs/rendered/task-definition-api.rendered.json
  infra/ecs/rendered/task-definition-worker.rendered.json
  infra/ecs/rendered/task-definition-dashboard.rendered.json

If --register is provided, script also registers all three task definitions.
EOF
}

REGISTER=false
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ "${1:-}" == "--register" ]]; then
  REGISTER=true
fi

required=(AWS_ACCOUNT_ID PRIMARY_REGION PROJECT_PREFIX IMAGE_TAG)
for k in "${required[@]}"; do
  if [[ -z "${!k:-}" ]]; then
    echo "Missing required env var: ${k}" >&2
    exit 1
  fi
done

ECR_API_REPO="${ECR_API_REPO:-hyrelog-api}"
ECR_WORKER_REPO="${ECR_WORKER_REPO:-hyrelog-worker}"
ECR_DASHBOARD_REPO="${ECR_DASHBOARD_REPO:-hyrelog-dashboard}"
EXECUTION_ROLE_NAME="${EXECUTION_ROLE_NAME:-${PROJECT_PREFIX}-ecs-execution-role}"
TASK_ROLE_NAME="${TASK_ROLE_NAME:-${PROJECT_PREFIX}-ecs-task-role}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE_DIR="${ROOT_DIR}/infra/ecs"
OUT_DIR="${TEMPLATE_DIR}/rendered"
mkdir -p "${OUT_DIR}"

for role_name in "${EXECUTION_ROLE_NAME}" "${TASK_ROLE_NAME}"; do
  aws iam get-role --role-name "${role_name}" >/dev/null
done

export AWS_ACCOUNT_ID PRIMARY_REGION PROJECT_PREFIX IMAGE_TAG
export ECR_API_REPO ECR_WORKER_REPO ECR_DASHBOARD_REPO
export EXECUTION_ROLE_NAME TASK_ROLE_NAME
export S3_BUCKET_US="${S3_BUCKET_US:-REPLACE_HYRELOG_ARCHIVE_US}"
export S3_BUCKET_EU="${S3_BUCKET_EU:-REPLACE_HYRELOG_ARCHIVE_EU}"
export S3_BUCKET_UK="${S3_BUCKET_UK:-REPLACE_HYRELOG_ARCHIVE_UK}"
export S3_BUCKET_AU="${S3_BUCKET_AU:-REPLACE_HYRELOG_ARCHIVE_AU}"
export TEMPLATE_DIR OUT_DIR

python - <<'PY'
import json
import os
from pathlib import Path

template_dir = Path(os.environ["TEMPLATE_DIR"])
out_dir = Path(os.environ["OUT_DIR"])

account = os.environ["AWS_ACCOUNT_ID"]
region = os.environ["PRIMARY_REGION"]
project_prefix = os.environ["PROJECT_PREFIX"]
image_tag = os.environ["IMAGE_TAG"]

exec_role_arn = f"arn:aws:iam::{account}:role/{os.environ['EXECUTION_ROLE_NAME']}"
task_role_arn = f"arn:aws:iam::{account}:role/{os.environ['TASK_ROLE_NAME']}"

api_img = f"{account}.dkr.ecr.{region}.amazonaws.com/{os.environ['ECR_API_REPO']}:{image_tag}"
worker_img = f"{account}.dkr.ecr.{region}.amazonaws.com/{os.environ['ECR_WORKER_REPO']}:{image_tag}"
dash_img = f"{account}.dkr.ecr.{region}.amazonaws.com/{os.environ['ECR_DASHBOARD_REPO']}:{image_tag}"

s3_map = {
    "REPLACE_HYRELOG_ARCHIVE_US": os.environ["S3_BUCKET_US"],
    "REPLACE_HYRELOG_ARCHIVE_EU": os.environ["S3_BUCKET_EU"],
    "REPLACE_HYRELOG_ARCHIVE_UK": os.environ["S3_BUCKET_UK"],
    "REPLACE_HYRELOG_ARCHIVE_AU": os.environ["S3_BUCKET_AU"],
}

files = [
    ("task-definition-api.json", "task-definition-api.rendered.json", api_img),
    ("task-definition-worker.json", "task-definition-worker.rendered.json", worker_img),
    ("task-definition-dashboard.json", "task-definition-dashboard.rendered.json", dash_img),
]

def rewrite_secret_valuefrom(value: str) -> str:
    value = value.replace("ACCOUNT_ID", account).replace("REGION", region)
    value = value.replace(":secret:hyrelog/", f":secret:{project_prefix}/")
    value = value.replace("/DASHBOARD_DATABASE_URL", "/DATABASE_URL")
    return value

for src_name, out_name, image in files:
    src = template_dir / src_name
    obj = json.loads(src.read_text(encoding="utf-8"))

    obj["executionRoleArn"] = exec_role_arn
    obj["taskRoleArn"] = task_role_arn

    for c in obj.get("containerDefinitions", []):
        c["image"] = image
        if "logConfiguration" in c:
            opts = c["logConfiguration"].get("options", {})
            if "awslogs-region" in opts:
                opts["awslogs-region"] = region

        for env in c.get("environment", []):
            v = env.get("value")
            if isinstance(v, str):
                env["value"] = s3_map.get(v, v)

        for sec in c.get("secrets", []):
            vf = sec.get("valueFrom")
            if isinstance(vf, str):
                sec["valueFrom"] = rewrite_secret_valuefrom(vf)

    out = out_dir / out_name
    out.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")
    print(f"Rendered: {out}")
PY

echo
echo "Rendered files are in: ${OUT_DIR}"
echo "Next:"
echo "  aws ecs register-task-definition --cli-input-json file://infra/ecs/rendered/task-definition-api.rendered.json --region ${PRIMARY_REGION}"
echo "  aws ecs register-task-definition --cli-input-json file://infra/ecs/rendered/task-definition-worker.rendered.json --region ${PRIMARY_REGION}"
echo "  aws ecs register-task-definition --cli-input-json file://infra/ecs/rendered/task-definition-dashboard.rendered.json --region ${PRIMARY_REGION}"

if [[ "${REGISTER}" == "true" ]]; then
  aws ecs register-task-definition --cli-input-json file://infra/ecs/rendered/task-definition-api.rendered.json --region "${PRIMARY_REGION}"
  aws ecs register-task-definition --cli-input-json file://infra/ecs/rendered/task-definition-worker.rendered.json --region "${PRIMARY_REGION}"
  aws ecs register-task-definition --cli-input-json file://infra/ecs/rendered/task-definition-dashboard.rendered.json --region "${PRIMARY_REGION}"
  echo "Registered all three task definitions."
fi
