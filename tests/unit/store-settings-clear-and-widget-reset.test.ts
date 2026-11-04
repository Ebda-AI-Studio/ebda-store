/**
 * Server side of the "an emptied admin field must clear" contract for the two
 * surfaces that ride a JSON column instead of a Prisma column.
 *
 * 1. `Store.settings` — StoreService.update SHALLOW-MERGES the incoming
 *    `settings` over the stored row. An omitted key is therefore preserved,
 *    which is exactly why the delivery page had to start sending an explicit
 *    `null` for a cleared `orderInvoiceEmail` (see
 *    apps/admin/src/lib/checkout-delivery-payload.ts). These tests pin the
 *    merge semantics the admin fix depends on.
 *
 * 2. `Store.settings.floatingWidget` — StoreService.updateFloatingWidget
 *    REPLACES the whole widget sub-object rather than merging into it, so a
 *    colour the merchant cleared (key absent from the body) is genuinely
 *    deleted and the storefront falls back to the theme default. The admin's
 *    `v || undefined` is correct BECAUSE of that replace; if this writer ever
 *    became a deep merge, resetting a widget colour would silently stop
 *    working. That is what these tests guard.
 *
 * Same mocking posture as store-theme-merge.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateMock, findUniqueMock, rawState } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  findUniqueMock: vi.fn(),
  // The Postgres path writes `settings` with ONE atomic SQL statement (BE:F-2, Ruling FP-5): merge (`||`) or `jsonb_set`.
  // The fake applies each statement to this object, which is what the database row would hold afterwards.
  rawState: { settings: {} as Record<string, unknown> },
}));

vi.mock('@ebda/database', () => ({
  prisma: {
    store: {
      findUnique: findUniqueMock,
      update: updateMock,
    },
  },
  Prisma: {},
  withMoneyTx: vi.fn(),
  // store payloads carry row counts, read inside the store's own scope (`withStore`): zero here.
  withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({
      // the transaction client is the same fake client, plus the zero counts
      ...(await import('@ebda/database')).prisma,
      $queryRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => {
        rawState.settings = { ...rawState.settings, ...JSON.parse(v[0] as string) };
        return [{ settings: rawState.settings }];
      },
      $executeRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => {
        rawState.settings = { ...rawState.settings, [v[0] as string]: JSON.parse(v[1] as string) };
        return 1;
      },
      product: { count: async () => 0 },
      category: { count: async () => 0 },
      order: { count: async () => 0 },
    }),
  acrossStores: async (_fn: unknown, o?: { storeIds?: string[] }) =>
    (o?.storeIds ?? []).map(storeId => ({ storeId, value: { products: 0, orders: 0 } })),
}));

vi.mock('@ebda/shared', async importOriginal => ({
  // Keep the real region config (REGION is read at import time by api config/services).
  ...(await importOriginal<typeof import('@ebda/shared')>()),
  slugify: (s: string) => s,
}));

vi.mock('../../apps/api/src/services/redis.service', () => ({
  redis: { delete: vi.fn(), get: vi.fn(), set: vi.fn() },
}));

vi.mock('../../apps/api/src/lib/public-cache', () => ({
  invalidateCached: vi.fn(),
  invalidateCachedPrefix: vi.fn(),
  memoryCache: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('../../apps/api/src/lib/logger', () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../../apps/api/src/services/r2-cleanup.service', () => ({
  cleanupRemovedImages: vi.fn(),
  deleteR2ObjectIfOrphan: vi.fn(),
}));

vi.mock('../../apps/api/src/services/accounting/account.service', () => ({
  seedCoaForStore: vi.fn(),
}));

import { StoreService } from '../../apps/api/src/services/store.service';
import { DEFAULT_FLOATING_WIDGET_CONFIG } from '../../packages/shared/src/types/floating-widget';

const STORE_ID = '11111111-1111-1111-1111-111111111111';

/** Everything the delivery/floating-widget writers read off the store row. */
function mockStore(settings: Record<string, unknown>) {
  rawState.settings = structuredClone(settings);
  findUniqueMock.mockResolvedValue({
    id: STORE_ID,
    slug: 'demo',
    domain: null,
    settings,
  });
  updateMock.mockImplementation(({ data }) =>
    Promise.resolve({ id: STORE_ID, slug: 'demo', domain: null, ...data })
  );
}

