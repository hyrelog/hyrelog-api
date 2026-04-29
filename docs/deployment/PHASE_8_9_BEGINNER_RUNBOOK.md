# HyreLog Beginner Runbook — Phase 8 and 9 (ECS cluster + TLS + ALB)

This companion guide is beginner-friendly and covers:

- **Phase 8:** ECS cluster creation, task definition registration (no running services yet — those are **Phase 10**).
- **Phase 9:** ACM TLS certificates, Application Load Balancer (ALB), Route 53 DNS.

Use this **after Phase 6 and 7 are complete** (secrets, ECR repos, images pushed with a known `IMAGE_TAG`).

You should already have **Phase 3 networking** (VPC, public + private subnets in `${PRIMARY_REGION}`) and **Phase 2 IAM** (ECS execution role + ECS task role). If anything below fails with “role not found” or “VPC not found”, finish those phases first using `docs/deployment/STEP_BY_STEP_AWS.md`.

---

## How Phase 8 + 9 relate to Phase 10

| Phase | What you create |
|--------|------------------|
| **8** | ECS **cluster** + registered **task definitions** (revision numbers in ECS). |
| **9** | **ACM** cert + **ALB** + **target groups** + **Route 53** records. Target groups start **empty** until tasks register. |
| **10** | ECS **services** (API, worker, dashboard) — tasks join target groups; traffic flows. |

Do **not** expect `https://api.hyrelog.com` to answer your API until **Phase 10** is done and tasks are **healthy**.

---

## Before you start (environment variables)

Use **Git Bash** (or PowerShell with equivalent syntax). From your ops notes, set:

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ENV_NAME="prod"
export PROJECT_PREFIX="hyrelog-${ENV_NAME}"
export PRIMARY_REGION="ap-southeast-2"
```

Sanity check:

```bash
echo "$AWS_ACCOUNT_ID $PROJECT_PREFIX $PRIMARY_REGION"
```

**Write down** (from Phase 3 / your VPC worksheet):

| Variable | Example | Used for |
|----------|---------|----------|
| `PRIMARY_VPC_ID` | `vpc-0abc…` | ALB + ECS services |
| `PRIMARY_PUBLIC_SUBNET_1` | `subnet-…` | ALB (AZ a) |
| `PRIMARY_PUBLIC_SUBNET_2` | `subnet-…` | ALB (AZ b) |
| `PRIMARY_PRIVATE_SUBNET_1` | `subnet-…` | ECS tasks (AZ a) |
| `PRIMARY_PRIVATE_SUBNET_2` | `subnet-…` | ECS tasks (AZ b) |

You will also need **security group IDs** (create or reuse — see §9.4):

- **ALB security group** — inbound `443` (and optionally `80`) from `0.0.0.0/0`.
- **ECS tasks security group** — inbound **TCP 3000** from the **ALB security group only** (API + dashboard containers listen on 3000).

Domains used in this guide (adjust if yours differ):

- API: `api.hyrelog.com`
- Dashboard: `app.hyrelog.com`

---

# Phase 8 — ECS cluster and task definitions

## 8.0 Prerequisites checklist

Before creating the cluster:

- [ ] **`${PROJECT_PREFIX}-ecs-execution-role`** exists (`aws iam get-role --role-name "${PROJECT_PREFIX}-ecs-execution-role"`).
- [ ] **`${PROJECT_PREFIX}-ecs-task-role`** exists (`aws iam get-role --role-name "${PROJECT_PREFIX}-ecs-task-role"`).
- [ ] Task role has **inline** S3 policy if you removed static S3 keys (`aws iam list-role-policies --role-name "${PROJECT_PREFIX}-ecs-task-role"` — expect e.g. `HyrelogS3RegionalBucketsAccess` from `scripts/deployment/attach-s3-policy-to-ecs-task-role.sh`).
- [ ] Execution role can **read Secrets Manager** (inline policy on execution role — see `STEP_BY_STEP_AWS.md` Phase 2.2). If API/worker use **cross-region** RDS secrets, the policy **Resource** must allow those ARNs or `secret:*` / `rds!*` patterns as appropriate.
- [ ] ECR images exist for **`IMAGE_TAG`** you will put in task definitions (Phase 7).

---

## 8.1 Create the ECS cluster (Fargate)

**Cluster name** (matches the rest of this repo’s docs):

```text
${PROJECT_PREFIX}-ecs
```

Example: `hyrelog-prod-ecs`.

### Option A — AWS CLI

```bash
export ECS_CLUSTER="${PROJECT_PREFIX}-ecs"

