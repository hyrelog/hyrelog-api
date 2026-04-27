# Dashboard auth 401 – debugging

## 1. Ensure you see the debug lines

When a request hits `POST /dashboard/companies`, the API auth hook writes **two lines to stderr** (they do not go through pino):

- `[DASHBOARD-AUTH] Hook entered for /dashboard/companies, checking token`
- `[DASHBOARD-AUTH] tokenLen=X expectedLen=Y reason=... fail=true|false`

**If you do NOT see these lines:**

- The running process is not using the updated code. Do this:
  1. Stop the API (Ctrl+C).
  2. From repo root: `cd hyrelog-api && npm run dev`  
     or from API package: `cd services/api && npm run dev`.
  3. Trigger onboarding again from the dashboard.
- Or the request is not reaching this server (e.g. wrong port, proxy, or client calling a different URL).

**If you DO see these lines:**

- `reason=header_missing` → request has no `x-dashboard-token` header (dashboard not sending it or wrong caller).
- `reason=token_mismatch` → header present but value does not match API’s `DASHBOARD_SERVICE_TOKEN`. Compare `tokenLen` and `expectedLen`; if they differ, the two env values are different. If they are the same, the strings still differ (e.g. extra character, encoding).
- `reason=ok` and `fail=false` → token accepted; 401 is coming from somewhere else (e.g. dashboard plugin or route).

## 2. Run the API so stderr is visible

- Run in a terminal (no background) so stderr is not hidden:
  ```bash
  cd hyrelog-api
  npm run dev
  ```
- Or run in background and tail the log file if you redirect:
  ```bash
  npm run dev 2>&1 | tee api.log
  ```

## 3. Env and token

- **API** `.env`: `DASHBOARD_SERVICE_TOKEN=<value>` (same as dashboard).
- **Dashboard** `.env`: `DASHBOARD_SERVICE_TOKEN=<same value>`, `HYRELOG_API_URL=http://localhost:3000` (or your API base URL).
- No spaces or quotes around the value; restart both apps after changing `.env`.
