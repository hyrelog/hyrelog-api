# HyreLog API Architecture

## API plane: single URL, backend region routing

The API is exposed as **one public URL**. There are no per-region URLs (e.g. `api-us.hyrelog.com` vs `api-eu.hyrelog.com`). Region is chosen **inside the backend** per request:

- **Customer requests** (Bearer API key): The API key is looked up (with cross-region key lookup if needed). The key’s company has a `dataRegion` (US, EU, UK, AU). The backend uses that to select the correct Postgres database and S3 bucket for that request.
- **Dashboard requests** (`x-dashboard-token` + `x-company-id`): The company’s `dataRegion` is read from the API’s tenant data; the backend then uses the matching regional DB and S3 for that company.

So: **single API URL → backend routes each request to the right region (and thus the right data store) based on company/workspace.**

---

## Dashboard as source of truth for tenants and keys

- **Tenant information** (companies, workspaces, projects, plans, members) is managed in the **dashboard**. The dashboard is the source of truth; it calls the API’s dashboard endpoints (with the dashboard service token) to create/update tenant and key data in the API’s backend.
- **Key management** (create company keys, create/revoke/rotate workspace keys) is done **only in the dashboard**. Keys are created or updated in the dashboard UI; the dashboard then syncs that state to the API backend via dashboard-only endpoints (e.g. `/dashboard/...`). End-users do **not** create or rotate keys via the public API (`/v1/...`); they use the dashboard and copy keys from there into their apps/env.

This keeps high-privilege operations (key creation, revocation, rotation) behind dashboard auth and audit, and avoids exposing them on the public API.

---

## Where the API stores tenant metadata

Tenant metadata (companies, workspaces, projects, API keys, plans, etc.) is stored in **Postgres per region**—not in a single global DB and not in-memory only.

- The API has **four regional Postgres databases** (US, EU, UK, AU). Each has the **same schema** (Company, Workspace, ApiKey, AuditEvent, etc.).
- A company’s data lives in **exactly one** region: the one matching its `dataRegion`. There is **no replication** of the same company across regions; each company exists in one region’s DB only.
- Key lookup (e.g. for `Authorization: Bearer <key>`): Keys have a **region in the prefix** (e.g. `hlk_us_co_...`, `hlk_au_ws_...`), so the API tries that region’s DB first, then falls back to the others; results are cached. Legacy keys without a region prefix trigger a full cross-region search.
- So: **one Postgres per region**, one copy of each tenant’s metadata in that tenant’s region. No global tenant DB, no in-memory-only tenant store.

---

## Dashboard → API push: synchronous

Dashboard-to-API calls (e.g. create company, create workspace, create/revoke API key) are **synchronous** from the UI’s point of view: the dashboard backend calls the API (e.g. `POST /dashboard/companies`), **waits for the API response**, then returns to the user. The user waits for that round-trip. There is no queue or fire-and-forget in the current design—if the API is slow or down, the user sees the delay or error.

---

## Tenant identifiers in the API plane

The API stores **two kinds** of tenant identifiers for companies and workspaces:

- **API internal IDs** (`Company.id`, `Workspace.id`): UUIDs generated and owned by the API. These are the **stable tenant identifiers** used everywhere inside the API (relations, events, keys, exports, etc.). When the dashboard or docs refer to “apiCompanyId” / “apiWorkspaceId”, they mean these fields.

- **Dashboard IDs** (`Company.dashboardCompanyId`, `Workspace.dashboardWorkspaceId`): Optional, unique. Set when the dashboard creates or syncs a company/workspace. Used for **idempotency and sync** (e.g. “upsert by dashboard company ID so we don’t duplicate if the dashboard retries”). The dashboard is the source of truth; these fields link the API row to the dashboard’s tenant.

**Recommendation in use:**  
- Use **dashboard company/workspace IDs** when the dashboard is pushing data (create/update) so the API can dedupe and stay in sync.  
- Use **API company/workspace IDs** for all internal API relationships, responses, and event/export data.

---

## API key prefix format

API keys use a **region-scoped prefix** so lookup can target one region first:

- **Format:** `hlk_{region}_{scope}_{random}...`  
  - `region`: `us`, `eu`, `uk`, `au` (company’s `dataRegion`).  
  - `scope`: `co` (company key) or `ws` (workspace key).  
- **Examples:** `hlk_us_co_a1b2c3d4...`, `hlk_au_ws_...`.  
- **Legacy:** Keys starting with `hlk_co_` or `hlk_ws_` (no region) are still valid; the API searches all regions for them.
