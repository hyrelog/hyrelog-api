# HyreLog — Dashboard ↔ API End-to-End Test Plan

This plan walks through **starting from scratch**, setting up everything via the **Dashboard UI**, and then **testing the API** with the resources you created. Use it to verify that Dashboard and API stay in sync and that all features work end-to-end.

For **API-only** and **Postman** tests (internal health, provisioning via API, key sync, etc.), see [TEST_PLAN.md](./TEST_PLAN.md).

---

## Prerequisites

| Requirement | Where |
|-------------|--------|
| **API** running | `hyrelog-api`: `npm run dev` (or `cd services/api && npm run dev`). Port **3000**. |
| **Dashboard** running | `hyrelog-dashboard`: `npm run dev`. Port **4000**. |
| **Databases** | Per [README.md](../README.md): run `docker compose up -d`, then migrations for API region DB(s) and dashboard DB. |
| **Dashboard env** | `HYRELOG_API_URL=http://localhost:3000`, `DASHBOARD_SERVICE_TOKEN` (same as API), `HYRELOG_API_KEY_SECRET` (same as API’s `API_KEY_SECRET`) for key sync. |
| **API env** | `DASHBOARD_SERVICE_TOKEN` (same as dashboard), `API_KEY_SECRET`. |

Ports and env details: [PORTS_AND_ENV.md](./PORTS_AND_ENV.md).

---

## Phase 1 — Start from scratch: Create account and company

**Goal:** One user, one company, one default workspace (e.g. “Production”) created in the Dashboard and, when API is configured, provisioned in the API.

### 1.1 Sign up (Dashboard)

| Step | Action | How to verify |
|------|--------|----------------|
| 1.1.1 | Open **http://localhost:4000** and go to **Sign up**. | Sign-up page loads. |
| 1.1.2 | Enter name, email, password, and **company name** (or leave blank for “Your Name’s Company”). Submit. | Redirect to check-email or dashboard; no error. |
| 1.1.3 | Complete email verification if required (magic link or code). | You land on dashboard or onboarding. |

**Backend:** Registration creates User (Better Auth), Company, default Workspace “Production”, and Subscription. Provisioning to the API is triggered from onboarding completion/skip and from create-workspace flows (best-effort). Sign-up does **not** fail if API is down.

### 1.2 Verify company and workspace exist (Dashboard)

| Step | Action | How to verify |
|------|--------|----------------|
| 1.2.1 | Open **Workspaces** (sidebar). | You see at least one workspace (e.g. “Production”). |
| 1.2.2 | Click the workspace to open its detail page. | Workspace detail loads; tabs: Overview / Keys / Projects / Members / Invites (or similar). |
| 1.2.3 | Open **Dashboard** (sidebar/home). | Owners/Admin/Billing users see **company-level** dashboard; Members see **workspace-level** dashboard. |

**Optional API check (Postman or curl):** If you have the dashboard company ID and API token, you can call the API’s dashboard endpoints to confirm the company/workspace exist in the API (see [TEST_PLAN.md](./TEST_PLAN.md) sections 3–4). For UI-only flow, the next phase (creating a key) will fail if the workspace is not provisioned.

---

## Phase 2 — Provisioning (if not already done)

If you did **not** have the API running at sign-up, company/workspace may exist only in the Dashboard DB. Creating an **API key** in the Dashboard requires the workspace to be provisioned (company + workspace must have `apiCompanyId` / `apiWorkspaceId`). Provisioning runs on onboarding completion/skip and when you **create a new workspace** (create workspace action calls `provisionWorkspaceAndStore`).

### 2.1 Ensure API is running and env is correct

| Step | Action | How to verify |
|------|--------|----------------|
| 2.1.1 | Start API; ensure Dashboard `.env` has `HYRELOG_API_URL`, `DASHBOARD_SERVICE_TOKEN`, and (for key sync) `HYRELOG_API_KEY_SECRET`. | No env errors in Dashboard/API logs. |
| 2.1.2 | (Optional) Trigger provisioning for existing company: e.g. create a **new workspace** (see Phase 3). That will provision the company if needed, then the new workspace. | New workspace appears and can get API keys. |

If the **first** workspace (e.g. Production) was created before the API was configured, you can still create a **second** workspace from the Dashboard; that will call the API and provision company + new workspace. Then use either workspace for keys.

