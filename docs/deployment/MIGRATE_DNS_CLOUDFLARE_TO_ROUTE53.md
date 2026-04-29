# Migrate DNS from Cloudflare to Route 53 (full guide)

This guide walks through moving **authoritative DNS** for a domain such as **`hyrelog.com`** from **Cloudflare** to **AWS Route 53**, including **MX** (email), marketing **`www`**, apex/redirects, **TXT** (SPF/DKIM/DMARC), and AWS-specific records (**ACM validation**, **ALB** aliases).

It does **not** migrate your domain **registration** (unless you explicitly transfer the domain into Route 53 Registrar). You only change **which nameservers** answer DNS for the domain.

---

## Concepts (read once)

| Term | Meaning |
|------|---------|
| **Registrar** | Where you **paid** for `hyrelog.com` (e.g. Cloudflare Registrar, Namecheap). You change **nameservers** here during cutover. |
| **Authoritative DNS** | Who serves the **real** DNS records (`A`, `MX`, `CNAME`). After migration, that becomes **Route 53**, not Cloudflare DNS. |
| **Hosted zone** | Route 53 container that holds records for **`hyrelog.com`**. |
| **Delegation** | Registrar points to **four** Route 53 nameservers like `ns-123.awsdns-xx.com`. |

Cloudflare **proxy** (orange cloud) only applies while DNS is hosted at Cloudflare. After migration, **`api`** / **`app`** terminate TLS on **AWS ACM + ALB** unless you intentionally put another proxy in front.

---

## Risks and planning

1. **Email (MX)** — Wrong MX or missing TXT during cutover can **delay or lose mail**. Plan a **quiet window**, keep a **screenshot/export** of all records, and know how to **rollback** (revert NS at registrar to Cloudflare).  
2. **Downtime** — Usually minimal if records are copied **exactly** and TTLs were lowered beforehand.  
3. **Marketing `www`** — If Cloudflare proxied `www`, you must point **`www`** at the **real origin** (CNAME to Vercel/Netlify/etc., or A records your host provides). Copy what Cloudflare **ultimately** resolved to, or what your hosting docs say **without** Cloudflare proxy.  
4. **ACM certificates** — Validation uses **DNS CNAME** records. Those records must exist in **Route 53** **before** or **immediately after** delegating to Route 53, or ACM cannot stay validated. Easiest path: **recreate the same ACM validation CNAMEs** in Route 53 from the ACM console, then verify with `dig` against Route 53 NS **before** switching registrar NS.

---

## Phase A — Inventory (Cloudflare)

1. Log in to **Cloudflare** → select **`hyrelog.com`** → **DNS** → **Records**.
2. **Export or screenshot** every row. For each record capture:
   - **Type** (A, AAAA, CNAME, MX, TXT, NS, SRV, CAA, …)
   - **Name** / host (`@`, `www`, `api`, `_dmarc`, etc.)
   - **Content** / target / **priority** (for MX)
   - **TTL** (Auto → note actual or use 300 for migration)
   - **Proxy status** (orange vs grey) — **only affects traffic while on Cloudflare**; note whether `www` / apex were proxied.
3. Copy **non-DNS** Cloudflare settings you rely on:
   - **SSL/TLS** mode, **Page Rules**, **Redirects** — you will recreate redirects as **Route 53** cannot redirect HTTP; redirects live on **hosting**, **ALB rules**, or **CloudFront/S3** website redirect. List any rule like “`hyrelog.com` → `www`” so you reproduce it elsewhere.
4. **Email:** List **MX** rows exactly (priority + mail server hostname). List **TXT** for **SPF**, **DKIM** (often `selector._domainkey`), **DMARC** (`_dmarc`), **Google/Microsoft verification**, etc.

Save this as a **spreadsheet or markdown** — you will recreate it in Route 53.

---

## Phase B — Create a Route 53 public hosted zone

1. AWS Console → **Route 53** → **Hosted zones** → **Create hosted zone**.
2. **Domain name:** `hyrelog.com`
3. **Type:** **Public hosted zone**
4. Create.

Route 53 will show:

- **Nameservers** (four), e.g. `ns-1234.awsdns-56.org` — **you will give these to your registrar** at cutover.
- **NS** and **SOA** records inside the zone (leave default).

**Do not** change your registrar’s nameservers until **Phase F** — first populate records and test.

Optional CLI:

```bash
export DOMAIN="hyrelog.com"
export PRIMARY_REGION="ap-southeast-2"

aws route53 create-hosted-zone \
  --name "$DOMAIN" \
  --caller-reference "hyrelog-$(date +%s)" \
  --hosted-zone-config Comment="HyreLog production DNS" \
  --region "$PRIMARY_REGION"
```

