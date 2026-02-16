# HyreLog — Features: Backend API & Dashboard

Single reference for all features in the **HyreLog API** (backend) and **HyreLog Dashboard** (frontend).  
Contract between the two: [DASHBOARD_API_CONTRACT.md](./DASHBOARD_API_CONTRACT.md).

---

## Backend API (HyreLog API)

**Stack:** Fastify, TypeScript, Prisma, multi-region Postgres (US/EU/UK/AU), S3-compatible object store.

**Base URL:** Single API host; region selected per request (key prefix or `x-company-id`).

---

### Authentication & infrastructure

| Feature | Description |
|--------|-------------|
| **API key auth** | Customer requests use `Authorization: Bearer <key>`. Key prefix `hlk_{region}_{scope}_...` selects region (us/eu/uk/au) and scope (co/ws). |
| **Key validation** | Key must exist in region DB, `revokedAt` null, `status` ACTIVE, optional expiry and IP allowlist enforced. |
| **Revocation latency** | Revoked keys rejected immediately; auth cache invalidated on revoke/archive. |
| **Dashboard service auth** | Routes under `/dashboard` require `x-dashboard-token`. Optional actor headers: `x-user-id`, `x-user-email`, `x-user-role`, `x-company-id`. |
| **Region resolution** | Dashboard: company looked up by `x-company-id` (dashboard or API id) → `Company.dataRegion` → Prisma for that region. |
| **Rate limiting** | Per API key / endpoint (when enabled). |
| **Request tracing** | `x-request-id` / trace ID on requests and responses. |
| **Health & metrics** | `GET /internal/health`, `GET /internal/metrics` (internal token). |

---

### Customer-facing API (v1) — API key required

| Area | Method | Path | Description |
|------|--------|------|-------------|
| **Events** | POST | `/v1/events` | Ingest audit event (workspace key only). Idempotency key supported. Rejected if workspace archived. |
| **Events** | GET | `/v1/events` | Query events (pagination, filters: from, to, category, action, projectId, workspaceId). |
| **Keys** | POST | `/v1/workspaces/:workspaceId/keys` | Returns 403 — key creation only via dashboard. |
| **Keys** | POST | `/v1/keys/:keyId/rotate` | Returns 403 — rotation only via dashboard. |
| **Keys** | GET | `/v1/keys/status` | Key status (ACTIVE/REVOKED), lastUsedAt, etc. |
| **Webhooks** | POST | `/v1/workspaces/:workspaceId/webhooks` | Create webhook (url, events, projectId, secretLabel). HTTPS required in prod. |
| **Webhooks** | GET | `/v1/workspaces/:workspaceId/webhooks` | List webhooks for workspace. |
| **Webhooks** | POST | `/v1/webhooks/:webhookId/disable` | Disable webhook. |
| **Webhooks** | POST | `/v1/webhooks/:webhookId/enable` | Enable webhook. |
| **Webhooks** | GET | `/v1/webhooks/:webhookId/deliveries` | List deliveries (pagination, status filter). |
| **Exports** | POST | `/v1/exports` | Create export job (source: HOT / ARCHIVED / HOT_AND_ARCHIVED, format: JSONL/CSV, filters, limit). Plan-gated. |
| **Exports** | GET | `/v1/exports/:jobId` | Get job status and metadata. |
| **Exports** | GET | `/v1/exports/:jobId/download` | Stream export data (JSONL or CSV). |

---

### Dashboard-facing API (/dashboard) — x-dashboard-token required

