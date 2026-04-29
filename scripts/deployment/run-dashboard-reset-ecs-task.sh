#!/usr/bin/env bash
# Run dashboard prisma/seed/resetToDefault.ts inside your VPC via a one-off ECS Fargate task.
# Same pattern as run-dashboard-migrations-ecs-task.sh (subnets/SGs/secrets as the running service).
#
# Required env:
#   PRIMARY_REGION
#   ECS_CLUSTER
#   ECS_SUBNET_IDS           comma-separated
#   ECS_SECURITY_GROUP_IDS   comma-separated
#
# Optional:
#   TASK_DEFINITION    default: hyrelog-dashboard — family name or family:revision
#   CONTAINER_NAME     default: hyrelog-dashboard
#
# Why not `npx tsx` / `bash -lc`:
# - `bash -lc` resets PATH and can break Prisma/tsx resolution.
# - `NODE_PATH` must point at /opt/prisma-cli/node_modules so @prisma/adapter-pg resolves.
#   (Image Dockerfile sets this; we export again so one-off overrides are explicit.)
#
set -euo pipefail

COMMAND_NAME=$(basename "${BASH_SOURCE[0]}")

TASK_DEFINITION="${TASK_DEFINITION:-hyrelog-dashboard}"
CONTAINER_NAME="${CONTAINER_NAME:-hyrelog-dashboard}"

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
export NODE_PATH=/opt/prisma-cli/node_modules
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/aws-rds-global-bundle.pem
cd /app
TSX_BIN="/opt/prisma-cli/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
  echo "Expected tsx at $TSX_BIN — rebuild/push hyrelog-dashboard image (see Dockerfile /opt/prisma-cli)." >&2
  exit 1
fi
echo "==> Dashboard database: resetToDefault (tsx)"
"$TSX_BIN" prisma/seed/resetToDefault.ts
echo "Dashboard reset complete."
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

echo "${COMMAND_NAME}: starting dashboard reset task..."
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
echo "${COMMAND_NAME}: waiting for task to finish..."

aws ecs wait tasks-stopped --region "${PRIMARY_REGION}" --cluster "${ECS_CLUSTER}" --tasks "${TASK_ARN}"

EXIT_CODE="$(aws ecs describe-tasks \
  --region "${PRIMARY_REGION}" \
  --cluster "${ECS_CLUSTER}" \
  --tasks "${TASK_ARN}" \
  --query 'tasks[0].containers[0].exitCode' \
  --output text)"

if [[ "${EXIT_CODE}" != "0" ]] || [[ "${EXIT_CODE}" == "None" ]]; then
  echo "${COMMAND_NAME}: reset task failed (exit code=${EXIT_CODE}). Check CloudWatch log group \"/ecs/hyrelog-dashboard\"." >&2
  exit 1
fi

echo "${COMMAND_NAME}: dashboard reset completed successfully (ECS task exit ${EXIT_CODE})."
