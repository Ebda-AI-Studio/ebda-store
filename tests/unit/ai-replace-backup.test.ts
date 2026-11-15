/**
 * AITOOLS-4: an AI "replace existing" run backs the old value up in the same atomic write, undo restores it, and undo
 * refuses a field the merchant edited after the run. Runs the REAL service over the REAL StoreDO schema (0001 + prisma-lite on
 * node:sqlite). Each test fails on the old code (no backup table / no service / fill-only sweeps).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';
import { META, openSqlite, insertSqlite } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { DO_PROCS } from '../../packages/repo/src/rpc/writes';

const STORE = 'store-a';
const holder = vi.hoisted(() => ({
  lite: null as any,
  db: null as any,
  failBackup: false,
  /** runs right before a $proc executes: a merchant edit landing between the service's reads and its write */
  beforeProc: null as null | (() => void),
}));

// prisma-lite delegates are lazy and its $transaction is the DO's atomic batch; only the backup-insert failure is injected.
const client = new Proxy(
  {},
  {
    get: (_t, model: string) => {
      if (model === '$transaction') return (ops: unknown[]) => holder.lite.$transaction(ops);
      if (model === '$proc')
        return (name: string, args: Record<string, unknown>) => ({
          then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
            Promise.resolve()
              .then(() => {
                holder.beforeProc?.();
                return DO_PROCS[name](nodeSqlRunner(holder.db), args);
              })
              .then(res, rej),
        });
      return new Proxy(
        {},
        {
          get:
            (_m, op: string) =>
            (...args: unknown[]) => {
              if (holder.failBackup && model === 'aiReplaceBackup' && op === 'create')
                return {
                  then: (_res: unknown, rej: (e: Error) => void) =>
                    rej(new Error('backup insert failed')),
                };
              return holder.lite[model][op](...args);
            },
        }
      );
    },
  }
);
const reindex = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../../apps/api/src/lib/search/reindex', () => ({ requestStoreReindex: reindex }));
vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async () => client,
  storeWriter: async () => client,
}));

import {
  listBackups,
  listReplaceRuns,
  purgeReplaceBackups,
  REPLACE_BACKUP_RETENTION_DAYS,
  replaceCategoriesWithBackup,
  replaceTextWithBackup,
  undoBackups,
  type ReplaceCtx,
} from '../../apps/api/src/services/catalogue-replace-backup.service';

const ctx: ReplaceCtx = { storeId: STORE, userId: 'u1', jobId: 'job-1', tool: 'translate_ar' };
let db: ReturnType<typeof openSqlite>;
const product = (id: string) =>
  db.prepare('SELECT name_ar, description_ar FROM products WHERE id = ?').get(id) as any;

beforeEach(() => {
  holder.failBackup = false;
  holder.beforeProc = null;
  db = openSqlite();
  holder.db = db;
  holder.lite = createPrismaLite(META as never, nodeSqlRunner(db), 'store-do', {
    storeId: STORE,
  }) as never;
  insertSqlite(db, 'Product', [
    { id: 'p1', storeId: STORE, name: 'Tee', nameAr: 'تيشرت', slug: 'tee', price: 100 },
  ]);
  insertSqlite(db, 'Category', [
    { id: 'c1', storeId: STORE, name: 'Men', slug: 'men' },
    { id: 'c2', storeId: STORE, name: 'Sale', slug: 'sale' },
    { id: 'c3', storeId: STORE, name: 'New', slug: 'new' },
  ]);
});

const swap = (next = 'قميص') =>
  replaceTextWithBackup(ctx, {
    entityKind: 'product',
    entityId: 'p1',
    field: 'nameAr',
    previous: 'تيشرت',
    next,
  });

describe('replace with backup', () => {
  it('writes the backup (who, which tool, which job, old and new value) together with the new value', async () => {
    expect(await swap()).toBe('replaced');
    expect(product('p1').name_ar).toBe('قميص');
    const rows = await listBackups(STORE, { productId: 'p1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      jobId: 'job-1',
      tool: 'translate_ar',
      userId: 'u1',
      field: 'nameAr',
      previousValue: 'تيشرت',
      newValue: 'قميص',
      productName: 'Tee',
      restoredAt: null,
    });
  });

  it('a replace without a backup is impossible: when the backup insert fails the value is untouched', async () => {
    holder.failBackup = true;
    await expect(swap()).rejects.toThrow('backup insert failed');
    expect(product('p1').name_ar).toBe('تيشرت');
  });

  it('refuses to "replace" an empty value (that is a fill, not a replace)', async () => {
    await expect(
      replaceTextWithBackup(ctx, {
        entityKind: 'product',
        entityId: 'p1',
        field: 'nameAr',
        previous: '  ',
        next: 'x',
      })
    ).rejects.toThrow(/fill/);
  });

  it('a retried batch does not replace (or back up) the same field twice in one run', async () => {
    await swap('قميص');
    expect(await swap('قميص ٢')).toBe('already');
    expect(product('p1').name_ar).toBe('قميص');
    expect(await listBackups(STORE, {})).toHaveLength(1);
  });

  it('leaves a value the merchant changed since the sweep read it, and keeps no orphan backup', async () => {
    db.prepare("UPDATE products SET name_ar = 'عدل التاجر' WHERE id = 'p1'").run();
    expect(await swap()).toBe('stale');
    expect(product('p1').name_ar).toBe('عدل التاجر');
    expect(await listBackups(STORE, {})).toHaveLength(0);
  });
});

