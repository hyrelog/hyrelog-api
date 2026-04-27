# HyreLog — database migration strategy

> **Compliance mode:** `DATABASE_URL_US`, `DATABASE_URL_EU`, `DATABASE_URL_UK`, and `DATABASE_URL_AU` should target **different regional database deployments**. This guide assumes strict regional separation.
>
> Primary runbook: [STEP_BY_STEP_AWS.md](./STEP_BY_STEP_AWS.md)

## 1. Dashboard migrations

- **Schema:** `hyrelog-dashboard/prisma/schema.prisma`
- **Migrations folder:** `hyrelog-dashboard/prisma/migrations/`
- **Command (deploy):** from the **dashboard** repo root:

```bash
cd hyrelog-dashboard
export DATABASE_URL="postgresql://USER:PASS@DASHBOARD_RDS:5432/DB?sslmode=require"
npx prisma migrate deploy
```

- **Prisma config:** `prisma.config.ts` uses `env("DATABASE_URL")` — the shell **must** export it (no `hyrelog-api/.env` in CI).

**Runtime:** the dashboard app does not auto-run `migrate` on start — **must** run in release pipeline or as a one-off before/after traffic cutover.

---

## 2. API / worker (single Prisma schema, **four** databases)

- **Schema:** `hyrelog-api/services/api/prisma/schema.prisma`
- **Migrations folder:** `hyrelog-api/services/api/prisma/migrations/`
- **All four** regional databases must have **the same** migration table history applied from this **one** history.

**Deploy command (per region),** from `hyrelog-api/services/api`:

```bash
cd services/api
export DATABASE_URL="$DATABASE_URL_US"   # then EU, UK, AU
npx prisma migrate deploy
```

`prisma.config.ts` in `services/api` uses `process.env.DATABASE_URL` (or `DATABASE_URL_US` as fallback) — for CI, set **`DATABASE_URL` explicitly** to the target you are deploying.

**Order:** you may run **US → EU → UK → AU** in any **fixed** order; do **all four** to the **same** migration revision (same git SHA / same deploy artifact).

**Worker** does not maintain a separate Prisma directory — it uses the **same** `services/api` generated client. **Migrations** are only for the `services/api` Prisma project.

---

## 3. Manual one-off (operator laptop or bastion)

1. Get network path to each RDS: **private only** in production (VPN, SSM port forward, or **ECS one-off** task in the same VPC as RDS — see §4).
2. For each of **five** databases (1 dashboard + 4 API), run `prisma migrate deploy` with the right `DATABASE_URL`.
3. Never run `prisma migrate dev` against production; use **`deploy`**.

---

## 4. How CI/CD should run migrations (safe patterns)

| Pattern | Pros | Cons |
|--------|------|------|
| **A. GitHub Action** with secrets `DATABASE_URL_*` and dashboard URL | One pipeline | Exposes DB to GitHub runner egress; **often blocked** for private RDS without VPN / self-hosted runner |
| **B. `aws ecs run-task`** with a **migration** task definition (same image as API, `command` override: `npx prisma migrate deploy`) in **private subnets** with RDS access | **Best** for private RDS: no public DB | Slightly more setup |
| **C. `scripts/deployment/run-api-regional-migrations.sh`** from a **bastion** in the VPC | Simple mental model | Manual or SSH automation |

**Recommendation for this project:** use **(B)** for API regional DBs in production, and a similar one-off for the **dashboard** (or a tiny “release” Fargate task) so migrations never need a public `0.0.0.0/0` on Postgres.

**Sample GitHub pattern (when RDS is reachable to runners — rare in locked-down orgs):**

- Job `migrate` **needs** the same `IMAGE_TAG` that you will deploy
- `docker run --rm` with env files from `aws secretsmanager get-secret-value` (complex) or use **OIDC** + **SSM/Secrets** in a self-hosted runner

The sample `deploy-production.yml` in this repo may include **placeholder** steps — **tighten** to your network reality.

---

## 5. If a migration **fails** mid-run

1. **Stop** further deploys to that database until fixed.
2. **Inspect** `prisma_migrations` table in PostgreSQL; Prisma will tell you the failed migration name.
3. **Do not** delete rows blindly. Options:
   - **Fix** the failed migration in a *new* migration (if idempotent) after consulting Prisma and your SRE.
   - **Restore** RDS from **snapshot** (before failed migration) in worst cases.
4. **Reconcile** the **four** API regions: if one region failed, **do not** treat other regions as “fully upgraded” for multi-region invariants; align all four to the same known-good schema revision.

---

## 6. Avoid deploying app code before schema is ready (expand/contract)

- Prefer **backwards-compatible** migrations first: add nullable columns, new tables, new indexes, **then** deploy app that **reads** them, **then** a second deploy that **writes** and removes old fields (**expand → deploy → contract**).
- If a column is **required** immediately, schedule **downtime** or use a **feature flag** until all regions and API/worker are on the new code.

## 7. Migrations “before or after” ECS deploy?

- **Default safe order:** run **`migrate deploy`** to success on **all** relevant databases **first**, then **roll the ECS service** to the new image that **expects** that schema.
- If the new code is **tolerant** of the old schema (e.g. only adds optional reads), you can **deploy app first** only in rare, carefully designed cases. **This repo does not guarantee** that — default to **migrations first**.

**Worker:** if migration adds a **new** table the worker will write to, migrate **all four** DBs **before** worker picks up a build that **requires** the new table.

## 8. Script reference

- `hyrelog-api/scripts/deployment/run-api-regional-migrations.sh` — loops four URLs (set by env)
- `hyrelog-api/scripts/deployment/run-dashboard-migrations.sh` — single `DATABASE_URL`

See script headers for `CONFIRM=YES` and required environment variables.
