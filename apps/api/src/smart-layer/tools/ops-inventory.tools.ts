/**
 * Phase E2 ops tools, inventory side: warehouses and warehouse stock, suppliers and purchase orders, stock adjustment documents and count sessions.
 */
import { type TurnCtx, type ToolSpec } from '@ebda/shared/smart-layer';
import { AppError } from '../../middleware/error-handler';
import { ProductService } from '../../services/product.service';
import { WarehouseService } from '../../services/warehouse.service';
import {
  createSupplier,
  getSupplier,
  listSuppliers,
} from '../../services/accounting/supplier.service';
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  receivePurchaseOrder,
} from '../../services/accounting/purchase-order.service';
import { change, egp, f, pair, row, shape } from './kit';
import {
  createAdjustment,
  postAdjustment,
} from '../../services/accounting/stock-adjustment.service';
import {
  closeCountSession,
  openCountSession,
  reconcileCountSession,
  submitCountLine,
} from '../../services/barcode-scan.service';
import { OWNER, iso, notFound, toPiasters, type Rec } from './ops-shared';

// ======================================================================================================================================
// inventory.warehouses
// ======================================================================================================================================
// warehouse.routes.ts: authorize('store_admin','super_admin') + requireFeature('inventory.multi_warehouse') on every route.
const WAREHOUSE_GATE = { roles: OWNER, feature: 'inventory.multi_warehouse' } as const;
const WH_FIELDS = ['name', 'nameAr', 'priority', 'address', 'isActive'] as const;
const WH_LABELS: Record<string, [string, string]> = {
  name: ['اسم المخزن', 'Name'],
  nameAr: ['الاسم بالعربي', 'Arabic name'],
  priority: ['الأولوية', 'Priority'],
  address: ['العنوان', 'Address'],
  isActive: ['شغال', 'Active'],
  isDefault: ['المخزن الافتراضي', 'Default warehouse'],
};
type WhArgs = {
  warehouseId: string;
  name?: string;
  nameAr?: string | null;
  priority?: number;
  address?: string | null;
  isActive?: boolean;
};
const warehouseUpdate = change<WhArgs>({
  name: 'warehouse_update',
  capabilityId: 'inventory.warehouses',
  description:
    'Edit a warehouse: rename it, change its priority or address, or switch it off (a soft switch-off, the stock stays). Send only what changes. Use for "rename the warehouse", "عدّل المخزن", "وقف المخزن ده".',
  schema: shape(
    {
      warehouseId: f.id('The warehouse id.'),
      name: f.str('New name.', { max: 200 }),
      nameAr: f.nullable(f.str('Arabic name (null clears).', { max: 200 })),
      priority: f.int('Higher priority is picked first.', { max: 9999 }),
      address: f.nullable(f.str('Address (null clears).', { max: 500 })),
      isActive: f.bool('false switches the warehouse off.'),
    },
    ['warehouseId']
  ),
  undo: 'reversible',
  gate: WAREHOUSE_GATE,
  audit: { action: 'warehouse.updated', resourceType: 'warehouse', resourceId: a => a.warehouseId },
  state: async (ctx, a) => {
    const w = await WarehouseService.getWarehouse(ctx.storeId, a.warehouseId);
    return {
      ...Object.fromEntries(WH_FIELDS.map(k => [k, (w as unknown as Rec)[k] ?? null])),
      updatedAt: iso(w.updatedAt),
    };
  },
  describe: (_ctx, a, st) => {
    const cur = st as Rec;
    const keys = WH_FIELDS.filter(k => a[k] !== undefined);
    if (keys.length === 0)
      throw new AppError(400, 'NOTHING_TO_CHANGE', 'Send at least one field to change.');
    return {
      summary: pair(
        `هعدّل المخزن (${keys.length} حقل)`,
        `Update the warehouse (${keys.length} field(s))`
      ),
      rows: keys.map(k => row(WH_LABELS[k]![0], WH_LABELS[k]![1], cur[k] ?? null, a[k])),
      affectedCount: 1,
      restore: Object.fromEntries(keys.map(k => [k, cur[k] ?? null])),
    };
  },
  run: (ctx, a) => {
    const { warehouseId, ...patch } = a;
    return WarehouseService.updateWarehouse(ctx.storeId, warehouseId, patch as never);
  },
  inverse: (a, restore) =>
    restore && Object.keys(restore as Rec).length > 0
      ? { tool: 'warehouse_update', args: { warehouseId: a.warehouseId, ...(restore as Rec) } }
      : null,
});

