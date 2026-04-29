#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Update ECS services to the latest task definition revisions and wait for stability.

Required environment variables:
  PRIMARY_REGION
  ECS_CLUSTER

Optional environment variables (defaults shown):
  API_FAMILY=hyrelog-api
  WORKER_FAMILY=hyrelog-worker
  DASHBOARD_FAMILY=hyrelog-dashboard
  API_SERVICE=hyrelog-api
  WORKER_SERVICE=hyrelog-worker
  DASHBOARD_SERVICE=hyrelog-dashboard
  DEPLOY_API=true
  DEPLOY_WORKER=true
  DEPLOY_DASHBOARD=true

Example:
  PRIMARY_REGION=ap-southeast-2 ECS_CLUSTER=hyrelog-prod-ecs \
  bash scripts/deployment/update-ecs-services.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_var() {
  local k="$1"
  if [[ -z "${!k:-}" ]]; then
    echo "Missing required env var: ${k}" >&2
    exit 1
  fi
}

is_true() {
  [[ "${1:-}" == "true" || "${1:-}" == "TRUE" || "${1:-}" == "1" ]]
}

require_var PRIMARY_REGION
require_var ECS_CLUSTER

API_FAMILY="${API_FAMILY:-hyrelog-api}"
WORKER_FAMILY="${WORKER_FAMILY:-hyrelog-worker}"
DASHBOARD_FAMILY="${DASHBOARD_FAMILY:-hyrelog-dashboard}"
API_SERVICE="${API_SERVICE:-hyrelog-api}"
WORKER_SERVICE="${WORKER_SERVICE:-hyrelog-worker}"
DASHBOARD_SERVICE="${DASHBOARD_SERVICE:-hyrelog-dashboard}"
DEPLOY_API="${DEPLOY_API:-true}"
DEPLOY_WORKER="${DEPLOY_WORKER:-true}"
DEPLOY_DASHBOARD="${DEPLOY_DASHBOARD:-true}"

latest_td_arn() {
  local family="$1"
  aws ecs describe-task-definition \
    --task-definition "$family" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text \
    --region "$PRIMARY_REGION"
}

update_service() {
  local svc="$1"
  local td_arn="$2"
  aws ecs update-service \
    --cluster "$ECS_CLUSTER" \
    --service "$svc" \
    --task-definition "$td_arn" \
    --region "$PRIMARY_REGION" >/dev/null
  echo "Updated service ${svc} -> ${td_arn}"
}

services_to_wait=()

if is_true "$DEPLOY_API"; then
  API_TD_ARN="$(latest_td_arn "$API_FAMILY")"
  update_service "$API_SERVICE" "$API_TD_ARN"
  services_to_wait+=("$API_SERVICE")
fi

if is_true "$DEPLOY_WORKER"; then
  WORKER_TD_ARN="$(latest_td_arn "$WORKER_FAMILY")"
  update_service "$WORKER_SERVICE" "$WORKER_TD_ARN"
  services_to_wait+=("$WORKER_SERVICE")
fi

if is_true "$DEPLOY_DASHBOARD"; then
  DASHBOARD_TD_ARN="$(latest_td_arn "$DASHBOARD_FAMILY")"
  update_service "$DASHBOARD_SERVICE" "$DASHBOARD_TD_ARN"
  services_to_wait+=("$DASHBOARD_SERVICE")
fi

if [[ "${#services_to_wait[@]}" -eq 0 ]]; then
  echo "No services selected for deploy."
  exit 0
fi

echo "Waiting for services to become stable..."
aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" \
  --services "${services_to_wait[@]}" \
  --region "$PRIMARY_REGION"

echo "All selected services are stable."
