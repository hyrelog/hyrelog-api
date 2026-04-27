# Deployment readiness — AWS ECS Fargate (API + Dashboard)

This report reflects the repositories as they exist today (`hyrelog-api`, `hyrelog-dashboard`). It is intended for operators wiring **ECS task definitions**, **CI build pipelines**, and **production configuration**.

---

## Executive summary

| Area | Status | Notes |
|------|--------|--------|
| **Container images** | **Gap** | No `Dockerfile` in either repo; you must add images (or use buildpacks) before Fargate is viable. |
| **API runtime** | **Ready (with env)** | `node dist/server.js`, listens on `0.0.0.0`; health without auth at `GET /`. |
| **Dashboard runtime** | **Ready (with env)** | `next build` / `next start`; **build-time env** for `DATABASE_URL` is a common footgun (see below). |
| **Prisma — API** | **Multi-DB** | Four regional Postgres URLs; `prisma migrate deploy` must run **once per region** against the **same migration history**. |
| **Prisma — Dashboard** | **Single-DB** | One `DATABASE_URL`; `prisma migrate deploy` from repo root. |
| **IaC in repo** | **Partial** | `hyrelog-api/infra` defines VPC, ECS **cluster**, ECR repos (API/worker), RDS, S3, log groups — **no Fargate service, task definition, ALB, or dashboard ECR**. |
| **Worker** | **Separate workload** | Same env shape as API for DB/S3; `npm run build --workspace=services/worker` + `node dist/index.js`. Not optional if you rely on webhooks/archival/restore jobs. |

---

## 1. HyreLog API (`hyrelog-api`)

### 1.1 Build commands (local / CI)

From repository root (`hyrelog-api/`):

```bash
npm ci
npm run prisma:generate --workspace=services/api
npm run build --workspace=services/api
```

- **`prisma generate`** uses `services/api/prisma.config.ts`, which loads **`hyrelog-api/.env`** from the **monorepo root** for datasource URL resolution (`DATABASE_URL` or `DATABASE_URL_US`).
- **`build`** runs `tsc` in `services/api` and emits **`services/api/dist/`**.

### 1.2 Run commands (production-shaped)

From `services/api` (or set cwd so relative paths resolve):

```bash
node dist/server.js
```

Root `package.json` exposes:

```bash
npm run start --workspace=services/api   # → node dist/server.js
```

### 1.3 ECS / ALB probes

- **Unauthenticated “up” check**: `GET /` → JSON `{ service, version, status }`.
- **`/internal/health`** is under **`/internal`** and requires header **`x-internal-token: <INTERNAL_TOKEN>`** (see `internalAuth` plugin). **Do not** point the ALB health check at `/internal/*` unless you inject that header (prefer **`GET /`**).

### 1.4 Environment variables (required vs operational)

Loaded via `dotenv` from **`hyrelog-api/.env` at repo root** in development; on ECS you should rely on **task env** or **Secrets Manager injection** (file may be absent).

**Required by `services/api/src/lib/config.ts` (Zod):**

| Variable | Purpose |
|----------|---------|
| `INTERNAL_TOKEN` | Auth for `/internal/*` routes |
| `DATABASE_URL_US`, `DATABASE_URL_EU`, `DATABASE_URL_UK`, `DATABASE_URL_AU` | Regional tenant DBs |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3 credentials (prefer **ECS task IAM role** + SDK default chain — keys still satisfy schema today) |
| `S3_BUCKET_US`, `S3_BUCKET_EU`, `S3_BUCKET_UK`, `S3_BUCKET_AU` | Regional archive buckets |
| `API_KEY_SECRET` | API key hashing |

**Strongly required for real product behavior:**

| Variable | Purpose |
|----------|---------|
| `DASHBOARD_SERVICE_TOKEN` | Enables `/dashboard/*`; must match dashboard |
| `HYRELOG_DASHBOARD_URL` **or** `DASHBOARD_USAGE_URL` | Base URL for dashboard **usage callback** (`/api/internal/usage`) |

If `DASHBOARD_SERVICE_TOKEN` is unset, `dashboardAuth` **does not register hooks** → dashboard routes effectively broken (`dashboardAuth` exits early).

**Optional / defaults:**

| Variable | Notes |
|----------|--------|
| `PORT` | Default **3000** |
| `NODE_ENV` | Use `production` |
| `LOG_LEVEL` | Pino level |
| `DEFAULT_DATA_REGION` | `US` \| `EU` \| `UK` \| `AU` |
| `S3_ENDPOINT` | **Local-only** MinIO; **omit** for real AWS S3 |
| `S3_REGION` | Default `us-east-1` |
| `S3_FORCE_PATH_STYLE` | `true` for MinIO; **typically `false` on AWS** |
| `COLD_ARCHIVE_AFTER_DAYS`, `RATE_LIMIT_*` | Tunables |

