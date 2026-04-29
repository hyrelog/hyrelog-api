# DBeaver + SSM Bastion Tunnel Runbook (Private RDS)

Use this to connect DBeaver to private RDS databases through a bastion EC2 instance using AWS Systems Manager (SSM), without opening RDS publicly.

This covers your HyreLog production-style setup end to end:

- dashboard DB
- API US DB
- API EU DB
- API UK DB
- API AU DB

---

## 0) What you need

- AWS CLI configured and authenticated
- Session Manager plugin installed
- IAM permissions for:
  - `ssm:StartSession`
  - `ssm:TerminateSession`
  - `ec2:DescribeInstances`
  - `rds:DescribeDBInstances`
- One running bastion EC2 instance in VPC (managed by SSM)
- DBeaver installed
- DB credentials (typically from Secrets Manager)

---

## 0.1) IAM permissions (your laptop identity vs. the bastion)

Two different IAM setups are involved:

| Who | What they need |
|-----|----------------|
| **Your AWS identity** (IAM user, or IAM Identity Center / SSO role you use with `aws sso login`) | Permission to run **`aws ssm start-session`** (port forward), describe EC2/RDS/SSM for discovery, and end sessions. |
| **The bastion EC2 instance** | An **instance profile** with **`AmazonSSMManagedInstanceCore`** (or equivalent) so SSM can reach the host. This is **not** the same as your user policy — it is attached to the **instance**, not to you. |

### Minimum actions for *your* identity

The bullets in §0 map to the JSON in **`docs/deployment/iam-dbeaver-ssm-operator-policy.json`** (account **`163436765242`**, region **`ap-southeast-2`**). That file also includes **`ssm:DescribeInstanceInformation`**, which §3 uses when listing SSM-managed instances — add it if you omit it and get **AccessDenied** on **`describe-instance-information`**.

- **`ssm:StartSession`** — must allow both:
  - The **bastion instance** (`arn:aws:ec2:…:instance/…` or `…:instance/*` if you accept broader scope).
  - The **AWS-managed SSM document** for port forwarding to a remote host:  
    `arn:aws:ssm:ap-southeast-2::document/AWS-StartPortForwardingSessionToRemoteHost`  
    (note the **empty account** in `::document` for AWS-owned documents).
- **`ssm:TerminateSession`** — usually **`Resource": "*"`** so you can stop sessions by ID.
- **`ec2:DescribeInstances`**, **`rds:DescribeDBInstances`** — read-only discovery (`Resource: "*"` is typical).

Tighten **`ssm:StartSession`** later by replacing **`instance/*`** with your bastion’s **`i-…`** ARN only.

### How to attach this policy

**A) Long-lived IAM user (access keys / `aws configure`)**

1. IAM → **Users** → your user → **Permissions** → **Add permissions** → **Create inline policy** → **JSON** → paste the contents of **`iam-dbeaver-ssm-operator-policy.json`**, or attach a **customer managed policy** with the same statements.
2. Or Git Bash (inline JSON, same pattern as `github-deploy-policy`):

```bash
cd /c/Users/kram/Dropbox/hyrelog/hyrelog-api/docs/deployment

aws iam put-user-policy \
  --user-name YOUR_IAM_USER_NAME \
  --policy-name dbeaver-ssm-operator \
  --policy-document "$(jq -c . iam-dbeaver-ssm-operator-policy.json)"
```

**B) IAM Identity Center (SSO)**

Policies are not attached with **`put-user-policy`**. An admin must add equivalent permissions to your **permission set** (IAM Identity Center → **Permission sets** → edit → **Customer managed policy** or inline policy). Use the same JSON as **`iam-dbeaver-ssm-operator-policy.json`**.

**C) Assume-role workflow**

If you use **`aws sts assume-role`**, attach the policy to that **role** instead:

```bash
aws iam put-role-policy \
  --role-name YOUR_ROLE_NAME \
  --policy-name dbeaver-ssm-operator \
  --policy-document "$(jq -c . iam-dbeaver-ssm-operator-policy.json)"
```

### Bastion EC2 (reminder)

Ensure the bastion has:

- **SSM Agent** running (Amazon Linux / recent Ubuntu AMIs include it).
- An **instance profile** with **`AmazonSSMManagedInstanceCore`** (and networking so SSM endpoints work — VPC endpoints or a route to the service).

Without that, **your** permissions are irrelevant; sessions will not start.

---

## 1) Verify local tools

Run in Git Bash or PowerShell:

```bash
aws --version
session-manager-plugin --version
aws sts get-caller-identity
```

If `session-manager-plugin` is missing, install it first:

- [AWS Session Manager plugin install docs](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)

---

## 2) Set baseline environment vars

```bash
export PRIMARY_REGION=ap-southeast-2
export AWS_DEFAULT_REGION=ap-southeast-2
```

Optional account check:

```bash
aws sts get-caller-identity --query '[Account,Arn]' --output text
```

---

## 3) Find bastion instance ID

### 3.1 List SSM-managed online instances

```bash
aws ssm describe-instance-information \
  --region "${PRIMARY_REGION}" \
  --query 'InstanceInformationList[?PingStatus==`Online`].[InstanceId,ComputerName,PlatformName,IPAddress]' \
  --output table
```

### 3.2 Find likely bastion in EC2 list

```bash
aws ec2 describe-instances \
  --region "${PRIMARY_REGION}" \
  --filters "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].[InstanceId,PrivateIpAddress,Tags[?Key==`Name`]|[0].Value]' \
  --output table
```

