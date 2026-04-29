# HyreLog Beginner Runbook — Phase 6 and 7 (CLI-first)

This companion guide is beginner-friendly and covers:

- **Phase 6:** AWS Secrets Manager setup from Git Bash (with scripts)
- **Phase 7:** ECR repositories and image push

It also includes the migration to **ECS task role for S3** so static `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` are no longer needed.

Use this after Phase 4 and 5 are complete.

---

## Before You Start (quick checklist)

You should already have:

- RDS endpoints for:
  - dashboard DB (`DATABASE_URL`)
  - US/EU/UK/AU API DBs (`DATABASE_URL_US/EU/UK/AU`)
- Four S3 bucket names (`S3_BUCKET_US/EU/UK/AU`)
- AWS account ID and regions documented

Use Git Bash and set:

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ENV_NAME="prod"
export PROJECT_PREFIX="hyrelog-${ENV_NAME}"
export PRIMARY_REGION="ap-southeast-2"
export DB_REGION_US="us-east-1"
export DB_REGION_EU="eu-west-1"
export DB_REGION_UK="eu-west-2"
export DB_REGION_AU="ap-southeast-2"
```

Optional sanity check:

```bash
echo "$AWS_ACCOUNT_ID $PROJECT_PREFIX $PRIMARY_REGION $DB_REGION_US $DB_REGION_EU $DB_REGION_UK $DB_REGION_AU"
```

---

## Phase 6 — Secrets Manager (CLI-first)

## 6.0 Security warning

- Do not paste production credentials into chat, commits, or screenshots.
- If credentials were shared accidentally, rotate DB passwords and regenerate app tokens immediately.

---

## 6.1 Required secrets list

Create these in Secrets Manager (`${PROJECT_PREFIX}/...`):

### Database URLs

- `${PROJECT_PREFIX}/DATABASE_URL`
- `${PROJECT_PREFIX}/DATABASE_URL_US`
- `${PROJECT_PREFIX}/DATABASE_URL_EU`
- `${PROJECT_PREFIX}/DATABASE_URL_UK`
- `${PROJECT_PREFIX}/DATABASE_URL_AU`

### Required app auth/integration secrets

- `${PROJECT_PREFIX}/DASHBOARD_SERVICE_TOKEN`
- `${PROJECT_PREFIX}/API_KEY_SECRET`
- `${PROJECT_PREFIX}/HYRELOG_API_KEY_SECRET` (must equal `API_KEY_SECRET`)
- `${PROJECT_PREFIX}/INTERNAL_TOKEN`
- `${PROJECT_PREFIX}/WEBHOOK_SECRET_ENCRYPTION_KEY` (64 hex chars)

### S3 key secrets (temporary only; remove after task-role migration below)

- `${PROJECT_PREFIX}/S3_ACCESS_KEY_ID`
- `${PROJECT_PREFIX}/S3_SECRET_ACCESS_KEY`

---

## 6.2 Create env file for secret values (recommended)

Create a local file (do not commit) at `./.secrets.prod.env`:

```bash
cat > ./.secrets.prod.env <<'EOF'
export DATABASE_URL='postgresql://USER:ENCODED_PASS@dashboard-host:5432/hyrelog_dashboard?sslmode=require'
export DATABASE_URL_US='postgresql://USER:ENCODED_PASS@us-host:5432/hyrelog_us?sslmode=require'
export DATABASE_URL_EU='postgresql://USER:ENCODED_PASS@eu-host:5432/hyrelog_eu?sslmode=require'
export DATABASE_URL_UK='postgresql://USER:ENCODED_PASS@uk-host:5432/hyrelog_uk?sslmode=require'
export DATABASE_URL_AU='postgresql://USER:ENCODED_PASS@au-host:5432/hyrelog_au?sslmode=require'

export DASHBOARD_SERVICE_TOKEN='REPLACE_WITH_LONG_RANDOM'
export API_KEY_SECRET='REPLACE_WITH_LONG_RANDOM'
export HYRELOG_API_KEY_SECRET='REPLACE_WITH_LONG_RANDOM_MATCHING_API_KEY_SECRET'
export INTERNAL_TOKEN='REPLACE_WITH_LONG_RANDOM'
export WEBHOOK_SECRET_ENCRYPTION_KEY='REPLACE_WITH_64_HEX'

