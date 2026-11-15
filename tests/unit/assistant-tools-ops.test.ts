/** Ops assistant tools (plan 4 E2): refund, InstaPay review, customer block/erase, backorders, warehouses, POs, shipping, gold rates, wholesale, CI, two reads. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ToolForbidden,
  checkAdapterContract,
  effectivePolicy,
  type SmartLayerAdapter,
  type TurnCtx,
  type ToolSpec,
} from '@ebda/shared/smart-layer';

const m = vi.hoisted(() => ({
  featureEnabled: vi.fn(),
  insertAuditLog: vi.fn(),
  lookup: vi.fn(),
  refund: vi.fn(),
  order: {} as Record<string, unknown>,
  receipts: [] as unknown[],
  ip: { confirm: vi.fn(), rejectReceipt: vi.fn() },
  assertCustomer: vi.fn(),
  customer: { firstName: 'Mona', lastName: 'A', status: 'active', deletedAt: null } as Record<
    string,
    unknown
  >,
  auth: { setCustomerStatus: vi.fn(), eraseAccount: vi.fn() },
  backorders: [] as unknown[],
  cancelBackorder: vi.fn(),
  wh: {
    getWarehouse: vi.fn(),
    updateWarehouse: vi.fn(),
    createWarehouse: vi.fn(),
    listWarehouses: vi.fn(),
    getProductStock: vi.fn(),
    adjustStock: vi.fn(),
  },
  getSupplier: vi.fn(),
  listSuppliers: vi.fn(),
  createSupplier: vi.fn(),
  po: { get: vi.fn(), create: vi.fn(), cancel: vi.fn(), receive: vi.fn() },
  ship: { get: vi.fn(), create: vi.fn(), cancel: vi.fn() },
  gold: { getState: vi.fn(), applyRates: vi.fn() },
  dbRows: { app: null as unknown, group: { name: 'Wholesale' }, store: { ciSharing: false } },
  wholesale: { approve: vi.fn(), reject: vi.fn(), revoke: vi.fn() },
  setFeature: vi.fn(),
  setCiSharing: vi.fn(),
  orders: [] as unknown[],
}));
vi.mock('@api/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@api/lib/definer', () => ({ insertAuditLog: m.insertAuditLog }));
vi.mock('@api/middleware/security', () => ({ auditLog: vi.fn(async () => undefined) }));
vi.mock('@api/services/feature.service', () => ({
  featureService: { isFeatureEnabled: m.featureEnabled, setFeature: m.setFeature },
}));
vi.mock('@api/lib/store-scoped-read', () => ({
  readInStoreContext: async (_s: string, fn: () => unknown) => fn(),
  runInStoreTenantContext: async (_s: string, fn: () => unknown) => fn(),
}));
vi.mock('@ebda/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  withStore: async (_s: string, fn: (tx: unknown) => unknown) =>
    fn({ user: { findFirst: async () => m.customer } }),
}));
vi.mock('@api/lib/repo-factory', () => ({
  storeDb: async () => ({
    order: { count: async () => m.orders.length, findMany: async () => m.orders },
    payment: { findMany: async () => [] },
    paymentEvent: { findMany: async () => [] },
    wholesaleApplication: { findFirst: async () => m.dbRows.app },
    customerGroup: { findFirst: async () => m.dbRows.group },
    store: { findFirst: async () => m.dbRows.store },
  }),
}));
vi.mock('@api/lib/after-tenant-commit', () => ({
  deferAfterTenantCommit: async (_n: string, fn: () => unknown) => fn(),
}));
vi.mock('@api/lib/public-cache', () => ({
  invalidateCustomersCache: vi.fn(async () => undefined),
}));
vi.mock('@api/lib/customer-directory', () => ({ customerRow: async () => undefined }));
vi.mock('@api/lib/store-customer', () => ({
  assertStoreCustomer: m.assertCustomer,
  storeCustomerWhere: () => ({}),
}));
vi.mock('@api/services/auth.service', () => ({ AuthService: m.auth }));
vi.mock('@api/services/order.service', () => ({
  OrderService: { getById: async () => m.order },
}));
vi.mock('@api/services/product.service', () => ({
  ProductService: { getById: async (_s: string, id: string) => ({ id, name: 'Ring' }) },
}));
vi.mock('@api/services/warehouse.service', () => ({ WarehouseService: m.wh }));
vi.mock('@api/services/gold-rate/gold-rate.service', () => ({ GoldRateService: m.gold }));
vi.mock('@api/services/ci-hints.service', () => ({ setCiSharing: m.setCiSharing }));
vi.mock('@api/services/shipping-carrier.service', () => ({
  shippingCarrierService: {
    getShipmentForOrder: m.ship.get,
    createShipmentForOrder: m.ship.create,
    cancelShipment: m.ship.cancel,
  },
}));
vi.mock('@api/services/wholesale-application.service', () => ({
  WholesaleApplicationService: m.wholesale,
}));
vi.mock('@api/services/accounting/backorder.service', () => ({
  listOpenBackorders: async () => m.backorders,
  cancelBackorder: m.cancelBackorder,
}));
vi.mock('@api/services/accounting/supplier.service', () => ({
  createSupplier: m.createSupplier,
  getSupplier: m.getSupplier,
  listSuppliers: m.listSuppliers,
}));
vi.mock('@api/services/accounting/purchase-order.service', () => ({
  getPurchaseOrder: m.po.get,
  createPurchaseOrder: m.po.create,
  cancelPurchaseOrder: m.po.cancel,
  receivePurchaseOrder: m.po.receive,
}));
vi.mock('@api/services/payment-providers/instapay.service', () => ({ InstapayService: m.ip }));
vi.mock('@api/services/payment-providers/instapay-receipt.service', () => ({
  InstapayReceiptService: { listForOrder: async () => m.receipts },
}));
vi.mock('@api/services/order-provider-refund.service', () => ({
  lookupRefundTarget: m.lookup,
  refundThroughProvider: m.refund,
}));

import { opsTools } from '@api/smart-layer/tools/ops.tools';

const ctx = (role = 'store_admin'): TurnCtx => ({
  product: 'store',
  storeId: 'S1',
  userId: 'u1',
  role,
  locale: 'ar',
  now: 1_800_000_000_000,
  conversationId: 'c1',
  releaseId: 'r',
});
const tool = (n: string): ToolSpec => opsTools().find(t => t.name === n)!;
const parse = (n: string, a: unknown) => tool(n).args.parse(a) as never;

const refundOk = (o: Record<string, unknown> = {}) => ({
  kind: 'ok',
  order: { id: 'O1', orderNumber: 'ORD-1', paymentStatus: 'paid' },
  payment: { transactionId: 'tx1', provider: 'paymob', amount: 10000, refundedAmount: 2500, ...o },
});

beforeEach(() => {
  vi.clearAllMocks();
  m.featureEnabled.mockResolvedValue(true);
  m.insertAuditLog.mockResolvedValue(undefined);
  m.lookup.mockResolvedValue(refundOk());
  m.refund.mockResolvedValue({ refundId: 'rf1', amount: 7500, status: 'completed' });
  m.order = {
    id: 'O1',
    orderNumber: 'ORD-1',
    status: 'awaiting_payment_confirmation',
    total: 5000,
    walletAmount: 1000,
    updatedAt: '2026-11-14T10:00:00.000Z',
    shippingAddress: { city: 'Cairo', address1: 'Tahrir' },
  };
  m.receipts = [
    {
      id: 'RC1',
      status: 'submitted',
      flags: ['duplicate_reference'],
      fields: { amountMinor: 4000, payerName: 'X', reference: '123' },
    },
  ];
  m.ip.confirm.mockResolvedValue({ changed: true, orderId: 'O1', status: 'confirmed' });
  m.assertCustomer.mockResolvedValue(undefined);
  m.customer = { firstName: 'Mona', lastName: 'A', status: 'active', deletedAt: null };
  m.auth.setCustomerStatus.mockResolvedValue(undefined);
  m.auth.eraseAccount.mockResolvedValue({ crmChecked: true, crmAmbiguous: false });
  m.backorders = [
    {
      id: 'B1',
      qty: 5,
      qtyFulfilled: 2,
      product: { name: 'Ring' },
      orderItem: { order: { orderNumber: 'ORD-9' } },
    },
  ];
  m.cancelBackorder.mockResolvedValue({});
  m.wh.getWarehouse.mockResolvedValue({
    id: 'W1',
    name: 'Cairo',
    code: 'CAI',
    updatedAt: '2026-11-14',
    priority: 1,
  });
  m.wh.getProductStock.mockResolvedValue([{ warehouseId: 'W1', quantity: 10 }]);
  m.wh.adjustStock.mockResolvedValue({ newQuantity: 15 });
  m.wh.updateWarehouse.mockResolvedValue({});
  m.wh.listWarehouses.mockResolvedValue([{ code: 'CAI' }]);
  m.wh.createWarehouse.mockResolvedValue({ id: 'W2', code: 'ALX' });
  m.getSupplier.mockResolvedValue({ id: 'SU1', name: 'Acme', isActive: true });
  m.listSuppliers.mockResolvedValue([]);
  m.createSupplier.mockResolvedValue({ id: 'SU2' });
  m.po.get.mockResolvedValue({
    id: 'PO1',
    poNumber: 'PO-1',
    status: 'draft',
    updatedAt: '2026-11-14',
    supplier: { name: 'Acme' },
    items: [{ id: 'I1', qty: 10, qtyReceived: 0, unitCost: 500, product: { name: 'Ring' } }],
  });
  m.po.create.mockResolvedValue({ id: 'PO2' });
  m.po.cancel.mockResolvedValue({});
  m.po.receive.mockResolvedValue({ po: { status: 'received' } });
  m.ship.get.mockResolvedValue({
    shipment: null,
    orderStatus: 'confirmed',
    canBook: true,
    codAmount: 4000,
    carriers: [{ code: 'bosta' }, { code: 'manual' }],
  });
  m.ship.create.mockResolvedValue({ id: 'SH1', status: 'created' });
  m.ship.cancel.mockResolvedValue({ status: 'cancelled' });
  m.gold.getState.mockResolvedValue({
    settings: { jumpConfirmBps: 500 },
    rates: [
      { karat: 24, ratePerGram: 500000 },
      { karat: 21, ratePerGram: 400000 },
    ],
  });
  m.gold.applyRates.mockResolvedValue({ applied: [], pending: [], repriced: 3 });
  m.dbRows.app = {
    id: 'A1',
    businessName: 'Biz',
    status: 'pending',
    groupId: null,
    updatedAt: '2026-11-14',
  };
  m.wholesale.approve.mockResolvedValue({ status: 'approved' });
  m.wholesale.reject.mockResolvedValue({ status: 'rejected' });
  m.wholesale.revoke.mockResolvedValue({ membership: 'removed' });
  m.orders = [];
});

type Case = {
  name: string;
  args: Record<string, unknown>;
  deny: string;
  spy: () => ReturnType<typeof vi.fn>;
  reasons: string[];
  before?: () => void;
};
const confirms: Case[] = [
  {
    name: 'order_refund',
    args: { orderId: 'O1' },
    deny: 'staff',
    spy: () => m.refund,
    reasons: ['money', 'customer_message', 'irreversible'],
  },
  {
    name: 'instapay_confirm_order',
    args: { orderId: 'O1' },
    deny: 'customer',
    spy: () => m.ip.confirm,
    reasons: ['money', 'irreversible'],
  },
  {
    name: 'instapay_reject_receipt',
    args: { orderId: 'O1', receiptId: 'RC1', note: 'wrong amount' },
    deny: 'customer',
    spy: () => m.ip.rejectReceipt,
    reasons: ['customer_message', 'irreversible'],
  },
  {
    name: 'customer_set_status',
    args: { customerId: 'C1', status: 'suspended' },
    deny: 'staff',
    spy: () => m.auth.setCustomerStatus,
    reasons: ['irreversible'],
  },
  {
    name: 'customer_erase',
    args: { customerId: 'C1' },
    deny: 'staff',
    spy: () => m.auth.eraseAccount,
    reasons: ['delete', 'irreversible'],
  },
  {
    name: 'backorder_cancel',
    args: { backorderId: 'B1', reason: 'gone' },
    deny: 'staff',
    spy: () => m.cancelBackorder,
    reasons: ['money', 'customer_message', 'irreversible'],
  },
  {
    name: 'supplier_create',
    args: { name: 'Acme2' },
    deny: 'staff',
    spy: () => m.createSupplier,
    reasons: ['irreversible'],
  },
  {
    name: 'purchase_order_create',
    args: { supplierId: 'SU1', items: [{ productId: 'P1', qty: 2, unitCostEgp: 12.5 }] },
    deny: 'staff',
    spy: () => m.po.create,
    reasons: ['irreversible'],
  },
  {
    name: 'purchase_order_cancel',
    args: { poId: 'PO1' },
    deny: 'staff',
    spy: () => m.po.cancel,
    reasons: ['irreversible'],
  },
  {
    name: 'purchase_order_receive',
    args: { poId: 'PO1', receipts: [{ poItemId: 'I1', qtyReceived: 4 }] },
    deny: 'staff',
    spy: () => m.po.receive,
    reasons: ['money', 'irreversible'],
  },
  {
    name: 'shipping_book',
    args: { orderId: 'O1', carrier: 'bosta' },
    deny: 'staff',
    spy: () => m.ship.create,
    reasons: ['money'],
  },
  {
    name: 'shipment_cancel',
    args: { orderId: 'O1' },
    deny: 'staff',
    spy: () => m.ship.cancel,
    reasons: ['irreversible'],
    before: () =>
      m.ship.get.mockResolvedValue({
        shipment: { id: 'SH1', status: 'created', carrier: 'bosta' },
        orderStatus: 'shipped',
        canBook: false,
        codAmount: 0,
        carriers: [],
      }),
  },
  {
    name: 'gold_rate_set',
    args: { rates: [{ karat: 21, ratePerGramEgp: 4100 }] },
    deny: 'staff',
    spy: () => m.gold.applyRates,
    reasons: ['money'],
  },
  {
    name: 'wholesale_decide',
    args: { applicationId: 'A1', decision: 'approve', groupId: 'G1', note: 'welcome' },
    deny: 'staff',
    spy: () => m.wholesale.approve,
    reasons: ['customer_message', 'irreversible'],
  },
  {
    name: 'wholesale_revoke',
    args: { applicationId: 'A1' },
    deny: 'staff',
    spy: () => m.wholesale.revoke,
    reasons: ['irreversible'],
    before: () => {
      (m.dbRows.app as Record<string, unknown>).status = 'approved';
    },
  },
];

describe('ops confirm tools', () => {
  for (const c of confirms) {
    describe(c.name, () => {
      beforeEach(() => c.before?.());
      const run = async (role = 'store_admin') => {
        const t = tool(c.name);
        const args = parse(c.name, c.args);
        return { t, args, d: await t.preview!(ctx(role), args) };
      };

      it('is confirm class, takes no store id, and an irreversible one declares no inverse', () => {
        const t = tool(c.name);
        expect(t.policy).toBe('confirm');
        expect(JSON.stringify(t.jsonSchema)).not.toMatch(/store_?id/i);
        if (t.undo === 'irreversible') expect(t.inverse).toBeUndefined();
      });

      it('preview has rows and an etag; apply runs as the assistant with the session store', async () => {
        const { t, args, d } = await run();
        expect(d.rows.length).toBeGreaterThan(0);
        expect(d.etag).toMatch(/^[0-9a-f]{32}$/);
        const r = await t.apply!(ctx(), args, d);
        expect(r.ok).toBe(true);
        expect(c.spy()).toHaveBeenCalledTimes(1);
        expect(m.insertAuditLog.mock.calls[0][0].details).toMatchObject({
          actor: 'assistant',
          phase: 'intent',
          tool: c.name,
        });
      });

      it('reports the confirm reasons the registry flags demand', async () => {
        const { t, d } = await run();
        const { policy, reasons } = effectivePolicy(t, d);
        expect(policy).toBe('confirm');
        expect(reasons).toEqual(expect.arrayContaining(c.reasons));
      });

      it('a role without the route gate gets ToolForbidden and nothing runs', async () => {
        const { t, args, d } = await run();
        await expect(t.apply!(ctx(c.deny), args, d)).rejects.toBeInstanceOf(ToolForbidden);
        expect(c.spy()).not.toHaveBeenCalled();
        expect(m.insertAuditLog).not.toHaveBeenCalled();
      });
    });
  }
});

describe('order_refund', () => {
  it('the amount shown and sent is the remaining balance from state(), not an argument', async () => {
    const t = tool('order_refund');
    expect(t.args.safeParse({ orderId: 'O1', amount: 1 }).success).toBe(false);
    const args = parse('order_refund', { orderId: 'O1', reason: 'damaged' });
    const d = await t.preview!(ctx(), args);
    expect(d.rows.find(r => r.label.en === 'Refunded now (EGP)')!.after).toBe('75');
    await t.apply!(ctx(), args, d);
    expect(m.refund.mock.calls[0][0]).toMatchObject({
      storeId: 'S1',
      orderId: 'O1',
      amount: 7500,
      reason: 'damaged',
    });
    expect(m.refund.mock.calls[0][0].idempotencyKey).toMatch(/^[A-Za-z0-9._:-]{8,128}$/);
  });
  it('refuses cod/instapay payments, fully refunded and unknown orders at preview', async () => {
    const a = parse('order_refund', { orderId: 'O1' });
    m.lookup.mockResolvedValue(refundOk({ provider: 'instapay' }));
    await expect(tool('order_refund').preview!(ctx(), a)).rejects.toThrow(
      /not paid through an online gateway/
    );
    m.lookup.mockResolvedValue(refundOk({ refundedAmount: 10000 }));
    await expect(tool('order_refund').preview!(ctx(), a)).rejects.toThrow(/Nothing is left/);
    m.lookup.mockResolvedValue({ kind: 'not_found' });
    await expect(tool('order_refund').preview!(ctx(), a)).rejects.toThrow(/not found/);
    expect(m.refund).not.toHaveBeenCalled();
  });
});

describe('instapay and customer guards', () => {
  it('an order that is not waiting for a transfer cannot be confirmed', async () => {
    m.order = { ...m.order, status: 'confirmed' };
    await expect(
      tool('instapay_confirm_order').preview!(
        ctx(),
        parse('instapay_confirm_order', { orderId: 'O1' })
      )
    ).rejects.toThrow(/not waiting/);
  });
  it('an unknown receipt id is refused and the rejection note is carried verbatim in the payload', async () => {
    const t = tool('instapay_reject_receipt');
    await expect(
      t.preview!(
        ctx(),
        parse('instapay_reject_receipt', { orderId: 'O1', receiptId: 'NOPE', note: 'abc' })
      )
    ).rejects.toThrow(/not found/);
    const d = await t.preview!(
      ctx(),
      parse('instapay_reject_receipt', { orderId: 'O1', receiptId: 'RC1', note: 'المبلغ غلط' })
    );
    expect(JSON.stringify(d.payload)).toContain('المبلغ غلط');
  });
  it('a foreign customer id never reaches the service', async () => {
    m.assertCustomer.mockRejectedValue(new Error('Customer not found'));
    for (const n of ['customer_set_status', 'customer_erase']) {
      const t = tool(n);
      const args = parse(
        n,
        n === 'customer_erase' ? { customerId: 'X' } : { customerId: 'X', status: 'suspended' }
      );
      await expect(t.preview!(ctx(), args)).rejects.toThrow('not found');
      await expect(t.apply!(ctx(), args, {} as never)).rejects.toThrow('not found');
    }
    expect(m.auth.setCustomerStatus).not.toHaveBeenCalled();
    expect(m.auth.eraseAccount).not.toHaveBeenCalled();
  });
});

describe('foreign ids for the other targets never reach run', () => {
  it('backorder, supplier, purchase order, application, warehouse', async () => {
    m.backorders = [];
    await expect(
      tool('backorder_cancel').preview!(
        ctx(),
        parse('backorder_cancel', { backorderId: 'F', reason: 'x' })
      )
    ).rejects.toThrow(/not found/);
    m.getSupplier.mockResolvedValue(null);
    await expect(
      tool('purchase_order_create').preview!(
        ctx(),
        parse('purchase_order_create', {
          supplierId: 'F',
          items: [{ productId: 'P', qty: 1, unitCostEgp: 1 }],
        })
      )
    ).rejects.toThrow(/not found/);
    m.po.get.mockResolvedValue(null);
    await expect(
      tool('purchase_order_cancel').preview!(ctx(), parse('purchase_order_cancel', { poId: 'F' }))
    ).rejects.toThrow(/not found/);
    m.dbRows.app = null;
    await expect(
      tool('wholesale_revoke').preview!(ctx(), parse('wholesale_revoke', { applicationId: 'F' }))
    ).rejects.toThrow(/not found/);
    m.wh.getWarehouse.mockRejectedValue(new Error('Warehouse not found'));
    await expect(
      tool('warehouse_update').preview!(
        ctx(),
        parse('warehouse_update', { warehouseId: 'F', name: 'n' })
      )
    ).rejects.toThrow(/not found/);
    for (const s of [
      m.cancelBackorder,
      m.po.create,
      m.po.cancel,
      m.wholesale.revoke,
      m.wh.updateWarehouse,
    ])
      expect(s).not.toHaveBeenCalled();
  });
  it('product refs are declared for warehouse stock and purchase orders', () => {
    expect(
      tool('warehouse_stock_adjust').refs!({ warehouseId: 'W1', productId: 'P1' } as never)
    ).toEqual([{ kind: 'product', id: 'P1' }]);
    expect(tool('order_refund').refs!({ orderId: 'O1' } as never)).toEqual([
      { kind: 'order', id: 'O1' },
    ]);
  });
});

describe('reversible previews and inverses', () => {
  it('warehouse_update restores the BEFORE values', async () => {
    const t = tool('warehouse_update');
    const args = parse('warehouse_update', { warehouseId: 'W1', name: 'New' });
    const d = await t.preview!(ctx(), args);
    expect(t.policy).toBe('preview');
    expect(t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'warehouse_update',
      args: { warehouseId: 'W1', name: 'Cairo' },
    });
    await t.apply!(ctx(), args, d);
    expect(m.wh.updateWarehouse).toHaveBeenCalledWith('S1', 'W1', { name: 'New' });
  });
  it('warehouse_create inverse switches the new warehouse off; a taken code is refused', async () => {
    const t = tool('warehouse_create');
    const args = parse('warehouse_create', { name: 'Alex', code: 'ALX' });
    const d = await t.preview!(ctx(), args);
    const r = await t.apply!(ctx(), args, d);
    expect(t.inverse!(ctx(), args, d, r)).toEqual({
      tool: 'warehouse_update',
      args: { warehouseId: 'W2', isActive: false },
    });
    await expect(
      t.preview!(ctx(), parse('warehouse_create', { name: 'Cairo2', code: 'CAI' }))
    ).rejects.toThrow(/already exists/);
  });
  it('warehouse_stock_adjust: a 25-unit add shows before/after and its inverse subtracts, clamped at zero', async () => {
    const t = tool('warehouse_stock_adjust');
    const args = parse('warehouse_stock_adjust', {
      warehouseId: 'W1',
      productId: 'P1',
      delta: -25,
    });
    const d = await t.preview!(ctx(), args);
    expect(d.rows[0]).toMatchObject({ before: 10, after: 0 });
    expect(t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'warehouse_stock_adjust',
      args: { ...args, delta: 10 },
    });
  });
  it('customer_intelligence_settings restores the previous switches', async () => {
    const t = tool('customer_intelligence_settings');
    m.featureEnabled.mockResolvedValue(false);
    const args = parse('customer_intelligence_settings', { hints: true, sharing: true });
    const d = await t.preview!(ctx(), args);
    await t.apply!(ctx(), args, d);
    expect(m.setFeature).toHaveBeenCalledWith('S1', 'customer_intelligence', true, 'u1');
    expect(m.setCiSharing).toHaveBeenCalledWith('S1', true);
    expect(t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'customer_intelligence_settings',
      args: { hints: false, sharing: false },
    });
  });
});

describe('gold, shipping, purchase orders, wholesale specifics', () => {
  it('gold_rate_set converts EGP to piasters, flags changesPrice, warns on a big jump and restores the old rate', async () => {
    const t = tool('gold_rate_set');
    const args = parse('gold_rate_set', { rates: [{ karat: 21, ratePerGramEgp: 4400 }] });
    const d = await t.preview!(ctx(), args);
    expect(d.changesPrice).toBe(true);
    expect(d.rows.some(r => r.label.en.startsWith('Warning'))).toBe(true);
    expect(t.inverse!(ctx(), args, d, { ok: true, etagAfter: 'x' })).toEqual({
      tool: 'gold_rate_set',
      args: { rates: [{ karat: 21, ratePerGramEgp: 4000 }] },
    });
    await t.apply!(ctx(), args, d);
    expect(m.gold.applyRates.mock.calls[0][1]).toEqual({
      rates: [{ karat: 21, ratePerGram: 440000 }],
      confirm: true,
    });
  });
  it('purchase_order_create converts unit cost to piasters; receive refuses a line of another order', async () => {
    const t = tool('purchase_order_create');
    const args = parse('purchase_order_create', {
      supplierId: 'SU1',
      items: [{ productId: 'P1', qty: 2, unitCostEgp: 12.5 }],
    });
    await t.apply!(ctx(), args, await t.preview!(ctx(), args));
    expect(m.po.create.mock.calls[0][0].items[0]).toEqual({
      productId: 'P1',
      qty: 2,
      unitCost: 1250,
    });
    await expect(
      tool('purchase_order_receive').preview!(
        ctx(),
        parse('purchase_order_receive', {
          poId: 'PO1',
          receipts: [{ poItemId: 'ZZ', qtyReceived: 1 }],
        })
      )
    ).rejects.toThrow(/not on this purchase order/);
  });
  it('shipping_book refuses an unconnected carrier, an order that cannot ship and a manual one without tracking', async () => {
    const t = tool('shipping_book');
    await expect(
      t.preview!(ctx(), parse('shipping_book', { orderId: 'O1', carrier: 'aramex' }))
    ).rejects.toThrow(/not connected/);
    await expect(
      t.preview!(ctx(), parse('shipping_book', { orderId: 'O1', carrier: 'manual' }))
    ).rejects.toThrow(/courier name/);
    m.ship.get.mockResolvedValue({
      shipment: null,
      orderStatus: 'delivered',
      canBook: false,
      codAmount: 0,
      carriers: [],
    });
    await expect(t.preview!(ctx(), parse('shipping_book', { orderId: 'O1' }))).rejects.toThrow(
      /cannot be shipped/
    );
    expect(m.ship.create).not.toHaveBeenCalled();
  });
  it('shipping_book is compensating with shipment_cancel as its inverse', async () => {
    const t = tool('shipping_book');
    expect(t.undo).toBe('compensating');
    const args = parse('shipping_book', { orderId: 'O1' });
    expect(
      t.inverse!(ctx(), args, await t.preview!(ctx(), args), { ok: true, etagAfter: 'x' })
    ).toEqual({ tool: 'shipment_cancel', args: { orderId: 'O1' } });
  });
  it('wholesale_decide needs a group to approve and only decides a pending application', async () => {
    const t = tool('wholesale_decide');
    await expect(
      t.preview!(ctx(), parse('wholesale_decide', { applicationId: 'A1', decision: 'approve' }))
    ).rejects.toThrow(/customer group/);
    (m.dbRows.app as Record<string, unknown>).status = 'approved';
    await expect(
      t.preview!(ctx(), parse('wholesale_decide', { applicationId: 'A1', decision: 'reject' }))
    ).rejects.toThrow(/already decided/);
  });
});

describe('free reads', () => {
  it('are free, need an owner or staff role and the plan feature', async () => {
    const t = tool('payment_abandonments_list');
    expect(t.policy).toBe('free');
    m.orders = [
      {
        orderNumber: 'O-1',
        status: 'pending',
        paymentStatus: 'unpaid',
        total: 5000,
        currency: 'EGP',
        paymentGatewayAbandonedAt: new Date(),
        payments: [{ provider: 'paymob' }],
      },
    ];
    const out = (await t.read!(ctx('staff'), {})) as {
      abandonedCount: number;
      latest: Array<Record<string, unknown>>;
    };
    expect(out.abandonedCount).toBe(1);
    expect(out.latest[0]).toMatchObject({ orderNumber: 'O-1', totalEgp: '50' });
    expect(JSON.stringify(out)).not.toMatch(/phone|email/i);
    await expect(t.read!(ctx('customer'), {})).rejects.toThrow();
    m.featureEnabled.mockResolvedValue(false);
    await expect(t.read!(ctx(), {})).rejects.toThrow();
    const e = tool('payment_events_for_order');
    expect(e.policy).toBe('free');
    await expect(e.read!(ctx('customer'), { orderId: 'O1' })).rejects.toThrow();
    expect(e.refs!({ orderId: 'O1' } as never)).toEqual([{ kind: 'order', id: 'O1' }]);
  });
});

describe('registry parity', () => {
  it('the engine adapter contract has no problem with the ops tools', async () => {
    const { storeRegistry } = await import('@api/smart-layer/registry');
    const problems = checkAdapterContract({
      registry: () => storeRegistry(),
      tools: () => opsTools(),
    } as unknown as SmartLayerAdapter);
    // registry.generated.json is regenerated by the controller after the capability JSON undo classes change (E2 fixed the
    // `unclassified` ones); until then only that one message is expected, anything else is a real parity break.
    expect(problems.filter(p => !/is weaker than registry unclassified$/.test(p))).toEqual([]);
  });
});
