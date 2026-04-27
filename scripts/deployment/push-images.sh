#!/usr/bin/env bash
# Tag and push local images to ECR. Requires: aws cli, docker, ECR login.
#
# Required env:
#   AWS_REGION          e.g. us-east-1
#   ECR_PREFIX          e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/hyrelog
#                       (script will use ${ECR_PREFIX}-api, -worker, -dashboard if you pass IMAGE_TAG for all,
#                        or set individually below)
#   IMAGE_TAG           e.g. git sha or 2025-01-15T00-00-00
#
# Optional:
#   CONFIRM=YES         must be set to actually push
#
# Example:
#   export AWS_REGION=us-east-1
#   export ECR_API=123456789012.dkr.ecr.us-east-1.amazonaws.com/hyrelog-api
#   export ECR_WORKER=123456789012.dkr.ecr.us-east-1.amazonaws.com/hyrelog-worker
#   export IMAGE_TAG=$(git rev-parse --short HEAD)
#   CONFIRM=YES ./scripts/deployment/push-images.sh
#
set -euo pipefail

if [[ "${CONFIRM:-}" != "YES" ]]; then
  echo "Refusing to push. Set CONFIRM=YES to push to ECR."
  exit 1
fi

: "${AWS_REGION:?Set AWS_REGION}"
: "${IMAGE_TAG:?Set IMAGE_TAG (e.g. git SHA)}"
: "${ECR_API:?Set ECR_API to full ECR repository URI (no tag)}"
: "${ECR_WORKER:?Set ECR_WORKER to full ECR repository URI (no tag)}"

echo "Logging in to ECR..."
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${ECR_API%/*}"

docker tag hyrelog-api:local "${ECR_API}:${IMAGE_TAG}"
docker tag hyrelog-worker:local "${ECR_WORKER}:${IMAGE_TAG}"
docker tag hyrelog-api:local "${ECR_API}:latest"
docker tag hyrelog-worker:local "${ECR_WORKER}:latest"

echo "Pushing ${ECR_API}:${IMAGE_TAG} and ${ECR_WORKER}:${IMAGE_TAG}..."
docker push "${ECR_API}:${IMAGE_TAG}"
docker push "${ECR_API}:latest"
docker push "${ECR_WORKER}:${IMAGE_TAG}"
docker push "${ECR_WORKER}:latest"

echo "Push complete. Update ECS task definitions to use tag ${IMAGE_TAG} (avoid :latest in strict prod if you use immutable deploys)."
