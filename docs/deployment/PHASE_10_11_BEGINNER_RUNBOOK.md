# HyreLog Beginner Runbook — Phase 10 and 11 (ECS services + migrations)

This guide continues after Phase 8 and 9 are complete:

- ECS cluster exists (`hyrelog-prod-ecs`)
- Task definitions are registered
- ACM cert is issued
- ALB + target groups + Route 53 records exist

This runbook covers:

- **Phase 10:** Create ECS services and get them stable
- **Phase 11:** Run regional API migrations + dashboard migration safely

---

## 0) Before you start (required vars)

Use Git Bash or PowerShell and set:

```bash
# Optional: stops Git Bash rewriting paths like `/ecs/name` → `C:/Program Files/Git/ecs/name` for aws CLI args
export MSYS_NO_PATHCONV=1

export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ENV_NAME="${ENV_NAME:-prod}"
export PROJECT_PREFIX="${PROJECT_PREFIX:-hyrelog-${ENV_NAME}}"
export PRIMARY_REGION="${PRIMARY_REGION:-ap-southeast-2}"
export ECS_CLUSTER="${ECS_CLUSTER:-${PROJECT_PREFIX}-ecs}"

export DB_REGION_US="${DB_REGION_US:-us-east-1}"
export DB_REGION_EU="${DB_REGION_EU:-eu-west-1}"
export DB_REGION_UK="${DB_REGION_UK:-eu-west-2}"
export DB_REGION_AU="${DB_REGION_AU:-ap-southeast-2}"

export TASK_ROLE_NAME="${TASK_ROLE_NAME:-${PROJECT_PREFIX}-ecs-task-role}"

export ECR_BASE="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com"
export ECR_API="${ECR_BASE}/hyrelog-api"
export ECR_WORKER="${ECR_BASE}/hyrelog-worker"
export ECR_DASHBOARD="${ECR_BASE}/hyrelog-dashboard"

export S3_BUCKET_US="${S3_BUCKET_US:-${PROJECT_PREFIX}-events-us}"
export S3_BUCKET_EU="${S3_BUCKET_EU:-${PROJECT_PREFIX}-events-eu}"
export S3_BUCKET_UK="${S3_BUCKET_UK:-${PROJECT_PREFIX}-events-uk}"
export S3_BUCKET_AU="${S3_BUCKET_AU:-${PROJECT_PREFIX}-events-au}"

# Adjust paths for your PC (Phase 11 dashboard migrations)
export DASHBOARD_ROOT="${DASHBOARD_ROOT:-/c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard}"
```

Keep your worksheet IDs handy for commands that mention them (VPC, subnet, SG IDs differ per deploy):

- Private subnets (`PRIMARY_PRIVATE_SUBNET_1`, `PRIMARY_PRIVATE_SUBNET_2`)
- ECS tasks security group (often `hyrelog-prod-ecs-sg`)
- Target groups: `hyrelog-api-tg`, `hyrelog-dashboard-tg`

Quick check:

```bash
aws ecs describe-clusters --clusters "$ECS_CLUSTER" --region "$PRIMARY_REGION" \
  --query 'clusters[0].[clusterName,status]' --output table
```

---

# Phase 10 — deploy ECS services

## 10.1 Decide service names and desired counts

Recommended service names:

- `hyrelog-api`
- `hyrelog-dashboard`
- `hyrelog-worker`

Recommended initial desired count:

- API: `1`
- Dashboard: `1`
- Worker: `1`

You can scale later.

---

## 10.2 Create API service (with ALB)

### Console steps

1. ECS → **Clusters** → `hyrelog-prod-ecs` → **Services** → **Create**.
2. **Compute options:** Launch type = `FARGATE`.
3. **Application type:** Service.
4. **Family / revision:** pick latest `hyrelog-api`.
5. **Service name:** `hyrelog-api`.
6. **Desired tasks:** `1`.
7. **Deployment options:**
   - Keep rolling update defaults initially.
   - Recommended: enable deployment circuit breaker with rollback.
8. **Networking:**
   - VPC = primary app VPC
   - Subnets = private subnets (`PRIMARY_PRIVATE_SUBNET_1`, `PRIMARY_PRIVATE_SUBNET_2`)
   - Security group = `hyrelog-prod-ecs-sg`
   - Public IP = `DISABLED`
9. **Load balancing:**
   - Type = Application Load Balancer
   - Existing load balancer = `hyrelog-prod-alb`
   - Container = `hyrelog-api`
   - Container port = `3000`
   - Target group = `hyrelog-api-tg`
10. Create service.

