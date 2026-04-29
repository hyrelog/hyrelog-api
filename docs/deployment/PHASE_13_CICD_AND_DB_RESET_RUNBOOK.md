# HyreLog Beginner Runbook - Phase 13 (CI/CD) + Database Reset Baseline

This runbook gives you:

1. **Phase 13** step-by-step setup for GitHub Actions CI/CD (API/worker + dashboard)
2. A repeatable **database reset + baseline seed** flow so plans/reference data are present after reset

Use this after Phase 12 (smoke/compliance) and after your AWS foundation is already working.

---

## Scope and repos

- API + worker repo: `hyrelog-api`
- Dashboard repo: `hyrelog-dashboard`

Existing workflows used by this runbook:

- `hyrelog-api/.github/workflows/aws-oidc-preflight.yml`
- `hyrelog-api/.github/workflows/deploy-production.yml`
- `hyrelog-dashboard/.github/workflows/deploy-production.yml`

---

## 1) Session bootstrap (Git Bash, after restart)

```bash
export MSYS_NO_PATHCONV=1
export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
export AWS_ACCOUNT_ID=163436765242

export ECS_CLUSTER=hyrelog-prod-ecs
export ECS_SERVICE_API=hyrelog-api
export ECS_SERVICE_WORKER=hyrelog-worker
export ECS_SERVICE_DASHBOARD=hyrelog-dashboard

export ECR_BASE="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com"
export ECR_API_REPOSITORY="${ECR_BASE}/hyrelog-api"
export ECR_WORKER_REPOSITORY="${ECR_BASE}/hyrelog-worker"
export ECR_DASHBOARD_REPOSITORY="${ECR_BASE}/hyrelog-dashboard"

aws sts get-caller-identity
```

---

## 2) Phase 13 - CI/CD setup (GitHub Actions)

## 2.1 Configure repository secrets

Set these in GitHub repo settings -> Secrets and variables -> Actions.

### In `hyrelog-api` repo

Required:

- `AWS_DEPLOY_ROLE_ARN`
- `AWS_REGION` (use `ap-southeast-2`)
- `ECR_API_REPOSITORY` (`163436765242.dkr.ecr.ap-southeast-2.amazonaws.com/hyrelog-api`)
- `ECR_WORKER_REPOSITORY` (`163436765242.dkr.ecr.ap-southeast-2.amazonaws.com/hyrelog-worker`)
- `ECS_CLUSTER` (`hyrelog-prod-ecs`)
- `ECS_SERVICE_API` (`hyrelog-api`)
- `ECS_SERVICE_WORKER` (`hyrelog-worker`)

### In `hyrelog-dashboard` repo

Required:

- `AWS_DEPLOY_ROLE_ARN`
- `AWS_REGION` (use `ap-southeast-2`)
- `ECR_DASHBOARD_REPOSITORY` (`163436765242.dkr.ecr.ap-southeast-2.amazonaws.com/hyrelog-dashboard`)
- `ECS_CLUSTER` (`hyrelog-prod-ecs`)
- `ECS_SERVICE_DASHBOARD` (`hyrelog-dashboard`)

---

## 2.2 Verify OIDC works first

In `hyrelog-api` repo, manually run workflow:

- Actions -> **AWS OIDC preflight** -> Run workflow

Success criteria:

- `aws sts get-caller-identity` succeeds in workflow logs.

If this fails, fix IAM trust/policies before any deploy workflow testing.

---

## 2.3 Validate deploy workflows

Both deploy workflows trigger on push to `main`.

### API + worker

- workflow: `hyrelog-api/.github/workflows/deploy-production.yml`
- builds and pushes API + worker images
- calls ECS `update-service --force-new-deployment` for both services

### Dashboard

- workflow: `hyrelog-dashboard/.github/workflows/deploy-production.yml`
- builds and pushes dashboard image
- calls ECS `update-service --force-new-deployment` for dashboard service

Recommended first test:

