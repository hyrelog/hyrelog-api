#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Attach least-privilege S3 policy to ECS task role so static S3 keys are not needed.

Required environment variables:
  TASK_ROLE_NAME
  S3_BUCKET_US
  S3_BUCKET_EU
  S3_BUCKET_UK
  S3_BUCKET_AU

Optional:
  POLICY_NAME (default: HyrelogS3RegionalBucketsAccess)

Example:
  TASK_ROLE_NAME=hyrelog-prod-ecs-task-role \
  S3_BUCKET_US=hyrelog-prod-events-us \
  S3_BUCKET_EU=hyrelog-prod-events-eu \
  S3_BUCKET_UK=hyrelog-prod-events-uk \
  S3_BUCKET_AU=hyrelog-prod-events-au \
  bash scripts/deployment/attach-s3-policy-to-ecs-task-role.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

required=(TASK_ROLE_NAME S3_BUCKET_US S3_BUCKET_EU S3_BUCKET_UK S3_BUCKET_AU)
for key in "${required[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    echo "Missing required env var: ${key}" >&2
    exit 1
  fi
done

POLICY_NAME="${POLICY_NAME:-HyrelogS3RegionalBucketsAccess}"
POLICY_DOCUMENT="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BucketList",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::${S3_BUCKET_US}",
        "arn:aws:s3:::${S3_BUCKET_EU}",
        "arn:aws:s3:::${S3_BUCKET_UK}",
        "arn:aws:s3:::${S3_BUCKET_AU}"
      ]
    },
    {
      "Sid": "ObjectReadWrite",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListBucketMultipartUploads",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": [
        "arn:aws:s3:::${S3_BUCKET_US}/*",
        "arn:aws:s3:::${S3_BUCKET_EU}/*",
        "arn:aws:s3:::${S3_BUCKET_UK}/*",
        "arn:aws:s3:::${S3_BUCKET_AU}/*"
      ]
    }
  ]
}
EOF
)"

aws iam put-role-policy \
  --role-name "${TASK_ROLE_NAME}" \
  --policy-name "${POLICY_NAME}" \
  --policy-document "${POLICY_DOCUMENT}"
echo "Attached inline policy '${POLICY_NAME}' to role '${TASK_ROLE_NAME}'."
