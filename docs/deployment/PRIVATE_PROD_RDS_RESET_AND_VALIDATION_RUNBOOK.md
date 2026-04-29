# Private Production RDS Reset + Validation Runbook (VPC-Only)

Use this when you need to reset and re-seed private production RDS databases.

This runbook is Git Bash first and assumes:

- AWS account: `163436765242`
- primary region: `ap-southeast-2`
- project prefix: `hyrelog-prod`

---

## 0) Critical rule

If RDS is private, run reset/seed from a network path that can reach DB:

- inside VPC (bastion/SSM host/self-hosted runner), or
- one-off ECS task approach if runtime image supports required reset tooling

Do **not** attempt private production reset from an internet-only laptop.

Always take fresh snapshots first.

---

## 1) Safety checklist (must be complete before reset)

- [ ] fresh RDS snapshot(s)
- [ ] confirmed target environment (no accidental prod hit)
- [ ] migration state healthy
- [ ] post-reset validation plan ready

If any checkbox is not complete, stop.

---

## 2) Operator command appendix (Git Bash, restart-safe)

Run this at the start of the session:

```bash
export MSYS_NO_PATHCONV=1
export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
export AWS_ACCOUNT_ID=163436765242
export PROJECT_PREFIX=hyrelog-prod

export API_REPO_DIR=/c/Users/kram/Dropbox/hyrelog/hyrelog-api
export DASHBOARD_REPO_DIR=/c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard

aws sts get-caller-identity
```

Confirm environment/account before doing anything destructive:

```bash
echo "ACCOUNT=${AWS_ACCOUNT_ID} REGION=${PRIMARY_REGION} PREFIX=${PROJECT_PREFIX}"
```

---

## 3) Step-by-step reset flow

## 3.1 Identify DB instances to snapshot/reset

List likely HyreLog DB instances:

```bash
aws rds describe-db-instances \
  --region "${PRIMARY_REGION}" \
  --query 'DBInstances[?contains(DBInstanceIdentifier, `hyrelog-prod`)].[DBInstanceIdentifier,DBInstanceArn,Engine,DBInstanceStatus,Endpoint.Address]' \
  --output table
```

Repeat in API DB regions if needed:

```bash
for r in us-east-1 eu-west-1 eu-west-2 ap-southeast-2; do
  echo "== $r =="
  aws rds describe-db-instances --region "$r" \
    --query 'DBInstances[?contains(DBInstanceIdentifier, `hyrelog-prod`)].[DBInstanceIdentifier,DBInstanceStatus,Endpoint.Address]' \
    --output table
done
```

## 3.2 Take manual snapshots (required)

Example snapshot command:

```bash
SNAP_TS="$(date +%Y%m%d-%H%M%S)"
aws rds create-db-snapshot \
  --region ap-southeast-2 \
  --db-instance-identifier hyrelog-prod-dashboard \
  --db-snapshot-identifier "hyrelog-prod-dashboard-pre-reset-${SNAP_TS}"
```

Do this for every DB you plan to reset.

Wait for available:

```bash
aws rds wait db-snapshot-available \
  --region ap-southeast-2 \
  --db-snapshot-identifier "hyrelog-prod-dashboard-pre-reset-${SNAP_TS}"
```

## 3.3 Verify migration state is healthy

If migrations were recently failing (`P3009` / `P3018`), resolve that first.

For dashboard, use the existing ECS migration helper:

- `scripts/deployment/run-dashboard-migrations-ecs-task.sh`

For API regions, use:

- `scripts/deployment/run-api-regional-migrations-ecs-task.sh`

Do not reset until migration state is stable.

## 3.4 Ensure API image has RDS TLS CA support (required)

The API reset script uses Prisma/pg and must trust the AWS RDS CA chain.

`services/api/Dockerfile` now includes:

- RDS CA bundle download (`global-bundle.pem`)
- `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/aws-rds-global-bundle.pem`

You must deploy an API image built from this Dockerfile before running API reset tasks.

Quick rollout summary:

1. Build/push new API image tag
2. Register/update API task definition with new image
3. Update `hyrelog-api` ECS service and wait stable

