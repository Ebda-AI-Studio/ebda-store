import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { prisma } from '@force/database';
import { loyaltyAutomationService } from '@api/services/loyalty-automation.service';
import { abandonedCartService } from '@api/services/abandoned-cart.service';
const ownerUrl = process.env.CRON_TEST_OWNER_DATABASE_URL;
const owner = ownerUrl
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) })
  : null;
const stores: string[] = [];
const users: string[] = [];
afterAll(async () => {
  if (owner) {
    await owner.abandonedCart.deleteMany({ where: { storeId: { in: stores } } });
    await owner.cart.deleteMany({ where: { storeId: { in: stores } } });
    await owner.store.deleteMany({ where: { id: { in: stores } } });
    await owner.user.deleteMany({ where: { id: { in: users } } });
    await owner.$disconnect();
    await prisma.$disconnect();
  }
});
describe.skipIf(!owner)('cron writes under strict ebda_app role', () => {
  it('awards birthdays, expires points, detects carts and advances reminders for two tenants', async () => {
    const role = await prisma.$queryRaw<
      Array<{ bypass: boolean }>
    >`SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`;
    expect(role[0].bypass).toBe(false);
    const fixtures = [];
    for (let i = 0; i < 2; i++) {
      const suffix = crypto.randomUUID();
      const u = await owner!.user.create({
        data: {
          email: `cron-${suffix}@example.org`,
          passwordHash: '!no-login',
          firstName: 'Cron',
          lastName: 'Fixture',
          dateOfBirth: new Date(),
        },
      });
      users.push(u.id);
      const s = await owner!.store.create({
        data: {
          name: 'Cron fixture',
          slug: `cron-${suffix}`,
          ownerId: u.id,
          loyaltyEnabled: true,
          loyaltySettings: { birthdayBonus: 500 },
        },
      });
      stores.push(s.id);
      await owner!.user.update({ where: { id: u.id }, data: { storeId: s.id } });
      await owner!.storeFeature.createMany({
        data: [
          { storeId: s.id, featureKey: 'loyalty', enabled: true },
          { storeId: s.id, featureKey: 'abandoned_cart', enabled: true },
        ],
      });
      await owner!.loyaltyPoints.create({
        data: { storeId: s.id, customerId: u.id, points: 100, totalEarned: 100 },
      });
      await owner!.loyaltyTransaction.create({
        data: {
          storeId: s.id,
          customerId: u.id,
          points: 100,
          type: 'earn_manual',
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      const p = await owner!.product.create({
        data: {
          storeId: s.id,
          name: 'Cron item',
          slug: 'cron-item',
          price: 100,
          inventory: 10,
          status: 'active',
        },
      });
      const c = await owner!.cart.create({
        data: {
          storeId: s.id,
          customerId: u.id,
          sessionId: suffix,
          lastActivityAt: new Date(Date.now() - 7200000),
          items: { create: { productId: p.id, quantity: 1 } },
        },
      });
      await owner!.abandonedCartConfig.create({
        data: { storeId: s.id, step1Enabled: false, step2Enabled: false, step3Enabled: false },
      });
      fixtures.push({ store: s.id, user: u.id, cart: c.id });
    }
    await loyaltyAutomationService.processBirthdayBonuses();
    await loyaltyAutomationService.processPointExpiration();
    await abandonedCartService.detectNewAbandonments();
    for (const f of fixtures) {
      expect(
        (
          await owner!.loyaltyPoints.findUniqueOrThrow({
            where: { storeId_customerId: { storeId: f.store, customerId: f.user } },
          })
        ).points
      ).toBe(500);
      expect(
        await owner!.loyaltyTransaction.count({
          where: { storeId: f.store, type: 'earn_birthday' },
        })
      ).toBe(1);
      const a = await owner!.abandonedCart.findUniqueOrThrow({ where: { cartId: f.cart } });
      await owner!.abandonedCart.update({
        where: { id: a.id },
        data: { nextStepAt: new Date(Date.now() - 1000) },
      });
    }
    await abandonedCartService.processReminders();
    for (const f of fixtures)
      expect(
        (await owner!.abandonedCart.findUniqueOrThrow({ where: { cartId: f.cart } })).status
      ).toBe('expired');
  });
});