**Production S3:**

- Remove **`S3_ENDPOINT`** (MinIO).
- Prefer **IAM task role** for S3 over long-lived keys; the code path still expects `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` in config — verify whether you keep minimal placeholder values with role-based credentials or extend config to allow omitting keys when using instance/task role only (today: **schema requires keys**).

### 1.5 Prisma migrations (API — four databases)

Migration commands live in **`services/api`**:

```bash
cd services/api
npx prisma migrate deploy
```

Run **four times**, each time with **`DATABASE_URL`** pointing at the correct regional DB (same migrations folder). Example pattern:

```bash
DATABASE_URL="$DATABASE_URL_US" npx prisma migrate deploy
DATABASE_URL="$DATABASE_URL_EU" npx prisma migrate deploy
DATABASE_URL="$DATABASE_URL_UK" npx prisma migrate deploy
DATABASE_URL="$DATABASE_URL_AU" npx prisma migrate deploy
```

Repo helper **`npm run prisma:migrate:all`** is **PowerShell + localhost ports** — **not portable** to Linux CI as-is; replicate the loop in bash or run four explicit deploys.

### 1.6 Docker / platform notes

- **No Dockerfile**: define multi-stage build (install → `prisma generate` → `tsc` → runtime with `node dist/server.js`).
- **Working directory**: preserve layout so `services/api/dist/server.js` and **`services/api/prisma`** (migrations) exist in the image if you run migrations from the container.
- **`.env` path**: config resolves repo-root `.env`; task env vars should satisfy runtime without that file.

### 1.7 What breaks in production (API)

1. **Missing any regional `DATABASE_URL_*`** → config throws at startup.
2. **`DASHBOARD_SERVICE_TOKEN` unset** → `/dashboard/*` unusable (provisioning, keys, etc.).
3. **`HYRELOG_DASHBOARD_URL` / `DASHBOARD_USAGE_URL` unset** → usage sync skipped; dashboard usage stays flat even when events ingest.
4. **Security groups**: API task must **egress HTTPS** to the **dashboard URL** for usage callbacks.
5. **MinIO-style env in prod** (`S3_ENDPOINT`, path-style, public MinIO creds) → wrong SDK behavior or auth failures.
6. **ALB health check** hitting `/internal/health` **without** `x-internal-token` → **401**.

---

## 2. HyreLog Dashboard (`hyrelog-dashboard`)

### 2.1 Build commands

```bash
npm ci
npm run build
```

Which expands to:

```bash
npx prisma generate && next build
```

### 2.2 Run commands

```bash
npm run start
# i.e. next start — honors PORT (default 3000); local dev uses `next dev -p 4000`
```

Set **`PORT`** in the ECS task to match the container port (e.g. **3000**).

### 2.3 Environment variables

**Hard requirement at runtime (module load):**

`lib/prisma.ts` throws if **`DATABASE_URL`** is missing when the module is first evaluated — this affects **SSR/build** wherever Prisma is imported.

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | **Yes** | Dashboard Postgres (single DB) |

**Integration with API (core product paths):**

| Variable | Purpose |
|----------|---------|
| `HYRELOG_API_URL` | Server-side calls to Fastify API |
| `DASHBOARD_SERVICE_TOKEN` | `x-dashboard-token` for `/dashboard/*` and internal routes |
| `HYRELOG_API_KEY_SECRET` | Must equal API **`API_KEY_SECRET`** for synced API keys (`hlk_…`) |

**Usage callback (API → Dashboard):**

The API calls:

- `GET /api/internal/usage?apiCompanyId=…`
- `POST /api/internal/usage`

Authenticated with **`x-dashboard-token`** (= `DASHBOARD_SERVICE_TOKEN`). Ensure load balancers **do not strip** this header on internal routes.

