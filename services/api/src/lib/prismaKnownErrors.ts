/**
 * Prisma P2021: referenced table/relation does not exist (migrations not applied or wrong database).
 * Matches `meta.modelName` and falls back to adapter cause / message when Prisma shape varies.
 * @see https://www.prisma.io/docs/reference/api-reference/error-reference#p2021
 */
export function isPrismaTableMissingForModel(error: unknown, modelName: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as {
    code?: string;
    message?: string;
    meta?: {
      modelName?: string;
      driverAdapterError?: { cause?: { table?: string; kind?: string } };
    };
  };
  if (e.code !== 'P2021') return false;
  if (e.meta?.modelName === modelName) return true;

  const table = e.meta?.driverAdapterError?.cause?.table;
  const msg = typeof e.message === 'string' ? e.message : '';

  if (modelName === 'ExportTemplate') {
    if (table?.includes('export_templates')) return true;
    if (msg.includes('export_templates')) return true;
  }
  if (modelName === 'SavedExplorerView') {
    if (table?.includes('saved_explorer_views')) return true;
    if (msg.includes('saved_explorer_views')) return true;
  }

  return false;
}
