/**
 * `product_embeddings` (search program P1, Task 9): pgvector + one bge-m3 vector per product.
 *
 * Proves the schema contract Task 10-12 build on: `halfvec` + cosine distance exist (the
 * `vector` extension is installed by the migration), the table is under the strict R-EBDA-001
 * policy (on a REAL `ebda_app` login, cross-store), both FKs CASCADE (product hard-delete and
 * StoreService.delete remove the rows; nothing references the table, so no NO ACTION child is
 * added), the tenant guard covers the model, and `ebda_product_embed_doc` builds the embedding
 * input. Owner-role `prisma` is used only for fixtures and read-backs. Fixtures are per CALL.
 */
import crypto from 'node:crypto';
import { describe, it, expect, afterAll, vi } from 'vitest';
import pg from 'pg';
import { prisma, createPrismaClient, runWithRequestDb } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));
const { StoreService } = await import('../../apps/api/src/services/store.service');

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
  return u.toString();
}
const uid = () => crypto.randomUUID().slice(0, 8);
const created = { userIds: [] as string[], storeIds: [] as string[] };

/** A 1024-dim halfvec literal with a single 1 at `hot` (unit vector). */
const unitVec = (hot: number) =>
  `[${Array.from({ length: 1024 }, (_, i) => (i === hot ? 1 : 0)).join(',')}]`;

async function seedStore(tag: string): Promise<string> {
  const id = uid();
  const owner = await prisma.user.create({
    data: {
      email: `pe-${tag}-${id}@test.local`,
      passwordHash: 'x',
      firstName: 'Embed',
      lastName: 'Ding',
      role: 'store_admin',
      status: 'active',
      emailVerified: true,
    },
  });
  created.userIds.push(owner.id);
  const store = await prisma.store.create({
    data: {
      name: `pe ${tag} ${id}`,
      slug: `pe-${tag}-${id}`,
      ownerId: owner.id,
      status: 'active',
      currency: 'EGP',
    },
  });
  created.storeIds.push(store.id);
  return store.id;
}

async function seedEmbeddedProduct(storeId: string, hot = 0): Promise<string> {
  const run = uid();
  const p = await prisma.product.create({
    data: {
      storeId,
      slug: `pe-${run}`,
      name: `pe ${run}`,
      price: 1000,
      inventory: 1,
      status: 'active',
    },
  });
  await prisma.$executeRaw`
    INSERT INTO product_embeddings (product_id, store_id, model, content_hash, embedding)
    VALUES (${p.id}, ${storeId}, '@cf/baai/bge-m3', md5('x'), ${unitVec(hot)}::halfvec(1024))`;
  return p.id;
}

const embeddingCount = async (where: { storeId?: string; productId?: string }) => {
  const [r] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM product_embeddings
    WHERE (${where.storeId ?? null}::text IS NULL OR store_id = ${where.storeId ?? null})
      AND (${where.productId ?? null}::text IS NULL OR product_id = ${where.productId ?? null})`;
  return Number(r.n);
};

/** One ebda_app transaction with the store GUC set the way tenant-context sets it (tx-local). */
async function asAppInStore<T>(storeId: string, sql: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: appUrl() });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_store_id', $1, true)`, [storeId]);
    const r = await c.query(sql);
    await c.query('COMMIT');
    return r.rows as T[];
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}

afterAll(async () => {
  if (!hasDb) return;
  await prisma.product.deleteMany({ where: { storeId: { in: created.storeIds } } });
  await prisma.store.deleteMany({ where: { id: { in: created.storeIds } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: created.userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: created.userIds } } });
});