**Public / app URLs:**

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_APP_URL` | Better Auth client `baseURL`, invite links |
| `NEXT_PUBLIC_API_BASE_URL` | Scalar `/reference`, help links (optional; has URL defaults in code) |

**Email (optional until you enable flows):**

| Variable | Purpose |
|----------|---------|
| `RESEND_API_KEY` | Resend |
| `MAIL_FROM`, `APP_URL` | Mail helper fallbacks |

**Billing (optional):**

| Variable | Purpose |
|----------|---------|
| `STRIPE_SECRET_KEY` | Billing actions |
| `STRIPE_WEBHOOK_SECRET` | `app/api/stripe/webhook` |

**Object storage (avatars):** `lib/storage/s3.ts` expects **`S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`**, optional `S3_ENDPOINT`, `S3_REGION`, `S3_PUBLIC_BASE_URL`. If unset, uploads may no-op (`getS3Client()` null). On AWS, **pre-create bucket** and restrict app from `CreateBucket` in prod if possible.

**Better Auth:** The repo does not document a `BETTER_AUTH_*` block in code you own; follow **Better Auth**’s standard env expectations for production (secret / URL / trusted origins). Ensure **`NEXT_PUBLIC_APP_URL`** matches the **browser-facing HTTPS** origin.

### 2.4 Prisma migrations (Dashboard)

From `hyrelog-dashboard/`:

```bash
npx prisma migrate deploy
```

(`prisma.config.ts` reads `DATABASE_URL`.)

### 2.5 Docker / platform notes

- **No Dockerfile** — same gap as API.
- **Build-time `DATABASE_URL`**: Next may import `@/lib/prisma` during `next build`. CI often needs a **non-empty** `DATABASE_URL` (e.g. **invalid host is OK** if no DB calls run at build time — confirm for your pipeline). This is a **top ECS/CodeBuild failure mode**.

### 2.6 What breaks in production (Dashboard)

1. **`DATABASE_URL` missing** at build or runtime → startup/build failure.
2. **`HYRELOG_API_URL` / `DASHBOARD_SERVICE_TOKEN` missing** → server actions that call the API fail (toasts/errors).
3. **`HYRELOG_API_KEY_SECRET` ≠ API `API_KEY_SECRET`** → key sync / prefix issues.
4. **`NEXT_PUBLIC_APP_URL` wrong** → broken auth redirects, invite links, cookies.
5. **Stripe keys missing** → billing UI/actions fail where `stripeConfigured` is false or throws.
6. **S3 misconfiguration** → avatar uploads silently fail when `getS3Client()` returns null.

---

## 3. Worker (`hyrelog-api/services/worker`) — same cluster, separate task

Not strictly “API” or “dashboard”, but **required** for background behavior (webhooks, retention, archival, restore automation).

**Build / run:**

```bash
npm run prisma:generate --workspace=services/api   # worker uses generated client / DB access patterns from shared prisma schema
npm run build --workspace=services/worker
npm run start --workspace=services/worker          # node dist/index.js
```

**Config:** `services/worker/src/lib/config.ts` — same **`DATABASE_URL_*`**, **`S3_*`** shape as API (no `INTERNAL_TOKEN` / dashboard token). Loads **`hyrelog-api/.env` at repo root**.

**Operational pattern on ECS:** long-running **worker service** or **EventBridge-triggered tasks** per job CLI (worker reads job name from argv).

---

## 4. Repo IaC vs what you still need for Fargate

`infra/lib/hyrelog-stack.ts` provisions **network**, **RDS**, **S3**, **ECR** (API/worker), **ECS cluster**, **CloudWatch log groups**. It does **not** define:

- ECS **task definitions** / **services**
- **Application Load Balancer** / target groups
- **Dashboard** image repository or service
- **Secrets Manager** wiring for tokens

Treat CDK output as **partial** scaffolding; **Fargate services must be added** (or another IaC layer).

---

## 5. Cross-service checklist (minimum for a working prod loop)

1. **Dashboard URL** reachable from API tasks → **`HYRELOG_DASHBOARD_URL`** / **`DASHBOARD_USAGE_URL`**.
2. **`DASHBOARD_SERVICE_TOKEN`** identical on API and dashboard.
3. **`API_KEY_SECRET`** (API) = **`HYRELOG_API_KEY_SECRET`** (dashboard).
4. **Four API regional DBs** migrated + **one dashboard DB** migrated.
5. **Worker** deployed if you rely on async processing beyond synchronous API paths.

---

## 6. Local-only configuration to strip before production

| Setting | Repo context |
|---------|----------------|
| `S3_ENDPOINT=http://localhost:9000` | MinIO |
| `S3_FORCE_PATH_STYLE=true` | MinIO |
| MinIO credentials | Non-AWS |
| `DATABASE_URL_*` pointing at `localhost:5432x` | Docker Compose |
| Dev-only tokens in `.env.example` | Rotate for prod |

---

*Generated from repository inspection; adjust if you introduce Dockerfiles or change config schemas.*

---

**See also (expanded CI/CD and AWS runbooks):** [docs/deployment/aws-production-guide.md](deployment/aws-production-guide.md), [docs/deployment/env-matrix.md](deployment/env-matrix.md), [docs/deployment/INSPECTION_REPORT.md](deployment/INSPECTION_REPORT.md).