aws ecs create-cluster \
  --cluster-name "$ECS_CLUSTER" \
  --region "$PRIMARY_REGION"
```

### Option B — Console

1. **Amazon ECS** → **Clusters** → **Create cluster**.
2. **Cluster name:** `hyrelog-prod-ecs` (or `${PROJECT_PREFIX}-ecs`).
3. **Infrastructure:** AWS Fargate (serverless).
4. Create.

Verify:

```bash
aws ecs describe-clusters --clusters "$ECS_CLUSTER" --region "$PRIMARY_REGION" \
  --query 'clusters[0].[clusterName,status]' --output text
```

---

## 8.2 CloudWatch log groups (optional but recommended)

ECS can create log groups on first run; you can pre-create to set retention.

```bash
# Git Bash on Windows mangles paths like "/ecs/..." into "C:/Program Files/Git/ecs/...".
# Either run this from PowerShell, or disable path conversion for these commands:
export MSYS_NO_PATHCONV=1

for name in hyrelog-api hyrelog-worker hyrelog-dashboard; do
  aws logs create-log-group --log-group-name "/ecs/${name}" --region "$PRIMARY_REGION" 2>/dev/null || true
  aws logs put-retention-policy --log-group-name "/ecs/${name}" --retention-in-days 14 --region "$PRIMARY_REGION"
done

unset MSYS_NO_PATHCONV
```

These names must match **`awslogs-group`** in `infra/ecs/task-definition-*.json`.

---

## 8.3 Prepare task definition JSON

Templates live in **`hyrelog-api`**:

- `infra/ecs/task-definition-api.json`
- `infra/ecs/task-definition-worker.json`
- `infra/ecs/task-definition-dashboard.json`

**Recommended:** use **`scripts/deployment/render-task-defs.sh`** so account, region, image tag, buckets, and secret name prefixes are substituted consistently (see Phase 7 runbook §7.7).

Minimum exports for render:

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api

export AWS_ACCOUNT_ID PRIMARY_REGION PROJECT_PREFIX IMAGE_TAG
export IMAGE_TAG="YOUR_PINNED_TAG_FROM_ECR"
export S3_BUCKET_US="hyrelog-prod-events-us"
export S3_BUCKET_EU="hyrelog-prod-events-eu"
export S3_BUCKET_UK="hyrelog-prod-events-uk"
export S3_BUCKET_AU="hyrelog-prod-events-au"

bash scripts/deployment/render-task-defs.sh
```

Rendered output:

- `infra/ecs/rendered/task-definition-api.rendered.json`
- `infra/ecs/rendered/task-definition-worker.rendered.json`
- `infra/ecs/rendered/task-definition-dashboard.rendered.json`

If you **edit JSON by hand**, ensure **no** remaining `ACCOUNT_ID`, `REGION`, `IMAGE_TAG`, or `REPLACE_*` placeholders, and that **`secrets`** use `valueFrom` (not `environment`).

---

## 8.4 Register task definitions

### If you used `render-task-defs.sh`

