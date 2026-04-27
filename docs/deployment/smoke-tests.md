# HyreLog — production smoke tests

> **Compliance mode:** Execute these checks against the strict regional setup from [STEP_BY_STEP_AWS.md](./STEP_BY_STEP_AWS.md), and ensure region-specific writes are validated against the matching regional database.

Run these **after** a production deployment (or in staging with production-shaped URLs and credentials). **Never** log secrets, API keys, or session tokens in CI output.

**Prerequisites**

- `curl` and `jq` (optional) installed
- A **company API key** and **user session** for dashboard tests (or use dedicated test accounts in a non-prod environment first)
- `HYRELOG_API_URL` = `https://api.hyrelog.com` (or staging)
- `DASHBOARD_URL` = `https://app.hyrelog.com`
- `DASHBOARD_SERVICE_TOKEN` for `/dashboard` route tests (header `x-dashboard-token`) — use from Secrets Manager, not in shell history in shared systems

---

## 1. Dashboard loads (TLS + HTML/JS)

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://app.hyrelog.com/
```

**Expected:** `200` (or `302` to login, which is acceptable if unauthenticated). **Not** `5xx` or connection errors.

**Manual:** open `https://app.hyrelog.com` in a browser, verify no certificate warnings (ACM) and that the app shell renders.

---

## 2. Public API health

```bash
curl -sS https://api.hyrelog.com/health
```

**Expected:** JSON like `{"ok":true}`. (See `services/api/src/plugins/openapi.ts`.)

**Alternate:** `curl -sS https://api.hyrelog.com/` returns service metadata (root route).

---

## 3. Dashboard → API (`/dashboard/*`, service token)

**Replace** `TOKEN` and use a real dashboard-authorized user context is **not** required for a minimal check — the API validates `x-dashboard-token` only. Example **list** route if present:

```bash
export DASHBOARD_SERVICE_TOKEN="(from secrets)"
curl -sS -H "x-dashboard-token: $DASHBOARD_SERVICE_TOKEN" \
  "https://api.hyrelog.com/dashboard/company" 
```

> **Note:** The exact `GET` path may vary by your released API. Confirm against OpenAPI or `services/api/src/routes/dashboard/`. A **200** (or **404** for missing id) is fine; **401** means the token is wrong; **5xx** is bad.

**Better:** from the **browser** while logged in, open **Network** and confirm a server action to `getCompany` or webhooks does **not** return 500.

---

## 4. Onboarding creates company + workspace (dashboard flow)

- **Manual:** create a new test user, complete onboarding, verify **one** company and at least **one** workspace in the DB (dashboard DB) and that **provisioning** calls succeed (no persistent error toasts).  
- **Data check:** in dashboard Prisma/DB, `Company` and `Workspace` rows exist; `apiWorkspaceId` populated when provisioned to API.

---

## 5. API key creation and sync

- In dashboard, create a **workspace API key** (or company key per product flow).
- **Expect:** key is shown **once**; in API DB, a row exists in the appropriate region’s store for the workspace’s `dataRegion` (inspect via internal tooling or a controlled `GET` if your API exposes it).

**Quick negative test:** a deliberately wrong HMAC/secret in staging should be rejected (proves `API_KEY_SECRET` alignment is meaningful).

---

## 6. `POST /v1/events` (ingestion)

**Replace** with a real key and workspace id from your test data:

```bash
export API_KEY="hlk_...."
export WORKSPACE_ID="uuid"

curl -sS -X POST "https://api.hyrelog.com/v1/workspaces/${WORKSPACE_ID}/events" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"user.login","category":"auth","source":"smoke","metadata":{}}'
```

**Expected:** `2xx` with an event or batch accept payload per your current API. **If 401** — key scope, IP allowlist, or key hash mismatch.

---

## 7. Event lands in the **correct** regional database

- Confirm the company/workspace **data region** in dashboard matches the DB you check.
- In the **correct** `DATABASE_URL_XX` database, query `AuditEvent` (or the relevant table) for the **event id** or recent rows from the smoke test.  
- **Cross-check:** the event must **not** only appear in the wrong region (would indicate a routing bug in `regionRouter`).

---

## 8. Usage callback to dashboard (plan metering)

- Perform an action that increments usage (e.g. event ingest or export per your product).
- In dashboard DB, check **UsagePeriod** / entitlements (or the table your `app/api/internal/usage` route updates).
- In **CloudWatch** logs (dashboard + API), search for **errors** from usage HTTP calls.  
- **If broken:** `HYRELOG_DASHBOARD_URL` / `DASHBOARD_USAGE_URL` or `DASHBOARD_SERVICE_TOKEN` mismatch; see [env-matrix.md](./env-matrix.md).

---

## 9. Worker — healthy operation (logs)

- **ECS** → **worker** service → **Tasks** → **Logs** (CloudWatch log group in task definition).  
- **Look for:** recurring errors from `webhookWorker`, `archivalJob`, or Prisma `P1001` (connection) — no sustained crash loops.  
- **Optional:** if you can safely trigger a **webhook** delivery, confirm a **WebhookJob** is processed in the right region (see [WEBHOOK_E2E_TEST_GUIDE.md](../WEBHOOK_E2E_TEST_GUIDE.md) for local flow; production requires real endpoints).

---

## 10. S3 / export / cold archive (if used)

- Run a **retention-allowed** test export in staging first; in production, use a **dedicated** test workspace.
- If your product **uploads to S3** from the API (export archive, cold storage), verify:
  - An object **prefix** exists in the **mapped regional bucket** (`S3_BUCKET_US` / …).
  - **No 403** in API logs (IAM or keys).

**Dev-only:** `BYPASS_ARCHIVE_RETENTION` must be **absent** in production.

---

## Sign-off checklist (operator)

- [ ] `GET /health` and dashboard load
- [ ] `x-dashboard-token` call succeeds
- [ ] Ingestion + read path in the expected region
- [ ] No critical errors in the last 15 minutes of **API, worker, dashboard** logs
- [ ] Alarm **silence** (if you used a maintenance window) re-enabled

For rollback steps, see [aws-production-guide.md §16](./aws-production-guide.md).
