/**
 * Abandoned-cart recovery totals go through the ONE resolver for the cart owner (B2B Task 3), and (design review M-6)
 * exclude soft-deleted lines, exactly like the live cart. Real Postgres, real `detectNewAbandonments`.
 * Retry-safe: fixtures keyed on a per-run suffix.
 */
import { describe, it, expect } from 'vitest';
import { prisma, withRlsBypass } from '@ebda/database';
import {
  hasDb,
  seedBundleStore,
  seedProduct,
  seedCustomer,
  cartSessionId,
} from '../helpers/bundle-fixtures';
import { abandonedCartService } from '@api/services/abandoned-cart.service';

const STALE = new Date(Date.now() - 2 * 60 * 60 * 1000);
const SUF = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;

describe.skipIf(!hasDb)(
  'abandoned-cart totals: resolver-priced for the owner, live lines only',
  () => {
    it('prices the cart as its OWNER would pay (group price) and drops a soft-deleted line from the snapshot, count and total', async () => {
      const store = await seedBundleStore(`b2baband-${SUF}`);
      const sid = store.storeId;
      await withRlsBypass(tx =>
        tx.storeFeature.create({
          data: { storeId: sid, featureKey: 'abandoned_cart', enabled: true },
        })
      );
      await prisma.storeFeature.create({
        data: { storeId: sid, featureKey: 'b2b.wholesale', enabled: true },
      });
      const ownerId = await seedCustomer(`b2baband-${SUF}`);
      await prisma.user.update({
        where: { id: ownerId },
        data: { storeId: sid, emailVerified: true },
      });
      const group = await prisma.customerGroup.create({
        data: { storeId: sid, name: 'Wholesale', pricingMode: 'percent_off', discountBps: 1_000 },
      });
      await prisma.customer.create({
        data: {
          storeId: sid,
          email: `b2baband-owner-${SUF}@test.com`,
          firstName: 'O',
          lastName: 'W',
          groupId: group.id,
          userId: ownerId,
        },
      });
      const live = await seedProduct(sid, `live-${SUF}`, { price: 1_000, inventory: 100 });
      const gone = await seedProduct(sid, `gone-${SUF}`, { price: 5_000, inventory: 100 });
      await prisma.product.update({ where: { id: gone }, data: { deletedAt: new Date() } });

      const cart = await prisma.cart.create({
        data: {
          storeId: sid,
          sessionId: cartSessionId('b2b-aband'),
          customerId: ownerId,
          lastActivityAt: STALE,
        },
      });
      await prisma.cartItem.create({ data: { cartId: cart.id, productId: live, quantity: 3 } });
      await prisma.cartItem.create({ data: { cartId: cart.id, productId: gone, quantity: 2 } });

      await abandonedCartService.detectNewAbandonments();

      const rec = await prisma.abandonedCart.findUnique({ where: { cartId: cart.id } });
      expect(rec).not.toBeNull();
      // group 10% off: 3 x 900 = 2700; the deleted 2 x 5000 line is neither counted nor listed
      expect(rec!.cartTotal).toBe(2_700);
      expect(rec!.cartItemCount).toBe(1);
      const items = rec!.cartItems as Array<{ price: number; quantity: number }>;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ price: 900, quantity: 3 });
    });
  }
);