// Making a warehouse the default makes WarehouseService.updateWarehouse clear the old default. Its undo gives the flag back to the old default, which is a
// different warehouse: so the default is its own tool, and its state is the store's whole default picture (not one warehouse), so the etag taken after the apply
// is the one the undo's preview takes.
const warehouseSetDefault = change<{ warehouseId: string }>({
  name: 'warehouse_set_default',
  capabilityId: 'inventory.warehouses',
  description:
    'Make a warehouse the default one (new orders and stock go there first). The old default stops being the default; undo gives it back. Use for "make Cairo the main warehouse", "خلي مخزن القاهرة هو الافتراضي".',
  schema: shape({ warehouseId: f.id('The warehouse id.') }, ['warehouseId']),
  undo: 'reversible',
  gate: WAREHOUSE_GATE,
  audit: {
    action: 'warehouse.default_changed',
    resourceType: 'warehouse',
    resourceId: a => a.warehouseId,
  },
  state: async (ctx, a) => {
    await WarehouseService.getWarehouse(ctx.storeId, a.warehouseId); // 404 for another store's warehouse
    const all = await WarehouseService.listWarehouses(ctx.storeId);
    return {
      defaultId: all.find(w => w.isDefault)?.id ?? null,
      names: Object.fromEntries(all.map(w => [w.id, w.name])),
    };
  },
  describe: (_ctx, a, st) => {
    const s = st as { defaultId: string | null; names: Record<string, string> };
    if (s.defaultId === a.warehouseId)
      throw new AppError(409, 'ALREADY_DEFAULT', 'This warehouse is already the default.');
    return {
      summary: pair(
        `هخلّي مخزن «${s.names[a.warehouseId] ?? a.warehouseId}» هو الافتراضي`,
        `Make "${s.names[a.warehouseId] ?? a.warehouseId}" the default warehouse`
      ),
      rows: [
        row(
          'المخزن الافتراضي',
          'Default warehouse',
          s.defaultId ? (s.names[s.defaultId] ?? s.defaultId) : null,
          s.names[a.warehouseId] ?? a.warehouseId
        ),
      ],
      affectedCount: 1,
      restore: { previousDefaultId: s.defaultId },
    };
  },
  run: (ctx, a) =>
    WarehouseService.updateWarehouse(ctx.storeId, a.warehouseId, { isDefault: true } as never),
  inverse: (_a, restore) => {
    const prev = (restore as { previousDefaultId: string | null } | null)?.previousDefaultId;
    return prev ? { tool: 'warehouse_set_default', args: { warehouseId: prev } } : null;
  },
});

const warehouseCreate = change<{
  name: string;
  nameAr?: string;
  code: string;
  priority?: number;
  address?: string;
}>({
  name: 'warehouse_create',
  capabilityId: 'inventory.warehouses',
  description:
    'Add a new warehouse (name, a short code like CAI or ALX, optional Arabic name, priority, address). Use for "I have a second warehouse", "ضيف مخزن جديد". Undo switches the new warehouse off.',
  schema: shape(
    {
      name: f.str('Warehouse name.', { max: 200 }),
      nameAr: f.str('Arabic name.', { max: 200 }),
      code: f.str('Short code: letters, digits, - and _ only.', { max: 20 }),
      priority: f.int('Higher priority is picked first.', { max: 9999 }),
      address: f.str('Address.', { max: 500 }),
    },
    ['name', 'code']
  ),
  undo: 'reversible',
  gate: WAREHOUSE_GATE,
  audit: { action: 'warehouse.created', resourceType: 'warehouse' },
  state: async ctx => ({
    codes: (await WarehouseService.listWarehouses(ctx.storeId)).map(w => w.code).sort(),
  }),
  describe: (_ctx, a, st) => {
    if (!/^[A-Za-z0-9_-]+$/.test(a.code))
      throw new AppError(422, 'INVALID_CODE', 'Code must be alphanumeric (A-Z, 0-9, -, _).');
    if ((st as { codes: string[] }).codes.some(c => c.toUpperCase() === a.code.toUpperCase()))
      throw new AppError(409, 'CODE_TAKEN', `A warehouse with code ${a.code} already exists.`);
    return {
      summary: pair(
        `هضيف مخزن جديد «${a.name}» بكود ${a.code}`,
        `Add warehouse "${a.name}" with code ${a.code}`
      ),
      rows: [row('الاسم', 'Name', null, a.name), row('الكود', 'Code', null, a.code)],
      affectedCount: 1,
    };
  },
  run: async (ctx, a) => {
    const w = await WarehouseService.createWarehouse(ctx.storeId, a);
    return { id: w.id, code: w.code };
  },
  inverse: (_a, _restore, result) => {
    const id = (result as { id?: string } | null)?.id;
    return id ? { tool: 'warehouse_update', args: { warehouseId: id, isActive: false } } : null;
  },
});