/** The body as it actually arrives — through the JSON wire, not in memory. */
function overTheWire<T>(body: T): T {
  return JSON.parse(JSON.stringify(body)) as T;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StoreService.update — settings is a shallow merge, so null is the only clear', () => {
  it('writes an explicit null over the stored order-invoice address', async () => {
    mockStore({ currency: 'EGP', orderInvoiceEmail: 'former.employee@store.com' });

    await StoreService.update(STORE_ID, {
      settings: overTheWire({ currency: 'EGP', orderInvoiceEmail: null }),
    } as never);

    const written = rawState.settings;
    expect(written.orderInvoiceEmail).toBeNull();
  });

  it('PRESERVES the stored address when the key is omitted — the bug, pinned', async () => {
    mockStore({ currency: 'EGP', orderInvoiceEmail: 'former.employee@store.com' });

    // This is what the admin used to send after the merchant emptied the
    // field: `orderInvoiceEmail: undefined` → JSON.stringify drops the key.
    await StoreService.update(STORE_ID, {
      settings: overTheWire({ currency: 'EGP', orderInvoiceEmail: undefined }),
    } as never);

    const written = rawState.settings;
    expect(written.orderInvoiceEmail).toBe('former.employee@store.com');
  });

  it('leaves untouched settings keys alone', async () => {
    mockStore({ currency: 'EGP', navMenu: [{ label: 'Shop', href: '/products' }] });

    await StoreService.update(STORE_ID, {
      settings: overTheWire({ orderInvoiceEmail: 'owner@store.com' }),
    } as never);

    const written = rawState.settings;
    expect(written.navMenu).toEqual([{ label: 'Shop', href: '/products' }]);
    expect(written.currency).toBe('EGP');
  });
});

describe('StoreService.updateFloatingWidget — a cleared colour resets to the theme default', () => {
  const STORED_WIDGET = {
    enabled: true,
    position: 'br',
    toggleBgColor: '#ff0000',
    buttons: [{ id: 'b1', kind: 'whatsapp', bgColor: '#00ff00', iconColor: '#0000ff' }],
  };

  it('deletes the toggle colour the merchant cleared', async () => {
    mockStore({ currency: 'EGP', floatingWidget: STORED_WIDGET });

    // The admin page holds the whole config and clears one colour to
    // `undefined`; the wire body therefore has no `toggleBgColor` key.
    const body = overTheWire({ ...STORED_WIDGET, toggleBgColor: undefined });
    expect('toggleBgColor' in body).toBe(false);

    await StoreService.updateFloatingWidget(STORE_ID, body);

    const settings = rawState.settings;
    const widget = settings.floatingWidget as Record<string, unknown>;
    expect('toggleBgColor' in widget).toBe(false);

    // …and the admin's own re-read (`{ ...DEFAULT, ...stored }`) now yields
    // the theme default rather than the removed colour.
    const reread = { ...DEFAULT_FLOATING_WIDGET_CONFIG, ...widget };
    expect(reread.toggleBgColor).toBeUndefined();
  });

  it('deletes a per-button colour the merchant cleared', async () => {
    mockStore({ currency: 'EGP', floatingWidget: STORED_WIDGET });

    const body = overTheWire({
      ...STORED_WIDGET,
      buttons: [{ id: 'b1', kind: 'whatsapp', bgColor: undefined, iconColor: undefined }],
    });

    await StoreService.updateFloatingWidget(STORE_ID, body);

    const settings = rawState.settings;
    const widget = settings.floatingWidget as { buttons: Record<string, unknown>[] };
    expect('bgColor' in widget.buttons[0]).toBe(false);
    expect('iconColor' in widget.buttons[0]).toBe(false);
  });

  it('still writes a colour the merchant actually picked', async () => {
    mockStore({ currency: 'EGP', floatingWidget: STORED_WIDGET });

    await StoreService.updateFloatingWidget(
      STORE_ID,
      overTheWire({ ...STORED_WIDGET, toggleBgColor: 'token:primary' })
    );

    const settings = rawState.settings;
    expect((settings.floatingWidget as Record<string, unknown>).toggleBgColor).toBe(
      'token:primary'
    );
  });

  it('never touches the sibling settings keys', async () => {
    mockStore({ currency: 'EGP', orderInvoiceEmail: 'owner@store.com', floatingWidget: {} });

    await StoreService.updateFloatingWidget(STORE_ID, overTheWire({ enabled: false }));

    const settings = rawState.settings;
    expect(settings.currency).toBe('EGP');
    expect(settings.orderInvoiceEmail).toBe('owner@store.com');
  });
});