### Common mistakes

- Wrong container name (must match task def: `hyrelog-api`)
- Wrong port (must be `3000`)
- Using public subnets with public IP enabled (not recommended)

---

## 10.3 Create dashboard service (with ALB)

Repeat the same wizard, with:

- Family/revision: latest `hyrelog-dashboard`
- Service name: `hyrelog-dashboard`
- Desired tasks: `1`
- Same VPC/private subnets/security group/public IP disabled
- Load balancing:
  - ALB: `hyrelog-prod-alb`
  - Container: `hyrelog-dashboard`
  - Container port: `3000`
  - Target group: `hyrelog-dashboard-tg`

---

## 10.4 Create worker service (no public LB)

Create service again with:

- Family/revision: latest `hyrelog-worker`
- Service name: `hyrelog-worker`
- Desired tasks: `1`
- Same VPC/private subnets/security group/public IP disabled
- **No load balancer** attached

Worker runs background jobs only; it should not be in ALB target groups.

---

## 10.5 Wait for all services to stabilize

Once all three services exist:

```bash
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services hyrelog-api --region "$PRIMARY_REGION"
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services hyrelog-dashboard --region "$PRIMARY_REGION"
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services hyrelog-worker --region "$PRIMARY_REGION"
```

Or use the helper script (updates services to latest task-definition revision and waits):

```bash
PRIMARY_REGION="$PRIMARY_REGION" ECS_CLUSTER="$ECS_CLUSTER" \
bash scripts/deployment/update-ecs-services.sh
```

---

## 10.6 Phase 10 verification checklist

### ECS level

```bash
aws ecs describe-services \
  --cluster "$ECS_CLUSTER" \
  --services hyrelog-api hyrelog-dashboard hyrelog-worker \
  --region "$PRIMARY_REGION" \
  --query 'services[*].[serviceName,status,runningCount,desiredCount]' --output table
```

Expect `status=ACTIVE`, `runningCount=desiredCount`.

### Target group health

```bash
API_TG_ARN=$(aws elbv2 describe-target-groups --names hyrelog-api-tg --region "$PRIMARY_REGION" --query 'TargetGroups[0].TargetGroupArn' --output text)
DASH_TG_ARN=$(aws elbv2 describe-target-groups --names hyrelog-dashboard-tg --region "$PRIMARY_REGION" --query 'TargetGroups[0].TargetGroupArn' --output text)

aws elbv2 describe-target-health --target-group-arn "$API_TG_ARN" --region "$PRIMARY_REGION"
aws elbv2 describe-target-health --target-group-arn "$DASH_TG_ARN" --region "$PRIMARY_REGION"
```

Expect healthy targets after task startup.

### DNS/app checks

```bash
curl -I https://api.hyrelog.com/health
curl -I https://app.hyrelog.com/
```

Expect 200/3xx (not 5xx). If you get 502/503, inspect ECS task logs and target group health reasons.

---

# Phase 11 — run migrations (strict regional)

## 11.0 Important rule

Run migrations only when:

- API/dashboard services are stable
- You are sure all DB URLs point to correct regional databases
- You are in maintenance-safe timing

Backups/snapshots before production migrations are strongly recommended.

---

## 11.1 API migrations (US/EU/UK/AU)

Use the provided script:

- `scripts/deployment/run-api-regional-migrations.sh`

It requires:

- `CONFIRM=YES`
- `DATABASE_URL_US`
- `DATABASE_URL_EU`
- `DATABASE_URL_UK`
- `DATABASE_URL_AU`

### Populating URL env vars (three options)

**A — Same source as ECS (recommended when passwords come from RDS Secrets Manager):**  
ECS builds URLs from RDS-managed secrets (`rds!db-…`) plus `DB_HOST_*`, `DB_PORT_*`, `DB_NAME_*` (see `scripts/docker/docker-entrypoint-database-url.sh`). Mirror that locally with:

- Copy each regional **RDS secret ARN** from `infra/ecs/task-definition-api.json` (use the ARN on `DB_PASSWORD_*` secrets; omit the ECS-only `:password::` suffix — `aws secretsmanager get-secret-value` expects the secret id or ARN only).
- Export `DB_HOST_*`, `DB_PORT_*`, `DB_NAME_*` to match the task definition environment block.
- `source scripts/deployment/export-api-phase11-database-urls-from-rds-secrets.sh`

That exports `DATABASE_URL_US` … `DATABASE_URL_AU` without pasting passwords by hand.

