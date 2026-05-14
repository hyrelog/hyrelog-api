import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EventQuerySchema,
  sanitizeEventQueryForPersistence,
  stableEventQueryJson,
  eventQueryToExportFilters,
} from './eventQuery.js';

test('sanitizeEventQueryForPersistence strips unknown and sorts arrays', () => {
  const s = sanitizeEventQueryForPersistence({
    categories: ['b', 'a'],
    extra: 'drop',
    from: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(s.categories, ['a', 'b']);
  assert.equal((s as { extra?: string }).extra, undefined);
  assert.ok(s.from);
});

test('stableEventQueryJson key order is deterministic', () => {
  const a = stableEventQueryJson(
    sanitizeEventQueryForPersistence({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' })
  );
  const b = stableEventQueryJson(
    sanitizeEventQueryForPersistence({ to: '2026-01-02T00:00:00.000Z', from: '2026-01-01T00:00:00.000Z' })
  );
  assert.equal(a, b);
});

test('eventQueryToExportFilters maps first category and workspace', () => {
  const f = eventQueryToExportFilters(
    sanitizeEventQueryForPersistence({
      categories: ['Login'],
      actions: ['create'],
      workspaceIds: ['11111111-1111-4111-8111-111111111111'],
      from: '2026-01-01T00:00:00.000Z',
    })
  );
  assert.equal(f.category, 'Login');
  assert.equal(f.action, 'create');
  assert.equal(f.workspaceId, '11111111-1111-4111-8111-111111111111');
  assert.ok(f.from);
});

test('EventQuerySchema rejects oversized arrays', () => {
  const cats = Array.from({ length: 60 }, () => 'x');
  const r = EventQuerySchema.safeParse({ categories: cats });
  assert.equal(r.success, false);
});
