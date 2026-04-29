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

### 3.0 How HyreLog actually uses this (so you set the right networking)

In code, the **API and worker** load **all four** URLs (`DATABASE_URL_US`, `DATABASE_URL_EU`, `DATABASE_URL_UK`, `DATABASE_URL_AU`) and open connections to the database that matches each company’s **data region** (see `getDatabaseUrl` / `regionRouter.getPrisma` in `hyrelog-api`).

So for production you typically have:

| Piece | Where it runs | What it talks to |
|--------|-----------------|------------------|
| API + worker (ECS) | **Primary region** (one cluster) | **All four** regional API PostgreSQL instances (by region) |
| Dashboard (Next.js ECS) | **Primary region** | **Dashboard** PostgreSQL in primary region (`DATABASE_URL` in dashboard) |

That is **one app tier + regional data plane**: you were **not** wrong — it is **one** API/worker deployment and **separate** RDS in US / EU / UK / AU. Those four databases are **not** in the same VPC as ECS unless you put them there; in this guide they live in **dedicated DB VPCs** per region, so the API **must** reach them over **inter-region private networking** (recommended below) or an **explicit, security-reviewed** public endpoint design.

**Recommended setup for this codebase:** run ECS in `PRIMARY_VPC` in `${PRIMARY_REGION}`, run each API regional RDS in a **dedicated** `${PROJECT_PREFIX}-db-*` VPC in the matching **AWS** region, and connect the primary VPC to each DB VPC with **inter-Region VPC peering** (one peering per DB region), plus **routes** and **security groups** as below. (Use **AWS Transit Gateway** with inter-Region peering if your org already standardizes on TGW; same logical idea.)

Document your **primary VPC CIDR** (this guide uses `10.10.0.0/16`; if you used `10.0.0.0/16`, use that consistently in all routes) and the **DB VPC CIDRs** in your worksheet.

---

### 3.1 Topology decision (recommended for first strict launch)

Use:

- **Primary region VPC**: ECS + ALB + dashboard DB
- **One DB VPC per API data region**: US, EU, UK, AU

This keeps each API regional DB physically local to its AWS region. The **primary** VPC holds the **single** API/worker service that **still** connects to all four API regions over peering (or TGW).

---

### 3.2 Primary region VPC (console) — step by step

In `${PRIMARY_REGION}`:

1. Open **VPC** → **Create VPC** → **VPC and more** (one-click with subnets, IGW, optional NAT).
2. **Name tag**: `${PROJECT_PREFIX}-primary-vpc`
3. **IPv4 CIDR**: e.g. `10.10.0.0/16` (must not overlap any DB VPC CIDR you will create).
4. **Availability Zones**: 2
5. **Subnets**:
   - **Public**: 2 (for ALB, NAT gateway)
   - **Private**: 2 (for ECS; optionally RDS for dashboard in primary)
6. **NAT gateway** (AWS new UI may offer **“Regional (multi-AZ) NAT”** or **1 per AZ**; either is valid):
   - **1 NAT** in one public subnet: lower cost, single-AZ risk for outbound if that AZ is impaired.
   - **1 per AZ** or **regional** multi-AZ NAT: higher resiliency for outbound. Pick based on budget and HA needs.
7. **VPC endpoints (optional but useful):** you can set **S3 gateway** to **None** in the quick wizard and add an **S3 gateway endpoint** later to avoid NAT charges for S3; not required to finish Phase 3.
8. **Create VPC**.

**Record in your worksheet (primary region):**

- `PRIMARY_VPC_ID`
- `PRIMARY_PUBLIC_SUBNET_1` / `PRIMARY_PUBLIC_SUBNET_2`
- `PRIMARY_PRIVATE_SUBNET_1` / `PRIMARY_PRIVATE_SUBNET_2`
- CIDR: e.g. `PRIMARY_VPC_CIDR=10.10.0.0/16` (or your actual block)

---

### 3.3 DB region VPCs (US / EU / UK / AU) — step by step

**Repeat in each of** `${DB_REGION_US}`, `${DB_REGION_EU}`, `${DB_REGION_UK}`, `${DB_REGION_AU}`:

1. Switch the console to that **AWS region** (top right).
2. **VPC** → **Create VPC** → **VPC only** (keeps the DB world minimal: no NAT required for RDS alone).
3. **Name**: `${PROJECT_PREFIX}-db-us` (or `-db-eu`, `-db-uk`, `-db-au`)
4. **IPv4 CIDR** — use a **non-overlapping** `/16` per region, for example:
   - US: `10.21.0.0/16`
   - EU: `10.22.0.0/16`
   - UK: `10.23.0.0/16`
   - AU: `10.24.0.0/16`
