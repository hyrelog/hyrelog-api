# Webhook E2E Test Guide (Local)

This guide validates webhook delivery end-to-end using:
- HyreLog API
- HyreLog worker
- Dashboard webhook test endpoint (`/api/webhooks/test`)
- Postman for API calls

## Prerequisites

- Docker services running (`docker compose up -d`)
- Databases migrated and seeded
- Valid API keys:
  - `COMPANY` key for webhook management
  - `WORKSPACE` key for event ingestion
- Dashboard running locally (default `http://localhost:4000`)
- API running locally (default `http://localhost:3000`)

## Run Commands (API + Worker + Dashboard)

Open separate terminals:

1) API

```bash
cd C:\Users\kram\Dropbox\hyrelog\hyrelog-api
npm run dev
```

2) Worker (required for delivery)

```bash
cd C:\Users\kram\Dropbox\hyrelog\hyrelog-api
npm run worker
```

3) Dashboard (for test endpoint)

```bash
cd C:\Users\kram\Dropbox\hyrelog\hyrelog-dashboard
npm run dev
```

## Why the worker is required

`POST /v1/events` creates webhook jobs (`PENDING`) but does not deliver them directly.  
The worker polls due jobs and performs HTTP delivery attempts.

If the worker is not running, jobs remain pending/retry-scheduled and the endpoint will never receive webhooks.

## Dashboard test endpoint

The receiver endpoint added in dashboard:

- `GET http://localhost:4000/api/webhooks/test` (health check)
- `POST http://localhost:4000/api/webhooks/test` (webhook receiver)

Optional protection:
- set `WEBHOOK_TEST_TOKEN` in dashboard env
- send header `x-webhook-test-token: <token>`

## Postman E2E flow

Use a Postman environment with:
- `baseUrl = http://localhost:3000`
- `workspaceId = <API workspace UUID (not dashboard DB workspace id)>`
- `companyKey = <hlk_*_co_...>`
- `workspaceKey = <hlk_*_ws_...>`

### Important: Which workspaceId to use

For `POST /v1/workspaces/:workspaceId/webhooks`, `:workspaceId` must be the **API workspace id**
stored in the API regional database (`workspaces.id`), not the dashboard database workspace id.

Quick ways to get the correct value:

1) From an ingested event response:
- `POST /v1/events` with a workspace key
- then `GET /v1/events?limit=1` and copy `data[0].workspaceId`

2) From dashboard DB mapping:
- use dashboard `workspace.apiWorkspaceId` (if provisioned)

### 1) Verify dashboard receiver is up

Request:
- `GET http://localhost:4000/api/webhooks/test`

Expected:
- `200` with `{ "ok": true, ... }`

### 2) Create webhook endpoint (company key)

Request:
- `POST {{baseUrl}}/v1/workspaces/{{workspaceId}}/webhooks`
- Headers:
  - `Authorization: Bearer {{companyKey}}`
  - `Content-Type: application/json`
- Body:

```json
{
  "url": "http://localhost:4000/api/webhooks/test",
  "events": ["AUDIT_EVENT_CREATED"],
  "projectId": null
}
```

Expected:
- `201`
- Response includes webhook `id` and one-time `secret`

Save `id` as `webhookId`.

### 3) Ingest an event (workspace key)

Request:
- `POST {{baseUrl}}/v1/events`
- Headers:
  - `Authorization: Bearer {{workspaceKey}}`
  - `Content-Type: application/json`
- Body:

```json
{
  "category": "webhook-e2e",
  "action": "created",
  "actor": {
    "id": "user_webhook_test",
    "email": "webhook-test@example.com",
    "role": "admin"
  },
  "resource": {
    "type": "workspace",
    "id": "{{workspaceId}}"
  },
  "metadata": {
    "source": "postman-e2e"
  }
}
```

Expected:
- `201` with created event `id`

### 4) Verify job delivery status

Request:
- `GET {{baseUrl}}/v1/webhooks/{{webhookId}}/deliveries?limit=20`
- Header:
  - `Authorization: Bearer {{companyKey}}`

Expected:
- A recent delivery transitions to `SUCCEEDED`
- `attempt` increments as expected if retries occur

Response shape note:
- `/v1/webhooks/:webhookId/deliveries` returns `{ "data": [...], "nextCursor": ... }`
- `/dashboard/webhooks/:webhookId/deliveries` returns `{ "deliveries": [...] }`

If you are using Postman tests/scripts, read `data` for the `/v1` route.

### 5) Confirm receiver got payload

Check the dashboard terminal output for:
- `[webhook-test] received webhook ...`
- headers like:
  - `x-hyrelog-delivery-id`
  - `x-hyrelog-attempt`
  - `x-hyrelog-signature`
  - `x-trace-id`

## Dashboard-side checks

- Open dashboard dev logs and confirm receiver log line appears.
- In webhook management UI (if available), confirm endpoint and recent deliveries.
- If you created a token, verify requests without `x-webhook-test-token` return `401`.

## Troubleshooting

- **No delivery created**
  - Confirm company plan enables webhooks.
  - Confirm webhook endpoint is `ACTIVE`.
  - Confirm event workspace/project scope matches webhook scope.

- **Delivery stays pending/retry**
  - Ensure `npm run worker` is running.
  - Check worker terminal for webhook processing errors.

- **Receiver not reached**
  - Verify URL is reachable from API host.
  - For local dev, use `http://localhost:4000/api/webhooks/test`.
  - Verify dashboard is running.

- **403 when creating webhooks**
  - Must use `COMPANY` key.
  - Key management paths may require IP allowlist.

- **403 when ingesting events**
  - Must use `WORKSPACE` key for `POST /v1/events`.
