/**
 * Product 3D models against a REAL Postgres, every assertion on a real
 * `ebda_app` login under strict RLS (same harness as page-builder.test.ts:
 * the superuser URL only builds fixtures and cleans up).
 *
 * Proves: create/replace a model (stale bindings dropped on replace), the
 * binding set is validated against THIS product's option values and the
 * file's materials, the public PDP payload carries the bindings keyed by
 * option name + value, store B cannot read or write store A's rows, a
 * context-less read sees nothing, and option-value / product deletes cascade.
 *
 * RETRY: `retry: 0` — an ordered state machine on one store, and an RLS
 * assertion that passes only on retry is a finding (CLAUDE.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { TextFallbackClient } from '../../packages/database/src/client';
import {
  createPrismaClient,
  runWithRequestDb,
  runInTenantContext,
  prisma,
  type AppPrismaClient,
} from '@ebda/database';
import {
  getAdminModel,
  replaceBindings,
  upsertModel,
} from '../../apps/api/src/services/product-model.service';
import { ProductService } from '../../apps/api/src/services/product.service';
import { setAppRoleLogin } from '../helpers/app-role-login';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const PREFIX = `p3d-${crypto.randomUUID().slice(0, 8)}-`;

let owner: AppPrismaClient;
const ids = {
  storeA: '',
  storeB: '',
  productA: '',
  productB: '',
  slugA: '',
  gold: '',
  rose: '',
  small: '',
  valueOfB: '',
};

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const makeApp = () => createPrismaClient({ connectionString: appUrl(), max: 2 });
const inStore = <T>(storeId: string, fn: () => Promise<T>) =>
  runWithRequestDb(makeApp, () => runInTenantContext(storeId, fn));

/**
 * The RLS proof below must run UNGUARDED: the code-level tenant guard (R-EBDA-003) would refuse
 * the deliberately unscoped queries before Postgres saw them, so the policy would go unproved.
 * Same shape as tests/integration/rls-ebda-app.test.ts: a plain ebda_app client, GUC set by hand.
 */
async function rawApp<T>(
  storeId: string | undefined,
  fn: (tx: PrismaClient) => Promise<T>
): Promise<T> {
  const client = new PrismaClient({
    adapter: new PrismaPg(
      new pg.Pool({ connectionString: appUrl(), max: 1, Client: TextFallbackClient }),
      { disposeExternalPool: true }
    ),
  });
  try {
    return await client.$transaction(async tx => {
      if (storeId) await tx.$queryRaw`SELECT set_config('app.current_store_id', ${storeId}, true)`;
      return fn(tx as unknown as PrismaClient);
    });
  } finally {
    await client.$disconnect();
  }
}

const MODEL = (name: string, materials = ['Band', 'Stone']) => ({
  modelUrl: `https://media.test/stores/x/models/${name}.glb`,
  modelBytes: 1234,
  materials: materials.map((n, index) => ({ index, name: n })),
  gltfVariants: [] as string[],
  stats: { vertices: 3, meshes: 1, materials: materials.length, textures: 0, extensionsUsed: [] },
});

async function freshStore(tag: string): Promise<string> {
  const u = await owner.user.create({
    data: {
      email: `${PREFIX}${tag}@test.com`,
      passwordHash: 'x',
      firstName: tag,
      lastName: 'T',
      role: 'store_admin' as never,
    },
  });
  const s = await owner.store.create({
    data: { slug: `${PREFIX}${tag}`, name: tag, ownerId: u.id, template: 'qamar' },
  });
  return s.id;
}

