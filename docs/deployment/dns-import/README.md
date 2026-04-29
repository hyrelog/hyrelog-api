# Route 53 BIND zone import — `hyrelog.com`

## What this is

[`hyrelog.com.zone`](./hyrelog.com.zone) is a **BIND-style zone file fragment** compatible with Route 53 **Import zone file** (see [Creating records by importing a zone file](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating-import.html)).

## How to import

1. AWS Console → **Route 53** → **Hosted zones** → **Create hosted zone** → domain **`hyrelog.com`** → type **Public** → Create.  
   (Or open an **empty new** hosted zone with no conflicting records.)

2. Open the hosted zone → **Import zone file**.

3. Paste the **entire contents** of `hyrelog.com.zone` into the box → **Import**.

Route 53 **ignores** `SOA` in the file (if present) and **NS** records that match the zone apex; it assigns its own delegation NS automatically.

### Rules that matter

- Import **fails** if **any** record in the zone file already exists in the hosted zone (`CREATE` semantics). Resolve duplicates first.
- **`$TTL`** at the top sets the default TTL for records that omit TTL (this file keeps explicit TTLs where your export had them).
- **Multiple TXT** on **`_vercel`** are **three separate** `TXT` lines — required for multiple proofs.
- **Google DKIM** (`google._domainkey`) cannot be expressed in this import — add it **after** import (see **Google Workspace DKIM** below).

## Google Workspace DKIM (`google._domainkey`)

Route 53 **Import zone file** accepts only `$ORIGIN` and `$TTL` directives — **not** BIND features like parentheses or multi-string TXT (`"..." "..."` on one line, or **`(`** … **`)`** blocks). Anything else can fail with errors like **unsupported directive** or **too many values**.

Long Google DKIM records **must exceed 255 bytes** total and are normally split across multiple TXT character strings. The importer cannot express that cleanly, so:

1. Import **`hyrelog.com.zone`** as-is (it intentionally **omits** `google._domainkey`).
2. In Route 53 → Hosted zone **`hyrelog.com`** → **Create record**:
   - **Record name:** `google._domainkey`
   - **Record type:** **TXT**
   - **Value:** paste the **entire** contents of **`google-workspace-dkim-txt-value.txt`** (single line).
3. Confirm with **Google Admin** if you rotate keys — that file is a snapshot from your Cloudflare export.

Route 53’s UI usually splits the value into legal 255‑octet chunks for you when saving.

## What is **not** in this file

Add **after** the relevant AWS resources exist (see `PHASE_8_9_BEGINNER_RUNBOOK.md`):

- **ACM DNS validation** CNAME records (per certificate request).
- **`api.hyrelog.com`** (often **alias** to Application Load Balancer).
- **`app.hyrelog.com`** when moving the dashboard **from Vercel to ECS** (replace Vercel CNAME with alias to dashboard ALB or split traffic consciously).

Review MX records against **Google Admin** DNS instructions before production cutover (see comments in `.zone` file).

## Security

The zone file contains **verification tokens** and **DKIM material**. Treat it like credentials: prefer **private** fork or omit from git; rotate if leaked.
