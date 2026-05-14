import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicExportFailureSummary, publicExportRetryHint } from './exportJobPublicMessages.js';

test('publicExportFailureSummary returns null for success', () => {
  assert.equal(publicExportFailureSummary('SUCCEEDED', null), null);
});

test('publicExportFailureSummary maps STREAM_ERROR', () => {
  assert.ok(
    String(publicExportFailureSummary('FAILED', 'STREAM_ERROR')).includes('export stream')
  );
});

test('publicExportFailureSummary never echoes arbitrary errorCode as raw exception text', () => {
  const s = publicExportFailureSummary('FAILED', 'SOME_INTERNAL_CODE_XYZ');
  assert.ok(s);
  assert.equal(s!.includes('SOME_INTERNAL'), false);
  assert.equal(s!.includes('stack'), false);
});

test('publicExportRetryHint is present for failed stream', () => {
  const h = publicExportRetryHint('FAILED', 'STREAM_ERROR');
  assert.ok(h && h.length > 10);
});
