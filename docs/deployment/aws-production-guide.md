# HyreLog — AWS production guide (beginner-friendly)

> **New here?** Use the full **copy-paste, phase-by-phase** runbook: **[STEP_BY_STEP_AWS.md](./STEP_BY_STEP_AWS.md)**. It is now written for a **strict regional-compliance** launch (separate regional API databases). This file is a shorter narrative companion.

**Domains**

| Service | Public URL | Notes |
|--------|------------|--------|
| Dashboard | `https://app.hyrelog.com` | Next.js; separate RDS |
| Public API | `https://api.hyrelog.com` | Fastify behind ALB |

**Repositories** (as used in this workspace)

- **API + worker:** `hyrelog-api` (monorepo: `services/api`, `services/worker`)
- **Dashboard:** `hyrelog-dashboard` (sibling repository)

**Companion documents**

- [INSPECTION_REPORT.md](./INSPECTION_REPORT.md) — Phase 1 findings (build commands, health paths)
- [env-matrix.md](./env-matrix.md) — all environment variables
- [database-migrations.md](./database-migrations.md) — multi-region `prisma migrate deploy`
- [smoke-tests.md](./smoke-tests.md) — post-deploy verification
- [../../infra/ecs/README.md](../../infra/ecs/README.md) — ECS task JSON templates

---

## Prerequisites checklist

