# HyreLog — environment variable matrix

> **Compliance mode:** This matrix assumes **strict regional compliance** for API data: `DATABASE_URL_US/EU/UK/AU` point to **separate regional DB deployments** (not a single host with four logical DB names).
>
> Primary runbook: [STEP_BY_STEP_AWS.md](./STEP_BY_STEP_AWS.md)

**Legend:** **Secret** = treat as a credential; use AWS Secrets Manager (or SSM SecureString) and inject into ECS. **Local** = safe for `.env` on a developer machine; never copy raw production values into source control.

Use **placeholders** like `https://app.hyrelog.com` for production public URLs. Do not commit real keys.

---

## Shared cross-service invariants (critical)

| Pairing | If wrong / missing |
|--------|---------------------|
| **Dashboard `DASHBOARD_SERVICE_TOKEN`** = **API `DASHBOARD_SERVICE_TOKEN`** (exact string) | **Dashboard** → API `/dashboard/*` returns **401**; provisioning, webhooks, company sync break |
| **Dashboard `HYRELOG_API_KEY_SECRET`** = **API `API_KEY_SECRET`** (exact string) | **API key hash sync** and `hlk_` key material diverge; keys invalid or not verifiable on API |
| **API `HYRELOG_DASHBOARD_URL` or `DASHBOARD_USAGE_URL`** = `https://app.hyrelog.com` (no trailing slash) | **Usage** metering / plan limits may not sync; or calls land on wrong host |

---

## Dashboard (`hyrelog-dashboard`)

