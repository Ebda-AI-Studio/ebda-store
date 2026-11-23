/**
 * Backup + undo for AI "replace existing" runs (Ruling AITOOLS-4, on top of NEVER-OVERWRITE-1).
 *
 * The one rule: a sweep that replaces a stored value goes through `replaceTextWithBackup` / `replaceCategoriesWithBackup`, which write the
 * backup row and the new value in ONE atomic batch (`$transaction`), compare-and-set on the value the sweep read. There is no other
 * replace path, so a replace without a backup cannot happen: if the backup insert fails the batch fails and the value is untouched.
 *
 * Undo restores `previousValue` only while the field still holds exactly what the AI wrote (`newValue`). A field the merchant edited
 * after the run is refused (`edited_since`), never overwritten. Undoing run 1 after run 2 replaced the same field is refused for the
 * same reason (undo run 2 first).
 *
 * Covered: product name / description (en, ar), category name / description (en, ar), product image alt, and a product's category set.
 * The store's own name and description are never replaced by an AI tool (fill-only stays).
 */
import { randomUUID } from 'node:crypto';
import { storeDb, storeWriter } from '../lib/repo-factory';
import { doStoreIdList } from '../lib/store-backend';
import logger from '../lib/logger';
import { requestStoreReindex } from '../lib/search/reindex';
import { invalidateStoreCategoriesCaches, invalidateStoreProductCaches } from '../lib/public-cache';
import { AppError } from '../middleware/error-handler';

type ReplaceTool = 'translate_ar' | 'translate_en' | 'categorize' | 'image_alt';
type ReplaceEntityKind = 'product' | 'category' | 'product_image' | 'product_categories';

export interface ReplaceCtx {
  storeId: string;
  userId: string | null;
  jobId: string;
  tool: ReplaceTool;
}

const TEXT_FIELDS: Record<'product' | 'category' | 'product_image', readonly string[]> = {
  product: ['name', 'nameAr', 'description', 'descriptionAr'],
  category: ['name', 'nameAr', 'description', 'descriptionAr'],
  product_image: ['alt'],
};

type ReplaceOutcome = 'replaced' | 'already' | 'stale';

const idsKey = (ids: string[]): string => JSON.stringify([...new Set(ids)].sort());

/** The backup row of this run for this entity + field, if the run already replaced it (a retried batch must not replace twice). */
async function hasBackupInRun(
  ctx: ReplaceCtx,
  entityKind: ReplaceEntityKind,
  entityId: string,
  field: string
): Promise<boolean> {
  const row = await (
    await storeDb(ctx.storeId)
  ).aiReplaceBackup.findFirst({
    where: { storeId: ctx.storeId, jobId: ctx.jobId, entityKind, entityId, field },
    select: { id: true },
  });
  return !!row;
}

/**
 * Replace one stored text value with backup. `previous` is the non-empty value the sweep read; it is the compare-and-set guard, so a value
 * the merchant changed since the read is left alone (`stale`, and the backup is removed again).
 */
export async function replaceTextWithBackup(
  ctx: ReplaceCtx,
  a: {
    entityKind: 'product' | 'category' | 'product_image';
    entityId: string;
    productId?: string;
    field: string;
    previous: string;
    next: string;
  }
): Promise<ReplaceOutcome> {
  if (!TEXT_FIELDS[a.entityKind].includes(a.field))
    throw new Error(`replaceTextWithBackup: ${a.entityKind}.${a.field} is not replaceable`);
  if (a.previous.trim() === '')
    throw new Error('replaceTextWithBackup: nothing to back up (fill, do not replace)');
  if (a.previous === a.next) return 'already';
  if (await hasBackupInRun(ctx, a.entityKind, a.entityId, a.field)) return 'already';

  const w = await storeWriter(ctx.storeId);
  const backupId = randomUUID();
  const create = w.aiReplaceBackup.create({
    data: {
      id: backupId,
      storeId: ctx.storeId,
      jobId: ctx.jobId,
      tool: ctx.tool,
      entityKind: a.entityKind,
      entityId: a.entityId,
      productId: a.productId ?? (a.entityKind === 'product' ? a.entityId : null),
      field: a.field,
      previousValue: a.previous,
      newValue: a.next,
      userId: ctx.userId,
    },
    select: { id: true },
  });
  const swap =
    a.entityKind === 'product'
      ? w.product.updateMany({
          where: { id: a.entityId, storeId: ctx.storeId, [a.field]: a.previous },
          data: { [a.field]: a.next },
        })
      : a.entityKind === 'category'
        ? w.category.updateMany({
            where: { id: a.entityId, storeId: ctx.storeId, [a.field]: a.previous },
            data: { [a.field]: a.next },
          })
        : w.productImage.updateMany({
            where: { id: a.entityId, productId: a.productId, alt: a.previous },
            data: { alt: a.next },
          });
  const [, swapped] = (await w.$transaction([create, swap])) as [unknown, { count: number }];
  if (swapped.count === 0) {
    await w.aiReplaceBackup.deleteMany({ where: { id: backupId, storeId: ctx.storeId } });
    return 'stale';
  }
  return 'replaced';
}

