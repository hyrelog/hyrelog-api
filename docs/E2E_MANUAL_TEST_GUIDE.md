# HyreLog End-to-End Manual Test Guide

Walk through the full HyreLog flow step by step. Steps are split into **Browser** (Dashboard UI) and **Postman** (or curl) where you call the API directly. Each API step includes exact method, URL, headers, body, and expected response.

---

## Do I need Stripe to run these tests?

**No.** You can run the full E2E flow (Parts 1-4, 5, 6, 7, 8) without Stripe. Stripe is only required for:

- Part 2 steps 2.5 and 2.6 (Upgrade, Manage billing)
- Part 9 (Stripe webhook local)

If Stripe is not configured, the Billing page still loads and shows plan and usage; Upgrade and Manage billing will be disabled or show a message. Skip those steps and continue with API key, events, exports, webhooks, and company settings.

---

## Prerequisites

| Item | Details |
|------|--------|
| **Databases** | Postgres running; Dashboard DB and API region DB(s) migrated. |
| **Dashboard** | `cd hyrelog-dashboard && npm run dev` (port 4000). |
| **API** | `cd hyrelog-api && npm run dev` (or `cd services/api && npm run dev`) (port 3000). |
| **Env** | Dashboard: `DATABASE_URL`, `HYRELOG_API_URL=http://localhost:3000`, `DASHBOARD_SERVICE_TOKEN`. API: `DATABASE_URL_*`, `DASHBOARD_SERVICE_TOKEN`, `API_KEY_SECRET`, `DASHBOARD_USAGE_URL=http://localhost:4000`. For key sync: Dashboard `HYRELOG_API_KEY_SECRET` = API `API_KEY_SECRET`. |
| **Stripe (optional)** | For billing: see [Stripe Setup Guide](../../hyrelog-dashboard/docs/STRIPE_SETUP.md). For local webhooks: `stripe listen --forward-to localhost:4000/api/stripe/webhook` and set `STRIPE_WEBHOOK_SECRET` in Dashboard `.env`. |

**Postman setup:** Create an environment with variables: `baseUrl` = `http://localhost:3000`, `apiKey` = (paste your workspace key after Step 3.3), `companyKey` = (optional; for webhooks, see Part 6), `workspaceId`, `jobId`, `webhookId`. Use `{{baseUrl}}` and `{{apiKey}}` in requests below.

