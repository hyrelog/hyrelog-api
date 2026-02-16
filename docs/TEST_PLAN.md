# HyreLog — Full Test Plan

Use this checklist to verify the Dashboard ↔ API integration and all major features. **All API tests are run with Postman** using the collection and environment in `postman/`. Run tests in order where dependencies exist.

---

## Test tool: Postman

- **Collection:** `postman/HyreLog API.postman_collection.json` (import into Postman).
- **Environment:** `postman/HyreLog Local.postman_environment.json` (or create from `postman/ENVIRONMENT_SETUP.md`).
- **Variables to set:** `base_url`, `dashboard_token` (from API `.env` `DASHBOARD_SERVICE_TOKEN`), `internal_token`, `workspace_key` (Bearer key for V1), `company_key`, `workspace_id`, `company_id`, `dashboard_company_id`, `dashboard_workspace_id`, `api_company_id`. After provisioning (sections 3–4), copy `apiCompanyId` → `api_company_id`, `apiWorkspaceId` → `workspace_id` for later requests.
- See `postman/README.md` and `postman/ENVIRONMENT_SETUP.md` for setup details.

---

## Prerequisites

- [ ] **API** running (e.g. `npm run dev` in `hyrelog-api` root or `hyrelog-api/services/api`) with at least one region DB (e.g. US) and seed data (`npm run seed`).
- [ ] **Dashboard** (optional for API-only tests): running with Better Auth and DB; env has `HYRELOG_API_URL` and dashboard service token for calling API.
- [ ] **Env:** `DASHBOARD_SERVICE_TOKEN` in API `.env`; for dashboard, `HYRELOG_API_URL` and `HYRELOG_DASHBOARD_SERVICE_TOKEN` (or equivalent).
- [ ] **Postman:** Collection and environment loaded; variables set as above.

---

## 1. Internal & health (Postman: Root, Internal)

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 1.1 | **Root** → GET `/` (no auth) | 200, `{ service: "hyrelog-api", status: "running" }` |
| 1.2 | **Internal** → **Health Check** (`GET /internal/health`, header `x-internal-token`) | 200, `{ status: "ok", uptime, service: "hyrelog-api" }` |
| 1.3 | **Internal** → **Metrics** (`GET /internal/metrics`, `x-internal-token`) | 200, metrics body (if implemented) |

---

## 2. Dashboard auth (service token) (Postman: Dashboard)

All dashboard requests use header `x-dashboard-token: {{dashboard_token}}`.

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 2.1 | **Dashboard** → **Company-scoped** → **GET Company** with no `x-dashboard-token` (remove or wrong value) | 401, `code: "UNAUTHORIZED"` |
| 2.2 | **GET Company** with wrong token | 401 |
| 2.3 | **GET Company** with valid token but no `x-company-id` | 400 or 401 (missing company context) |
| 2.4 | **Dashboard** → **Companies** → **Provision Company** with valid token only (body required) | 400 VALIDATION_ERROR if body missing, or 201 with body |

---

## 3. Company provisioning (Postman: Dashboard → Companies)

Use a fixed UUID for `dashboardCompanyId` (e.g. from dashboard DB or `{{$guid}}`; save to env as `dashboard_company_id`).

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 3.1 | **Companies** → **Provision Company**  
Body: `dashboardCompanyId`, `slug`, `name`, `dataRegion: "US"`  
Set `dashboard_company_id` in env to the UUID you use. | 201, `apiCompanyId`, `dashboardCompanyId`, `dataRegion`, `status: "PROVISIONED"`, `created: true`. Save `apiCompanyId` → `api_company_id`. |
| 3.2 | Send **Provision Company** again (same body) | 200, same `apiCompanyId`, `created: false` |
| 3.3 | **Companies** → **Get Company by dashboard ID** (same `dashboard_company_id`) | 200, `exists: true`, `apiCompanyId`, `dataRegion`, `updatedAt` |
| 3.4 | **Get Company by dashboard ID** with a random UUID (not provisioned) | 200, `exists: false` |
| 3.5 | **Provision Company** with invalid `dataRegion` (e.g. `"XX"`) | 400 VALIDATION_ERROR |
| 3.6 | **Provision Company** with missing required field (e.g. no `name`) | 400 VALIDATION_ERROR |

