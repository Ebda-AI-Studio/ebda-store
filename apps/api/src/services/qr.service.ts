/**
 * Merchant QR codes (QR-1). Design settings live in `Store.settings.qr` (no column); a printed
 * code carries a stateless storefront link `/q/s | /q/w | /q/p/<slug> | /q/c/<slug>`; the
 * storefront asks `resolveQrScan` where to send the shopper and the scan is counted in
 * `qr_scan_daily` (an aggregate counter: no user, session, IP or user agent).
 *
 * A code that does not resolve to a real entity of THIS store is a 404 and writes nothing, so
 * the table is bounded by the catalogue and a bot cannot grow it with made-up slugs.
 */
import { SlugEntityType, prisma, withStore } from '@ebda/database';
import { storeDb } from '../lib/repo-factory';
import { analyticsMoney, analyticsOnDo } from '../lib/analytics-backend';
import { waMeLink, regionDayKey } from '@ebda/shared';
import { SentryService } from './sentry.service';
import {
  DEFAULT_QR_SETTINGS,
  qrSettingsSchema,
  type QrKind,
  type QrSettings,
} from '@ebda/shared/qr/schema';
import { AppError } from '../middleware/error-handler';
import { resolveSlugRedirectCached } from './slug-redirect.service';
import logger from '../lib/logger';

export const QR_SCAN_RETENTION_DAYS = 400;
/** One scan in this many also prunes the store's rows past retention (no cron needed). */
const PRUNE_ONE_IN = 200;

export function readQrSettings(raw: unknown): QrSettings {
  const qr = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).qr : undefined;
  const parsed = qrSettingsSchema.safeParse(qr);
  return parsed.success ? parsed.data : DEFAULT_QR_SETTINGS;
}

export type QrResolved = { kind: QrKind; ref: string; target: string };

/** Where a scan lands. Throws 404 for anything that is not a live entity of `storeId`. */
export async function resolveQrScan(
  storeId: string,
  kind: QrKind,
  slug?: string
): Promise<QrResolved> {
  const notFound = () => new AppError(404, 'NOT_FOUND', 'QR code target not found');
  if (kind === 'store') return { kind, ref: '', target: '/' };

  if (kind === 'whatsapp') {
    const store = await withStore(storeId, tx =>
      tx.store.findFirst({ where: { id: storeId }, select: { whatsapp: true, settings: true } })
    );
    if (!store) throw notFound();
    const text = readQrSettings(store.settings).whatsappText;
    const link = waMeLink(store.whatsapp, text || undefined);
    if (!link) throw notFound();
    return { kind, ref: '', target: link };
  }

  if (!slug || slug.length > 200) throw notFound();

  if (kind === 'product') {
    const find = async (s: string) =>
      (await storeDb(storeId)).product.findFirst({
        where: { storeId, slug: s, status: 'active', deletedAt: null, audience: 'public' },
        select: { id: true, slug: true },
      });
    let product = await find(slug);
    if (!product) {
      const moved = await resolveSlugRedirectCached(storeId, SlugEntityType.PRODUCT, slug);
      product = moved ? await find(moved) : null;
    }
    if (!product) throw notFound();
    return { kind, ref: product.id, target: `/products/${encodeURIComponent(product.slug)}` };
  }

  const findCat = async (s: string) =>
    (await storeDb(storeId)).category.findFirst({
      where: { storeId, slug: s, isActive: true },
      select: { id: true, slug: true },
    });
  let category = await findCat(slug);
  if (!category) {
    const moved = await resolveSlugRedirectCached(storeId, SlugEntityType.CATEGORY, slug);
    category = moved ? await findCat(moved) : null;
  }
  if (!category) throw notFound();
  return {
    kind,
    ref: category.id,
    target: `/products?category=${encodeURIComponent(category.slug)}`,
  };
}

