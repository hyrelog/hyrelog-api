#!/usr/bin/env bash
# Run dashboard Prisma migrate deploy inside your VPC via a one-off ECS Fargate task using the
# hyrelog-dashboard image (same subnets/SGs/secrets as the running dashboard service).
# Use when your laptop hits P1001 against the private dashboard RDS.
#
# The dashboard Dockerfile must ship prisma/ + prisma.config.ts (see hyrelog-dashboard Dockerfile).
#
# Required env:
#   PRIMARY_REGION
#   ECS_CLUSTER
#   ECS_SUBNET_IDS           comma-separated (from hyrelog-dashboard service networking)
#   ECS_SECURITY_GROUP_IDS   comma-separated
#
# Optional:
#   ECS_SERVICE_DASHBOARD  default: hyrelog-dashboard — used to resolve TASK_DEFINITION from the
#                          running service when TASK_DEFINITION is unset or family-only (no ":").
#   TASK_DEFINITION      pin a revision (hyrelog-dashboard:13) or full ARN; otherwise resolved from service.
#   CONTAINER_NAME       default: hyrelog-dashboard
#   MIGRATION_ACTION   default: deploy
#                      one of: deploy | resolve-rolled-back | resolve-applied
#   MIGRATION_NAME     required when MIGRATION_ACTION is resolve-rolled-back/resolve-applied
#
# Dashboard image installs Prisma CLI under /opt/prisma-cli (see hyrelog-dashboard Dockerfile).
# Use `bash -c` (not `bash -lc`): a login shell resets PATH on Debian and drops /opt/prisma-cli/.../.bin.
#
# Example:
#   PRIMARY_REGION=ap-southeast-2 ECS_CLUSTER=hyrelog-prod-ecs \
#     ECS_SUBNET_IDS=subnet-a,subnet-b ECS_SECURITY_GROUP_IDS=sg-x \
#     bash scripts/deployment/run-dashboard-migrations-ecs-task.sh
#
# JSON helpers use Node (not Python): on Windows, `python3`/`python` often resolve to
# Microsoft Store stubs and open installers — Node is expected for HyreLog dev tooling.
#
set -euo pipefail

COMMAND_NAME=$(basename "${BASH_SOURCE[0]}")

TASK_DEFINITION="${TASK_DEFINITION:-}"
ECS_SERVICE_DASHBOARD="${ECS_SERVICE_DASHBOARD:-hyrelog-dashboard}"
CONTAINER_NAME="${CONTAINER_NAME:-hyrelog-dashboard}"
MIGRATION_ACTION="${MIGRATION_ACTION:-deploy}"
MIGRATION_NAME="${MIGRATION_NAME:-}"

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
  echo "${COMMAND_NAME}: need 'node' in PATH — install Node.js (LTS). These ECS scripts avoid Python so Windows Store python stubs don't open installers." >&2
  exit 1
fi

require_var PRIMARY_REGION
require_var ECS_CLUSTER
require_var ECS_SUBNET_IDS
require_var ECS_SECURITY_GROUP_IDS

if [[ -z "${TASK_DEFINITION}" ]] || [[ "${TASK_DEFINITION}" != *:* ]]; then
  echo "${COMMAND_NAME}: resolving task definition from ECS service ${ECS_SERVICE_DASHBOARD}..."
  TASK_DEFINITION="$(aws ecs describe-services \
    --cluster "${ECS_CLUSTER}" \
    --services "${ECS_SERVICE_DASHBOARD}" \
    --region "${PRIMARY_REGION}" \
    --query 'services[0].taskDefinition' \
    --output text)"
fi
echo "${COMMAND_NAME}: using task definition: ${TASK_DEFINITION}"

case "${MIGRATION_ACTION}" in
  deploy|resolve-rolled-back|resolve-applied) ;;
  *)
    echo "${COMMAND_NAME}: invalid MIGRATION_ACTION='${MIGRATION_ACTION}'. Use deploy | resolve-rolled-back | resolve-applied." >&2
    exit 1
    ;;
esac

if [[ "${MIGRATION_ACTION}" != "deploy" ]] && [[ -z "${MIGRATION_NAME}" ]]; then
  echo "${COMMAND_NAME}: MIGRATION_NAME is required when MIGRATION_ACTION=${MIGRATION_ACTION}" >&2
  exit 1
fi

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

# DATABASE_URL is injected by ECS from secrets. Call prisma by full path so it works even if login shell clobbers PATH.
if [[ "${MIGRATION_ACTION}" == "deploy" ]]; then
  COMMAND_SCRIPT=$(cat <<'EOS'
set -euo pipefail
cd /app
PRISMA_BIN="/opt/prisma-cli/node_modules/.bin/prisma"
if [[ ! -x "$PRISMA_BIN" ]]; then
  echo "Expected Prisma at $PRISMA_BIN — rebuild/push hyrelog-dashboard image (see Dockerfile /opt/prisma-cli)." >&2
  exit 1
fi
echo "==> Dashboard database: prisma migrate deploy"
"$PRISMA_BIN" migrate deploy
echo "Dashboard migrations complete."
EOS
)
elif [[ "${MIGRATION_ACTION}" == "resolve-rolled-back" ]]; then
  COMMAND_SCRIPT=$(cat <<EOS
set -euo pipefail
cd /app
PRISMA_BIN="/opt/prisma-cli/node_modules/.bin/prisma"
if [[ ! -x "\$PRISMA_BIN" ]]; then
  echo "Expected Prisma at \$PRISMA_BIN — rebuild/push hyrelog-dashboard image (see Dockerfile /opt/prisma-cli)." >&2
  exit 1
fi
echo "==> Dashboard database: prisma migrate resolve --rolled-back ${MIGRATION_NAME}"
"\$PRISMA_BIN" migrate resolve --rolled-back "${MIGRATION_NAME}"
echo "Dashboard migration state resolved (rolled-back) for ${MIGRATION_NAME}."
EOS
)
else
  COMMAND_SCRIPT=$(cat <<EOS
set -euo pipefail
cd /app
PRISMA_BIN="/opt/prisma-cli/node_modules/.bin/prisma"
if [[ ! -x "\$PRISMA_BIN" ]]; then
  echo "Expected Prisma at \$PRISMA_BIN — rebuild/push hyrelog-dashboard image (see Dockerfile /opt/prisma-cli)." >&2
  exit 1
fi
echo "==> Dashboard database: prisma migrate resolve --applied ${MIGRATION_NAME}"
"\$PRISMA_BIN" migrate resolve --applied "${MIGRATION_NAME}"
echo "Dashboard migration state resolved (applied) for ${MIGRATION_NAME}."
EOS
)
fi

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

echo "${COMMAND_NAME}: starting dashboard task (action=${MIGRATION_ACTION})..."
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
  echo "${COMMAND_NAME}: migration task failed (exit code=${EXIT_CODE}). Check CloudWatch log group \"/ecs/hyrelog-dashboard\"." >&2
  exit 1
fi

echo "${COMMAND_NAME}: dashboard migrations completed successfully (ECS task exit ${EXIT_CODE})."
