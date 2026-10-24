// ORM comparison worker (Task 0.2). Local `wrangler dev` / workerd only; never deployed.
//   /orm/drizzle/{seed,products,cart,order}   -> OrmDO (SQLite DO, drizzle durable-sqlite)
//   /orm/prisma/{seed,products,cart}          -> Prisma 6.19.3 client built PER REQUEST over D1
import { DurableObject } from 'cloudflare:workers';
import { makeDrizzle, listProducts, addCartItem, createOrder } from './drizzle-do';
import * as schema from '../src/schema';
import * as P from './rejected/prisma-d1';
import core from '../migrations/0001_core.sql';
import { statements } from '../src/sql';

interface Env {
  ORM_DO: DurableObjectNamespace<OrmDO>;
  ORM_D1: D1Database;
}

const STORE = 'store-orm-1';
const seedRows = () => {
  const now = Date.now();
  const products = Array.from({ length: 50 }, (_, i) => ({
    id: `p-${i + 1}`,
    storeId: STORE,
    name: `Product ${i + 1}`,
    nameAr: `منتج ${i + 1}`,
    slug: `product-${i + 1}`,
    price: 10000 + i * 100,
    compareAtPrice: null,
    inventory: 100,
    status: 'active' as const,
    hasVariants: false,
    createdAt: now + i,
    updatedAt: now,
  }));
  return {
    store: {
      id: STORE,
      slug: 'orm',
      name: 'ORM store',
      currency: 'EGP',
      createdAt: now,
      updatedAt: now,
    },
    products,
  };
};

const ms = (t0: number) => Math.round((performance.now() - t0) * 1000) / 1000;
const json = (body: unknown, timing: Record<string, number>) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'x-timing': JSON.stringify(timing) },
  });

export class OrmDO extends DurableObject<Env> {
  readonly db: ReturnType<typeof makeDrizzle>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const t0 = performance.now();
    ctx.blockConcurrencyWhile(async () => {
      for (const stmt of statements(core)) ctx.storage.sql.exec(stmt);
    });
    this.db = makeDrizzle(ctx.storage); // one wrapper object per DO lifetime, not per request
    void t0;
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const t0 = performance.now();
    switch (url.pathname.split('/').pop()) {
      case 'seed': {
        const { store, products } = seedRows();
        this.db.insert(schema.stores).values(store).onConflictDoNothing().run();
        for (const p of products)
          this.db.insert(schema.products).values(p).onConflictDoNothing().run();
        return json({ seeded: products.length }, { total_ms: ms(t0) });
      }
      case 'products': {
        const rows = listProducts(this.db, STORE, 24);
        return json(rows, { query_ms: ms(t0), construct_ms: 0 });
      }
      case 'cart': {
        const sid = url.searchParams.get('sid') ?? crypto.randomUUID();
        return json(addCartItem(this.db, STORE, sid, 'p-1', 1), {
          query_ms: ms(t0),
          construct_ms: 0,
        });
      }
      case 'order': {
        const sid = url.searchParams.get('sid') ?? 'none';
        try {
          return json(createOrder(this.db, STORE, sid), { query_ms: ms(t0), construct_ms: 0 });
        } catch (e) {
          return json({ error: (e as Error).message }, { query_ms: ms(t0) });
        }
      }
    }
    return new Response('not found', { status: 404 });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const [, , impl, op] = url.pathname.split('/');
    if (impl === 'drizzle') return env.ORM_DO.get(env.ORM_DO.idFromName(STORE)).fetch(req);
    if (impl === 'prisma') {
      if (op === 'seed') {
        for (const stmt of statements(core)) await env.ORM_D1.exec(stmt);
        const { store, products } = seedRows();
        const ins = env.ORM_D1.prepare(
          'INSERT OR IGNORE INTO products (id,store_id,name,name_ar,slug,price,compare_at_price,inventory,status,has_variants,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
        );
        await env.ORM_D1.batch([
          env.ORM_D1.prepare(
            'INSERT OR IGNORE INTO stores (id,slug,name,currency,created_at,updated_at) VALUES (?,?,?,?,?,?)'
          ).bind(
            store.id,
            store.slug,
            store.name,
            store.currency,
            store.createdAt,
            store.updatedAt
          ),
          ...products.map(p =>
            ins.bind(
              p.id,
              p.storeId,
              p.name,
              p.nameAr,
              p.slug,
              p.price,
              null,
              p.inventory,
              p.status,
              0,
              p.createdAt,
              p.updatedAt
            )
          ),
        ]);
        return json({ seeded: products.length }, {});
      }
      const t0 = performance.now();
      const prisma = P.makePrisma(env.ORM_D1); // PER REQUEST, as production does
      const construct = ms(t0);
      const t1 = performance.now();
      if (op === 'products') {
        const rows = await P.listProducts(prisma, STORE, 24);
        const first = ms(t1);
        const t2 = performance.now();
        await P.listProducts(prisma, STORE, 24);
        return json(rows, {
          construct_ms: construct,
          first_query_ms: first,
          second_query_ms: ms(t2),
        });
      }
      if (op === 'cart') {
        const sid = url.searchParams.get('sid') ?? crypto.randomUUID();
        const out = await P.addCartItem(prisma, STORE, sid, 'p-1', 1);
        return json(out, { construct_ms: construct, first_query_ms: ms(t1) });
      }
    }
    return new Response('not found', { status: 404 });
  },
};