**B — Stored full URLs (`${PROJECT_PREFIX}/DATABASE_URL_*` in `PRIMARY_REGION`):**  
If you still maintain these after `bootstrap-secrets-from-template.sh` (and rotate them whenever RDS rotates master credentials):

```bash
export DATABASE_URL_US="$(aws secretsmanager get-secret-value --secret-id "${PROJECT_PREFIX}/DATABASE_URL_US" --region "$PRIMARY_REGION" --query SecretString --output text)"
# repeat for _EU _UK _AU
```

Prefer **A** whenever API uses dynamic RDS secrets and the stored full URL might be stale after rotation.

**C — Paste full URLs manually** (fine for emergencies only).

### Step-by-step: Option A (RDS secrets — recommended)

Follow these steps **in order** in **Git Bash opened from the Start menu** (interactive window). Do **not** double-click `.sh` files in Explorer, or the window may close before you can read messages.

#### 1) Open the repo

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
```

(On your machine, replace the path if Dropbox lives elsewhere.)

#### 2) Load your usual deployment env vars (after reboot this is mandatory)

Paste the exports from **[§ Before you start](#0-before-you-start-required-vars)** (`PRIMARY_REGION`, `PROJECT_PREFIX`, `ECS_CLUSTER`, `MSYS_NO_PATHCONV`, etc.). At minimum you need working `aws sts get-caller-identity` so the CLI knows your profile.

Sanity:

```bash
aws sts get-caller-identity
```

Your IAM principal must allow **`secretsmanager:GetSecretValue`** for each RDS secret (each RDS lives in **its AWS region**: US `us-east-1`, EU `eu-west-1`, UK `eu-west-2`, AU `ap-southeast-2`).

#### 3) Install Node dependencies once (if you have not yet at repo root)

The migration script runs `npx prisma` under `services/api`:

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
npm install
```

(If monorepo uses `pnpm`, use whatever you normally use so `services/api/node_modules` / root `node_modules` exists and `prisma` can run.)

#### 4) Collect four RDS secret ARNs from your task definition

Open `infra/ecs/task-definition-api.json` and find the **`secrets`** entries named `DB_PASSWORD_US`, `DB_PASSWORD_EU`, `DB_PASSWORD_UK`, `DB_PASSWORD_AU`.

Each `valueFrom` is an ARN that may end with **`:password::`** — that suffix is **only for ECS**. For CLI + `export-api-phase11-database-urls-from-rds-secrets.sh`, use the ARN **without** the `:username::` or `:password::` suffix (everything up to and including `...`-**randomSixChars** typically works as `--secret-id`).

#### 5) Collect host, port, and database names from the same file

Still in `task-definition-api.json`, note the **`environment`** entries `DB_HOST_US` … `DB_HOST_AU`, `DB_PORT_*`, `DB_NAME_*` — your exports must match.

#### 6) Export the inputs for the loader script

Example shape (paste your **real** ARNs and hosts):

```bash
export RDS_SECRET_ID_US='arn:aws:secretsmanager:us-east-1:YOUR_ACCOUNT_ID:secret:rds!db-xxxx'
export RDS_SECRET_ID_EU='arn:aws:secretsmanager:eu-west-1:YOUR_ACCOUNT_ID:secret:rds!db-xxxx'
export RDS_SECRET_ID_UK='arn:aws:secretsmanager:eu-west-2:YOUR_ACCOUNT_ID:secret:rds!db-xxxx'
export RDS_SECRET_ID_AU='arn:aws:secretsmanager:ap-southeast-2:YOUR_ACCOUNT_ID:secret:rds!db-xxxx'

export DB_HOST_US='…'
export DB_HOST_EU='…'
export DB_HOST_UK='…'
export DB_HOST_AU='…'

export DB_PORT_US='5432'
export DB_PORT_EU='5432'
export DB_PORT_UK='5432'
export DB_PORT_AU='5432'

export DB_NAME_US='hyrelog_us'
export DB_NAME_EU='hyrelog_eu'
export DB_NAME_UK='hyrelog_uk'
export DB_NAME_AU='hyrelog_au'
```

Optional: export `RDS_REGION_US` … `RDS_REGION_AU` if your secret ARN’s AWS region differs. Defaults (`us-east-1`, `eu-west-1`, `eu-west-2`, `ap-southeast-2`) match the helper script unless you override (the script also falls back to `DB_REGION_*` from your shell — same names as the [Phase 6 runbook](PHASE_6_7_BEGINNER_RUNBOOK.md)).

#### 7) Source the exporter (fills `DATABASE_URL_*` in **this shell** only)

Stay in `/c/Users/kram/Dropbox/hyrelog/hyrelog-api`:

```bash
source scripts/deployment/export-api-phase11-database-urls-from-rds-secrets.sh
```

You should see: `Exported DATABASE_URL_* …`. If AWS errors appear, fix IAM or ARNs — you should remain at a prompt (**the script must not kill your shell**).

#### 8) Confirm you will run migrations (safety latch)

```bash
export CONFIRM=YES
```

#### 9) Run the migrations

```bash
bash scripts/deployment/run-api-regional-migrations.sh
```

The script loops **US → EU → UK → AU** and runs `npx prisma migrate deploy` in `services/api` for each. Wait until you see **`All four regions migrated successfully.`**

#### 10) Connection failures

If you see timeouts or connection refused to Postgres, your workstation may not route to **private RDS** endpoints. Apply **[§ 11.3](#113-network-access-note-important)** (bastion / VPN / ECS task runner) before retrying — using the **same shell steps**.

---

### Running the API migrations again

| Situation | What to redo |
|-----------|----------------|
| Same Git Bash session, migrations already succeeded, you applied **new migration files** and want deploy again | `export CONFIRM=YES` and `bash scripts/deployment/run-api-regional-migrations.sh` — `DATABASE_URL_*` remain in env. |
| New Git Bash / PC restart / terminal tab | Reload **[§ Before you start](#0-before-you-start-required-vars)**, redo **§ 11.1 steps 4→9** (`export` RDS + DB vars → `source export-api…` → `CONFIRM` → `bash run-api…`). |
| RDS master password rotated in AWS but task def still pointed at same secret | Re-`source` the exporter (**step 7**); URLs pick up fresh password from Secrets Manager (no pasted URL). |

Idempotent behaviour: **`prisma migrate deploy` is safe to re-run**; already-applied migrations are skipped.

Debug one shot:

```bash
export CONFIRM=YES
bash -x scripts/deployment/run-api-regional-migrations.sh 2>&1 | tee /c/Users/kram/Dropbox/hyrelog/api-migrate-api.log
```

(Option C manual URLs — paste into env then run.)

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
export CONFIRM=YES
export DATABASE_URL_US="postgresql://...us..."
export DATABASE_URL_EU="postgresql://...eu..."
export DATABASE_URL_UK="postgresql://...uk..."
export DATABASE_URL_AU="postgresql://...au..."
bash scripts/deployment/run-api-regional-migrations.sh
```

The script runs `npx prisma migrate deploy` once per region.

---

## 11.2 Dashboard migration

Use:

- `scripts/deployment/run-dashboard-migrations.sh`

Required:

- `CONFIRM=YES`
- `DATABASE_URL` (dashboard DB URL)
- `DASHBOARD_ROOT` (path to `hyrelog-dashboard` repo)

If you created **`${PROJECT_PREFIX}/DATABASE_URL`** during Phase 6 (`bootstrap-secrets-from-template`), you can pull it instead of paste:

```bash
export DATABASE_URL="$(aws secretsmanager get-secret-value --secret-id "${PROJECT_PREFIX}/DATABASE_URL" --region "$PRIMARY_REGION" --query SecretString --output text)"
```

Command:

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
export CONFIRM=YES
export DATABASE_URL="postgresql://...dashboard..."
export DASHBOARD_ROOT="/c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard"
bash scripts/deployment/run-dashboard-migrations.sh
```

### **`P1001` on dashboard from your laptop**

The dashboard RDS hostname is reachable only **inside VPC network paths**, same reasoning as **`§ 11.3`** and the regional API databases. **`run-dashboard-migrations.sh`** on your PC will normally fail with **`P1001`** until you use VPN/bastion or run migrations **inside ECS**.

---

### Dashboard migration via ECS one-off task (`run-dashboard-migrations-ecs-task.sh`)

**1)** The **`hyrelog-dashboard`** production image historically shipped **only** the Next.js standalone bundle (`server.js`). The repo Dockerfile now **`COPY`**s **`prisma/`** and **`prisma.config.ts`** into `/app` so a one-off task can run **`prisma migrate deploy`**.  

**→ Rebuild, push to ECR, and register/update the ECS task definition** with the new dashboard image tag **before** relying on ECS migrations (otherwise the container filesystem has nothing to migrate with).

**2)** Networking values come from the **`hyrelog-dashboard`** service (**not** necessarily identical to **`hyrelog-api`** if you ever diverge subnets/SGs):

```bash
export PRIMARY_REGION=ap-southeast-2
export ECS_CLUSTER=hyrelog-prod-ecs

aws ecs describe-services \
  --cluster "$ECS_CLUSTER" \
  --services hyrelog-dashboard \
  --region "$PRIMARY_REGION" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' \
  --output json
```