Choose your bastion instance ID and set:

```bash
export BASTION_INSTANCE_ID=i-REPLACE_ME
```

---

## 4) Get RDS endpoints

List likely DBs:

```bash
for r in ap-southeast-2 us-east-1 eu-west-1 eu-west-2; do
  echo "== $r =="
  aws rds describe-db-instances \
    --region "$r" \
    --query 'DBInstances[].[DBInstanceIdentifier,Endpoint.Address,Endpoint.Port,DBName,DBInstanceStatus]' \
    --output table
done
```

Set endpoint vars (replace with real values):

```bash
export DASHBOARD_RDS_HOST=dashboard-host.rds.amazonaws.com
export API_US_RDS_HOST=api-us-host.rds.amazonaws.com
export API_EU_RDS_HOST=api-eu-host.rds.amazonaws.com
export API_UK_RDS_HOST=api-uk-host.rds.amazonaws.com
export API_AU_RDS_HOST=api-au-host.rds.amazonaws.com
```

---

## 5) Choose local tunnel ports

Use fixed local ports so DBeaver configs stay stable:

- dashboard -> `15432`
- api-us -> `15433`
- api-eu -> `15434`
- api-uk -> `15435`
- api-au -> `15436`

---

## 6) Start SSM tunnels (one terminal per DB)

Open **five terminals** (or run one at a time). Keep each tunnel terminal open while using DBeaver.

### 6.1 Dashboard tunnel

```bash
aws ssm start-session \
  --region "${PRIMARY_REGION}" \
  --target "${BASTION_INSTANCE_ID}" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["'"${DASHBOARD_RDS_HOST}"'"],"portNumber":["5432"],"localPortNumber":["15432"]}'
```

### 6.2 API US tunnel

```bash
aws ssm start-session \
  --region "${PRIMARY_REGION}" \
  --target "${BASTION_INSTANCE_ID}" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["'"${API_US_RDS_HOST}"'"],"portNumber":["5432"],"localPortNumber":["15433"]}'
```

### 6.3 API EU tunnel

```bash
aws ssm start-session \
  --region "${PRIMARY_REGION}" \
  --target "${BASTION_INSTANCE_ID}" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["'"${API_EU_RDS_HOST}"'"],"portNumber":["5432"],"localPortNumber":["15434"]}'
```

### 6.4 API UK tunnel

```bash
aws ssm start-session \
  --region "${PRIMARY_REGION}" \
  --target "${BASTION_INSTANCE_ID}" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["'"${API_UK_RDS_HOST}"'"],"portNumber":["5432"],"localPortNumber":["15435"]}'
```

### 6.5 API AU tunnel

```bash
aws ssm start-session \
  --region "${PRIMARY_REGION}" \
  --target "${BASTION_INSTANCE_ID}" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["'"${API_AU_RDS_HOST}"'"],"portNumber":["5432"],"localPortNumber":["15436"]}'
```

---

## 7) Configure DBeaver connections

Create one PostgreSQL connection per DB.

For each connection in DBeaver:

1. **Database -> New Database Connection -> PostgreSQL**
2. Main:
   - Host: `127.0.0.1`
   - Port: one of `15432..15436`
   - Database: target DB name
   - Username/password: from secret
3. SSL:
   - Start with `require`
   - If your DB/user policies require strict cert validation, configure CA cert accordingly
4. Click **Test Connection**
5. Save

Recommended connection names:

- `prod-dashboard (15432)`
- `prod-api-us (15433)`
- `prod-api-eu (15434)`
- `prod-api-uk (15435)`
- `prod-api-au (15436)`

---

## 8) Validate DB access with SQL

### 8.1 API DBs (run on each of US/EU/UK/AU)

```sql
SELECT "planTier", COUNT(*) FROM plans GROUP BY "planTier" ORDER BY "planTier";
```

Expected tiers:

- FREE
- STARTER
- GROWTH
- ENTERPRISE

### 8.2 Dashboard DB

```sql
SELECT code, name, status FROM plans ORDER BY code;
SELECT code, name, "isActive" FROM addons ORDER BY code;
```

Expected plan codes:

- FREE
- STARTER
- PRO
- BUSINESS
- ENTERPRISE

Expected addon codes:

- ADDON_EXTRA_EVENTS
- ADDON_RETENTION_EXTENDED
- ADDON_EXTRA_SEATS
- ADDON_SSO
- ADDON_ADDITIONAL_REGION

---

## 9) Troubleshooting

## 9.1 Tunnel starts but DBeaver cannot connect

- Ensure tunnel terminal is still open
- Ensure DBeaver host is `127.0.0.1` (not RDS host)
- Confirm local port matches the tunnel command

## 9.2 `TargetNotConnected` / SSM errors

- Bastion is not SSM-managed/online
- SSM agent not running
- IAM permissions missing

## 9.3 `connection refused` / timeout

- Wrong RDS host
- Bastion SG/NACL route cannot reach DB SG
- RDS SG does not allow inbound from bastion or ECS/bastion SG

## 9.4 TLS/certificate errors

- Use SSL mode `require` first
- If strict validation required, import CA and use `verify-ca` / `verify-full`

---

## 10) Close tunnels

Stop each tunnel by pressing `Ctrl+C` in each tunnel terminal.

---

## 11) Security notes

- Do not store raw DB passwords in plaintext files committed to git.
- Prefer pulling creds from Secrets Manager when opening DBeaver connections.
- Close tunnels when not actively using them.