**Contract endpoints (provisioning & sync):**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/dashboard/companies` | Idempotent company provisioning (dashboardCompanyId, slug, name, dataRegion). Returns apiCompanyId, created. |
| GET | `/dashboard/companies/:dashboardCompanyId` | Reconciliation: exists, apiCompanyId, dataRegion, updatedAt. |
| POST | `/dashboard/workspaces` | Idempotent workspace provisioning (dashboardWorkspaceId, dashboardCompanyId, slug, name, status, preferredRegion). |
| GET | `/dashboard/workspaces/:dashboardWorkspaceId` | Reconciliation: exists, apiWorkspaceId, apiCompanyId, status. |
| POST | `/dashboard/workspaces/:dashboardWorkspaceId/archive` | Set workspace ARCHIVED; optional revokeAllKeys; cache invalidation. |
| POST | `/dashboard/workspaces/:dashboardWorkspaceId/restore` | Set workspace ACTIVE (does not un-revoke keys). |
| POST | `/dashboard/api-keys` | Sync: body with dashboardKeyId, scope (co/ws), prefix, hash, etc. Validates region/scope; upsert by dashboardKeyId. Legacy: create key (generate secret) when x-company-id set and body without sync fields. |
| POST | `/dashboard/api-keys/:dashboardKeyId/revoke` | Set revokedAt; idempotent; invalidate auth cache. |

**Company/context-scoped (x-company-id):**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard/company` | Company summary (id, name, dataRegion, plan). |
| GET | `/dashboard/events` | Query events (company-scoped, pagination, filters). |
| POST | `/dashboard/exports` | Create export (returns 501 NOT_IMPLEMENTED or forwards to export flow). |
| GET | `/dashboard/exports/:jobId` | Export job status. |
| GET | `/dashboard/webhooks` | List webhooks (company/workspace context). |

**Restore (Glacier / cold archive):**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/dashboard/restore-requests` | Create restore request (archiveId, tier, days). Plan-gated. |
| GET | `/dashboard/restore-requests` | List restore requests. |
| GET | `/dashboard/restore-requests/:id` | Restore request detail. |
| DELETE | `/dashboard/restore-requests/:id` | Cancel request. |

**Admin (HYRELOG_ADMIN role):**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard/admin/companies` | List/search companies. |
| GET | `/dashboard/admin/plans` | List plans. |
| POST | `/dashboard/admin/companies/:id/plan` | Assign plan to company. |
| GET | `/dashboard/admin/restore-requests` | List all restore requests. |
| POST | `/dashboard/admin/restore-requests/:id/approve` | Approve restore. |
| POST | `/dashboard/admin/restore-requests/:id/reject` | Reject restore (optional reason). |
| GET | `/dashboard/admin/audit-logs` | Audit log entries. |

---

### Runtime enforcement

| Rule | Behavior |
|------|----------|
| **Revoked key** | Any request with key where `revokedAt` set or `status` REVOKED → 401. |
| **Archived workspace** | Write endpoints (e.g. ingest): if key is workspace-scoped and workspace status ARCHIVED → 403 `WORKSPACE_ARCHIVED`. Reads may be allowed. |
| **Scope** | Workspace key: only that workspace. Company key: company-wide (and optional workspace filter where applicable). |
| **Plan / limits** | Exports, webhooks, restore, etc. gated by company plan and overrides. |

---

### Data & regions

| Feature | Description |
|--------|-------------|
| **Multi-region DB** | One Postgres per region (US, EU, UK, AU). Tenant lives in exactly one region. |
| **Hot data** | Events in Postgres (AuditEvent). |
| **Archived data** | Older events in S3 (JSONL); export and restore (including Glacier-style restore) supported. |
| **Webhook delivery** | Async delivery, retries, signing/encryption options. |
| **Audit logging** | Dashboard actions logged to API AuditLog (audit-only actor headers). |

---

### Not yet implemented (API)

- **POST /dashboard/projects** (optional project sync).
- **GDPR** endpoints: create request, execute redaction, get status.
- **Dashboard**-side: central API client wrapper, provisioning orchestrators, reconcile helpers (manual reconcile possible via GET company/workspace).

---

## Frontend Dashboard (HyreLog Dashboard)

**Stack:** Next.js (App Router), TypeScript, Prisma, Better Auth, shadcn/ui.

**Role:** Canonical source for companies, workspaces, projects, members, invites, API key creation intent, and workspace lifecycle. Calls API for provisioning/sync when integrated.

---

### Auth & onboarding

| Feature | Description |
|--------|-------------|
| **Registration** | Sign up (e.g. email/password, OAuth) via Better Auth. |
| **Login** | Login, verify email, verify code, post-login redirect. |
| **Onboarding** | Post-signup onboarding (company/workspace creation when applicable). |
| **Session** | Session and company context; role (OWNER, ADMIN, BILLING, MEMBER), platform role (PLATFORM_ADMIN). |
| **Access control** | `requireDashboardAccess`, company/workspace membership checks. |

---

### Company

| Feature | Description |
|--------|-------------|
| **Company context** | Current company (id, name, slug, preferredRegion, planType, trial). |
| **Company members** | List members, roles, status (ACTIVE/PENDING); invite, remove, change role. |
| **Company invites** | List pending invites; invite by email (OWNER/ADMIN); accept/reject invite. |
| **Transfer ownership** | Transfer company ownership (e.g. OWNER only). |
| **Assign to workspaces** | Assign members to workspaces (sheets/flows). |

