# Dashboard: ECR image, task definition, ECS deploy, VPC migration (Git Bash)

Hands-on sequence to **build and push** the dashboard image to ECR, **register** a new `hyrelog-dashboard` task definition, **roll the ECS service**, then run **`prisma migrate deploy`** from your laptop via a **one-off Fargate task** (RDS stays private).

**Related:** migration strategy overview is in [`database-migrations.md`](./database-migrations.md).

**Assumed defaults (hardcoded below where safe):**

- Region: `ap-southeast-2`
- Cluster: `hyrelog-prod-ecs`
- ECS service: `hyrelog-dashboard`
- Repo paths:

  `hyrelog-dashboard` → `C:\Users\kram\Dropbox\hyrelog\hyrelog-dashboard` (Git Bash: `/c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard`)

  `hyrelog-api` → `.../hyrelog/hyrelog-api`

Adjust only if your AWS/account setup differs.

---

## Prerequisites

- **AWS CLI** (`aws sts get-caller-identity` works with your **default** profile or whichever profile you use).
- **Docker** Desktop (or daemon) running.
- **Git Bash** with **Node.js** on `PATH` (`node --version`). The ECS migration helper script uses Node for JSON.
- **Git**, **latest** `main`/`master` pulled for **`hyrelog-dashboard`** (image must contain `prisma/migrations/` you intend to apply).

Optional on Windows/Git Bash:

```bash
export MSYS_NO_PATHCONV=1
```

Helps **`file://`** paths passed to AWS CLI behave predictably under MSYS path conversion.

---

## 1) Session bootstrap (run first after every restart)

Run once per new Git Bash session:

```bash
export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
export AWS_ACCOUNT_ID=163436765242
export ECS_CLUSTER=hyrelog-prod-ecs
export ECS_SERVICE_DASHBOARD=hyrelog-dashboard
export TASK_FAMILY_DASHBOARD=hyrelog-dashboard
export MSYS_NO_PATHCONV=1

export DASHBOARD_REPO_DIR=/c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard
export API_REPO_DIR=/c/Users/kram/Dropbox/hyrelog/hyrelog-api
export ECR_DASHBOARD="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com/hyrelog-dashboard"

aws sts get-caller-identity
node --version
docker --version
```

If `aws sts get-caller-identity` does not return account `163436765242`, stop and fix credentials first.

---

## 2) Build tag, ECR login, Docker build, push

Run in **Git Bash**:

```bash
export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
export AWS_ACCOUNT_ID=163436765242
export DASHBOARD_REPO_DIR=/c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard
export ECR_DASHBOARD="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com/hyrelog-dashboard"

cd "${DASHBOARD_REPO_DIR}"

export IMAGE_TAG="$(date +%Y%m%d%H%M)-$(git rev-parse --short HEAD)"

echo "IMAGE_TAG=${IMAGE_TAG}"
```

Keep the printed **`IMAGE_TAG`** (needed for the task definition image string).

Build and push (standalone block):

```bash
export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
export AWS_ACCOUNT_ID=163436765242
export DASHBOARD_REPO_DIR=/c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard
export ECR_DASHBOARD="${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com/hyrelog-dashboard"
cd "${DASHBOARD_REPO_DIR}"

# If this shell was restarted, regenerate IMAGE_TAG from current commit before pushing.
export IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d%H%M)-$(git rev-parse --short HEAD)}"
echo "IMAGE_TAG=${IMAGE_TAG}"

aws ecr get-login-password --region "${PRIMARY_REGION}" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com"

docker build \
  --build-arg NEXT_PUBLIC_APP_URL="https://app.hyrelog.com" \
  --build-arg NEXT_PUBLIC_API_BASE_URL="https://api.hyrelog.com" \
  -t "${ECR_DASHBOARD}:${IMAGE_TAG}" \
  -t "${ECR_DASHBOARD}:latest" \
  .

docker push "${ECR_DASHBOARD}:${IMAGE_TAG}"
docker push "${ECR_DASHBOARD}:latest"
```

---