Note **`DelegationSet`** / nameservers from the output or the console.

---

## Phase C — Recreate records in Route 53

Use the **console** (simplest), a **BIND zone file import** (fastest bulk), or **`aws route53 change-resource-record-sets`** (advanced).

### Option: import a BIND zone file (bulk paste)

HyreLog ships an example BIND fragment ready for Route 53 **Import zone file**:

- **`docs/deployment/dns-import/hyrelog.com.zone`** + instructions in **`docs/deployment/dns-import/README.md`**

Edit the `.zone` file if your IPs, Vercel targets, MX, or TXT proofs change; then Route 53 console → Hosted zone → **Import zone file** (see AWS: [Creating records by importing a zone file](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating-import.html)).

### General rules (manual entry)

- **Apex** `@` / `hyrelog.com` — use **A**, **AAAA**, or **Alias** (Route 53 alias to **ALB**, **CloudFront**, **API Gateway**, **S3 website**, etc.).  
- **`www`** — usually **CNAME** or **Alias** per your marketing host’s instructions.  
- **`api`** / **`app`** — after ALB exists (Phase 9), prefer **Alias A** to **ALB** (same region) or **CNAME** to ALB DNS name **if** your DNS provider allows CNAME on these names (Route 53 alias is cleaner for ALB).  
- **MX** — same **priority** and **hostname** as Cloudflare; multiple MX rows allowed.  
- **TXT** — long strings may need splitting per RFC (Route 53 console handles one string; very long SPF may use multiple TXT rows — mirror what you had).  
- **CAA** — if you used CAA at Cloudflare, copy so Let’s Encrypt / ACM issuance still allowed (`amazon.com` / `amazontrust.com` for ACM if needed).

### ACM DNS validation CNAMEs (do this during first deploy)

1. **ACM** (correct **region** for your ALB — see `PHASE_8_9_BEGINNER_RUNBOOK.md`) → open your **pending** or **issued** certificate → **Domains**.
2. For each domain, ACM shows **CNAME name** and **CNAME value**.

In Route 53 → **Create record**:

- **Record name:** paste ACM’s **name** (often a long `_xxxx` **subdomain** — Route 53 may let you paste the **relative** name under `hyrelog.com`).  
- **Record type:** **CNAME**  
- **Value:** ACM’s target (often ends in **acm-validations.aws.**)

**Important:** Name field must match what ACM expects publicly (sometimes you enter only the **left part** before `.hyrelog.com`).

3. Save. Repeat for **`api.hyrelog.com`** / **`app.hyrelog.com`** if they are separate SANs.

Wait until ACM status is **Issued** (same as current runbook).

### Marketing and apex (examples only — use *your* inventory)

| Goal | Typical Route 53 approach |
|------|---------------------------|
| `www.hyrelog.com` → hosting | **CNAME** `www` → `cname.vercel-dns.com` (example) **or** **A** records from host |
| Apex → `www` redirect | Not in DNS alone — use **S3 redirect bucket + CloudFront**, **ALB redirect**, or **hosting** redirect; DNS might point apex to those endpoints |
| Static marketing IP | **A** record `@` |

If you relied on **Cloudflare Workers** or **Page Rules** for redirects, replicate on **CloudFront**, **ALB**, or your **static host**.

---

## Phase D — Verify **before** changing nameservers (critical)

Route 53 is **not** yet public for the world, but you can query **Route 53’s** nameservers directly:

```bash
# Replace with YOUR four Route 53 delegation nameservers from the hosted zone
NS1="ns-xxxx.awsdns-xx.com"

dig +short MX hyrelog.com @$NS1
dig +short TXT hyrelog.com @$NS1
dig +short CNAME www.hyrelog.com @$NS1
dig +short CNAME _xxxxxxxx.hyrelog.com @$NS1
```

Fix any missing/wrong answers compared to Cloudflare **before** cutover.

---

## Phase E — Lower TTLs at Cloudflare (prep)

1. In Cloudflare DNS, set **TTL** to **300 seconds** (or lowest allowed) on important records **24–48 hours before** cutover (optional but reduces stale caching during switch).

---

## Phase F — Registrar nameserver cutover

This is the step that **moves** the internet from Cloudflare DNS to Route 53.

1. Open your **domain registrar** (where **nameservers** are edited):
   - If domain is registered **at Cloudflare**: **Cloudflare Dashboard** → **hyrelog.com** → **Manage** → **Configuration** → **DNS** section might show “Custom nameservers” — set to Route 53’s **four** NS from **Phase B**.
   - If registered **elsewhere** (Namecheap, Route 53 Registrar, etc.): find **Nameservers** → **Custom DNS** → enter the **four** Route 53 delegation NS **exactly** (copy/paste from Route 53 hosted zone details).

