/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * N-17 (NEON-ZERO, plan item 5): SUPER-ADMIN CROSS-STORE READS over the built Worker, the D1 directory and real StoreDOs.
 *
 * Four DO stores hold 2 / 3 / 1 / 4 products. The super-admin product list (`GET /admin/products`, a fan-out over every store)
 * and store list (`GET /admin/stores`, one D1 page + per-store counts from each DO) must:
 *  - visit EVERY store (all 10 products, all 4 stores, each with its own count): no silent cap, no store dropped;
 *  - paginate completely and without repeats, whatever the page size;
 *  - refuse a store admin (403 on the super-admin-only list) and scope the shared lists to the stores they own.
 * The bound itself (500 stores per fan-out, reported as `truncated`) is asserted on the helpers in workers-do/hub-fanout.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { DEFAULT_PLAN_SEEDS } from '@ebda/shared';
import { accessToken, authState } from './helpers';

const e = env as unknown as {
  API: { fetch(u: string, i?: RequestInit): Promise<Response> };
  PLATFORM_DB: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } };
  TEST_PLATFORM_MIGRATIONS: unknown[];
  E2E_DB: string;
};
const BASE = 'https://api.ebda.app/api/v1';
const SEED_TOKEN = 'workers-test-seed-token';
const PER_STORE = [2, 3, 1, 4];