---

## 4. Workspace provisioning (Postman: Dashboard → Workspaces)

Company must exist (use `api_company_id` and `dashboard_company_id` from section 3). Set `dashboard_workspace_id` (e.g. new UUID) in env.

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 4.1 | **Workspaces** → **Provision Workspace**  
Body: `dashboardWorkspaceId`, `dashboardCompanyId`, `slug`, `name` | 201, `apiWorkspaceId`, `dashboardWorkspaceId`, `apiCompanyId`, `created: true`, `status: "ACTIVE"`. Save `apiWorkspaceId` → `workspace_id` for V1. |
| 4.2 | Send **Provision Workspace** again | 200, same `apiWorkspaceId`, `created: false` |
| 4.3 | **Workspaces** → **Get Workspace by dashboard ID** | 200, `exists: true`, `apiWorkspaceId`, `apiCompanyId`, `status` |
| 4.4 | **Provision Workspace** with non-existent `dashboardCompanyId` | 404 NOT_FOUND |
| 4.5 | **Provision Workspace** with `preferredRegion` different from company `dataRegion` | 400 REGION_MISMATCH |

---

## 5. API key sync & revoke (Postman: Dashboard → API Keys, V1 API → Events)

You need a key **prefix** and **hash** (from dashboard key creation or test helper). Prefix must match `hlk_{region}_{scope}_...` (e.g. `hlk_us_ws_...`). Set `workspace_key` to the **secret** for Bearer auth in V1.

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 5.1 | **Dashboard** → **API Keys** → **Sync API Key**  
Body: `dashboardKeyId`, `scope: "ws"`, `dashboardCompanyId`, `dashboardWorkspaceId`, `name`, `prefix`, `hash` (region = company dataRegion) | 201, `apiKeyId`, `created: true`, `scopeValidated: true` |
| 5.2 | **Sync API Key** again (same body) | 200, same `apiKeyId`, `created: false` |
| 5.3 | **Sync API Key** with prefix region ≠ company region | 400 REGION_MISMATCH |
| 5.4 | **Sync API Key** with prefix scope ≠ body scope | 400 SCOPE_MISMATCH |
| 5.5 | **API Keys** → **Revoke API Key** (body: `revokedAt` ISO date) | 200, `ok: true` |
| 5.6 | **Revoke API Key** again | 200, `ok: true` (idempotent) |
| 5.7 | **V1 API** → **Events** → **Ingest Event** with **revoked** key (Bearer) | 401 (key revoked) |
| 5.8 | Use a **non-revoked** key and **Ingest Event** | 201 (or 403 if workspace archived) |

---

## 6. Workspace archive & restore (Postman: Dashboard → Workspaces)

Use workspace from section 4; ensure it has at least one API key if testing key revocation.

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 6.1 | **Workspaces** → **Archive Workspace** (body: `archivedAt`, `revokeAllKeys: true`) | 200, `ok: true`, `keysRevokedCount` ≥ 0 |
| 6.2 | **Get Workspace by dashboard ID** | 200, `status: "ARCHIVED"` |
| 6.3 | **V1 API** → **Events** → **Ingest Event** with key that belonged to this workspace | 403 `WORKSPACE_ARCHIVED` |
| 6.4 | **Workspaces** → **Restore Workspace** (body: `restoredAt`) | 200, `ok: true` |
| 6.5 | **Get Workspace by dashboard ID** | 200, `status: "ACTIVE"` |
| 6.6 | **Ingest Event** with same key (still revoked) | 401 (restore does not un-revoke keys) |

