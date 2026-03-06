# HyreLog — Feature Inventory & Remaining Work

This document lists **every feature implemented so far** in the **API** and **Dashboard**, and **remaining features** still to build. Use it for planning and QA.

---

## Part 1 — API: Implemented Features

### Public / Root

| Feature | Endpoint / behavior | Notes |
|--------|----------------------|--------|
| Root info | `GET /` | Returns service name, version, status. |
| OpenAPI spec | `GET /openapi.json` | Full spec for v1 + dashboard routes (when exposed). |

### Internal (no auth or internal auth)

| Feature | Endpoint | Notes |
|--------|----------|--------|
| Health | `GET /internal/health` | status, uptime, timestamp, service name. |
| Metrics | `GET /internal/metrics` | Placeholder JSON (Prometheus metrics planned). |

### V1 API (Bearer API key)

**Events**

| Feature | Endpoint | Notes |
|--------|----------|--------|
| Ingest event | `POST /v1/events` | Workspace key; body: category, action, optional projectId, timestamp, actor, resource, metadata, idempotencyKey. Idempotent by idempotencyKey. |
| Query events | `GET /v1/events` | Filters: category, action, projectId, from, to; cursor pagination. |

**Keys**

| Feature | Endpoint | Notes |
|--------|----------|--------|
| Create workspace key | `POST /v1/workspaces/:workspaceId/keys` | Company key required; returns key secret once. |
| Rotate key | `POST /v1/keys/:keyId/rotate` | Returns new secret once. |
| Key status | `GET /v1/keys/status` | Returns key id, prefix, scope, status, healthScore, etc. (workspace or company key). |

**Webhooks**

| Feature | Endpoint | Notes |
|--------|----------|--------|
| Create webhook | `POST /v1/workspaces/:workspaceId/webhooks` | Company key; body includes url. Plan-gated. |
| List webhooks | `GET /v1/workspaces/:workspaceId/webhooks` | Company key. |
| Disable webhook | `POST /v1/webhooks/:webhookId/disable` | Company key. |
| Enable webhook | `POST /v1/webhooks/:webhookId/enable` | Company key. |
| List deliveries | `GET /v1/webhooks/:webhookId/deliveries` | Company key. |

**Exports**

| Feature | Endpoint | Notes |
|--------|----------|--------|
| Create export job | `POST /v1/exports` | Body: source (HOT / ARCHIVED / HOT_AND_ARCHIVED), format (JSONL / CSV), optional filters, limit. Plan-gated (e.g. Starter+). |
| Get export job status | `GET /v1/exports/:jobId` | Status, rowsExported, etc. |
| Download export | `GET /v1/exports/:jobId/download` | Streams JSONL or CSV. |

### Dashboard API (service token + actor headers)

**Companies**

| Feature | Endpoint | Notes |
|--------|----------|--------|
| Provision company | `POST /dashboard/companies` | Idempotent; creates company in API region DB; returns apiCompanyId. |
| Get company by dashboard ID | `GET /dashboard/companies/:dashboardCompanyId` | Reconciliation. |
| Get company (current) | `GET /dashboard/company` | Company info for dashboard context. |
| Get events (company) | `GET /dashboard/events` | Company-scoped events for dashboard. |
| Create export (dashboard) | `POST /dashboard/exports` | Dashboard-initiated export. |
| Get export job | `GET /dashboard/exports/:jobId` | Export status. |
| Get webhooks (company) | `GET /dashboard/webhooks` | List webhooks for dashboard. |

**Workspaces**

| Feature | Endpoint | Notes |
|--------|----------|--------|
| Provision workspace | `POST /dashboard/workspaces` | Idempotent; body: dashboardWorkspaceId, dashboardCompanyId, slug, name, status, preferredRegion. |
| Get workspace | `GET /dashboard/workspaces/:dashboardWorkspaceId` | Reconciliation: exists, apiWorkspaceId, status. |
| Archive workspace | `POST /dashboard/workspaces/:dashboardWorkspaceId/archive` | Body: archivedAt, revokeAllKeys. |
| Restore workspace | `POST /dashboard/workspaces/:dashboardWorkspaceId/restore` | Body: restoredAt. |

**API keys (dashboard sync)**

| Feature | Endpoint | Notes |
|--------|----------|--------|
| Create API key | `POST /dashboard/api-keys` | Dashboard creates key; API stores and syncs (hlk_* format when configured). |
| Revoke API key | `POST /dashboard/api-keys/:dashboardKeyId/revoke` | Revokes in API and invalidates cache. |

**Restore (cold archive)**

| Feature | Endpoint | Notes |
|--------|----------|--------|
| Create restore request | `POST /dashboard/restore-requests` | Request restore of cold-archived data. |
| List restore requests | `GET /dashboard/restore-requests` | |
| Get restore request | `GET /dashboard/restore-requests/:id` | |

**Admin (dashboard service token, often IP-restricted)**

