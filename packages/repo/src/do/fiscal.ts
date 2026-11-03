// DO port of the fiscal documents (INFRA-CF-1 PR R2, Ruling CF-R2-1): `FiscalDocumentService.issueSaleDocument`,
// `issueRefundDocument`, `cancelSaleDocument` and `allocateSerial` (apps/api/src/services/fiscal-document.service.ts), with the
// pure helpers they call (`buildSaleLines`, `documentBalance`, shared `groupOrderLinesForDisplay` / `orderAddressLines`,
// api `priceLineLabel` / `struckListPrice`). The Postgres file stays the reference: the contract test compares the documents
// field for field (number, payload, amounts), so a drift in any copy below fails the build.
//
// GAPLESS numbering: one counter row per (store, doc type), bumped with ONE upsert INSIDE the section that writes the document.
// The Durable Object is single-threaded and the section is one `transactionSync`, so concurrent issuers are serialised and a
// section that throws (an unbalanced invoice, a refused order) rolls the bump back with the document: no gaps, no duplicates.
import { MoneyError, type SyncSql } from './sync-sql';
import { mulDivRound } from './tax';

export type SaleDocType = 'tax_invoice' | 'receipt';
export type RefundDocType = 'credit_note' | 'refund_receipt';
const PREFIX: Record<SaleDocType | RefundDocType, string> = {
  tax_invoice: 'INV',
  receipt: 'RCT',
  credit_note: 'CRN',
  refund_receipt: 'RFR',
};
/** 7 years: must equal apps/api/src/config/retention.ts RETENTION_YEARS (Ruling RETENTION-1; legal minimum 5 + 2 buffer). */
const RETENTION_YEARS = 7;
const SALE_TYPES = "('tax_invoice', 'receipt')";
const REFUND_TYPES = "('credit_note', 'refund_receipt')";

export const fiscalNumber = (docType: keyof typeof PREFIX, serial: number): string =>
  `${PREFIX[docType]}-${String(serial).padStart(6, '0')}`;

export function retainUntil(issuedAt: number): number {
  const d = new Date(issuedAt);
  d.setUTCFullYear(d.getUTCFullYear() + RETENTION_YEARS);
  return d.getTime();
}

interface FiscalLine {
  kind: 'item' | 'bundle' | 'shipping' | 'cod_fee' | 'extra';
  description: string;
  descriptionAr?: string | null;
  sku?: string | null;
  quantity: number;
  unitPrice: number | null;
  amount: number;
  priceLabel?: string | null;
  priceLabelAr?: string | null;
  listPrice?: number | null;
}
interface FiscalDiscount {
  kind: 'coupon' | 'promotion' | 'loyalty' | 'other';
  label: string | null;
  amount: number;
}
/** An order line as the sale document reads it (camelCase, like the Prisma row the Postgres builder gets). */
interface SaleItem {
  id: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  price: number;
  total: number;
  bundleGroupId: string | null;
  bundleName: string | null;
  bundleNameAr: string | null;
  priceSource: string | null;
  priceTierMinQty: number | null;
  priceGroupApplied: boolean | null;
  listPrice: number | null;
  productNameAr: string | null;
}

// ---- pure helpers (copies, pinned by the contract test) ---------------------------------------------------------------

function priceLineLabel(
  i: {
    priceSource: string | null;
    priceTierMinQty: number | null;
    priceGroupApplied: boolean | null;
  },
  lang: 'en' | 'ar'
): string | null {
  if (i.priceSource === 'group') return lang === 'ar' ? 'سعر الجملة' : 'Wholesale price';
  if (i.priceSource !== 'tier') return null;
  const wholesale = i.priceGroupApplied === true;
  const name =
    lang === 'ar'
      ? wholesale
        ? 'سعر الجملة'
        : 'سعر الكمية'
      : wholesale
        ? 'Wholesale price'
        : 'Quantity price';
  if (i.priceTierMinQty == null) return name;
  return lang === 'ar'
    ? `${name}، ${i.priceTierMinQty}+ وحدة`
    : `${name}, ${i.priceTierMinQty}+ units`;
}

function struckListPrice(i: {
  priceSource: string | null;
  listPrice: number | null;
  price: number;
}): number | null {
  return i.priceSource && i.priceSource !== 'base' && i.listPrice != null && i.listPrice > i.price
    ? i.listPrice
    : null;
}

