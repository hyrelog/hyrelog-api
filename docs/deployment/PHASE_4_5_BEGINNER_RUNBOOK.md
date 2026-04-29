# HyreLog Beginner Runbook — Phase 4 and 5

This runbook is a beginner-friendly guide for:

- **Phase 4:** Create all required PostgreSQL databases (RDS)
- **Phase 5:** Create region-aligned S3 buckets

It assumes your **Phase 3 networking is complete** (primary VPC, DB VPCs, peering/routes, security groups).

---

## Before You Start (5-minute checklist)

Make sure you have these values written down:

- `PROJECT_PREFIX` (example: `hyrelog-prod`)
- `PRIMARY_REGION` (example: `ap-southeast-2`)
- API DB regions:
  - `DB_REGION_US` (example: `us-east-1`)
  - `DB_REGION_EU` (example: `eu-west-1`)
  - `DB_REGION_UK` (example: `eu-west-2`)
  - `DB_REGION_AU` (example: `ap-southeast-2`)

From Phase 3, you should also have:

- `PRIMARY_VPC_ID`
- `SG_DASHBOARD_RDS` (primary region dashboard DB SG)
- `SG_API_RDS_US`, `SG_API_RDS_EU`, `SG_API_RDS_UK`, `SG_API_RDS_AU`
- Two private subnet IDs in each DB VPC (for DB subnet groups)
- Two private subnet IDs in primary VPC for dashboard DB subnet group

---

## Phase 4 — Create Regional RDS Databases (PostgreSQL)

## 4.0 Target Architecture

You are creating **5 independent RDS instances**:

1. Dashboard DB in `PRIMARY_REGION`
2. API US DB in `DB_REGION_US`
3. API EU DB in `DB_REGION_EU`
4. API UK DB in `DB_REGION_UK`
5. API AU DB in `DB_REGION_AU`

Database names to use:

- Dashboard: `hyrelog_dashboard`
- API US: `hyrelog_us`
- API EU: `hyrelog_eu`
- API UK: `hyrelog_uk`
- API AU: `hyrelog_au`

> Important: each API database must physically exist in its own matching AWS region.

---

## 4.1 Create DB subnet groups first (recommended)

You need one DB subnet group per region where you create an RDS instance.

Repeat this in each relevant region:

1. Switch AWS console region (top-right).
2. Open **RDS** -> **Subnet groups** -> **Create DB subnet group**.
3. Fill:
   - **Name**: `${PROJECT_PREFIX}-db-subnet-group-<region>`
     - example: `hyrelog-prod-db-subnet-group-us`
   - **Description**: `HyreLog DB subnet group for <region>`
   - **VPC**: the region's DB VPC (or primary VPC for dashboard DB)
4. Select at least **2 private subnets in different AZs**.
5. Click **Create**.

Create these 5 subnet groups:

- `${PROJECT_PREFIX}-db-subnet-group-dashboard` (primary VPC private subnets)
- `${PROJECT_PREFIX}-db-subnet-group-us`
- `${PROJECT_PREFIX}-db-subnet-group-eu`
- `${PROJECT_PREFIX}-db-subnet-group-uk`
- `${PROJECT_PREFIX}-db-subnet-group-au`

---

## 4.2 Create the Dashboard RDS instance (primary region)

1. Switch to `PRIMARY_REGION`.
2. Open **RDS** -> **Databases** -> **Create database**.
3. Choose:
   - **Standard create**
   - **Engine type**: PostgreSQL
   - **Engine version**: PostgreSQL 16.x
4. Templates:
   - Start with **Dev/Test** while onboarding if cost-sensitive
   - Move to **Production** sizing/settings before real customer launch
5. Settings:
   - **DB instance identifier**: `${PROJECT_PREFIX}-dashboard`
   - **Master username**: choose one (example: `hyrelog_admin`)
   - **Master password**: auto-generate or strong manual password
6. Instance config:
   - Choose burstable/small size for test (example `db.t4g.micro`) if acceptable
7. Storage:
   - Keep defaults or set baseline (example 20-100 GB)
   - Enable storage autoscaling
8. Connectivity:
   - **VPC**: primary VPC
   - **DB subnet group**: `${PROJECT_PREFIX}-db-subnet-group-dashboard`
   - **Public access**: **No**
   - **VPC security group**: select `${PROJECT_PREFIX}-dashboard-rds-sg`
9. Additional config:
   - **Initial database name**: `hyrelog_dashboard`
10. Protection and ops:
   - Enable **automated backups**
   - Enable **encryption at rest**
   - Enable **deletion protection** for production-like environments
11. Click **Create database**.

Wait until status = **Available**.

Record:

- Dashboard endpoint hostname
- Port (5432)
- DB name (`hyrelog_dashboard`)

---

## 4.3 Create API US/EU/UK/AU RDS instances (repeat per region)

Do the same flow in each API region, with region-specific names.

### Example: US (`DB_REGION_US`)

1. Switch to `DB_REGION_US`.
2. **RDS** -> **Create database**.
3. Choose:
   - Standard create
   - PostgreSQL 16.x