# Optional only while still using static S3 keys:
export S3_ACCESS_KEY_ID='REPLACE_IF_NEEDED'
export S3_SECRET_ACCESS_KEY='REPLACE_IF_NEEDED'
EOF
```

Load it:

```bash
source ./.secrets.prod.env
```

Generate a 64-hex webhook key if needed:

```bash
openssl rand -hex 32
```

---

## 6.3 URL-encode DB passwords (required if special chars)

If your DB passwords include symbols (for example `@`, `:`, `/`, `?`, `#`), URL-encode the password part before building `DATABASE_URL*`.

Example helper:

```bash
python - <<'PY'
import urllib.parse
raw = "P@ss:word/123"
print(urllib.parse.quote(raw, safe=''))
PY
```

Use output in the URL:

- raw: `P@ss:word/123`
- encoded: `P%40ss%3Aword%2F123`

---

## 6.4 Run script to create/update all secrets

Script added:

- `scripts/deployment/create-or-update-secrets.sh`
- `scripts/deployment/bootstrap-secrets-from-template.sh` (recommended one-file flow)
- `scripts/deployment/secrets-bootstrap.template.env`

### Recommended: one template + one command

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
cp scripts/deployment/secrets-bootstrap.template.env .secrets.bootstrap.env
# edit .secrets.bootstrap.env and paste your real values
bash scripts/deployment/bootstrap-secrets-from-template.sh .secrets.bootstrap.env
```

What this does automatically:

- URL-encodes DB passwords
- builds `DATABASE_URL`, `DATABASE_URL_US`, `DATABASE_URL_EU`, `DATABASE_URL_UK`, `DATABASE_URL_AU`
- creates/updates all required secrets in `PRIMARY_REGION`
- optionally includes static S3 key secrets only if `INCLUDE_STATIC_S3_KEYS=true`
- prints Name + ARN table for task definitions

Run:

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
bash scripts/deployment/create-or-update-secrets.sh
```

This script:

- validates required env vars
- enforces `HYRELOG_API_KEY_SECRET == API_KEY_SECRET`
- enforces 64-hex webhook key
- creates or updates each secret
- prints Name + ARN table for task definition use

Help:

```bash
bash scripts/deployment/create-or-update-secrets.sh --help
bash scripts/deployment/bootstrap-secrets-from-template.sh --help
```

---

## 6.5 Verify secrets and ARNs

```bash
aws secretsmanager list-secrets \
  --region "$PRIMARY_REGION" \
  --query "SecretList[?starts_with(Name, '${PROJECT_PREFIX}/')].[Name,ARN]" \
  --output table
```

Expected:

- all required names present
- ARNs available to paste into ECS task definitions (`valueFrom`)

---

## 6.6 Move from static S3 keys to ECS task role (recommended now)

This removes the need for `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`.

### Step A — Attach S3 policy to ECS task role

Script added:

- `scripts/deployment/attach-s3-policy-to-ecs-task-role.sh`

Set variables:

```bash
export TASK_ROLE_NAME="${PROJECT_PREFIX}-ecs-task-role"
export S3_BUCKET_US="hyrelog-prod-events-us"
export S3_BUCKET_EU="hyrelog-prod-events-eu"
export S3_BUCKET_UK="hyrelog-prod-events-uk"
export S3_BUCKET_AU="hyrelog-prod-events-au"
```

Run:

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
bash scripts/deployment/attach-s3-policy-to-ecs-task-role.sh
```

The script adds least-privilege bucket/object permissions to your task role.

### Step B — Remove static S3 key env vars from ECS task definitions

In task definition JSONs, remove:

- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`

Keep:

- `S3_BUCKET_US`
- `S3_BUCKET_EU`
- `S3_BUCKET_UK`
- `S3_BUCKET_AU`
- optional `S3_REGION` / `S3_ENDPOINT` as needed