---

## 7. Customer API key auth (V1) (Postman: V1 API → Events, Keys)

Use a workspace key created via dashboard/sync; set `workspace_key` to the secret.

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 7.1 | **V1 API** → **Events** → **Ingest Event** with no Authorization | 401 UNAUTHORIZED |
| 7.2 | **Ingest Event** with `Authorization: Bearer <invalid>` | 401 Invalid API key |
| 7.3 | **Ingest Event** with valid workspace key, body e.g. `{ "category": "test", "action": "test" }` | 201, event created (or 403 if workspace archived) |
| 7.4 | **Events** → **Query Events (Workspace Key)** (or **Query Events (Company Key)**) | 200, list of events |
| 7.5 | **Keys** → **Get Key Status** | 200, key status (e.g. ACTIVE, lastUsedAt) |
| 7.6 | **Keys** → **Create Workspace Key** | 403 FORBIDDEN (key creation only via dashboard) |

---

## 8. Exports (V1) (Postman: V1 API → Exports)

Requires valid API key and plan that allows exports (e.g. STARTER or overrides).

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 8.1 | **Exports** → **Create Export (HOT - JSONL)** (body: source, format, filters) | 201, `jobId`, `status` (e.g. PENDING) or 403 PLAN_RESTRICTED |
| 8.2 | **GET Export Status** (use `jobId` from 8.1) | 200, job status, counts |
| 8.3 | **GET Export Download** (or equivalent) | 200, streamed body (JSONL/CSV) or 404/403 as appropriate |

---

## 9. Webhooks (V1) — CRUD only (Postman: V1 API → Webhooks)

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 9.1 | **Webhooks** → **Create Webhook**  
Body: `url`, `events: ["AUDIT_EVENT_CREATED"]` (use `workspace_id` in path) | 201, webhook id, secret (or 403 if plan/feature disabled). Save `webhookId` for 9.5 and section 10. |
| 9.2 | **List Webhooks** | 200, list of webhooks |
| 9.3 | **Disable Webhook** | 200 |
| 9.4 | **Enable Webhook** | 200 |
| 9.5 | **Get Webhook Deliveries** | 200, list of deliveries (may be empty until E2E in section 10) |

---

## 10. Webhooks — End-to-end (Postman + worker + webhook receiver)

This verifies that the **worker** delivers webhook payloads and that you can confirm deliveries via the API.

**Prerequisites:** API running; at least one webhook created (section 9) with a URL your machine can receive (e.g. `http://localhost:3001/webhook` or ngrok URL). Worker must run so webhook delivery job runs.

| # | Step | Expected |
|---|------|----------|
| 10.1 | In Postman, **V1 API** → **Webhooks** → **Create Webhook** with `url: "http://localhost:3001/webhook"` (or your receiver URL). Save `webhookId` and optional `secret`. | 201, webhook created. |
| 10.2 | Start the test receiver: `node tools/webhook-receiver.js [port]` (default 3001). Optionally set `WEBHOOK_SECRET` to the webhook secret for signature verification. | Receiver listening on port. |
| 10.3 | In Postman, **V1 API** → **Events** → **Ingest Event** (valid workspace key, body e.g. `category`, `action`). | 201, event created. |
| 10.4 | Run the worker so it processes the webhook queue: either `npm run worker` (continuous) or run the webhook job once if your worker supports a single-job mode. See section 11. | Worker picks up pending delivery and POSTs to receiver. |
| 10.5 | In receiver terminal: confirm a POST was received with body (event payload), headers `x-hyrelog-signature`, `x-hyrelog-delivery-id`, `x-hyrelog-attempt`. | Receiver logs the request; optional signature check if `WEBHOOK_SECRET` set. |
| 10.6 | In Postman, **V1 API** → **Webhooks** → **Get Webhook Deliveries** (use saved `webhookId`). | 200, list includes the delivery (e.g. success, statusCode 200). |