---

## Phase 3 — Workspaces

**Goal:** Confirm workspace list and create an additional workspace if desired; ensure it’s provisioned so keys can be created.

### 3.1 List workspaces

| Step | Action | How to verify |
|------|--------|----------------|
| 3.1.1 | Go to **Workspaces**. | List shows your workspace(s); name, slug, member count (or similar). |
| 3.1.2 | Click a workspace. | Workspace detail page with Keys / Projects / Members etc. |

### 3.2 Create a new workspace (optional)

| Step | Action | How to verify |
|------|--------|----------------|
| 3.2.1 | On Workspaces page, use **Create workspace** (or equivalent). Enter name and optionally region. Submit. | New workspace appears in the list. |
| 3.2.2 | Open the new workspace. | Detail page loads; no “must be provisioned first” when creating a key (Phase 4). |

**Backend:** Create workspace creates the workspace in the Dashboard DB and calls `provisionWorkspaceAndStore` (and company if needed). So after this step, both Dashboard and API have the company and workspace.

---

## Phase 4 — API keys (Dashboard)

**Goal:** Create a workspace API key in the Dashboard, copy the secret once, and confirm it appears in the UI and (in Phase 5) works with the API.

### 4.1 Create API key

| Step | Action | How to verify |
|------|--------|----------------|
| 4.1.1 | Open a workspace that is provisioned (has `apiWorkspaceId`). Go to **Keys** (or API Keys) tab. | Keys section shows existing keys or empty state. |
| 4.1.2 | Click **Create API key** (or Add key). Enter a name (e.g. “E2E test key”). Submit. | A modal or page shows the **full key (secret)** once. |
| 4.1.3 | **Copy the full key** and store it somewhere safe (e.g. a temporary env var or Postman variable). You will use it as `Authorization: Bearer <full_key>`. | You have the secret; UI warns it won’t be shown again. |
| 4.1.4 | Close the modal. | Keys list shows the new key with a **prefix** (e.g. `hlk_us_ws_...`); status Active. |

**Backend:** When API and key sync are configured, the Dashboard creates the key in the Dashboard DB (with prefix + hash) and calls `syncApiKey` so the API has the same key. If key sync is not configured, the key exists only in the Dashboard and **will not** work with the API.

### 4.2 Verify key in Dashboard

| Step | Action | How to verify |
|------|--------|----------------|
| 4.2.1 | On the same workspace, Keys tab: confirm the key shows prefix, name, status, last used (optional). | No errors; optional “last used” updates after you call the API (Phase 5). |

---

## Phase 5 — Projects (Dashboard)

**Goal:** Create a project in a workspace so you can (optionally) send events with `projectId` when calling the API.

### 5.1 Create project

| Step | Action | How to verify |
|------|--------|----------------|
| 5.1.1 | In workspace detail, open **Projects** tab. | Projects list or empty state. |
| 5.1.2 | Create a project (e.g. name “Web app”). Submit. | New project appears with name and slug. |
| 5.1.3 | Note the **project ID** (e.g. from URL or a copy button) if you want to send events with `projectId`. | You have the UUID for API requests. |

**Note:** Projects exist in the Dashboard (and optionally in the API’s project list depending on implementation). The **API** accepts `projectId` in the event payload (POST /v1/events) and validates that the project belongs to the workspace. So you use the **Dashboard project ID** (UUID) in the API body.

---

## Phase 6 — Test the API with the key

**Goal:** Use the workspace API key from Phase 4 to call the API: health, key status, ingest event, query events. Optionally use the project ID from Phase 5.

### 6.1 Public endpoints (no key)