Beginner-friendly way (script):

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
bash scripts/deployment/remove-static-s3-secrets-from-task-defs.sh
```

### Step C — Register new task definitions and redeploy services

Do this **after Phase 7 image push**. If ECR/images are not ready yet, skip Step C for now.

### Step D — Delete old S3 key secrets (after successful redeploy)

Only after services are stable and uploads work:

```bash
aws secretsmanager delete-secret --secret-id "${PROJECT_PREFIX}/S3_ACCESS_KEY_ID" --region "$PRIMARY_REGION" --force-delete-without-recovery
aws secretsmanager delete-secret --secret-id "${PROJECT_PREFIX}/S3_SECRET_ACCESS_KEY" --region "$PRIMARY_REGION" --force-delete-without-recovery
```

If you prefer a recovery window, omit `--force-delete-without-recovery`.

---

## 6.7 Phase 6 verification checklist

- [ ] All required non-S3 secrets exist
- [ ] All `DATABASE_URL*` values are valid and use correct DB host/DB name
- [ ] `HYRELOG_API_KEY_SECRET == API_KEY_SECRET`
- [ ] `DASHBOARD_SERVICE_TOKEN` matches API + dashboard
- [ ] ECS task role has S3 access policy attached
- [ ] Task defs no longer include static S3 key env vars

---

## 6.8 Phase 6 completion checkpoint (before Phase 7)

If all checks below are true, Phase 6 is complete and you can move to Phase 7:

1. Secrets created/updated in Secrets Manager
2. ECS task role has S3 bucket policy attached
3. Static S3 key entries removed from task-definition JSON templates
4. You intentionally deferred Step C (register/redeploy) until after Phase 7

At this point: **go do Phase 7**, then return to Step C.

---

## Phase 7 — ECR + image build and push

## 7.0 What you are publishing

In primary region, create and publish 3 images:

- `hyrelog-api`
- `hyrelog-worker`
- `hyrelog-dashboard`

Each gets:

- timestamp+git tag (recommended)
- optional `latest` tag

---

## 7.1 Create ECR repositories

```bash
aws ecr create-repository --repository-name hyrelog-api --region "$PRIMARY_REGION" || true
aws ecr create-repository --repository-name hyrelog-worker --region "$PRIMARY_REGION" || true
aws ecr create-repository --repository-name hyrelog-dashboard --region "$PRIMARY_REGION" || true
```

Set repo URLs:

```bash
export ECR_API="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com/hyrelog-api"
export ECR_WORKER="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com/hyrelog-worker"
export ECR_DASHBOARD="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com/hyrelog-dashboard"
export IMAGE_TAG="$(date +%Y%m%d%H%M)-$(git rev-parse --short HEAD)"
```

---

## 7.2 Log in Docker to ECR

```bash
aws ecr get-login-password --region "$PRIMARY_REGION" \
| docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com"
```

---

## 7.3 Build and push API + worker images

From `hyrelog-api` repo root:

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api

docker build -f services/api/Dockerfile \
  -t "$ECR_API:$IMAGE_TAG" \
  -t "$ECR_API:latest" \
  .

docker build -f services/worker/Dockerfile \
  -t "$ECR_WORKER:$IMAGE_TAG" \
  -t "$ECR_WORKER:latest" \
  .

docker push "$ECR_API:$IMAGE_TAG"
docker push "$ECR_API:latest"
docker push "$ECR_WORKER:$IMAGE_TAG"
docker push "$ECR_WORKER:latest"
```

---

## 7.4 Build and push dashboard image

From `hyrelog-dashboard` repo root:

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard

docker build \
  --build-arg NEXT_PUBLIC_APP_URL="https://app.hyrelog.com" \
  --build-arg NEXT_PUBLIC_API_BASE_URL="https://api.hyrelog.com" \
  -t "$ECR_DASHBOARD:$IMAGE_TAG" \
  -t "$ECR_DASHBOARD:latest" \
  .