async function productWithOptions(storeId: string, tag: string) {
  const slug = `${PREFIX}${tag}`;
  const p = await owner.product.create({
    data: {
      storeId,
      name: `ring ${tag}`,
      slug,
      price: 100000,
      status: 'active',
      hasVariants: true,
    },
  });
  const metal = await owner.productOption.create({
    data: {
      productId: p.id,
      name: 'Metal',
      position: 0,
      values: {
        create: [
          { value: 'Gold', position: 0 },
          { value: 'Rose', position: 1 },
        ],
      },
    },
    include: { values: true },
  });
  const size = await owner.productOption.create({
    data: { productId: p.id, name: 'Size', position: 1, values: { create: [{ value: 'S' }] } },
    include: { values: true },
  });
  return { p, metal, size, slug };
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
  await setAppRoleLogin(owner, APP_PASSWORD);
  ids.storeA = await freshStore('a');
  ids.storeB = await freshStore('b');
  const a = await productWithOptions(ids.storeA, 'pa');
  const b = await productWithOptions(ids.storeB, 'pb');
  ids.productA = a.p.id;
  ids.slugA = a.slug;
  ids.productB = b.p.id;
  ids.gold = a.metal.values.find(v => v.value === 'Gold')!.id;
  ids.rose = a.metal.values.find(v => v.value === 'Rose')!.id;
  ids.small = a.size.values[0].id;
  ids.valueOfB = b.metal.values[0].id;
});

afterAll(async () => {
  const inPrefix = `(SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`;
  await owner.$executeRawUnsafe(`DELETE FROM public.products WHERE store_id IN ${inPrefix}`);
  await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
  await owner.$disconnect();
  await prisma.$disconnect().catch(() => undefined);
});