5. **Create VPC**.
6. **Subnets** (still in that region): **Subnets** → **Create subnet** — create **two private subnets** in **two different AZs** in this VPC (sized `/24` or as you prefer) for a future **DB subnet group**. Do not attach an Internet Gateway for RDS-only use.
7. (Optional) **Route table**: the wizard may create a “main” route table. Ensure these subnets are associated with a route table that has **local** `10.21.0.0/16` (or the region’s CIDR) only, until you add the **peering route** in section 3.4.

**Record per region:**

- `DB_VPC_ID_US` / `EU` / `UK` / `AU`
- The two **private** subnet IDs for the RDS subnet group
- The **CIDR** for that VPC

**NAT in DB VPCs?** For **only** RDS, you usually **do not** need a NAT gateway in these VPCs. Add NAT (or AWS endpoints) only if you run something in a private subnet that must reach the public internet.

---

### 3.4 Inter-Region VPC peering (connect primary ECS to each API DB VPC) — step by step

You need **four** peering relationships: **primary ↔ US**, **primary ↔ EU**, **primary ↔ UK**, **primary ↔ AU**. Same AWS account is assumed.

For **each** API DB region (example: US):

1. In **one** of the two regions (usually **start in the primary region** for consistency), open **VPC** → **Peering connections** → **Create peering connection**.
2. **Name**: e.g. `hyrelog-prod-pcx-primary-to-us`
3. **Requester VPC**: the **primary** VPC in `${PRIMARY_REGION}`.
4. **Accepter VPC**: select **Region** = `${DB_REGION_US}` and choose `${PROJECT_PREFIX}-db-us`.
5. **Create** the request, then **switch** console region to `${DB_REGION_US}` → same **Peering connections** page → **Accept** the request.
6. **Edit peering options** (after active):
   - Enable **“Allow DNS resolution from requester to accepter”** and **accepter to requester** as the console offers (wording can vary by UI). This helps ECS in the primary region **resolve** the regional RDS **private** hostname to the right address.
7. **Routes — critical:**

   In **primary region**, open **Route tables** → select the **private** subnet route table used by **ECS** (or the shared private RT):

   - Add route: **Destination** = `10.21.0.0/16` (US DB VPC CIDR) — **Target** = this peering connection `pcx-…`

   In **US** region, open **Route tables** for the **DB** private subnets:

   - Add route: **Destination** = your **primary** VPC CIDR (e.g. `10.10.0.0/16` or `10.0.0.0/16`) — **Target** = the **same** peering connection (shown in the US region for that pcx)

8. Repeat for EU (`10.22.0.0/16`), UK (`10.23.0.0/16`), AU (`10.24.0.0/16`), each time choosing the peering to the right regional DB VPC and adding **both** sides of the route (primary private RT → that DB CIDR; DB private RT → primary CIDR).

**Why this matches HyreLog:** the API in `PRIMARY_VPC` initiates **TCP 5432** to each inter-region **RDS private IP**; the return traffic uses the same peering. No public RDS required if routes + SGs are correct.

**Transit Gateway (alternative):** if you use TGW, replace each `pcx` with **TGW** attachments and the **same** CIDR-based routes; document TGW and attachment IDs in your worksheet.

---

### 3.5 Security groups — full beginner walkthrough

Create security groups in this **order** so you can “reference” another SG in rules. Replace names with your prefix.

#### A) Primary region — ALB

1. **EC2** → **Security groups** (region = `${PRIMARY_REGION}`) → **Create security group**
2. **Name**: `${PROJECT_PREFIX}-alb-sg`
3. **VPC**: primary VPC
4. **Inbound rules**:
   - **HTTPS (443)**, Source **0.0.0.0/0** (or a corporate allowlist if you have one; `0.0.0.0/0` is standard for a public app/API)
5. **Outbound rules**: default **all traffic** to `0.0.0.0/0` is typical (ALB to targets). Save.
6. Note **Security group ID**: `SG_ALB`

#### B) Primary region — ECS tasks (API, worker, dashboard)

1. **Create security group**
2. **Name**: `${PROJECT_PREFIX}-ecs-sg`
3. **VPC**: primary VPC
4. **Inbound rules**:
   - **Custom TCP 3000** (or the port your target group uses), **Source** = **SG** `${PROJECT_PREFIX}-alb-sg` (the ALB SG you just made)
5. (Optional) If you use **intra-ECS** service mesh or an internal only target group, add only what you need; for standard ALB → Fargate, the rule above is the main one.
6. **Outbound**:
   - **Default** “all outbound” is normal so tasks can use NAT for general egress **and** reach peered **RDS** per routes you added. If you later lock this down, keep **at least** TCP 5432 to the DB SGs and HTTPS for AWS APIs, etc.
7. Note **ID**: `SG_ECS`

#### C) Primary region — dashboard RDS (PostgreSQL in primary)