docker push "$ECR_DASHBOARD:$IMAGE_TAG"
docker push "$ECR_DASHBOARD:latest"
```

---

## 7.5 Verify images exist in ECR

```bash
aws ecr describe-images --repository-name hyrelog-api --region "$PRIMARY_REGION" --query "sort_by(imageDetails,& imagePushedAt)[-3:].imageTags" --output json
aws ecr describe-images --repository-name hyrelog-worker --region "$PRIMARY_REGION" --query "sort_by(imageDetails,& imagePushedAt)[-3:].imageTags" --output json
aws ecr describe-images --repository-name hyrelog-dashboard --region "$PRIMARY_REGION" --query "sort_by(imageDetails,& imagePushedAt)[-3:].imageTags" --output json
```

---

## 7.6 Capture outputs for Phase 8 and CI/CD

### Where `ECR_API`, `ECR_WORKER`, `ECR_DASHBOARD` come from

They are not a special AWS “download”. They follow this pattern (same for all three repos in your **primary** region):

`ECR_URL = <AWS_ACCOUNT_ID>.dkr.ecr.<PRIMARY_REGION>.amazonaws.com/<repository-name>`

| Variable | Repository name (default) |
|----------|----------------------------|
| `ECR_API` | `hyrelog-api` |
| `ECR_WORKER` | `hyrelog-worker` |
| `ECR_DASHBOARD` | `hyrelog-dashboard` |

**Fill in the values:**

1. `AWS_ACCOUNT_ID` — from `aws sts get-caller-identity --query Account --output text`
2. `PRIMARY_REGION` — the region where you created ECR (e.g. `ap-southeast-2`)
3. Repository name — from **ECR → Repositories** in the console, or:

```bash
aws ecr describe-repositories --region "$PRIMARY_REGION" --query "repositories[?contains(repositoryName, 'hyrelog')].repositoryUri" --output text
```

Example result:

- `163436765242.dkr.ecr.ap-southeast-2.amazonaws.com/hyrelog-api`  
  That string is the value you use as `ECR_API` (with no extra tag on the end yet).

**Optional one-liner to export all three (after repos exist):**

```bash
export ECR_BASE="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com"
export ECR_API="${ECR_BASE}/hyrelog-api"
export ECR_WORKER="${ECR_BASE}/hyrelog-worker"
export ECR_DASHBOARD="${ECR_BASE}/hyrelog-dashboard"
```

### Where `IMAGE_TAG` comes from

`IMAGE_TAG` is **the Docker tag you built and pushed** (not a separate AWS resource). Common choices:

1. **Set when you build** (recommended in this runbook):

   ```bash
   export IMAGE_TAG="$(date +%Y%m%d%H%M)-$(git rev-parse --short HEAD)"
   ```

2. **Read from ECR** after a push (pick the tag you just pushed, not `latest` if you want a pinned deploy):

   ```bash
   aws ecr describe-images --repository-name hyrelog-api --region "$PRIMARY_REGION" \
     --query "sort_by(imageDetails,& imagePushedAt)[-1].imageTags" --output json
   ```

Use the **same** `IMAGE_TAG` for API, worker, and dashboard in one release, or use separate tags if your process requires it.

### What to write down

| Name | Example meaning |
|------|------------------|
| `ECR_API` | Base image URI for API (no tag, or with `:tag` when passing to `docker build` `-t`) |
| `ECR_WORKER` | Base image URI for worker |
| `ECR_DASHBOARD` | Base image URI for dashboard |
| `IMAGE_TAG` | The tag part after `:`, e.g. `202604271030-a1b2c3d` |

In `render-task-defs.sh` and task definitions, the image is usually `.../hyrelog-api:IMAGE_TAG`.

---

## 7.6a API + worker: `DATABASE_URL` from rotated secret + static host (optional, recommended for password rotation)

This section is only for **API** and **worker** tasks (not the dashboard image unless you add the same entrypoint there). It fixes the problem where **RDS rotates the password every 7 days** in the **small JSON secret** (`username` / `password`), but your **plain-text `DATABASE_URL_*` secrets** still contain the **old** password.

### What you are doing (big picture)

1. **Stop** injecting full `postgresql://...` strings as `DATABASE_URL_US` etc. from Secrets Manager *for API/worker* (remove those secret mappings from the task definition), **or** leave them unset so the entrypoint can run.
2. **Add** plain **environment** variables for each database: host, port, database name (these rarely change).
3. **Add** **secrets** mappings that pull only `username` and `password` from each RDS master secret (the one that **rotates**).
4. On container start, the image runs **`docker-entrypoint-database-url.sh`**, which **builds** `DATABASE_URL_US`, `DATABASE_URL_EU`, etc. (with **URL-encoded** password) and then starts Node.