**Resetting to a clean state:** To clear all users, companies, and data and leave only default reference data (plans, regions, etc.) for testing, use the reset scripts. See [Resetting databases for testing](#resetting-databases-for-testing) at the end of this guide.

---

## Part 1: Account and onboarding (Browser)

| Step | Where | Action | Expected result |
|------|--------|--------|-----------------|
| 1.1 | Browser | Open **http://localhost:4000**. | Dashboard home or sign-in page loads. |
| 1.2 | Browser | Click **Sign up**. Fill name, email, password, company name. Submit. | Redirect to check-email or dashboard; no error. |
| 1.3 | Browser | Complete email verification if required (magic link or code). | You land on dashboard or onboarding. |
| 1.4 | Browser | If onboarding is shown, complete it (company/workspace name, region). Submit. | Data saved; redirect to dashboard home. |
| 1.5 | Browser | In sidebar click **Workspaces**. | At least one workspace (e.g. "Production") is listed. |
| 1.6 | Browser | Click a workspace. Note the **workspace ID** in the URL (e.g. `/workspaces/[id]`) for later. | Workspace detail page with tabs: Overview, Keys, Projects, Members, Invites. |

---

## Part 2: Dashboard home and billing (Browser)

| Step | Where | Action | Expected result |
|------|--------|--------|-----------------|
| 2.1 | Browser | Go to **Home** (sidebar). | Home loads with company overview and a billing/subscription card. |
| 2.2 | Browser | On the billing card, confirm **plan name** (e.g. "Free") and **usage** (events, exports, webhooks). | Plan label and usage numbers (or zeros) visible. |
| 2.3 | Browser | Click **Manage subscription**. | Navigate to **Billing > Subscription** page. |
| 2.4 | Browser | On Billing page confirm: current plan, status, next billing date (if any), usage this period. | All fields render without error. |
| 2.5 | Browser | (Optional, if Stripe configured) Click **Upgrade** on a paid plan. Complete Checkout with card `4242 4242 4242 4242`. | Redirect to Stripe; after payment, return to success URL; Billing page shows updated plan. |
| 2.6 | Browser | Click **Manage billing**. | Stripe Customer Portal opens; you can update payment or cancel. Return to Dashboard when done. |

---

## Part 3: API key and event ingest

### 3.1 Create API key (Browser)

| Step | Where | Action | Expected result |
|------|--------|--------|-----------------|
| 3.1 | Browser | Open **Workspaces** > select your workspace > **Keys** tab. | Keys list or empty state. |
| 3.2 | Browser | Click **Create API key**. Enter name (e.g. "E2E key"). Submit. | Modal shows the **full key (secret)** once. |
| 3.3 | Browser | **Copy the full key.** Save it as Postman/env variable `apiKey` (and in a safe place). Close modal. | Keys list shows new key with prefix (e.g. `hlk_us_ws_...`), status Active. |

### 3.2 Verify API and key (Postman)

| Step | Where | Call | Expected result |
|------|--------|------|-----------------|
| 3.4 | Postman | **GET** `http://localhost:3000/health` (no auth). | **Status 200.** Body: `{ "status": "ok", "uptime": <number>, "timestamp": "<ISO>", "service": "hyrelog-api" }`. |
| 3.5 | Postman | **GET** `http://localhost:3000/v1/keys/status`<br>**Headers:** `Authorization: Bearer {{apiKey}}` | **Status 200.** Body includes: `id`, `prefix`, `scope` (e.g. "WORKSPACE"), `status`, `healthScore`. If 401: key not synced or invalid. |

### 3.3 Ingest events (Postman)

| Step | Where | Call | Expected result |
|------|--------|------|-----------------|
| 3.6 | Postman | **POST** `http://localhost:3000/v1/events`<br>**Headers:** `Authorization: Bearer {{apiKey}}`, `Content-Type: application/json`<br>**Body (raw JSON):** `{ "category": "e2e", "action": "test" }` | **Status 201.** Body: `{ "id": "<event-uuid>" }`. |
| 3.7 | Postman | **POST** `http://localhost:3000/v1/events`<br>**Headers:** same as 3.6<br>**Body:** `{ "category": "e2e", "action": "test", "metadata": { "source": "e2e-guide" }, "idempotencyKey": "e2e-idem-1" }` (optional: add `projectId` with a project UUID from your workspace) | **Status 201.** Body: `{ "id": "<event-uuid>" }`. |
| 3.8 | Postman | **POST** same URL, same headers, **same body** as 3.7 (including `idempotencyKey: "e2e-idem-1"`). | **Status 200.** Body: `{ "id": "<same-event-uuid-as-3.7>" }` (idempotent). |

---

## Part 4: Query events (Postman) and Events explorer (Browser)

### 4.1 Query events via API (Postman)

| Step | Where | Call | Expected result |
|------|--------|------|-----------------|
| 4.1 | Postman | **GET** `http://localhost:3000/v1/events?limit=10`<br>**Headers:** `Authorization: Bearer {{apiKey}}` | **Status 200.** Body: `{ "data": [ { "id", "timestamp", "category", "action", ... } ], "nextCursor": "<string or null>" }`. Events from Part 3 appear. |
| 4.2 | Postman | **GET** `http://localhost:3000/v1/events?limit=5&category=e2e&action=test`<br>**Headers:** same | **Status 200.** `data` contains only events with category `e2e` and action `test`. |
| 4.3 | Postman | If `nextCursor` was non-null, **GET** `http://localhost:3000/v1/events?limit=5&cursor={{nextCursor}}`<br>**Headers:** same | **Status 200.** Next page of events. |

### 4.2 Events explorer (Browser)

| Step | Where | Action | Expected result |
|------|--------|--------|-----------------|
| 4.4 | Browser | In sidebar open **Events** (or Workspaces > Events). | Events explorer page loads. |
| 4.5 | Browser | Set filters: workspace (if shown), category `e2e`, action `test`. Click Apply. | List updates; events from Part 3 appear. |
| 4.6 | Browser | Click **Load more** if available. | More events load (cursor pagination). |
| 4.7 | Browser | Click an event row. | Detail drawer opens with full event JSON. |
| 4.8 | Browser | Click **Copy JSON**. | Event JSON copied to clipboard. |

---

## Part 5: Exports

### 5.1 Create export job (Postman)

| Step | Where | Call | Expected result |
|------|--------|------|-----------------|
| 5.1 | Postman | **POST** `http://localhost:3000/v1/exports`<br>**Headers:** `Authorization: Bearer {{apiKey}}`, `Content-Type: application/json`<br>**Body (raw JSON):** `{ "source": "HOT", "format": "JSONL" }` | **Status 201** and body e.g. `{ "jobId": "<uuid>", "status": "PENDING" }` (or **403** with `code: "PLAN_RESTRICTED"` if plan does not allow exports). Save `jobId` as `{{jobId}}`. |

### 5.2 Get export status (Postman)

| Step | Where | Call | Expected result |
|------|--------|------|-----------------|
| 5.2 | Postman | **GET** `http://localhost:3000/v1/exports/{{jobId}}`<br>**Headers:** `Authorization: Bearer {{apiKey}}` | **Status 200.** Body: `id`, `status` (PENDING | RUNNING | COMPLETED | FAILED), `source`, `format`, `rowsExported`, `createdAt`, `startedAt`, `finishedAt`, etc. Repeat until `status` is COMPLETED or FAILED. |

### 5.3 Download export (Postman)

| Step | Where | Call | Expected result |
|------|--------|------|-----------------|
| 5.3 | Postman | **GET** `http://localhost:3000/v1/exports/{{jobId}}/download`<br>**Headers:** `Authorization: Bearer {{apiKey}}` | **Status 200** and streamed body (NDJSON/CSV). Or **404**/ **403** if job not found or not ready. |

### 5.4 Exports page (Browser)

| Step | Where | Action | Expected result |
|------|--------|--------|-----------------|
| 5.4 | Browser | Open **Exports** in sidebar. | Exports page with list of export jobs. |
| 5.5 | Browser | Confirm the job from 5.1 appears with correct status. | Job listed with id, status, source, format, dates. |

---

## Part 6: Webhooks

**Note:** Creating a webhook requires a **company-scoped** API key and (in production) **IP allowlist** on that key. For local testing, if the API enforces IP allowlist, create a company key in the Dashboard (if the UI supports it) and add your IP (e.g. 127.0.0.1) to its allowlist. Otherwise skip or mock this part.

### 6.1 Create webhook (Postman)

| Step | Where | Call | Expected result |
|------|--------|------|-----------------|
| 6.1 | Postman | **POST** `http://localhost:3000/v1/workspaces/{{workspaceId}}/webhooks`<br>**Headers:** `Authorization: Bearer {{companyKey}}`, `Content-Type: application/json`<br>**Body (raw JSON):** `{ "url": "https://webhook.site/your-unique-id" }` (replace with your webhook.site URL or a local HTTPS endpoint). Replace `{{workspaceId}}` with the workspace ID from Part 1.6. | **Status 201.** Body: `id`, `url`, `status`, `events`, `projectId`, `secret` (shown once), `createdAt`. Save `id` as `{{webhookId}}`. If **403** "Only company keys can manage webhooks": use a company key. If **403** "IP allowlist": add your IP to the key allowlist. |

### 6.2 List webhooks (Browser)

| Step | Where | Action | Expected result |
|------|--------|--------|-----------------|
| 6.2 | Browser | Open **Webhooks** in sidebar. | Webhooks page lists endpoints. The webhook from 6.1 appears (URL, status). |

### 6.3 Trigger delivery (Postman)

| Step | Where | Call | Expected result |
|------|--------|------|-----------------|
| 6.3 | Postman | **POST** `http://localhost:3000/v1/events`<br>**Headers:** `Authorization: Bearer {{apiKey}}`, `Content-Type: application/json`<br>**Body:** `{ "category": "test", "action": "webhook" }` | **Status 201.** Event created; if webhook worker is running, delivery is queued. |

### 6.4 List deliveries (Postman)

| Step | Where | Call | Expected result |
|------|--------|------|-----------------|
| 6.4 | Postman | **GET** `http://localhost:3000/v1/webhooks/{{webhookId}}/deliveries?limit=10`<br>**Headers:** `Authorization: Bearer {{companyKey}}` | **Status 200.** Body: list of deliveries (e.g. `id`, `status`, `statusCode`, `createdAt`). Requires company key. |

---

## Part 7: Company settings and Help (Browser)

| Step | Where | Action | Expected result |
|------|--------|--------|-----------------|
| 7.1 | Browser | Go to **Settings > Company settings** (or equivalent). | Company settings page: name, slug, region. |
| 7.2 | Browser | Change company **name** and/or **slug**. Click Save. | Success message; data persisted. Reload page to confirm. |
| 7.3 | Browser | Confirm **region** and lock state (read-only) are shown. | No errors. |
| 7.4 | Browser | Open **Help** from sidebar. | Help page with links: API Reference, Docs, Status, Support email, API base URL. |
| 7.5 | Browser | Click **API Reference**. | API reference (e.g. Scalar) loads with OpenAPI spec from the API. |

---

## Part 8: Plan enforcement and rate limiting (Postman)

### 8.1 Plan limit exceeded

| Step | Where | Call | Expected result |
|------|--------|------|-----------------|
| 8.1 | Postman | Ensure the company is on Free (or a plan with a low monthly event limit) and usage for the current period is at or above that limit (or use a test plan with limit 1). Then **POST** `http://localhost:3000/v1/events` with `Authorization: Bearer {{apiKey}}`, body `{ "category": "e2e", "action": "limit-test" }`. | **Status 403.** Body includes `code: "PLAN_LIMIT_EXCEEDED"` (or equivalent). |

### 8.2 Trial expired

| Step | Where | Call | Expected result |
|------|--------|------|-----------------|
| 8.2 | Postman | In Dashboard DB set `subscriptions.trialEndsAt` to a past date for your company. Then **POST** `http://localhost:3000/v1/events` (same as 3.6). | **Status 403.** Body includes `code: "TRIAL_EXPIRED"`. |

### 8.3 Rate limit

| Step | Where | Call | Expected result |
|------|--------|------|-----------------|
| 8.3 | Postman | Send many **POST** `http://localhost:3000/v1/events` requests in a short time (e.g. 1100 in one minute if limit is 1000). Use same headers and a minimal body. | After exceeding the per-key limit: **Status 429** and rate limit headers/message. |

---

## Part 9: Stripe webhook local (optional)

| Step | Where | Action | Expected result |
|------|--------|--------|-----------------|
| 9.1 | Terminal | Run `stripe listen --forward-to localhost:4000/api/stripe/webhook`. Copy the printed webhook secret. | CLI forwards events to Dashboard. |
| 9.2 | Env | Set in Dashboard `.env`: `STRIPE_WEBHOOK_SECRET=<cli_secret>`. Restart Dashboard. | Signature verification uses CLI secret. |
| 9.3 | Terminal | Run `stripe trigger customer.subscription.updated`. | CLI shows event forwarded; Dashboard webhook returns 200. |
| 9.4 | DB | If the test payload has `metadata.dashboardCompanyId`, check Dashboard DB table `subscriptions` for that company. | Subscription row updated (status, period, etc.). |

---

## Postman quick reference

| Purpose | Method | URL | Headers | Body |
|---------|--------|-----|---------|------|
| Health | GET | `{{baseUrl}}/health` | (none) | (none) |
| Key status | GET | `{{baseUrl}}/v1/keys/status` | `Authorization: Bearer {{apiKey}}` | (none) |
| Ingest event | POST | `{{baseUrl}}/v1/events` | `Authorization: Bearer {{apiKey}}`, `Content-Type: application/json` | `{ "category": "e2e", "action": "test" }` |
| Query events | GET | `{{baseUrl}}/v1/events?limit=10` | `Authorization: Bearer {{apiKey}}` | (none) |
| Create export | POST | `{{baseUrl}}/v1/exports` | `Authorization: Bearer {{apiKey}}`, `Content-Type: application/json` | `{ "source": "HOT", "format": "JSONL" }` |
| Export status | GET | `{{baseUrl}}/v1/exports/{{jobId}}` | `Authorization: Bearer {{apiKey}}` | (none) |
| Download export | GET | `{{baseUrl}}/v1/exports/{{jobId}}/download` | `Authorization: Bearer {{apiKey}}` | (none) |
| Create webhook | POST | `{{baseUrl}}/v1/workspaces/{{workspaceId}}/webhooks` | `Authorization: Bearer {{companyKey}}`, `Content-Type: application/json` | `{ "url": "https://webhook.site/xxx" }` |
| List deliveries | GET | `{{baseUrl}}/v1/webhooks/{{webhookId}}/deliveries` | `Authorization: Bearer {{companyKey}}` | (none) |

**Expected status codes:** Health 200; key status 200; ingest 201 (or 200 idempotent); query events 200; create export 201 or 403; export status 200; download 200 or 404/403; create webhook 201 or 403; deliveries 200. Plan/trial/rate limit: 403 or 429 as above.

---

## Sign-off checklist

- [ ] Part 1: Account and onboarding (sign up, workspace visible, workspace ID noted).
- [ ] Part 2: Dashboard home and billing (plan, usage, Upgrade, Manage billing).
- [ ] Part 3: API key created in UI; health 200; key status 200; ingest 201 and 200 idempotent.
- [ ] Part 4: GET events 200; Events explorer filters, pagination, detail drawer, Copy JSON.
- [ ] Part 5: POST export 201; GET export status 200; GET download 200; Exports page shows job.
- [ ] Part 6: POST webhook 201 (if company key and IP allowlist OK); Webhooks page lists it; GET deliveries 200.
- [ ] Part 7: Company settings (edit name/slug); Help page and API Reference.
- [ ] Part 8: Plan limit 403; trial expired 403; rate limit 429.
- [ ] Part 9: Stripe CLI webhook forward and subscription sync (optional).

For more on Dashboard/API flows and provisioning, see [DASHBOARD_E2E_TEST_PLAN.md](./DASHBOARD_E2E_TEST_PLAN.md).

---

## Resetting all regions and setting everything back to zero

Follow these steps exactly to clear all users, companies, and data in both the Dashboard and all API region databases. After this, only reference data (plans, add-ons, regions, etc.) remains and you can run the E2E guide from Part 1 (sign up) with a clean slate.

### Prerequisites

- **Dashboard database:** Postgres running and reachable via `DATABASE_URL` in the Dashboard `.env`.
- **API region databases:** All four region Postgres instances running (e.g. Docker Compose on ports 54321, 54322, 54323, 54324 for US, EU, UK, AU). If you use different hosts/ports, ensure `.env` has the correct `DATABASE_URL_US`, `DATABASE_URL_EU`, `DATABASE_URL_UK`, `DATABASE_URL_AU`.
- **Migrations applied:** Run API migrations for all regions before reset (see Step 2 below). For the Dashboard, run all migrations so that tables like `usage_periods` (usage metering) and subscription fields exist; if you see "Skipping usagePeriod (table not present)" when running `db:reset`, apply Dashboard migrations first: from hyrelog-dashboard run `npx prisma migrate deploy` (or `npx prisma migrate dev`), then run `db:reset` again.

### Step 1: Reset the Dashboard database

1. Open a terminal and go to the **hyrelog-dashboard** directory (Dashboard repo root).
2. Ensure `DATABASE_URL` in `.env` points to your Dashboard Postgres.
3. Run:

   ```bash
   npm run db:reset
   ```

4. Expected output: messages that data is cleared, then reference data (continents, currencies, countries, regions, plans, add-ons) seeded. Ends with: `Reset complete. Database has no users or companies; reference data only.`
5. **Result:** Dashboard DB has no users, no companies, no workspaces, no API keys, no subscriptions. Only plans, add-ons, and geo reference data remain.

### Step 2: Ensure API migrations are applied to all regions

1. Go to the **hyrelog-api** directory (API repo root).
2. If you use the default Docker Compose setup (ports 54321–54324), run:

   ```bash
   npm run prisma:migrate:all
   ```

   If you use a different migration script or single DB, run your equivalent so every region DB has the latest schema.

3. **Result:** All region databases have the same schema and are ready for reset.

### Step 3: Reset all API region databases

Choose one of the following.

#### Option A: Reset all four regions in one go (recommended)

1. From the **hyrelog-api** directory (repo root), run:

   - **Windows (PowerShell):**
     ```bash
     npm run seed:reset:all
     ```
     This runs `scripts/reset-all-regions.ps1`, which sets `DATABASE_URL` for each region (US, EU, UK, AU) and runs the seed-reset script against each.

   - **Linux / macOS:**
     ```bash
     chmod +x scripts/reset-all-regions.sh
     ./scripts/reset-all-regions.sh
     ```
     Or set `DB_HOST`, `DB_USER`, `DB_PASS` if different from `localhost`, `hyrelog`, `hyrelog`.

2. If your DB host, user, or password are not the script defaults (`localhost`, `hyrelog`, `hyrelog`), pass them:

   ```powershell
   powershell -ExecutionPolicy Bypass -File ./scripts/reset-all-regions.ps1 -DbHost localhost -DbUser hyrelog -DbPass hyrelog
   ```

3. Expected output: for each region (US, EU, UK, AU), a line like `Resetting US region...`, then `Clearing existing data...`, `Creating standard plans...`, `Reset complete...`, then `Success: US reset`. Ends with: `All regions reset successfully. No companies or API keys remain; plans only.`
4. **Result:** Every region DB has no companies, no workspaces, no API keys, no events, no export jobs, no webhooks. Only the four standard plans (Free, Starter, Growth, Enterprise) exist in each.

#### Option B: Reset each API region manually

If you prefer to run the reset per region (e.g. different URLs in `.env`), from the **hyrelog-api** directory do the following for **each** region (US, EU, UK, AU).

1. Set `DATABASE_URL` to that region’s URL. Examples (PowerShell):

   ```powershell
   # US
   $env:DATABASE_URL = "postgresql://hyrelog:hyrelog@localhost:54321/hyrelog_us"
   npm run seed:reset

   # EU
   $env:DATABASE_URL = "postgresql://hyrelog:hyrelog@localhost:54322/hyrelog_eu"
   npm run seed:reset

   # UK
   $env:DATABASE_URL = "postgresql://hyrelog:hyrelog@localhost:54323/hyrelog_uk"
   npm run seed:reset

   # AU
   $env:DATABASE_URL = "postgresql://hyrelog:hyrelog@localhost:54324/hyrelog_au"
   npm run seed:reset
   ```

   On bash/zsh:

   ```bash
   DATABASE_URL="postgresql://hyrelog:hyrelog@localhost:54321/hyrelog_us" npm run seed:reset
   DATABASE_URL="postgresql://hyrelog:hyrelog@localhost:54322/hyrelog_eu" npm run seed:reset
   DATABASE_URL="postgresql://hyrelog:hyrelog@localhost:54323/hyrelog_uk" npm run seed:reset
   DATABASE_URL="postgresql://hyrelog:hyrelog@localhost:54324/hyrelog_au" npm run seed:reset
   ```

2. **Result:** Same as Option A: each region has only the four plans, no app data.

### Step 4: Verify

1. **Dashboard:** In Dashboard DB, confirm there are no rows in `users`, `companies`, `workspaces`, `sessions`, `subscriptions` (or that only reference data exists in `plans`, etc.).
2. **API:** In each region DB, confirm there are no rows in `companies`, `workspaces`, `api_keys`, `audit_events`, `export_jobs`, `webhook_endpoints`, and that `plans` has exactly four rows (Free, Starter, Growth, Enterprise).

### Step 5: Start apps and run E2E

1. Start the **API** (from hyrelog-api: `npm run dev`).
2. Start the **Dashboard** (from hyrelog-dashboard: `npm run dev`).
3. Open the E2E guide from **Part 1: Account and onboarding** and run through the flow (sign up, create key, ingest events, etc.).

### Summary of commands (all regions, default Docker setup)

| Step | Where | Command |
|------|--------|---------|
| 1. Dashboard reset | hyrelog-dashboard | `npm run db:reset` |
| 2. API migrations (if needed) | hyrelog-api | `npm run prisma:migrate:all` |
| 3. API reset all regions | hyrelog-api | Windows: `npm run seed:reset:all`. Linux/Mac: `./scripts/reset-all-regions.sh` |
| 4. Start API | hyrelog-api | `npm run dev` |
| 5. Start Dashboard | hyrelog-dashboard | `npm run dev` |

### Single-region or default-region only

If you only use one API database (e.g. default region), you can skip Step 3 Option A and run from **hyrelog-api**:

```bash
npm run seed:reset
```

This resets only the **default** region (from `DEFAULT_DATA_REGION` and `DATABASE_URL_US` / `DATABASE_URL_EU` / etc. in `.env`). All other steps (Dashboard reset, verify, start apps) stay the same.