Paste **`subnets`** → **`ECS_SUBNET_IDS`**, **`securityGroups`** → **`ECS_SECURITY_GROUP_IDS`**.

Or use **ECS Console** → Cluster → **`hyrelog-dashboard`** → **Networking**.

**3)** Run:

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api

export PRIMARY_REGION=ap-southeast-2
export ECS_CLUSTER=hyrelog-prod-ecs
export ECS_SUBNET_IDS="subnet-xxxx,subnet-yyyy"
export ECS_SECURITY_GROUP_IDS="sg-zzzz"

bash scripts/deployment/run-dashboard-migrations-ecs-task.sh
```

The task inherits **`DATABASE_URL`** from the dashboard task-definition secrets (**same behaviour as production**). Logs: **CloudWatch** → **`/ecs/hyrelog-dashboard`**.

Optional: **`TASK_DEFINITION`** (defaults to **`hyrelog-dashboard`**), **`PRISMA_CLI_VERSION`** (default **`7.7.0`** to match **`hyrelog-dashboard`** `package.json`). First **`npx`** may need **NAT/registry egress**.

---

## 11.2a Step-by-step — dashboard TLS (RDS), Resend secret, rebuild, and redeploy

Use this once you have merged the dashboard fixes (**`NODE_EXTRA_CA_CERTS` + RDS CA in `Dockerfile`**, **`Pool` SSL in `lib/prisma.ts`**, lazy **`Resend`**, **`RESEND_API_KEY`** reference in **`hyrelog-api`** `infra/ecs/task-definition-dashboard.json`). It rolls everything to ECS so **`P1011` TLS chain errors** and **“Missing API key” Resend** stop in production.

### 0) What you’re shipping

| Change | Purpose |
|--------|---------|
| **Dockerfile** downloads AWS **`global-bundle.pem`** and sets **`NODE_EXTRA_CA_CERTS`** | Node/pg trust RDS TLS certs (fixes “self-signed certificate in certificate chain”). |
| **`lib/prisma.ts`** uses **`pg.Pool`** with **`ssl`** for **`*.rds.amazonaws.com`** | Explicit TLS behaviour with `pg`; optional **`RDS_PG_SSL_REJECT_UNAUTHORIZED=false`** escape hatch document below. |
| **Resend** constructed only inside send paths | Avoids crashing on module load when **`RESEND_API_KEY`** was missing at cold start. |
| **Task definition** **`secrets`** entry **`RESEND_API_KEY`** | Injects production key like other secrets (you must **create** the Secrets Manager secret). |

Paths: **`hyrelog-dashboard`** (app + Dockerfile) and **`hyrelog-api`** (task-definition JSON committed under **`infra/ecs/`**).

---

### 1) Pull latest code locally

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard
git pull

cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
git pull
```

---

### 2) Create **`RESEND_API_KEY`** in Secrets Manager (production)

Dashboard emails need a **[Resend](https://resend.com/)** API key. The ECS task expects this secret name (**must match task definition ARN**):

- **`hyrelog/RESEND_API_KEY`** in **`ap-southeast-2`** — see `infra/ecs/task-definition-dashboard.json`.

**If your org uses **`hyrelog-prod/`** secret names**, edit **`valueFrom`** in that JSON **before** registering the task definition, or duplicate the secret into **`hyrelog/RESEND_API_KEY`**.

Create (adjust region/account):

```bash
export PRIMARY_REGION=ap-southeast-2

aws secretsmanager describe-secret \
  --secret-id "hyrelog/RESEND_API_KEY" \
  --region "$PRIMARY_REGION" 2>/dev/null \
|| aws secretsmanager create-secret \
      --name "hyrelog/RESEND_API_KEY" \
      --secret-string "re_YOUR_KEY_FROM_RESEND_DASHBOARD" \
      --region "$PRIMARY_REGION"
```

To **update** an existing stub:

```bash
aws secretsmanager put-secret-value \
  --secret-id "hyrelog/RESEND_API_KEY" \
  --secret-string "re_YOUR_KEY" \
  --region "$PRIMARY_REGION"
```

**IAM:** ECS **task execution role** (`hyrelog-prod-ecs-execution-role` or your equivalent) already needs **`secretsmanager:GetSecretValue`** on the ARNs referenced in the task definition (including **`hyrelog/*`**). Ensure policy matches your secret ARN pattern).

---

### 3) Align **`task-definition-dashboard.json`** (image tag + secrets)

