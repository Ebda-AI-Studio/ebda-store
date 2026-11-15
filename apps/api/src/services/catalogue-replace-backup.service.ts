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
import logger from '../lib/logger';
import { requestStoreReindex } from '../lib/search/reindex';
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

  const db = await storeDb(ctx.storeId);
  const now = await db.productCategory.findMany({
    where: { productId: a.productId },
    select: { categoryId: true },
  });
  if (idsKey(now.map(r => r.categoryId)) !== idsKey(a.previousIds)) return 'stale';

  const w = await storeWriter(ctx.storeId);
  await w.$transaction([
    w.aiReplaceBackup.create({
      data: {
        id: randomUUID(),
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
    }),
    w.productCategory.deleteMany({ where: { productId: a.productId } }),
    w.productCategory.createMany({
      data: a.nextIds.map((categoryId, position) => ({
        productId: a.productId,
        categoryId,
        position,
      })),
    }),
  ]);
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
  for (const row of rows) {
    const outcome = await restoreOne(storeId, userId, row);
    if (outcome === 'ok') {
      out.restored++;
      if (row.entityKind === 'product') productTextRestored = true;
    } else out.refused.push({ id: row.id, reason: outcome });
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
  const mark = () =>
    w.aiReplaceBackup.updateMany({
      where: { id: row.id, storeId, restoredAt: null },
      data: { restoredAt: new Date(), restoredBy: userId },
    });

  if (row.entityKind === 'product_categories') {
    const db = await storeDb(storeId);
    const product = await db.product.findFirst({
      where: { id: row.entityId, storeId },
      select: { id: true },
    });
    if (!product) return 'gone';
    const now = await db.productCategory.findMany({
      where: { productId: row.entityId },
      select: { categoryId: true },
    });
    if (idsKey(now.map(r => r.categoryId)) !== next) return 'edited_since';
    const prevIds = JSON.parse(prev) as string[];
    // a category deleted since the run cannot come back: restore the ones that still exist
    const alive = await db.category.findMany({
      where: { storeId, id: { in: prevIds } },
      select: { id: true },
    });
    const aliveIds = new Set(alive.map(c => c.id));
    await w.$transaction([
      w.productCategory.deleteMany({ where: { productId: row.entityId } }),
      w.productCategory.createMany({
        data: prevIds
          .filter(id => aliveIds.has(id))
          .map((categoryId, position) => ({ productId: row.entityId, categoryId, position })),
      }),
      mark(),
    ]);
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
          data: { [field]: prev },
        })
      : kind === 'category'
        ? w.category.updateMany({
            where: { id: row.entityId, storeId, [field]: next },
            data: { [field]: prev },
          })
        : w.productImage.updateMany({
            where: { id: row.entityId, productId: row.productId ?? undefined, alt: next },
            data: { alt: prev },
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