describe.skipIf(!hasDb)('product_embeddings', () => {
  it('pgvector supports halfvec and cosine distance', async () => {
    const [r] = await prisma.$queryRaw<
      Array<{ d: number }>
    >`SELECT ('[1,0]'::halfvec(2) <=> '[0,1]'::halfvec(2))::float8 AS d`;
    expect(r.d).toBeCloseTo(1);
  });

  it('is RLS-forced with the strict policy', async () => {
    const [r] = await prisma.$queryRaw<Array<{ f: boolean; p: bigint }>>`
      SELECT c.relforcerowsecurity AS f, (SELECT count(*) FROM pg_policies WHERE tablename='product_embeddings') AS p
      FROM pg_class c WHERE c.relname='product_embeddings'`;
    expect(r.f).toBe(true);
    expect(Number(r.p)).toBe(1);
  });

  it('embed doc strips html, keeps arabic as written, caps description', async () => {
    const long = 'x'.repeat(4000);
    const [r] = await prisma.$queryRaw<Array<{ d: string }>>`
      SELECT public.ebda_product_embed_doc('Shoes', 'أحذية', '3abaya', ${'<p>جلد <b>طبيعي</b></p>'}, ${long}) AS d`;
    expect(r.d).toContain('أحذية');
    expect(r.d).toContain('جلد طبيعي');
    expect(r.d).not.toContain('<b>');
    expect(r.d.length).toBeLessThan(1500 + 200);
  });

  it('embed doc tolerates NULL fields and is IMMUTABLE invoker-rights sql', async () => {
    const [r] = await prisma.$queryRaw<Array<{ d: string }>>`
      SELECT public.ebda_product_embed_doc('Bag', NULL, NULL, NULL, NULL) AS d`;
    expect(r.d).toBe('Bag');
    const [f] = await prisma.$queryRaw<Array<{ vol: string; secdef: boolean }>>`
      SELECT p.provolatile::text AS vol, p.prosecdef AS secdef FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'ebda_product_embed_doc'`;
    expect(f).toEqual({ vol: 'i', secdef: false });
  });

  it('both FKs cascade and no table references product_embeddings (no NO ACTION child)', async () => {
    const fks = await prisma.$queryRaw<Array<{ col: string; ref: string; del: string }>>`
      SELECT kcu.column_name::text AS col, ccu.table_name::text AS ref, rc.delete_rule::text AS del
      FROM information_schema.referential_constraints rc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = rc.unique_constraint_name
      WHERE kcu.table_name = 'product_embeddings' ORDER BY 1`;
    expect(fks).toEqual([
      { col: 'product_id', ref: 'products', del: 'CASCADE' },
      { col: 'store_id', ref: 'stores', del: 'CASCADE' },
    ]);
    const [children] = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'public.product_embeddings'::regclass`;
    expect(Number(children.n)).toBe(0);
  });

  it('has the store_id and (store_id, embedded_at) btree indexes', async () => {
    const idx = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname::text FROM pg_indexes WHERE tablename = 'product_embeddings' ORDER BY 1`;
    expect(idx.map(i => i.indexname)).toEqual([
      'product_embeddings_pkey',
      'product_embeddings_store_id_embedded_at_idx',
      'product_embeddings_store_id_idx',
    ]);
  });

  it('ebda_app sees only its own store’s vectors and cannot write into another store', async () => {
    const a = await seedStore('a');
    const b = await seedStore('b');
    const pa = await seedEmbeddedProduct(a, 1);
    await seedEmbeddedProduct(b, 2);
    const seenA = await asAppInStore<{ product_id: string }>(
      a,
      'SELECT product_id FROM product_embeddings'
    );
    expect(seenA.map(r => r.product_id)).toEqual([pa]);
    await expect(
      asAppInStore(
        a,
        `INSERT INTO product_embeddings (product_id, store_id, model, content_hash, embedding)
         VALUES ('${pa}', '${b}', 'm', 'h', '${unitVec(3)}'::halfvec(1024))`
      )
    ).rejects.toThrow(/row-level security/i);
    // KNN ranks within the store: the nearest neighbour of the unit vector at 1 is pa.
    const knn = await asAppInStore<{ product_id: string; d: number }>(
      a,
      `SELECT product_id, (embedding <=> '${unitVec(1)}'::halfvec(1024))::float8 AS d
       FROM product_embeddings WHERE store_id = '${a}' ORDER BY d LIMIT 5`
    );
    expect(knn).toEqual([{ product_id: pa, d: 0 }]);
  });

  it('the tenant guard covers ProductEmbedding (contextless read refused)', async () => {
    await expect(
      runWithRequestDb(
        () => createPrismaClient({ connectionString: appUrl(), max: 1 }),
        () => prisma.productEmbedding.count()
      )
    ).rejects.toThrow(/TenantScope|tenant/i);
  });

  it('product hard-delete and store deletion cascade to the vectors', async () => {
    const s = await seedStore('del');
    const p1 = await seedEmbeddedProduct(s, 4);
    await seedEmbeddedProduct(s, 5);
    await prisma.product.delete({ where: { id: p1 } });
    expect(await embeddingCount({ productId: p1 })).toBe(0);
    expect(await embeddingCount({ storeId: s })).toBe(1);
    const operator = await prisma.user.create({
      data: {
        email: `pe-op-${uid()}@test.local`,
        passwordHash: 'x',
        firstName: 'Op',
        lastName: 'Erator',
        role: 'super_admin',
      },
    });
    created.userIds.push(operator.id);
    await StoreService.delete(s, operator.id);
    expect(await prisma.store.count({ where: { id: s } })).toBe(0);
    expect(await embeddingCount({ storeId: s })).toBe(0);
  });
});