Open **`hyrelog-api`** `infra/ecs/task-definition-dashboard.json`:

1. Confirm the **`secrets`** block includes **`RESEND_API_KEY`** → **`hyrelog/RESEND_API_KEY`** (or your edited ARN).

2. Set **`containerDefinitions[0].image`** to **`${YOUR_ACCOUNT}.dkr.ecr.ap-southeast-2.amazonaws.com/hyrelog-dashboard:NEW_TAG`** — replace **`NEW_TAG`** with the **`IMAGE_TAG`** you will build below (often `YYYYMMDDHHmm-<git-sha>`), not `latest`.

3. **`ACCOUNT_ID` / ARN / image name mistakes** (`Parameter validation`) — double-check account ID **`163436765242`** and region **`ap-southeast-2`** match your environment.

Git Bash (**`MSYS_NO_PATHCONV=1`** if **`file://`** misbehaves):

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
export PRIMARY_REGION=ap-southeast-2
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

IMAGE_TAG="$(date +%Y%m%d%H%M)-dashboard-$(git -C ../hyrelog-dashboard rev-parse --short HEAD)"

# Edit infra/ecs/task-definition-dashboard.json: set "image": ".../hyrelog-dashboard:${IMAGE_TAG}"
# Then register:
aws ecs register-task-definition \
  --cli-input-json "file://${PWD}/infra/ecs/task-definition-dashboard.json" \
  --region "$PRIMARY_REGION"

```

Note **`register-task-definition`** prints **`taskDefinition.revision`**. Capture **family:revision**, e.g. **`hyrelog-dashboard:42`**.

---

### 4) Docker: log in to ECR and build push **dashboard**

From **[Phase 7.2 / 7.4](PHASE_6_7_BEGINNER_RUNBOOK.md)** pattern:

```bash
export PRIMARY_REGION=ap-southeast-2
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_DASHBOARD="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com/hyrelog-dashboard"
export IMAGE_TAG="$(date +%Y%m%d%H%M)-$(cd /c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard && git rev-parse --short HEAD)"

aws ecr get-login-password --region "$PRIMARY_REGION" \
| docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com"

cd /c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard

docker build \
  --build-arg NEXT_PUBLIC_APP_URL="https://app.hyrelog.com" \
  --build-arg NEXT_PUBLIC_API_BASE_URL="https://api.hyrelog.com" \
  -t "${ECR_DASHBOARD}:${IMAGE_TAG}" \
  -t "${ECR_DASHBOARD}:latest" \
  .

docker push "${ECR_DASHBOARD}:${IMAGE_TAG}"
docker push "${ECR_DASHBOARD}:latest"
```

**Then** paste **`"${IMAGE_TAG}"`** into **`task-definition-dashboard.json`** `image`, **`register-task-definition`** again — or register **before** push only if CI allows (image must exist at deploy time).

---

### 5) Point the ECS **service** at the new revision

```bash
export ECS_CLUSTER=hyrelog-prod-ecs
export TASK_DEF="hyrelog-dashboard:LATEST_REVISION"   # replace with output from register-task-definition

aws ecs update-service \
  --cluster "$ECS_CLUSTER" \
  --service hyrelog-dashboard \
  --task-definition "$TASK_DEF" \
  --force-new-deployment \
  --region "$PRIMARY_REGION"

aws ecs wait services-stable \
  --cluster "$ECS_CLUSTER" \
  --services hyrelog-dashboard \
  --region "$PRIMARY_REGION"
```

---

### 6) Validate

1. **CloudWatch** → **`/ecs/hyrelog-dashboard`** — no **`self-signed certificate`**, no **`TlsConnectionError`** on login.
2. **`https://app.hyrelog.com`** — flows that send mail no longer raise **Resend constructor** errors (**if **`RESEND_API_KEY`** reached the task**: check ECS task stopped events for **`ResourceInitializationError` / secrets**).
3. If TLS still fails after CA bundle (**rare**): temporarily add ECS task **`environment`** (dashboard container) **`RDS_PG_SSL_REJECT_UNAUTHORIZED` = **`false`** (document why; traffic remains encrypted).

---

### 7) Local **`hyrelog-dashboard/.env`**

Never commit **`RESEND_API_KEY`** or **`DATABASE_URL`**. ECS does not read your laptop **`.env`**; production relies on **Secrets Manager** + task definition.

---

## 11.3 Network access note (important)

`prisma migrate deploy` must be able to reach each RDS TCP endpoint (**port `5432`**) using the URL you exported.

### If you see Prisma **`P1001: Can't reach database server`** from your laptop