## 3) Register a new `hyrelog-dashboard` task definition (new image)

### 3a — Edit JSON

Open **`hyrelog-api/infra/ecs/task-definition-dashboard.json`** and set **`containerDefinitions[0].image`** to the image you just pushed:

```text
163436765242.dkr.ecr.ap-southeast-2.amazonaws.com/hyrelog-dashboard:<IMAGE_TAG>
```

Example (replace only **`<IMAGE_TAG>`**):

```text
163436765242.dkr.ecr.ap-southeast-2.amazonaws.com/hyrelog-dashboard:202604291430-a1b2c3d
```

Save the file.

### 3b — Register

**Git Bash** (from **`hyrelog-api`** root):

```bash
export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
export MSYS_NO_PATHCONV=1
export API_REPO_DIR=/c/Users/kram/Dropbox/hyrelog/hyrelog-api

cd "${API_REPO_DIR}"

aws ecs register-task-definition \
  --cli-input-json "file://$(pwd -W 2>/dev/null || pwd)/infra/ecs/task-definition-dashboard.json" \
  --region "${PRIMARY_REGION}" \
  --query 'taskDefinition.[family,revision]' \
  --output text
```

Note the **revision number** printed (second column), e.g. `9`. The full ARN family reference is **`hyrelog-dashboard:9`** (replace `9` with your revision).

Optional: export `REV` directly from latest registered dashboard task definition:

**Git Bash:** do not paste placeholders like `<paste-arn-from-above>` literally — in bash, `<word>` is **stdin redirection** (`No such file or directory`). Use the real ARN (for example `arn:aws:ecs:ap-southeast-2:163436765242:task-definition/hyrelog-dashboard:11`) or the family name `hyrelog-dashboard` to mean “latest”.

```bash
export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
export REV="$(aws ecs describe-task-definition \
  --task-definition hyrelog-dashboard \
  --region "${PRIMARY_REGION}" \
  --query 'taskDefinition.revision' \
  --output text)"
echo "REV=${REV}"
```

If **`file://`** fails under Git Bash, use **PowerShell** from **`hyrelog-api`**:

```powershell
$env:PRIMARY_REGION = "ap-southeast-2"
cd C:\Users\kram\Dropbox\hyrelog\hyrelog-api

aws ecs register-task-definition `
  --cli-input-json "file://$PWD/infra/ecs/task-definition-dashboard.json" `
  --region $env:PRIMARY_REGION `
  --query 'taskDefinition.[family,revision]' `
  --output text
```

---

## 4) Redeploy the `hyrelog-dashboard` ECS service on that revision

Replace **`REV`** with the revision from step **3** (integer only), or use the optional command above to set it automatically.

```bash
export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
export ECS_CLUSTER=hyrelog-prod-ecs
export ECS_SERVICE_DASHBOARD=hyrelog-dashboard

export REV=9

aws ecs update-service \
  --cluster "${ECS_CLUSTER}" \
  --service "${ECS_SERVICE_DASHBOARD}" \
  --task-definition "hyrelog-dashboard:${REV}" \
  --force-new-deployment \
  --region "${PRIMARY_REGION}"

aws ecs wait services-stable \
  --cluster "${ECS_CLUSTER}" \
  --services "${ECS_SERVICE_DASHBOARD}" \
  --region "${PRIMARY_REGION}"
```

---

## 5) Run dashboard DB migrations via ECS (laptop outside the VPC)

Migrations execute **inside** the VPC using the dashboard container image (same **`DATABASE_URL`** secret as production).

### 5a — Current production task definition (optional)

To align the migration task with whatever the service is running:

```bash
export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
export ECS_CLUSTER=hyrelog-prod-ecs
export ECS_SERVICE_DASHBOARD=hyrelog-dashboard

aws ecs describe-services \
  --cluster "${ECS_CLUSTER}" \
  --services "${ECS_SERVICE_DASHBOARD}" \
  --region "${PRIMARY_REGION}" \
  --query 'services[0].taskDefinition' \
  --output text
```

