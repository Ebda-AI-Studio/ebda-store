/**
 * BE:S-23 / S-33 / S-26: a custom shipping fee on a phone order is the owner's call (staff are refused before anything is
 * read or written); super_admin no longer reaches POST /orders/admin (ruling ORDER-MONEY-SUPERADMIN); the merchant's override
 * records never reach the customer timeline.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<object>()),
  prisma: {},
}));
vi.mock('@api/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const base = {
  shippingAddress: { city: 'Cairo' },
  items: [{ productId: '22222222-2222-2222-2222-222222222222', quantity: 1 }],
};

describe('OrderService.createAdminOrder shipping override (BE:S-23)', () => {
  it.each(['staff', undefined])('refuses a shipping override for role %s', async role => {
    const { OrderService } = await import('@api/services/order.service');
    await expect(
      OrderService.createAdminOrder(
        '11111111-1111-1111-1111-111111111111',
        'u1',
        { ...base, shippingOverride: 0 },
        { role }
      )
    ).rejects.toMatchObject({ statusCode: 403, code: 'SHIPPING_OVERRIDE_FORBIDDEN' });
  });
});

describe('order routes source contract', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../apps/api/src/routes/order.routes.ts'),
    'utf8'
  );

  it('POST /orders/admin excludes super_admin (BE:S-33)', () => {
    const m = src.match(/router\.post\(\s*'\/admin',\s*authenticate,[\s\S]*?authorize\(([^)]*)\)/);
    expect(m?.[1]).toBeDefined();
    expect(m![1]).not.toContain('super_admin');
    expect(m![1]).toContain('store_admin');
  });

  it('the customer timeline hides the coupon, MOQ, stock and shipping override audit rows (BE:S-26)', () => {
    const set = src.match(/CUSTOMER_HIDDEN_AUDIT_ACTIONS = new Set<string>\(\[([\s\S]*?)\]\)/);
    expect(set?.[1]).toContain('COUPON_OVERRIDE_AUDIT_ACTION');
    expect(set?.[1]).toContain("'order.moq_override'");
    expect(set?.[1]).toContain("'order.stock_override'");
    expect(set?.[1]).toContain('ORDER_SHIPPING_OVERRIDE_AUDIT_ACTION');
    expect(src).toContain('!isStoreViewer && CUSTOMER_HIDDEN_AUDIT_ACTIONS.has(a.action)');
  });
});
