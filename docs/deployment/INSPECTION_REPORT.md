# HyreLog — Phase 1 deployment inspection report

> **Compliance note:** This report captures repository structure and runtime requirements. For execution, use the strict regional-compliance launch runbook: [STEP_BY_STEP_AWS.md](./STEP_BY_STEP_AWS.md).

This report was generated from the **hyrelog-api** and **hyrelog-dashboard** repositories in this workspace. It is the **pre-implementation** baseline referenced by `docs/deployment/aws-production-guide.md`.

---

## 1. Deployable services

| Service | Location | Type |
|---------|----------|------|
| **API** | `hyrelog-api/services/api` | Fastify (TypeScript → `tsc` → `node dist/server.js`) |
| **Worker** | `hyrelog-api/services/worker` | Node worker (`tsc` → `node dist/index.js`), long-running loop + webhooks |
| **Dashboard** | `hyrelog-dashboard/` (sibling repo) | Next.js 16 (`next build` / `next start` or **standalone** output) |

**Note:** The API and worker live in a **single Git repo** (`hyrelog-api`); the dashboard is a **separate repo**. CI/CD and ECR/ECS are described per repo, with a unified operations guide in `aws-production-guide.md`.

---

## 2. Install, build, and start commands (verified from `package.json`)

### API (`hyrelog-api` root)

- **Install:** `npm ci` (Node `>= 20` per root `engines`)
- **Prisma client:** `npm run prisma:generate --workspace=services/api` (or `npx prisma generate` in `services/api`)
- **Build:** `npm run build --workspace=services/api` → compiles to `services/api/dist/`
- **Start (production):** `npm run start --workspace=services/api` → `node dist/server.js` (cwd must allow relative imports; run from `services/api` or ensure paths match — **recommended:** `node services/api/dist/server.js` with `process.cwd()` at repo root, or set `WORKDIR` in Docker to `services/api` and `node dist/server.js`)

**Resolved:** The API entrypoint is `services/api/dist/server.js` when the working directory is `services/api` (as in `package.json` `"start": "node dist/server.js"`).

### Worker

- **Install / generate:** same root `npm ci`; **must** run `prisma generate` in `services/api` first — worker imports the generated client from `services/api/node_modules/.prisma/client` (see `services/worker/src/lib/regionRouter.ts`).
- **Build:** `npm run build --workspace=services/worker` → `services/worker/dist/`
- **Start:** `npm run start --workspace=services/worker` → `node dist/index.js` (from `services/worker` with `WORKDIR`)

### Dashboard

- **Install:** `npm ci`
- **Build:** `npm run build` → runs `npx prisma generate && next build` (expects `DATABASE_URL` at build for Prisma; use a **non-production placeholder** in Docker build if the schema does not need a live DB for `generate`)
- **Start:** `npm start` → `next start` (or run **standalone** server from `.next/standalone` per `next.config.ts`)

---

## 3. Prisma schemas and migrations

| App | Schema path | Migrations | Command (deploy) |
|-----|-------------|------------|-------------------|
| **API** | `services/api/prisma/schema.prisma` | `services/api/prisma/migrations` | `cd services/api && npx prisma migrate deploy` with `DATABASE_URL` **or** `prisma.config.ts` URL — **one deploy per regional database** (set `DATABASE_URL` to `DATABASE_URL_US` / EU / UK / AU in turn) |
| **Dashboard** | `hyrelog-dashboard/prisma/schema.prisma` | `hyrelog-dashboard/prisma/migrations` | `cd hyrelog-dashboard && npx prisma migrate deploy` (single `DATABASE_URL`) |

`services/api/prisma.config.ts` loads `hyrelog-api/.env` and uses `DATABASE_URL` or `DATABASE_URL_US` for CLI/studio. **CI/CD should not rely on a `.env` file**; export `DATABASE_URL` explicitly per region.

**Dashboard DB ≠ API DBs** — two separate PostgreSQL instances (or clusters) in production.

---

## 4. Environment variables (by service)

### API (`services/api/src/lib/config.ts` — Zod)

