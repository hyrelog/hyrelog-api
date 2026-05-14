import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDashboardExportListWhere,
  buildDashboardExportTemplateListWhere,
  canDashboardUserViewExportJob,
  canDashboardUserViewExportTemplate,
  filtersJsonForExportTemplate,
  sanitizeDashboardFilters,
} from './dashboardExportJobs.js';

test('sanitizeDashboardFilters keeps allowed keys', () => {
  const out = sanitizeDashboardFilters({
    from: '2026-01-01T00:00:00.000Z',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    extra: 'nope',
  });
  assert.ok(out);
  assert.equal(out!.from, '2026-01-01T00:00:00.000Z');
  assert.equal(out!.workspaceId, '11111111-1111-4111-8111-111111111111');
  assert.equal((out as { extra?: string }).extra, undefined);
});

test('buildDashboardExportTemplateListWhere scopes members to workspace ids', () => {
  const w = buildDashboardExportTemplateListWhere('co', 'MEMBER', ['a', 'b']);
  assert.deepEqual(w.workspaceId, { in: ['a', 'b'] });
});

test('buildDashboardExportListWhere uses impossible uuid when member has no workspace ids', () => {
  const w = buildDashboardExportListWhere('co', 'MEMBER', []);
  assert.deepEqual(w.workspaceId, { in: ['00000000-0000-0000-0000-000000000000'] });
});

test('canDashboardUserViewExportJob hides company-wide jobs from members', () => {
  assert.equal(
    canDashboardUserViewExportJob({
      userRole: 'MEMBER',
      exportWorkspaceIds: ['a'],
      jobWorkspaceId: null,
    }),
    false
  );
  assert.equal(
    canDashboardUserViewExportJob({
      userRole: 'MEMBER',
      exportWorkspaceIds: [],
      jobWorkspaceId: 'a',
    }),
    false
  );
  assert.ok(
    canDashboardUserViewExportJob({
      userRole: 'MEMBER',
      exportWorkspaceIds: ['a'],
      jobWorkspaceId: 'a',
    })
  );
  assert.ok(
    canDashboardUserViewExportJob({
      userRole: 'ADMIN',
      exportWorkspaceIds: undefined,
      jobWorkspaceId: null,
    })
  );
});

test('filtersJsonForExportTemplate strips unknown keys', () => {
  const j = filtersJsonForExportTemplate({
    from: '2026-01-01T00:00:00.000Z',
    apiKey: 'secret',
    nested: { x: 1 },
  } as Record<string, unknown>);
  assert.equal(j.from, '2026-01-01T00:00:00.000Z');
  assert.equal((j as { apiKey?: string }).apiKey, undefined);
});

test('canDashboardUserViewExportTemplate rejects company-wide for members', () => {
  assert.equal(
    canDashboardUserViewExportTemplate({
      userRole: 'MEMBER',
      exportWorkspaceIds: ['a'],
      templateWorkspaceId: null,
    }),
    false
  );
  assert.ok(
    canDashboardUserViewExportTemplate({
      userRole: 'MEMBER',
      exportWorkspaceIds: ['a'],
      templateWorkspaceId: 'a',
    })
  );
});
