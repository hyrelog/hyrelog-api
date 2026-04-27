# HyreLog — step-by-step AWS launch (strict regional compliance)

Use this as the primary runbook when onboarding testers/operators.

## What this deploy guarantees

This guide is strict regional-compliance for API data:

- `DATABASE_URL_US` points to a **US-hosted** database
- `DATABASE_URL_EU` points to an **EU-hosted** database
- `DATABASE_URL_UK` points to a **UK-hosted** database
- `DATABASE_URL_AU` points to an **AU-hosted** database

No single-host “logical region” fallback is used in this guide.

## Domains and services

| Service | Domain | Repo |
|---|---|---|
| Dashboard | `app.hyrelog.com` | `hyrelog-dashboard` |
| API | `api.hyrelog.com` | `hyrelog-api/services/api` |
| Worker | no public domain | `hyrelog-api/services/worker` |

---

## Table of phases

| Phase | Goal |
|---|---|
| 0 | Prepare local tools and AWS CLI |
| 1 | Decide regions and naming |
| 2 | Create IAM and access model |
| 3 | Create networking (VPC/subnets/SG) |
| 4 | Create regional RDS databases |
| 5 | Create regional S3 buckets |
| 6 | Create Secrets Manager secrets |
| 7 | Create ECR repos and push images |
| 8 | Create ECS cluster, task roles, task defs |
| 9 | Create ALB + ACM + Route53 |
| 10 | Deploy ECS services |
| 11 | Run DB migrations (all regions) |
| 12 | Smoke tests and regional validation |
| 13 | GitHub Actions CI/CD enablement |

---

## Phase 0 — local prerequisites

Install:

- Docker Desktop
- AWS CLI v2
- `jq`
- PostgreSQL client (`psql`)

Configure AWS:

```bash
aws configure
aws sts get-caller-identity
```

Set baseline vars (adjust):

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export PRIMARY_REGION="ap-southeast-2"
export DB_REGION_US="us-east-1"
export DB_REGION_EU="eu-west-1"
export DB_REGION_UK="eu-west-2"
export DB_REGION_AU="ap-southeast-2"
```

Use one consistent environment name:

```bash
export ENV_NAME="prod"
export PROJECT_PREFIX="hyrelog-${ENV_NAME}"
```

---

## Phase 1 — region map and naming

Record this in your ops notes:

| Logical region | AWS region | DB identifier |
|---|---|---|
| US | `${DB_REGION_US}` | `${PROJECT_PREFIX}-api-us` |
| EU | `${DB_REGION_EU}` | `${PROJECT_PREFIX}-api-eu` |
| UK | `${DB_REGION_UK}` | `${PROJECT_PREFIX}-api-uk` |
| AU | `${DB_REGION_AU}` | `${PROJECT_PREFIX}-api-au` |
| Dashboard | `${PRIMARY_REGION}` (recommended) | `${PROJECT_PREFIX}-dashboard` |

Also decide where ECS runs (usually one primary region first): `${PRIMARY_REGION}`.

---

## Phase 2 — IAM setup (operator + runtime + CI/CD)

This phase creates the identity foundation. Do this carefully before touching ECS.

### 2.1 Human/operator access (console)

1. Sign in as root once.
2. IAM -> Users -> your admin user -> **Security credentials** -> set/verify MFA.
3. IAM -> Account settings -> enable strong password policy.
4. Sign out root. Do all future work as IAM user/role.

### 2.2 Runtime IAM roles for ECS

You need 2 roles in the same account where ECS runs (primary region account).

#### A) Task execution role

Purpose: pull image from ECR, write logs, fetch injected secrets.

Console steps:

1. IAM -> Roles -> Create role.
2. Trusted entity: **AWS service**.
3. Use case: **Elastic Container Service Task**.
4. Attach policy: `AmazonECSTaskExecutionRolePolicy`.
5. Role name: `${PROJECT_PREFIX}-ecs-execution-role`.

Then add inline policy for secrets access (replace region/account/prefix):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:*:ACCOUNT_ID:secret:hyrelog-prod/*"
    },
    {
      "Effect": "Allow",
      "Action": ["kms:Decrypt"],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "secretsmanager.REGION.amazonaws.com"
        }
      }
    }
  ]
}
```

If you use AWS-managed key `aws/secretsmanager`, `kms:Decrypt` may not need custom changes.

#### B) Task role

Purpose: permissions your app code uses at runtime.

Console steps:

1. IAM -> Roles -> Create role.
2. Trusted entity: **AWS service**.
3. Use case: **Elastic Container Service Task**.
4. Role name: `${PROJECT_PREFIX}-ecs-task-role`.
5. Start with least-privilege policies you need (S3 read/write for archive buckets if using role-based access later).

