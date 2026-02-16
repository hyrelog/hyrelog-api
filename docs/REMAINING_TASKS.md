# HyreLog — Remaining Tasks

This document lists what is **done** vs **still to do** for the Dashboard ↔ API contract and related features.

---

## Done

### API (backend)
- Schema: `dashboardCompanyId`, `dashboardWorkspaceId`, `dashboardProjectId`, `dashboardKeyId`, `revokedAt`, workspace `status`, company `slug`, etc.
- Dashboard auth plugin: `x-dashboard-token`, resolve company by `x-company-id`, attach regional Prisma.
- **POST/GET** `/dashboard/companies`, **POST/GET** `/dashboard/workspaces`, **POST** archive/restore.
- **POST** `/dashboard/api-keys` (sync upsert), **POST** `/dashboard/api-keys/:dashboardKeyId/revoke`.
- Runtime: reject revoked keys and archived workspace writes; cache invalidation on revoke/archive.
- Postman: full collection (Dashboard + V1 + Internal) and environment variables.

### Dashboard (frontend)
- **Schema:** `Company.apiCompanyId`, `Workspace.apiWorkspaceId`, `Project.apiProjectId` already exist in dashboard Prisma schema. No schema change needed for provisioning/reconcile.
- Auth, onboarding, company/workspace/members, invites, workspace detail, API keys UI, settings (profile, preferences, notifications, security).

---

## Not done (to implement)

### 1. ~~Dashboard: API client wrapper~~ (Done: `lib/hyrelog-api/`)
- **What:** A single module (e.g. `lib/api-client.ts` or `lib/hyrelog-api.ts`) that:
  - Sends `x-dashboard-token`, `x-request-id` (UUID), and optional actor headers (`x-user-id`, `x-user-email`, `x-user-role`, `x-company-id`).
  - Uses `HYRELOG_API_URL` and `DASHBOARD_SERVICE_TOKEN` from env.
  - Exposes typed methods for each dashboard endpoint (provision company/workspace, sync key, revoke, archive, restore, GET company/workspace, etc.).
  - Retries on 5xx with bounded exponential backoff.
- **Where:** `hyrelog-dashboard` (e.g. `lib/api-client.ts`).

### 2. ~~Dashboard: Provisioning orchestrators~~ (Done: `actions/provisioning.ts`)
- **What:** Server actions or server-side functions that:
  - **createCompanyAndProvision:** Create company in dashboard DB, then call API **POST /dashboard/companies** with `dashboardCompanyId`, slug, name, dataRegion; store returned `apiCompanyId` on the company.
  - **createWorkspaceAndProvision:** Create workspace in dashboard DB, then call API **POST /dashboard/workspaces**; store `apiWorkspaceId`.
  - **createKeyAndSync:** After creating a key in dashboard (generate secret, hash), call API **POST /dashboard/api-keys** with `dashboardKeyId`, scope, prefix, hash, etc.; store API key id if needed.
  - **revokeKeyAndSync:** Update key in dashboard, call API **POST /dashboard/api-keys/:dashboardKeyId/revoke**.
  - **archiveWorkspaceAndSync:** Update workspace in dashboard, call API **POST /dashboard/workspaces/:id/archive**.
  - **restoreWorkspaceAndSync:** Update workspace in dashboard, call API **POST /dashboard/workspaces/:id/restore**.
- **Rule:** Dashboard does local DB write first, then calls API; if API fails, return error and do not leave dashboard in an inconsistent state (e.g. mark as “sync failed” for retry).
- **Where:** `hyrelog-dashboard` (e.g. `actions/provisioning.ts` or under `lib/`).

### 3. ~~Dashboard: Reconcile utilities~~ (Done: `lib/reconcile.ts`)
- **What:** Functions or an admin flow that:
  - **reconcileCompany(dashboardCompanyId):** Call API **GET /dashboard/companies/:dashboardCompanyId**. If `exists: true` and dashboard company has `apiCompanyId` null, backfill `apiCompanyId` (and optionally dataRegion) from the response.
  - **reconcileWorkspace(dashboardWorkspaceId):** Call API **GET /dashboard/workspaces/:dashboardWorkspaceId**. If `exists: true` and dashboard workspace has `apiWorkspaceId` null, backfill it.
- Can be triggered manually (e.g. “Repair” button) or by a background job that periodically checks for missing API IDs.
- **Where:** `hyrelog-dashboard`.

### 4. API: Optional project sync
- **POST /dashboard/projects** (idempotent project upsert) is optional for MVP; implement if dashboard needs “All dashboards” / project-scoped features that rely on API project replica.

### 5. Dashboard: Optional “Repair” / Reconcile UI
- Trigger `reconcileCompany` / `reconcileWorkspace` from a button (e.g. company or workspace settings) when apiCompanyId/apiWorkspaceId is null.

### 6. API + Dashboard: GDPR workflow
- API: **POST /dashboard/gdpr/requests**, **POST .../execute**, **GET .../status** (and internal redaction execution).
- Dashboard: GDPR request model, approval workflow (customer + HyreLog admin), then call API to execute and poll status.

---

## Summary

| Item | Status |
|------|--------|
| Dashboard schema `apiCompanyId` / `apiWorkspaceId` | Done (already in schema) |
| API contract endpoints (companies, workspaces, keys, archive, restore) | Done |
| API runtime enforcement (revoke, archive) | Done |
| Postman collection & environment | Done |
| **Dashboard API client wrapper** | Done (`lib/hyrelog-api/`) |
| **Dashboard provisioning orchestrators** | Done (`actions/provisioning.ts` + wired into actions) |
| **Dashboard reconcile utilities** | Done (`lib/reconcile.ts`) |
| API POST /dashboard/projects | Optional; not done |
| GDPR (API + Dashboard) | Not done |

**Dashboard env:** Set `HYRELOG_API_URL` (e.g. `http://localhost:4000`) and use the same `DASHBOARD_SERVICE_TOKEN` as the API. For API key sync (provisioned workspaces), set `HYRELOG_API_KEY_SECRET` to the API's apiKeySecret so keys are hashed correctly for the API.
