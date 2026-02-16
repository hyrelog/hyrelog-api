# Postman Environment Variables Setup Guide

This guide explains where to get each environment variable value.

## ⚠️ Common Issue: Variables Not Working

If you're getting "Invalid API key" errors, check:

1. **Environment is selected:** Top right dropdown should show "HyreLog Local"
2. **Variable has a value:** Check that `company_key` is not empty
3. **Full key copied:** Must be the complete key (starts with `hlk_co_` or `hlk_ws_`), not just the prefix
4. **Authorization format:** Should be `Bearer {{company_key}}` (not just `{{company_key}}`)

See `TROUBLESHOOTING.md` for detailed troubleshooting steps.

## Initial Setup (from seed output)

After running `npm run seed`, you'll see output like this:

```
🔑 API Keys (save these - shown only once!):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPANY KEY (read/export across all workspaces):
hlk_co_abc123...

WORKSPACE KEY (ingest + read within workspace):
hlk_ws_xyz789...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ Seeding complete!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Company Information:
   Company ID: 123e4567-e89b-12d3-a456-426614174000
   Workspace ID: 223e4567-e89b-12d3-a456-426614174001
   Project ID: 323e4567-e89b-12d3-a456-426614174002
   Plan Tier: GROWTH
   Billing Status: TRIALING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Set these immediately:**

- `company_key` = `hlk_co_abc123...` (the full key)
- `workspace_key` = `hlk_ws_xyz789...` (the full key)
- `company_id` = `123e4567-e89b-12d3-a456-426614174000`
- `workspace_id` = `223e4567-e89b-12d3-a456-426614174001`
- `project_id` = `323e4567-e89b-12d3-a456-426614174002`
- `plan_tier` = `GROWTH` (or whatever plan you seeded with)

## Getting `key_id`

The `key_id` is needed for key rotation operations.

### Method 1: From Get Key Status

1. In Postman, go to `V1 API > Keys > Get Key Status`
2. Send the request (uses your `company_key` or `workspace_key`)
3. In the response, copy the `id` field:
   ```json
   {
     "id": "456e7890-e89b-12d3-a456-426614174003",
     "prefix": "hlk_co_abc123",
     "scope": "COMPANY",
     ...
   }
   ```
4. Set `key_id` = `456e7890-e89b-12d3-a456-426614174003`

### Method 2: From Create Workspace Key

1. In Postman, go to `V1 API > Keys > Create Workspace Key`
2. Send the request (requires company key with IP allowlist)
3. In the response, copy the `id` field:
   ```json
   {
     "apiKey": "hlk_ws_newkey...",
     "id": "789e0123-e89b-12d3-a456-426614174004",
     ...
   }
   ```
4. Set `key_id` = `789e0123-e89b-12d3-a456-426614174004`

## Getting `webhook_id`

The `webhook_id` is needed for webhook management operations (enable, disable, view deliveries).

### Method 1: From Create Webhook

1. **Prerequisites:**
   - Company must be on GROWTH or ENTERPRISE plan
   - Company key must have IP allowlist configured

2. In Postman, go to `V1 API > Webhooks > Create Webhook`
3. Update the request body:
   ```json
   {
     "url": "http://localhost:3001",
     "events": ["AUDIT_EVENT_CREATED"]
   }
   ```
4. Send the request
5. In the response, copy the `id` field:
   ```json
   {
     "id": "abc12345-e89b-12d3-a456-426614174005",
     "url": "http://localhost:3001",
     "status": "ACTIVE",
     "secret": "whsec_...",
     ...
   }
   ```
6. Set `webhook_id` = `abc12345-e89b-12d3-a456-426614174005`

### Method 2: From List Webhooks

1. In Postman, go to `V1 API > Webhooks > List Webhooks`
2. Send the request
3. In the response, find any webhook and copy its `id`:
   ```json
   {
     "webhooks": [
       {
         "id": "abc12345-e89b-12d3-a456-426614174005",
         "url": "http://localhost:3001",
         ...
       }
     ]
   }
   ```
4. Set `webhook_id` = `abc12345-e89b-12d3-a456-426614174005`

## Getting `webhook_secret`

⚠️ **CRITICAL:** The `webhook_secret` is **only shown once** when you create a webhook!

### Steps:

1. **Create a webhook** (see "Getting webhook_id" above)
2. **Immediately copy the `secret` field** from the response:
   ```json
   {
     "id": "abc12345-e89b-12d3-a456-426614174005",
     "url": "http://localhost:3001",
     "secret": "whsec_abc123xyz789...",  ← COPY THIS IMMEDIATELY!
     ...
   }
   ```
3. **Set `webhook_secret`** = `whsec_abc123xyz789...` in Postman environment
4. **Save it somewhere safe** - you won't be able to retrieve it again!

### What if I lost the secret?

If you lose the webhook secret:

1. You **cannot** retrieve it from the API (it's encrypted in the database)
2. You have two options:
   - **Option A:** Create a new webhook (and save the secret this time!)
   - **Option B:** If you're using it for signature verification, you can disable the old webhook and create a new one

### Using the Secret

The secret is used to verify webhook signatures. In your webhook receiver:

```javascript
const crypto = require('crypto');

