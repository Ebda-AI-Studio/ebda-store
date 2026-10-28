/**
 * Swatch colour/photo on product option values, against a REAL Postgres on a
 * real `ebda_app` login (strict RLS + the code-level tenant guard), same
 * harness as product-3d-models.test.ts. Proves: create-with-swatch via
 * VariantService.addOption, the public PDP payload carries swatchHex /
 * swatchImageUrl (null when unset, never undefined), update sets/clears each
 * independently (undefined leaves alone, null clears), the DB CHECK refuses a
 * malformed hex, and the route schemas reject a bad hex before the service.
 *
 * RETRY: `retry: 0` - an ordered state machine on one store.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { optionValueSwatchSchema } from '@ebda/shared';
import {
  createPrismaClient,
  runWithRequestDb,
  runInTenantContext,
  prisma,
  type AppPrismaClient,
} from '@ebda/database';
import { VariantService } from '../../apps/api/src/services/variant.service';
import { ProductService } from '../../apps/api/src/services/product.service';
import { setAppRoleLogin } from '../helpers/app-role-login';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const PREFIX = `swt-${crypto.randomUUID().slice(0, 8)}-`;

let owner: AppPrismaClient;
const ids = { store: '', product: '', slug: '', option: '', teal: '' };

function appUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return u.toString();
}
const makeApp = () => createPrismaClient({ connectionString: appUrl(), max: 2 });
const inStore = <T>(fn: () => Promise<T>) =>
  runWithRequestDb(makeApp, () => runInTenantContext(ids.store, fn));

async function publicValues() {
  const p = await inStore(() => ProductService.getPublicBySlug(ids.store, ids.slug));
  return p.options[0].values;
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
  await setAppRoleLogin(owner, APP_PASSWORD);
  const u = await owner.user.create({
    data: {
      email: `${PREFIX}o@test.com`,
      passwordHash: 'x',
      firstName: 'o',
      lastName: 'T',
      role: 'store_admin' as never,
    },
  });
  const s = await owner.store.create({
    data: { slug: `${PREFIX}s`, name: 's', ownerId: u.id, template: 'qamar' },
  });
  ids.store = s.id;
  ids.slug = `${PREFIX}p`;
  const p = await owner.product.create({
    data: { storeId: s.id, name: 'tee', slug: ids.slug, price: 10000, status: 'active' },
  });
  ids.product = p.id;
});

afterAll(async () => {
  const inPrefix = `(SELECT id FROM public.stores WHERE slug LIKE '${PREFIX}%')`;
  await owner.$executeRawUnsafe(`DELETE FROM public.products WHERE store_id IN ${inPrefix}`);
  await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${PREFIX}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${PREFIX}%'`);
  await owner.$disconnect();
  await prisma.$disconnect().catch(() => undefined);
});

describe('option value swatches (in order)', { retry: 0 }, () => {
  it('stores a swatch on create and the public PDP returns it (null when unset)', async () => {
    const opt = await inStore(() =>
      VariantService.addOption(ids.store, ids.product, {
        name: 'Color',
        nameAr: 'اللون',
        values: [{ value: 'Teal', valueAr: 'تيل', swatchHex: '#1F4E54' }, { value: 'Plain' }],
      })
    );
    ids.option = opt.id;
    const values = await publicValues();
    const teal = values.find(v => v.value === 'Teal')!;
    const plain = values.find(v => v.value === 'Plain')!;
    ids.teal = teal.id;
    expect(teal.swatchHex).toBe('#1F4E54');
    expect(teal.swatchImageUrl).toBeNull();
    expect(plain.swatchHex).toBeNull();
    expect(plain.swatchImageUrl).toBeNull();
  });

  it('updates image and hex independently; undefined leaves alone, null clears', async () => {
    await inStore(() =>
      VariantService.updateOptionValue(ids.store, ids.product, ids.teal, {
        swatchImageUrl: 'https://x.r2.dev/teal.webp',
      })
    );
    let teal = (await publicValues()).find(v => v.id === ids.teal)!;
    expect(teal.swatchHex).toBe('#1F4E54'); // untouched
    expect(teal.swatchImageUrl).toBe('https://x.r2.dev/teal.webp');

    await inStore(() =>
      VariantService.updateOptionValue(ids.store, ids.product, ids.teal, { swatchHex: null })
    );
    teal = (await publicValues()).find(v => v.id === ids.teal)!;
    expect(teal.swatchHex).toBeNull();
    expect(teal.swatchImageUrl).toBe('https://x.r2.dev/teal.webp');
  });

  it('addOptionValue accepts a swatch and the cache bust makes it visible', async () => {
    await inStore(() =>
      VariantService.addOptionValue(ids.store, ids.product, ids.option, {
        value: 'Sand',
        swatchHex: '#C2B280',
      })
    );
    const sand = (await publicValues()).find(v => v.value === 'Sand')!;
    expect(sand.swatchHex).toBe('#C2B280');
  });

  it('deleting a value or an option drops it from the (cached) public payload', async () => {
    const sandId = (await publicValues()).find(v => v.value === 'Sand')!.id;
    await inStore(() => VariantService.deleteOptionValue(ids.store, ids.product, sandId));
    expect((await publicValues()).some(v => v.value === 'Sand')).toBe(false);
    await inStore(() => VariantService.deleteOption(ids.store, ids.product, ids.option));
    const p = await inStore(() => ProductService.getPublicBySlug(ids.store, ids.slug));
    expect(p.options).toHaveLength(0);
  });

  it('rejects a bad hex at the route schema and at the DB CHECK', async () => {
    expect(optionValueSwatchSchema.safeParse({ swatchHex: 'red' }).success).toBe(false);
    expect(
      optionValueSwatchSchema.safeParse({ swatchHex: null, swatchImageUrl: null }).success
    ).toBe(true);
    const keep = await owner.productOption.create({
      data: { productId: ids.product, name: 'Shade', values: { create: [{ value: 'K' }] } },
      include: { values: true },
    });
    await expect(
      owner.$executeRawUnsafe(
        `UPDATE public.product_option_values SET swatch_hex = 'red' WHERE id = '${keep.values[0].id}'`
      )
    ).rejects.toThrow();
  });
});