```bash
aws ecs register-task-definition \
  --cli-input-json file://infra/ecs/rendered/task-definition-api.rendered.json \
  --region "$PRIMARY_REGION"

aws ecs register-task-definition \
  --cli-input-json file://infra/ecs/rendered/task-definition-worker.rendered.json \
  --region "$PRIMARY_REGION"

aws ecs register-task-definition \
  --cli-input-json file://infra/ecs/rendered/task-definition-dashboard.rendered.json \
  --region "$PRIMARY_REGION"
```

### If you use the non-rendered templates

```bash
aws ecs register-task-definition \
  --cli-input-json file://infra/ecs/task-definition-api.json \
  --region "$PRIMARY_REGION"

aws ecs register-task-definition \
  --cli-input-json file://infra/ecs/task-definition-worker.json \
  --region "$PRIMARY_REGION"

aws ecs register-task-definition \
  --cli-input-json file://infra/ecs/task-definition-dashboard.json \
  --region "$PRIMARY_REGION"
```

**Or** one step:

```bash
bash scripts/deployment/render-task-defs.sh --register
```

(requires the same env vars as §8.3.)

On success, note the **`taskDefinitionArn`** / **revision** in the output.

---

## 8.5 Verify task definitions

```bash
aws ecs list-task-definitions --family-prefix hyrelog-api --region "$PRIMARY_REGION" --sort DESC --max-items 1
aws ecs list-task-definitions --family-prefix hyrelog-worker --region "$PRIMARY_REGION" --sort DESC --max-items 1
aws ecs list-task-definitions --family-prefix hyrelog-dashboard --region "$PRIMARY_REGION" --sort DESC --max-items 1
```

---

## Phase 8 completion checklist

- [ ] Cluster **`${PROJECT_PREFIX}-ecs`** exists in **`$PRIMARY_REGION`**.
- [ ] Three task definition **families** registered with at least revision **`:1`** (or higher).
- [ ] Task definitions reference the **correct ECR image URI + tag** and **execution/task role** ARNs that exist in IAM.

---

# Phase 9 — ACM, ALB, and Route 53

Phase 9 exposes **HTTPS** on a load balancer and points DNS at it. **ECS tasks are not attached yet** until Phase 10; target groups may show **unhealthy** or **empty** until services run.

If you are moving **all DNS from Cloudflare into Route 53** (MX, `www`, ACM, ALB), follow **`docs/deployment/MIGRATE_DNS_CLOUDFLARE_TO_ROUTE53.md`** first so your hosted zone and validation records exist **before** delegating nameservers at the registrar.

---

## 9.0 ACM certificate (same region as ALB)

For ALB in **`$PRIMARY_REGION`**, request the certificate **in that same region** (not `us-east-1` unless your ALB is there — that region is required for **CloudFront**, not for a regional ALB).

### Option A — Console

1. **ACM** (switch region to **`PRIMARY_REGION`**) → **Request** → **Request a public certificate**.
2. **Fully qualified domain names:**
   - `api.hyrelog.com`
   - `app.hyrelog.com`  
   Or use one name + **SAN** entries for the other (or a wildcard `*.hyrelog.com` if that matches your DNS plan).
3. **Validation:** DNS validation (recommended).
4. If the wizard asks for **key algorithm**, use **RSA 2048** (default) unless your org standardizes on **ECDSA P-256** / **P-384** — both work with Application Load Balancer.
5. **Private key / export:** For a normal **Amazon-issued public** certificate, ACM **keeps** the private key and attaches the cert to ALB; you **do not** need to export the key for this runbook. **Do not** enable export unless you have a **separate** requirement to use the same key **outside** AWS (unusual for HyreLog). If your console only offers “request” + DNS validation with no export toggle, that’s expected.
6. Request.

### Option B — CLI

```bash
aws acm request-certificate \
  --domain-name api.hyrelog.com \
  --subject-alternative-names app.hyrelog.com \
  --validation-method DNS \
  --key-algorithm RSA_2048 \
  --region "$PRIMARY_REGION"
```

(`RSA_2048` is the default if you omit `--key-algorithm`. Other valid values include `EC_prime256v1` and `EC_secp384r1` for ECDSA.)