### 2.3 CI/CD role (GitHub OIDC, recommended)

Use OIDC instead of long-lived AWS keys.

#### A) Create OIDC provider (one time per account)

Console:

1. IAM -> Identity providers -> Add provider.
2. Provider type: OpenID Connect.
3. Provider URL: `https://token.actions.githubusercontent.com`
4. Audience: `sts.amazonaws.com`

#### B) Create deploy role trusted by GitHub

Create role with trust policy (replace account/repo):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:YOUR_ORG/hyrelog-api:ref:refs/heads/main",
            "repo:YOUR_ORG/hyrelog-dashboard:ref:refs/heads/main"
          ]
        }
      }
    }
  ]
}
```

Attach deploy permissions:

- ECR push/pull actions
- ECS `DescribeServices`, `UpdateService`, `RegisterTaskDefinition`, `DescribeTaskDefinition`
- `iam:PassRole` for the ECS execution/task roles used in task defs

### 2.4 Quick verification commands

```bash
aws iam get-role --role-name "${PROJECT_PREFIX}-ecs-execution-role"
aws iam get-role --role-name "${PROJECT_PREFIX}-ecs-task-role"
# For OIDC role, replace name
aws iam get-role --role-name "GitHubActionsHyrelogDeploy"
```

You are done with Phase 2 when:

- execution role exists
- task role exists
- (recommended) GitHub OIDC deploy role exists

---

## Phase 3 — networking (strict layout)

This phase creates a network shape that supports strict regional DB deployment.

### 3.1 Topology decision (recommended for first strict launch)

Use:

- **Primary region VPC**: ECS + ALB + dashboard DB
- **One DB VPC per API data region**: US, EU, UK, AU

This keeps each API regional DB physically local to its AWS region.

### 3.2 Primary region VPC (console)

In `${PRIMARY_REGION}`:

1. VPC -> Create VPC -> **VPC and more**.
2. Name: `${PROJECT_PREFIX}-primary-vpc`
3. IPv4 CIDR: `10.10.0.0/16`
4. AZ count: 2
5. Public subnets: 2
6. Private subnets: 2
7. NAT gateways: 1 (cost-saving) or 2 (HA)
8. Create.

Record:

- `PRIMARY_VPC_ID`
- `PRIMARY_PUBLIC_SUBNET_1/2`
- `PRIMARY_PRIVATE_SUBNET_1/2`

### 3.3 DB region VPCs (US/EU/UK/AU)

Repeat in each DB region:

1. Switch console region.
2. VPC -> Create VPC -> **VPC only** (or VPC and more if preferred).
3. Name: `${PROJECT_PREFIX}-db-us` (or `-eu`, `-uk`, `-au`).
4. CIDR suggestion:
   - US: `10.21.0.0/16`
   - EU: `10.22.0.0/16`
   - UK: `10.23.0.0/16`
   - AU: `10.24.0.0/16`
5. Create at least 2 private subnets across 2 AZs for RDS subnet group.

Record for each region:

- VPC ID
- private subnet IDs

### 3.4 Security groups (strict minimum)

#### Primary region SGs

Create:

- `${PROJECT_PREFIX}-alb-sg`
- `${PROJECT_PREFIX}-ecs-sg`
- `${PROJECT_PREFIX}-dashboard-rds-sg`

Rules:

1. ALB SG inbound:
   - TCP 443 from `0.0.0.0/0`
2. ECS SG inbound:
   - TCP 3000 from ALB SG
3. Dashboard RDS SG inbound:
   - TCP 5432 from ECS SG

#### API DB region SGs

In each DB region create:

- `${PROJECT_PREFIX}-api-rds-sg`

Inbound:

- TCP 5432 from the approved source used for app and migration access

Important: if your ECS tasks in primary region need direct DB access across regions, you need network connectivity path (Transit Gateway / peering / private routing / approved public endpoint strategy). Pick one and document it before Phase 4.

### 3.5 Route table sanity checks

In primary region:

- Public subnets route table has Internet Gateway route (`0.0.0.0/0 -> igw-*`)
- Private subnets route table has NAT route (`0.0.0.0/0 -> nat-*`)

In DB VPCs:

- Private subnets do not require public internet for RDS itself

### 3.6 Verification checklist for Phase 3

- [ ] Primary VPC created with 2 public + 2 private subnets
- [ ] DB VPC created in each API region
- [ ] SG rules created as above
- [ ] No Postgres SG allows `0.0.0.0/0` in production
- [ ] Subnet IDs and SG IDs captured in your worksheet

---

## Phase 4 — RDS creation (strict regional)

Create five independent RDS instances:

1. Dashboard DB in `${PRIMARY_REGION}`
2. API US DB in `${DB_REGION_US}`
3. API EU DB in `${DB_REGION_EU}`
4. API UK DB in `${DB_REGION_UK}`
5. API AU DB in `${DB_REGION_AU}`

Recommended settings:

- Engine: PostgreSQL 16
- Public access: No
- Private subnets only
- Backups enabled
- Encryption at rest enabled

Database names:

- Dashboard: `hyrelog_dashboard`
- API US: `hyrelog_us`
- API EU: `hyrelog_eu`
- API UK: `hyrelog_uk`
- API AU: `hyrelog_au`

Capture endpoints and build URLs:

```text
DATABASE_URL=postgresql://USER:PASS@dashboard-host:5432/hyrelog_dashboard?sslmode=require
DATABASE_URL_US=postgresql://USER:PASS@us-host:5432/hyrelog_us?sslmode=require
DATABASE_URL_EU=postgresql://USER:PASS@eu-host:5432/hyrelog_eu?sslmode=require
DATABASE_URL_UK=postgresql://USER:PASS@uk-host:5432/hyrelog_uk?sslmode=require
DATABASE_URL_AU=postgresql://USER:PASS@au-host:5432/hyrelog_au?sslmode=require
```

Validation rule: each host must resolve to the intended region’s RDS instance.

---

## Phase 5 — S3 buckets (region-aligned)

Create 4 buckets, each in matching region:

- `S3_BUCKET_US` in `${DB_REGION_US}`
- `S3_BUCKET_EU` in `${DB_REGION_EU}`
- `S3_BUCKET_UK` in `${DB_REGION_UK}`
- `S3_BUCKET_AU` in `${DB_REGION_AU}`

Enable:

- Block Public Access
- Default encryption
- Versioning (recommended)

---

## Phase 6 — Secrets Manager values

Create these secrets (names can vary; keep consistent):

- `${PROJECT_PREFIX}/DATABASE_URL`
- `${PROJECT_PREFIX}/DATABASE_URL_US`
- `${PROJECT_PREFIX}/DATABASE_URL_EU`
- `${PROJECT_PREFIX}/DATABASE_URL_UK`
- `${PROJECT_PREFIX}/DATABASE_URL_AU`
- `${PROJECT_PREFIX}/DASHBOARD_SERVICE_TOKEN`
- `${PROJECT_PREFIX}/API_KEY_SECRET`
- `${PROJECT_PREFIX}/HYRELOG_API_KEY_SECRET` (same value as API_KEY_SECRET)
- `${PROJECT_PREFIX}/INTERNAL_TOKEN`
- `${PROJECT_PREFIX}/WEBHOOK_SECRET_ENCRYPTION_KEY` (64 hex chars)
- `${PROJECT_PREFIX}/S3_ACCESS_KEY_ID`
- `${PROJECT_PREFIX}/S3_SECRET_ACCESS_KEY`

Hard requirements:

- `DASHBOARD_SERVICE_TOKEN` must match dashboard + API exactly
- `HYRELOG_API_KEY_SECRET` must equal API `API_KEY_SECRET`
- `HYRELOG_DASHBOARD_URL` or `DASHBOARD_USAGE_URL` on API must be `https://app.hyrelog.com`

