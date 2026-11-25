/**
 * Ported from tests/integration/product-3d-models.test.ts (Postgres, strict RLS on a real `ebda_app` login). The real
 * product-model.service runs on the StoreDO schema (node:sqlite through prisma-lite, the wiring of bulk-do-roundtrip.test.ts), one
 * database PER STORE as in production, so "store B cannot see or write store A" is the per-store DO boundary (a separate SQLite)
 * plus the service's own product-in-store check. Also: the binding validation, replacing a file drops stale bindings, the
 * schema CHECKs refuse an out-of-range binding, and deleting an option value / the product cascades.
 * The public PDP payload mapping (`toPublicModel3d`) is pinned by the product-3d unit tests; the route gate by product-model-routes.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { openSqlite, META } from '../../packages/repo/test/diff-harness';
import { nodeSqlRunner } from '../../packages/repo/test/node-sql';
import { createPrismaLite } from '../../packages/repo/src/prisma-lite/client';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const dbs = {
  [A]: openSqlite(),
  [B]: openSqlite(),
} as Record<string, ReturnType<typeof openSqlite>>;
const lites = Object.fromEntries(
  Object.entries(dbs).map(([k, d]) => [
    k,
    createPrismaLite(META, nodeSqlRunner(d), 'store-do', { unscoped: true }) as any,
  ])
) as Record<string, any>;

vi.mock('../../apps/api/src/lib/repo-factory', () => ({
  storeDb: async (id: string) => lites[id],
  storeWriter: async (id: string) => lites[id],
  storeRepo: async () => ({ backend: 'do' }),
}));

import {
  PUBLIC_MODEL3D_SELECT,
  toPublicModel3d,
  getAdminModel,
  replaceBindings,
  upsertModel,
} from '../../apps/api/src/services/product-model.service';

const MODEL = (name: string, materials = ['Band', 'Stone']) => ({
  modelUrl: `https://media.test/stores/x/models/${name}.glb`,
  modelBytes: 1234,
  materials: materials.map((n, index) => ({ index, name: n })),
  gltfVariants: [] as string[],
  stats: { vertices: 3, meshes: 1, materials: materials.length, textures: 0, extensionsUsed: [] },
});
const n = (store: string, sql: string) => (dbs[store]!.prepare(sql).get() as { n: number }).n;

function seed(store: string, tag: string) {
  const d = dbs[store]!;
  d.prepare(
    `INSERT INTO products (id, store_id, name, slug, price, status, has_variants) VALUES ('prod-${tag}', '${store}', 'ring', 'ring-${tag}', 100000, 'active', 1)`
  ).run();
  d.prepare(
    `INSERT INTO product_options (id, product_id, name, position) VALUES ('metal-${tag}', 'prod-${tag}', 'Metal', 0)`
  ).run();
  d.prepare(
    `INSERT INTO product_options (id, product_id, name, position) VALUES ('size-${tag}', 'prod-${tag}', 'Size', 1)`
  ).run();
  const v = d.prepare(
    `INSERT INTO product_option_values (id, option_id, value, position) VALUES (?, ?, ?, ?)`
  );
  v.run(`gold-${tag}`, `metal-${tag}`, 'Gold', 0);
  v.run(`rose-${tag}`, `metal-${tag}`, 'Rose', 1);
  v.run(`small-${tag}`, `size-${tag}`, 'S', 0);
}

beforeAll(() => {
  seed(A, 'a');
  seed(B, 'b');
});

describe('product 3D model lifecycle on the StoreDO schema (store A, in order)', () => {
  it('creates the model and lists the product options with value ids', async () => {
    const r = await upsertModel(A, 'prod-a', MODEL('v1'));
    expect(r).toEqual({ previousModelUrl: null, droppedBindings: 0 });
    const got = await getAdminModel(A, 'prod-a');
    expect(got.model?.modelUrl).toContain('/v1.glb');
    expect(got.options.map(o => o.name)).toEqual(['Metal', 'Size']);
    expect(got.options[0].values.map(v => v.id)).toEqual(['gold-a', 'rose-a']);
  });

  it('saves bindings for this product only, onto materials the file has; a refused set changes nothing', async () => {
    const saved = await replaceBindings(A, 'prod-a', [
      {
        optionValueId: 'gold-a',
        kind: 'material',
        target: 'Band',
        color: '#ffc356',
        metalness: 1,
        roughness: 0.25,
      },
      {
        optionValueId: 'rose-a',
        kind: 'material',
        target: 'Band',
        color: '#f2b49b',
        metalness: 1,
        roughness: 0.25,
      },
      {
        optionValueId: 'rose-a',
        kind: 'material',
        target: 'Stone',
        color: '#ffffff',
        metalness: 0,
        roughness: 0.1,
      },
    ]);
    expect(saved).toBe(3);
    await expect(
      replaceBindings(A, 'prod-a', [
        { optionValueId: 'gold-b', kind: 'material', target: 'Band', color: '#000000' },
      ])
    ).rejects.toMatchObject({ code: 'INVALID_OPTION_VALUE' });
    await expect(
      replaceBindings(A, 'prod-a', [
        { optionValueId: 'gold-a', kind: 'material', target: 'Nope', color: '#000000' },
      ])
    ).rejects.toMatchObject({ code: 'UNKNOWN_TARGET' });
    expect(n(A, 'SELECT COUNT(*) n FROM product_model_bindings')).toBe(3);
  });

  it('the public PDP select + payload carry the model with bindings keyed by option name + value', async () => {
    const row = await lites[A].productModel.findFirst({
      where: { productId: 'prod-a' },
      select: PUBLIC_MODEL3D_SELECT,
    });
    const m3d = toPublicModel3d(row);
    expect(m3d).toMatchObject({ modelUrl: expect.stringContaining('/v1.glb'), arEnabled: true });
    expect(m3d!.bindings).toContainEqual({
      optionName: 'Metal',
      value: 'Gold',
      kind: 'material',
      target: 'Band',
      color: '#ffc356',
      metalness: 1,
      roughness: 0.25,
    });
  });

  it('replacing the file drops bindings whose material is gone, keeps the rest', async () => {
    const r = await upsertModel(A, 'prod-a', MODEL('v2', ['Band']));
    expect(r).toEqual({ previousModelUrl: expect.stringContaining('/v1.glb'), droppedBindings: 1 });
    expect(n(A, 'SELECT COUNT(*) n FROM product_model_bindings')).toBe(2);
  });

  it('deleting an option value cascades its binding', () => {
    dbs[A]!.prepare(`DELETE FROM product_option_values WHERE id = 'rose-a'`).run();
    const left = dbs[A]!.prepare(
      'SELECT option_value_id v FROM product_model_bindings'
    ).all() as Array<{ v: string }>;
    expect(left.map(b => b.v)).toEqual(['gold-a']);
  });
});

describe('concurrent first uploads for one product', () => {
  it('both requests succeed and leave ONE row (the loser replaces the winner)', async () => {
    dbs[A]!.prepare(
      `INSERT INTO products (id, store_id, name, slug, price) VALUES ('race', '${A}', 'race', 'race', 1)`
    ).run();
    const results = await Promise.all(['r1', 'r2'].map(tag => upsertModel(A, 'race', MODEL(tag))));
    expect(results).toHaveLength(2);
    expect(n(A, `SELECT COUNT(*) n FROM product_models WHERE product_id = 'race'`)).toBe(1);
  });
});

describe('store isolation (the per-store DO is the RLS equivalent) and schema CHECKs', () => {
  it('store B holds none of store A rows, and cannot upsert a model onto store A product', async () => {
    expect(n(B, 'SELECT COUNT(*) n FROM product_models')).toBe(0);
    expect(n(B, 'SELECT COUNT(*) n FROM product_model_bindings')).toBe(0);
    await expect(upsertModel(B, 'prod-a', MODEL('steal'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(n(A, `SELECT COUNT(*) n FROM product_models WHERE product_id = 'prod-a'`)).toBe(1);
  });

  it('the CHECK constraints refuse an out-of-range binding even past the API', () => {
    const model = dbs[A]!.prepare(
      `SELECT id FROM product_models WHERE product_id = 'prod-a'`
    ).get() as { id: string };
    const ins = (kind: string, color: string | null, extra = 'NULL') =>
      dbs[A]!.prepare(
        `INSERT INTO product_model_bindings (id, store_id, model_id, option_value_id, kind, target, color, metalness) VALUES (?, '${A}', ?, 'small-a', ?, 'Band', ?, ${extra})`
      ).run(crypto.randomUUID(), model.id, kind, color);
    expect(() => ins('material', 'red')).toThrow();
    expect(() => ins('texture', null)).toThrow();
    expect(() => ins('material', '#ffffff', '2')).toThrow(); // metalness out of 0..1
  });

  it('deleting the product cascades its model and bindings', () => {
    dbs[A]!.prepare(`DELETE FROM products WHERE id = 'prod-a'`).run();
    expect(n(A, `SELECT COUNT(*) n FROM product_models WHERE product_id = 'prod-a'`)).toBe(0);
    expect(n(A, 'SELECT COUNT(*) n FROM product_model_bindings')).toBe(0);
  });
});