Save the **CertificateArn** from the output.

---

## 9.1 Complete DNS validation for ACM

1. In **ACM** → select the certificate → **Domains** → copy the **CNAME** name and value for each domain.
2. In **Route 53** (hosted zone for `hyrelog.com`) → **Create record** → type **CNAME** as ACM specifies (name/value often include `_acme-challenge` style records — paste exactly).
3. Wait until ACM status is **Issued** (can take several minutes).

Check:

```bash
aws acm describe-certificate \
  --certificate-arn "arn:aws:acm:${PRIMARY_REGION}:${AWS_ACCOUNT_ID}:certificate/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \
  --region "$PRIMARY_REGION" \
  --query 'Certificate.Status' --output text
```

Do **not** attach the certificate to a listener until it shows **ISSUED**.

---

## 9.2 Security groups (before ALB)

Create or identify:

1. **`sg-alb`**  
   - Inbound: TCP **443** from `0.0.0.0/0` (and optionally **80** if you redirect HTTP→HTTPS).  
   - Outbound: allow to ECS tasks on **3000** (or allow all to `sg-ecs` — see below).

2. **`sg-ecs`** (tasks)  
   - Inbound: TCP **3000** **only** from **`sg-alb`** (source type: security group).  
   - Outbound: allow HTTPS to internet (for AWS APIs, npm if needed), **or** minimal rules per your design; typically **NAT** for private subnets.

**Worker** tasks do not need ALB traffic; they still need **`sg-ecs`** (or a dedicated worker SG) for **outbound** to RDS/S3/secrets per your network design.

---

## 9.3 Create target groups (IP mode, HTTP)

Fargate uses **IP** target type (not instance).

### API target group

- **Target type:** IP  
- **Protocol:** HTTP  
- **Port:** **3000** (matches API container `containerPort`)  
- **VPC:** `PRIMARY_VPC_ID`  
- **Health check path:** **`/health`**  
- **Health check success codes:** **200**

### Dashboard target group

- Same VPC, protocol HTTP, port **3000**.  
- **Health check path:** **`/`** or a lightweight route your Next.js app responds to quickly (if `/` is slow or redirects, add `/api/health` in the app and point the health check there).

### CLI example (adjust VPC ID and names)

Git Bash on Windows rewrites **`/health`** into **`C:/Program Files/Git/health`**. Prefix the command with **`MSYS_NO_PATHCONV=1`**, use **`--health-check-path="//health"`** (double slash), use **PowerShell**, or **`export MSYS_NO_PATHCONV=1`** for the shell session — same pattern as **`/ecs/...`** log groups elsewhere in this runbook.

```bash
export PRIMARY_VPC_ID="vpc-xxxxxxxx"
export PRIMARY_REGION="ap-southeast-2"

MSYS_NO_PATHCONV=1 aws elbv2 create-target-group \
  --name hyrelog-api-tg \
  --protocol HTTP \
  --port 3000 \
  --vpc-id "$PRIMARY_VPC_ID" \
  --target-type ip \
  --health-check-path "/health" \
  --health-check-interval-seconds 30 \
  --region "$PRIMARY_REGION"

MSYS_NO_PATHCONV=1 aws elbv2 create-target-group \
  --name hyrelog-dashboard-tg \
  --protocol HTTP \
  --port 3000 \
  --vpc-id "$PRIMARY_VPC_ID" \
  --target-type ip \
  --health-check-path "/" \
  --health-check-interval-seconds 30 \
  --region "$PRIMARY_REGION"
```

Save **`TargetGroupArn`** for each.

---

## 9.4 Create Application Load Balancer

Use one ALB for both `api.hyrelog.com` and `app.hyrelog.com` (host-based routing in §9.5).

### Recommended naming

- **Load balancer name:** `hyrelog-prod-alb`
- **Target groups:** keep `hyrelog-api-tg` and `hyrelog-dashboard-tg` from §9.3
- **Security group:** `hyrelog-prod-alb-sg` (`sg-alb` in this guide)