| Variable | Service | Required | Secret? | Local example | Production example | Store in AWS | What breaks if wrong |
|----------|---------|----------|---------|---------------|--------------------|--------------|------------------------|
| `DATABASE_URL` | Next / Prisma | **Yes** | **Yes** (contains password) | `postgresql://user:pass@localhost:5432/hyrelog` | `postgresql://...rds...:5432/hyrelog?sslmode=require` | **Secrets Manager** → ECS task (or inject at build only if you accept drift — **prefer runtime for secrets only**) | App cannot start; auth Prisma calls fail |
| `BETTER_AUTH_URL` | Better Auth | **Yes** in prod | No (URL) | `http://localhost:4000` | `https://app.hyrelog.com` | Task env (non-secret) or secret if you embed in multi-secret JSON | **Wrong:** cookie/session, OAuth callbacks, open redirect issues |
| `BETTER_AUTH_SECRET` | Better Auth | **Yes** in prod | **Yes** | `dev-secret-change` | 32+ char random (see [Better Auth docs](https://www.better-auth.com/docs/)) | **Secrets Manager** | Sessions invalid; all users logged out / auth fails |
| `NEXT_PUBLIC_APP_URL` | Client / links | **Yes** | No | `http://localhost:4000` | `https://app.hyrelog.com` | **Build** + **Runtime** (Next public; often baked at build time in CI) | Links, CORS, auth redirects, emails wrong |
| `HYRELOG_API_URL` | Server → API base | **Yes** (dashboard features) | No | `http://127.0.0.1:3000` | `https://api.hyrelog.com` | **Task env** (server-side) | `hyrelogRequest` to API fails; provisioning, sync, webhooks 404/ECONNREFUSED |
| `NEXT_PUBLIC_API_BASE_URL` | Public docs / help | No (has defaults) | No | (omit) | `https://api.hyrelog.com` | **Build** arg / env | Help page and embedded docs show wrong API host |
| `DASHBOARD_SERVICE_TOKEN` | `lib/hyrelog-api/client` | **Yes** (when using API) | **Yes** | `dev-dashboard-token-64-hex` | same as API | **Secrets Manager** | Header `x-dashboard-token` wrong → **all** dashboard API calls fail |
| `HYRELOG_API_KEY_SECRET` | API key sync | **Yes** to sync keys | **Yes** | (must match API) | same as `API_KEY_SECRET` on API | **Secrets Manager** | New keys not accepted on API; hash mismatch |
| `RESEND_API_KEY` | Email | If email on | **Yes** | (test key) | Resend key | **Secrets Manager** | Email verification / invites do not send |
| `MAIL_FROM` | Email | If email on | No | - | `HyreLog <no-reply@hyrelog.com>` | **Task env** or secret | Bounces / “from” misconfigured |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Billing | If billing on | **Yes** | (test) | (live) | **Secrets Manager** | Billing, webhooks, upgrades fail |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_REGION` | `lib/storage/s3` | If attachments on | **Yes** (keys) | local MinIO | real bucket + role or keys | **Secrets Manager** + **task role** (preferred for AWS) | Uploads to dashboard storage break |

**TODO:** confirm **all** Better Auth v1+ required envs for your exact version when you go live; see upstream docs and `lib/auth.ts` for plugins.

**Dashboard build note:** `npm run build` runs Prisma; ensure **build** has a valid `DATABASE_URL` or a placeholder **if** your Prisma `generate` does not need live DB (common: placeholder URL is enough for `prisma generate` only).

---

## API (`hyrelog-api/services/api` — `loadConfig` + ad-hoc `process.env`)

| Variable | Required | Secret? | Local example | Production | Store in AWS | If wrong / missing |
|----------|----------|---------|---------------|------------|--------------|----------------------|
| `PORT` | No (default 3000) | No | `3000` | `3000` or set by ALB | **Task** | Wrong port in task vs target group |
| `NODE_ENV` | **Yes** | No | `development` | `production` | **Task** | Verbose errors, stricter CORS, behavior differences |
| `LOG_LEVEL` | No | No | `info` | `info` | **Task** | Too noisy or too quiet |
| `INTERNAL_TOKEN` | **Yes** | **Yes** | `dev-internal` | long random | **Secrets Manager** | **Cannot** use `/internal/*` metrics, internal ops |
| `API_KEY_SECRET` | **Yes** | **Yes** | dev string | 32+ byte secret | **Secrets Manager** | API key HMAC/verification **broken** (security incident if leaked) |
| `DASHBOARD_SERVICE_TOKEN` | **Yes** for `/dashboard` | **Yes** | (match dashboard) | same as dashboard | **Secrets Manager** | **Entire** dashboard integration off or 401 on `/dashboard` |
| `HYRELOG_DASHBOARD_URL` *or* `DASHBOARD_USAGE_URL` | **Yes** (usage) | No (URL) | `http://localhost:4000` | `https://app.hyrelog.com` | **Task** (single URL) | **Usage** callbacks fail; plan limits inaccurate |
| `DATABASE_URL_US` … `DATABASE_URL_AU` | **Yes** (4) | **Yes** | `localhost:5432x` | Regional RDS | **4 secrets** or one JSON | Wrong region = data in wrong place / connection refused |
| `DEFAULT_DATA_REGION` | No | No | `US` | `US` | **Task** | Default routing for new data if used |
| `S3_ENDPOINT` | **Local only** | No | `http://localhost:9000` | **(omit for AWS S3)** | - | If set in prod, SDK may try Minio-style endpoint and **fail** |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | **Required by current Zod schema** | **Yes** | minio | IAM user or placeholder | **Secrets Manager** (or TODO: code change for IAM-only) | S3 access fails; **archival, exports, attachments** break |
| `S3_REGION` | **Yes** in practice | No | `us-east-1` | bucket region | **Task** | Wrong signing / latency |
| `S3_FORCE_PATH_STYLE` | No | No | `true` (Minio) | `false` | **Task** | Must be **false** for normal AWS S3 |
| `S3_BUCKET_US` … `S3_BUCKET_AU` | **Yes** (4) | No (names) | `hyrelog-archive-us` | per-region unique names | **Task** or secret | **Wrong bucket** = data leak risk or 403 |
| `COLD_ARCHIVE_AFTER_DAYS` / `RATE_LIMIT_*` | No | No | defaults | tune | **Task** | Operational tuning |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | **Yes** (webhooks) | **Yes** (64 hex) | generate locally | same for API+worker for consistency | **Secrets Manager** | **Webhook** create/verify and worker delivery **throw** or fail |

---

## Worker (`hyrelog-api/services/worker` — `loadConfig` + encryption)

| Variable | Required | Secret? | Notes |
|----------|----------|---------|--------|
| `DATABASE_URL_US` … `DATABASE_URL_AU` | **Yes** | **Yes** | Same four URLs as API |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_REGION` / `S3_FORCE_PATH_STYLE` / buckets (4) | As API | mixed | Archival, restore, verification jobs |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | **Yes** (webhook jobs) | **Yes** | **Must** match API for decrypt/sign consistency |
| `LOG_LEVEL` / `NODE_ENV` / `DEFAULT_DATA_REGION` | No | - | Tuning |
| `WORKER_POLL_INTERVAL_SECONDS` | No | - | Polling / CPU tradeoff |

**Worker does not** use `API_KEY_SECRET`, `INTERNAL_TOKEN`, or dashboard URL **in the shared `config` schema** — it still **needs** the same S3/DB/encryption material as the API for background work.

---

## Not in a central schema but in code (grep)

- **`BYPASS_ARCHIVE_RETENTION`** (API exports, dev) — do **not** set in production.
- **Dashboard `APP_URL`** (email) — set to public app URL in prod or rely on `NEXT_PUBLIC_APP_URL`.

---

## “Where to store in AWS” quick reference

| Type | Service |
|------|---------|
| Database URLs, API keys, tokens, webhook AES key, Stripe | **Secrets Manager** (one secret per value or a JSON object with `keys`) |
| Public URLs, bucket **names** (if not secret), `NODE_ENV`, `LOG_LEVEL`, `PORT` | **ECS task definition** `environment` (plain) |
| IAM to S3 without static keys (future) | **ECS task role**; update app code to allow optional static keys (TODO in codebase) |

When in doubt, **store credentials in Secrets Manager** and reference them in the task definition `secrets` array so they never appear in the console as plain `environment` fields.