1. **Create security group**
2. **Name**: `${PROJECT_PREFIX}-dashboard-rds-sg`
3. **VPC**: primary VPC
4. **Inbound**:
   - **PostgreSQL 5432**, **Source** = `SG_ECS` (the ECS group), so only your tasks can connect to the dashboard database
5. **Outbound**: default; RDS rarely needs custom outbound. Save. Note `SG_DASH_RDS`

#### D) Per API data region — API RDS (US, EU, UK, AU) — do this in **each** DB region

**AWS rule:** for a peer VPC in a **different Region**, you **cannot** reference a security group ID in the peering **source** rule. You must use the **CIDR of the primary (requester) VPC** where ECS runs (see [Reference peer security groups](https://docs.aws.amazon.com/vpc/latest/peering/vpc-peering-security-groups.html)).

For **example** in `${DB_REGION_US}`:

1. **Create security group** in **that** region
2. **Name**: `${PROJECT_PREFIX}-api-rds-sg` (or `${PROJECT_PREFIX}-api-rds-sg-us` if you want distinct names in the console)
3. **VPC**: `${PROJECT_PREFIX}-db-us` VPC
4. **Inbound — PostgreSQL 5432** with **Source** = the **CIDR of your primary VPC** (e.g. `10.10.0.0/16` or `10.0.0.0/16` — **exact** block from 3.2). That CIDR is how AWS identifies “traffic from the peered primary VPC” for **inter-Region** peering. Only ECS/ENI private IPs in that CIDR (after peering + routes) will match.

5. **Outbound:** default. Save.

Repeat in the other **three** API DB regions for each `db-eu`, `db-uk`, `db-au` VPC.

**Do not** use **0.0.0.0/0** on 5432 in production.

**Why not the ECS security group here?** Same-Region peering *does* allow referencing a peer **SG**; **inter-Region** peering does not, so the **tight** lever is the **entire primary VPC CIDR** (or a smaller CIDR if you only ever place ECS in specific subnets and document that). Avoid overlapping that CIDR with any DB VPC CIDR so routes stay unambiguous.

**Migrations and ops:** if you need DB access from your **laptop** or a build host, do **not** add `0.0.0.0/0` — use a one-off **Fargate** task in the primary VPC (inside that CIDR), **SSM** Session Manager to a small bastion in the primary VPC, or a temporary **/32** with a removal date.

#### E) Summary table (what you should have at the end of Phase 3)

| Security group | Region | Inbound (minimum) |
|----------------|--------|-------------------|
| `${PROJECT_PREFIX}-alb-sg` | Primary | 443 from `0.0.0.0/0` (or stricter) |
| `${PROJECT_PREFIX}-ecs-sg` | Primary | 3000 from ALB SG |
| `${PROJECT_PREFIX}-dashboard-rds-sg` | Primary | 5432 from `ecs-sg` |
| `${PROJECT_PREFIX}-api-rds-sg` (×4) | US/EU/UK/AU | 5432 from **primary VPC CIDR** (inter-Region: **no** cross-region SG ref) |

---

### 3.6 Route table sanity checks (end of Phase 3)

**Primary region**

- **Public** subnets: `0.0.0.0/0` → **Internet gateway** (for ALB and NAT).
- **Private** subnets: `0.0.0.0/0` → **NAT** (so ECS can pull images, call external services, if not fully endpoint’d).
- **Private** subnets: one route per **remote DB** CIDR (e.g. `10.21.0.0/16`, …) → **Peering** `pcx-*` (or TGW).

**Each DB region (API RDS VPCs)**

- **Private** DB subnets: **local** CIDR to “local” + route **to primary** CIDR (e.g. `10.10.0.0/16` → `pcx-*`) for **return** traffic on established connections. No need for `0.0.0.0/0` to NAT for RDS-only subnets.

**Dashboard** (if in primary private subnets, not covered above): ensure that subnet’s route table can reach the dashboard RDS (same VPC; local routing usually sufficient).

---

### 3.7 Verification checklist for Phase 3 (complete this section)

- [ ] Primary VPC: 2 public + 2 private subnets, NAT (or plan documented), IGW for public
- [ ] Four DB VPCs created (one per **AWS** region for US/EU/UK/AU), **non-overlapping** CIDRs
- [ ] **Four** peering links active (primary ↔ each DB VPC), **DNS** options enabled
- [ ] **Routes** on **both** sides of every peering (primary → each DB CIDR, each DB → primary CIDR)
- [ ] ALB, ECS, dashboard RDS, and four **api-rds** security groups created and **no** `0.0.0.0/0` on 5432
- [ ] All VPC IDs, subnet IDs, SG IDs, `pcx` IDs, and CIDRs written to your deployment worksheet
- [ ] (Optional) Quick **future** test after RDS exists: from a **Fargate task** in `SG_ECS` with a DB client, not from your laptop, verify TCP to each regional **endpoint** (Phase 4/12 can formalize this)

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

