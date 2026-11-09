/**
 * BE:F-2 / BE:F-3 against a real Postgres (Rulings FP-5, FP-8).
 *
 * The `/stores` router has NO request transaction (`storeScopeContext`), so every query is its own transaction. These tests run the
 * writers exactly that way (`runInStoreScope`), where a `SELECT ... FOR UPDATE` followed by a separate UPDATE would NOT hold its
 * lock. They prove:
 *   1. two interleaved writers of different `settings` keys keep BOTH keys (many rounds, a race must show up as a lost key);
 *   2. the single-key setters do not undo a key written concurrently;
 *   3. a failing part of the branding bundle leaves NOTHING of the earlier parts written (one transaction).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { prisma, withRlsBypass, runInStoreScope } from '@ebda/database';
import { StoreService } from '@api/services/store.service';
import { hasDb, seedBundleStore, type FixtureStore } from '../helpers/bundle-fixtures';

const run = crypto.randomUUID().slice(0, 8);
let fx: FixtureStore;

const settingsOf = async (): Promise<Record<string, unknown>> =>
  ((
    await withRlsBypass(tx =>
      tx.store.findUnique({ where: { id: fx.storeId }, select: { settings: true } })
    )
  )?.settings ?? {}) as Record<string, unknown>;

const asStoreScope = <T>(fn: () => Promise<T>) => runInStoreScope(fx.storeId, fn);

beforeAll(async () => {
  if (!hasDb) return;
  fx = await seedBundleStore(`atomic-${run}`);
});

afterAll(async () => {
  if (!hasDb || !fx) return;
  await withRlsBypass(async tx => {
    await tx.storeFeature.deleteMany({ where: { storeId: fx.storeId } });
    await tx.store.delete({ where: { id: fx.storeId } });
    await tx.user.delete({ where: { id: fx.ownerId } });
  });
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)('settings writers on a real Postgres, no request transaction', () => {
  it('two interleaved generic writers keep BOTH keys, 25 rounds', async () => {
    for (let i = 0; i < 25; i++) {
      await withRlsBypass(tx =>
        tx.store.update({ where: { id: fx.storeId }, data: { settings: { base: i } } })
      );
      await Promise.all([
        asStoreScope(() =>
          StoreService.update(fx.storeId, { settings: { checkoutDelivery: { round: i } } } as never)
        ),
        asStoreScope(() =>
          StoreService.update(fx.storeId, { settings: { contact: { round: i } } } as never)
        ),
      ]);
      expect(await settingsOf(), `round ${i}`).toEqual({
        base: i,
        checkoutDelivery: { round: i },
        contact: { round: i },
      });
    }
  });

  it('the MCP switch and the floating widget do not undo a key written concurrently', async () => {
    for (let i = 0; i < 10; i++) {
      await withRlsBypass(tx =>
        tx.store.update({ where: { id: fx.storeId }, data: { settings: { base: i } } })
      );
      await Promise.all([
        asStoreScope(() => StoreService.setMcpWriteEnabled(fx.storeId, i % 2 === 0)),
        asStoreScope(() => StoreService.updateFloatingWidget(fx.storeId, { enabled: true, i })),
        asStoreScope(() =>
          StoreService.update(fx.storeId, { settings: { deliveryDays: [i] } } as never)
        ),
      ]);
      expect(await settingsOf(), `round ${i}`).toEqual({
        base: i,
        mcpWriteEnabled: i % 2 === 0,
        floatingWidget: { enabled: true, i },
        deliveryDays: [i],
      });
    }
  });

  it('server-owned flags survive a generic write that carries them', async () => {
    await withRlsBypass(tx =>
      tx.store.update({
        where: { id: fx.storeId },
        data: { settings: { mcpWriteEnabled: false, goldAllowDeferredPayment: false } },
      })
    );
    await asStoreScope(() =>
      StoreService.update(fx.storeId, {
        settings: { mcpWriteEnabled: true, goldAllowDeferredPayment: true, theme: 'x' },
      } as never)
    );
    expect(await settingsOf()).toEqual({
      mcpWriteEnabled: false,
      goldAllowDeferredPayment: false,
      theme: 'x',
    });
  });
});

describe.skipIf(!hasDb)('the branding bundle is one transaction', () => {
  it('a failing part rolls back the parts before it', async () => {
    const before = await withRlsBypass(tx =>
      tx.store.findUnique({ where: { id: fx.storeId }, select: { name: true } })
    );
    await expect(
      asStoreScope(() =>
        StoreService.updateBrandingBundle(fx.storeId, {
          branding: { name: `Renamed ${run}` },
          contact: { email: `bundle-${run}@example.com` },
          // the social part is a key patch now; a throwing `remove` fails it after branding + contact were written
          social: {
            set: {},
            get remove(): string[] {
              throw new Error('boom');
            },
          },
        })
      )
    ).rejects.toThrow('boom');
    const after = await withRlsBypass(tx =>
      tx.store.findUnique({ where: { id: fx.storeId }, select: { name: true, email: true } })
    );
    expect(after?.name).toBe(before?.name);
    expect(after?.email).not.toBe(`bundle-${run}@example.com`);
  });

  it('a successful bundle writes every part', async () => {
    await asStoreScope(() =>
      StoreService.updateBrandingBundle(fx.storeId, {
        branding: { name: `Final ${run}` },
        contact: { email: `final-${run}@example.com` },
        settings: { contact: { addressLink: true } } as never,
        blogEnabled: true,
      })
    );
    const row = await withRlsBypass(tx =>
      tx.store.findUnique({
        where: { id: fx.storeId },
        select: { name: true, email: true, blogEnabled: true, settings: true },
      })
    );
    expect(row?.name).toBe(`Final ${run}`);
    expect(row?.email).toBe(`final-${run}@example.com`);
    expect(row?.blogEnabled).toBe(true);
    expect((row?.settings as Record<string, unknown>).contact).toEqual({ addressLink: true });
  });
});