type AdjArgs = { warehouseId: string; productId: string; delta: number; reason?: string };
const warehouseStockAdjust = change<AdjArgs>({
  name: 'warehouse_stock_adjust',
  capabilityId: 'inventory.warehouses',
  description:
    'Add or remove units of ONE simple product in ONE warehouse (+10 adds, -3 removes; never below zero). For a product with variants the merchant uses the warehouse screen. Use for "add 20 units to the Cairo warehouse", "نقّص المخزن".',
  schema: shape(
    {
      warehouseId: f.id('The warehouse id.'),
      productId: f.id('The product id.'),
      delta: f.int('Signed whole number of units.', { min: -1_000_000, max: 1_000_000 }),
      reason: f.str('Why (kept in the stock history).', { max: 500 }),
    },
    ['warehouseId', 'productId', 'delta']
  ),
  undo: 'reversible',
  gate: WAREHOUSE_GATE,
  audit: {
    action: 'warehouse.stock_adjusted',
    resourceType: 'warehouse',
    resourceId: a => a.warehouseId,
  },
  refs: a => [{ kind: 'product', id: a.productId }],
  state: async (ctx, a) => {
    const w = await WarehouseService.getWarehouse(ctx.storeId, a.warehouseId); // 404 for another store's warehouse
    const stock = await WarehouseService.getProductStock(ctx.storeId, a.productId, null);
    return {
      warehouseId: w.id,
      warehouse: w.name,
      quantity: stock.find(s => s.warehouseId === a.warehouseId)?.quantity ?? 0,
    };
  },
  describe: (_ctx, a, st) => {
    const s = st as { warehouse: string; quantity: number };
    if (a.delta === 0)
      throw new AppError(400, 'NOTHING_TO_CHANGE', 'A change of 0 units does nothing.');
    const after = Math.max(0, s.quantity + a.delta);
    return {
      summary: pair(
        `هغيّر المخزون في «${s.warehouse}» من ${s.quantity} إلى ${after}`,
        `Change stock in ${s.warehouse} from ${s.quantity} to ${after}`
      ),
      rows: [row('المخزون في المخزن', 'Stock in the warehouse', s.quantity, after)],
      affectedCount: 1,
      restore: { delta: s.quantity - after },
    };
  },
  run: (ctx, a) =>
    WarehouseService.adjustStock(ctx.storeId, a.warehouseId, {
      productId: a.productId,
      delta: a.delta,
      reason: a.reason,
    }),
  inverse: (a, restore) =>
    restore && (restore as { delta: number }).delta !== 0
      ? {
          tool: 'warehouse_stock_adjust',
          args: { ...a, delta: (restore as { delta: number }).delta },
        }
      : null,
});

