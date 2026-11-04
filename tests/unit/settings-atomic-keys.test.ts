/**
 * BE:F-2 (Ruling FP-5): `Store.settings` lost-update. Two admin surfaces write different keys of the same JSON; the old writer
 * merged against a copy read at the START of its request, so the slower writer put the other's key back to its old value.
 * The merge now happens against the row as it is at WRITE time. The fake database below is a single mutable row; the first
 * (`getById`) read of every writer waits at a barrier so BOTH writers have started before either writes, which is exactly the
 * interleaving that used to lose a key. The Postgres path is ONE SQL statement per write (the `/stores` router has no request
 * transaction, so a lock-then-update pair would not hold): the fake applies each statement as a single synchronous step.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const db = vi.hoisted(() => ({
  row: {
    id: 'x',
    slug: 'demo',
    domain: null as string | null,
    settings: {} as Record<string, unknown>,
  },
  barrier: undefined as Promise<void> | undefined,
}));

vi.mock('@ebda/database', () => {
  const store = {
    findUnique: async (args: { select?: unknown }) => {
      // getById has no `select`: hold it until the test releases both writers
      if (!args?.select && db.barrier) await db.barrier;
      return structuredClone(db.row);
    },
    update: async ({ data }: { data: Record<string, unknown> }) => {
      // Prisma ignores `undefined` fields
      const defined = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
      db.row = { ...db.row, ...structuredClone(defined) } as typeof db.row;
      return structuredClone(db.row);
    },
  };
  // The two SQL statements the Postgres path issues. Each is ONE synchronous step here, as it is one atomic statement in Postgres:
  //   UPDATE stores SET settings = coalesce(settings,'{}') || $patch   (merge)
  //   UPDATE stores SET settings = jsonb_set(..., ARRAY[$key], $value)  (one key)
  const $queryRaw = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    expect(strings.join('?')).toContain('||');
    db.row.settings = { ...db.row.settings, ...JSON.parse(vals[0] as string) };
    return [{ settings: structuredClone(db.row.settings) }];
  };
  const $executeRaw = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    expect(strings.join('?')).toContain('jsonb_set');
    db.row.settings = { ...db.row.settings, [vals[0] as string]: JSON.parse(vals[1] as string) };
    return 1;
  };
  const prisma = { store };
  return {
    prisma,
    Prisma: {},
    withMoneyTx: vi.fn(),
    // getById also reads row counts for the store payload: zero here
    withStore: async (_id: string, fn: (tx: unknown) => unknown) =>
      fn({
        store,
        $queryRaw,
        $executeRaw,
        product: { count: async () => 0 },
        category: { count: async () => 0 },
        order: { count: async () => 0 },
      }),
    acrossStores: async () => [],
  };
});
vi.mock('@ebda/shared', async importOriginal => ({
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

const ID = '11111111-1111-1111-1111-111111111111';

function twoWritersStartTogether<A, B>(a: () => Promise<A>, b: () => Promise<B>) {
  let release!: () => void;
  db.barrier = new Promise<void>(r => (release = r));
  const pa = a();
  const pb = b();
  // both are now parked on their getById read; let them go
  setTimeout(release, 0);
  return Promise.all([pa, pb]);
}

beforeEach(() => {
  db.row = { id: ID, slug: 'demo', domain: null, settings: { currency: 'EGP' } };
  db.barrier = undefined;
});

describe('settings writers merge against the live row (BE:F-2)', () => {
  it('two interleaved generic writers keep BOTH keys (delivery page + branding page)', async () => {
    await twoWritersStartTogether(
      () => StoreService.update(ID, { settings: { checkoutDelivery: { mode: 'flat' } } } as never),
      () => StoreService.update(ID, { settings: { contact: { addressLink: true } } } as never)
    );
    expect(db.row.settings).toMatchObject({
      currency: 'EGP',
      checkoutDelivery: { mode: 'flat' },
      contact: { addressLink: true },
    });
  });

  it('a page that sends only its own key never rewrites the others', async () => {
    db.row.settings = { currency: 'EGP', minimumOrderFils: 5000, blogEnabled: true };
    await StoreService.update(ID, { settings: { orderInvoiceEmail: 'a@b.com' } } as never);
    expect(db.row.settings).toEqual({
      currency: 'EGP',
      minimumOrderFils: 5000,
      blogEnabled: true,
      orderInvoiceEmail: 'a@b.com',
    });
  });

  it('the MCP write switch keeps a key another surface wrote meanwhile', async () => {
    await twoWritersStartTogether(
      () => StoreService.setMcpWriteEnabled(ID, false),
      () => StoreService.update(ID, { settings: { deliveryDays: [1, 2] } } as never)
    );
    expect(db.row.settings).toMatchObject({ mcpWriteEnabled: false, deliveryDays: [1, 2] });
  });

  it('the floating widget writer keeps a concurrent key', async () => {
    await twoWritersStartTogether(
      () => StoreService.updateFloatingWidget(ID, { enabled: true }),
      () => StoreService.update(ID, { settings: { deliveryOffDays: [5] } } as never)
    );
    expect(db.row.settings).toMatchObject({
      floatingWidget: { enabled: true },
      deliveryOffDays: [5],
    });
  });

  it('server-owned flags cannot be changed through the generic merge (BE:S-8, FP-1)', async () => {
    db.row.settings = { mcpWriteEnabled: true, goldAllowDeferredPayment: false };
    await StoreService.update(ID, {
      settings: { mcpWriteEnabled: false, goldAllowDeferredPayment: true, theme: 't' },
    } as never);
    expect(db.row.settings).toEqual({
      mcpWriteEnabled: true,
      goldAllowDeferredPayment: false,
      theme: 't',
    });
  });

  it('an echoed server-owned flag from a stale whole copy is dropped, not refused', async () => {
    db.row.settings = { mcpWriteEnabled: false };
    await StoreService.update(ID, { settings: { mcpWriteEnabled: true } } as never);
    expect(db.row.settings.mcpWriteEnabled).toBe(false);
  });

  it('the dedicated setters DO write their own key (and only it)', async () => {
    db.row.settings = { currency: 'EGP' };
    await StoreService.setMcpWriteEnabled(ID, false);
    await StoreService.setGoldAllowDeferredPayment(ID, true);
    expect(db.row.settings).toEqual({
      currency: 'EGP',
      mcpWriteEnabled: false,
      goldAllowDeferredPayment: true,
    });
  });
});
