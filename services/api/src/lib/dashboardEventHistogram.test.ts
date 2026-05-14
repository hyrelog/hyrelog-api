import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryEventHistogramSchema, countExpectedBuckets } from './dashboardEventHistogramQuery.js';

test('minute interval rejects span over 48h', () => {
  const from = '2024-01-01T00:00:00.000Z';
  const to = '2024-01-03T01:00:00.000Z';
  const r = QueryEventHistogramSchema.safeParse({ from, to, interval: 'minute', groupBy: 'none' });
  assert.equal(r.success, false);
});

test('minute interval accepts within 48h and under bucket cap', () => {
  const from = '2024-01-01T00:00:00.000Z';
  const to = '2024-01-01T08:00:00.000Z';
  const r = QueryEventHistogramSchema.safeParse({ from, to, interval: 'minute', groupBy: 'none' });
  assert.equal(r.success, true);
});

test('minute schema rejects when bucket count exceeds cap', () => {
  const from = '2024-01-01T00:00:00.000Z';
  const to = '2024-01-01T12:00:00.000Z';
  const r = QueryEventHistogramSchema.safeParse({ from, to, interval: 'minute', groupBy: 'none' });
  assert.equal(r.success, false);
});

test('countExpectedBuckets hourly UTC alignment', () => {
  const from = new Date('2024-01-01T00:30:00.000Z');
  const to = new Date('2024-01-02T00:30:00.000Z');
  const n = countExpectedBuckets(from, to, 'hour');
  assert.equal(n, 25);
});

test('from must be <= to', () => {
  const r = QueryEventHistogramSchema.safeParse({
    from: '2024-01-02T00:00:00.000Z',
    to: '2024-01-01T00:00:00.000Z',
    interval: 'day',
    groupBy: 'none',
  });
  assert.equal(r.success, false);
});
