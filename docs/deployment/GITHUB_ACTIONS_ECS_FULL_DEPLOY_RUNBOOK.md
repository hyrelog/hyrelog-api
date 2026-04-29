# GitHub Actions → ECS: full deploy fix (Dashboard, API, Worker)

**Shell:** This runbook uses **Git Bash** on Windows only. Do **not** paste PowerShell line continuation (backticks `` ` ``); in Bash they break the command. Use **backslash `\`** at end of line, or one long line.

**IAM `put-role-policy` and `file://` on Windows + Git Bash:** the AWS CLI can mis-parse `file:///C:/...` and try to open an invalid path like **`/C:/Users/...`** → **`[Errno 22] Invalid argument`**. The reliable fix is to pass the policy as **JSON on the command line** (§2 Option A) instead of `file://`.

Optional (other AWS CLI path quirks under MSYS):

```bash
export MSYS_NO_PATHCONV=1
```

---

Use this after changing CI so **each deploy registers a new ECS task definition** whose container image is **`repository:${{ github.sha }}`**. Without that step, ECS stays on old immutable tags (`20260429…`, `…-iamonly`) while CI pushes new images — production never updates.

**Repos involved**

| Repo | Workflow | Deploys |
|------|-----------|---------|
| `hyrelog-dashboard` | `.github/workflows/deploy-production.yml` | Dashboard service |
| `hyrelog-api` | `.github/workflows/deploy-production.yml` | API + Worker services |

**IAM policy file (single source of truth):** `hyrelog-api/github-deploy-policy.json`  
Attach it as an **inline policy** on the **same IAM role** referenced by **`AWS_DEPLOY_ROLE_ARN`** in **both** repositories.

---

## 0) Prerequisites

- AWS CLI configured (`aws sts get-caller-identity` works).
- GitHub access to **hyrelog** org repos and **Actions** tab.
- **`production`** GitHub Environment: if it requires **manual approval**, approve deploy jobs when they wait.

---

## 1) Find the IAM role name for `AWS_DEPLOY_ROLE_ARN`

GitHub **does not** show secret values after save. Use any method below.

### A) If you still know the full ARN

Format:

```text
arn:aws:iam::163436765242:role/<ROLE_NAME>
```

Sometimes:

```text
arn:aws:iam::163436765242:role/<path>/<ROLE_NAME>
```

**Role name for `--role-name`** is usually the **last path segment** (e.g. `hyrelog-github-deploy-role`). Confirm in **IAM → Roles** if the console shows a path.

### B) List roles and grep

```bash
aws iam list-roles --query 'Roles[*].Arn' --output text | tr '\t' '\n' | grep -i hyrelog
```

Inspect candidates until **Trust relationships** show **`token.actions.githubusercontent.com`** (OIDC).

### C) Match by inline policy name

If you previously attached an inline policy named `github-deploy-policy`:

```bash
aws iam list-roles --output json | jq -r '.Roles[].RoleName' | while read -r r; do
  aws iam list-role-policies --role-name "$r" --query 'PolicyNames' --output text | grep -q github-deploy-policy && echo "$r"
done
```

---

## 2) Update the IAM inline policy on that role (once)

**`cd`:** Use Git Bash style **`cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api`**, not **`cd C:\...`**.

**`--policy-document`:** Prefer **JSON from the file, passed as a string** (no `file://`). That avoids Windows + Git Bash `file://` bugs (`No such file`, **`[Errno 22] Invalid argument: '/C:/Users/...'`**).

**Option A — recommended (Git Bash + `jq` minifies to one line):**

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
test -f github-deploy-policy.json && echo "policy file OK"

aws iam put-role-policy \
  --role-name hyrelog-github-deploy-role \
  --policy-name github-deploy-policy \
  --policy-document "$(jq -c . github-deploy-policy.json)"
```

**Option B — no `jq` (use Python, ships with most Windows Python installs):**

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api

aws iam put-role-policy \
  --role-name hyrelog-github-deploy-role \
  --policy-name github-deploy-policy \
  --policy-document "$(python -c "import json, pathlib; print(json.dumps(json.loads(pathlib.Path('github-deploy-policy.json').read_text(encoding='utf-8'))))")"
```

**Option C — PowerShell for this one command** (native Windows paths; use if you prefer not to inline JSON):

```powershell
cd C:\Users\kram\Dropbox\hyrelog\hyrelog-api
aws iam put-role-policy `
  --role-name hyrelog-github-deploy-role `
  --policy-name github-deploy-policy `
  --policy-document file://C:/Users/kram/Dropbox/hyrelog/hyrelog-api/github-deploy-policy.json
```

(Only **two** slashes after `file:` in the last line: `file://C:/...` — that form is what the Windows CLI expects for a local file.)

Replace **`hyrelog-github-deploy-role`** with your role name from §1 if different.

This policy must include at least:

- **ECR:** push/pull for `hyrelog-dashboard`, `hyrelog-api`, `hyrelog-worker` repos (already in repo JSON).
- **ECS:** `RegisterTaskDefinition`, `UpdateService`, `DescribeTaskDefinition`, `DescribeServices`, etc.
- **IAM:** `PassRole` for **`hyrelog-prod-ecs-execution-role`** and **`hyrelog-prod-ecs-task-role`** (needed when registering task definitions).

If your prod ECS roles use **different names**, edit **`github-deploy-policy.json`** `PassRole` `Resource` ARNs to match **IAM → Roles**, then run **`put-role-policy`** again.

**Verify** (`Action` in IAM JSON may be a **string** or an **array** — do not use `flatten` alone):

```bash
aws iam get-role-policy \
  --role-name hyrelog-github-deploy-role \
  --policy-name github-deploy-policy \
  --query 'PolicyDocument' \
  --output json | jq -r '.Statement[] | .Action | if type == "string" then . else .[] end' | grep -E 'RegisterTaskDefinition|PassRole'
```

Expect lines containing **`ecs:RegisterTaskDefinition`** and **`iam:PassRole`**.

---

## 3) GitHub repository secrets checklist

Both repos need **`AWS_DEPLOY_ROLE_ARN`** pointing at **the same role** you updated in §2.

### `hyrelog-dashboard` — Settings → Secrets and variables → Actions

| Secret | Purpose |
|--------|---------|
| `AWS_DEPLOY_ROLE_ARN` | IAM role ARN from §1 |
| `AWS_REGION` | e.g. `ap-southeast-2` |
| `ECR_DASHBOARD_REPOSITORY` | e.g. `163436765242.dkr.ecr.ap-southeast-2.amazonaws.com/hyrelog-dashboard` |
| `ECS_CLUSTER` | e.g. `hyrelog-prod-ecs` |
| `ECS_SERVICE_DASHBOARD` | e.g. `hyrelog-dashboard` |

### `hyrelog-api` — same place

| Secret | Purpose |
|--------|---------|
| `AWS_DEPLOY_ROLE_ARN` | Same ARN as dashboard |
| `AWS_REGION` | Same region |
| `ECR_API_REPOSITORY` | Full URI **without tag**, e.g. `…amazonaws.com/hyrelog-api` |
| `ECR_WORKER_REPOSITORY` | Full URI **without tag**, e.g. `…amazonaws.com/hyrelog-worker` |
| `ECS_CLUSTER` | Same cluster |
| `ECS_SERVICE_API` | e.g. `hyrelog-api` |
| `ECS_SERVICE_WORKER` | e.g. `hyrelog-worker` |

---

## 4) Pull latest workflow code and push `main`

Ensure **`main`** contains the workflows that **register task definitions** (not only `--force-new-deployment`).

### Dashboard

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard
git checkout main
git pull
git status   # expect deploy-production.yml with "Register task definition revision"
git push origin main   # only if you have unpushed commits; otherwise skip
```

If your workflow fix is **only local**, commit and push:

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard
git add .github/workflows/deploy-production.yml
git commit -m "ECS: register dashboard task definition with pushed image SHA"
git push origin main
```

### API (includes API + Worker)

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
git checkout main
git pull
git add .github/workflows/deploy-production.yml github-deploy-policy.json
git commit -m "ECS: register API/worker task defs with pushed SHA; IAM policy"
git push origin main
```

---

## 5) Watch GitHub Actions

1. **hyrelog-dashboard** → **Actions** → **deploy-production** → latest run on `main`.
2. **hyrelog-api** → **Actions** → **deploy-production** → latest run on `main`.

Confirm steps **succeed**:

- **Dashboard:** `Register task definition revision and deploy ECS`
- **API:** `Register task definitions and deploy API + Worker`

Approve **production environment** if prompted.

If **`RegisterTaskDefinition`** or **`PassRole`** fails: re-check §2 (policy applied to correct role, PassRole ARNs match ECS execution/task roles).

---

## 6) Verify ECS uses the Git commit SHA as image tag

After a green deploy, the **running task definition** image should end with the **full 40-character SHA** of **that deploy’s commit** (same value GitHub shows on the workflow run).

### Get expected SHAs from your laptop (Git Bash)

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-dashboard
git fetch origin main
git rev-parse origin/main

cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api
git fetch origin main
git rev-parse origin/main
```

Dashboard and API repos may have **different** SHAs on `main`; compare **each** service to **its** repo’s commit that triggered the deploy.

### Query ECS image per service

```bash
export REGION=ap-southeast-2
export CLUSTER=hyrelog-prod-ecs

for svc in hyrelog-dashboard hyrelog-api hyrelog-worker; do
  echo "=== ${svc} ==="
  TD=$(aws ecs describe-services --cluster "$CLUSTER" --services "$svc" --region "$REGION" \
    --query 'services[0].taskDefinition' --output text)
  aws ecs describe-task-definition --task-definition "$TD" --region "$REGION" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text
done
```

**Success:** each image URI ends with `:FULL_GIT_SHA` matching the workflow run.

**Failure:** still shows `:20260429…`, `:…-iamonly`, etc. → deploy workflow did not run, wrong branch, IAM denied registration, or task definition family name mismatch (see §7).

---

## 7) Task definition family names (must match AWS)

Workflows assume:

| Service | Task definition family |
|---------|-------------------------|
| Dashboard | `hyrelog-dashboard` |
| API | `hyrelog-api` |
| Worker | `hyrelog-worker` |

Confirm in **ECS → Task definitions** (or `aws ecs list-task-definitions`). If your families differ, update the workflow env/constants (`TASK_DEFINITION_FAMILY`, `register_and_deploy "hyrelog-api"` strings) to match.

---

## 8) Quick troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Green **checks** but old prod code | **checks** do not deploy; watch **deploy-production**. |
| Deploy fails `AccessDenied` on `RegisterTaskDefinition` | Policy not on role used by **`AWS_DEPLOY_ROLE_ARN`**, or wrong role. |
| Deploy fails `iam:PassRole` | Edit **`github-deploy-policy.json`** PassRole ARNs to match ECS execution/task roles; re-run §2. |
| Deploy waits forever | **production** environment needs approval. |
| Image tag is SHA but wrong app version | You compared wrong repo’s SHA (dashboard vs api). |
| `bash: cd: C:Users...: No such file or directory` | You used **`C:\...`** in Git Bash. Use **`/c/Users/...`**. |
| `bash: --role-name: command not found` | You pasted **PowerShell** continuations (**`` ` ``**). Use **`\`** or one line (§2). |
| `Unable to load paramfile ... No such file` / **`[Errno 22] Invalid argument: '/C:/Users/...'`** | Do **not** use `file://` from Git Bash for this command. Use §2 **Option A** (`jq -c`) or **Option B** (Python), or **Option C** (PowerShell). |

---

## 9) Reference files in repo

- IAM policy: `hyrelog-api/github-deploy-policy.json`
- Dashboard deploy: `hyrelog-dashboard/.github/workflows/deploy-production.yml`
- API + Worker deploy: `hyrelog-api/.github/workflows/deploy-production.yml`
- OIDC trust (for reference): `hyrelog-api/trust-policy-github-oidc.json`

---

## Execution order summary

1. **§1–2** — Resolve **`AWS_DEPLOY_ROLE_ARN`** → role name → **`put-role-policy`** with **`github-deploy-policy.json`**.
2. **§3** — Confirm GitHub secrets for **both** repos.
3. **§4** — Push **`main`** for **dashboard** and **api** so workflows run.
4. **§5** — Confirm **deploy-production** green for each repo.
5. **§6** — CLI check: three services’ images end with **deploy commit SHA**.

After this, every push to **`main`** that runs deploy should roll ECS to that commit’s images.