### Console steps (exact fields)

1. **EC2** → **Load Balancers** → **Create Load Balancer** → **Application Load Balancer**.
2. **Basic configuration**
   - **Load balancer name:** `hyrelog-prod-alb` (or `${PROJECT_PREFIX}-alb`)
   - **Scheme:** `Internet-facing`
   - **IP address type:** `IPv4` (choose dualstack only if you are intentionally enabling IPv6)
3. **Network mapping**
   - **VPC:** your primary app VPC (`PRIMARY_VPC_ID`)
   - **Mappings:** pick at least **2 public subnets** across different AZs (`PRIMARY_PUBLIC_SUBNET_1`, `PRIMARY_PUBLIC_SUBNET_2`)
4. **Security groups**
   - Attach only **`sg-alb`** (`hyrelog-prod-alb-sg`)
5. **Listeners and routing**
   - If your ACM cert is already **Issued**, add listener **HTTPS : 443** now.
   - Add listener **HTTP : 80** now if you want immediate redirect in §9.6.
   - If the wizard asks for a default action, pick a temporary forward target (for example `hyrelog-api-tg`) and change it in §9.5 after host rules are added.
6. **Create load balancer**.

### Defaults to keep vs change

| Setting | What to do |
|--------|-------------|
| Deletion protection | Keep **off** while building; enable after first stable production deploy |
| HTTP/2 | Keep default (**on**) |
| Cross-zone load balancing | Keep default (**on** for ALB) |
| WAF | Leave unset for now unless you already use AWS WAF |
| Access logs | Optional now; can enable later to S3 when operations hardening starts |
| Idle timeout | Keep default initially; tune later if long requests need it |

### CLI sketch (advanced)

Use `aws elbv2 create-load-balancer` with `--subnets` and `--security-groups`; then create listeners as below.

---

## 9.5 HTTPS listener (443) + default action

### Console steps (exact)

1. Open **EC2** → **Load Balancers** → select `hyrelog-prod-alb`.
2. Open **Listeners and rules** tab.
3. If no HTTPS listener exists, choose **Add listener**:
   - **Protocol:** `HTTPS`
   - **Port:** `443`
4. **Default SSL/TLS certificate**
   - Choose **From ACM**
   - Select your `api.hyrelog.com` + `app.hyrelog.com` certificate (status must be **Issued** in `PRIMARY_REGION`)
5. **Default action** (recommended while configuring rules)
   - Choose **Fixed response**
   - **Status code:** `404`
   - **Content type:** `text/plain`
   - **Message body:** `No matching host rule`
   This prevents accidentally routing unknown hostnames to one app.
6. Save listener.

### Host-based routing rules

Add **rules** on listener **443**:

| Priority | Condition | Forward to |
|----------|-----------|------------|
| 1 | Host header **`api.hyrelog.com`** | API target group |
| 2 | Host header **`app.hyrelog.com`** | Dashboard target group |

**Rule evaluation order:** most specific host rules before a generic default.

### Click path to create each rule

1. On listener **HTTPS:443**, choose **View/edit rules**.
2. Choose **Insert rule** (before default) and create API rule:
   - **Condition:** Host header is `api.hyrelog.com`
   - **Action:** Forward to `hyrelog-api-tg`
   - **Priority:** `1`
3. Create dashboard rule:
   - **Condition:** Host header is `app.hyrelog.com`
   - **Action:** Forward to `hyrelog-dashboard-tg`
   - **Priority:** `2`
4. Keep **default rule** as the fixed `404` response (or your temporary fallback).
5. Save changes.

### Optional hardening on listener 443

- **Security policy:** keep AWS default initially; if available, prefer a modern TLS policy such as `ELBSecurityPolicy-TLS13-1-2-2021-06`.
- **HTTP header handling / advanced settings:** leave default unless you have explicit compliance requirements.