| Feature | Endpoint | Notes |
|--------|----------|--------|
| List companies | `GET /dashboard/admin/companies` | |
| List plans | `GET /dashboard/admin/plans` | |
| Set company plan | `POST /dashboard/admin/companies/:id/plan` | |
| List restore requests | `GET /dashboard/admin/restore-requests` | |
| Approve restore | `POST /dashboard/admin/restore-requests/:id/approve` | |
| Reject restore | `POST /dashboard/admin/restore-requests/:id/reject` | |
| Audit logs | `GET /dashboard/admin/audit-logs` | |

---

## Part 2 — Dashboard: Implemented Features

### Auth & onboarding

| Feature | Location | Notes |
|--------|----------|--------|
| Register | `app/auth/register`, `actions/register.ts` | Better Auth signup; company + default workspace “Production” + subscription; best-effort provision to API; verification email. |
| Login | `app/auth/login`, `actions/login.ts` | Email/password. |
| Post-login | `app/auth/post-login` | Post-login redirect/handling. |
| Check email | `app/auth/check-email` | After signup. |
| Verify email (magic link) | `app/auth/verify-email` | |
| Verify code (OTP) | `app/auth/verify-code` | |
| Onboarding | `app/onboarding`, `actions/onboarding.ts` | Company/workspace naming, region (optional step). |

### Invites

| Feature | Location | Notes |
|--------|----------|--------|
| Invites list | `app/(dashboard)/company/invites`, `actions/invites.ts` | For OWNER/ADMIN/BILLING. |
| Invite accept | `app/invites`, `app/invite/[token]` | Accept invite by token. |

### Workspaces

| Feature | Location | Notes |
|--------|----------|--------|
| List workspaces | `app/(dashboard)/workspaces`, `actions/workspaces.ts` | |
| Create workspace | Same | Creates in DB + provisions via API (`provisionWorkspaceAndStore`). |
| Workspace detail | `app/(dashboard)/workspaces/[id]/page.tsx`, `app/(dashboard)/workspaces/[id]/actions.ts` | Tabs: Overview, Keys, Projects, Members, Invites. |
| Rename workspace | `actions.ts` → `renameWorkspaceAction` | |
| Archive workspace | `archiveWorkspaceAction` → `archiveWorkspaceAndSync` | |
| Restore workspace | `restoreWorkspaceAction` → `restoreWorkspaceAndSync` | |
| Delete workspace | `deleteWorkspaceAction` | Soft delete; only if not provisioned (regionLocked). |
| Set workspace region | `updateWorkspaceRegionAction` | Only before provisioning (region locked after). |

### API keys (workspace)

| Feature | Location | Notes |
|--------|----------|--------|
| Create key | `actions.ts` → `createKeyAction` | Uses `createKeyAndSync` when provisioned + key sync configured; full secret shown once. |
| Rename key | `renameKeyAction` | |
| Revoke key | `revokeKeyAction` → `revokeKeyAndSync` | |

### Projects (dashboard-only)

| Feature | Location | Notes |
|--------|----------|--------|
| Create project | `createProjectAction` | Name + slug. |
| Rename project | `renameProjectAction` | |
| Delete project | `deleteProjectAction` | Soft delete. |

### Company

| Feature | Location | Notes |
|--------|----------|--------|
| Members list | `app/(dashboard)/company/members`, `actions/members.ts` | Roles, remove, transfer ownership. |
| Invites | See Invites above. |

### Settings

| Feature | Location | Notes |
|--------|----------|--------|
| Settings shell | `app/(dashboard)/settings/page.tsx` | Redirects to profile. |
| Profile | `app/(dashboard)/settings/profile`, `components/settings/ProfileSection.tsx` | Name, email, timezone, language. |
| Security | `app/(dashboard)/settings/security`, `SecuritySection.tsx` | Password change, etc. |
| Notifications | `app/(dashboard)/settings/notifications` | Email preferences. |
| Preferences | `app/(dashboard)/settings/preferences`, `PreferencesSection.tsx` | |

### Provisioning (backend only)

| Feature | Location | Notes |
|--------|----------|--------|
| Provision company | `actions/provisioning.ts` → `provisionCompanyAndStore` | Dashboard → API. |
| Provision workspace | `provisionWorkspaceAndStore` | |
| Create key & sync | `createKeyAndSync` | API-format key (hlk_*) + sync to API. |
| Sync key after create | `syncKeyAfterCreate` | Best-effort sync for existing keys. |
| Revoke key & sync | `revokeKeyAndSync` | |
| Archive workspace & sync | `archiveWorkspaceAndSync` | |
| Restore workspace & sync | `restoreWorkspaceAndSync` | |

### Other UI

| Feature | Location | Notes |
|--------|----------|--------|
| Dashboard home | `app/(dashboard)/page.tsx` | Overview; may use mock billing info. |
| API Reference | `app/reference/route.ts` | Scalar API Reference; spec from `NEXT_PUBLIC_API_BASE_URL` or api.hyrelog.com. |
| Sidebar | `components/dashboard/AppSidebar.tsx` | Nav: Dashboard, Workspaces, Members, Invites, Billing (Subscription), Personal settings, Company Settings, API Reference; plan badge; region; Help link. |