**Required (validation fails if missing):**  
`INTERNAL_TOKEN`, `DATABASE_URL_US` … `DATABASE_URL_AU`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_US` … `S3_BUCKET_AU`, `API_KEY_SECRET`

**Strongly required for product features:**  
`DASHBOARD_SERVICE_TOKEN` (enables `/dashboard/*`), `HYRELOG_DASHBOARD_URL` or `DASHBOARD_USAGE_URL` (usage callback to dashboard)

**Optional with defaults:** `PORT` (default 3000), `NODE_ENV`, `LOG_LEVEL`, `DEFAULT_DATA_REGION`, `S3_REGION`, `S3_FORCE_PATH_STYLE`, rate limits, `COLD_ARCHIVE_AFTER_DAYS`

**Local-only in production (omit on AWS S3):** `S3_ENDPOINT` (MinIO)

**Not in `loadConfig` but required at runtime for features:**

- `WEBHOOK_SECRET_ENCRYPTION_KEY` — **64 hex chars**; read by `webhookEncryption` / worker copy for creating webhooks, signing (`services/api`, `services/worker`).

### Worker (`services/worker/src/lib/config.ts`)

**Required:** same four `DATABASE_URL_*`, S3 keys/flags/buckets as API (no `INTERNAL_TOKEN`, `API_KEY_SECRET`, or dashboard URL in this schema).

**Also:** `WEBHOOK_SECRET_ENCRYPTION_KEY` for webhook path in worker (see `services/worker/src/lib/webhookEncryption.ts`).

**Optional:** `WORKER_POLL_INTERVAL_SECONDS`, `LOG_LEVEL`, `NODE_ENV`, `DEFAULT_DATA_REGION`

### Dashboard (representative, from `grep`)

**Database / app:** `DATABASE_URL`, `NEXT_PUBLIC_APP_URL`, `HYRELOG_API_URL`, `DASHBOARD_SERVICE_TOKEN`, `HYRELOG_API_KEY_SECRET` (must match API `API_KEY_SECRET`)  
**Auth / public URLs:** Better Auth uses standard env (e.g. `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` — **confirm** in your Better Auth / deployment docs)  
**Email:** `RESEND_API_KEY`, `MAIL_FROM`  
**Billing:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`  
**S3 (dashboard attachments):** `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` (per `lib/storage/s3.ts`)

**TODO (operator):** Reconcile **Better Auth** required envs with the [Better Auth environment documentation](https://www.better-auth.com/docs) for your version — not all are referenced explicitly in `lib/auth.ts` in this scan.

---

## 5. Local-only values (do not use in production)

- `S3_ENDPOINT=http://localhost:9000` and MinIO-style credentials
- `S3_FORCE_PATH_STYLE=true` (MinIO); use **`false`** for AWS (unless a rare compatibility case)
- `DATABASE_URL_*` pointing to `localhost:5432x`
- `DASHBOARD_USAGE_URL` / `HYRELOG_DASHBOARD_URL` as `http://localhost:4000` on ECS tasks
- `INTERNAL_TOKEN`, `API_KEY_SECRET`, `DASHBOARD_SERVICE_TOKEN` default dev strings from `.env.example`

---

## 6. Health checks (ALB / smoke)

- **Public:** `GET https://api.hyrelog.com/health` — returns `{ ok: true }` (no auth) — use for ALB health checks.
- **Root:** `GET /` — JSON with `status: 'running'`.
- **`GET /internal/health`** — exists but is under `/internal` and is protected by `x-internal-token` via `internalAuth` — **not** recommended for a simple public load balancer check without custom headers.

---

## 7. Gaps and prerequisites (before first production cutover)

1. ~~**No Dockerfiles**~~ — Dockerfiles are now in each repo (see table above). Validate with `scripts/deployment/build-all.sh` and dashboard `docker build`.
2. **Worker → Prisma path:** Worker build artifacts **depend** on `services/api` `prisma generate` output; worker image must preserve `services/api/node_modules/.prisma/client` layout.
3. **API S3 config:** Zod currently **requires** `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. For pure IAM task roles, you may use placeholder non-empty values if the AWS SDK uses the instance/task role, or plan a small code change to make keys optional when on AWS default credential chain. **Document in env-matrix.md.**
4. **Dashboard build:** `next build` with Prisma may require `DATABASE_URL` — Dockerfile should pass a build-arg dummy URL for `prisma generate` if needed.
5. **Separate Git remotes:** Two workflows (API repo vs dashboard repo) or a unified org pipeline; documented in the GitHub section of the main guide.
6. **IaC:** `hyrelog-api/infra` exists (CDK) but is not fully wired in this handoff; ECS **task definition JSON** templates are provided under `infra/ecs/` for manual/CLI use.

---

## 8. Summary

| Item | Verdict |
|------|---------|
| **Ready for container build** | Yes — use Dockerfiles + `.dockerignore` in this delivery |
| **Multi-region API migrations** | **Must** run `prisma migrate deploy` four times (US/EU/UK/AU) |
| **Shared secrets** | `DASHBOARD_SERVICE_TOKEN` (dashboard + API); `HYRELOG_API_KEY_SECRET` = `API_KEY_SECRET` |
| **ALB health path** | `GET /health` |

**Start here for hands-on AWS:** [STEP_BY_STEP_AWS.md](./STEP_BY_STEP_AWS.md) (phased checklist). Also: [aws-production-guide.md](./aws-production-guide.md), [env-matrix.md](./env-matrix.md), [database-migrations.md](./database-migrations.md), CI/CD under `.github/workflows/`.