2. **Remove** reliance on Cloudflare’s nameservers (`*.ns.cloudflare.com`) — replace **entirely** with Route 53’s four.

3. Save. Propagation often takes **minutes to hours**; global caches can take up to **old TTL** (up to 48h in worst cases).

**Do not delete** the Cloudflare DNS zone until you confirm worldwide resolution (Phase G).

---

## Phase G — Post-cutover verification

From your laptop (not `@` specific NS):

```bash
dig NS hyrelog.com +short
```

You should see **Route 53** nameservers, not Cloudflare.

Then:

```bash
dig +short MX hyrelog.com
dig +short TXT hyrelog.com
dig +short www.hyrelog.com
curl -sI https://www.hyrelog.com | head -5
```

**Send a test email** to yourself. Check **SPF/DMARC** reports if you use them.

**ACM:** Confirm certificate still **Issued** in ACM (DNS validation records now live on Route 53).

---

## Phase H — ALB DNS records (`api`, `app`) — “new CNAME” / alias

After you create an **Application Load Balancer** (see `PHASE_8_9_BEGINNER_RUNBOOK.md` §9):

1. Note the ALB **DNS name**, e.g.  
   `hyrelog-prod-alb-xxxxxxxxx.ap-southeast-2.elb.amazonaws.com`.

2. In Route 53 → **Hosted zone** `hyrelog.com` → **Create record**:

**Recommended (Alias to ALB):**

- **Record name:** `api` (and repeat for `app`)
- **Record type:** **A** — toggle **Alias** → **Alias to Application and Classic Load Balancer**
- **Region:** same as ALB
- **Choose load balancer** …

Repeat for **`app`** pointing to same ALB **if** one ALB hosts both hostnames (listener rules route by Host header).

**Alternative (CNAME — works for subdomains only):**

- **Type:** **CNAME**
- **Name:** `api`
- **Value:** the ALB DNS name (must end with **.** in some tools: `xxx.elb.amazonaws.com.`)

**Do not** CNAME the **apex** `hyrelog.com` to ALB per DNS rules — use **Alias A** at apex if needed.

---

## Phase I — Cloudflare after migration

- **DNS at Cloudflare** for `hyrelog.com` is **ignored** once NS point to Route 53 (except any **secondary** use — there is none for public DNS).
- You may **delete** the Cloudflare zone for `hyrelog.com` **only after** Route 53 works everywhere **or** leave the zone unused (confusing). Cleaner to **remove** the site from Cloudflare or delete duplicate zone after ~72h stability.
- If you keep **Cloudflare Registrar**, that is fine — only **nameservers** changed.
- Any **paid Cloudflare features** tied to proxy (orange cloud) on `www` are **gone** unless you move `www` back behind Cloudflare using **partial setup** / **CNAME setup** — out of scope here.

---

## Rollback (if something breaks)

1. At **registrar**, set nameservers back to **Cloudflare’s** pair (shown in Cloudflare dashboard for the domain — typically `xxxx.ns.cloudflare.com`).  
2. Wait for TTL propagation.  
3. Fix Route 53 records offline, then retry cutover.

Keep Cloudflare DNS records **unchanged** until you confirm Route 53 is good, or restore from your **Phase A export**.

---

## Checklist summary

- [ ] **Phase A** — Full export from Cloudflare (MX, TXT, www, apex, mail security, redirects mental model).  
- [ ] **Phase B** — Route 53 **public hosted zone** for `hyrelog.com`; save **four delegation NS**.  
- [ ] **Phase C** — Recreate **all** records + **ACM validation** CNAMEs → **Issued**.  
- [ ] **Phase D** — `dig @route53-ns` for MX, TXT, www, ACM names.  
- [ ] **Phase E** — (Optional) lower TTLs at Cloudflare.  
- [ ] **Phase F** — Registrar → **Route 53 nameservers** only.  
- [ ] **Phase G** — Verify NS, mail, HTTPS, ACM.  
- [ ] **Phase H** — **Alias/CNAME** `api` / `app` → ALB.  
- [ ] **Phase I** — Retire duplicate Cloudflare DNS when stable.

---

## Related documents

- `docs/deployment/PHASE_8_9_BEGINNER_RUNBOOK.md` — ACM, ALB, ECS-oriented steps  
- `docs/deployment/STEP_BY_STEP_AWS.md` — broader phase list  
- [Route 53: Working with records](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html)  
- [Making Route 53 the DNS service](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/MigratingDNS.html)
