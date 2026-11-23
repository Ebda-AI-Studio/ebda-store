/** Assistant add-on + AI pack checkout (Ruling AI-ADDON-1): confirm + money, server price only, no charge before the press, idempotent, tenant-scoped. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { effectivePolicy, type TurnCtx, type ToolSpec } from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  preview: vi.fn(),
  purchase: vi.fn(),
  list: vi.fn(),
  insertAuditLog: vi.fn(),
  total: 9900,
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: async () => true },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
  runInStoreTenantContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/services/billing/addons.service', () => ({
  previewAddon: m.preview,
  purchaseAddon: m.purchase,
  listAddons: m.list,
}));

import { addonCheckoutTools } from '@api/smart-layer/tools/addon-checkout.tools';

const ctx = (role = 'store_admin', storeId = 'S1'): TurnCtx => ({
  product: 'store',
  storeId,
  userId: 'u1',
  role,
  locale: 'ar',
  now: 1_800_000_000_000,
  conversationId: 'c1',
  releaseId: 'r',
});
const tool = (n: string): ToolSpec => addonCheckoutTools().find(t => t.name === n)!;
const parse = (n: string, a: unknown) => tool(n).args.parse(a) as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.total = 9900;
  m.insertAuditLog.mockResolvedValue(undefined);
  m.preview.mockImplementation(async ({ sku }: { sku: string }) => ({
    sku,
    nameEn: 'Item',
    nameAr: 'منتج',
    netMinor: m.total,
    vatMinor: 0,
    totalMinor: m.total,
    renews: sku.startsWith('feature:'),
    confirmToken: `tok-${sku}`,
  }));
  m.list.mockResolvedValue({ addons: [{ sku: 'feature:loyalty', active: null }] });
  m.purchase.mockResolvedValue({ redirectUrl: 'https://pay.example/x', billingEventId: 'E1' });
});

describe('addon_checkout_start / ai_pack_checkout_start', () => {
  it('both are confirm + money + irreversible, on their own capability, with no inverse', async () => {
    for (const [n, cap, sku] of [
      ['addon_checkout_start', 'billing.addons', 'feature:loyalty'],
      ['ai_pack_checkout_start', 'billing.ai-topup', 'ai:topup_300'],
    ] as const) {
      const t = tool(n);
      expect([t.policy, t.undo, t.capabilityId, t.inverse]).toEqual([
        'confirm',
        'irreversible',
        cap,
        undefined,
      ]);
      const d = await t.preview!(ctx(), parse(n, { sku }));
      expect(
        JSON.stringify(
          effectivePolicy(t, d, { cap: { policy: 'confirm', undo: 'irreversible' } } as never)
        )
      ).toMatch(/money/);
    }
  });

  it('the price is never an argument: extra keys and unknown or wrong-kind skus are refused', () => {
    const t = tool('addon_checkout_start');
    expect(t.args.safeParse({ sku: 'feature:loyalty', totalMinor: 1 }).success).toBe(false);
    expect(t.args.safeParse({ sku: 'feature:loyalty', priceMinor: 1 }).success).toBe(false);
    expect(t.args.safeParse({ sku: 'nope' }).success).toBe(false);
    expect(t.args.safeParse({ sku: 'ai:topup_300' }).success).toBe(false); // an AI pack is the other tool
    expect(tool('ai_pack_checkout_start').args.safeParse({ sku: 'feature:loyalty' }).success).toBe(
      false
    );
    for (const x of addonCheckoutTools())
      expect(Object.keys((x.jsonSchema as { properties: object }).properties)).toEqual(['sku']);
  });

  it('the card shows the server total and starts no checkout', async () => {
    m.total = 4900;
    const d = await tool('ai_pack_checkout_start').preview!(
      ctx(),
      parse('ai_pack_checkout_start', { sku: 'ai:topup_300' })
    );
    expect(d.rows.find(r => r.label.en === 'Total in EGP')!.after).toBe('49');
    expect(d.summary.en).toContain('49');
    expect(m.purchase).not.toHaveBeenCalled(); // no press, no checkout row
  });

  it('apply starts the hosted checkout with a server-minted token, charges nothing itself and returns the link', async () => {
    const t = tool('addon_checkout_start');
    const args = parse('addon_checkout_start', { sku: 'feature:loyalty' });
    const d = await t.preview!(ctx(), args);
    const r = await t.apply!(ctx(), args, d);
    expect(r.result).toMatchObject({ charged: false, paymentUrl: 'https://pay.example/x' });
    expect(m.purchase).toHaveBeenCalledTimes(1);
    expect(m.purchase.mock.calls[0]![0]).toMatchObject({
      storeId: 'S1',
      userId: 'u1',
      sku: 'feature:loyalty',
      confirmToken: 'tok-feature:loyalty',
    });
    expect(m.insertAuditLog.mock.calls[0]![0].details).toMatchObject({ actor: 'assistant' });
  });

  it('a price that moved between the card and the press changes the etag and is charged only at the current server quote', async () => {
    const t = tool('addon_checkout_start');
    const args = parse('addon_checkout_start', { sku: 'feature:loyalty' });
    const d = await t.preview!(ctx(), args);
    m.total = 12900;
    expect((await t.preview!(ctx(), args)).etag).not.toBe(d.etag); // the engine compares this etag and re-previews instead of applying
    await t.apply!(ctx(), args, d);
    // and even if it were applied, the charge is the server's current quote, never the old card's figure
    expect(m.purchase.mock.calls[0]![0].idempotencyKey).toContain(':12900:');
  });

  it('idempotent: a retried apply sends the same Idempotency-Key; a different conversation or sku sends another', async () => {
    const t = tool('addon_checkout_start');
    const args = parse('addon_checkout_start', { sku: 'feature:loyalty' });
    const d = await t.preview!(ctx(), args);
    await t.apply!(ctx(), args, d);
    await t.apply!(ctx(), args, d);
    const keys = m.purchase.mock.calls.map(c => c[0].idempotencyKey as string);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^assistant:c1:feature:loyalty:9900:none$/);
    await t.apply!({ ...ctx(), conversationId: 'c2' }, args, d);
    expect(m.purchase.mock.calls[2]![0].idempotencyKey).not.toBe(keys[0]);
  });

  it('owner only: staff and platform super admin get no card and no checkout', async () => {
    const t = tool('addon_checkout_start');
    const args = parse('addon_checkout_start', { sku: 'feature:loyalty' });
    for (const role of ['staff', 'store_manager', 'super_admin']) {
      await expect(t.preview!(ctx(role), args)).rejects.toThrow(/FORBIDDEN/);
    }
    expect(m.purchase).not.toHaveBeenCalled();
  });

  it('tenant: the store is the session store, never an argument', async () => {
    const t = tool('ai_pack_checkout_start');
    const args = parse('ai_pack_checkout_start', { sku: 'ai:topup_1000' });
    const d = await t.preview!(ctx('store_admin', 'S9'), args);
    await t.apply!(ctx('store_admin', 'S9'), args, d);
    expect(m.purchase.mock.calls[0]![0].storeId).toBe('S9');
    expect(m.preview.mock.calls.every(c => c[0].storeId === 'S9')).toBe(true);
  });
});