const signature = req.headers['x-hyrelog-signature']; // Format: "v1=<hex>"
const secret = process.env.WEBHOOK_SECRET; // From Postman environment
const body = JSON.stringify(req.body);

const providedSig = signature.replace(/^v1=/, '');
const computedSig = crypto.createHmac('sha256', secret).update(body).digest('hex');

if (providedSig === computedSig) {
  // Signature is valid!
}
```

## Dashboard API Variables

Required for **Dashboard** folder (all `/dashboard/*` requests):

| Variable                 | Where to Get                                      | When to Set                    | Required?   |
| ------------------------ | ------------------------------------------------- | ------------------------------ | ----------- |
| `dashboard_token`        | API `.env`: `DASHBOARD_SERVICE_TOKEN`              | Before any Dashboard request   | ✅ Yes      |
| `dashboard_company_id`   | Your dashboard app company UUID (or generate new) | Provision Company / reconcile  | For Dashboard companies/workspaces |
| `dashboard_workspace_id` | Your dashboard app workspace UUID                 | Provision Workspace, archive   | For workspaces |
| `api_company_id`         | **Provision Company** response: `apiCompanyId`     | After first Provision Company  | For x-company-id routes |
| `api_workspace_id`       | **Provision Workspace** response: `apiWorkspaceId` | Optional                       | ❌ Optional |
| `dashboard_key_id`       | Your dashboard app API key record UUID            | Sync Key, Revoke Key           | For key sync/revoke |
| `archive_id`             | Archive object UUID (from export/archive context) | Create Restore Request         | ❌ Optional |
| `restore_request_id`     | Create Restore Request or List response: `id`     | Get/Cancel/Approve/Reject       | ❌ Optional |
| `plan_id`                | **Admin > List Plans** response: plan `id`        | Assign Plan to Company         | ❌ Optional |

**Note:** For company-scoped Dashboard routes (GET Company, GET Events, Export, Webhooks, Restore), set `x-company-id` to `api_company_id` (or dashboard company id). The collection uses `{{api_company_id}}` in those request headers.

## Quick Reference Table (V1 + Dashboard)

| Variable                 | Where to Get                             | When to Set                        | Required?   |
| ------------------------ | ---------------------------------------- | ---------------------------------- | ----------- |
| `company_key`            | Seed output                              | Immediately after seeding          | ✅ V1       |
| `workspace_key`          | Seed output                              | Immediately after seeding          | ✅ V1       |
| `company_id`             | Seed output                              | Immediately after seeding          | ✅ V1       |
| `workspace_id`           | Seed output                              | Immediately after seeding          | ✅ V1       |
| `project_id`             | Seed output                              | Immediately after seeding          | ✅ V1       |
| `plan_tier`              | Seed output                              | Immediately after seeding          | ✅ V1       |
| `dashboard_token`        | API .env DASHBOARD_SERVICE_TOKEN         | Before Dashboard requests          | ✅ Dashboard |
| `api_company_id`         | Provision Company response               | After Provision Company             | For company-scoped Dashboard |
| `key_id`                 | Get Key Status or Create Key response    | When you need to rotate a key      | ❌ Optional |
| `webhook_id`             | Create Webhook or List Webhooks response | When you create a webhook          | ❌ Optional |
| `webhook_secret`         | Create Webhook response (only once!)     | Immediately after creating webhook | ❌ Optional |
| `dashboard_company_id`   | Dashboard app / new UUID                 | Provision Company, GET company     | For Dashboard |
| `dashboard_workspace_id` | Dashboard app / new UUID                 | Provision Workspace, archive       | For Dashboard |
| `dashboard_key_id`       | Dashboard app key record id              | Sync/Revoke key                    | ❌ Optional |

## Pro Tip: Auto-extract with Postman Tests

You can automatically extract these values using Postman's "Tests" tab:

### Auto-extract `webhook_id` and `webhook_secret`:

In the **Create Webhook** request, go to the **Tests** tab and add:

```javascript
if (pm.response.code === 201) {
  const json = pm.response.json();
  pm.environment.set('webhook_id', json.id);
  pm.environment.set('webhook_secret', json.secret);
  console.log('✅ Webhook ID and secret saved to environment');
}
```

### Auto-extract `key_id`:

In the **Get Key Status** request, go to the **Tests** tab and add:

```javascript
if (pm.response.code === 200) {
  const json = pm.response.json();
  pm.environment.set('key_id', json.id);
  console.log('✅ Key ID saved to environment');
}
```

This way, the values are automatically saved when you make the requests!
