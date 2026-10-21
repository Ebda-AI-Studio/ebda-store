/**
 * Wholesale application + approval flow (B2B Task 5; Review Focus 8) and the applicant's data in export / erasure, against real
 * Postgres. Approval links the shopper through customers.user_id (linkApprovedBuyer), never assignByIdentity.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import { prisma } from '@ebda/database';

vi.mock('@api/services/email.service', async importOriginal => {
  const real = await importOriginal<typeof import('@api/services/email.service')>();
  return {
    ...real,
    EmailService: { ...real.EmailService, sendWholesaleNotice: vi.fn(async () => undefined) },
  };
});

import { WholesaleApplicationService } from '@api/services/wholesale-application.service';
import { EmailService } from '@api/services/email.service';
import { PriceResolver } from '@api/services/price-resolver.service';
import { CartService } from '@api/services/cart.service';
import { AuthService } from '@api/services/auth.service';
import { hasDb, seedBundleStore, seedProduct, cartSessionId } from '../helpers/bundle-fixtures';
import type { BuyerIdentity } from '@api/lib/buyer-identity';

const SUF = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
const id = {} as Record<string, string>;
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    e => (e as { code?: string }).code ?? String(e)
  );
const session = (userId: string) => ({ kind: 'session', userId }) as unknown as BuyerIdentity;
const VIP_PHONE = '+201055559999';

async function shopper(tag: string, o: Record<string, unknown> = {}) {
  return prisma.user.create({
    data: {
      email: `b2bapp-${tag}-${SUF}@test.com`,
      passwordHash: 'x',
      firstName: tag,
      lastName: 'S',
      role: 'customer',
      emailVerified: true,
      storeId: id.s,
      ...o,
    } as never,
  });
}
const form = (o: Record<string, unknown> = {}) => ({
  businessName: 'Cairo Traders',
  phone: '+201000000123',
  commercialRegNo: 'CR-1',
  notes: 'resell',
  ...o,
});
const priceFor = async (userId: string) =>
  (
    await (
      await PriceResolver.forBuyer(id.s, session(userId))
    ).priceLine({ id: id.p, price: 10_000 }, null, 1)
  ).unitMinor;

describe.skipIf(!hasDb)('B2B Task 5: wholesale applications', () => {
  beforeAll(async () => {
    const s = await seedBundleStore(`b2bapp-${SUF}`);
    const o = await seedBundleStore(`b2bappo-${SUF}`);
    id.s = s.storeId;
    id.o = o.storeId;
    id.owner = s.ownerId;
    id.p = await seedProduct(id.s, `p-${SUF}`, { price: 10_000, inventory: 100 });
    id.ws = (
      await prisma.customerGroup.create({
        data: {
          storeId: id.s,
          name: 'Wholesale',
          pricingMode: 'percent_off',
          discountBps: 1_000,
          isWholesale: true,
        },
      })
    ).id;
    id.plain = (await prisma.customerGroup.create({ data: { storeId: id.s, name: 'VIP' } })).id;
    id.dflt = (
      await prisma.customerGroup.create({
        data: { storeId: id.s, name: 'Everyone', isDefault: true },
      })
    ).id;
    id.ows = (
      await prisma.customerGroup.create({
        data: { storeId: id.o, name: 'Wholesale', isWholesale: true },
      })
    ).id;
    await prisma.storeFeature.create({
      data: { storeId: id.s, featureKey: 'b2b.wholesale', enabled: true },
    });
  });
  afterAll(async () => {
    await prisma.wholesaleApplication.deleteMany({ where: { storeId: { in: [id.s, id.o] } } });
  });

  it('apply -> pending (applicant emailed); a second open application, an unverified email and a non-entitled store are refused', async () => {
    const u = await shopper('a1');
    const app = await WholesaleApplicationService.apply(id.s, u.id, form());
    expect(app).toMatchObject({ status: 'pending', userId: u.id, businessName: 'Cairo Traders' });
    expect(EmailService.sendWholesaleNotice).toHaveBeenCalledWith(
      id.s,
      expect.objectContaining({ kind: 'received', to: u.email })
    );
    expect(await code(WholesaleApplicationService.apply(id.s, u.id, form()))).toBe(
      'ALREADY_PENDING'
    );
    const unv = await shopper('unv', { emailVerified: false });
    expect(await code(WholesaleApplicationService.apply(id.s, unv.id, form()))).toBe(
      'EMAIL_NOT_VERIFIED'
    );
    const other = await prisma.user.create({
      data: {
        email: `b2bapp-x-${SUF}@test.com`,
        passwordHash: 'x',
        firstName: 'x',
        lastName: 'x',
        role: 'customer',
        emailVerified: true,
        storeId: id.o,
      },
    });
    expect(await code(WholesaleApplicationService.apply(id.o, other.id, form()))).toBe(
      'FEATURE_DISABLED'
    );
    // a shopper of ANOTHER store cannot apply here (their id is not a customer of this store)
    expect(await code(WholesaleApplicationService.apply(id.s, other.id, form()))).toBe('NOT_FOUND');
  });

  it('approve: links through customers.user_id, the buyer now prices wholesale; the application records who/when; applicant emailed', async () => {
    const u = await shopper('a2');
    const app = await WholesaleApplicationService.apply(id.s, u.id, form());
    expect(await priceFor(u.id)).toBe(10_000);
    const done = await WholesaleApplicationService.approve(id.s, app.id, id.ws, id.owner);
    expect(done).toMatchObject({ status: 'approved', groupId: id.ws, decidedBy: id.owner });
    expect(done.decidedAt).toBeTruthy();
    const row = await prisma.customer.findFirstOrThrow({ where: { storeId: id.s, userId: u.id } });
    expect(row).toMatchObject({ groupId: id.ws, phone: null }); // the typed application phone is NOT copied onto the CRM row
    expect(await priceFor(u.id)).toBe(9_000);
    expect(EmailService.sendWholesaleNotice).toHaveBeenCalledWith(
      id.s,
      expect.objectContaining({ kind: 'approved' })
    );
    expect(await code(WholesaleApplicationService.apply(id.s, u.id, form()))).toBe(
      'ALREADY_APPROVED'
    );
    expect(await code(WholesaleApplicationService.approve(id.s, app.id, id.ws, id.owner))).toBe(
      'NOT_PENDING'
    );
  });

  it("RF8 attack: an applicant who TYPES another customer's phone gets only their own row linked; the other customer's row is untouched", async () => {
    const vip = await prisma.customer.create({
      data: {
        storeId: id.s,
        phone: VIP_PHONE,
        email: `b2bapp-vip-${SUF}@test.com`,
        firstName: 'Vip',
        lastName: 'One',
        groupId: id.plain,
      },
    });
    const evil = await shopper('evil');
    const app = await WholesaleApplicationService.apply(id.s, evil.id, form({ phone: VIP_PHONE }));
    await WholesaleApplicationService.approve(id.s, app.id, id.ws, id.owner);
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: vip.id } })).toMatchObject({
      groupId: id.plain,
      userId: null,
      phone: VIP_PHONE,
      email: vip.email,
      firstName: 'Vip',
    });
    const mine = await prisma.customer.findMany({ where: { storeId: id.s, userId: evil.id } });
    expect(mine).toHaveLength(1);
    expect(mine[0]!.phone).toBeNull();
  });

  it('cross-store approve is 404; a non-wholesale or unknown group is refused; an inactive applicant is refused; nothing is linked on failure', async () => {
    const u = await shopper('a3');
    const app = await WholesaleApplicationService.apply(id.s, u.id, form());
    expect(await code(WholesaleApplicationService.approve(id.o, app.id, id.ows, id.owner))).toBe(
      'NOT_FOUND'
    ); // store O cannot see S's application
    expect(await code(WholesaleApplicationService.approve(id.s, app.id, id.plain, id.owner))).toBe(
      'GROUP_NOT_WHOLESALE'
    );
    expect(await code(WholesaleApplicationService.approve(id.s, app.id, id.ows, id.owner))).toBe(
      'NOT_FOUND'
    ); // another store's group
    await prisma.user.update({ where: { id: u.id }, data: { status: 'suspended' } });
    expect(await code(WholesaleApplicationService.approve(id.s, app.id, id.ws, id.owner))).toBe(
      'APPLICANT_INACTIVE'
    );
    expect(await prisma.customer.count({ where: { storeId: id.s, userId: u.id } })).toBe(0);
    expect(
      (await prisma.wholesaleApplication.findUniqueOrThrow({ where: { id: app.id } })).status
    ).toBe('pending');
  });

  it('reject records the note, emails the applicant, blocks re-applying for 30 days, then allows it', async () => {
    const u = await shopper('a4');
    const app = await WholesaleApplicationService.apply(id.s, u.id, form());
    const r = await WholesaleApplicationService.reject(id.s, app.id, 'no trade licence', id.owner);
    expect(r).toMatchObject({ status: 'rejected', decisionNote: 'no trade licence' });
    expect(EmailService.sendWholesaleNotice).toHaveBeenCalledWith(
      id.s,
      expect.objectContaining({ kind: 'rejected', note: 'no trade licence' })
    );
    const again = await WholesaleApplicationService.apply(id.s, u.id, form()).catch(e => e);
    expect(again).toMatchObject({ statusCode: 429, code: 'REAPPLY_COOLDOWN' });
    await prisma.wholesaleApplication.update({
      where: { id: app.id },
      data: { decidedAt: new Date(Date.now() - 31 * 86_400_000) },
    });
    expect((await WholesaleApplicationService.apply(id.s, u.id, form())).status).toBe('pending');
  });

  it('revoke returns the buyer to the default group, open carts re-price to retail at the next read, and a revoked buyer can apply again', async () => {
    const u = await shopper('a5');
    const app = await WholesaleApplicationService.apply(id.s, u.id, form());
    await WholesaleApplicationService.approve(id.s, app.id, id.ws, id.owner);
    const sessionId = cartSessionId('b2bapp-revoke');
    await CartService.addItem(
      id.s,
      sessionId,
      id.p,
      1,
      undefined,
      undefined,
      undefined,
      session(u.id)
    );
    const read = async () =>
      (
        (await CartService.getOrCreate(id.s, sessionId, undefined, session(u.id))).items[0] as {
          unitPrice: number;
        }
      ).unitPrice;
    expect(await read()).toBe(9_000);
    const rev = await WholesaleApplicationService.revoke(id.s, app.id, 'left the trade', id.owner);
    expect(rev.status).toBe('revoked');
    expect(
      (await prisma.customer.findFirstOrThrow({ where: { storeId: id.s, userId: u.id } })).groupId
    ).toBe(id.dflt);
    expect(await read()).toBe(10_000);
    expect(await code(WholesaleApplicationService.revoke(id.s, app.id, null, id.owner))).toBe(
      'NOT_APPROVED'
    );
  });

  it("list is store-scoped, filterable and cursor-paginated; status reports the shopper's own latest application", async () => {
    const all = await WholesaleApplicationService.list(id.s, { limit: 2 });
    expect(all.items.length).toBe(2);
    expect(all.nextCursor).toBeTruthy();
    const next = await WholesaleApplicationService.list(id.s, {
      limit: 2,
      cursor: all.nextCursor!,
    });
    expect(next.items.every(r => !all.items.some(a => a.id === r.id))).toBe(true);
    expect(
      (await WholesaleApplicationService.list(id.s, { status: 'pending' })).items.every(
        r => r.status === 'pending'
      )
    ).toBe(true);
    expect((await WholesaleApplicationService.list(id.o)).items).toEqual([]);
  });

  it("privacy: the applicant's application is in their data export, and erasure deletes it and severs the wholesale link", async () => {
    const u = await shopper('a6');
    const app = await WholesaleApplicationService.apply(
      id.s,
      u.id,
      form({ businessName: 'Erase Me Ltd' })
    );
    await WholesaleApplicationService.approve(id.s, app.id, id.ws, id.owner);
    const exported = await AuthService.exportAccount(u.id);
    expect(
      (exported.wholesaleApplications as Array<{ businessName: string }>).map(a => a.businessName)
    ).toContain('Erase Me Ltd');
    await AuthService.eraseAccount(u.id);
    expect(await prisma.wholesaleApplication.count({ where: { userId: u.id } })).toBe(0);
    expect(await prisma.customer.count({ where: { storeId: id.s, userId: u.id } })).toBe(0);
    expect(await priceFor(u.id)).toBe(10_000);
  });
});