If you **still** inject a full `DATABASE_URL_*` from Secrets Manager, the entrypoint **skips** building that one (backward compatible), but you are **not** fixing rotation until you remove those entries.

---

### Step 0 — Prerequisites

- [ ] API and worker Docker images are **rebuilt and pushed** after the entrypoint was added (see `services/api/Dockerfile` and `services/worker/Dockerfile`).
- [ ] You know the **Secrets Manager secret ARN** (or name) for **each** RDS instance’s master credentials (dashboard + US + EU + UK + AU if all separate).
- [ ] Each master secret JSON contains at least `username` and `password` (your case).
- [ ] ECS **task execution role** can call `secretsmanager:GetSecretValue` on **every** secret ARN you reference (including **other regions** if your DB secrets live in EU/US etc. and ECS runs in `PRIMARY_REGION`).

---

### Step 1 — Collect “static” connection facts per database

For **each** database, write down (from **RDS → Databases → your instance → Connectivity & security** and **Configuration**):

| You need | Example | Where |
|----------|---------|--------|
| Endpoint / host | `hyrelog-prod-api-us.xxxx.us-east-1.rds.amazonaws.com` | RDS endpoint hostname |
| Port | `5432` | Usually 5432 |
| Database name | `hyrelog_us` | The DB name you created (see Phase 4 runbook) |

Build a small table for yourself:

| Logical DB | `DB_HOST_*` value | Port | `DB_NAME_*` |
|------------|-------------------|------|-------------|
| US | `...us-east-1.rds.amazonaws.com` | 5432 | `hyrelog_us` |
| EU | `...eu-west-1...` | 5432 | `hyrelog_eu` |
| UK | `...eu-west-2...` | 5432 | `hyrelog_uk` |
| AU | `...ap-southeast-2...` | 5432 | `hyrelog_au` |

These values go in the task definition as **`environment`** (not secrets), because they are not rotating with the password.

---

### Step 2 — Map env var names the entrypoint expects

The script `scripts/docker/docker-entrypoint-database-url.sh` looks for:

**Regional API databases (required for API + worker):**

| Built at startup | Environment (plain) | Secrets (from JSON keys) |
|------------------|----------------------|---------------------------|
| `DATABASE_URL_US` | `DB_HOST_US`, `DB_PORT_US` (optional, default `5432`), `DB_NAME_US` | `DB_USER_US` ← key `username`, `DB_PASSWORD_US` ← key `password` |
| `DATABASE_URL_EU` | `DB_HOST_EU`, `DB_PORT_EU`, `DB_NAME_EU` | `DB_USER_EU`, `DB_PASSWORD_EU` |
| `DATABASE_URL_UK` | `DB_HOST_UK`, … | `DB_USER_UK`, `DB_PASSWORD_UK` |
| `DATABASE_URL_AU` | `DB_HOST_AU`, … | `DB_USER_AU`, `DB_PASSWORD_AU` |

**Optional (only if you use a single “dashboard” connection inside API/worker — usually you do not):**

| Built at startup | Environment | Secrets |
|------------------|-------------|---------|
| `DATABASE_URL` | `DB_HOST`, `DB_PORT`, `DB_NAME` | `DB_USER`, `DB_PASSWORD` |

Use **one rotating secret per database**. Typically that is the secret RDS created for **that** instance (often in the **same AWS region** as that RDS).

---

### Step 3 — Get the correct `valueFrom` ARN for ECS (`username` / `password` keys)

ECS can inject a **single JSON key** from Secrets Manager. The `valueFrom` string must include the key name at the end.

**Pattern:**

```text
arn:aws:secretsmanager:<SECRET_REGION>:<ACCOUNT_ID>:secret:<SECRET_NAME>-<RandomSuffix>:password::
```

**Same for `username`:**

```text
arn:aws:secretsmanager:<SECRET_REGION>:<ACCOUNT_ID>:secret:<SECRET_NAME>-<RandomSuffix>:username::
```

**How to get the full ARN (easiest):**