Use that **`hyrelog-dashboard:revision`** as **`TASK_DEFINITION`** in **5c** if you want it to match production exactly (often **same revision as step 4**).

If you want to export it directly for reuse in step **5c**:

```bash
export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
export ECS_CLUSTER=hyrelog-prod-ecs
export ECS_SERVICE_DASHBOARD=hyrelog-dashboard

export TASK_DEFINITION="$(aws ecs describe-services \
  --cluster "${ECS_CLUSTER}" \
  --services "${ECS_SERVICE_DASHBOARD}" \
  --region "${PRIMARY_REGION}" \
  --query 'services[0].taskDefinition' \
  --output text)"

echo "TASK_DEFINITION=${TASK_DEFINITION}"
```

This ensures migration runs with the **exact same task definition/image currently serving production**.

If you intentionally want to migrate on the newest registered dashboard task definition instead:

```bash
export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2

export TASK_DEFINITION="$(aws ecs describe-task-definition \
  --task-definition hyrelog-dashboard \
  --region "${PRIMARY_REGION}" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)"

echo "TASK_DEFINITION=${TASK_DEFINITION}"
```

Recommended default: use the **current service task definition** from step **5a** unless you are intentionally validating a newer, not-yet-serving revision.

### 5b — Networking (subnets + security groups)

Reuse the dashboard service networking:

```bash
export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
export ECS_CLUSTER=hyrelog-prod-ecs
export ECS_SERVICE_DASHBOARD=hyrelog-dashboard

aws ecs describe-services \
  --cluster "${ECS_CLUSTER}" \
  --services "${ECS_SERVICE_DASHBOARD}" \
  --region "${PRIMARY_REGION}" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' \
  --output json
```

From **`subnets`** set **`ECS_SUBNET_IDS`** — comma-separated, no spaces optional (the script trims spaces):

```bash
export ECS_SUBNET_IDS="subnet-xxxxxxxx,subnet-yyyyyyyy"
```

From **`securityGroups`**:

```bash
export ECS_SECURITY_GROUP_IDS="sg-zzzzzzzz"
```

Paste **your** values from the JSON; do not reuse example subnets or security groups blindly.

### 5c — Run the migration script

From **`hyrelog-api`**, **`TASK_DEFINITION`** must point at an image revision that includes **`prisma/migrations/`** matching what you intend to deploy (typically **`hyrelog-dashboard:${REV}`** from step **3–4**).

```bash
export MSYS_NO_PATHCONV=1

export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2

export ECS_CLUSTER=hyrelog-prod-ecs

export API_REPO_DIR=/c/Users/kram/Dropbox/hyrelog/hyrelog-api

export ECS_SUBNET_IDS="subnet-xxxxxxxx,subnet-yyyyyyyy"

export ECS_SECURITY_GROUP_IDS="sg-zzzzzzzz"

export TASK_DEFINITION="${TASK_DEFINITION:-hyrelog-dashboard:9}"

cd "${API_REPO_DIR}"

bash scripts/deployment/run-dashboard-migrations-ecs-task.sh
```

`TASK_DEFINITION` is set above from step **5a** if you exported it. If not, replace the fallback `hyrelog-dashboard:9` with your real `family:revision` or full task definition ARN.

### 5d — Confirm success

1. Shell exits **`0`**.
2. **CloudWatch Logs** → log group **`/ecs/hyrelog-dashboard`** → latest stream for that task → **`prisma migrate deploy`** completes without **`Error:`** / **`P`** Prisma failures.

---

## Recovering from a previously failed migrate

If a migration failed mid-flight (**P3018** etc.), resolve the failed row in **`_prisma_migrations`** per [Prisma’s troubleshooting guide](https://www.prisma.io/docs/guides/migrate/developing-with-prisma-migrate/troubleshooting-development#failed-migration) before **`migrate deploy`** will succeed—often **`prisma migrate resolve --rolled-back "<migration_folder_name>"`** against the dashboard database. As with **`migrate deploy`**, that command must reach RDS (VPN/bastion) or run in a VPC context similar to **`run-dashboard-migrations-ecs-task.sh`**.
