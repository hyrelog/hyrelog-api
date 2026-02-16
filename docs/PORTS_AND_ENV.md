# HyreLog — Ports and environment (local dev)

Single reference for **ports** and **env files** so API and Dashboard stay compatible.

---

## Ports (local)

| Service    | Port | URL                     |
|-----------|------|-------------------------|
| **API**   | 3000 | http://localhost:3000  |
| **Dashboard** | 4000 | http://localhost:4000 |

- **API** — HyreLog API backend (Fastify). Used by the Dashboard (server-side) and by Postman/custom clients.
- **Dashboard** — Next.js app (auth, companies, workspaces, keys UI). Users open this in the browser.

---

## Where it’s configured

### 1. API backend (hyrelog-api)

| What | Where |
|------|--------|
| **Port** | `hyrelog-api/.env` → `PORT=3000` (read by `services/api/src/lib/config.ts`) |
| **Dashboard auth** | `hyrelog-api/.env` → `DASHBOARD_SERVICE_TOKEN` (must match dashboard’s value) |
| **API key hashing** | `hyrelog-api/.env` → `API_KEY_SECRET` (dashboard uses same value as `HYRELOG_API_KEY_SECRET` for key sync) |

**File:** `hyrelog-api/.env`

### 2. Dashboard (hyrelog-dashboard)

| What | Where |
|------|--------|
| **Port** | `hyrelog-dashboard/package.json` → `"dev": "next dev -p 4000"` |
| **App URL (auth, public)** | `hyrelog-dashboard/.env` → `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL` = `http://localhost:4000` |
| **API URL (server)** | `hyrelog-dashboard/.env` → `HYRELOG_API_URL=http://localhost:3000` (Dashboard server calls API here) |
| **API URL (client)** | `hyrelog-dashboard/.env` → `NEXT_PUBLIC_API_BASE_URL=http://localhost:3000` (if the UI calls the API from the browser) |
| **Dashboard token** | `hyrelog-dashboard/.env` → `DASHBOARD_SERVICE_TOKEN` (must match API’s `DASHBOARD_SERVICE_TOKEN`) |
| **Key sync (optional)** | `hyrelog-dashboard/.env` → `HYRELOG_API_KEY_SECRET` (same as API’s `API_KEY_SECRET` for provisioning keys) |

**Files:** `hyrelog-dashboard/.env`, `hyrelog-dashboard/package.json` (dev script only)

### 3. Postman

| What | Where |
|------|--------|
| **API base URL** | `hyrelog-api/postman/HyreLog Local.postman_environment.json` → `base_url` = `http://localhost:3000` |

**File:** `hyrelog-api/postman/HyreLog Local.postman_environment.json`

---

## Checklist for compatibility

1. **API** `.env`: `PORT=3000`, `DASHBOARD_SERVICE_TOKEN` set.
2. **Dashboard** `.env`: `HYRELOG_API_URL=http://localhost:3000`, `BETTER_AUTH_URL=http://localhost:4000`, `NEXT_PUBLIC_APP_URL=http://localhost:4000`, `DASHBOARD_SERVICE_TOKEN` same as API.
3. **Dashboard** `package.json`: `"dev": "next dev -p 4000"`.
4. **Postman** (if used): environment `base_url` = `http://localhost:3000`.

To change the API port (e.g. to 5000): set `PORT=5000` in `hyrelog-api/.env` and set `HYRELOG_API_URL` and `NEXT_PUBLIC_API_BASE_URL` to `http://localhost:5000` in `hyrelog-dashboard/.env`, and update Postman `base_url`.

To change the Dashboard port: change `-p 4000` in `hyrelog-dashboard/package.json` and set `BETTER_AUTH_URL` and `NEXT_PUBLIC_APP_URL` to the new URL in `hyrelog-dashboard/.env`.
