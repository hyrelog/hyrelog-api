# ECS task definition templates (Fargate)

These JSON files are **starting points**. Replace placeholders before registering:

- `ACCOUNT_ID`, `REGION`, `IMAGE_TAG`
- Log group names (create in CloudWatch Logs first, or use `aws logs create-log-group`)
- `secrets` ARNs: AWS Secrets Manager returns ARNs with a **random suffix** (e.g. `...:hyrelog/KEY-abc123`) — use the real ARN from the console or `aws secretsmanager list-secrets`
- `executionRoleArn` and `taskRoleArn` — your IAM role ARNs
- S3 bucket **names** in `environment` if you prefer not to duplicate in secrets
- `cpu` / `memory` — adjust per load

## Register a task definition

```bash
aws ecs register-task-definition --cli-input-json file://infra/ecs/task-definition-api.json
```

**Tip:** for `secrets`, the `valueFrom` for Secrets Manager can be the **full secret ARN** or the **name** in some API versions; follow [ECS documentation](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data-secrets.html) for your region and console.

## Connect to a service

1. Create (or update) an **ECS service** with:
   - launch type: **Fargate**
   - task definition: the **latest revision** of `hyrelog-api` (etc.)
   - desired count: **2+** for the API in production (HA)
   - subnets: **private**
   - security groups: allow ALB → container port
2. **Target group** on port `3000` (API / dashboard) or internal-only for workers (often **no** ALB — worker is background only).

## Worker

The worker has **no** HTTP port requirement for the ALB. Do not attach the worker to a public load balancer. Keep desired count `1+` and monitor **CPU/memory**; scale out only if you split jobs (future work).

## Health check

- **API:** use ALB health check to `GET /health` on the API (path `/`, host `api.hyrelog.com` if host-based rules).
- **Container health** in the JSON is optional; some teams rely only on ALB health checks for HTTP services.

## Updating the image

After CI pushes a new `IMAGE_TAG` to ECR, either:

1. `register-task-definition` with the new `image` field and **revision bump**, then `update-service --task-definition family:rev --force-new-deployment`, or
2. Use **Infrastructure as Code** (CDK/Terraform) to manage revisions.

## Related docs

- [../../docs/deployment/aws-production-guide.md](../../docs/deployment/aws-production-guide.md)
- [../../docs/deployment/env-matrix.md](../../docs/deployment/env-matrix.md)