type Row =
  | { kind: 'item'; item: SaleItem }
  | { kind: 'bundle'; name: string; nameAr: string | null; total: number };
function groupLines(items: SaleItem[]): Row[] {
  const out: Row[] = [];
  const at = new Map<string, number>();
  for (const item of items) {
    if (item.bundleGroupId) {
      const idx = at.get(item.bundleGroupId);
      if (idx === undefined) {
        at.set(item.bundleGroupId, out.length);
        out.push({
          kind: 'bundle',
          name: item.bundleName || item.bundleNameAr || 'Bundle',
          nameAr: item.bundleNameAr || (item.bundleName ? null : 'باقة'),
          total: item.price * item.quantity,
        });
      } else {
        const existing = out[idx];
        if (existing.kind === 'bundle') existing.total += item.price * item.quantity;
      }
    } else out.push({ kind: 'item', item });
  }
  return out;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const pick = (locale: 'ar' | 'en', ar: string, en: string): string =>
  locale === 'ar' ? ar || en : en || ar;
/** shared `orderAddressLines` (the home country is Egypt / مصر). */
function addressLines(addr: Record<string, unknown> | null, locale: 'ar' | 'en'): string[] {
  if (!addr) return [];
  const street = str(addr.address1) || str(addr.street);
  const landmark = str(addr.address2) || str(addr.landmark);
  const area = pick(locale, str(addr.areaAr), str(addr.area));
  const city = pick(locale, str(addr.cityAr), str(addr.city));
  const governorate = pick(locale, str(addr.governorateAr), str(addr.governorate));
  const state = str(addr.state);
  const sep = locale === 'ar' ? '، ' : ', ';
  const parts: string[] = [];
  for (const p of [area || city, governorate || state]) if (p && !parts.includes(p)) parts.push(p);
  let locality = parts.join(sep);
  const postal = str(addr.postalCode);
  if (postal) locality = locality ? `${locality} ${postal}` : postal;
  const rawCountry = str(addr.country);
  const isHome =
    rawCountry === 'Egypt' || rawCountry === 'مصر' || rawCountry.toUpperCase() === 'EG';
  const country = isHome ? (locale === 'ar' ? 'مصر' : 'Egypt') : rawCountry;
  const label = locale === 'ar' ? 'علامة مميزة' : 'Landmark';
  return [street, landmark ? `${label}: ${landmark}` : '', locality, country].filter(l => !!l);
}

interface SaleOrder {
  orderNumber: string;
  createdAt: number;
  currency: string;
  subtotal: number;
  discount: number;
  couponDiscount: number;
  couponCode: string | null;
  promotionDiscount: number;
  loyaltyDiscount: number;
  loyaltyPointsRedeemed: number | null;
  shipping: number;
  codFee: number;
  extraAmount: number;
  extraAmountNote: string | null;
  tax: number;
  taxIncludedInPrice: boolean;
  taxRateBps: number | null;
  taxableAmount: number | null;
  total: number;
  sellerTaxRegistrationNumber: string | null;
  sellerTaxLegalName: string | null;
  shippingAddress: Record<string, unknown> | null;
  billingAddress: Record<string, unknown> | null;
  appliedPromotion: { name: string; nameAr: string | null } | null;
  items: SaleItem[];
  paymentProvider: string | null;
}

export function buildSaleLines(order: SaleOrder): {
  lines: FiscalLine[];
  discounts: FiscalDiscount[];
} {
  const lines: FiscalLine[] = [];
  for (const row of groupLines(order.items)) {
    if (row.kind === 'bundle') {
      lines.push({
        kind: 'bundle',
        description: row.name,
        descriptionAr: row.nameAr ?? null,
        quantity: 1,
        unitPrice: null,
        amount: row.total,
      });
      continue;
    }
    const it = row.item;
    lines.push({
      kind: 'item',
      description: `${it.productName}${it.variantName ? ` · ${it.variantName}` : ''}`,
      descriptionAr: it.productNameAr
        ? `${it.productNameAr}${it.variantName ? ` · ${it.variantName}` : ''}`
        : null,
      sku: it.sku ?? null,
      quantity: it.quantity,
      unitPrice: it.price,
      amount: it.total,
      priceLabel: priceLineLabel(it, 'en'),
      priceLabelAr: priceLineLabel(it, 'ar'),
      listPrice: struckListPrice(it),
    });
  }
  if (order.extraAmount > 0)
    lines.push({
      kind: 'extra',
      description: order.extraAmountNote || 'Additional charge',
      descriptionAr: order.extraAmountNote || 'مبلغ إضافي',
      quantity: 1,
      unitPrice: order.extraAmount,
      amount: order.extraAmount,
    });
  if (order.shipping > 0)
    lines.push({
      kind: 'shipping',
      description: 'Shipping',
      descriptionAr: 'الشحن',
      quantity: 1,
      unitPrice: order.shipping,
      amount: order.shipping,
    });
  if (order.codFee > 0)
    lines.push({
      kind: 'cod_fee',
      description: 'Cash on delivery fee',
      descriptionAr: 'رسوم الدفع عند الاستلام',
      quantity: 1,
      unitPrice: order.codFee,
      amount: order.codFee,
    });
  const coupon = order.couponDiscount ?? 0;
  const promotion = order.promotionDiscount ?? 0;
  const loyalty = order.loyaltyDiscount ?? 0;
  const other = Math.max(0, order.discount - coupon - promotion - loyalty);
  const discounts: FiscalDiscount[] = [];
  if (coupon > 0) discounts.push({ kind: 'coupon', label: order.couponCode, amount: coupon });
  if (promotion > 0)
    discounts.push({
      kind: 'promotion',
      label: order.appliedPromotion?.name ?? null,
      amount: promotion,
    });
  if (loyalty > 0)
    discounts.push({
      kind: 'loyalty',
      label: order.loyaltyPointsRedeemed ? String(order.loyaltyPointsRedeemed) : null,
      amount: loyalty,
    });
  if (other > 0) discounts.push({ kind: 'other', label: null, amount: other });
  return { lines, discounts };
}

const documentBalance = (i: {
  lines: FiscalLine[];
  discounts: FiscalDiscount[];
  vat: number;
  taxIncludedInPrice: boolean;
  total: number;
}): number =>
  i.lines.reduce((n, l) => n + l.amount, 0) -
  i.discounts.reduce((n, d) => n + d.amount, 0) +
  (i.taxIncludedInPrice ? 0 : i.vat) -
  i.total;

// ---- the counter ------------------------------------------------------------------------------------------------------

function allocateSerial(
  db: SyncSql,
  storeId: string,
  docType: SaleDocType | RefundDocType,
  now: number
): number {
  db.run(
    `INSERT INTO fiscal_document_counters (store_id, doc_type, last_serial, updated_at) VALUES (?, ?, 1, ?)
     ON CONFLICT (store_id, doc_type) DO UPDATE SET last_serial = last_serial + 1, updated_at = excluded.updated_at`,
    [storeId, docType, now]
  );
  const serial = Number(
    db.all('SELECT last_serial FROM fiscal_document_counters WHERE store_id = ? AND doc_type = ?', [
      storeId,
      docType,
    ])[0]?.last_serial
  );
  if (!Number.isSafeInteger(serial) || serial < 1)
    throw new MoneyError('FISCAL_SERIAL_FAILED', 'Could not allocate a document number', 500);
  return serial;
}

const json = (v: unknown): Record<string, unknown> | null => {
  try {
    const o = JSON.parse(String(v ?? 'null'));
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const nul = (v: unknown): number | null => (typeof v === 'number' ? v : null);

function loadSaleOrder(db: SyncSql, storeId: string, orderId: string): SaleOrder | null {
  const o = db.all('SELECT * FROM orders WHERE id = ? AND store_id = ?', [orderId, storeId])[0];
  if (!o) return null;
  const items = db
    .all(
      `SELECT i.*, p.name_ar AS product_name_ar FROM order_items i LEFT JOIN products p ON p.id = i.product_id
       WHERE i.order_id = ? ORDER BY i.rowid`,
      [orderId]
    )
    .map(
      (i): SaleItem => ({
        id: i.id as string,
        productName: i.product_name as string,
        variantName: (i.variant_name as string | null) ?? null,
        sku: (i.sku as string | null) ?? null,
        quantity: num(i.quantity),
        price: num(i.price),
        total: num(i.total),
        bundleGroupId: (i.bundle_group_id as string | null) ?? null,
        bundleName: (i.bundle_name as string | null) ?? null,
        bundleNameAr: (i.bundle_name_ar as string | null) ?? null,
        priceSource: (i.price_source as string | null) ?? null,
        priceTierMinQty: nul(i.price_tier_min_qty),
        priceGroupApplied: i.price_group_applied == null ? null : i.price_group_applied === 1,
        listPrice: nul(i.list_price),
        productNameAr: (i.product_name_ar as string | null) ?? null,
      })
    );
  const promo = o.applied_promotion_id
    ? db.all('SELECT name, name_ar FROM promotions WHERE id = ?', [o.applied_promotion_id])[0]
    : undefined;
  const pay = db.all('SELECT provider FROM payments WHERE order_id = ? ORDER BY rowid LIMIT 1', [
    orderId,
  ])[0];
  return {
    orderNumber: o.order_number as string,
    createdAt: num(o.created_at),
    currency: o.currency as string,
    subtotal: num(o.subtotal),
    discount: num(o.discount),
    couponDiscount: num(o.coupon_discount),
    couponCode: (o.coupon_code as string | null) ?? null,
    promotionDiscount: num(o.promotion_discount),
    loyaltyDiscount: num(o.loyalty_discount),
    loyaltyPointsRedeemed: nul(o.loyalty_points_redeemed),
    shipping: num(o.shipping),
    codFee: num(o.cod_fee),
    extraAmount: num(o.extra_amount),
    extraAmountNote: (o.extra_amount_note as string | null) ?? null,
    tax: num(o.tax),
    taxIncludedInPrice: o.tax_included_in_price === 1,
    taxRateBps: nul(o.tax_rate_bps),
    taxableAmount: nul(o.taxable_amount),
    total: num(o.total),
    sellerTaxRegistrationNumber: (o.seller_tax_registration_number as string | null) ?? null,
    sellerTaxLegalName: (o.seller_tax_legal_name as string | null) ?? null,
    shippingAddress: json(o.shipping_address),
    billingAddress: json(o.billing_address),
    appliedPromotion: promo
      ? { name: promo.name as string, nameAr: (promo.name_ar as string | null) ?? null }
      : null,
    items,
    paymentProvider: (pay?.provider as string | undefined) ?? null,
  };
}

function buyerName(order: SaleOrder): string {
  const b = (order.billingAddress ?? order.shippingAddress ?? {}) as Record<string, unknown>;
  const s = (order.shippingAddress ?? {}) as Record<string, unknown>;
  const first = (typeof b.firstName === 'string' && b.firstName) || (s.firstName as string) || '';
  const last = (typeof b.lastName === 'string' && b.lastName) || (s.lastName as string) || '';
  return `${first} ${last}`.trim();
}

interface DocRow {
  id: string;
  doc_type: string;
  serial: number;
  number: string;
  status: string;
  issued_at: number;
  net_amount: number;
  vat_amount: number;
  total_amount: number;
  vat_rate_bps: number | null;
  seller_trn: string | null;
  currency: string;
  payload: string;
  [k: string]: unknown;
}
const saleDoc = (db: SyncSql, storeId: string, orderId: string): DocRow | undefined =>
  db.all(
    `SELECT * FROM fiscal_documents WHERE store_id = ? AND order_id = ? AND doc_type IN ${SALE_TYPES}`,
    [storeId, orderId]
  )[0] as DocRow | undefined;

/**
 * The sale document (tax invoice or receipt) of an order, INSIDE the caller's section. Idempotent: an order already holding a
 * sale document gets that one back. Throws (rolling the section, and with it the order, back) when the document would not
 * balance: an invoice whose lines do not add up is never issued.
 */
export function issueSaleDocument(
  db: SyncSql,
  a: { storeId: string; orderId: string; now: number }
): { id: string; number: string; docType: SaleDocType } {
  const { storeId, orderId, now } = a;
  const existing = saleDoc(db, storeId, orderId);
  if (existing)
    return { id: existing.id, number: existing.number, docType: existing.doc_type as SaleDocType };
  const order = loadSaleOrder(db, storeId, orderId);
  if (!order) throw new MoneyError('ORDER_NOT_FOUND', 'Order not found', 404);
  const store = db.all('SELECT name, address, phone, email FROM store_profile WHERE store_id = ?', [
    storeId,
  ])[0];
  if (!store) throw new MoneyError('STORE_NOT_FOUND', 'Store not found', 404);

  const isTaxInvoice = !!order.sellerTaxRegistrationNumber;
  const docType: SaleDocType = isTaxInvoice ? 'tax_invoice' : 'receipt';
  const { lines, discounts } = buildSaleLines(order);
  const off = documentBalance({
    lines,
    discounts,
    vat: order.tax,
    taxIncludedInPrice: order.taxIncludedInPrice,
    total: order.total,
  });
  if (off !== 0)
    throw new MoneyError(
      'INVOICE_UNBALANCED',
      'The order total does not match its lines; the invoice was not issued',
      500
    );
  const taxable =
    order.taxableAmount ??
    Math.max(
      0,
      order.subtotal -
        order.discount +
        order.shipping +
        order.codFee +
        order.extraAmount -
        (order.taxIncludedInPrice ? order.tax : 0)
    );
  const serial = allocateSerial(db, storeId, docType, now);
  const payload = {
    version: 1,
    orderNumber: order.orderNumber,
    orderDate: new Date(order.createdAt).toISOString(),
    currency: order.currency,
    isTaxInvoice,
    seller: {
      name: store.name as string,
      legalName: order.sellerTaxLegalName,
      trn: order.sellerTaxRegistrationNumber,
      address: (store.address as string | null) ?? null,
      phone: (store.phone as string | null) ?? null,
      email: (store.email as string | null) ?? null,
    },
    // PDPL minimisation (ruling MONEYB-4): only a tax invoice names the buyer and address.
    buyer: isTaxInvoice
      ? {
          name: buyerName(order),
          addressAr: addressLines(order.shippingAddress, 'ar'),
          addressEn: addressLines(order.shippingAddress, 'en'),
        }
      : { name: '', addressAr: [], addressEn: [] },
    lines,
    discounts,
    totals: {
      subtotal: order.subtotal,
      discount: order.discount,
      shipping: order.shipping,
      codFee: order.codFee,
      extra: order.extraAmount,
      taxable,
      vat: order.tax,
      vatRateBps: order.taxRateBps,
      taxIncludedInPrice: order.taxIncludedInPrice,
      total: order.total,
    },
    paymentMethod: order.paymentProvider,
  };
  const id = crypto.randomUUID();
  const number = fiscalNumber(docType, serial);
  db.run(
    `INSERT INTO fiscal_documents (id, store_id, order_id, doc_type, serial, number, issued_at, currency, net_amount, vat_amount, total_amount, vat_rate_bps, seller_trn, payload, retain_until, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      storeId,
      orderId,
      docType,
      serial,
      number,
      now,
      order.currency,
      taxable,
      order.tax,
      order.total,
      order.taxRateBps,
      order.sellerTaxRegistrationNumber,
      JSON.stringify(payload),
      retainUntil(now),
      now,
    ]
  );
  return { id, number, docType };
}

/**
 * Cancel the sale document of an order that never took money. Keeps the number and the document (Art. 37). A no-op (null)
 * when there is none or it is already cancelled.
 */
export function cancelSaleDocument(
  db: SyncSql,
  a: { storeId: string; orderId: string; now: number }
): { number: string } | null {
  const doc = saleDoc(db, a.storeId, a.orderId);
  if (!doc || doc.status === 'cancelled') return null;
  db.run(
    "UPDATE fiscal_documents SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND store_id = ?",
    [a.now, doc.id, a.storeId]
  );
  return { number: doc.number };
}

/**
 * The credit note (tax invoice) or refund receipt (receipt) of a refund. `refundRef` is the idempotency key of the refund
 * event: the same refund never gets two documents. The amount is capped at what is still un-credited on the sale document and
 * its VAT is the sale document's VAT share of that amount (the last credit takes exactly what is left). Null when there is
 * no sale document (legacy order) or nothing is left to credit.
 */
export function issueRefundDocument(
  db: SyncSql,
  a: {
    storeId: string;
    orderId: string;
    refundRef: string;
    amount: number | 'remaining';
    reason?: string | null;
    now: number;
  }
): { number: string; docType: RefundDocType } | null {
  const { storeId, orderId, now } = a;
  const dup = db.all(
    'SELECT number, doc_type FROM fiscal_documents WHERE store_id = ? AND refund_ref = ?',
    [storeId, a.refundRef]
  )[0];
  if (dup) return { number: dup.number as string, docType: dup.doc_type as RefundDocType };
  const sale = saleDoc(db, storeId, orderId);
  if (!sale) return null;
  const prior = db.all(
    `SELECT total_amount, vat_amount FROM fiscal_documents WHERE store_id = ? AND order_id = ? AND doc_type IN ${REFUND_TYPES}`,
    [storeId, orderId]
  );
  const creditedTotal = prior.reduce((n, d) => n + num(d.total_amount), 0);
  const creditedVat = prior.reduce((n, d) => n + num(d.vat_amount), 0);
  const remaining = Math.max(0, sale.total_amount - creditedTotal);
  const requested = a.amount === 'remaining' ? remaining : Math.max(0, a.amount);
  const total = Math.min(requested, remaining);
  if (total <= 0) return null;
  const vat =
    total === remaining
      ? Math.max(0, sale.vat_amount - creditedVat)
      : sale.total_amount > 0
        ? Math.min(
            Math.max(0, sale.vat_amount - creditedVat),
            mulDivRound(total, sale.vat_amount, sale.total_amount)
          )
        : 0;
  const salePayload = JSON.parse(sale.payload) as {
    orderNumber: string;
    seller: unknown;
    buyer?: { name?: string };
  };
  const docType: RefundDocType = sale.doc_type === 'tax_invoice' ? 'credit_note' : 'refund_receipt';
  const serial = allocateSerial(db, storeId, docType, now);
  const payload = {
    version: 1,
    orderNumber: salePayload.orderNumber,
    currency: sale.currency,
    isTaxInvoice: sale.doc_type === 'tax_invoice',
    seller: salePayload.seller,
    buyerName: salePayload.buyer?.name ?? '',
    original: {
      number: sale.number,
      issuedAt: new Date(sale.issued_at).toISOString(),
      total: sale.total_amount,
      vat: sale.vat_amount,
    },
    reason: a.reason ?? null,
    scope: total === sale.total_amount ? 'full' : 'partial',
    totals: { net: total - vat, vat, total, vatRateBps: sale.vat_rate_bps },
  };
  const number = fiscalNumber(docType, serial);
  db.run(
    `INSERT INTO fiscal_documents (id, store_id, order_id, doc_type, serial, number, issued_at, original_document_id, original_number, original_issued_at, currency, net_amount, vat_amount, total_amount, vat_rate_bps, seller_trn, payload, refund_ref, retain_until, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      storeId,
      orderId,
      docType,
      serial,
      number,
      now,
      sale.id,
      sale.number,
      sale.issued_at,
      sale.currency,
      total - vat,
      vat,
      total,
      sale.vat_rate_bps,
      sale.seller_trn,
      JSON.stringify(payload),
      a.refundRef,
      retainUntil(now),
      now,
    ]
  );
  return { number, docType };
}

/**
 * The fiscal step of a WHOLE-order cancel / refund (the `fiscal-document` step of the `order/refunded` fanout, ruling
 * MONEYB-1), inside the reversal's section: a sale that took no money keeps its number, marked cancelled; one that took money
 * gets the credit note (tax invoice) or refund receipt (receipt) for what is left, keyed `order:<id>:full` so a replay issues
 * nothing new. Money was taken when the order is paid / refunded or any payment completed, refunded or was partly refunded.
 */
export function settleFiscalOnReversal(
  db: SyncSql,
  a: { storeId: string; orderId: string; now: number }
): void {
  const o = db.all('SELECT payment_status FROM orders WHERE id = ? AND store_id = ?', [
    a.orderId,
    a.storeId,
  ])[0];
  if (!o) return;
  const pays = db.all(
    'SELECT status, refunded_amount, metadata FROM payments WHERE order_id = ? ORDER BY created_at DESC, rowid DESC',
    [a.orderId]
  );
  const taken =
    o.payment_status === 'paid' ||
    o.payment_status === 'refunded' ||
    pays.some(
      p =>
        p.status === 'completed' ||
        p.status === 'refunded' ||
        p.status === 'partially_refunded' ||
        num(p.refunded_amount) > 0
    );
  if (!taken) {
    cancelSaleDocument(db, a);
    return;
  }
  const reason = (json(pays[0]?.metadata)?.refundReason as string | undefined) ?? null;
  issueRefundDocument(db, {
    ...a,
    refundRef: `order:${a.orderId}:full`,
    amount: 'remaining',
    reason: typeof reason === 'string' ? reason : null,
  });
}