- [ ] AWS account with billing and admin or power-user access
- [ ] **GitHub** repositories (API and dashboard) with `main` protected as appropriate
- [ ] This repo built locally once (`npm ci` / `npm run build` per service) to catch issues before CI
- [ ] **Decide S3 access model:** the API Zod config currently **requires** `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Many teams set **dedicated IAM user** keys in Secrets Manager, or (TODO) change code to use **only** the task IAM role. Until then, use secrets or small IAM user for S3.
- [ ] All **four** API regional database URLs and **one** dashboard database URL
- [ ] A shared 64-hex `WEBHOOK_SECRET_ENCRYPTION_KEY` and matching **DASHBOARD_SERVICE_TOKEN** / **API_KEY_SECRET** + **HYRELOG_API_KEY_SECRET**

**Compliance mode used here:** `DATABASE_URL_US/EU/UK/AU` are expected to point to **physically separate regional database deployments** (not four logical DBs on one host).

---

## 1. AWS account setup

1. Create or use an [AWS account](https://aws.amazon.com/).
2. **Enable** IAM, Billing alerts, and (recommended) AWS Organizations for production.
3. Create a **billing alarm** (e.g. CloudWatch billing metric → SNS email).

---

## 2. IAM — CI/CD and runtime

You need two distinct concerns:

- **CI/CD (GitHub Actions):** either **long-lived access keys** (simpler, rotate often) or **OIDC** (no static keys) — [see § GitHub OIDC](#github-oidc-federation-recommended) below.
- **Runtime (ECS Fargate):** a **Task Execution Role** (pull from ECR, write logs) and a **Task Role** (S3, Secrets Manager, optional RDS if using IAM database auth — many setups use username/password in Secrets Manager only).

**Minimal permissions for a deploy user / CI role**

- ECR: `GetAuthorizationToken`, `BatchCheckLayerAvailability`, `CompleteLayerUpload`, `InitiateLayerUpload`, `PutImage`, `UploadLayerPart`
- ECS: `DescribeServices`, `UpdateService`, `RegisterTaskDefinition`, `DescribeTaskDefinition`, `RunTask` (if migrations as one-off)
- (Optional) Secrets Manager: `GetSecretValue` for tasks if not injected by ECS secretOptions

**Minimal task role (application)**

- S3: `s3:PutObject`, `s3:GetObject`, `s3:ListBucket` (scoped to your four buckets/prefixes)
- Secrets Manager: only if the app uses AWS SDK to read secrets at runtime
- CloudWatch Logs: `logs:CreateLogStream`, `logs:PutLogEvents` on the log group

**Never** put production secrets in IAM policies; use **Secrets Manager** or **SSM Parameter Store (SecureString)** and reference them in the task definition.

---

## 3. VPC, subnets, and security groups

1. **VPC:** use the default VPC for experiments only; for production, create a **dedicated VPC** (e.g. `10.0.0.0/16`) with:
   - **3+ public subnets** (multi-AZ) for ALB
   - **3+ private subnets** for ECS tasks and RDS
   - **NAT Gateways** (or NAT per AZ) for private subnet egress, **or** VPC endpoints (ECR, S3, CloudWatch, Secrets Manager) to avoid public egress from tasks.
2. **Security groups**
   - **ALB:** inbound `443` from `0.0.0.0/0` (or your corporate CIDRs); outbound to target group
   - **ECS tasks:** inbound only from ALB (app port, e.g. 3000); outbound to RDS (5432), S3 (443), and internet/NAT for external APIs as needed
   - **RDS:** inbound **only** from ECS security group on **5432** (not from the public internet)
3. **No public RDS:** place RDS in **private subnets**; database subnets should not have a direct route to an Internet Gateway.

Document subnet IDs, SG IDs, and VPC ID — you will need them in ECS, RDS, and Endpoints.

---

## 4. ECR (Elastic Container Registry)

1. Open **ECR** in the region where you run ECS (often `us-east-1` or your primary region; note: API regional DBs can live in other regions, but a single ECR/ECS in one region is the usual starting point; cross-region adds complexity).
2. Create **three** repositories (private):
   - `hyrelog-api`
   - `hyrelog-worker`
   - `hyrelog-dashboard`
3. **Lifecycle policy** (optional): expire untagged or old images to save cost.
4. Note each **repository URI**:
   - `ACCOUNT.dkr.ecr.REGION.amazonaws.com/hyrelog-api`
   - … same for worker and dashboard
5. **Image tags:** use immutable tags (`:git-SHA` or datetime), not only `:latest`, for traceability and rollback.

---

## 5. RDS PostgreSQL — dashboard database

1. **Engine:** PostgreSQL 15 or 16 (match local if possible).
2. **Templates:** “Production” or “Dev/Test” (single-AZ is cheaper, **Multi-AZ** for HA in production).
3. **Subnets:** place in **private DB subnets**; **Public access: No** for production.
4. **Security group:** only ECS tasks and (optionally) a **bastion** on 5432.
5. **Credentials:** store in **Secrets Manager**; rotate on schedule.
6. **Connection string** format for the dashboard (Prisma):
   - `postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require`
7. **Backup** window and **retention** (e.g. 7–30 days) per compliance needs.

**Result:** you will have **one** `DATABASE_URL` for the dashboard (see [env-matrix.md](./env-matrix.md)).

---

## 6. RDS PostgreSQL — API regional databases (4×)

The API and worker use **four separate connection strings**:

- `DATABASE_URL_US`
- `DATABASE_URL_EU`
- `DATABASE_URL_UK`
- `DATABASE_URL_AU`

Use four **separate regional database deployments** (RDS instances or Aurora clusters), for example:

- US data -> DB in a US AWS region
- EU data -> DB in an EU AWS region
- UK data -> DB in a UK AWS region
- AU data -> DB in an AU AWS region

Do not map all four URLs to one host if you need regional compliance.

Migrations: **the same** Prisma migration history must be applied to **all four** (see [database-migrations.md](./database-migrations.md)).

---

## 7. S3 buckets (regional)

Create four buckets (names must be globally unique), e.g.:

- `hyrelog-archive-us-ACCOUNT-ENV`
- `hyrelog-archive-eu-...`
- (UK, AU)

**Block public access** on all. Enable **default encryption (SSE-S3 or SSE-KMS)**. Optional: **S3 access logs** to another bucket, **Object Lock** if compliance requires. Map bucket names to `S3_BUCKET_US`, `S3_BUCKET_EU`, `S3_BUCKET_UK`, `S3_BUCKET_AU`.

**Production:** do **not** set `S3_ENDPOINT` (that is for MinIO locally). Set `S3_REGION`, `S3_FORCE_PATH_STYLE=false` (or omit).

---

## 8. AWS Secrets Manager

Create secrets (examples — use your naming convention):

- `hyrelog/api/internal-token`
- `hyrelog/api/api-key-secret`
- `hyrelog/shared/dashboard-service-token` (copy **same** value to dashboard and API)
- `hyrelog/api/database-url-us` … (four secrets or one JSON map — ECS accepts JSON key injection if you use a single secret with multiple keys)
- `hyrelog/dashboard/database-url`
- `hyrelog/api/webhook-secret-encryption-key` (64 hex characters)
- `hyrelog/shared/hyrelog-api-key-secret` (matches API `API_KEY_SECRET`)

**Inject into ECS** using `secrets` in the task definition (see `infra/ecs/*.json`).

---

## 9. ECS cluster

1. **ECS** → “Create cluster” → “Networking: AWS Fargate”.
2. Name: e.g. `hyrelog-prod`.
3. **No need** to pre-create “capacity providers” for Fargate beyond defaults.

---

## 10. ECS task definitions and services

- Register **one task definition per** workload: `hyrelog-api`, `hyrelog-worker`, `hyrelog-dashboard` (or combine API + sidecar if you add one later; **use separate** services for API and worker in production).
- **Task CPU/memory:** e.g. API `512` CPU / `1024` MiB to start; worker similar or higher if large batch work; increase after observing CloudWatch.
- **Network mode:** `awsvpc` (required for Fargate).
- **Subnets:** private subnets with NAT or endpoints.
- **Security groups:** use the **ECS** SG created in §3.
- **Assign public IP:** **Disabled** for private-only egress via NAT, unless you intentionally use a public subnet for tasks (not recommended).

JSON templates: [../../infra/ecs/README.md](../../infra/ecs/README.md)

---

## 11. Application Load Balancer (ALB)

1. **Create ALB** (Internet-facing) in the **public** subnets.
2. **Listeners**
   - `443` (HTTPS) — attach **ACM** certificate (see §12).
   - Optional redirect `80` → `443`.
3. **Target groups** (at least two if API and dashboard in same cluster):
   - **API:** protocol HTTP, target type **IP** (Fargate), health check path **`/health`**, **matcher 200** (add matcher for JSON if needed: API returns `{"ok":true}`).
   - **Dashboard:** health check on `/` or a dedicated `GET /api/health` if you add one; Next.js root may be heavy — prefer a lightweight health route in the dashboard app in a future change.
4. **Stickiness** — usually off for stateless API; on only if you add session affinity.

**Two common patterns**

- **One ALB, two target groups, host-based routing** — rule: `Host: api.hyrelog.com` → API; `Host: app.hyrelog.com` → dashboard. **(Recommended)**
- **Two ALBs** — one per domain (more cost, simpler mental model).

---

## 12. Route 53 and ACM (DNS + TLS)

1. **Register** or **delegate** the domain `hyrelog.com` in **Route 53** (or use an external DNS provider — these instructions assume R53 for simplicity).
2. **Request certificates** in **ACM (us-east-1** if using CloudFront; for ALB alone, use the **same region as the ALB**).
3. **Validate** with DNS: create the **CNAME** records ACM provides.
4. **Attach** the same wildcard `*.hyrelog.com` or two separate cert SANs: `app.hyrelog.com`, `api.hyrelog.com`.
5. **A/AAAA (alias) records** in Route 53:
   - `app.hyrelog.com` → ALB (record type **Alias** to the ALB)
   - `api.hyrelog.com` → same ALB (host-based rules route to the correct target group) **or** separate ALB

---

## 13. CloudWatch — logs and alarms

1. **Log groups** (or let ECS create them on first run): e.g. `/ecs/hyrelog-api`, `/ecs/hyrelog-worker`, `/ecs/hyrelog-dashboard`. Retention: 7–30 days in production.
2. **Alarms (examples)**
   - `UnHealthyHostCount` (target group) > 0 for 5 min
   - `HTTPCode_ELB_5XX_Count` > threshold
   - **RDS** `CPUUtilization`, `FreeStorageSpace`, `DatabaseConnections` above/below limits
3. **SNS** topic → email/Slack for on-call

---

## 14. GitHub setup

### 14.1 Branches and secrets

- Use **`main`** for production (align with the sample workflow).
- In **GitHub → Settings → Secrets and variables → Actions**, add the secrets named in the workflow (see `deploy-production.yml` and `Phase 10` in your runbook). Minimum:
  - `AWS_REGION`
  - `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` **(if not using OIDC)**
  - ECR **repository URIs** (or a prefix + derive names)
  - `ECS_CLUSTER_NAME`, `ECS_SERVICE_API`, `ECS_SERVICE_WORKER`, `ECS_SERVICE_DASHBOARD` (or split by repo)
  - Optional: `DATABASE_URL_US` … for migration job (sensitive) — or run migrations as a **one-off** task in AWS, not in GitHub, if you cannot expose DBs to the internet (recommended for many teams).

### 14.2 GitHub OIDC federation (recommended)

1. In **IAM** → “Identity provider” → **Add** → `token.actions.githubusercontent.com` with audience `sts.amazonaws.com`.
2. **IAM role** (e.g. `GitHubActionsHyrelogDeploy`) with:
   - **Trust policy** allowing `sts:AssumeRoleWithWebIdentity` for your GitHub org/repo and `ref:refs/heads/main`.
   - **Permissions** as in §2 (ECR + ECS + pass role if needed for task registration).
3. In the workflow, use:
   - `aws-actions/configure-aws-credentials` with `role-to-assume: arn:aws:iam::ACCOUNT:role/GitHubActionsHyrelogDeploy` and `role-session-name`.

**You do not store** long-lived `AWS_ACCESS_KEY_ID` in GitHub for this flow.

**Static keys:** still document as opt-in: create IAM user, attach policy, add keys to GitHub secrets, rotate on schedule.

### 14.3 Two repositories

- `hyrelog-api/.github/workflows` — build/push **API and worker**; run checks; **optionally** migrate and deploy those ECS services.
- `hyrelog-dashboard/.github/workflows` — build/push **dashboard**; deploy its ECS service.

The **same** ECR/ECS/region secrets can be configured in both repos, or you restrict the dashboard role to ECR + only the dashboard ECS service.

---

## 15. Smoke tests

See [smoke-tests.md](./smoke-tests.md). Run from your laptop or a CI “post-deploy” job (without storing keys in log output).

---

## 16. Rollback (application)

1. **ECS** → service → “Update service” → set **task definition** to a previous **revision** (the one that worked) → force new deployment.
2. If the failure is a **bad migration** — see [database-migrations.md](./database-migrations.md) (restore from snapshot + re-run, or app downgrade). **Never** delete migration rows manually without a runbook.

---

## 17. What you must do manually (first time)

- Create **VPC, RDS, S3, Secrets, ECR, ALB, ACM, R53, ECS cluster, task definitions, services, CloudWatch** as above.
- **Connect** private subnets, NAT, and security groups correctly (most common source of “tasks cannot pull image” / “503” / “cannot reach database”).
- **Point** `api.hyrelog.com` and `app.hyrelog.com` to the ALB.
- **Fill** all secrets and confirm **cross-app** values (`DASHBOARD_SERVICE_TOKEN`, `API_KEY_SECRET` / `HYRELOG_API_KEY_SECRET`).

## 18. Ongoing process

- Merge to `main` → **checks** run → (optional approval) **deploy** runs → images tagged with SHA → ECS rolling update.
- **Migrations** before or with deploy — see [database-migrations.md](./database-migrations.md) for the order we recommend (often **migrations first**, then new code that depends on the schema, or a backward-compatible “expand” migration strategy).

This guide is the operational spine; the **env-matrix** and **INSPECTION_REPORT** are the source of truth for what the code actually requires.
