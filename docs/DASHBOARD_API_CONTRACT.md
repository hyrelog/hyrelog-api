# Dashboard ↔ API Backend Integration Contract

This document is the **application contract** between the HyreLog dashboard (control plane) and the API plane. It summarizes the spec and implementation status.

## Principles (non-negotiable)

- **Dashboard** is canonical for: Company, Workspace, Project, memberships, API key creation intent, workspace lifecycle (ACTIVE/ARCHIVED).
- **API** is canonical for: events, exports, webhooks, runtime key validity.
- **Provisioned** = `workspace.apiWorkspaceId != null` / `company.apiCompanyId != null` in dashboard.
- Single API base URL; region selected per request (key prefix or `x-company-id` → company region).
- Revocations and archive effects must take effect in **seconds**.

## Authentication

- **Dashboard → API:** `x-dashboard-token: <DASHBOARD_SERVICE_TOKEN>` (required).
- **Actor headers (audit only):** `x-user-id`, `x-user-email`, `x-user-role`; `x-company-id` (dashboard or API company id; API resolves to region).
- **Correlation:** Dashboard sends `x-request-id` (UUID); API logs it.

## Region selection

- **API key requests:** Parse region from key prefix `hlk_{region}_{scope}_...` → use that region DB only.
- **Dashboard requests:** Resolve company by `x-company-id` (as `dashboardCompanyId` or API `id`) → use `Company.dataRegion` for all reads/writes.

## Error codes (machine-readable)

- `UNAUTHORIZED` – bad or missing service token
- `FORBIDDEN` – not allowed
- `VALIDATION_ERROR` – invalid payload
- `NOT_FOUND` – referenced company/workspace/key not found
- `REGION_MISMATCH` – prefix region ≠ company region
- `SCOPE_MISMATCH` – prefix scope ≠ payload scope
- `CONFLICT` – e.g. duplicate slug
- `INTERNAL_ERROR` – 5xx

## Endpoints (MVP)

| Method | Path | Purpose |
|--------|------|--------|
| POST | /dashboard/companies | Idempotent company upsert (body: dashboardCompanyId, slug, name, dataRegion) |
| GET | /dashboard/companies/:dashboardCompanyId | Exists + apiCompanyId, dataRegion |
| POST | /dashboard/workspaces | Idempotent workspace upsert |
| GET | /dashboard/workspaces/:dashboardWorkspaceId | Exists + apiWorkspaceId, apiCompanyId, status |
| POST | /dashboard/projects | Idempotent project upsert (optional) |
| POST | /dashboard/api-keys | Idempotent key upsert (body: dashboardKeyId, scope, prefix, hash, …) |
| POST | /dashboard/api-keys/:dashboardKeyId/revoke | Set revokedAt |
| POST | /dashboard/workspaces/:dashboardWorkspaceId/archive | Set status ARCHIVED, revoke workspace keys |
| POST | /dashboard/workspaces/:dashboardWorkspaceId/restore | Set status ACTIVE (do not un-revoke keys) |
| POST | /dashboard/gdpr/requests | Create GDPR request (execution) |
| POST | /dashboard/gdpr/requests/:id/execute | Execute redaction |
| GET | /dashboard/gdpr/requests/:id | Status, counts |

## Idempotency

- Dashboard sends `Idempotency-Key` (UUID) where applicable.
- API upserts by dashboard IDs: `dashboardCompanyId`, `dashboardWorkspaceId`, `dashboardProjectId`, `dashboardKeyId`.
- Repeated request returns same resource IDs and `created: false` when already exists.

## API schema (regional replica)

- **Company:** id, dashboardCompanyId (unique), slug, name, dataRegion, status flags, timestamps.
- **Workspace:** id, dashboardWorkspaceId (unique), companyId, slug, name, status (ACTIVE/ARCHIVED), timestamps.
- **Project:** id, dashboardProjectId (unique), workspaceId, slug, name.
- **ApiKey:** id, dashboardKeyId (unique), companyId/workspaceId, scope, prefix, hashedKey, revokedAt, name, timestamps.

## Implementation status

- [x] API schema: dashboard IDs + slug/status/revokedAt
- [x] Dashboard auth: resolve company by dashboardCompanyId or id, attach region
- [x] POST/GET /dashboard/companies (idempotent upsert, GET by dashboardCompanyId)
- [x] POST/GET /dashboard/workspaces; POST .../archive, .../restore
- [ ] POST /dashboard/projects (optional)
- [x] POST /dashboard/api-keys (sync upsert when body has dashboardKeyId/prefix/hash), POST .../revoke
- [x] Runtime: enforce key.revokedAt and workspace.status ACTIVE for writes; cache invalidation on revoke/archive
- [ ] GDPR dashboard endpoints (create/execute/status)
- [ ] Dashboard: API client wrapper, provisioning orchestrators, reconcile utilities
- [x] Dashboard schema: `Company.apiCompanyId`, `Workspace.apiWorkspaceId`, `Project.apiProjectId` already in dashboard Prisma (no change needed).

**Remaining work:** See [REMAINING_TASKS.md](./REMAINING_TASKS.md) for the full list of not-yet-implemented items (API client, orchestrators, reconcile, optional projects, GDPR).