---

## Phase 7 — ECR and image publishing

### 7.1 Create repositories in primary region

```bash
aws ecr create-repository --repository-name hyrelog-api --region "$PRIMARY_REGION" || true
aws ecr create-repository --repository-name hyrelog-worker --region "$PRIMARY_REGION" || true
aws ecr create-repository --repository-name hyrelog-dashboard --region "$PRIMARY_REGION" || true
```

Set ECR vars:

```bash
export ECR_API="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com/hyrelog-api"
export ECR_WORKER="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com/hyrelog-worker"
export ECR_DASHBOARD="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com/hyrelog-dashboard"
export IMAGE_TAG="$(date +%Y%m%d%H%M)-$(git rev-parse --short HEAD)"
```

Login:

```bash
aws ecr get-login-password --region "$PRIMARY_REGION" | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com"
```

### 7.2 Build and push API + worker

```bash
cd /path/to/hyrelog-api
docker build -f services/api/Dockerfile -t "$ECR_API:$IMAGE_TAG" -t "$ECR_API:latest" .
docker build -f services/worker/Dockerfile -t "$ECR_WORKER:$IMAGE_TAG" -t "$ECR_WORKER:latest" .
docker push "$ECR_API:$IMAGE_TAG"
docker push "$ECR_API:latest"
docker push "$ECR_WORKER:$IMAGE_TAG"
docker push "$ECR_WORKER:latest"
```

### 7.3 Build and push dashboard