---

### Workspaces

| Feature | Description |
|--------|-------------|
| **Workspace list** | List workspaces for company (name, slug, region, member count, status). |
| **Workspace detail** | Workspace by id/slug; tabs/sections for overview, projects, keys, webhooks, members, etc. |
| **Create workspace** | Create workspace (name, slug, region). When integrated: call API POST /dashboard/workspaces and store apiWorkspaceId. |
| **Workspace members** | Add/remove workspace members; invite to workspace. |
| **Workspace invites** | Invite by email; accept invite (e.g. /invite/[token]). |
| **Projects** | Create/edit projects (name, slug, environment). |
| **Archive / restore** | (When implemented) Archive workspace and restore; sync with API archive/restore endpoints. |

---

### API keys

| Feature | Description |
|--------|-------------|
| **Create key** | Create workspace API key (name, scope); secret shown once. When integrated: hash and sync to API (POST /dashboard/api-keys with dashboardKeyId, prefix, hash). |
| **List keys** | List keys for workspace (prefix, scope, last used, status). |
| **Revoke key** | Revoke key; when integrated: call API POST .../revoke and invalidate cache. |
| **Key creation only in dashboard** | v1 key create/rotate return 403; all key lifecycle in dashboard. |

---

### Settings

| Feature | Description |
|--------|-------------|
| **Settings layout** | Settings nav (profile, preferences, notifications, security). |
| **Profile** | Profile section (name, email, avatar, etc.). |
| **Preferences** | Preferences (e.g. locale, timezone). |
| **Notifications** | Notification preferences. |
| **Security** | Security section (e.g. password, 2FA if supported). |

---

### Invites & members

| Feature | Description |
|--------|-------------|
| **Invites list** | Company invites page; workspace invites in workspace detail. |
| **Invite accept** | Public accept-invite page (e.g. /invite/[token]); accept/reject. |
| **Invite email** | Email sent for invite (e.g. InviteEmail template). |

---

### UI & layout

| Feature | Description |
|--------|-------------|
| **Dashboard layout** | App sidebar, topbar, main content. |
| **Dashboard home** | Home with session (e.g. mock or real projects, members, billing). |
| **Regions / locales** | Constants for regions, timezones, locales; searchable pickers where used. |
| **Data & mocks** | Mock data for dashboard home (e.g. dashboard-mock) where API not yet wired. |

---

### Integration with API (when implemented)

| Feature | Description |
|--------|-------------|
| **API client** | Central client: x-dashboard-token, x-request-id, actor headers, retries for 5xx. |
| **Provisioning** | createCompanyAndProvision, createWorkspaceAndProvision, createKeyAndSync, revokeKeyAndSync, archiveWorkspaceAndSync, restoreWorkspaceAndSync. |
| **Reconcile** | reconcileCompany(dashboardCompanyId), reconcileWorkspace(dashboardWorkspaceId) using GET endpoints to backfill apiCompanyId/apiWorkspaceId. |
| **Schema** | Dashboard DB stores apiCompanyId, apiWorkspaceId, apiProjectId (and key mapping) for provisioned entities. |

---

### Not yet implemented (dashboard)

- **GDPR request workflow** (approvals, request creation, call API execute/status).
- **Billing/Stripe** (if planned).
- **Full export/create from dashboard** (API POST /dashboard/exports may return 501 until wired).

---

## Quick reference: who owns what

| Entity / action | Canonical | Replica / enforcement |
|-----------------|-----------|------------------------|
| Company, Workspace, Project | Dashboard | API (regional replica) |
| Members, roles, invites | Dashboard | — |
| API key creation intent (name, prefix, hash, revokedAt) | Dashboard | API (sync + runtime validity) |
| Workspace lifecycle (ACTIVE/ARCHIVED) | Dashboard | API (archive/restore + reject writes) |
| Events, exports, webhooks, delivery | — | API |
| Key revocation / archive effect latency | — | API (seconds; cache invalidation) |

---

**Doc version:** Single reference for backend + dashboard features. Align with [DASHBOARD_API_CONTRACT.md](./DASHBOARD_API_CONTRACT.md) and [TEST_PLAN.md](./TEST_PLAN.md) for contract and testing.
