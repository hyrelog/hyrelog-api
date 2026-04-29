#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Create or update HyreLog production secrets in AWS Secrets Manager.

Required environment variables:
  PROJECT_PREFIX
  PRIMARY_REGION
  DATABASE_URL
  DATABASE_URL_US
  DATABASE_URL_EU
  DATABASE_URL_UK
  DATABASE_URL_AU
  DASHBOARD_SERVICE_TOKEN
  API_KEY_SECRET
  HYRELOG_API_KEY_SECRET
  INTERNAL_TOKEN
  WEBHOOK_SECRET_ENCRYPTION_KEY

Optional (only if using static S3 keys):
  S3_ACCESS_KEY_ID
  S3_SECRET_ACCESS_KEY

Example:
  PROJECT_PREFIX=hyrelog-prod PRIMARY_REGION=ap-southeast-2 \
  DATABASE_URL='postgresql://...' DATABASE_URL_US='postgresql://...' ... \
  bash scripts/deployment/create-or-update-secrets.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

required=(
  PROJECT_PREFIX
  PRIMARY_REGION
  DATABASE_URL
  DATABASE_URL_US
  DATABASE_URL_EU
  DATABASE_URL_UK
  DATABASE_URL_AU
  DASHBOARD_SERVICE_TOKEN
  API_KEY_SECRET
  HYRELOG_API_KEY_SECRET
  INTERNAL_TOKEN
  WEBHOOK_SECRET_ENCRYPTION_KEY
)

for key in "${required[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    echo "Missing required env var: ${key}" >&2
    exit 1
  fi
done

if [[ "${API_KEY_SECRET}" != "${HYRELOG_API_KEY_SECRET}" ]]; then
  echo "API_KEY_SECRET and HYRELOG_API_KEY_SECRET must be identical." >&2
  exit 1
fi

if [[ ! "${WEBHOOK_SECRET_ENCRYPTION_KEY}" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "WEBHOOK_SECRET_ENCRYPTION_KEY must be exactly 64 hex characters." >&2
  exit 1
fi

upsert_secret() {
  local name="$1"
  local value="$2"
  local region="$3"

  if aws secretsmanager describe-secret --secret-id "$name" --region "$region" >/dev/null 2>&1; then
    aws secretsmanager update-secret \
      --secret-id "$name" \
      --secret-string "$value" \
      --region "$region" >/dev/null
    echo "Updated: ${name}"
  else
    aws secretsmanager create-secret \
      --name "$name" \
      --secret-string "$value" \
      --region "$region" >/dev/null
    echo "Created: ${name}"
  fi
}

upsert_secret "${PROJECT_PREFIX}/DATABASE_URL" "${DATABASE_URL}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/DATABASE_URL_US" "${DATABASE_URL_US}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/DATABASE_URL_EU" "${DATABASE_URL_EU}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/DATABASE_URL_UK" "${DATABASE_URL_UK}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/DATABASE_URL_AU" "${DATABASE_URL_AU}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/DASHBOARD_SERVICE_TOKEN" "${DASHBOARD_SERVICE_TOKEN}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/API_KEY_SECRET" "${API_KEY_SECRET}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/HYRELOG_API_KEY_SECRET" "${HYRELOG_API_KEY_SECRET}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/INTERNAL_TOKEN" "${INTERNAL_TOKEN}" "${PRIMARY_REGION}"
upsert_secret "${PROJECT_PREFIX}/WEBHOOK_SECRET_ENCRYPTION_KEY" "${WEBHOOK_SECRET_ENCRYPTION_KEY}" "${PRIMARY_REGION}"

if [[ -n "${S3_ACCESS_KEY_ID:-}" ]]; then
  upsert_secret "${PROJECT_PREFIX}/S3_ACCESS_KEY_ID" "${S3_ACCESS_KEY_ID}" "${PRIMARY_REGION}"
fi
if [[ -n "${S3_SECRET_ACCESS_KEY:-}" ]]; then
  upsert_secret "${PROJECT_PREFIX}/S3_SECRET_ACCESS_KEY" "${S3_SECRET_ACCESS_KEY}" "${PRIMARY_REGION}"
fi

echo
echo "Secret ARNs:"
aws secretsmanager list-secrets \
  --region "${PRIMARY_REGION}" \
  --query "SecretList[?starts_with(Name, '${PROJECT_PREFIX}/')].[Name,ARN]" \
  --output table