// ======================================================================================================================================
// inventory.suppliers-po
// ======================================================================================================================================
// purchase-orders.routes.ts / suppliers.routes.ts: authorize('store_admin','super_admin') + requireFeature('inventory.purchase_orders' | 'accounting.basic').
const PO_GATE = { roles: OWNER, feature: 'inventory.purchase_orders' } as const;
const supplierCreate = change<{
  name: string;
  nameAr?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  paymentTerms?: string;
  leadTimeDays?: number;
}>({
  name: 'supplier_create',
  capabilityId: 'inventory.suppliers-po',
  description:
    'Add a supplier (name, contact, phone, email, payment terms, lead time in days) so purchase orders can be made to them. Use for "add a supplier", "ضيف مورد".',
  schema: shape(
    {
      name: f.str('Supplier name.', { max: 200 }),
      nameAr: f.str('Arabic name.', { max: 200 }),
      contactName: f.str('Contact person.', { max: 200 }),
      phone: f.str('Phone.', { max: 50 }),
      email: f.str('Email.', { max: 200 }),
      paymentTerms: f.enum(['net0', 'net15', 'net30', 'net60'], 'Days to pay after receiving.'),
      leadTimeDays: f.int('Usual delivery time in days.', { min: 1, max: 365 }),
    },
    ['name']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  gate: { roles: OWNER, feature: 'accounting.basic' },
  audit: { action: 'supplier.created', resourceType: 'supplier' },
  state: async ctx => ({
    names: (await listSuppliers(ctx.storeId, { includeInactive: true })).map(s => s.name).sort(),
  }),
  describe: (_ctx, a) => ({
    summary: pair(`هضيف المورد «${a.name}»`, `Add supplier "${a.name}"`),
    rows: [
      row('الاسم', 'Name', null, a.name),
      ...(a.phone ? [row('التليفون', 'Phone', null, a.phone)] : []),
      ...(a.email ? [row('الإيميل', 'Email', null, a.email)] : []),
      ...(a.paymentTerms ? [row('شروط الدفع', 'Payment terms', null, a.paymentTerms)] : []),
    ],
    affectedCount: 1,
  }),
  run: async (ctx, a) => {
    const s = await createSupplier({
      storeId: ctx.storeId,
      ...a,
      paymentTerms: a.paymentTerms as never,
    });
    return { id: s.id };
  },
});

async function readPo(ctx: TurnCtx, poId: string) {
  const po = (await getPurchaseOrder(ctx.storeId, poId)) as unknown as {
    id: string;
    poNumber?: string;
    status: string;
    updatedAt?: Date;
    supplier?: { name?: string } | null;
    items: Array<{
      id: string;
      qty: number;
      qtyReceived: number;
      unitCost: number;
      product?: { name?: string } | null;
    }>;
  } | null;
  if (!po) throw new AppError(404, 'PO_NOT_FOUND', 'Purchase order not found.');
  return {
    poId: po.id,
    poNumber: po.poNumber ?? po.id,
    status: String(po.status),
    supplier: po.supplier?.name ?? null,
    updatedAt: iso(po.updatedAt),
    items: po.items.map(i => ({
      id: i.id,
      product: i.product?.name ?? null,
      qty: i.qty,
      qtyReceived: i.qtyReceived,
      unitCostMinor: i.unitCost,
    })),
  };
}
type PoState = Awaited<ReturnType<typeof readPo>>;

type PoCreateArgs = {
  supplierId: string;
  items: Array<{ productId: string; variantId?: string; qty: number; unitCostEgp: number }>;
  expectedDate?: string;
  notes?: string;
};
const poCreate = change<PoCreateArgs>({
  name: 'purchase_order_create',
  capabilityId: 'inventory.suppliers-po',
  description:
    'Create a draft purchase order to a supplier: the products, the quantity of each and the unit cost in EGP (a decimal number, not piasters). Nothing is paid or received yet. Use for "make a purchase order", "اعمل امر شراء", "اطلب من المورد".',
  schema: shape(
    {
      supplierId: f.id('The supplier id.'),
      items: f.list(
        f.obj(
          {
            productId: f.id('The product id.'),
            variantId: f.id('The variant id, if the product has variants.'),
            qty: f.int('Units to order.', { min: 1, max: 1_000_000 }),
            unitCostEgp: f.num('Cost per unit in EGP.', { max: 100_000_000 }),
          },
          ['productId', 'qty', 'unitCostEgp']
        ),
        { min: 1, max: 25 }
      ),
      expectedDate: f.str('Expected delivery date, YYYY-MM-DD.', { max: 30 }),
      notes: f.str('Notes on the order.', { max: 1000 }),
    },
    ['supplierId', 'items']
  ),
  policy: 'confirm',
  // Registry class for the capability is irreversible (a cancel or a receive cannot be taken back); a draft can still be cancelled with purchase_order_cancel.
  undo: 'irreversible',
  gate: PO_GATE,
  audit: { action: 'purchase_order.created', resourceType: 'purchase_order' },
  refs: a => a.items.map(i => ({ kind: 'product', id: i.productId })),
  state: async (ctx, a) => {
    const s = await getSupplier(ctx.storeId, a.supplierId); // another store's supplier is simply absent
    if (!s) throw notFound('Supplier');
    return { supplierId: s.id, supplier: s.name, isActive: s.isActive };
  },
  describe: async (ctx, a, st) => {
    const s = st as { supplier: string };
    const names = await Promise.all(
      a.items.map(async i => {
        try {
          return String(
            ((await ProductService.getById(ctx.storeId, i.productId)) as Rec).name ?? i.productId
          );
        } catch {
          return i.productId;
        }
      })
    );
    const totalMinor = a.items.reduce((n, i) => n + i.qty * toPiasters(i.unitCostEgp), 0);
    return {
      summary: pair(
        `هعمل أمر شراء مسودة للمورد «${s.supplier}»: ${a.items.length} صنف بإجمالي ${egp(totalMinor)} ج.م. لسه مفيش دفع ولا استلام.`,
        `Create a draft purchase order to ${s.supplier}: ${a.items.length} item(s), total ${egp(totalMinor)} EGP. Nothing is paid or received yet.`
      ),
      rows: [
        row('المورد', 'Supplier', null, s.supplier),
        ...a.items.map((i, n) =>
          row(`صنف ${n + 1}`, `Item ${n + 1}`, null, `${names[n]}: ${i.qty} × ${i.unitCostEgp} EGP`)
        ),
        row('الإجمالي (ج.م)', 'Total (EGP)', null, egp(totalMinor)),
      ],
      affectedCount: a.items.length,
    };
  },
  run: async (ctx, a) => {
    const po = await createPurchaseOrder({
      storeId: ctx.storeId,
      supplierId: a.supplierId,
      createdBy: ctx.userId,
      ...(a.expectedDate ? { expectedDate: new Date(a.expectedDate) } : {}),
      ...(a.notes ? { notes: a.notes } : {}),
      items: a.items.map(i => ({
        productId: i.productId,
        ...(i.variantId ? { variantId: i.variantId } : {}),
        qty: i.qty,
        unitCost: toPiasters(i.unitCostEgp),
      })),
    });
    return { id: po.id };
  },
});

const poCancel = change<{ poId: string }>({
  name: 'purchase_order_cancel',
  capabilityId: 'inventory.suppliers-po',
  description:
    'Cancel a purchase order that is not fully received yet. Cannot be undone. Use for "cancel the purchase order", "الغي امر الشراء".',
  schema: shape({ poId: f.id('The purchase order id.') }, ['poId']),
  policy: 'confirm',
  undo: 'irreversible',
  gate: PO_GATE,
  audit: {
    action: 'purchase_order.cancelled',
    resourceType: 'purchase_order',
    resourceId: a => a.poId,
  },
  state: (ctx, a) => readPo(ctx, a.poId),
  describe: (_ctx, _a, st) => {
    const s = st as PoState;
    if (s.status === 'received' || s.status === 'cancelled')
      throw new AppError(
        409,
        'PO_NOT_CANCELLABLE',
        `A ${s.status} purchase order cannot be cancelled.`
      );
    return {
      summary: pair(
        `هلغي أمر الشراء ${s.poNumber} للمورد «${s.supplier}». مينفعش يترجع.`,
        `Cancel purchase order ${s.poNumber} to ${s.supplier}. This cannot be undone.`
      ),
      rows: [
        row('أمر الشراء', 'Purchase order', s.poNumber, s.poNumber),
        row('الحالة', 'Status', s.status, 'cancelled'),
      ],
      affectedCount: 1,
    };
  },
  run: (ctx, a) => cancelPurchaseOrder(ctx.storeId, a.poId),
});

const poReceive = change<{
  poId: string;
  receipts: Array<{ poItemId: string; qtyReceived: number }>;
}>({
  name: 'purchase_order_receive',
  capabilityId: 'inventory.suppliers-po',
  description:
    'Record that goods of a purchase order arrived (all or part): adds the units to stock at the order\'s unit cost, clears waiting backorders first and books what is owed to the supplier. Cannot be undone. Use for "I received the shipment", "استلمت نص الشحنة".',
  schema: shape(
    {
      poId: f.id('The purchase order id.'),
      receipts: f.list(
        f.obj(
          {
            poItemId: f.id('The purchase order line id.'),
            qtyReceived: f.int('Units that arrived.', { min: 1, max: 1_000_000 }),
          },
          ['poItemId', 'qtyReceived']
        ),
        { min: 1, max: 25 }
      ),
    },
    ['poId', 'receipts']
  ),
  policy: 'confirm',
  undo: 'irreversible',
  money: true,
  gate: PO_GATE,
  audit: {
    action: 'purchase_order.received',
    resourceType: 'purchase_order',
    resourceId: a => a.poId,
  },
  state: (ctx, a) => readPo(ctx, a.poId),
  describe: (_ctx, a, st) => {
    const s = st as PoState;
    if (s.status === 'received' || s.status === 'cancelled')
      throw new AppError(
        409,
        'PO_NOT_RECEIVABLE',
        `A ${s.status} purchase order cannot receive goods.`
      );
    let totalMinor = 0;
    const rows = a.receipts.map(r => {
      const line = s.items.find(i => i.id === r.poItemId);
      if (!line)
        throw new AppError(400, 'PO_ITEM_NOT_FOUND', 'That line is not on this purchase order.');
      totalMinor += r.qtyReceived * line.unitCostMinor;
      return row(
        line.product ?? line.id,
        line.product ?? line.id,
        `${line.qtyReceived}/${line.qty}`,
        `${line.qtyReceived + r.qtyReceived}/${line.qty}`
      );
    });
    return {
      summary: pair(
        `هسجّل استلام بضاعة أمر الشراء ${s.poNumber} بقيمة ${egp(totalMinor)} ج.م وهزوّد المخزون. مينفعش يترجع.`,
        `Record goods received on purchase order ${s.poNumber}, worth ${egp(totalMinor)} EGP, and add them to stock. This cannot be undone.`
      ),
      rows: [...rows, row('قيمة المستلم (ج.م)', 'Value received (EGP)', null, egp(totalMinor))],
      affectedCount: a.receipts.length,
    };
  },
  run: async (ctx, a) => {
    const r = await receivePurchaseOrder({
      storeId: ctx.storeId,
      poId: a.poId,
      receivedBy: ctx.userId,
      receipts: a.receipts,
    });
    return { status: String((r.po as { status?: string }).status ?? '') };
  },
});

// ======================================================================================================================================
// inventory.stock-adjustments
// ======================================================================================================================================
// stock-adjustments.routes.ts POST /:storeId/stock-adjustments then POST /:id/post: authorize('store_admin','super_admin') + requireFeature('inventory.bulk_adjustments').
const ADJ_TYPES = [
  'cycle_count',
  'damage',
  'theft',
  'loss',
  'write_off',
  'found',
  'return_to_supplier',
] as [string, ...string[]];
type StockAdjArgs = {
  type: string;
  reason?: string;
  items: Array<{ productId: string; newQty: number }>;
};
/** The same product twice would count or adjust it twice: refused. */
function assertUniqueProducts(ids: string[]): void {
  if (new Set(ids).size !== ids.length)
    throw new AppError(422, 'DUPLICATE_PRODUCT', 'A product can appear only once in the list.');
}
async function readStockLines(ctx: TurnCtx, items: StockAdjArgs['items']) {
  return Promise.all(
    items.map(async i => {
      const p = (await ProductService.getById(ctx.storeId, i.productId)) as Rec & {
        variants?: unknown[];
      };
      return {
        productId: i.productId,
        name: String(p.name ?? i.productId),
        inventory: Number(p.inventory ?? 0),
        costMinor: Number(p.costPrice ?? 0),
        hasVariants: (p.variants?.length ?? 0) > 0,
      };
    })
  );
}
const stockAdjustmentCreate = change<StockAdjArgs>({
  name: 'stock_adjustment_create',
  capabilityId: 'inventory.stock-adjustments',
  description:
    'Record a stock adjustment document and post it: a count variance, damage, theft, loss, write-off, found stock or return to supplier. Each line is a simple product and the counted total (newQty). It changes stock and the accounts (the cost of the difference) and a posted adjustment is only reversed by another adjustment. Use for "adjust stock after the count", "سجّل تالف", "تسوية جرد".',
  schema: shape(
    {
      type: f.enum(
        ADJ_TYPES,
        'cycle_count, damage, theft, loss, write_off, found or return_to_supplier.'
      ),
      reason: f.str('Why (kept on the document).', { max: 500 }),
      items: f.list(
        f.obj(
          {
            productId: f.id('The product id (a product without variants).'),
            newQty: f.int('The counted total in stock after the adjustment.', { max: 1_000_000 }),
          },
          ['productId', 'newQty']
        ),
        { min: 1, max: 25 }
      ),
    },
    ['type', 'items']
  ),
  policy: 'confirm',
  // Registry class is irreversible: a posted adjustment needs a reversing adjustment, which is its own confirm card.
  undo: 'irreversible',
  money: true,
  gate: { roles: OWNER, feature: 'inventory.bulk_adjustments' },
  audit: { action: 'stock_adjustment.posted', resourceType: 'stock_adjustment' },
  refs: a => a.items.map(i => ({ kind: 'product', id: i.productId })),
  state: (ctx, a) => readStockLines(ctx, a.items),
  describe: (_ctx, a, st) => {
    assertUniqueProducts(a.items.map(i => i.productId));
    const lines = st as Awaited<ReturnType<typeof readStockLines>>;
    let impact = 0;
    let changed = 0;
    const rows = lines.map((l, n) => {
      if (l.hasVariants)
        throw new AppError(
          422,
          'VARIANT_PRODUCT',
          `${l.name} has variants; adjust it on the stock screen.`
        );
      const delta = a.items[n]!.newQty - l.inventory;
      if (delta !== 0) changed += 1;
      impact += delta * l.costMinor;
      return row(
        l.name,
        l.name,
        l.inventory,
        `${a.items[n]!.newQty} (${delta >= 0 ? '+' : ''}${delta}, ${egp(delta * l.costMinor)} EGP)`
      );
    });
    if (changed === 0)
      throw new AppError(
        400,
        'NOTHING_TO_CHANGE',
        'Every counted quantity equals the current stock.'
      );
    return {
      summary: pair(
        `هسجّل تسوية مخزون (${a.type}) على ${changed} منتج وأرحّلها. أثرها على تكلفة المخزون ${egp(impact)} ج.م، ومينفعش تترجع غير بتسوية عكسية.`,
        `Record and post a stock adjustment (${a.type}) on ${changed} product(s). Cost impact ${egp(impact)} EGP; it is only reversed by another adjustment.`
      ),
      rows: [...rows, row('الأثر على التكلفة (ج.م)', 'Cost impact (EGP)', null, egp(impact))],
      affectedCount: changed,
    };
  },
  run: async (ctx, a) => {
    const draft = await createAdjustment({
      storeId: ctx.storeId,
      createdBy: ctx.userId,
      type: a.type as never,
      ...(a.reason ? { reason: a.reason } : {}),
      items: a.items,
    });
    const posted = await postAdjustment(ctx.storeId, draft.id, ctx.userId);
    return { id: posted.id };
  },
});

// ======================================================================================================================================
// inventory.barcode-scan-count
// ======================================================================================================================================
// inventory.routes.ts POST /:storeId/inventory/count-sessions (+ /lines, /close, /reconcile): authorize('store_admin','super_admin') + requireFeature('inventory.barcode').
type CountArgs = { note?: string; lines: Array<{ productId: string; countedQty: number }> };
const barcodeCountSet = change<CountArgs>({
  name: 'barcode_count_set',
  capabilityId: 'inventory.barcode-scan-count',
  description:
    'Run a stock count without a scanner: say the counted quantity of up to 25 simple products. It opens a count session, records each line, closes it and reconciles, so stock becomes the counted numbers (the difference is posted to the accounts as a cycle-count adjustment). Undo counts the old numbers back and posts a second adjustment. Use for "I counted 12 of this", "جرد المخزن", "الجرد طلع 3 بدل 5".',
  schema: shape(
    {
      note: f.str('Note on the count session.', { max: 300 }),
      lines: f.list(
        f.obj(
          {
            productId: f.id('The product id (a product without variants).'),
            countedQty: f.int('Units you counted.', { max: 1_000_000 }),
          },
          ['productId', 'countedQty']
        ),
        { min: 1, max: 25 }
      ),
    },
    ['lines']
  ),
  policy: 'confirm',
  // The reconcile posts a cycle-count adjustment to the accounts, like stock_adjustment_create. Undo recounts the old numbers, which posts a SECOND
  // adjustment (the first one is not erased), so it is compensating and its own confirm card.
  undo: 'compensating',
  money: true,
  gate: { roles: OWNER, feature: 'inventory.barcode' },
  audit: { action: 'inventory.count_reconciled', resourceType: 'count_session' },
  refs: a => a.lines.map(l => ({ kind: 'product', id: l.productId })),
  state: (ctx, a) =>
    readStockLines(
      ctx,
      a.lines.map(l => ({ productId: l.productId, newQty: l.countedQty }))
    ),
  describe: (_ctx, a, st) => {
    assertUniqueProducts(a.lines.map(l => l.productId));
    const lines = st as Awaited<ReturnType<typeof readStockLines>>;
    let changed = 0;
    let impact = 0;
    const rows = lines.map((l, n) => {
      if (l.hasVariants)
        throw new AppError(
          422,
          'VARIANT_PRODUCT',
          `${l.name} has variants; count it on the scan screen.`
        );
      const counted = a.lines[n]!.countedQty;
      if (counted !== l.inventory) changed += 1;
      impact += (counted - l.inventory) * l.costMinor;
      return row(
        l.name,
        l.name,
        l.inventory,
        `${counted} (${counted >= l.inventory ? '+' : ''}${counted - l.inventory}, ${egp((counted - l.inventory) * l.costMinor)} EGP)`
      );
    });
    if (changed === 0)
      throw new AppError(400, 'NOTHING_TO_CHANGE', 'Every count equals the current stock.');
    return {
      summary: pair(
        `هسجّل جرد ${lines.length} منتج وأضبط المخزون على الأرقام المعدودة (${changed} فيهم مختلف). الفرق بيتسجل في الحسابات بقيمة ${egp(impact)} ج.م، والتراجع بيسجّل تسوية تانية.`,
        `Record a count of ${lines.length} product(s) and set stock to the counted numbers (${changed} differ). The difference is posted to the accounts (${egp(impact)} EGP); undoing posts a second adjustment.`
      ),
      rows: [...rows, row('الأثر على التكلفة (ج.م)', 'Cost impact (EGP)', null, egp(impact))],
      affectedCount: changed,
      restore: { lines: lines.map(l => ({ productId: l.productId, countedQty: l.inventory })) },
    };
  },
  run: async (ctx, a) => {
    const session = await openCountSession(ctx.storeId, ctx.userId, a.note);
    for (const l of a.lines) await submitCountLine(ctx.storeId, session.id, l);
    await closeCountSession(ctx.storeId, session.id);
    return reconcileCountSession(ctx.storeId, session.id, ctx.userId);
  },
  inverse: (_a, restore) =>
    restore
      ? { tool: 'barcode_count_set', args: { note: 'undo', lines: (restore as CountArgs).lines } }
      : null,
});

export function opsInventoryTools(): ToolSpec[] {
  return [
    warehouseUpdate,
    warehouseSetDefault,
    warehouseCreate,
    warehouseStockAdjust,
    supplierCreate,
    poCreate,
    poCancel,
    poReceive,
    stockAdjustmentCreate,
    barcodeCountSet,
  ];
}