1. AWS Console → **Secrets Manager** → switch to the **region where that RDS secret lives**.
2. Open the secret → copy **Secret ARN** from the details page.
3. Append **`:password::`** or **`:username::`** (two colons at the end).

**CLI example (lists name + ARN):**

```bash
aws secretsmanager list-secrets --region us-east-1 --query "SecretList[?contains(Name, 'hyrelog')].[Name,ARN]" --output table
```

Use the ARN that matches **that specific** database’s master secret.

**Cross-region:** If your ECS tasks run in `ap-southeast-2` but the US DB secret is in `us-east-1`, you still use the **`us-east-1` ARN** in the task definition. Ensure the **task execution role** policy allows `GetSecretValue` on that ARN (often a broad `hyrelog-prod/*` prefix is enough).

---

### Step 4 — Edit the API (and worker) task definition JSON

**4a — Remove old full-URL secret injections (important)**

In `infra/ecs/task-definition-api.json` (and worker), in `containerDefinitions[].secrets`, **remove** entries whose `name` is:

- `DATABASE_URL_US`, `DATABASE_URL_EU`, `DATABASE_URL_UK`, `DATABASE_URL_AU`

(if they point at a **full connection string** secret). If you leave them, the entrypoint will **not** rebuild those URLs and rotation will still break you.

**4b — Add `environment` entries**

Under `environment`, add (example for US — repeat for EU/UK/AU with your real host/db names):

```json
{ "name": "DB_HOST_US", "value": "hyrelog-prod-api-us.xxxx.us-east-1.rds.amazonaws.com" },
{ "name": "DB_PORT_US", "value": "5432" },
{ "name": "DB_NAME_US", "value": "hyrelog_us" }
```

**4c — Add `secrets` entries for user + password**

For each region, add four secret injections (two keys × two env names). Example for US:

```json
{
  "name": "DB_USER_US",
  "valueFrom": "arn:aws:secretsmanager:us-east-1:163436765242:secret:rds!db-xxxxx-yyyyy:username::"
},
{
  "name": "DB_PASSWORD_US",
  "valueFrom": "arn:aws:secretsmanager:us-east-1:163436765242:secret:rds!db-xxxxx-yyyyy:password::"
}
```

Repeat with **each region’s** secret ARN for EU, UK, AU (`DB_USER_EU` / `DB_PASSWORD_EU`, etc.).

> Replace account, region, and ARN with **yours**. The `-xxxxx` suffix after the secret name is **required** — copy it from the console ARN.

---

### Step 5 — Register the task definition and deploy

1. Register the updated JSON:

   ```bash
   aws ecs register-task-definition --cli-input-json file://infra/ecs/task-definition-api.json --region "$PRIMARY_REGION"
   aws ecs register-task-definition --cli-input-json file://infra/ecs/task-definition-worker.json --region "$PRIMARY_REGION"
   ```

2. Update the ECS services to the new revision (or use `scripts/deployment/update-ecs-services.sh`).

3. Confirm new tasks **start** and **health checks** pass.

---

### Step 6 — After RDS rotates the password (every 7 days)

Rotating secrets **updates** the JSON in Secrets Manager. **Existing** tasks still hold the **old** password in memory until replaced.

After each rotation window (or when you see DB auth errors):

- **Force a new deployment** of API and worker so tasks restart and re-read secrets:

  ```bash
  aws ecs update-service --cluster "$ECS_CLUSTER" --service hyrelog-api --force-new-deployment --region "$PRIMARY_REGION"
  aws ecs update-service --cluster "$ECS_CLUSTER" --service hyrelog-worker --force-new-deployment --region "$PRIMARY_REGION"
  ```

Longer term, automate this with **EventBridge** on successful rotation + Lambda calling `UpdateService` (optional).

---

### Step 7 — Dashboard database note

The **dashboard** task definition usually still uses a single `DATABASE_URL` secret for Postgres. You can either:

- Keep a **full URL** secret for dashboard only and **refresh** it when the dashboard DB password rotates (until you add the same entrypoint pattern to `hyrelog-dashboard`), or  
- Add the same **piecewise** env + secret pattern if you extend the dashboard Dockerfile with the shared entrypoint script later.