describe('undo', () => {
  it('restores the previous value, per product, and marks the change undone', async () => {
    await swap();
    const res = await undoBackups(STORE, 'u2', { productId: 'p1' });
    expect(res).toEqual({ restored: 1, refused: [] });
    expect(reindex).toHaveBeenCalledWith(STORE, 'ai-replace-undo');
    expect(product('p1').name_ar).toBe('تيشرت');
    expect(await listBackups(STORE, { productId: 'p1' })).toHaveLength(0); // undone rows drop off the undoable list
    const all = await listBackups(STORE, { productId: 'p1', includeRestored: true });
    expect(all[0].restoredAt).not.toBeNull();
  });

  it('restores a whole bulk run by jobId and reports it in the runs list', async () => {
    insertSqlite(db, 'Product', [
      { id: 'p2', storeId: STORE, name: 'Cap', nameAr: 'كاب', slug: 'cap', price: 100 },
    ]);
    await swap();
    await replaceTextWithBackup(ctx, {
      entityKind: 'product',
      entityId: 'p2',
      field: 'nameAr',
      previous: 'كاب',
      next: 'قبعة',
    });
    expect(await listReplaceRuns(STORE)).toMatchObject([
      { jobId: 'job-1', tool: 'translate_ar', changed: 2, undone: 0 },
    ]);
    const res = await undoBackups(STORE, 'u1', { jobId: 'job-1' });
    expect(res.restored).toBe(2);
    expect(product('p2').name_ar).toBe('كاب');
    expect(await listReplaceRuns(STORE)).toMatchObject([{ changed: 2, undone: 2 }]);
  });

  it('refuses after a later manual edit and does NOT clobber the merchant value', async () => {
    await swap();
    db.prepare("UPDATE products SET name_ar = 'نسخة التاجر' WHERE id = 'p1'").run();
    const res = await undoBackups(STORE, 'u1', { jobId: 'job-1' });
    expect(res.restored).toBe(0);
    expect(res.refused).toMatchObject([{ reason: 'edited_since' }]);
    expect(product('p1').name_ar).toBe('نسخة التاجر');
    // still listed as undoable-in-principle, not marked restored
    expect(await listBackups(STORE, { productId: 'p1' })).toHaveLength(1);
  });

  it('needs a scope', async () => {
    await expect(undoBackups(STORE, 'u1', {})).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('category set and image alt', () => {
  beforeEach(() => {
    insertSqlite(db, 'ProductCategory', [
      { productId: 'p1', categoryId: 'c1', position: 0 },
      { productId: 'p1', categoryId: 'c2', position: 1 },
    ]);
  });
  const cats = () =>
    (
      db
        .prepare(
          'SELECT category_id FROM product_categories WHERE product_id = ? ORDER BY position'
        )
        .all('p1') as any[]
    ).map(r => r.category_id);
  const catCtx: ReplaceCtx = { ...ctx, tool: 'categorize' };

  it('replaces the category set with a backup and undo restores the old set', async () => {
    expect(
      await replaceCategoriesWithBackup(catCtx, {
        productId: 'p1',
        previousIds: ['c1', 'c2'],
        nextIds: ['c3'],
      })
    ).toBe('replaced');
    expect(cats()).toEqual(['c3']);
    expect((await undoBackups(STORE, 'u1', { productId: 'p1' })).restored).toBe(1);
    expect(cats().sort()).toEqual(['c1', 'c2']);
  });

  it('undo of a category change refuses after the merchant changed the categories', async () => {
    await replaceCategoriesWithBackup(catCtx, {
      productId: 'p1',
      previousIds: ['c1', 'c2'],
      nextIds: ['c3'],
    });
    db.prepare(
      "INSERT INTO product_categories (product_id, category_id, position) VALUES ('p1','c1',1)"
    ).run();
    const res = await undoBackups(STORE, 'u1', { productId: 'p1' });
    expect(res.refused).toMatchObject([{ reason: 'edited_since' }]);
    expect(cats().sort()).toEqual(['c1', 'c3']);
  });

  it('undo is ONE compare-and-set: a manual category edit landing between its reads and its write is never overwritten', async () => {
    await replaceCategoriesWithBackup(catCtx, {
      productId: 'p1',
      previousIds: ['c1', 'c2'],
      nextIds: ['c3'],
    });
    // the merchant adds c1 AFTER undo has read what it needs and BEFORE its write
    holder.beforeProc = () =>
      db
        .prepare(
          "INSERT INTO product_categories (product_id, category_id, position) VALUES ('p1','c1',1)"
        )
        .run();
    const res = await undoBackups(STORE, 'u1', { productId: 'p1' });
    expect(res.restored).toBe(0);
    expect(res.refused).toMatchObject([{ reason: 'edited_since' }]);
    expect(cats().sort()).toEqual(['c1', 'c3']); // the merchant's edit survives
    expect(await listBackups(STORE, { productId: 'p1' })).toHaveLength(1); // still not marked undone
  });

  it('the replace is the same compare-and-set: a set the merchant changed since the sweep read it is left alone, no orphan backup', async () => {
    holder.beforeProc = () =>
      db
        .prepare("DELETE FROM product_categories WHERE product_id = 'p1' AND category_id = 'c2'")
        .run();
    expect(
      await replaceCategoriesWithBackup(catCtx, {
        productId: 'p1',
        previousIds: ['c1', 'c2'],
        nextIds: ['c3'],
      })
    ).toBe('stale');
    expect(cats()).toEqual(['c1']);
    expect(await listBackups(STORE, {})).toHaveLength(0);
  });

  it('replaces and restores an image alt', async () => {
    insertSqlite(db, 'ProductImage', [
      { id: 'i1', productId: 'p1', url: 'https://x/y.png', alt: 'old alt' },
    ]);
    const altCtx: ReplaceCtx = { ...ctx, tool: 'image_alt' };
    expect(
      await replaceTextWithBackup(altCtx, {
        entityKind: 'product_image',
        entityId: 'i1',
        productId: 'p1',
        field: 'alt',
        previous: 'old alt',
        next: 'new alt',
      })
    ).toBe('replaced');
    const alt = () =>
      (db.prepare("SELECT alt FROM product_images WHERE id = 'i1'").get() as any).alt;
    expect(alt()).toBe('new alt');
    expect((await undoBackups(STORE, 'u1', { productId: 'p1' })).restored).toBe(1);
    expect(alt()).toBe('old alt');
  });
});

describe('retention (Ruling AITOOLS-5): the undo history is kept 90 days', () => {
  const DAY = 86_400_000;
  const seed = (id: string, ageDays: number, now: number) =>
    db
      .prepare(
        `INSERT INTO ai_replace_backups (id, store_id, job_id, tool, entity_kind, entity_id, field, created_at)
         VALUES (?, ?, ?, 'translate_ar', 'product', 'p1', 'nameAr', ?)`
      )
      .run(id, STORE, `job-${id}`, now - ageDays * DAY);
  const ids = () =>
    (db.prepare('SELECT id FROM ai_replace_backups ORDER BY id').all() as any[]).map(r => r.id);

  it('deletes rows older than 90 days and keeps the rest (undone or not)', async () => {
    const now = Date.now();
    seed('old-1', 91, now);
    seed('old-2', 400, now);
    seed('new-1', 89, now);
    seed('new-2', 1, now);
    expect(REPLACE_BACKUP_RETENTION_DAYS).toBe(90);
    expect(await purgeReplaceBackups(STORE, { now: new Date(now) })).toBe(2);
    expect(ids()).toEqual(['new-1', 'new-2']);
  });

  it('is batch-bounded: one call deletes at most batch x maxBatches rows, the next call continues', async () => {
    const now = Date.now();
    for (let i = 0; i < 7; i++) seed(`o${i}`, 100 + i, now);
    expect(await purgeReplaceBackups(STORE, { now: new Date(now), batch: 2, maxBatches: 2 })).toBe(
      4
    );
    expect(ids()).toHaveLength(3);
    expect(await purgeReplaceBackups(STORE, { now: new Date(now), batch: 2, maxBatches: 2 })).toBe(
      3
    );
    expect(ids()).toHaveLength(0);
  });

  it('runs from the existing daily retention job, not a cron of its own', () => {
    const src = readFileSync(
      join(__dirname, '../../apps/api/src/lib/inngest/functions/data-retention.ts'),
      'utf8'
    );
    expect(src).toContain('purgeReplaceBackupsAcrossStores');
    const own = readFileSync(
      join(__dirname, '../../apps/api/src/services/catalogue-replace-backup.service.ts'),
      'utf8'
    );
    expect(own).not.toContain('createFunction');
  });
});