---

## 9.6 Optional: HTTP → HTTPS redirect (port 80)

Add listener **HTTP:80** with this exact action:

- **Action type:** Redirect
- **Protocol:** `HTTPS`
- **Port:** `443`
- **Host:** `#{host}`
- **Path:** `/#{path}`
- **Query:** `#{query}`
- **Status code:** `HTTP_301`

This preserves host/path/query and forces TLS for users who type `http://`.

---

## 9.7 Route 53 alias records

In the **Route 53 hosted zone** for `hyrelog.com`:

1. **Create record**  
   - **Record name:** `api`  
   - **Record type:** **A** (and **AAAA** if using dual-stack ALB)  
   - **Alias:** yes → **Alias to Application Load Balancer** → choose your ALB.

2. Repeat for **`app`** (dashboard).

Both can point to the **same ALB**; the ALB routes by **Host** header.

Propagation may take a few minutes.

---

## 9.8 Verify (before Phase 10)

These checks confirm **Phase 9** infrastructure only:

```bash
# ALB DNS name (curl will not hit your API yet until ECS registers healthy targets)
aws elbv2 describe-load-balancers --region "$PRIMARY_REGION" \
  --query 'LoadBalancers[?contains(LoadBalancerName, `hyrelog`) || contains(DNSName, `elb`)].DNSName' --output text
```

```bash
dig +short api.hyrelog.com
dig +short app.hyrelog.com
```

Expect resolution toward **ALB** addresses (or CNAME chains).  
**HTTPS** to `https://api.hyrelog.com/health` may return **502/503** until Phase 10 runs tasks — that is normal.

---

## Phase 9 completion checklist

- [ ] ACM certificate **ISSUED** in **`PRIMARY_REGION`** for `api` + `app` hostnames.
- [ ] ALB in **public subnets**, **`sg-alb`** attached.
- [ ] Two **target groups** (API + dashboard), HTTP port **3000**, health paths set.
- [ ] Listener **443** with ACM cert; **host rules** route `api` / `app` to correct TG.
- [ ] Optional: listener **80** → redirect to **443**.
- [ ] Route 53 **alias** records for `api` and `app` → ALB.
- [ ] **`sg-ecs`** allows **3000** from **`sg-alb`** (Phase 10 will use this SG on ECS services).

---

## What to do next — Phase 10 (pointer only)

1. Create ECS **services** for `hyrelog-api`, `hyrelog-dashboard`, `hyrelog-worker` in cluster **`${PROJECT_PREFIX}-ecs`**.  
2. Assign **private subnets**, **`sg-ecs`**, **Fargate** launch type.  
3. For API and dashboard services: attach to the **correct target group** (load balancer integration).  
4. Worker: **no** load balancer; still needs subnets + SG for outbound access.  
5. Wait for **tasks RUNNING** and target group **healthy**.

See **`STEP_BY_STEP_AWS.md`** Phase 10 and **`scripts/deployment/update-ecs-services.sh`** (after services exist).

---

## Quick reference — naming used in this repo

| Item | Typical name |
|------|----------------|
| Cluster | `hyrelog-prod-ecs` |
| Execution role | `hyrelog-prod-ecs-execution-role` |
| Task role | `hyrelog-prod-ecs-task-role` |
| Task families | `hyrelog-api`, `hyrelog-worker`, `hyrelog-dashboard` |
| ECS services (Phase 10) | same as family names in examples |

---

## Related documents

- `docs/deployment/STEP_BY_STEP_AWS.md` — full phase list and IAM/network detail  
- `docs/deployment/PHASE_6_7_BEGINNER_RUNBOOK.md` — secrets + ECR + image tag  
- `docs/deployment/aws-production-guide.md` — ALB / Route 53 overview  
- `infra/ecs/README.md` — task definition placeholders  
- `scripts/deployment/render-task-defs.sh` — render + optional `--register`