/** Count one scan. Fail-open: a counter failure never blocks the shopper's redirect. */
export async function recordQrScan(
  storeId: string,
  kind: QrKind,
  ref: string,
  now: Date = new Date()
): Promise<boolean> {
  // Ruling ANALYTICS-DAY-1: UTC-midnight day key shared with the DO op contract and the readers.
  const dayKeyMs = regionDayKey(now);
  const day = new Date(dayKeyMs);
  try {
    // Ruling NZ-AN-1: a Durable Object store counts in its own DO once the analytics copy flipped
    const money = await analyticsMoney(storeId, 'write');
    if (money) {
      const prune = Math.floor(Math.random() * PRUNE_ONE_IN) === 0;
      await money.qrScanRecord({
        dayMs: dayKeyMs,
        kind,
        ref,
        ...(prune ? { pruneBeforeMs: dayKeyMs - QR_SCAN_RETENTION_DAYS * 86_400_000 } : {}),
      });
      return true;
    }
    await withStore(storeId, async tx => {
      await tx.$executeRaw`
        INSERT INTO qr_scan_daily (id, store_id, date, kind, ref, count)
        VALUES (gen_random_uuid()::text, ${storeId}, ${day}, ${kind}, ${ref}, 1)
        ON CONFLICT (store_id, date, kind, ref)
        DO UPDATE SET count = LEAST(qr_scan_daily.count, 2147483646) + 1`;
      if (Math.floor(Math.random() * PRUNE_ONE_IN) === 0) {
        const cutoff = new Date(day.getTime() - QR_SCAN_RETENTION_DAYS * 86_400_000);
        await tx.$executeRaw`
          DELETE FROM qr_scan_daily WHERE store_id = ${storeId} AND date < ${cutoff}`;
      }
    });
    return true;
  } catch (err) {
    logger.warn(
      { storeId, err: err instanceof Error ? err.message : 'unknown' },
      '[QR] scan not counted'
    );
    try {
      SentryService.captureException(err instanceof Error ? err : new Error(String(err)), {
        tags: { area: 'analytics', op: 'qr-scan-record' },
        extra: { storeId, kind },
      });
    } catch {
      /* reporting must never break the shopper redirect */
    }
    return false;
  }
}

export type QrStatRow = {
  kind: QrKind;
  ref: string;
  label: string;
  labelAr: string | null;
  scans: number;
};

/** Scans per code over the last `days` days, with product/category names for the admin list. */
export async function qrStats(storeId: string, days: number): Promise<QrStatRow[]> {
  const since = new Date(regionDayKey() - (days - 1) * 86_400_000);
  // Ruling NZ-AN-1: the DO when this store's analytics moved, else Postgres (both answer the same groupBy)
  const reader = (await analyticsOnDo(storeId, 'read')) ? await storeDb(storeId) : prisma;
  const rows = await reader.qrScanDaily.groupBy({
    by: ['kind', 'ref'],
    where: { storeId, date: { gte: since } },
    _sum: { count: true },
    orderBy: { _sum: { count: 'desc' } },
    take: 100,
  });
  const productIds = rows.filter(r => r.kind === 'product').map(r => r.ref);
  const categoryIds = rows.filter(r => r.kind === 'category').map(r => r.ref);
  const [products, categories] = await Promise.all([
    productIds.length
      ? (await storeDb(storeId)).product.findMany({
          where: { storeId, id: { in: productIds } },
          select: { id: true, name: true, nameAr: true },
        })
      : [],
    categoryIds.length
      ? (await storeDb(storeId)).category.findMany({
          where: { storeId, id: { in: categoryIds } },
          select: { id: true, name: true, nameAr: true },
        })
      : [],
  ]);
  const names = new Map<string, { name: string; nameAr: string | null }>();
  for (const p of [...products, ...categories]) names.set(p.id, p);
  return rows.map(r => {
    const n = names.get(r.ref);
    return {
      kind: r.kind as QrKind,
      ref: r.ref,
      label: n?.name ?? '',
      labelAr: n?.nameAr ?? null,
      scans: r._sum.count ?? 0,
    };
  });
}