1. Make a trivial non-functional change in each repo (e.g., docs comment)
2. Merge to `main`
3. Watch workflow logs to completion
4. Confirm ECS services are stable

Verification command:

```bash
aws ecs describe-services \
  --cluster hyrelog-prod-ecs \
  --services hyrelog-api hyrelog-worker hyrelog-dashboard \
  --region ap-southeast-2 \
  --query 'services[*].[serviceName,status,desiredCount,runningCount]' \
  --output table
```

---

## 3) Database reset strategy (what gets restored)

After reset, you want baseline data present.

## 3.1 API databases (US/EU/UK/AU)

Script behavior (`services/api/prisma/seed-reset.ts`):

- Deletes tenant/runtime data (companies, workspaces, keys, events, exports, webhooks, etc.)
- Recreates **plans only**
- Leaves DB with no companies and no API keys

Baseline plans recreated:

- FREE
- STARTER
- GROWTH
- ENTERPRISE

## 3.2 Dashboard database

Script behavior (`prisma/seed/resetToDefault.ts` in dashboard repo):

- Deletes auth + tenant data (users, companies, workspaces, subscriptions, invites, etc.)
- Re-seeds reference/billing baseline:
  - Continents/currencies/countries/regions
  - Plans (`FREE`, `STARTER`, `PRO`, `BUSINESS`, `ENTERPRISE`)
  - Add-ons (from `seedAddons.ts`)

Result: no users/companies remain, but reference and plan/add-on catalogs are ready.

---

## 4) Reset + seed commands (local/dev)

## 4.1 API: reset all 4 regions (Windows PowerShell helper)

From `hyrelog-api` root:

```bash
npm run seed:reset:all
```

Or directly:

```bash
powershell -ExecutionPolicy Bypass -File ./scripts/reset-all-regions.ps1
```

Prerequisites:

- migrations already applied in each region DB
- connectivity to target DB hosts (default script targets localhost mapped ports)

## 4.2 Dashboard: reset to default baseline

From `hyrelog-dashboard` root:

```bash
export DATABASE_URL='postgresql://...dashboard-db...'
npm run db:reset
```

---

## 5) Reset + seed for private production RDS

If RDS is private, run reset/seed from a network path that can reach DB:

- inside VPC (bastion/SSM host/self-hosted runner), or
- one-off ECS task approach if runtime image supports required reset tooling

Do not attempt production resets from an internet-only laptop if DB is private.

Always take a snapshot first.

Minimum safety checklist before production reset:

- [ ] fresh RDS snapshot(s)
- [ ] confirmed target environment (no accidental prod hit)
- [ ] migration state healthy
- [ ] post-reset validation plan ready

---

## 6) Post-reset validation checklist

## 6.1 API region DBs

After `seed-reset` across regions, verify plans exist:

```sql
SELECT "planTier", COUNT(*) FROM plans GROUP BY "planTier" ORDER BY "planTier";
```

Expected tiers present: `FREE`, `STARTER`, `GROWTH`, `ENTERPRISE`.

## 6.2 Dashboard DB

Verify plans:

```sql
SELECT code, name, status FROM plans ORDER BY code;
```

Verify add-ons:

```sql
SELECT code, name, "isActive" FROM addons ORDER BY code;
```

Expected plan codes include:

- `FREE`
- `STARTER`
- `PRO`
- `BUSINESS`
- `ENTERPRISE`

Expected add-on codes include:

- `ADDON_EXTRA_EVENTS`
- `ADDON_RETENTION_EXTENDED`
- `ADDON_EXTRA_SEATS`
- `ADDON_SSO`
- `ADDON_ADDITIONAL_REGION`

---

## 7) Recommended operating model

- Use CI/CD (Phase 13) for normal deploys.
- Use migration scripts for schema changes (Phase 10/11 runbooks).
- Use reset scripts only for non-prod, test refreshes, or explicit production maintenance windows.
- Keep this runbook with:
  - `PHASE_10_11_BEGINNER_RUNBOOK.md`
  - `dashboard-ecs-deploy-and-migrate.md`

