import { z } from 'zod';

export const MAX_HISTOGRAM_BUCKETS = 500;

export const QueryEventHistogramSchema = z
  .object({
    workspaceId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    from: z.string().datetime(),
    to: z.string().datetime(),
    interval: z.enum(['minute', 'hour', 'day']),
    groupBy: z.enum(['none', 'category', 'action', 'workspace', 'region']),
    category: z.string().optional(),
    action: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const from = new Date(data.from);
    const to = new Date(data.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid from/to', path: ['from'] });
      return;
    }
    if (from > to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'from must be <= to', path: ['from'] });
      return;
    }
    const spanMs = to.getTime() - from.getTime();
    const maxSpan =
      data.interval === 'minute'
        ? 48 * 60 * 60 * 1000
        : data.interval === 'hour'
          ? 45 * 24 * 60 * 60 * 1000
          : 400 * 24 * 60 * 60 * 1000;
    if (spanMs > maxSpan) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Time range exceeds maximum for interval=${data.interval}`,
        path: ['to'],
      });
    }
    const n = countExpectedBuckets(from, to, data.interval);
    if (n > MAX_HISTOGRAM_BUCKETS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Range produces ${n} buckets (max ${MAX_HISTOGRAM_BUCKETS}); use a coarser interval or shorter window`,
        path: ['interval'],
      });
    }
  });

export type ParsedHistogramQuery = z.infer<typeof QueryEventHistogramSchema>;

function floorToIntervalUtc(d: Date, interval: 'minute' | 'hour' | 'day'): Date {
  const x = new Date(d.getTime());
  x.setUTCMilliseconds(0);
  x.setUTCSeconds(0);
  if (interval === 'minute') return x;
  x.setUTCMinutes(0);
  if (interval === 'hour') return x;
  x.setUTCHours(0);
  return x;
}

function addIntervalUtc(d: Date, interval: 'minute' | 'hour' | 'day'): Date {
  const ms =
    interval === 'minute' ? 60_000 : interval === 'hour' ? 3_600_000 : 86_400_000;
  return new Date(d.getTime() + ms);
}

export function countExpectedBuckets(
  from: Date,
  to: Date,
  interval: 'minute' | 'hour' | 'day'
): number {
  const first = floorToIntervalUtc(from, interval);
  const last = floorToIntervalUtc(to, interval);
  if (last < first) return 0;
  let n = 0;
  for (let cur = first; cur <= last; cur = addIntervalUtc(cur, interval)) {
    n++;
    if (n > MAX_HISTOGRAM_BUCKETS + 1) return n;
  }
  return n;
}

export { floorToIntervalUtc, addIntervalUtc };
