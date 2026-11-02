/**
 * `product_embeddings` (search program P1, Task 9): pgvector + one bge-m3 vector per product.
 *
 * Proves the schema contract Task 10-12 build on: `halfvec` + cosine distance exist (the
 * `vector` extension is installed by the migration), the table is under the strict R-EBDA-001
 * policy (on a REAL `ebda_app` login, cross-store), both FKs CASCADE (product hard-delete and
 * StoreService.delete remove the rows; nothing references the table, so no NO ACTION child is
 * added), the tenant guard covers the model, and `ebda_product_embed_doc` builds the embedding
 * input. Owner-role `prisma` is used only for fixtures and read-backs. Fixtures are per CALL.
 *
 * planner-owner-ok: the EXPLAIN here only checks that an IMMUTABLE helper is inlined (SQL shape),
 * not that any index is used.
 */
import crypto from 'node:crypto';
import { describe, it, expect, afterAll, vi } from 'vitest';
import pg from 'pg';
import { prisma, createPrismaClient, runWithRequestDb } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';
import { configureIdentityClient } from '@api/lib/identity-client';

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
      SELECT public.ebda_product_embed_doc('Shoes', 'أحذية', ${'<p>جلد <b>طبيعي</b></p>'}, ${long}) AS d`;
    expect(r.d).toContain('أحذية');
    expect(r.d).toContain('جلد طبيعي');
    expect(r.d).not.toContain('<b>');
    expect(r.d.length).toBeLessThan(1500 + 200);
  });

  it('SEARCH-T13-7: a nullable words vector + hash, set together or not at all', async () => {
    const cols = await prisma.$queryRaw<Array<{ c: string; t: string; n: string }>>`
      SELECT a.attname::text AS c, format_type(a.atttypid, a.atttypmod) AS t,
             CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS n
        FROM pg_attribute a WHERE a.attrelid = 'product_embeddings'::regclass
         AND a.attname IN ('terms_embedding', 'terms_hash') ORDER BY 1`;
    expect(cols).toEqual([
      { c: 'terms_embedding', t: 'halfvec(1024)', n: 'YES' },
      { c: 'terms_hash', t: 'text', n: 'YES' },
    ]);
    const [c] = await prisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'product_embeddings'::regclass AND conname = 'product_embeddings_terms_pair_chk'`;
    expect(c?.def).toMatch(/terms_embedding IS NULL.*=.*terms_hash IS NULL/);
  });

  it('SEARCH-T13-5/8: contracted — only the 4-argument doc (no words) exists; the 5-argument one is dropped', async () => {
    const sigs = await prisma.$queryRaw<Array<{ args: string }>>`
      SELECT pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'ebda_product_embed_doc' ORDER BY 1`;
    expect(sigs).toEqual([{ args: 'p_name text, p_name_ar text, p_desc text, p_desc_ar text' }]);
    const [r] = await prisma.$queryRaw<Array<{ d: string }>>`
      SELECT public.ebda_product_embed_doc('Mug', 'مج', 'سيراميك', NULL) AS d`;
    expect(r.d).toBe('مج\nMug\nسيراميك');
  });

  it('embed doc tolerates NULL fields and is IMMUTABLE invoker-rights sql', async () => {
    const [r] = await prisma.$queryRaw<Array<{ d: string }>>`
      SELECT public.ebda_product_embed_doc('Bag', NULL, NULL, NULL) AS d`;
    expect(r.d).toBe('Bag');
    const [f] = await prisma.$queryRaw<Array<{ vol: string; secdef: boolean }>>`
      SELECT p.provolatile::text AS vol, p.prosecdef AS secdef FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'ebda_product_embed_doc'
        AND p.pronargs = 4`;
    expect(f).toEqual({ vol: 'i', secdef: false });
  });

  it('embed doc trims every kind of whitespace and drops whitespace-only parts', async () => {
    const [r] = await prisma.$queryRaw<Array<{ d: string }>>`
      SELECT public.ebda_product_embed_doc(${'\t Bag \r\n'}, ${'\n'}, ${' \t '}, NULL) AS d`;
    expect(r.d).toBe('Bag');
  });

  it('embed doc turns tags into a space, collapses whitespace, and keeps a bare < or >', async () => {
    const doc = async (desc: string) => {
      const [r] = await prisma.$queryRaw<Array<{ d: string }>>`
        SELECT public.ebda_product_embed_doc('X', NULL, ${desc}, NULL) AS d`;
      return r.d;
    };
    expect(await doc('<p>قطن</p><p>مصري</p>')).toBe('X\nقطن مصري');
    expect(await doc('price < 50 and > 10')).toBe('X\nprice < 50 and > 10');
    expect(await doc('<ul>\n  <li>a</li>\n\n  <li>b</li>\n</ul>')).toBe('X\na b');
    expect(await doc('a<br/>b<!-- note -->c')).toBe('X\na b c');
  });

  it('embed doc is NULL (not an empty string) when every part is empty', async () => {
    // Task 11 must skip a NULL doc instead of embedding md5('').
    const [r] = await prisma.$queryRaw<Array<{ a: string | null; b: string | null }>>`
      SELECT public.ebda_product_embed_doc(NULL, NULL, NULL, NULL) AS a,
             public.ebda_product_embed_doc(' ', ${'\t'}, '<p> </p>', NULL) AS b`;
    expect(r).toEqual({ a: null, b: null });
  });

  it('embed doc is honestly IMMUTABLE: the planner inlines it (no STABLE call in its body)', async () => {
    // Postgres inlines an IMMUTABLE sql function only when its body contains no mutable call, so a
    // label that hides a STABLE function (concat_ws, array_to_string) leaves the call in the plan.
    const plan = await prisma.$queryRaw<Array<{ 'QUERY PLAN': string }>>`
      EXPLAIN (VERBOSE) SELECT public.ebda_product_embed_doc(p.name, p.name_ar, p.description, p.description_ar)
      FROM products p LIMIT 1`;
    const text = plan.map(r => r['QUERY PLAN']).join('\n');
    expect(text).not.toMatch(/ebda_product_embed_doc/);
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

  it('Task 14: both vectors are stored inline (toast_tuple_target 8160), not in TOAST', async () => {
    const [rel] = await prisma.$queryRaw<Array<{ opts: string[] | null }>>`
      SELECT reloptions AS opts FROM pg_class WHERE oid = 'public.product_embeddings'::regclass`;
    expect(rel.opts).toContain('toast_tuple_target=8160');
    // Behaviour, not just the option: 150 rows of two incompressible 1024-dim vectors (~4 KB each
    // row) grow the heap and leave the TOAST relation untouched. (Measured at 20 000 products
    // with the default EXTENDED: the exact KNN scan read the vectors back through the TOAST index
    // (~5 buffer hits per value, 120 k hits per query) and took 74 ms alone and ~1.2 s mean
    // under 30 searches/s, against 30 ms and 26 ms inline.)
    const ROLLBACK = Symbol('rollback');
    let grew = { heap: 0n, toast: 0n };
    const storeId = await seedStore('inline');
    await prisma
      .$transaction(
        async tx => {
          const size = async () => {
            const [r] = await tx.$queryRaw<Array<{ heap: bigint; toast: bigint }>>`
              SELECT pg_relation_size('public.product_embeddings'::regclass) AS heap,
                     pg_relation_size((SELECT reltoastrelid FROM pg_class
                                       WHERE oid = 'public.product_embeddings'::regclass)) AS toast`;
            return r;
          };
          const before = await size();
          await tx.$executeRaw`
            INSERT INTO public.products (id, store_id, name, slug, price, status, updated_at)
            SELECT 'inl-' || ${uid()} || '-' || g, ${storeId}, 'n' || g, 'inl-' || ${uid()} || '-' || g,
                   1000, 'active', now()
            FROM generate_series(1, 150) g`;
          await tx.$executeRaw`
            INSERT INTO public.product_embeddings
              (product_id, store_id, model, content_hash, embedding, terms_embedding, terms_hash)
            SELECT p.id, p.store_id, '@cf/baai/bge-m3', md5(p.id),
                   (SELECT array_agg(random()::real) FROM generate_series(1, 1024))::real[]::halfvec(1024),
                   (SELECT array_agg(random()::real) FROM generate_series(1, 1024))::real[]::halfvec(1024),
                   'h'
            FROM public.products p WHERE p.store_id = ${storeId}`;
          const after = await size();
          grew = { heap: after.heap - before.heap, toast: after.toast - before.toast };
          throw ROLLBACK;
        },
        { timeout: 60_000 }
      )
      .catch(e => {
        if (e !== ROLLBACK) throw e;
      });
    expect(grew.heap).toBeGreaterThan(0n);
    expect(grew.toast).toBe(0n);
  }, 90_000);

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
    // Deleting a store flips its identity-managed owner at the identity service (store.service.ts); the Postgres tier has no
    // ACCOUNTS binding, so answer as the service would for an active account.
    configureIdentityClient({
      getAccountState: async () => ({ status: 'active' }) as never,
      setStatus: async () => undefined,
      revokeUser: async () => undefined,
      deleteStoreClients: async () => ({ clients: 0 }),
    });
    try {
      await StoreService.delete(s, operator.id);
    } finally {
      configureIdentityClient(undefined);
    }
    expect(await prisma.store.count({ where: { id: s } })).toBe(0);
    expect(await embeddingCount({ storeId: s })).toBe(0);
  });
});