That almost always means **network routing**, not “wrong password”:

- RDS is in **private subnets** and reachable only from your **VPC-linked** workloads (ECS tasks, bastions, VPN clients with routes into those subnets, etc.).
- A **random home/off‑office workstation is not allowed** via the RDS security group and has **no VPC route**, so Postgres never responds at the hostname — Prisma surfaces that as **`P1001`**.
- **`localhost` PostgreSQL installs do not fix this.** The client must run **somewhere inside the VPC path** approved for RDS (same subnets/SGs you used for ECS, or tooling that portals into them).

Do **not** open RDS **`0.0.0.0/0`** in production except as a deliberate, time‑boxed break‑glass exercise if your org forbids cleaner options.

### Run regional API migrations from ECS (recommended when laptops cannot reach RDS)

**What this does:** Starts a **one-off Fargate task** using the **`hyrelog-api`** task definition (same image, Secrets Manager references, and entrypoint as production). The task runs in **your VPC** on the **same subnets and security groups** as the **`hyrelog-api` ECS service**, so reachability to regional RDS matches running tasks.

**Script:** `scripts/deployment/run-api-regional-migrations-ecs-task.sh`

You run it from **your laptop** (AWS CLI + Git Bash). It calls **`aws ecs run-task`** with your networking and a **command override** that runs **`prisma migrate deploy`** for **US → EU → UK → AU**.

The prod image **`npm prune`** removes the Prisma CLI; the script uses **`npx --yes prisma@VERSION migrate deploy`** (default **`PRISMA_CLI_VERSION=7.2.0`** — align with `services/api/package.json`). Tasks need **NAT (or equivalent) egress** so `npx` can reach the npm registry on first run unless you bake Prisma into the image later.

Other valid patterns (depending on security review): **SSM port‑forward**, **Client VPN**, **temporary bastion**.

---

#### Where to get each piece of information

| Variable | What it is | Where to find it |
|----------|------------|------------------|
| **`PRIMARY_REGION`** | Region where **ECS + ECR** live (not the US/EU RDS regions). | AWS Console **top-right region**; must match when you open ECS. Typical: **`ap-southeast-2`**. |
| **`ECS_CLUSTER`** | Cluster that holds **`hyrelog-api`**. | **ECS** → **Clusters** → copy name (e.g. `hyrelog-prod-ecs`). CLI: `aws ecs list-clusters --region "$PRIMARY_REGION"`. |
| **`ECS_SUBNET_IDS`** | Private subnets the **API service** uses. | **ECS** → **Clusters** → cluster → **Services** → **`hyrelog-api`** → **Networking**: copy every **subnet ID**. Usually **two** subnets, two AZs. CLI: see step below. |
| **`ECS_SECURITY_GROUP_IDS`** | Security groups on the **API tasks** (often one SG, e.g. `hyrelog-prod-ecs-sg`). **Not** the ALB SG. | Same **Networking** section → Security groups. CLI: same JSON as subnets. |

**One-shot CLI** — dumps subnets + SGs for `hyrelog-api`:

```bash
export ECS_CLUSTER=hyrelog-prod-ecs
export PRIMARY_REGION=ap-southeast-2

aws ecs describe-services \
  --cluster "$ECS_CLUSTER" \
  --services hyrelog-api \
  --region "$PRIMARY_REGION" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' \
  --output json
```

Paste **`subnet`** IDs comma-separated (**no spaces**) into **`ECS_SUBNET_IDS`** and **`securityGroups`** into **`ECS_SECURITY_GROUP_IDS`**.

Sanity: **`assignPublicIp`** should match prod (**`DISABLED`** for tasks without public IP).

Optional **`TASK_DEFINITION`**: defaults to **`hyrelog-api`** (latest); pin **`hyrelog-api:42`** from **ECS** → **Task definitions** if needed. **`CONTAINER_NAME`** defaults to **`hyrelog-api`** (must match `task-definition-api.json`).

---

#### Execute (Git Bash)

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api

export PRIMARY_REGION=ap-southeast-2
export ECS_CLUSTER=hyrelog-prod-ecs
export ECS_SUBNET_IDS="subnet-xxxx,subnet-yyyy"
export ECS_SECURITY_GROUP_IDS="sg-zzzz"

