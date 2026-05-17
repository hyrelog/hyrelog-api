/**
 * Fixed IDs for local screenshot / demo seeding.
 * Dashboard seed (hyrelog-dashboard) must use the same dashboard* ids.
 */

export const DEMO_DASHBOARD_COMPANY_ID = '11111111-1111-4111-8111-111111111101';
export const DEMO_API_COMPANY_ID = '22222222-2222-4222-8222-222222222201';

export const DEMO_WORKSPACES = [
  {
    dashboardId: '11111111-1111-4111-8111-111111111201',
    apiId: '22222222-2222-4222-8222-222222222201',
    slug: 'production',
    name: 'Production',
    region: 'US' as const,
    weight: 0.55,
  },
  {
    dashboardId: '11111111-1111-4111-8111-111111111202',
    apiId: '22222222-2222-4222-8222-222222222202',
    slug: 'staging',
    name: 'Staging',
    region: 'US' as const,
    weight: 0.2,
  },
  {
    dashboardId: '11111111-1111-4111-8111-111111111203',
    apiId: '22222222-2222-4222-8222-222222222203',
    slug: 'eu-production',
    name: 'EU Production',
    region: 'EU' as const,
    weight: 0.18,
  },
  {
    dashboardId: '11111111-1111-4111-8111-111111111204',
    apiId: '22222222-2222-4222-8222-222222222204',
    slug: 'sandbox',
    name: 'Sandbox',
    region: 'US' as const,
    weight: 0.07,
  },
] as const;

export const DEMO_PROJECTS = [
  {
    dashboardId: '11111111-1111-4111-8111-111111111301',
    apiId: '22222222-2222-4222-8222-222222222301',
    workspaceApiId: DEMO_WORKSPACES[0].apiId,
    name: 'Core API',
    slug: 'core-api',
  },
  {
    dashboardId: '11111111-1111-4111-8111-111111111302',
    apiId: '22222222-2222-4222-8222-222222222302',
    workspaceApiId: DEMO_WORKSPACES[0].apiId,
    name: 'Customer Portal',
    slug: 'customer-portal',
  },
  {
    dashboardId: '11111111-1111-4111-8111-111111111303',
    apiId: '22222222-2222-4222-8222-222222222303',
    workspaceApiId: DEMO_WORKSPACES[1].apiId,
    name: 'Payments Service',
    slug: 'payments',
  },
  {
    dashboardId: '11111111-1111-4111-8111-111111111304',
    apiId: '22222222-2222-4222-8222-222222222304',
    workspaceApiId: DEMO_WORKSPACES[2].apiId,
    name: 'GDPR Vault',
    slug: 'gdpr-vault',
  },
] as const;

export const DEMO_ADMIN_USER_ID = '33333333-3333-4333-8333-333333333301';