describe('product 3D model lifecycle (store A, in order)', { retry: 0 }, () => {
  it('creates the model and lists the product options with value ids', async () => {
    const r = await inStore(ids.storeA, () => upsertModel(ids.storeA, ids.productA, MODEL('v1')));
    expect(r).toEqual({ previousModelUrl: null, droppedBindings: 0 });
    const got = await inStore(ids.storeA, () => getAdminModel(ids.storeA, ids.productA));
    expect(got.model?.modelUrl).toContain('/v1.glb');
    expect(got.options.map(o => o.name)).toEqual(['Metal', 'Size']);
    expect(got.options[0].values.map(v => v.id)).toEqual([ids.gold, ids.rose]);
  });

  it('saves bindings for this product only, onto materials the file has', async () => {
    const n = await inStore(ids.storeA, () =>
      replaceBindings(ids.storeA, ids.productA, [
        {
          optionValueId: ids.gold,
          kind: 'material',
          target: 'Band',
          color: '#ffc356',
          metalness: 1,
          roughness: 0.25,
        },
        {
          optionValueId: ids.rose,
          kind: 'material',
          target: 'Band',
          color: '#f2b49b',
          metalness: 1,
          roughness: 0.25,
        },
        {
          optionValueId: ids.rose,
          kind: 'material',
          target: 'Stone',
          color: '#ffffff',
          metalness: 0,
          roughness: 0.1,
        },
      ])
    );
    expect(n).toBe(3);
    await expect(
      inStore(ids.storeA, () =>
        replaceBindings(ids.storeA, ids.productA, [
          { optionValueId: ids.valueOfB, kind: 'material', target: 'Band', color: '#000000' },
        ])
      )
    ).rejects.toMatchObject({ code: 'INVALID_OPTION_VALUE' });
    await expect(
      inStore(ids.storeA, () =>
        replaceBindings(ids.storeA, ids.productA, [
          { optionValueId: ids.gold, kind: 'material', target: 'Nope', color: '#000000' },
        ])
      )
    ).rejects.toMatchObject({ code: 'UNKNOWN_TARGET' });
    const rows = await owner.productModelBinding.count({ where: { storeId: ids.storeA } });
    expect(rows).toBe(3); // the refused sets changed nothing
  });

  it('the public PDP payload carries the model with bindings keyed by option name + value', async () => {
    const p = await inStore(ids.storeA, () =>
      ProductService.getPublicBySlug(ids.storeA, ids.slugA)
    );
    expect(p.model3d).toMatchObject({
      modelUrl: expect.stringContaining('/v1.glb'),
      arEnabled: true,
    });
    expect(p.model3d!.bindings).toContainEqual({
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
    const r = await inStore(ids.storeA, () =>
      upsertModel(ids.storeA, ids.productA, MODEL('v2', ['Band']))
    );
    expect(r).toEqual({
      previousModelUrl: expect.stringContaining('/v1.glb'),
      droppedBindings: 1,
    });
    expect(await owner.productModelBinding.count({ where: { storeId: ids.storeA } })).toBe(2);
  });

  it('deleting an option value cascades its binding (no NO ACTION child)', async () => {
    await owner.productOptionValue.delete({ where: { id: ids.rose } });
    const left = await owner.productModelBinding.findMany({ where: { storeId: ids.storeA } });
    expect(left.map(b => b.optionValueId)).toEqual([ids.gold]);
  });
});

describe('concurrent first uploads for one product', { retry: 0 }, () => {
  it('both requests succeed and leave ONE row (the loser replaces the winner)', async () => {
    const p = await owner.product.create({
      data: {
        storeId: ids.storeA,
        name: 'race',
        slug: `${PREFIX}race-${crypto.randomUUID().slice(0, 6)}`,
        price: 1,
      },
    });
    const results = await Promise.all(
      ['r1', 'r2'].map(tag => inStore(ids.storeA, () => upsertModel(ids.storeA, p.id, MODEL(tag))))
    );
    expect(results).toHaveLength(2);
    expect(await owner.productModel.count({ where: { productId: p.id } })).toBe(1);
  });
});

describe('strict RLS on product_models / product_model_bindings', { retry: 0 }, () => {
  it('store B sees none of store A rows and cannot write into store A', async () => {
    const seen = await rawApp(ids.storeB, async tx => ({
      models: await tx.productModel.count(),
      bindings: await tx.productModelBinding.count(),
    }));
    expect(seen).toEqual({ models: 0, bindings: 0 });
    await expect(
      rawApp(ids.storeB, tx =>
        tx.productModel.create({
          data: {
            storeId: ids.storeA,
            productId: ids.productB,
            modelUrl: 'https://x/y.glb',
            modelBytes: 1,
          },
        })
      )
    ).rejects.toThrow();
    await expect(
      inStore(ids.storeB, () => upsertModel(ids.storeB, ids.productA, MODEL('steal')))
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a context-less ebda_app read sees nothing and a write is rejected', async () => {
    expect(await rawApp(undefined, tx => tx.productModel.count())).toBe(0);
    expect(await rawApp(undefined, tx => tx.productModelBinding.count())).toBe(0);
    await expect(
      rawApp(undefined, tx =>
        tx.productModel.create({
          data: {
            storeId: ids.storeB,
            productId: ids.productB,
            modelUrl: 'https://x/y.glb',
            modelBytes: 1,
          },
        })
      )
    ).rejects.toThrow();
    // ...while the owner sees store A's row exists (the zero above is RLS, not emptiness).
    expect(await owner.productModel.count({ where: { productId: ids.productA } })).toBe(1);
  });

  it('the CHECK constraints refuse an out-of-range binding even past the API', async () => {
    const model = await owner.productModel.findFirstOrThrow({ where: { storeId: ids.storeA } });
    await expect(
      owner.productModelBinding.create({
        data: {
          storeId: ids.storeA,
          modelId: model.id,
          optionValueId: ids.small,
          kind: 'material',
          target: 'Band',
          color: 'red',
        },
      })
    ).rejects.toThrow();
    await expect(
      owner.productModelBinding.create({
        data: {
          storeId: ids.storeA,
          modelId: model.id,
          optionValueId: ids.small,
          kind: 'texture',
          target: 'Band',
        },
      })
    ).rejects.toThrow();
  });

  it('deleting the product cascades its model and bindings', async () => {
    await owner.product.delete({ where: { id: ids.productA } });
    expect(await owner.productModel.count({ where: { productId: ids.productA } })).toBe(0);
    expect(
      await owner.productModelBinding.count({ where: { model: { productId: ids.productA } } })
    ).toBe(0);
  });
});
