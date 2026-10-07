import { prisma, withStore } from '@force/database';
import { parseReportRange, resolveStoreTimeZone, type ReportRange } from '@force/shared';

export type RangeOrLegacyResult =
  | { ok: true; from: Date | undefined; to: Date | undefined }
  | { ok: false };

/**
 * Date filter for a list route: the shared report-range contract first
 * (`startDate`/`endDate`, viewer-local days as instants), else the legacy
 * date-only `from`/`to` pair read as whole UTC days (explicit `Z`, so the
 * result no longer depends on the server's TZ). `ok: false` = a malformed
 * contract range → the caller answers 422.
 */
export function rangeOrLegacyDays(query: Record<string, unknown>): RangeOrLegacyResult {
  const parsed = parseReportRange(query);
  if (!parsed.ok) return { ok: false };
  if (parsed.range) return { ok: true, from: parsed.range.startDate, to: parsed.range.endDate };
  return {
    ok: true,
    from: legacyDay(query.from, 'start'),
    to: legacyDay(query.to, 'end'),
  };
}

function legacyDay(v: unknown, edge: 'start' | 'end'): Date | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const day = v.slice(0, 10);
  const d = new Date(`${day}T${edge === 'end' ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export type { ReportRange };

/**
 * The time zone a store's finance reports count days in: the store's
 * `timezone` column when it is a usable IANA zone, else Africa/Cairo
 * (Ruling FRT-2). Call it bare, NOT inside its own `runInTenantContext`:
 * `stores` has RLS disabled (migration 20260609000000), so the read needs no
 * tenant GUC, and `runInTenantContext` never joins an ambient tx — wrapping
 * it opens an extra interactive Postgres transaction per request (issue 2410).
 */
export async function storeTimeZone(storeId: string): Promise<string> {
  const store = await withStore(storeId, tx =>
    tx.store.findUnique({
      where: { id: storeId },
      select: { timezone: true },
    })
  );
  return resolveStoreTimeZone(store?.timezone);
}
