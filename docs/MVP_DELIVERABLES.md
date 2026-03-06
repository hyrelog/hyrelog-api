# HyreLog MVP Deliverables Summary

## New routes and endpoints

### Dashboard (Next.js)

| Method | Route | Description |
|--------|--------|-------------|
| GET | `/billing/subscription` | Billing page: plan, usage, upgrade/manage CTAs |
| GET | `/settings/company` | Company settings: name, slug, region, danger zone |
| GET | `/help` | Help: docs, status, support, API base URL |
| GET | `/events` | Events explorer: filters, pagination, detail drawer, copy JSON |
| GET | `/exports` | Exports: list export jobs from API |
| GET | `/webhooks` | Webhooks: list webhook endpoints from API |
| POST | `/api/internal/usage` | Internal: increment usage (API service calls with token) |
| GET | `/api/internal/usage` | Internal: get usage for company by apiCompanyId |
| POST | `/api/stripe/webhook` | Stripe webhook: subscription created/updated/deleted |

### API (Fastify)

| Method | Route | Description |
|--------|--------|-------------|
| GET | `/dashboard/exports` | List export jobs for company (dashboard auth) |

Existing dashboard API routes unchanged: GET /dashboard/events, GET /dashboard/exports/:jobId, GET /dashboard/webhooks, etc.

---

## New environment variables

### Dashboard (.env)

| Variable | Required | Description |
|----------|----------|-------------|
| `STRIPE_SECRET_KEY` | For billing | Stripe secret key (sk_test_ or sk_live_) |
| `STRIPE_WEBHOOK_SECRET` | For webhooks | Stripe webhook signing secret (whsec_...) |
| `NEXT_PUBLIC_APP_URL` | Optional | Origin for Stripe redirects (default from headers) |
| `NEXT_PUBLIC_DOCS_URL` | Optional | Docs link on Help page |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Optional | Support email on Help page |
| `NEXT_PUBLIC_STATUS_URL` | Optional | Status page link on Help page |
| `DASHBOARD_SERVICE_TOKEN` | For API + usage API | Same as API; used for internal usage endpoint auth |

### API (.env)

| Variable | Required | Description |
|----------|----------|-------------|
| `HYRELOG_DASHBOARD_URL` or `DASHBOARD_USAGE_URL` | For usage sync | Dashboard base URL (e.g. http://localhost:4000) for usage GET/POST |
| `RATE_LIMIT_EVENTS_PER_MIN` | Optional | Per-key limit for POST /v1/events (default 1000) |

---

## Migrations

### Dashboard (Prisma)

- **Migration**: `20260126000000_add_stripe_and_usage_period`
  - `subscriptions`: add `currentPeriodStart`, `stripePriceId`
  - New table `usage_periods`: companyId, periodStart, periodEnd, eventsIngested, exportsCreated, webhooksActive

Run: `cd hyrelog-dashboard && npx prisma migrate deploy` (or `prisma migrate dev` with DB up).

### API

- No new migrations. Plan limits (monthlyEventLimit, monthlyExportLimit) are in code (lib/plans.ts).

---

## Manual QA steps

1. **Billing**
   - Sign in, go to Billing > Subscription. See plan, usage, next billing date.
   - If Stripe configured: click Upgrade (plan with price), complete Checkout; return and see updated plan.
   - Click "Manage billing" and open Stripe Customer Portal.

2. **Usage**
   - Ingest events via POST /v1/events (workspace key). Refresh Dashboard home and Billing; usage "Events" should increase.

3. **Plan enforcement**
   - Set company to FREE and usage at or above monthly event limit (or use a test plan with low limit). POST /v1/events should return 403 PLAN_LIMIT_EXCEEDED.
   - Trial ended: set subscription trialEndsAt in the past; POST /v1/events should return 403 TRIAL_EXPIRED.

4. **Company settings**
   - Go to Settings > Company Settings. Change name and slug (as OWNER/ADMIN), save. Confirm persisted.

5. **Help**
   - Go to Help. Check links: API Reference, Docs, Status, Support email and API base URL.

6. **Events explorer**
   - Go to Events. Apply filters (workspace, category, date). Load more. Open an event, click Copy JSON.

7. **Exports**
   - Go to Exports. Create an export via API (POST /v1/exports with workspace key). List should show the job.

8. **Webhooks**
   - Go to Webhooks. Create a webhook via API (company key). List should show the endpoint.

9. **Rate limit**
   - Send many POST /v1/events in a short time (e.g. 1100 in 1 min). Expect 429 RATE_LIMITED after limit.

10. **Stripe webhook (local)**
    - Run `stripe listen --forward-to localhost:4000/api/stripe/webhook`. Use printed secret in Dashboard .env. Trigger subscription.updated; check Subscription row updated.

---

## How to run locally

1. **Database**
   - Start Postgres (e.g. Docker). Set DATABASE_URL (Dashboard) and per-region URLs (API).

2. **Dashboard**
   - `cd hyrelog-dashboard && npm i && npx prisma generate && npx prisma migrate deploy`
   - Set .env: DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (optional for billing), DASHBOARD_SERVICE_TOKEN, HYRELOG_API_URL.
   - `npm run dev` (port 4000).

3. **API**
   - `cd hyrelog-api/services/api && npm i && npx prisma generate`
   - Set .env: DATABASE_URL_*, DASHBOARD_SERVICE_TOKEN, API_KEY_SECRET, HYRELOG_DASHBOARD_URL (or DASHBOARD_USAGE_URL) = http://localhost:4000.
   - `npm run dev` (port 3000).

4. **Stripe (optional)**
   - Stripe CLI: `stripe listen --forward-to localhost:4000/api/stripe/webhook`. Use the printed webhook secret in Dashboard .env.

---

## Production deployment

### Vercel (Dashboard)

- Set env vars: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, DASHBOARD_SERVICE_TOKEN, HYRELOG_API_URL, NEXT_PUBLIC_APP_URL (e.g. https://app.hyrelog.com).
- In Stripe Dashboard, add production webhook endpoint: https://app.hyrelog.com/api/stripe/webhook.

### API host

- Set HYRELOG_DASHBOARD_URL (or DASHBOARD_USAGE_URL) to the production dashboard URL so usage callbacks succeed.
- Set RATE_LIMIT_EVENTS_PER_MIN if you want a different ingest limit.