/** Replace a product's category set with `nextIds`, backing the previous set up first (same atomic batch). */
export async function replaceCategoriesWithBackup(
  ctx: ReplaceCtx,
  a: { productId: string; previousIds: string[]; nextIds: string[] }
): Promise<ReplaceOutcome> {
  if (a.previousIds.length === 0)
    throw new Error('replaceCategoriesWithBackup: nothing to back up (fill, do not replace)');
  if (idsKey(a.previousIds) === idsKey(a.nextIds)) return 'already';
  if (await hasBackupInRun(ctx, 'product_categories', a.productId, 'categories')) return 'already';

  const w = await storeWriter(ctx.storeId);
  const backupId = randomUUID();
  const backup = w.aiReplaceBackup.create({
    data: {
      id: backupId,
      storeId: ctx.storeId,
      jobId: ctx.jobId,
      tool: ctx.tool,
      entityKind: 'product_categories',
      entityId: a.productId,
      productId: a.productId,
      field: 'categories',
      previousValue: idsKey(a.previousIds),
      newValue: idsKey(a.nextIds),
      userId: ctx.userId,
    },
    select: { id: true },
  });
  // The store is on its Durable Object (the only backend in production, NZ-D23): the set swap is ONE compare-and-set procedure in
  // the same atomic batch as the backup. A set the merchant changed since the sweep read it swaps nothing (0) and the backup goes.
  const [, swapped] = (await w.$transaction([
    backup,
    w.$proc('productCategoriesCas', {
      productId: a.productId,
      storeId: ctx.storeId,
      expected: a.previousIds,
      next: a.nextIds.map((categoryId, position) => ({ categoryId, position })),
    }),
  ])) as [unknown, number];
  if (Number(swapped) === 0) {
    await w.aiReplaceBackup.deleteMany({ where: { id: backupId, storeId: ctx.storeId } });
    return 'stale';
  }
  return 'replaced';
}

// ---------------------------------------------------------------------------------------------------------------------
// Reads (the history the merchant sees)

interface BackupRow {
  id: string;
  jobId: string | null;
  tool: ReplaceTool;
  entityKind: ReplaceEntityKind;
  entityId: string;
  productId: string | null;
  productName: string | null;
  field: string;
  previousValue: string | null;
  newValue: string | null;
  userId: string | null;
  createdAt: string;
  restoredAt: string | null;
}

const LIST_CAP = 200;