---

## 11. Workers & background jobs

The **worker** (`hyrelog-api`) runs webhook delivery and archival/restore jobs. Use this section to verify worker behaviour; API behaviour is tested via Postman, worker behaviour by running the worker and (optionally) scripts.

**Location:** `hyrelog-api/services/worker`; run from repo root: `npm run worker` (all jobs + webhook worker) or single job: `npm run worker -- <job-name>`.

### 11.1 Running the worker

| # | Step | Expected |
|---|------|----------|
| 11.1 | From `hyrelog-api`: `npm run worker` | Worker starts; webhook worker runs continuously; scheduled jobs run on intervals (daily/weekly/restore intervals). |
| 11.2 | Run a single job: `npm run worker -- retention-marking` (or `archival`, `archive-verification`, `cold-archive-marker`, `restore-initiator`, `restore-status-checker`, `restore-expiration`). | Job runs once for configured region(s) and exits. |

**Job names (CLI):**

- `retention-marking` — mark events older than hot retention as archival candidates.
- `archival` — archive marked events to S3/MinIO (gzipped JSONL).
- `archive-verification` — verify archived files (checksum).
- `cold-archive-marker` — mark old archives for cold storage.
- `restore-initiator` — start Glacier/cold restore requests.
- `restore-status-checker` — poll restore status and update DB.
- `restore-expiration` — mark expired restores.

### 11.2 Verifying worker behaviour

| # | What to verify | How |
|---|----------------|-----|
| 11.3 | Webhook delivery | After ingesting an event (Postman **Ingest Event**) and running the worker, use **Get Webhook Deliveries** in Postman and/or confirm POST in `tools/webhook-receiver.js` (section 10). |
| 11.4 | Archival | Ensure events exist and retention has marked some; run `npm run worker -- retention-marking` then `npm run worker -- archival`. Check S3/MinIO for new objects and DB for `ArchiveObject` records. |
| 11.5 | Restore jobs | If using cold/restore flow: create restore request (Postman **Dashboard** → **Restore** → **Create Restore Request**); run `restore-initiator`, then `restore-status-checker`; check restore request status via Postman **Get Restore Request**. |

**Helper script:** `npm run test:worker` runs `scripts/test-worker-jobs.ps1`, which prints job names and how to run them (no assertions).

---

## 12. Dashboard proxy routes (x-company-id) (Postman: Dashboard → Company-scoped)

With valid `x-dashboard-token` and `x-company-id` (dashboard or API company id), region is resolved from company.

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 12.1 | **Company-scoped** → **GET Company** (headers: `x-dashboard-token`, `x-company-id: {{api_company_id}}`) | 200, company id, name, dataRegion, plan |
| 12.2 | **GET Events** (query params as needed) | 200, events list (company-scoped) |
| 12.3 | **POST Create Export** (if implemented) | 201 or 501 NOT_IMPLEMENTED |
| 12.4 | **GET Export Status** (use jobId from 12.3 if applicable) | 200 or 404 |
| 12.5 | **GET Webhooks** | 200, webhooks list |

---

## 13. Restore requests (Postman: Dashboard → Restore)

Requires dashboard auth and company context (`x-company-id`).

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 13.1 | **Restore** → **Create Restore Request** (body: `archiveId`, `tier`, `days`) | 201 or 403/400 (plan or validation) |
| 13.2 | **List Restore Requests** | 200, list |
| 13.3 | **Get Restore Request** (use id from list) | 200, request detail |
| 13.4 | **Cancel Restore Request** | 200 or 404 |

---

## 14. Admin (Postman: Dashboard → Admin)

