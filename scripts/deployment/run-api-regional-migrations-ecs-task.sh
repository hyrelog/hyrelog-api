#!/usr/bin/env bash
# Run API regional Prisma migrations *inside your VPC* by starting a one-off ECS Fargate task
# that uses the same hyrelog-api image + secrets as production. Use this when your laptop hits
# P1001 ("Can't reach database server") against private RDS endpoints.
#
# Prerequisites:
#   - aws CLI; you only need general internet egress (ECS API control plane).
#   - ECS cluster + API service already healthy (same subnets/SGs that reach RDS).
#
# Required env:
#   PRIMARY_REGION           e.g. ap-southeast-2
#   ECS_CLUSTER              e.g. hyrelog-prod-ecs
#   ECS_SUBNET_IDS           comma-separated private subnet IDs used by ECS services
#   ECS_SECURITY_GROUP_IDS   comma-separated SG IDs on ECS tasks (e.g. hyrelog-prod-ecs-sg)
#
# Optional:
#   TASK_DEFINITION   default: hyrelog-api — family name or family:revision
#   CONTAINER_NAME    default: hyrelog-api
#   PRISMA_CLI_VERSION — Prisma CLI semver (default: read from services/api/package.json, else 7.2.0).
#     The prod image prunes devDependencies, so migrations use `npx --yes prisma@VERSION migrate deploy`.
#
# Example:
#   export PRIMARY_REGION=ap-southeast-2
#   export ECS_CLUSTER=hyrelog-prod-ecs
#   export ECS_SUBNET_IDS=subnet-aaa...,subnet-bbb...
#   export ECS_SECURITY_GROUP_IDS=sg-ccc...
#   bash scripts/deployment/run-api-regional-migrations-ecs-task.sh
#
# JSON helpers use Node (not Python): on Windows, `python3`/`python` often resolve to the
# Microsoft Store stub installer — use Node.js (LTS), which HyreLog already expects anyway.
#
set -euo pipefail

COMMAND_NAME=$(basename "${BASH_SOURCE[0]}")

TASK_DEFINITION="${TASK_DEFINITION:-hyrelog-api}"
CONTAINER_NAME="${CONTAINER_NAME:-hyrelog-api}"

# Matches services/api/package.json devDependencies.prisma (prod Dockerfile prunes devDeps, so npx installs CLI).
PRISMA_CLI_VERSION="${PRISMA_CLI_VERSION:-7.2.0}"

require_var() {
  local k="$1"
  if [[ -z "${!k:-}" ]]; then
    echo "${COMMAND_NAME}: missing required env var: ${k}" >&2
    exit 1
  fi
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  grep -E '^#' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

if ! NODE_BIN="$(command -v node 2>/dev/null)" || [[ -z "${NODE_BIN}" ]]; then
  echo "${COMMAND_NAME}: need 'node' in PATH — install Node.js (LTS). ECS migration scripts avoid Python so Windows Store python stubs don't open installers." >&2
  exit 1
fi

require_var PRIMARY_REGION
require_var ECS_CLUSTER
require_var ECS_SUBNET_IDS
require_var ECS_SECURITY_GROUP_IDS

comma_list_to_bracket() {
  local raw="$1"
  local trimmed first
  first=1
  printf '['
  local IFS=','
  for part in ${raw}; do
    trimmed="${part// /}"
    [[ -z "$trimmed" ]] && continue
    if [[ "${first}" -eq 1 ]]; then
      first=0
    else
      printf ','
    fi
    printf '%s' "${trimmed}"
  done
  printf ']'
}

subnet_part="$(comma_list_to_bracket "${ECS_SUBNET_IDS}")"
sg_part="$(comma_list_to_bracket "${ECS_SECURITY_GROUP_IDS}")"
NETWORK_CFG="awsvpcConfiguration={subnets=${subnet_part},securityGroups=${sg_part},assignPublicIp=DISABLED}"

COMMAND_SCRIPT=$(cat <<EOF
set -euo pipefail
cd /app/services/api
echo "==> Migrating region US"
export DATABASE_URL="\$DATABASE_URL_US"
npx --yes prisma@${PRISMA_CLI_VERSION} migrate deploy
echo "==> Migrating region EU"
export DATABASE_URL="\$DATABASE_URL_EU"
npx --yes prisma@${PRISMA_CLI_VERSION} migrate deploy
echo "==> Migrating region UK"
export DATABASE_URL="\$DATABASE_URL_UK"
npx --yes prisma@${PRISMA_CLI_VERSION} migrate deploy
echo "==> Migrating region AU"
export DATABASE_URL="\$DATABASE_URL_AU"
npx --yes prisma@${PRISMA_CLI_VERSION} migrate deploy
echo "All four regions migrated successfully."
EOF
)

export COMMAND_SCRIPT_CONTAINER_OVERRIDES="${COMMAND_SCRIPT}"
export CONTAINER_NAME_FOR_OVERRIDES="${CONTAINER_NAME}"

OVERRIDES_JSON="$("${NODE_BIN}" -e '
const n = process.env.CONTAINER_NAME_FOR_OVERRIDES;
const cmd = process.env.COMMAND_SCRIPT_CONTAINER_OVERRIDES;
if (!n || typeof cmd !== "string") {
  console.error("internal: missing override env vars");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ containerOverrides: [{ name: n, command: ["bash", "-c", cmd] }] }));
')"

echo "${COMMAND_NAME}: starting migration task..."
RUN_JSON="$(aws ecs run-task \
  --region "${PRIMARY_REGION}" \
  --cluster "${ECS_CLUSTER}" \
  --task-definition "${TASK_DEFINITION}" \
  --launch-type FARGATE \
  --network-configuration "${NETWORK_CFG}" \
  --overrides "${OVERRIDES_JSON}" \
  --no-cli-pager)"

TASK_ARN="$(echo "${RUN_JSON}" | "${NODE_BIN}" -e "
const fs = require(\"fs\");
const data = JSON.parse(fs.readFileSync(0, \"utf8\"));
const fail = data.failures || [];
if (fail.length) {
  console.error(\"ECS failures:\", JSON.stringify(fail));
  process.exit(1);
}
console.log(data.tasks[0].taskArn);
")"

echo "${COMMAND_NAME}: task ${TASK_ARN}"
echo "${COMMAND_NAME}: waiting for task to finish (may take several minutes)..."

aws ecs wait tasks-stopped --region "${PRIMARY_REGION}" --cluster "${ECS_CLUSTER}" --tasks "${TASK_ARN}"

EXIT_CODE="$(aws ecs describe-tasks \
  --region "${PRIMARY_REGION}" \
  --cluster "${ECS_CLUSTER}" \
  --tasks "${TASK_ARN}" \
  --query 'tasks[0].containers[0].exitCode' \
  --output text)"

if [[ "${EXIT_CODE}" != "0" ]] || [[ "${EXIT_CODE}" == "None" ]]; then
  echo "${COMMAND_NAME}: migration task failed (exit code=${EXIT_CODE}). Check CloudWatch log group \"/ecs/hyrelog-api\" for this task's stream." >&2
  exit 1
fi

echo "${COMMAND_NAME}: migrations completed successfully (ECS task exit ${EXIT_CODE})."
