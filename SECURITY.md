# Security Measures

This document describes the security measures implemented for API key management operations and plan enforcement.

## Overview

Key management operations are sensitive and require additional security measures beyond standard API authentication. This document outlines the restrictions and requirements.

## Security Restrictions

### Company Key Creation
- **Status**: Dashboard-only (not available via API)
- **Reason**: Company keys are high-privilege and should require:
  - Dashboard authentication (login + 2FA)
  - Visual confirmation
  - Proper audit trail with user identity

### Key Revocation
- **Status**: Dashboard-only (removed from API)
- **Reason**: Key revocation is destructive and should require:
  - Confirmation dialogs
  - Visual feedback
  - Clear audit trail
  - Prevention of accidental or malicious revocation

### Workspace Key Creation
- **Status**: Dashboard-only (not available via public API)
- **Reason**: Key management is done in the dashboard; the dashboard is the source of truth and syncs key data to the API backend. This ensures dashboard auth, audit trail, and confirmation flows for all key creation.

### Key Rotation
- **Status**: Dashboard-only (not available via public API)
- **Reason**: Same as workspace key creation—rotation is a sensitive operation and is performed in the dashboard, which then updates the API backend.

### Key Status Check
- **Status**: API-accessible (read-only, less restrictive)
- **Requirements**:
  - Standard API authentication
  - Standard rate limiting
  - Audit logging (lower priority)

## Implementation Details

### IP Allowlist Enforcement

Company keys used for key management operations must have an IP allowlist configured. The system:

1. Checks if the company key has an IP allowlist
2. Verifies the request IP is in the allowlist
3. Returns `403 FORBIDDEN` if IP allowlist is missing or IP is not allowed

**Error Messages:**
- Missing IP allowlist: `"Company keys used for key management must have IP allowlist configured. Please configure IP allowlist via dashboard."`
- IP not in allowlist: `"IP address {ip} is not in the API key's IP allowlist"`

### Rate Limiting

Key management operations use a stricter rate limit:
- **General API**: 1200 requests/minute per API key
- **Key Management**: 10 operations/minute per API key

Rate limit headers are included in all responses:
- `X-RateLimit-Limit`: Maximum requests per window
- `X-RateLimit-Remaining`: Remaining requests in current window
- `X-RateLimit-Reset`: ISO timestamp when the limit resets
- `Retry-After`: Seconds to wait before retrying (on 429)

### Audit Logging

All key management operations are logged with:
- Operation type (`create`, `rotate`, `revoke`, `status`)
- API key ID and scope
- Company ID and workspace ID (if applicable)
- Client IP address
- User agent
- Trace ID
- Endpoint URL
- Operation-specific details (e.g., new key ID, rotated key ID)

Logs are structured JSON and can be queried for compliance and security audits.

## API Endpoints

### Create Workspace Key
```
POST /v1/workspaces/:workspaceId/keys
Authorization: Bearer <company_key>
Content-Type: application/json

Body:
{
  "label": "Production Key",
  "expiresAt": "2025-12-31T23:59:59Z",
  "ipAllowlist": ["192.168.1.1"]
}
```

**Requirements:**
- Company key with IP allowlist
- Rate limit: 10 operations/minute

### Rotate Key
```
POST /v1/keys/:keyId/rotate
Authorization: Bearer <company_key>
```

**Requirements:**
- Company key with IP allowlist
- Rate limit: 10 operations/minute
- Key must not be already revoked

### Get Key Status
```
GET /v1/keys/status
Authorization: Bearer <company_key_or_workspace_key>
```

**Requirements:**
- Standard authentication
- Standard rate limiting

## Error Codes

- `401 UNAUTHORIZED`: Missing or invalid authentication
- `403 FORBIDDEN`: IP allowlist required or IP not allowed
- `404 NOT_FOUND`: Key or workspace not found
- `429 RATE_LIMITED`: Rate limit exceeded
- `400 VALIDATION_ERROR`: Invalid request (e.g., trying to rotate revoked key)

## Best Practices

1. **Configure IP allowlists**: Always configure IP allowlists for company keys used for key management
2. **Use dashboard for sensitive operations**: Use the dashboard for company key creation and key revocation
3. **Monitor audit logs**: Regularly review audit logs for suspicious activity
4. **Rotate keys regularly**: Implement automated key rotation scripts using the API
5. **Limit key management keys**: Create separate company keys specifically for key management with strict IP allowlists

## Plan Enforcement

### Server-Side Enforcement

All plan restrictions are enforced server-side and cannot be bypassed:

- **Feature gating**: Features are checked before allowing access
- **Limit enforcement**: Limits are checked before allowing operations
- **Plan validation**: Plan tier is validated on every request that requires it

### Plan Downgrades

When a company downgrades their plan:

- **Features are disabled**: Features not available in the new plan are immediately disabled
- **Data is preserved**: No data is deleted on downgrade
- **Existing resources**: Existing resources (e.g., webhooks) remain but cannot be used until plan is upgraded

### Stripe Integration (Future)

When Stripe billing is integrated:

- **Stripe is source of truth**: Plan tier and billing status will sync from Stripe
- **Pricing is not stored**: Pricing information is not stored in the database
- **Webhook handling**: Stripe webhooks will update plan tier and billing status
- **Trial management**: Trial periods are managed via Stripe subscriptions

### Plan Configuration

Plan configurations are centralized in `services/api/src/lib/plans.ts`:

- **Single source of truth**: All plan rules live in one file
- **Type-safe**: Plan configurations are fully typed
- **Easy to modify**: Adding new plans or features is straightforward

## Future Enhancements

- Dashboard UI for key management
- Two-factor authentication for dashboard operations
- Webhook notifications for key management events
- Key expiration warnings
- Automated key rotation scheduling
- Stripe billing integration
- Retention enforcement (Phase 3)
- Export limit enforcement (Phase 3)

