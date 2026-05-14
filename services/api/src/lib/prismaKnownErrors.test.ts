import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPrismaTableMissingForModel } from './prismaKnownErrors.js';

test('isPrismaTableMissingForModel matches P2021 + modelName', () => {
  assert.equal(
    isPrismaTableMissingForModel({ code: 'P2021', meta: { modelName: 'ExportTemplate' } }, 'ExportTemplate'),
    true
  );
  assert.equal(
    isPrismaTableMissingForModel({ code: 'P2021', meta: { modelName: 'ExportJob' } }, 'ExportTemplate'),
    false
  );
  assert.equal(isPrismaTableMissingForModel(new Error('nope'), 'ExportTemplate'), false);
});

test('isPrismaTableMissingForModel matches P2021 + driver adapter table', () => {
  assert.equal(
    isPrismaTableMissingForModel(
      {
        code: 'P2021',
        meta: {
          driverAdapterError: {
            cause: { table: 'public.export_templates', kind: 'TableDoesNotExist' },
          },
        },
      },
      'ExportTemplate'
    ),
    true
  );
});

test('isPrismaTableMissingForModel matches P2021 + message substring', () => {
  assert.equal(
    isPrismaTableMissingForModel(
      {
        code: 'P2021',
        message: 'The table `public.export_templates` does not exist',
      },
      'ExportTemplate'
    ),
    true
  );
});
