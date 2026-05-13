#!/usr/bin/env bash
# Run API prisma/seed-reset.ts for all four regions *inside your VPC* via a one-off ECS Fargate task.
# Same networking + task-definition pattern as run-api-regional-migrations-ecs-task.sh.
#
# Destructive: wipes tenant data in each regional DB (see prisma/seed-reset.ts).
#
# Required env:
#   PRIMARY_REGION
#   ECS_CLUSTER
#   ECS_SUBNET_IDS           comma-separated
#   ECS_SECURITY_GROUP_IDS   comma-separated
#
# Optional:
#   TASK_DEFINITION   default: hyrelog-api — family name or family:revision
#   CONTAINER_NAME    default: hyrelog-api
#
# Example:
#   export PRIMARY_REGION=ap-southeast-2
#   export ECS_CLUSTER=hyrelog-prod-ecs
#   export ECS_SUBNET_IDS=subnet-aaa...,subnet-bbb...
#   export ECS_SECURITY_GROUP_IDS=sg-ccc...
#   bash scripts/deployment/run-api-regional-reset-ecs-task.sh
#
set -euo pipefail

COMMAND_NAME=$(basename "${BASH_SOURCE[0]}")

TASK_DEFINITION="${TASK_DEFINITION:-hyrelog-api}"
CONTAINER_NAME="${CONTAINER_NAME:-hyrelog-api}"

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
  echo "${COMMAND_NAME}: need 'node' in PATH — install Node.js (LTS)." >&2
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

COMMAND_SCRIPT=$(cat <<'EOS'
set -euo pipefail
cd /app/services/api
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/aws-rds-global-bundle.pem
echo "==> Seed reset region US"
export DATABASE_URL="$DATABASE_URL_US"
export SEED_RESET_REGION_LABEL=US
npx --yes tsx prisma/seed-reset.ts
echo "==> Seed reset region EU"
export DATABASE_URL="$DATABASE_URL_EU"
export SEED_RESET_REGION_LABEL=EU
npx --yes tsx prisma/seed-reset.ts
echo "==> Seed reset region UK"
export DATABASE_URL="$DATABASE_URL_UK"
export SEED_RESET_REGION_LABEL=UK
npx --yes tsx prisma/seed-reset.ts
echo "==> Seed reset region AU"
export DATABASE_URL="$DATABASE_URL_AU"
export SEED_RESET_REGION_LABEL=AU
npx --yes tsx prisma/seed-reset.ts
echo "All four API regions reset successfully."
EOS
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

echo "${COMMAND_NAME}: starting API regional reset task..."
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
  echo "${COMMAND_NAME}: reset task failed (exit code=${EXIT_CODE}). Check CloudWatch log group \"/ecs/hyrelog-api\" for this task's stream." >&2
  exit 1
fi

echo "${COMMAND_NAME}: API regional reset completed successfully (ECS task exit ${EXIT_CODE})."