4. Settings:
   - **Identifier**: `${PROJECT_PREFIX}-api-us`
   - Credentials as chosen standard
5. Connectivity:
   - **VPC**: US DB VPC
   - **DB subnet group**: `${PROJECT_PREFIX}-db-subnet-group-us`
   - **Public access**: **No**
   - **VPC security group**: `${PROJECT_PREFIX}-api-rds-sg` (US)
6. Additional config:
   - **Initial database name**: `hyrelog_us`
7. Backups + encryption enabled.
8. Create database and wait for **Available**.

Repeat similarly:

- EU region: identifier `${PROJECT_PREFIX}-api-eu`, DB `hyrelog_eu`
- UK region: identifier `${PROJECT_PREFIX}-api-uk`, DB `hyrelog_uk`
- AU region: identifier `${PROJECT_PREFIX}-api-au`, DB `hyrelog_au`

Record each endpoint hostname.

---

## 4.4 Build connection strings (for Secrets Manager in Phase 6)

Use this format:

`postgresql://USER:PASS@HOST:5432/DB_NAME?sslmode=require`

Create values:

- `DATABASE_URL=postgresql://USER:PASS@dashboard-host:5432/hyrelog_dashboard?sslmode=require`
- `DATABASE_URL_US=postgresql://USER:PASS@us-host:5432/hyrelog_us?sslmode=require`
- `DATABASE_URL_EU=postgresql://USER:PASS@eu-host:5432/hyrelog_eu?sslmode=require`
- `DATABASE_URL_UK=postgresql://USER:PASS@uk-host:5432/hyrelog_uk?sslmode=require`
- `DATABASE_URL_AU=postgresql://USER:PASS@au-host:5432/hyrelog_au?sslmode=require`

---

## 4.5 Beginner verification (must pass before Phase 5/6)

For each DB instance:

- Status = **Available**
- Region matches intended region
- Public access = **No**
- Correct subnet group in private subnets
- Correct security group attached
- Encryption enabled

Compliance quick-check:

- US URL host is in US region
- EU URL host is in EU region
- UK URL host is in UK region
- AU URL host is in AU region

---

## Phase 5 — Create Region-Aligned S3 Buckets

## 5.0 What you are creating

Create 4 buckets, one per API data region:

- `S3_BUCKET_US` in `DB_REGION_US`
- `S3_BUCKET_EU` in `DB_REGION_EU`
- `S3_BUCKET_UK` in `DB_REGION_UK`
- `S3_BUCKET_AU` in `DB_REGION_AU`

Recommended naming pattern (must be globally unique):

- `${PROJECT_PREFIX}-events-us`
- `${PROJECT_PREFIX}-events-eu`
- `${PROJECT_PREFIX}-events-uk`
- `${PROJECT_PREFIX}-events-au`

---

## 5.1 Create US bucket (repeat pattern for each region)

1. Switch console region to `DB_REGION_US`.
2. Open **S3** -> **Create bucket**.
3. Bucket name: `${PROJECT_PREFIX}-events-us` (or your chosen unique name).
4. Region: `DB_REGION_US` (must match).
5. Object ownership: **ACLs disabled** (default recommended).
6. Block Public Access: **leave all block settings ON**.
7. Bucket versioning: **Enable** (recommended).
8. Default encryption:
   - SSE-S3 is acceptable to start
   - SSE-KMS if your policy requires KMS key control
9. Create bucket.

Repeat in EU/UK/AU:

- `${PROJECT_PREFIX}-events-eu` in `DB_REGION_EU`
- `${PROJECT_PREFIX}-events-uk` in `DB_REGION_UK`
- `${PROJECT_PREFIX}-events-au` in `DB_REGION_AU`

---

## 5.2 Bucket policy and access model notes

For now, if your app uses `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` secrets, keep bucket policies simple and private.

Minimum recommendations:

- Keep buckets private (no public policies)
- Keep Block Public Access ON
- Grant write/read only to the app principal you use (user or role)

Later hardening (recommended before full launch):

- Move app access from static S3 keys to IAM role-based access on ECS task role
- Add bucket policies scoped to required actions and prefixes

---

## 5.3 Capture outputs for later phases

Record:

- `S3_BUCKET_US=<actual-bucket-name>`
- `S3_BUCKET_EU=<actual-bucket-name>`
- `S3_BUCKET_UK=<actual-bucket-name>`
- `S3_BUCKET_AU=<actual-bucket-name>`

These values are needed in:

- Secrets/config env
- ECS task definitions
- Deploy workflow secrets/variables

---

## 5.4 Beginner verification (must pass)

For each bucket:

- Region is correct (US/EU/UK/AU as intended)
- Block Public Access is ON
- Default encryption is ON
- Versioning is ON (recommended)
- Name is captured in worksheet

---

## Done Criteria for Phase 4 + 5

You are ready for Phase 6 when:

- All 5 RDS instances exist and are available
- All DB connection URLs are built from real endpoints
- All 4 region-aligned S3 buckets exist
- Bucket names and DB endpoints are captured in your worksheet

If you want, next I can produce the same beginner-level runbook for **Phase 6 (Secrets Manager)** and **Phase 7 (ECR + image push)** in one companion doc.