```bash
cd /path/to/hyrelog-dashboard
docker build \
  --build-arg NEXT_PUBLIC_APP_URL="https://app.hyrelog.com" \
  --build-arg NEXT_PUBLIC_API_BASE_URL="https://api.hyrelog.com" \
  -t "$ECR_DASHBOARD:$IMAGE_TAG" -t "$ECR_DASHBOARD:latest" .
docker push "$ECR_DASHBOARD:$IMAGE_TAG"
docker push "$ECR_DASHBOARD:latest"
```

---

## Phase 8 — ECS cluster and task definitions

Create ECS cluster in `${PRIMARY_REGION}`:

- name: `${PROJECT_PREFIX}-ecs`

Use these templates (already in repo):

- `infra/ecs/task-definition-api.json`
- `infra/ecs/task-definition-worker.json`
- `infra/ecs/task-definition-dashboard.json`

Replace placeholders:

- account, region, image tags
- secret ARNs
- bucket names

Register task defs:

```bash
cd /path/to/hyrelog-api
aws ecs register-task-definition --cli-input-json file://infra/ecs/task-definition-api.json --region "$PRIMARY_REGION"
aws ecs register-task-definition --cli-input-json file://infra/ecs/task-definition-worker.json --region "$PRIMARY_REGION"
aws ecs register-task-definition --cli-input-json file://infra/ecs/task-definition-dashboard.json --region "$PRIMARY_REGION"
```

---

## Phase 9 — ALB, ACM, Route53

1. Request ACM cert (in `${PRIMARY_REGION}`):
   - `api.hyrelog.com`
   - `app.hyrelog.com`
2. Validate cert via DNS.
3. Create ALB in public subnets.
4. Create target groups:
   - API health: `/health`
   - Dashboard health: `/`
5. Listener rules:
   - host `api.hyrelog.com` -> API TG
   - host `app.hyrelog.com` -> Dashboard TG
6. Route53 alias records:
   - `api.hyrelog.com` -> ALB
   - `app.hyrelog.com` -> ALB

---

## Phase 10 — deploy ECS services

Create/Update services:

- API service (with ALB)
- Dashboard service (with ALB)
- Worker service (no public LB)

Wait for stability:

```bash
aws ecs wait services-stable --cluster "${PROJECT_PREFIX}-ecs" --services hyrelog-api --region "$PRIMARY_REGION"
aws ecs wait services-stable --cluster "${PROJECT_PREFIX}-ecs" --services hyrelog-dashboard --region "$PRIMARY_REGION"
aws ecs wait services-stable --cluster "${PROJECT_PREFIX}-ecs" --services hyrelog-worker --region "$PRIMARY_REGION"
```

---

## Phase 11 — run migrations (strict regional)

API migrations (all 4 regional URLs):

```bash
cd /path/to/hyrelog-api
export CONFIRM=YES
export DATABASE_URL_US="postgresql://...us..."
export DATABASE_URL_EU="postgresql://...eu..."
export DATABASE_URL_UK="postgresql://...uk..."
export DATABASE_URL_AU="postgresql://...au..."
bash scripts/deployment/run-api-regional-migrations.sh
```

Dashboard migration:

```bash
cd /path/to/hyrelog-dashboard
export DATABASE_URL="postgresql://...dashboard..."
npx prisma migrate deploy
```

Rule: deploy app code only after required migrations are successful.

---

## Phase 12 — smoke tests + compliance checks

Quick smoke:

```bash
cd /path/to/hyrelog-api
DASHBOARD_URL="https://app.hyrelog.com" API_URL="https://api.hyrelog.com" bash scripts/deployment/smoke-test-production.sh
```

Then run full checklist:

- `docs/deployment/smoke-tests.md`

Regional compliance checks:

- [ ] US writes observed in US DB
- [ ] EU writes observed in EU DB
- [ ] UK writes observed in UK DB
- [ ] AU writes observed in AU DB
- [ ] No region endpoint points to wrong host/region

---

## Phase 13 — GitHub Actions CI/CD

Use workflows already added:

- `hyrelog-api/.github/workflows/checks.yml`
- `hyrelog-api/.github/workflows/deploy-production.yml`
- `hyrelog-dashboard/.github/workflows/checks.yml`
- `hyrelog-dashboard/.github/workflows/deploy-production.yml`

Prefer OIDC role auth.

Set required GitHub Secrets exactly as each workflow header comments specify.

---

## Final regional-compliance signoff

- [ ] `DATABASE_URL_US` target DB is physically in US region
- [ ] `DATABASE_URL_EU` target DB is physically in EU region
- [ ] `DATABASE_URL_UK` target DB is physically in UK region
- [ ] `DATABASE_URL_AU` target DB is physically in AU region
- [ ] Migration history is in sync across all four API DBs
- [ ] Cross-service secret invariants are correct
- [ ] Smoke tests pass and no critical CloudWatch errors

If all checks pass, this deployment is strict region-based for API data.