export async function listBackups(
  storeId: string,
  q: { productId?: string; jobId?: string; includeRestored?: boolean; limit?: number }
): Promise<BackupRow[]> {
  const db = await storeDb(storeId);
  const rows = await db.aiReplaceBackup.findMany({
    where: {
      storeId,
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.jobId ? { jobId: q.jobId } : {}),
      ...(q.includeRestored ? {} : { restoredAt: null }),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(q.limit ?? LIST_CAP, LIST_CAP),
  });
  const productIds = [...new Set(rows.map(r => r.productId).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (productIds.length > 0) {
    const ps = await db.product.findMany({
      where: { storeId, id: { in: productIds } },
      select: { id: true, name: true, nameAr: true },
    });
    for (const p of ps) names.set(p.id, p.name || p.nameAr || p.id);
  }
  return rows.map(r => ({
    id: r.id,
    jobId: r.jobId,
    tool: r.tool as ReplaceTool,
    entityKind: r.entityKind as ReplaceEntityKind,
    entityId: r.entityId,
    productId: r.productId,
    productName: r.productId ? (names.get(r.productId) ?? null) : null,
    field: r.field,
    previousValue: r.previousValue,
    newValue: r.newValue,
    userId: r.userId,
    createdAt: r.createdAt.toISOString(),
    restoredAt: r.restoredAt ? r.restoredAt.toISOString() : null,
  }));
}

interface ReplaceRun {
  jobId: string;
  tool: ReplaceTool;
  userId: string | null;
  at: string;
  changed: number;
  undone: number;
}

/** The recent replace runs (one line per bulk job that replaced something) with how many of their changes are still undoable. */
export async function listReplaceRuns(storeId: string, limit = 20): Promise<ReplaceRun[]> {
  const db = await storeDb(storeId);
  const rows = await db.aiReplaceBackup.findMany({
    where: { storeId, jobId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 2000,
    select: { jobId: true, tool: true, userId: true, createdAt: true, restoredAt: true },
  });
  const runs = new Map<string, ReplaceRun>();
  for (const r of rows) {
    if (!r.jobId) continue;
    const run = runs.get(r.jobId) ?? {
      jobId: r.jobId,
      tool: r.tool as ReplaceTool,
      userId: r.userId,
      at: r.createdAt.toISOString(),
      changed: 0,
      undone: 0,
    };
    run.changed++;
    if (r.restoredAt) run.undone++;
    if (r.createdAt.toISOString() < run.at) run.at = r.createdAt.toISOString();
    runs.set(r.jobId, run);
  }
  return [...runs.values()].slice(0, limit);
}

// ---------------------------------------------------------------------------------------------------------------------
// Undo

interface UndoResult {
  restored: number;
  refused: Array<{ id: string; reason: 'edited_since' | 'gone' }>;
}

const UNDO_CAP = 500;

/** Undo by backup ids, by bulk run (jobId) or by product (everything still undoable on it). */
export async function undoBackups(
  storeId: string,
  userId: string,
  scope: { ids?: string[]; jobId?: string; productId?: string }
): Promise<UndoResult> {
  if (!scope.ids?.length && !scope.jobId && !scope.productId)
    throw new AppError(
      400,
      'UNDO_SCOPE_REQUIRED',
      'Say what to undo: a change, a run or a product.'
    );
  const db = await storeDb(storeId);
  const rows = await db.aiReplaceBackup.findMany({
    where: {
      storeId,
      restoredAt: null,
      ...(scope.ids?.length ? { id: { in: scope.ids } } : {}),
      ...(scope.jobId ? { jobId: scope.jobId } : {}),
      ...(scope.productId ? { productId: scope.productId } : {}),
    },
    // newest first: the last change to a field is undone before an earlier one
    orderBy: { createdAt: 'desc' },
    take: UNDO_CAP,
  });
  const out: UndoResult = { restored: 0, refused: [] };
  let productTextRestored = false;
  let categoryRestored = false;
  for (const row of rows) {
    const outcome = await restoreOne(storeId, userId, row);
    if (outcome === 'ok') {
      out.restored++;
      if (row.entityKind === 'product') productTextRestored = true;
      if (row.entityKind === 'category' || row.entityKind === 'product_categories')
        categoryRestored = true;
    } else out.refused.push({ id: row.id, reason: outcome });
  }
  // The storefront and the public API cache what the undo just rewrote (names, descriptions, alt text, category sets): drop
  // every layer, as every other catalogue write does. A purge failure never fails an undo that already committed.
  if (out.restored > 0) {
    await invalidateStoreProductCaches(storeId).catch(err =>
      logger.warn({ err, storeId }, '[ai-replace] product cache purge after undo failed')
    );
    if (categoryRestored)
      await invalidateStoreCategoriesCaches(storeId).catch(err =>
        logger.warn({ err, storeId }, '[ai-replace] category cache purge after undo failed')
      );
  }
  // restored names / descriptions feed the search embedding: one reindex request after the writes, never per row
  if (productTextRestored) await requestStoreReindex(storeId, 'ai-replace-undo');
  logger.info(
    { storeId, userId, scope, restored: out.restored, refused: out.refused.length },
    '[ai-replace] undo'
  );
  return out;
}

type Row = Awaited<
  ReturnType<Awaited<ReturnType<typeof storeDb>>['aiReplaceBackup']['findMany']>
>[number];

async function restoreOne(
  storeId: string,
  userId: string,
  row: Row
): Promise<'ok' | 'edited_since' | 'gone'> {
  const w = await storeWriter(storeId);
  const prev = row.previousValue ?? '';
  const next = row.newValue ?? '';
  // a field that was empty before the AI wrote it (null) goes back to null, never to ''
  const restoredText = row.previousValue;
  const mark = () =>
    w.aiReplaceBackup.updateMany({
      where: { id: row.id, storeId, restoredAt: null },
      data: { restoredAt: new Date(), restoredBy: userId },
    });

  if (row.entityKind === 'product_categories') {
    const db = await storeDb(storeId);
    const prevIds = JSON.parse(prev) as string[];
    // a category deleted since the run cannot come back: restore the ones that still exist
    const alive = await db.category.findMany({
      where: { storeId, id: { in: prevIds } },
      select: { id: true },
    });
    const aliveIds = new Set(alive.map(c => c.id));
    // ONE compare-and-set: the set is restored only while it still equals what the AI wrote. A manual change at any moment before
    // the write (even between the reads above and it) makes it 0 rows: the same `edited_since` refusal as a text field.
    const swapped = await w.$proc('productCategoriesCas', {
      productId: row.entityId,
      storeId,
      expected: JSON.parse(next) as string[],
      next: prevIds
        .filter(id => aliveIds.has(id))
        .map((categoryId, position) => ({ categoryId, position })),
    });
    if (Number(swapped) === 0) {
      const gone = await db.product.findFirst({
        where: { id: row.entityId, storeId },
        select: { id: true },
      });
      return gone ? 'edited_since' : 'gone';
    }
    await mark();
    return 'ok';
  }

  // text fields: compare-and-set on what the AI wrote
  const field = row.field;
  const kind = row.entityKind as 'product' | 'category' | 'product_image';
  if (!TEXT_FIELDS[kind]?.includes(field)) return 'gone';
  const restore =
    kind === 'product'
      ? w.product.updateMany({
          where: { id: row.entityId, storeId, [field]: next },
          data: { [field]: restoredText },
        })
      : kind === 'category'
        ? w.category.updateMany({
            where: { id: row.entityId, storeId, [field]: next },
            data: { [field]: restoredText },
          })
        : w.productImage.updateMany({
            where: { id: row.entityId, productId: row.productId ?? undefined, alt: next },
            data: { alt: restoredText },
          });
  const res = (await restore) as { count: number };
  if (res.count === 0) {
    // either the merchant edited it since, or the row is gone: tell them apart
    const db = await storeDb(storeId);
    const exists =
      kind === 'product'
        ? await db.product.findFirst({ where: { id: row.entityId, storeId }, select: { id: true } })
        : kind === 'category'
          ? await db.category.findFirst({
              where: { id: row.entityId, storeId },
              select: { id: true },
            })
          : await db.productImage.findFirst({ where: { id: row.entityId }, select: { id: true } });
    return exists ? 'edited_since' : 'gone';
  }
  await mark();
  return 'ok';
}

// ---------------------------------------------------------------------------------------------------------------------
// Retention (Ruling AITOOLS-5): the undo history is kept 90 days, then deleted. Run by the existing daily
// `search-log-purge-daily` job (lib/inngest/functions/data-retention.ts), no cron of its own.

// pq-allow(unused-export): pinned by the retention unit test
export const REPLACE_BACKUP_RETENTION_DAYS = 90;
const PURGE_BATCH = 500;
const PURGE_MAX_BATCHES = 20;

/** Delete this store's backups older than the retention window, at most `batch * maxBatches` rows per call. Returns rows deleted. */
// pq-allow(unused-export): the unit test drives the per-store purge with small batch bounds
export async function purgeReplaceBackups(
  storeId: string,
  opts: { now?: Date; batch?: number; maxBatches?: number } = {}
): Promise<number> {
  const cutoff = new Date(
    (opts.now ?? new Date()).getTime() - REPLACE_BACKUP_RETENTION_DAYS * 86_400_000
  );
  const batch = opts.batch ?? PURGE_BATCH;
  const db = await storeDb(storeId);
  const w = await storeWriter(storeId);
  let purged = 0;
  for (let i = 0; i < (opts.maxBatches ?? PURGE_MAX_BATCHES); i++) {
    const old = await db.aiReplaceBackup.findMany({
      where: { storeId, createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
      take: batch,
      select: { id: true },
    });
    if (old.length === 0) break;
    const res = (await w.aiReplaceBackup.deleteMany({
      where: { storeId, id: { in: old.map(r => r.id) } },
    })) as { count: number };
    purged += res.count;
    if (old.length < batch) break;
  }
  return purged;
}

/** Every store on its Durable Object; one failing store never stops the rest (counted, logged, the job fails loudly after). */
export async function purgeReplaceBackupsAcrossStores(
  opts: { storeIds?: string[]; now?: Date } = {}
): Promise<{ purged: number; failedStores: number }> {
  const storeIds = opts.storeIds ?? (await doStoreIdList());
  let purged = 0;
  let failedStores = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, storeIds.length) }, async () => {
      while (next < storeIds.length) {
        const storeId = storeIds[next++];
        try {
          purged += await purgeReplaceBackups(storeId, { now: opts.now });
        } catch (err) {
          failedStores += 1;
          logger.error({ storeId, err }, '[ai-replace] backup purge failed for store');
        }
      }
    })
  );
  return { purged, failedStores };
}
