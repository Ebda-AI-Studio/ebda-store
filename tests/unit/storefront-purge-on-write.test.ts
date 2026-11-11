/**
 * Product/category writes must purge the STOREFRONT cache, not just Redis (unit)
 *
 * Merchants reported saving a product or variant and not seeing the change on
 * the storefront until they saved "a few more times". The repeat saves did
 * nothing — the Next.js data cache on the storefront Worker holds the API's
 * response for 60s, and nothing purged it. Clearing the API's Redis cache (as
 * every writer already did) leaves that outer layer untouched.
 *
 * The purge is wired into `invalidateStoreProductCaches` /
 * `invalidateStoreCategoriesCaches` rather than into each of their ~20 callers,
 * so a future write path cannot forget it. This test pins that: the choke point
 * must emit the tag the storefront fetches are tagged with.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ts from 'typescript';
import { all, calleeText, callsIn, declNamed, parseFile, prop } from './helpers/ast-statements';

const revalidateSpy = vi.fn();

vi.mock('../../apps/api/src/lib/revalidate-storefront', () => ({
  revalidateStorefront: (...args: unknown[]) => revalidateSpy(...args),
}));

// The cache layer itself is not under test here — only the purge wiring.
vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: {
    getClient: () => null,
    isAvailable: () => false,
    del: vi.fn(),
    keys: vi.fn().mockResolvedValue([]),
  },
}));

const {
  invalidateStoreProductCaches,
  invalidateStoreCategoriesCaches,
  invalidateStoreProductCachesAfterOrder,
  ORDER_PURGE_COALESCE_MS,
} = await import('../../apps/api/src/lib/public-cache');

const STORE = 'store-abc';

describe('storefront purge on product/category writes', () => {
  beforeEach(() => revalidateSpy.mockClear());

  it('purges the products tag the storefront fetches are tagged with', async () => {
    await invalidateStoreProductCaches(STORE);

    const tags = revalidateSpy.mock.calls.flatMap(
      ([arg]) => (arg as { tags?: string[] })?.tags ?? []
    );
    expect(tags).toContain(`products:${STORE}`);
  });

  it('purges the categories tag too — a product write can change category pages', async () => {
    await invalidateStoreProductCaches(STORE);

    const tags = revalidateSpy.mock.calls.flatMap(
      ([arg]) => (arg as { tags?: string[] })?.tags ?? []
    );
    expect(tags).toContain(`categories:${STORE}`);
  });

  it('purges on a categories-only write', async () => {
    await invalidateStoreCategoriesCaches(STORE);

    const tags = revalidateSpy.mock.calls.flatMap(
      ([arg]) => (arg as { tags?: string[] })?.tags ?? []
    );
    expect(tags).toContain(`categories:${STORE}`);
  });

  it('scopes the tag to the store, so one merchant’s save cannot purge another’s cache', async () => {
    await invalidateStoreProductCaches(STORE);

    const tags = revalidateSpy.mock.calls.flatMap(
      ([arg]) => (arg as { tags?: string[] })?.tags ?? []
    );
    expect(tags.every(t => t.endsWith(`:${STORE}`))).toBe(true);
  });
});

// #1220 — one outbound purge per bust, and orders coalesced per store.
describe('storefront purge volume', () => {
  beforeEach(() => revalidateSpy.mockClear());

  it('a product write sends exactly ONE purge carrying every tag', async () => {
    await invalidateStoreProductCaches(STORE);
    expect(revalidateSpy).toHaveBeenCalledTimes(1);
    expect(revalidateSpy.mock.calls[0][0]).toEqual({
      tags: [`products:${STORE}`, `categories:${STORE}`, `bundles:${STORE}`],
    });
  });

  it('a category write sends exactly ONE purge', async () => {
    await invalidateStoreCategoriesCaches(STORE);
    expect(revalidateSpy).toHaveBeenCalledTimes(1);
  });
});

describe('order-driven purge is coalesced per store (#1220)', () => {
  beforeEach(() => {
    revalidateSpy.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('the first order in a quiet period purges immediately', async () => {
    await invalidateStoreProductCachesAfterOrder('store-quiet');
    expect(revalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('a burst shares ONE trailing purge, and the store is purged again after it', async () => {
    const store = 'store-burst';
    await invalidateStoreProductCachesAfterOrder(store); // leading edge
    for (let i = 0; i < 20; i++) await invalidateStoreProductCachesAfterOrder(store);
    expect(revalidateSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(ORDER_PURGE_COALESCE_MS);
    // The orders that arrived mid-window are not left stale: one trailing purge.
    expect(revalidateSpy).toHaveBeenCalledTimes(2);

    // Nothing arrived in the second window — it closes without a purge.
    await vi.advanceTimersByTimeAsync(ORDER_PURGE_COALESCE_MS);
    expect(revalidateSpy).toHaveBeenCalledTimes(2);

    // Quiet again: the next order purges immediately.
    await invalidateStoreProductCachesAfterOrder(store);
    expect(revalidateSpy).toHaveBeenCalledTimes(3);
  });

  it('one store’s burst never delays another store’s purge', async () => {
    await invalidateStoreProductCachesAfterOrder('store-a');
    await invalidateStoreProductCachesAfterOrder('store-b');
    expect(revalidateSpy).toHaveBeenCalledTimes(2);
  });

  it('a content write is never coalesced, even mid-burst', async () => {
    await invalidateStoreProductCachesAfterOrder('store-edit');
    await invalidateStoreProductCaches('store-edit');
    expect(revalidateSpy).toHaveBeenCalledTimes(2);
  });
});

describe('the order path uses the coalesced bust (#1220)', () => {
  it('OrderService.bustProductCaches calls the order variant, not the content purge', () => {
    // Structural (AST): the real calls inside the function, so a comment naming the content purge cannot trip or satisfy it.
    const fn = declNamed(parseFile('apps/api/src/services/order.service.ts'), 'bustProductCaches');
    const calls = callsIn(fn).map(
      c => `${calleeText(c)}(${c.arguments.map(x => x.getText()).join(',')})`
    );
    expect(calls).toContain('invalidateStoreProductCachesAfterOrder(storeId)');
    expect(callsIn(fn, 'invalidateStoreProductCaches')).toEqual([]);
  });
});

describe('the bundles:<storeId> purge tag matches a storefront fetch', () => {
  // The product purge (the only bundle invalidator) sends
  // `bundles:<storeId>`. revalidateTag on a tag no fetch carries is a silent
  // no-op, so the storefront's bundle list and bundle PDP must carry it.
  it.each([
    'apps/web/src/app/bundles/BundlesPageBody.tsx',
    'apps/web/src/app/bundles/[slug]/BundleDetailBody.tsx',
  ])('%s tags its fetch bundles:<storeId>', async rel => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
    expect(src).toContain('`bundles:${store.id}`');
  });
});

function inventoryMethods(): Record<string, ts.MethodDeclaration> {
  const sf = parseFile('apps/api/src/services/inventory.service.ts');
  return Object.fromEntries(
    all(sf, ts.isMethodDeclaration)
      .filter(m => m.modifiers?.some(x => x.kind === ts.SyntaxKind.StaticKeyword))
      .map(m => [m.name.getText(), m])
  );
}

describe('every InventoryService stock writer busts the product caches', () => {
  // Enumerated from inventory.service.ts: every method that writes
  // `inventory`. reduceOnSale/returnToStock have no caller today, but a
  // revived caller must not inherit the pre-fix stale-stock bug.
  it.each([
    'adjustInventory',
    'bulkAdjustInventory',
    'setInventory',
    'reduceOnSale',
    'returnToStock',
  ])('%s calls invalidateStoreProductCaches', method => {
    // Structural (AST): the method node's own calls, never a window that could run into the next method.
    expect(
      callsIn(inventoryMethods()[method]!, 'invalidateStoreProductCaches').map(c => c.getText())
    ).toContain('invalidateStoreProductCaches(storeId)');
  });

  it('the list above is every method that writes inventory', () => {
    // A writer = a method with an object literal `data: { ..., inventory ... }` anywhere in its body.
    const writers = Object.entries(inventoryMethods())
      .filter(([, m]) =>
        all(m, ts.isPropertyAssignment).some(
          p =>
            p.name.getText() === 'data' &&
            ts.isObjectLiteralExpression(p.initializer) &&
            !!prop(p.initializer, 'inventory')
        )
      )
      .map(([name]) => name);
    expect(writers.sort()).toEqual(
      [
        'adjustInventory',
        'bulkAdjustInventory',
        'setInventory',
        'reduceOnSale',
        'returnToStock',
      ].sort()
    );
  });
});

describe('bundle writes fire ONE storefront purge (issue 2202)', () => {
  // invalidateStoreProductCaches clears the bundle-list key and sends
  // `bundles:<storeId>` in the same request; a bundles-only purge next to it
  // was a second outbound POST per write (that function is now deleted).
  it('bundle.routes.ts busts via invalidateStoreProductCaches only', () => {
    // Real call nodes (a commented-out call is not counted).
    const sf = parseFile('apps/api/src/routes/bundle.routes.ts');
    const awaited = all(sf, ts.isAwaitExpression).filter(
      a =>
        ts.isCallExpression(a.expression) &&
        a.expression.getText() === 'invalidateStoreProductCaches(storeId)'
    );
    expect(awaited).toHaveLength(3);
    // one bust per bundle write: create, update, deactivate
    expect(callsIn(sf, /\.bundle\.(create|update)$/)).toHaveLength(5); // DO + Postgres create/update, deactivate
    expect(callsIn(sf, 'invalidateStoreBundlesCache')).toEqual([]);
  });
});

import { runWithWaitUntil } from '../../apps/api/src/cf/bindings';

describe('order purge trailing timer survives Workers (P2-1)', () => {
  beforeEach(() => {
    revalidateSpy.mockClear();
  });

  it('hands the trailing wait to ctx.waitUntil so the isolate stays alive for it', async () => {
    const kept: Promise<unknown>[] = [];
    vi.useFakeTimers();
    try {
      await runWithWaitUntil(
        p => kept.push(p),
        async () => {
          await invalidateStoreProductCachesAfterOrder('store-wu');
          await invalidateStoreProductCachesAfterOrder('store-wu'); // mid-window
        }
      );
      expect(kept).toHaveLength(1);
      expect(revalidateSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(ORDER_PURGE_COALESCE_MS);
      await kept[0];
      expect(revalidateSpy).toHaveBeenCalledTimes(2); // the trailing purge ran
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it('a window whose timer was dropped does not suppress purges forever', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); // clock moves, timers never fire = a dropped timer
    try {
      await invalidateStoreProductCachesAfterOrder('store-dropped');
      await invalidateStoreProductCachesAfterOrder('store-dropped');
      expect(revalidateSpy).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + ORDER_PURGE_COALESCE_MS * 2 + 1);
      await invalidateStoreProductCachesAfterOrder('store-dropped');
      expect(revalidateSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