---

### Quick checklist

- [ ] Removed full `DATABASE_URL_*` secret refs from **API/worker** task defs (or left `DATABASE_URL_*` unset).
- [ ] Added `DB_HOST_*`, `DB_PORT_*`, `DB_NAME_*` for US/EU/UK/AU.
- [ ] Added `DB_USER_*` / `DB_PASSWORD_*` from **`:username::`** / **`:password::`** ARNs.
- [ ] Execution role can read all secret ARNs (including cross-region).
- [ ] Redeployed services after change; plan **force redeploy** after each rotation.

---

## 7.7 Render task definitions automatically (recommended)

Use this to avoid manual placeholder mistakes like invalid role ARNs.

Script:

- `scripts/deployment/render-task-defs.sh`

Set minimum inputs:

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export PRIMARY_REGION="ap-southeast-2"
export PROJECT_PREFIX="hyrelog-prod"
export IMAGE_TAG="REPLACE_WITH_YOUR_PUSHED_TAG"
export S3_BUCKET_US="hyrelog-prod-events-us"
export S3_BUCKET_EU="hyrelog-prod-events-eu"
export S3_BUCKET_UK="hyrelog-prod-events-uk"
export S3_BUCKET_AU="hyrelog-prod-events-au"
```

Render only:

```bash
bash scripts/deployment/render-task-defs.sh
```

Render and register all 3 families:

```bash
bash scripts/deployment/render-task-defs.sh --register
```

Rendered output files:

- `infra/ecs/rendered/task-definition-api.rendered.json`
- `infra/ecs/rendered/task-definition-worker.rendered.json`
- `infra/ecs/rendered/task-definition-dashboard.rendered.json`

---

## 7.8 Optional hardening

- Enable ECR image scanning
- Add lifecycle policies for old tags
- Prefer pinned image tags over `latest` in production task definitions

---

## 7.9 Deploy ECS services with one script

Script:

- `scripts/deployment/update-ecs-services.sh`

Use it after registering task definitions:

```bash
export PRIMARY_REGION="ap-southeast-2"
export ECS_CLUSTER="hyrelog-prod-ecs"
bash scripts/deployment/update-ecs-services.sh
```

If your service names differ:

```bash
export API_SERVICE="your-api-service-name"
export WORKER_SERVICE="your-worker-service-name"
export DASHBOARD_SERVICE="your-dashboard-service-name"
bash scripts/deployment/update-ecs-services.sh
```

Deploy only API + worker:

```bash
export DEPLOY_DASHBOARD=false
bash scripts/deployment/update-ecs-services.sh
```

The script updates services to the latest revision of:

- `hyrelog-api`
- `hyrelog-worker`
- `hyrelog-dashboard`

and waits for all selected services to be stable.

---

## 7.10 Return and finish deferred Step C (register + redeploy)

Run this only after Phase 7 is complete (images are pushed and `IMAGE_TAG` is known).

Step-by-step:

1. Set deployment vars:

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export PRIMARY_REGION="ap-southeast-2"
export PROJECT_PREFIX="hyrelog-prod"
export IMAGE_TAG="REPLACE_WITH_PUSHED_IMAGE_TAG"
export ECS_CLUSTER="hyrelog-prod-ecs"
export S3_BUCKET_US="hyrelog-prod-events-us"
export S3_BUCKET_EU="hyrelog-prod-events-eu"
export S3_BUCKET_UK="hyrelog-prod-events-uk"
export S3_BUCKET_AU="hyrelog-prod-events-au"
```

2. Render and register task definitions:

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
bash scripts/deployment/render-task-defs.sh --register
```

3. Redeploy services and wait for stable:

```bash
bash scripts/deployment/update-ecs-services.sh
```

4. Verify app behavior (including S3 paths) from logs/smoke tests.

5. Only after successful validation, delete legacy static S3 key secrets (Step D).

---

## Done Criteria for Phase 6 + 7

You are ready for Phase 8 when:

- all required secrets are present and validated
- ECS task role has S3 access and static S3 keys are removed from task defs
- three ECR repos exist
- API/worker/dashboard images are pushed with a known `IMAGE_TAG`