| Step | Action | How to verify |
|------|--------|----------------|
| 6.1.1 | `GET http://localhost:3000/health` (no auth). | 200, body e.g. `{ "ok": true }`. |
| 6.1.2 | `GET http://localhost:3000/openapi.json` (no auth). | 200, OpenAPI JSON with paths for /health and /v1/*. |

### 6.2 Key status (requires key)

| Step | Action | How to verify |
|------|--------|----------------|
| 6.2.1 | `GET http://localhost:3000/v1/keys/status` with header `Authorization: Bearer <your_full_key>`. | 200, body with `id`, `prefix`, `scope`, `status`, `healthScore`, etc. |

If you get **401**, the key is not in the API (key sync not configured or failed) or the key is revoked.

### 6.3 Ingest event (requires workspace key)

| Step | Action | How to verify |
|------|--------|----------------|
| 6.3.1 | `POST http://localhost:3000/v1/events` with `Authorization: Bearer <your_full_key>` and body: `{ "category": "e2e", "action": "test" }`. | 201, body includes `id` (event id). |
| 6.3.2 | Same with optional fields: `projectId` (UUID from Phase 5), `timestamp`, `actor`, `resource`, `metadata`, `idempotencyKey`. | 201; event is stored with those fields. |
| 6.3.3 | Repeat the same request **with the same `idempotencyKey`**. | 200 and the **same** event id (idempotent). |

If you get **403** “Only workspace keys can ingest” you might be using a company key; use a key created under a workspace. If **403** “Workspace is archived”, restore the workspace in the Dashboard first.

### 6.4 Query events

| Step | Action | How to verify |
|------|--------|----------------|
| 6.4.1 | `GET http://localhost:3000/v1/events?limit=10` with `Authorization: Bearer <your_full_key>`. | 200, body has `data` (array of events) and `nextCursor`. |
| 6.4.2 | Use query params: `category`, `action`, `projectId`, `from`, `to`, `cursor`. | 200; results match filters; cursor pagination works. |

### 6.5 Confirm last used in Dashboard (optional)

| Step | Action | How to verify |
|------|--------|----------------|
| 6.5.1 | In Dashboard, open the workspace → Keys. | Key shows “last used” (or similar) updated after your API calls. |

---

## Phase 7 — Key revocation and archive/restore (Dashboard → API)

**Goal:** Revoke a key in the Dashboard and confirm the API rejects it; optionally archive/restore workspace and confirm API behaviour.

### 7.1 Revoke key

| Step | Action | How to verify |
|------|--------|----------------|
| 7.1.1 | In Dashboard, workspace → Keys: find the key you used; use **Revoke** (or equivalent). Confirm. | Key shows as Revoked (or inactive). |
| 7.1.2 | Call `POST /v1/events` with the same key. | 401 (key revoked). |
| 7.1.3 | Call `GET /v1/keys/status` with the same key. | 401. |

### 7.2 Archive workspace (optional)

| Step | Action | How to verify |
|------|--------|----------------|
| 7.2.1 | Create a **second** API key in the same workspace (or use another workspace with a key). Use it to send an event; confirm 201. | Event created. |
| 7.2.2 | In Dashboard, **Archive** that workspace (workspace settings or danger zone). Confirm. | Workspace status Archived. |
| 7.2.3 | Call `POST /v1/events` with the workspace key. | 403, `code: "WORKSPACE_ARCHIVED"`. |
| 7.2.4 | In Dashboard, **Restore** the workspace. | Workspace status Active. |
| 7.2.5 | Call `POST /v1/events` again with the **same** key. | 401 (restore does **not** un-revoke keys; keys revoked at archive stay revoked). Create a new key to ingest again. |

---

## Phase 8 — Webhooks (API + optional worker)

**Goal:** Create a webhook via the API (company key required), send an event, and confirm delivery if the worker is running. Dashboard may also expose webhook management; if so, you can create/list webhooks from the UI and verify via API.

### 8.1 Webhook requirements

- **Company-scoped** API key (not workspace key) for create/list/disable/enable.
- **IP allowlist** may be required for management (see API docs).
- **Worker** running to process webhook delivery jobs.

### 8.2 Create webhook (API)

| Step | Action | How to verify |
|------|--------|----------------|
| 8.2.1 | With a **company** key: `POST /v1/workspaces/<workspace_id>/webhooks` with body `{ "url": "https://webhook.site/your-id" }` (or a local receiver). | 201, body includes `id`, `secret` (shown once), `url`. |
| 8.2.2 | `GET /v1/workspaces/<workspace_id>/webhooks`. | 200, list includes the webhook (no secret). |

### 8.3 Trigger delivery

| Step | Action | How to verify |
|------|--------|----------------|
| 8.3.1 | With a **workspace** key for that workspace: `POST /v1/events` with `{ "category": "test", "action": "webhook" }`. | 201. |
| 8.3.2 | Run the **worker** (e.g. `npm run worker` in hyrelog-api) so it processes the webhook queue. | Worker logs show job run. |
| 8.3.3 | Check webhook receiver (webhook.site or local server). | POST received with event payload and headers (e.g. `x-hyrelog-signature`, `x-hyrelog-delivery-id`). |
| 8.3.4 | `GET /v1/webhooks/<webhook_id>/deliveries`. | 200, list includes the delivery (e.g. success, statusCode 200). |

---

## Phase 9 — Exports (API)

**Goal:** Create an export job and (if plan allows) download data. Plan must allow exports (e.g. Starter or overrides).

### 9.1 Create export job

| Step | Action | How to verify |
|------|--------|----------------|
| 9.1.1 | With a workspace (or company) key: `POST /v1/exports` with body `{ "source": "HOT", "format": "JSONL" }`. | 201 with `jobId`, `status`, or 403 PLAN_RESTRICTED. |
| 9.1.2 | `GET /v1/exports/<jobId>`. | 200, job status, `rowsExported`, etc. |
| 9.1.3 | `GET /v1/exports/<jobId>/download`. | 200, streamed JSONL (or CSV); or 404/403 if job not ready or not allowed. |

---

## Phase 10 — Dashboard UI coverage (summary)

Use this as a checklist for all major Dashboard flows. Each item: perform the action in the UI, then verify the outcome (UI state and/or API call).

| Area | Action | Verify |
|------|--------|--------|
| **Auth** | Sign up, sign in, sign out, verify email. | Session, redirects, no errors. |
| **Onboarding** | Complete onboarding (company/workspace name, region) if shown. | Data saved; redirect to dashboard. |
| **Company** | View company; members list; invites (if admin). | Pages load; data correct. |
| **Workspaces** | List workspaces; create workspace; open workspace; rename; archive; restore; delete (if allowed). | CRUD works; provisioned workspace can have keys. |
| **Keys** | Create key; copy secret; revoke key; (optional) rename key. | Key appears; after revoke, API returns 401. |
| **Projects** | Create project; rename; delete. | Project appears in workspace; can use `projectId` in API. |
| **Members / Invites** | Invite member; accept invite (second browser); list members. | Invite flow and roles work. |
| **Billing** | Open billing/subscription page. | Loads; plan shown. |
| **Settings** | Personal settings; company settings; profile; security; notifications. | Pages load; saves work. |
| **API Reference** | Open **API Reference** (sidebar) → `/reference`. | Scalar loads; spec from `https://api.hyrelog.com/openapi.json` (or local) shows all public endpoints. |

---

## Quick reference: API base URLs and auth

| Context | Base URL | Auth |
|---------|----------|------|
| Local API | `http://localhost:3000` | Workspace key: `Authorization: Bearer <full_key>` |
| Local Dashboard | `http://localhost:4000` | Session (Better Auth) |
| Production API | `https://api.hyrelog.com` | Same Bearer key |
| Production Dashboard | `https://app.hyrelog.com` | Same session |

**Getting the full key:** Only at creation time in the Dashboard (Keys tab → Create API key). Store it securely; use it as `Authorization: Bearer <full_key>` for all `/v1/*` requests that require auth.

---

## Sign-off checklist

- [ ] Phase 1: Account and company created via Dashboard; at least one workspace visible.
- [ ] Phase 2–3: Provisioning confirmed (e.g. by creating a key successfully); optional second workspace created.
- [ ] Phase 4: API key created in Dashboard; full key copied.
- [ ] Phase 5: Optional project created; project ID noted.
- [ ] Phase 6: API health and openapi.json OK; key status 200; ingest event 201; query events 200; optional last-used in Dashboard.
- [ ] Phase 7: Revoked key returns 401; optional archive/restore and 403/401 behaviour confirmed.
- [ ] Phase 8: Webhook created via API; event triggers delivery when worker runs; deliveries visible via API.
- [ ] Phase 9: Export job created and status/download checked (or 403 PLAN_RESTRICTED noted).
- [ ] Phase 10: All listed Dashboard areas exercised and working.

**Notes:**

- If key sync is not configured (`HYRELOG_API_KEY_SECRET` / `API_KEY_SECRET`), keys created in the Dashboard will **not** work with the API. Ensure both are set and match.
- For Postman-based API tests (provisioning, key sync, internal endpoints), use [TEST_PLAN.md](./TEST_PLAN.md) and the Postman collection in `postman/`.
