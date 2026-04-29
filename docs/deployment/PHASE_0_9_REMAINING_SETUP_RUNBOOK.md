# HyreLog Beginner Runbook — Remaining Setup (Phase 0 to 9)

Use this when you want a single, clean path for everything **before** ECS services/migrations (Phase 10/11).

This file is a practical wrapper around existing detailed docs:

- `STEP_BY_STEP_AWS.md` (full source of truth)
- `PHASE_4_5_BEGINNER_RUNBOOK.md`
- `PHASE_6_7_BEGINNER_RUNBOOK.md`
- `PHASE_8_9_BEGINNER_RUNBOOK.md`

---

## Scope

This runbook covers:

1. Local prep (Phase 0)
2. Naming/regions (Phase 1)
3. IAM foundation (Phase 2)
4. Networking foundation (Phase 3)
5. Regional databases + buckets (Phase 4/5)
6. Secrets + ECR/images (Phase 6/7)
7. ECS cluster/task definitions + ALB/TLS/DNS (Phase 8/9)

It intentionally stops before:

- ECS services rollout (Phase 10)
- Runtime migrations (Phase 11)

For those, use:

- `PHASE_10_11_BEGINNER_RUNBOOK.md`
- `dashboard-ecs-deploy-and-migrate.md` (dashboard-specific deploy/migrate flow)

---

## 1) Session Bootstrap (run after every terminal restart)

```bash
export MSYS_NO_PATHCONV=1

export AWS_ACCOUNT_ID=163436765242
export ENV_NAME=prod
export PROJECT_PREFIX=hyrelog-prod

export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2

export DB_REGION_US=us-east-1
export DB_REGION_EU=eu-west-1
export DB_REGION_UK=eu-west-2
export DB_REGION_AU=ap-southeast-2

export ECS_CLUSTER=hyrelog-prod-ecs

export ECR_BASE="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com"
export ECR_API="${ECR_BASE}/hyrelog-api"
export ECR_WORKER="${ECR_BASE}/hyrelog-worker"
export ECR_DASHBOARD="${ECR_BASE}/hyrelog-dashboard"

export API_REPO_DIR=/c/Users/kram/Dropbox/hyrelog/hyrelog-api
export DASHBOARD_REPO_DIR=/c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard

aws sts get-caller-identity
```

If account/ARN does not match your expected production admin/user, stop and fix credentials first.

---

## 2) Phase-by-Phase Execution Order

Follow this exact order:

1. **Phase 2 IAM**
2. **Phase 3 Networking**
3. **Phase 4 RDS**
4. **Phase 5 S3**
5. **Phase 6 Secrets**
6. **Phase 7 ECR + image push**
7. **Phase 8 ECS cluster + task definitions**
8. **Phase 9 ACM + ALB + Route53**
9. **Validation checkpoint** (end of this file)

---

## 3) Phase 2 — IAM Foundation

Use `STEP_BY_STEP_AWS.md` Phase 2 and ensure all are true:

- ECS execution role exists: `${PROJECT_PREFIX}-ecs-execution-role`
- ECS task role exists: `${PROJECT_PREFIX}-ecs-task-role`
- Execution role can read required Secrets Manager secrets
- Task role has permissions for runtime S3 access (preferred over static S3 keys)

Quick checks:

```bash
aws iam get-role --role-name "${PROJECT_PREFIX}-ecs-execution-role" >/dev/null
aws iam get-role --role-name "${PROJECT_PREFIX}-ecs-task-role" >/dev/null
aws iam list-role-policies --role-name "${PROJECT_PREFIX}-ecs-task-role"
```

---

## 4) Phase 3 — Networking Foundation

Use `STEP_BY_STEP_AWS.md` Phase 3. At completion, record these values in your worksheet:

- Primary VPC ID
- Primary public subnets (2)
- Primary private subnets (2)
- ECS tasks security group ID
- ALB security group ID
- DB security groups per region
- Route tables / peering status for required flows

Do not proceed unless these are confirmed. Most downstream failures come from missing Phase 3 details.

---

## 5) Phase 4 and 5 — RDS + S3

Follow `PHASE_4_5_BEGINNER_RUNBOOK.md` fully.

At completion you should have:

- Dashboard RDS instance in `PRIMARY_REGION` with DB `hyrelog_dashboard`
- API RDS instances in US/EU/UK/AU with DB names:
  - `hyrelog_us`
  - `hyrelog_eu`
  - `hyrelog_uk`
  - `hyrelog_au`
- Four regional S3 buckets (US/EU/UK/AU)

Record all DB endpoints and bucket names; you need them in Phase 6.

---

## 6) Phase 6 and 7 — Secrets + ECR + Images

Follow `PHASE_6_7_BEGINNER_RUNBOOK.md`.

Minimum completion criteria:

- Secrets exist in Secrets Manager under `hyrelog-prod/...`
- Dashboard/API shared secrets are aligned:
  - dashboard `DASHBOARD_SERVICE_TOKEN` == API `DASHBOARD_SERVICE_TOKEN`
  - dashboard `HYRELOG_API_KEY_SECRET` == API `API_KEY_SECRET`
- ECR repos exist:
  - `hyrelog-api`
  - `hyrelog-worker`
  - `hyrelog-dashboard`
- Latest images are built and pushed with a known `IMAGE_TAG`

Useful quick check:

```bash
aws ecr describe-repositories --region "${PRIMARY_REGION}" \
  --query 'repositories[].repositoryName' --output text
```

---

## 7) Phase 8 and 9 — ECS Cluster + Task Definitions + TLS + ALB + DNS

Follow `PHASE_8_9_BEGINNER_RUNBOOK.md`.

Minimum completion criteria:

- ECS cluster exists: `hyrelog-prod-ecs`
- Task definitions registered (api/worker/dashboard)
- ACM certificate for `api.hyrelog.com` and `app.hyrelog.com` is `ISSUED`
- ALB exists and listeners route correctly
- Route53 records resolve to ALB

Quick checks:

```bash
aws ecs describe-clusters --clusters "${ECS_CLUSTER}" --region "${PRIMARY_REGION}" \
  --query 'clusters[0].[clusterName,status]' --output table

aws acm list-certificates --region "${PRIMARY_REGION}" \
  --query 'CertificateSummaryList[?contains(DomainName, `hyrelog.com`)].[DomainName,CertificateArn]' \
  --output table
```

---

## 8) End-of-Phase-9 Validation Gate

Before moving to Phase 10/11, confirm all boxes:

- [ ] IAM roles/policies complete
- [ ] Networking IDs documented (VPC/subnets/SGs)
- [ ] All 5 RDS instances available
- [ ] All required Secrets Manager values set
- [ ] ECR images pushed for a known tag
- [ ] ECS cluster + task definitions ready
- [ ] ACM cert issued
- [ ] ALB listeners + target groups configured
- [ ] DNS for `api.hyrelog.com` and `app.hyrelog.com` points to ALB

If all checked, continue with:

- `PHASE_10_11_BEGINNER_RUNBOOK.md`
- `dashboard-ecs-deploy-and-migrate.md`

---

## 9) Troubleshooting Shortcuts

- **App not reachable after Phase 9:** expected until Phase 10 services are created.
- **Secrets access denied at runtime:** usually execution role policy scope.
- **Health checks fail immediately:** target group port/container name mismatch.
- **Git Bash path weirdness (`/ecs/...` becomes local path):** ensure `export MSYS_NO_PATHCONV=1`.

When in doubt, fall back to the canonical deep guide:

- `STEP_BY_STEP_AWS.md`

