# HyreLog Local Architecture -> AWS Production Handoff

This document is a quick handoff for an engineer deploying the current local stack to AWS.

## 1) Current Local System (what is running today)

### Applications

- **Dashboard** (`hyrelog-dashboard`): Next.js app on `http://localhost:4000`
- **API** (`hyrelog-api/services/api`): Fastify app on `http://localhost:3000`
- **Worker** (`hyrelog-api/services/worker`): background jobs (webhooks, archival, restore, etc.)

### Local infrastructure (Docker Compose)

- **Postgres (regional API data)**:
  - US: `localhost:54321`
  - EU: `localhost:54322`
  - UK: `localhost:54323`
  - AU: `localhost:54324`
- **Postgres (dashboard app DB)**:
  - `localhost:54325`
- **MinIO (S3-compatible local storage)**:
  - S3 API: `localhost:9000`
  - Console: `localhost:9001`

## 2) Ownership and data boundaries

- **Dashboard is source of truth** for tenancy and business entities:
  - users, membership, company/workspace records, subscriptions/billing metadata
- **API is source of truth** for audit log plane:
  - events, API-key auth records, exports, webhooks, archival metadata
- **Regional data residency** is enforced in API by `dataRegion`:
  - each company lives in one regional API database (US/EU/UK/AU)

## 3) Request/auth model

### Public API traffic (customer systems -> API)

- Endpoint family: `/v1/*`
- Auth: `Authorization: Bearer <api-key>`
- API key prefix includes region/scope (`hlk_{region}_{scope}_...`) for fast regional lookup

### Dashboard management traffic (dashboard server -> API)

- Endpoint family: `/dashboard/*`
- Auth headers:
  - `x-dashboard-token`
  - actor headers (`x-user-id`, `x-user-email`, `x-user-role`, and company header where required)
- Token must match `DASHBOARD_SERVICE_TOKEN` in both apps

### Usage accounting callback (API -> Dashboard)

- API posts usage increments to dashboard internal route:
  - `POST /api/internal/usage`
- API reads usage snapshot from:
  - `GET /api/internal/usage?apiCompanyId=...`
- Auth: `x-dashboard-token` (same shared service token)
- API env requirement:
  - `HYRELOG_DASHBOARD_URL` (or `DASHBOARD_USAGE_URL`)
  - `DASHBOARD_SERVICE_TOKEN`

If `HYRELOG_DASHBOARD_URL`/`DASHBOARD_USAGE_URL` is missing in the API runtime env, usage updates are skipped and dashboard usage cards stay empty.

## 4) Critical env contract

### Shared across Dashboard and API

- `DASHBOARD_SERVICE_TOKEN` must be identical in both apps

### API (`hyrelog-api/.env`)

- Runtime:
  - `PORT`
  - `NODE_ENV`
- Auth/secrets:
  - `INTERNAL_TOKEN`
  - `API_KEY_SECRET`
  - `DASHBOARD_SERVICE_TOKEN`
- Dashboard callback:
  - `HYRELOG_DASHBOARD_URL` (or `DASHBOARD_USAGE_URL`)
- Regional DBs:
  - `DATABASE_URL_US`
  - `DATABASE_URL_EU`
  - `DATABASE_URL_UK`
  - `DATABASE_URL_AU`
- Object storage:
  - `S3_ENDPOINT` (local only), `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`
  - `S3_BUCKET_US`, `S3_BUCKET_EU`, `S3_BUCKET_UK`, `S3_BUCKET_AU`

### Dashboard (`hyrelog-dashboard/.env`)

- App/base URLs:
  - `BETTER_AUTH_URL`
  - `NEXT_PUBLIC_APP_URL`
  - `HYRELOG_API_URL`
  - `NEXT_PUBLIC_API_BASE_URL` (if browser calls API directly)
- DB:
  - `DATABASE_URL`
- Shared secrets:
  - `DASHBOARD_SERVICE_TOKEN`
  - `HYRELOG_API_KEY_SECRET` (must equal API `API_KEY_SECRET` for synced key behavior)

## 5) Core runtime flows (current behavior)

1. **Onboarding/provisioning**
   - User completes or skips onboarding in dashboard
   - Dashboard provisions company/workspace in API via `/dashboard/*`
   - Dashboard stores returned API IDs (`apiCompanyId`, `apiWorkspaceId`) for sync

2. **API key creation**
   - Triggered from dashboard UI
   - Dashboard creates key and syncs to API, using shared key secret for hashed storage compatibility

3. **Event ingestion**
   - Customer sends `POST /v1/events` to API with workspace key
   - API resolves region, writes event to regional DB
   - API calls dashboard internal usage endpoint to increment monthly usage

4. **Dashboard usage display**
   - Dashboard reads usage from its DB (`UsagePeriod`)
   - Values shown on dashboard cards and workspace/company views

## 6) AWS target mapping (local -> production)

- **Next.js Dashboard app** -> ECS/Fargate service (or App Runner)
- **Fastify API app** -> ECS/Fargate service
- **Worker app** -> ECS/Fargate scheduled/long-running worker service
- **4x Postgres containers** -> 4x RDS Postgres instances (one per region) or a regionalized RDS strategy
- **Dashboard Postgres container** -> RDS Postgres (dashboard region)
- **MinIO** -> S3 buckets per region
- **Local env files** -> AWS Secrets Manager + SSM Parameter Store
- **Local process logs** -> CloudWatch Logs

## 7) Recommended production deployment order

1. Provision AWS infra (network, RDS, S3, IAM, log groups, ECS/ECR)
2. Deploy dashboard DB + migrations
3. Deploy API regional DBs + migrations (all regions)
4. Deploy API service
5. Deploy dashboard service
6. Deploy worker service
7. Set/verify shared secrets:
   - `DASHBOARD_SERVICE_TOKEN` (same in API + dashboard)
   - `API_KEY_SECRET` == dashboard `HYRELOG_API_KEY_SECRET`
8. Run smoke tests:
   - dashboard -> `/dashboard/*` API auth
   - event ingest -> usage increment callback
   - key creation -> prefixed key format

## 8) Production checklist for handoff engineer

- Confirm no local-only values in production (`localhost`, MinIO settings, dev tokens)
- Confirm API can reach dashboard internal usage route over private network or allowed ingress
- Confirm regional DB connectivity and correct `dataRegion` routing
- Confirm TLS everywhere and secret rotation policy
- Confirm backup/restore and retention policies on RDS and S3 lifecycle
- Confirm CloudWatch alarms for API 4xx/5xx spikes and worker failures

## 9) Known gotchas from current local debugging

- Usage cards remain empty if API runtime misses `HYRELOG_DASHBOARD_URL`/`DASHBOARD_USAGE_URL` even when events ingest succeeds
- Dashboard and API token mismatch causes `/dashboard/*` auth failures
- Key sync/prefix issues occur if dashboard `HYRELOG_API_KEY_SECRET` does not match API `API_KEY_SECRET`
- API process restart is required after `.env` changes

---

If useful, this can be split next into:

1) an AWS infrastructure blueprint (VPC, ECS, RDS, S3, secrets, IAM), and  
2) an operations runbook (deploy, rollback, migrations, smoke tests, incident checks).