Requires dashboard auth with user role indicating admin (e.g. actor header `x-user-role: HYRELOG_ADMIN` if enforced).

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 14.1 | **Admin** → **List Companies** | 200, list (or 403 if not admin) |
| 14.2 | **List Plans** | 200, plans list |
| 14.3 | **Assign Plan to Company** (body: `planId`) | 200 or 403/404 |
| 14.4 | **List Restore Requests (Admin)** | 200 |
| 14.5 | **Approve Restore** | 200 or 403 |
| 14.6 | **Reject Restore** (body: optional `reason`) | 200 or 403 |
| 14.7 | **Audit Logs** | 200, audit log entries |

---

## 15. Reconciliation (manual) (Postman: Dashboard → Companies, Workspaces)

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 15.1 | Create company in dashboard DB only (no API call). **Get Company by dashboard ID** with that id. | `exists: false` (API never provisioned). |
| 15.2 | **Provision Company** with that same `dashboardCompanyId`. Then **Get Company by dashboard ID** again. | `exists: true`, `apiCompanyId` — dashboard can backfill `apiCompanyId` from this response. |
| 15.3 | Same for workspace: **Get Workspace by dashboard ID** before/after **Provision Workspace**. | Before: optional 404/exists false; after: exists true, apiWorkspaceId. |

---

## 16. Error codes (contract)

Use Postman to trigger each condition; confirm API returns the documented code.

| # | Step (Postman) | Expected |
|---|----------------|----------|
| 16.1 | Dashboard request with bad token | 401, `code: "UNAUTHORIZED"` |
| 16.2 | Dashboard request with invalid body (e.g. invalid UUID) | 400, `code: "VALIDATION_ERROR"` |
| 16.3 | Dashboard request referencing non-existent company/workspace | 404, `code: "NOT_FOUND"` |
| 16.4 | **Sync API Key** with prefix region ≠ company | 400, `code: "REGION_MISMATCH"` |
| 16.5 | **Sync API Key** with prefix scope ≠ body scope | 400, `code: "SCOPE_MISMATCH"` |
| 16.6 | **Ingest Event** with archived workspace | 403, `code: "WORKSPACE_ARCHIVED"` |
| 16.7 | **Ingest Event** with revoked key | 401 (revoked) |

---

## 17. Dashboard UI (high level)

If the dashboard app is wired to the API (client + orchestrators; see [REMAINING_TASKS.md](./REMAINING_TASKS.md)):

| # | Step | Expected |
|---|------|----------|
| 17.1 | Sign up / log in | Session, redirect to dashboard or onboarding |
| 17.2 | Onboarding: create company (and optionally workspace) | Company created; if integrated, API provisioned and apiCompanyId stored |
| 17.3 | Create workspace from dashboard | Workspace created; if integrated, API provisioned and apiWorkspaceId stored |
| 17.4 | Open workspace → create API key | Key created; secret shown once; if integrated, key synced to API |
| 17.5 | Revoke key from dashboard | Key revoked; next API call with that key returns 401 |
| 17.6 | Archive workspace (if implemented) | Workspace archived; ingestion with workspace key returns 403 WORKSPACE_ARCHIVED |
| 17.7 | Company members, invites, workspace members | CRUD and list as designed |
| 17.8 | Settings: profile, preferences, security, notifications | Pages load and save as designed |

---

## Sign-off

- [ ] All sections run and results match “Expected” (or documented exceptions).
- [ ] No unhandled 500s for valid contract requests.
- [ ] Idempotency (company/workspace/key) and revoke/archive behaviour match spec.
- [ ] Webhook E2E: create webhook → ingest event → worker delivers → deliveries visible in Postman and/or receiver.
- [ ] Worker: at least one job run (e.g. retention-marking or webhook delivery) and outcome verified.

**Notes:**

- For key sync tests (section 5), use a real prefix/hash from your key generation or a test helper.
- If the dashboard does not yet call the API for provisioning, focus on sections 1–9, 12–16 via Postman; section 17 is partial until the dashboard has the API client and orchestrators (see [REMAINING_TASKS.md](./REMAINING_TASKS.md)).