let ip = 0;
const get = (path: string, token?: string) =>
  e.API.fetch(BASE + path, {
    headers: {
      'cf-connecting-ip': `10.8.0.${ip++ & 255}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

interface S {
  id: string;
  owner: string;
  slug: string;
  productIds: string[];
}
const stores: S[] = [];
let su = '';
let ownerTok = '';

describe.skipIf(e.E2E_DB === '1')(
  'super-admin cross-store reads: every store visited, complete pages, 403 for others',
  () => {
    it('fixture: four DO stores with 2/3/1/4 products', async () => {
      await applyD1Migrations(e.PLATFORM_DB as never, e.TEST_PLATFORM_MIGRATIONS as never);
      for (const p of DEFAULT_PLAN_SEEDS)
        await e.PLATFORM_DB.prepare(
          'INSERT OR IGNORE INTO plans (id, code, name_en, name_ar, feature_tier, limits, price_monthly_minor, price_yearly_minor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
        )
          .bind(
            `plan-${p.code}`,
            p.code,
            p.nameEn,
            p.nameAr,
            p.featureTier,
            JSON.stringify(p.limits),
            p.priceMonthlyMinor,
            p.priceYearlyMinor
          )
          .run();
      for (const [i, k] of [
        'platform_cutover.billing',
        'platform_cutover.access',
        'platform_cutover.platform',
        'platform_cutover.inbox',
        'platform_cutover.ai-usage',
        'platform_cutover.analytics',
        'platform_cutover.payments',
        'platform_cutover.ops',
        'platform_cutover.audit',
        'customer_auth_cutover.__all',
      ].entries())
        await e.PLATFORM_DB.prepare(
          'INSERT OR REPLACE INTO system_settings (id, key, value) VALUES (?1, ?2, \'{"on":true}\')'
        )
          .bind(`xs-marker-${i}`, k)
          .run();
      let t = Date.now() - 100_000;
      for (const [n, count] of PER_STORE.entries()) {
        const owner = `owner-xs-${n}`;
        const slug = `xs-shop-${n}`;
        const made = await e.API.fetch('https://api.ebda.app/__dev/create-store', {
          method: 'POST',
          body: JSON.stringify({ ownerId: owner, name: `XS Shop ${n}`, slug, operator: true }),
        });
        expect(made.status).toBe(200);
        const id = ((await made.json()) as { id: string }).id;
        const productIds = Array.from({ length: count }, () => crypto.randomUUID());
        const seeded = await e.API.fetch(
          `https://api.ebda.app/api/v1/internal/store-do/${id}/seed`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${SEED_TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              products: productIds.map((pid, j) => ({
                id: pid,
                storeId: id,
                name: `XS ${n}.${j}`,
                slug: `xs-${n}-${j}`,
                price: 1000,
                inventory: 5,
                status: 'active',
                hasVariants: false,
                // distinct, increasing: the merged order is deterministic across stores
                createdAt: (t += 1000),
                updatedAt: t,
              })),
            }),
          }
        );
        expect(seeded.status).toBe(200);
        stores.push({ id, owner, slug, productIds });
        await authState(`user:tv:${owner}`, [['set', `user:tv:${owner}`, '0', {}]]);
      }
      await authState('user:tv:super-xs', [['set', 'user:tv:super-xs', '0', {}]]);
      su = await accessToken({ userId: 'super-xs', jti: 'j-xs-su', role: 'super_admin' });
      ownerTok = await accessToken({
        userId: stores[0]!.owner,
        jti: 'j-xs-o0',
        role: 'store_admin',
        storeId: stores[0]!.id,
      });
    });

    const allProducts = () => stores.flatMap(s => s.productIds);

    it('GET /admin/products visits every store: all products, from all stores, total = the sum', async () => {
      const res = await get('/admin/products?limit=100', su);
      expect(res.status).toBe(200);
      const j = (await res.json()) as {
        data: { products: Array<{ id: string; storeId: string }>; pagination: { total: number } };
      };
      const ids = j.data.products.map(p => p.id);
      expect(ids.length).toBe(allProducts().length);
      expect(new Set(ids)).toEqual(new Set(allProducts()));
      expect(j.data.pagination.total).toBe(allProducts().length);
      for (const s of stores)
        expect(j.data.products.filter(p => p.storeId === s.id).length).toBe(s.productIds.length);
    });

    it('GET /admin/products paginates completely and without repeats at every page size', async () => {
      for (const limit of [1, 3, 4]) {
        const seen: string[] = [];
        const pages = Math.ceil(allProducts().length / limit);
        for (let page = 1; page <= pages + 1; page++) {
          const r = await get(`/admin/products?limit=${limit}&page=${page}`, su);
          expect(r.status).toBe(200);
          const j = (await r.json()) as {
            data: { products: Array<{ id: string }>; pagination: { total: number } };
          };
          expect(j.data.pagination.total).toBe(allProducts().length);
          if (page > pages) expect(j.data.products).toEqual([]);
          seen.push(...j.data.products.map(p => p.id));
        }
        expect(seen.length, `limit ${limit}: no repeats and no gaps`).toBe(allProducts().length);
        expect(new Set(seen)).toEqual(new Set(allProducts()));
      }
    });

    it('GET /admin/stores lists every store with its own DO counts, and its pages are complete', async () => {
      const r = await get('/admin/stores?limit=100', su);
      expect(r.status).toBe(200);
      const j = (await r.json()) as {
        data: {
          stores: Array<{ id: string; _count: { products: number } }>;
          meta: { total: number };
          pagination: { total: number };
        };
      };
      // The admin /stores subtitle reads `pagination`; it read "0 stores" while `meta` carried the count.
      expect(j.data.pagination.total).toBe(j.data.meta.total);
      for (const s of stores) {
        const row = j.data.stores.find(x => x.id === s.id);
        expect(row, `store ${s.slug} listed`).toBeTruthy();
        expect(row!._count.products).toBe(s.productIds.length);
      }
      expect(j.data.meta.total).toBeGreaterThanOrEqual(stores.length);
      const seen: string[] = [];
      for (let page = 1; page <= j.data.meta.total; page++) {
        const p = (await (await get(`/admin/stores?limit=1&page=${page}`, su)).json()) as {
          data: { stores: Array<{ id: string }> };
        };
        seen.push(...p.data.stores.map(x => x.id));
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(new Set(seen)).toEqual(new Set(j.data.stores.map(x => x.id)));
    });

    it('GET /admin/dashboard aggregates over every store for a super admin', async () => {
      const r = await get('/admin/dashboard', su);
      expect(r.status).toBe(200);
      const j = (await r.json()) as { data: { stats: { stores: number } } };
      expect(j.data.stats.stores).toBeGreaterThanOrEqual(stores.length);
    });

    it('a store admin gets 403 on the super-admin-only list, and only their own store on the shared ones', async () => {
      expect((await get('/admin/products?limit=100', ownerTok)).status).toBe(403);
      expect((await get('/admin/products?limit=100')).status).toBe(401);
      const r = await get('/admin/stores?limit=100', ownerTok);
      expect(r.status).toBe(200);
      const j = (await r.json()) as { data: { stores: Array<{ id: string }> } };
      expect(j.data.stores.map(x => x.id)).toEqual([stores[0]!.id]);
      const d = (await (await get('/admin/dashboard', ownerTok)).json()) as {
        data: { stats: { stores: number } };
      };
      expect(d.data.stats.stores).toBe(1);
    });
  }
);
