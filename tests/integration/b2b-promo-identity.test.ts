/**
 * Group-targeted promotions and coupons follow the SAME identity as group prices (Ruling B2B-2c, extended 2026-10-21 by the
 * coordinator): the session (or a merchant's explicit Customer pick) decides group membership, never a typed phone or email.
 * Before this change `resolveCustomerContext` mapped a typed shipping phone / a self-edited `User.phone` to a `customers`
 * row and its group, so anyone who typed a VIP's phone received the VIP promotion or coupon.
 *
 * Real Postgres as `ebda_app`, real services. Retry-safe: fixtures keyed on a per-run suffix.
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
  type AppPrismaClient,
} from '@ebda/database';
import {
  resolveCustomerContext,
  resolveBestPromotion,
} from '../../apps/api/src/services/promotion-resolver';
import { CouponService } from '../../apps/api/src/services/coupon.service';
import { CustomerGroupService } from '../../apps/api/src/services/customer-group.service';
import { getCustomerProfile } from '../../apps/api/src/services/customer-aggregate.service';
import { ANONYMOUS_BUYER, type BuyerIdentity } from '../../apps/api/src/lib/buyer-identity';

const OWNER_URL = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
const APP_PASSWORD = process.env.EBDA_APP_PASSWORD || 'ci-only-app-pw';
const RUN = `b2bpromo-${crypto.randomBytes(4).toString('hex')}`;
const VIP_PHONE = '+201055551111';
const VIP_EMAIL = `${RUN}-vip@test.com`;

let owner: AppPrismaClient;
const makeApp = (): AppPrismaClient => {
  const u = new URL(OWNER_URL);
  u.username = 'ebda_app';
  u.password = APP_PASSWORD;
  return new PrismaClient({
    adapter: new PrismaPg(
      new pg.Pool({ connectionString: u.toString(), max: 2, Client: TextFallbackClient }),
      { disposeExternalPool: true }
    ),
  }) as unknown as AppPrismaClient;
};
const asApp = <T>(storeId: string, fn: () => Promise<T>) =>
  runWithRequestDb(makeApp, () => runInTenantContext(storeId, fn));
const session = (userId: string) => ({ kind: 'session', userId }) as unknown as BuyerIdentity;
const merchantPick = (customerId: string) =>
  ({ kind: 'merchant-selected', customerId, actorUserId: 'staff' }) as unknown as BuyerIdentity;

const ids = {} as Record<string, string>;
const cartItems = (productId: string) => [
  { productId, categoryIds: [] as string[], quantity: 1, lineTotal: 10_000 },
];

async function cleanup() {
  await owner.$executeRawUnsafe(
    `DELETE FROM public.orders WHERE store_id IN (SELECT id FROM public.stores WHERE slug LIKE '${RUN}%')`
  );
  await owner.$executeRawUnsafe(`DELETE FROM public.stores WHERE slug LIKE '${RUN}%'`);
  await owner.$executeRawUnsafe(`DELETE FROM public.users WHERE email LIKE '${RUN}%'`);
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: OWNER_URL, max: 3, role: 'owner' });
  await owner.$executeRawUnsafe(`ALTER ROLE ebda_app WITH LOGIN PASSWORD '${APP_PASSWORD}'`);
  await cleanup();
  const user = (tag: string, o: Record<string, unknown> = {}) =>
    owner.user.create({
      data: {
        email: `${RUN}-${tag}@test.com`,
        passwordHash: 'x',
        firstName: tag,
        lastName: 'T',
        role: 'customer',
        emailVerified: true,
        ...o,
      } as never,
    });
  const merchant = await user('merchant', { role: 'store_admin' });
  const store = await owner.store.create({
    data: { slug: `${RUN}-s`, name: 'S', ownerId: merchant.id },
  });
  const vipUser = await owner.user.create({
    data: {
      email: VIP_EMAIL,
      passwordHash: 'x',
      firstName: 'Vip',
      lastName: 'One',
      role: 'customer',
      emailVerified: true,
      storeId: store.id,
      phone: VIP_PHONE,
    },
  });
  const attacker = await user('attacker', { storeId: store.id, phone: VIP_PHONE });
  const vip = await owner.customerGroup.create({ data: { storeId: store.id, name: 'VIP' } });
  const other = await owner.customerGroup.create({ data: { storeId: store.id, name: 'Other' } });
  const vipRow = await owner.customer.create({
    data: {
      storeId: store.id,
      email: VIP_EMAIL,
      phone: VIP_PHONE,
      firstName: 'Vip',
      lastName: 'One',
      groupId: vip.id,
      userId: vipUser.id,
    },
  });
  const product = await owner.product.create({
    data: { storeId: store.id, name: 'p', slug: `${RUN}-p`, price: 10_000 },
  });
  const promo = await owner.promotion.create({
    data: {
      storeId: store.id,
      name: 'VIP 20',
      type: 'percentage',
      value: 20,
      customerGroupId: vip.id,
    },
  });
  const coupon = await owner.coupon.create({
    data: {
      storeId: store.id,
      code: `${RUN}-VIP10`.toUpperCase(),
      name: 'VIP10',
      type: 'percentage',
      value: 10,
      customerGroupId: vip.id,
    },
  });
  for (const [u, n] of [
    [vipUser, 'vip'],
    [attacker, 'att'],
  ] as const) {
    await owner.order.create({
      data: {
        storeId: store.id,
        customerId: u.id,
        orderNumber: `${RUN}-${n}`,
        subtotal: 10,
        total: 10,
        shippingAddress: { firstName: n, lastName: 'T', phone: u.phone ?? '', email: u.email },
        billingAddress: {},
      },
    });
  }
  Object.assign(ids, {
    store: store.id,
    vipUser: vipUser.id,
    attacker: attacker.id,
    vip: vip.id,
    other: other.id,
    vipRow: vipRow.id,
    product: product.id,
    promo: promo.id,
    coupon: coupon.id,
    merchant: merchant.id,
  });
});

afterAll(async () => {
  await cleanup();
  await owner.$disconnect();
});

const ctxFor = (buyer: BuyerIdentity, typed: { phone?: string; email?: string }) =>
  asApp(ids.store!, async () => {
    const c = await resolveCustomerContext(ids.store!, { ...typed }, buyer);
    const targeting = { ...c, cartItems: cartItems(ids.product!) };
    const best = await resolveBestPromotion(ids.store!, targeting);
    const coupon = await owner.coupon.findUnique({ where: { id: ids.coupon! } });
    const couponEval = CouponService.evaluateForCart(coupon!, targeting);
    return { c, best, couponEval };
  });

describe('group-targeted promotions and coupons: only the session or a merchant pick decides group membership', () => {
  it('the VIP signed in gets the VIP promotion and the VIP coupon', async () => {
    const r = await ctxFor(session(ids.vipUser!), {});
    expect(r.c.customerGroupId).toBe(ids.vip);
    expect(r.best).toMatchObject({ promotionId: ids.promo, discount: 2_000 });
    expect(r.couponEval).toMatchObject({ eligible: true, discount: 1_000 });
  });

  it('a GUEST typing the VIP phone and email at checkout gets no group benefits (no VIP promo, no VIP coupon)', async () => {
    const r = await ctxFor(ANONYMOUS_BUYER, { phone: VIP_PHONE, email: VIP_EMAIL });
    expect(r.c.customerGroupId).toBeNull();
    expect(r.best).toBeNull();
    expect(r.couponEval.eligible).toBe(false);
  });

  it("a signed-in attacker whose PROFILE phone is the VIP's, typing the VIP phone too, gets no VIP promo or coupon", async () => {
    const r = await ctxFor(session(ids.attacker!), { phone: VIP_PHONE, email: VIP_EMAIL });
    expect(r.c.customerGroupId).toBeNull();
    expect(r.best).toBeNull();
    expect(r.couponEval.eligible).toBe(false);
  });

  it("a merchant-selected Customer (admin order) is that row's group", async () => {
    const r = await ctxFor(merchantPick(ids.vipRow!), {});
    expect(r.c.customerGroupId).toBe(ids.vip);
    expect(r.best).toMatchObject({ discount: 2_000 });
  });

  it('first-order status is still decided from account / typed history (unchanged), not from the group link', async () => {
    const a = await ctxFor(session(ids.vipUser!), {});
    expect(a.c.isFirstOrder).toBe(false); // the VIP has a prior order
    const g = await ctxFor(ANONYMOUS_BUYER, { phone: '+201099990000' });
    expect(g.c.isFirstOrder).toBe(true);
  });
});

describe('assignByIdentity never clobbers an existing row (Ruling B2B-2e)', () => {
  const vipRowNow = () => owner.customer.findUniqueOrThrow({ where: { id: ids.vipRow! } });

  it('the C1 attack: a merchant re-selecting a group from the ATTACKER profile leaves the VIP row untouched and the VIP still a VIP', async () => {
    const before = await vipRowNow();
    const attacker = await owner.user.findUniqueOrThrow({ where: { id: ids.attacker! } });
    await asApp(ids.store!, () =>
      CustomerGroupService.assignByIdentity(
        ids.store!,
        {
          userId: attacker.id,
          phone: attacker.phone,
          email: attacker.email,
          firstName: 'Att',
          lastName: 'Acker',
        },
        ids.vip!
      )
    );
    const after = await vipRowNow();
    expect(after).toMatchObject({
      email: before.email,
      phone: before.phone,
      firstName: before.firstName,
      lastName: before.lastName,
      groupId: ids.vip,
      userId: ids.vipUser,
    });
    // the attacker got their OWN linked row (contact fields only where free), and it grants nothing to the VIP
    const mine = await owner.customer.findFirst({
      where: { storeId: ids.store!, userId: ids.attacker! },
    });
    expect(mine).toMatchObject({ groupId: ids.vip });
    expect(mine?.phone).toBeNull(); // the phone is taken by the VIP row: never stolen, never duplicated
    expect(mine?.email).toBe(attacker.email);
  });

  it('I-3: a typed phone that only matches a row LINKED to a registered shopper is refused (409), and nothing on that row changes', async () => {
    const before = await vipRowNow();
    await expect(
      asApp(ids.store!, () =>
        CustomerGroupService.assignByIdentity(
          ids.store!,
          {
            phone: VIP_PHONE,
            email: `${RUN}-someone-else@test.com`,
            firstName: 'Evil',
            lastName: 'Name',
          },
          ids.other!
        )
      )
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDENTITY_LINKED_TO_ACCOUNT' });
    expect(await vipRowNow()).toMatchObject({
      email: before.email,
      phone: before.phone,
      firstName: before.firstName,
      lastName: before.lastName,
      userId: before.userId,
      groupId: ids.vip,
    });
  });

  it('a typed phone that matches an UNLINKED CRM row attaches the group and rewrites NO contact or name field', async () => {
    const crm = await owner.customer.create({
      data: {
        storeId: ids.store!,
        phone: '+201066660001',
        email: `${RUN}-guest@test.com`,
        firstName: 'Guest',
        lastName: 'One',
      },
    });
    await asApp(ids.store!, () =>
      CustomerGroupService.assignByIdentity(
        ids.store!,
        {
          phone: '+201066660001',
          email: `${RUN}-other@test.com`,
          firstName: 'Evil',
          lastName: 'Name',
        },
        ids.other!
      )
    );
    expect(await owner.customer.findUniqueOrThrow({ where: { id: crm.id } })).toMatchObject({
      email: `${RUN}-guest@test.com`,
      phone: '+201066660001',
      firstName: 'Guest',
      lastName: 'One',
      userId: null,
      groupId: ids.other,
    });
  });

  it("I-3 (B2B-2c attack): the attacker puts a wholesaler's not-yet-known phone on their profile and gets a group; the merchant then assigns the REAL wholesaler by that guest phone: the attacker's row is untouched and the real one is a separate row", async () => {
    const P = '+201066660099';
    const evil = await owner.user.create({
      data: {
        email: `${RUN}-evil@test.com`,
        passwordHash: 'x',
        firstName: 'E',
        lastName: 'V',
        role: 'customer',
        emailVerified: true,
        storeId: ids.store!,
        phone: P,
      },
    });
    // merchant (or Task 5) gives the attacker's account a group: their linked row must NOT inherit the self-edited phone
    await asApp(ids.store!, () =>
      CustomerGroupService.assignByIdentity(ids.store!, { userId: evil.id, phone: P }, ids.other!)
    );
    const evilRow = await owner.customer.findFirstOrThrow({
      where: { storeId: ids.store!, userId: evil.id },
    });
    expect(evilRow.phone).toBeNull();
    // the real wholesaler is then approved from their guest profile (key = phone P)
    const real = await asApp(ids.store!, () =>
      CustomerGroupService.assignByIdentity(
        ids.store!,
        { phone: P, firstName: 'Real', lastName: 'Wholesaler' },
        ids.vip!
      )
    );
    expect(real.id).not.toBe(evilRow.id);
    expect(await owner.customer.findUniqueOrThrow({ where: { id: evilRow.id } })).toMatchObject({
      groupId: ids.other,
      userId: evil.id,
    });
  });

  it('a userId that is not a customer of this store is a 404, never a link', async () => {
    await expect(
      asApp(ids.store!, () =>
        CustomerGroupService.assignByIdentity(
          ids.store!,
          { userId: ids.merchant!, email: 'x@y.z' },
          ids.vip!
        )
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('assigning by userId twice updates the same linked row (one CRM row per user)', async () => {
    const u = await owner.user.create({
      data: {
        email: `${RUN}-twice@test.com`,
        passwordHash: 'x',
        firstName: 'T',
        lastName: 'W',
        role: 'customer',
        emailVerified: true,
        storeId: ids.store!,
      },
    });
    const run = (g: string | null) =>
      asApp(ids.store!, () =>
        CustomerGroupService.assignByIdentity(ids.store!, { userId: u.id, email: u.email }, g)
      );
    const a = await run(ids.vip!);
    const b = await run(ids.other!);
    expect(b.id).toBe(a.id);
    expect(b.groupId).toBe(ids.other);
  });
});

describe('the registered-shopper profile shows the group of THAT user', () => {
  it("the attacker's profile does not display the VIP group; the VIP's does", async () => {
    // reset the attacker's own linked row (created by the attack test) so only the phone coincidence remains
    await owner.customer.deleteMany({ where: { storeId: ids.store!, userId: ids.attacker! } });
    const att = await asApp(ids.store!, () => getCustomerProfile(ids.store!, ids.attacker!));
    expect(att.customer.groupId).toBeNull();
    const vip = await asApp(ids.store!, () => getCustomerProfile(ids.store!, ids.vipUser!));
    expect(vip.customer.groupId).toBe(ids.vip);
  });
});