If this is not done, API reset tasks can fail with:

`self-signed certificate in certificate chain`

## 3.5 Run reset/seed from a VPC-reachable runtime

### API regional DBs (US/EU/UK/AU)

Reset script behavior (`services/api/prisma/seed-reset.ts`):

- clears tenant/runtime data
- re-seeds plans only

If you can run from a VPC host with direct DB access, execute reset script per region DB URL.

For ECS Console one-off tasks (comma-delimited command override UI), use:

```text
bash,-lc,set -euo pipefail; export DATABASE_URL="$DATABASE_URL_US"; export SEED_RESET_REGION_LABEL=US; npx tsx prisma/seed-reset.ts; export DATABASE_URL="$DATABASE_URL_EU"; export SEED_RESET_REGION_LABEL=EU; npx tsx prisma/seed-reset.ts; export DATABASE_URL="$DATABASE_URL_UK"; export SEED_RESET_REGION_LABEL=UK; npx tsx prisma/seed-reset.ts; export DATABASE_URL="$DATABASE_URL_AU"; export SEED_RESET_REGION_LABEL=AU; npx tsx prisma/seed-reset.ts
```

If your task entrypoint prepends paths incorrectly, use `/bin/bash` as the first token:

```text
/bin/bash,-lc,set -euo pipefail; export DATABASE_URL="$DATABASE_URL_US"; export SEED_RESET_REGION_LABEL=US; npx tsx prisma/seed-reset.ts; export DATABASE_URL="$DATABASE_URL_EU"; export SEED_RESET_REGION_LABEL=EU; npx tsx prisma/seed-reset.ts; export DATABASE_URL="$DATABASE_URL_UK"; export SEED_RESET_REGION_LABEL=UK; npx tsx prisma/seed-reset.ts; export DATABASE_URL="$DATABASE_URL_AU"; export SEED_RESET_REGION_LABEL=AU; npx tsx prisma/seed-reset.ts
```

Expected result: all four regions reset; plans recreated (`FREE`, `STARTER`, `GROWTH`, `ENTERPRISE`).

### Dashboard DB

Reset script behavior (`prisma/seed/resetToDefault.ts`):

- clears auth + tenant data
- re-seeds reference data
- re-seeds plans + add-ons

Run from VPC-reachable environment with dashboard `DATABASE_URL` set.

For ECS Console one-off task command override:

```text
bash,-lc,set -euo pipefail; cd /app; npx tsx prisma/seed/resetToDefault.ts
```

Expected result: tenant/auth data cleared; reference data + plans + add-ons reseeded.

## 3.6 Recommended execution order (API + Dashboard)

1. Take snapshots for all target DBs
2. Confirm migration health
3. Deploy API image with RDS CA support (3.4)
4. Run API multi-region reset task (3.5 API)
5. Run Dashboard reset task (3.5 Dashboard)
6. Run SQL validation (section 4)
7. Run smoke checks on API + dashboard

---

## 4) Post-reset validation SQL

Run these checks against the correct databases.

## 4.1 API region DBs

```sql
SELECT "planTier", COUNT(*) FROM plans GROUP BY "planTier" ORDER BY "planTier";
```

Expected tiers present:

- FREE
- STARTER
- GROWTH
- ENTERPRISE

## 4.2 Dashboard DB

Verify plans:

```sql
SELECT code, name, status FROM plans ORDER BY code;
```

Verify add-ons:

```sql
SELECT code, name, "isActive" FROM addons ORDER BY code;
```

Expected plan codes include:

- FREE
- STARTER
- PRO
- BUSINESS
- ENTERPRISE

Expected add-on codes include:

- ADDON_EXTRA_EVENTS
- ADDON_RETENTION_EXTENDED
- ADDON_EXTRA_SEATS
- ADDON_SSO
- ADDON_ADDITIONAL_REGION

---

## 5) Final sign-off

Reset is complete only when all are true:

- snapshots created and `available`
- reset/seed completed with no runtime errors
- API plans query matches expected tiers
- dashboard plans/add-ons queries match expected codes
- smoke checks pass after reset

If any check fails, stop and restore from snapshot if needed.