### Supporting

| Feature | Location | Notes |
|--------|----------|--------|
| Dashboard access / auth | `lib/auth/requireDashboardAccess.ts` | Session + company context. |
| HyreLog API client | `lib/hyrelog-api`, `lib/hyrelog-api/key-format.ts` | Config check, key sync format. |
| Emails | `actions/emails.ts`, `lib/email/sendVerificationEmail` | Verification, etc. |

---

## Part 3 — Remaining Features (To Build)

### API

| Area | Feature | Notes |
|------|--------|--------|
| Internal | **Prometheus metrics** | `/internal/metrics` is placeholder; implement real counters/histograms for requests, errors, latency. |
| V1 | **Key rotation in Dashboard** | API has `POST /v1/keys/:keyId/rotate`; dashboard has no “rotate key” UI (create new + revoke old is current flow). Optional. |
| Plans | **Plan management API** | PLAN_MANAGEMENT.md mentions “Managing Plans via API (Future)”; not implemented. |
| Dashboard API | **Dashboard events/webhooks/exports** | Dashboard routes exist for GET events, GET webhooks, POST/GET exports; dashboard UI may not yet call them or show data. |

### Dashboard

| Area | Feature | Notes |
|------|--------|--------|
| **Billing** | Billing / subscription page | Sidebar links to `/billing/subscription` but no `app/(dashboard)/billing/` route; needs subscription view, plan upgrade, payment method (Stripe or similar). |
| **Company settings** | Company settings page | Sidebar has “Company Settings” → `/settings/company`; no corresponding page in app; add company name, slug, region, danger zone. |
| **Help** | Help page | Sidebar “Need help?” → `/help`; no `app/help` route; add docs/FAQ/support link. |
| **Webhooks** | Webhook management UI | API supports create/list/disable/enable webhooks; dashboard could list/create/edit webhooks per workspace (company key required from backend or role). |
| **Events** | Event explorer / logs UI | Dashboard API has `GET /dashboard/events`; add a page to view recent events (per workspace or company). |
| **Exports** | Export jobs UI | Dashboard API has POST/GET exports; add UI to create export job, show status, download. |
| **Restore requests** | Restore request UI | API has restore-requests and admin approve/reject; dashboard could show “request restore” for cold archive and status. |
| **Audit log** | Company/workspace audit log UI | Admin audit-logs endpoint exists; dashboard could show audit log for company or workspace. |
| **Key rotation** | Rotate key from Dashboard | Optional; API supports rotate; UI could offer “Rotate” and show new secret once. |
| **Company key** | Company-scoped API key in Dashboard | Currently keys are workspace-scoped; if product needs company key for webhooks/exports, add create/list company key in dashboard. |

### Cross-cutting

| Area | Feature | Notes |
|------|--------|--------|
| **E2E / QA** | Run full E2E test plan | Use `docs/DASHBOARD_E2E_TEST_PLAN.md` regularly; automate where possible. |
| **Plans** | Enforce plan limits in Dashboard | Show plan limits (webhooks, exports, retention) and gate actions in UI. |
| **Errors** | Consistent error codes in UI | Map API codes (e.g. PLAN_RESTRICTED, WORKSPACE_ARCHIVED) to user-friendly messages. |

---

## Summary Tables

### API: Implemented

- **Public:** `/`, `/openapi.json`
- **Internal:** `/internal/health`, `/internal/metrics` (placeholder)
- **V1:** Events (ingest, query), Keys (create, rotate, status), Webhooks (CRUD + deliveries), Exports (create, status, download)
- **Dashboard:** Companies (provision, get, events, exports, webhooks), Workspaces (provision, get, archive, restore), API keys (create, revoke), Restore requests, Admin (companies, plans, restore, audit)

### Dashboard: Implemented

- **Auth:** Register, login, verify email/code, onboarding
- **Workspaces:** List, create, detail, rename, archive, restore, delete, region (pre-provision)
- **Keys:** Create, rename, revoke (with API sync when configured)
- **Projects:** Create, rename, delete
- **Company:** Members, invites, accept invite
- **Settings:** Profile, security, notifications, preferences
- **Other:** Dashboard home, API Reference, sidebar nav

### Remaining (high level)

- **API:** Real Prometheus metrics; optional plan/management API.
- **Dashboard:** Billing page, Company settings page, Help page; Webhooks UI; Events explorer; Exports UI; Restore requests UI; Audit log UI; optional key rotation and company key UI.
- **Cross-cutting:** E2E automation; plan limits in UI; error code mapping.

If you add or remove features, update this doc and the [DASHBOARD_E2E_TEST_PLAN.md](./DASHBOARD_E2E_TEST_PLAN.md) so both stay accurate.