bash scripts/deployment/run-api-regional-migrations-ecs-task.sh
```

Adjust the **`cd`** path if your checkout lives elsewhere.

---

#### Confirm success

1. Script prints success or shows a failure from **`aws ecs wait`** / exit code.
2. **ECS** → **Clusters** → **Tasks** → open the migration task → container **Exit code `0`**.
3. **CloudWatch** → Log group **`/ecs/hyrelog-api`** → newest stream → **`Migrating region US`** … **`AU`**, Prisma **`migrate deploy`** lines.

Describe a stopped task:

```bash
TASK_ARN="arn:aws:ecs:REGION:ACCOUNT:task/CLUSTER/TASK_ID"

aws ecs describe-tasks \
  --cluster "$ECS_CLUSTER" \
  --tasks "$TASK_ARN" \
  --region "$PRIMARY_REGION" \
  --query 'tasks[0].containers[*].[name,exitCode,reason]' \
  --output table
```

---

#### Running again later

| Situation | What to reuse |
|-----------|----------------|
| **Networking unchanged** | Same **`ECS_SUBNET_IDS`** and **`ECS_SECURITY_GROUP_IDS`**. |
| **Only env/session stale** | Re‑run **`describe-services`** or reuse notes; export vars again; run the script. |
| **New migration files shipped** | Prefer a task definition revision whose container image includes those migrations; set **`TASK_DEFINITION`** if you pin revisions. **`migrate deploy`** is safe to repeat if nothing new applies. |

---

### Credential hygiene

If you pasted full **`DATABASE_URL_*`** URLs or debug logs **into chats, screenshots, tickets, or public paste sites**, rotate those RDS credentials promptly and treat those URLs as leaked.

---

## 11.4 Post-migration checks

1. Confirm scripts finished with success (no failed migration errors).
2. Re-check service health:

```bash
aws ecs wait services-stable --cluster "$ECS_CLUSTER" --services hyrelog-api hyrelog-dashboard hyrelog-worker --region "$PRIMARY_REGION"
```

3. Run quick smoke test:

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
DASHBOARD_URL="https://app.hyrelog.com" API_URL="https://api.hyrelog.com" \
bash scripts/deployment/smoke-test-production.sh
```

---

## Phase 11 completion checklist

- [ ] API migrations applied successfully in US/EU/UK/AU
- [ ] Dashboard migration applied successfully
- [ ] ECS services stable after migrations
- [ ] `https://api.hyrelog.com/health` healthy
- [ ] Dashboard loads and can reach API

---

## Troubleshooting quick map

- **Service stuck in `PROVISIONING` / `PENDING`**: subnet/SG/ENI capacity issues, task role/execution role issues, or image pull failures.
- **Target group unhealthy**: wrong container name/port, app not listening on `3000`, health path mismatch.
- **`CannotPullContainerError`**: ECR permissions or missing image tag.
- **Secrets access errors**: execution role missing `secretsmanager:GetSecretValue` (including cross-region secret ARNs).
- **Migration connect timeout**: no network path from where you run script to RDS endpoint.
- **Prisma `P1001` from laptop**: RDS is private; run migrations **[from ECS §11.3](#113-network-access-note-important)** or another in‑VPC path — not from ordinary home IPs.
- **Git Bash window flashes closed**: Open **Git Bash** from the Start menu (interactive session), then `cd` into the repo and run commands — do **not** double‑click `.sh` files from Explorer (the window exits as soon as the script ends). Also avoid `set -e` in scripts you **`source`**: if AWS or `$(...)` fails, `set -e` can exit the **login shell** and close the window; the repo’s `export-api-phase11-database-urls-from-rds-secrets.sh` is written so sourcing it does not do that.
- **Windows opens the Python installer** when running a script: uninstalled **`python`** / **`python3`** commands often invoke the Microsoft Store stub — **`run-*-migrations-ecs-task.sh`** use **Node** for JSON (`node` required on PATH; install [`nodejs.org` LTS](https://nodejs.org/) or ensure `PATH` resolves to a real `node.exe`).

---

## Related docs

- **§ 11.2a** in this file — [Dashboard TLS + Resend redeploy](#112a-step-by-step-dashboard-tls-rds-resend-secret-rebuild-and-redeploy)
- `docs/deployment/PHASE_8_9_BEGINNER_RUNBOOK.md`
- `docs/deployment/STEP_BY_STEP_AWS.md`
- `scripts/deployment/update-ecs-services.sh`
- `scripts/deployment/run-api-regional-migrations.sh`
- `scripts/deployment/run-api-regional-migrations-ecs-task.sh` (VPC: API regional migrations — use when laptops get `P1001`)
- `scripts/deployment/run-dashboard-migrations-ecs-task.sh` (VPC: dashboard migrations — rebuild dashboard image **with `prisma/` in image** first)
- `scripts/deployment/run-dashboard-migrations.sh`
