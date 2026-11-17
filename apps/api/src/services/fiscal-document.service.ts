import { prisma, type Prisma } from '@ebda/database';
import { RETENTION_YEARS } from '../config/retention';
import { priceLineLabel, struckListPrice } from '../lib/order-pricing';
import { groupOrderLinesForDisplay, mulDivRound, orderAddressLines } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { storeDb } from '../lib/repo-factory';

/**
 * Fiscal documents (rulings MONEYB-1, MONEYB-4).
 *
 * - Every sale gets ONE sale document at creation: a TAX INVOICE when the order
 *   froze a verified seller TRN (ruling TAX-2), otherwise a plain RECEIPT.
 * - Every refund (full or partial) of a sale that took money gets its own
 *   CREDIT NOTE (of a tax invoice) or REFUND RECEIPT (of a receipt), with its
 *   own serial, naming the original number and date (VAT Exec. Regs Art. 11;
 *   ETA credit-note `references`).
 * - A sale cancelled before any money was taken keeps its number, marked
 *   `cancelled` (UTPL 206/2020 Art. 37: cancelled originals are kept).
 *
 * Numbering: one gap-free counter per (store, document type), bumped with a
 * single upsert INSIDE the transaction that writes the document, so the number
 * and the document commit or roll back together. Never the random order number.
 *
 * Documents are immutable (DB trigger) and have no FK to stores/orders, so a
 * store deletion leaves them in place for 7 years (`retain_until`).
 */

export type FiscalDocTypeValue =
  | 'tax_invoice'
  | 'receipt'
  | 'credit_note'
  | 'refund_receipt'
  | 'order_record'
  | 'billing_record';

export const FISCAL_NUMBER_PREFIX: Record<
  'tax_invoice' | 'receipt' | 'credit_note' | 'refund_receipt',
  string
> = {
  tax_invoice: 'INV',
  receipt: 'RCT',
  credit_note: 'CRN',
  refund_receipt: 'RFR',
};

/** 7 years from the order date (Ruling RETENTION-1; the legal minimum is 5, see config/retention.ts). */
export const FISCAL_RETENTION_YEARS = RETENTION_YEARS; // Ruling RETENTION-1: one constant (config/retention.ts)

export function fiscalNumber(docType: keyof typeof FISCAL_NUMBER_PREFIX, serial: number): string {
  return `${FISCAL_NUMBER_PREFIX[docType]}-${String(serial).padStart(6, '0')}`;
}

export function retainUntil(issuedAt: Date): Date {
  const d = new Date(issuedAt);
  d.setUTCFullYear(d.getUTCFullYear() + FISCAL_RETENTION_YEARS);
  return d;
}

/** One printed line of a document. `amount` is the line total in minor units. */
export interface FiscalLine {
  kind: 'item' | 'bundle' | 'shipping' | 'cod_fee' | 'extra';
  description: string;
  descriptionAr?: string | null;
  sku?: string | null;
  quantity: number;
  unitPrice: number | null;
  amount: number;
  /** B2B: tier / wholesale label and the struck-through retail price, from the line's persisted snapshot. */
  priceLabel?: string | null;
  priceLabelAr?: string | null;
  listPrice?: number | null;
}

export interface FiscalDiscount {
  kind: 'coupon' | 'promotion' | 'loyalty' | 'other';
  label: string | null;
  amount: number;
}

export interface SaleDocumentPayload {
  version: 1;
  orderNumber: string;
  orderDate: string;
  currency: string;
  isTaxInvoice: boolean;
  seller: {
    name: string;
    legalName: string | null;
    trn: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
  };
  buyer: {
    name: string;
    /** Address lines as printed (Arabic and English renderings). */
    addressAr: string[];
    addressEn: string[];
  };
  lines: FiscalLine[];
  discounts: FiscalDiscount[];
  totals: {
    subtotal: number;
    discount: number;
    shipping: number;
    codFee: number;
    extra: number;
    taxable: number;
    vat: number;
    vatRateBps: number | null;
    taxIncludedInPrice: boolean;
    total: number;
  };
  paymentMethod: string | null;
}

export interface RefundDocumentPayload {
  version: 1;
  orderNumber: string;
  currency: string;
  isTaxInvoice: boolean;
  seller: SaleDocumentPayload['seller'];
  buyerName: string;
  original: { number: string; issuedAt: string; total: number; vat: number };
  reason: string | null;
  scope: 'full' | 'partial';
  totals: { net: number; vat: number; total: number; vatRateBps: number | null };
}

type SaleOrder = Prisma.OrderGetPayload<{
  include: {
    items: { include: { product: { select: { nameAr: true } } } };
    appliedPromotion: { select: { name: true; nameAr: true } };
    payments: { select: { provider: true; method: true }; take: 1 };
  };
}>;

/**
 * The lines + totals a sale document prints, built from the frozen order.
 * Invariant (asserted by `assertBalanced`): Σ lines − Σ discounts + VAT (when
 * exclusive) === total. Wallet spend is a payment, not a line.
 */
export function buildSaleLines(order: {
  items: SaleOrder['items'];
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
  appliedPromotion: { name: string; nameAr: string | null } | null;
}): { lines: FiscalLine[]; discounts: FiscalDiscount[] } {
  const lines: FiscalLine[] = groupOrderLinesForDisplay(order.items).map(row => {
    if (row.kind === 'bundle') {
      return {
        kind: 'bundle' as const,
        description: row.name,
        descriptionAr: row.nameAr ?? null,
        quantity: row.quantity,
        unitPrice: null,
        // The component lines' own totals (what the order charged), not the
        // display re-multiplication of the allocated unit price.
        amount: (row.lines as SaleOrder['items']).reduce((n, l) => n + l.total, 0),
      };
    }
    const it = row.item as SaleOrder['items'][number];
    return {
      kind: 'item' as const,
      description: `${it.productName}${it.variantName ? ` · ${it.variantName}` : ''}`,
      descriptionAr: it.product?.nameAr
        ? // RC1: the Arabic line carries the Arabic variant title the order saved (falls back to the canonical one)
          `${it.product.nameAr}${it.variantNameAr || it.variantName ? ` · ${it.variantNameAr || it.variantName}` : ''}`
        : null,
      sku: it.sku ?? null,
      quantity: it.quantity,
      unitPrice: it.price,
      amount: it.total,
      priceLabel: priceLineLabel(it, 'en'),
      priceLabelAr: priceLineLabel(it, 'ar'),
      listPrice: struckListPrice(it),
    };
  });
  if (order.extraAmount > 0) {
    lines.push({
      kind: 'extra',
      description: order.extraAmountNote || 'Additional charge',
      descriptionAr: order.extraAmountNote || 'مبلغ إضافي',
      quantity: 1,
      unitPrice: order.extraAmount,
      amount: order.extraAmount,
    });
  }
  if (order.shipping > 0) {
    lines.push({
      kind: 'shipping',
      description: 'Shipping',
      descriptionAr: 'الشحن',
      quantity: 1,
      unitPrice: order.shipping,
      amount: order.shipping,
    });
  }
  if (order.codFee > 0) {
    lines.push({
      kind: 'cod_fee',
      description: 'Cash on delivery fee',
      descriptionAr: 'رسوم الدفع عند الاستلام',
      quantity: 1,
      unitPrice: order.codFee,
      amount: order.codFee,
    });
  }
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

/** Lines − discounts (+ VAT when exclusive) must equal the order total. */
export function documentBalance(input: {
  lines: FiscalLine[];
  discounts: FiscalDiscount[];
  vat: number;
  taxIncludedInPrice: boolean;
  total: number;
}): number {
  const lineSum = input.lines.reduce((n, l) => n + l.amount, 0);
  const discountSum = input.discounts.reduce((n, d) => n + d.amount, 0);
  const computed = lineSum - discountSum + (input.taxIncludedInPrice ? 0 : input.vat);
  return computed - input.total;
}

async function allocateSerial(
  tx: Prisma.TransactionClient,
  storeId: string,
  docType: keyof typeof FISCAL_NUMBER_PREFIX
): Promise<number> {
  // One statement: the row lock taken by ON CONFLICT DO UPDATE serialises
  // concurrent issuers of the same series until this transaction ends, and a
  // rollback un-does the bump — no gaps, no duplicates.
  const rows = await tx.$queryRaw<Array<{ last_serial: number }>>`
    INSERT INTO public.fiscal_document_counters (store_id, doc_type, last_serial, updated_at)
    VALUES (${storeId}, ${docType}::"FiscalDocType", 1, now())
    ON CONFLICT (store_id, doc_type)
    DO UPDATE SET last_serial = public.fiscal_document_counters.last_serial + 1, updated_at = now()
    RETURNING last_serial`;
  const serial = Number(rows[0]?.last_serial);
  if (!Number.isSafeInteger(serial) || serial < 1) {
    throw new AppError(500, 'FISCAL_SERIAL_FAILED', 'Could not allocate a document number');
  }
  return serial;
}

const SALE_TYPES = ['tax_invoice', 'receipt'] as const;
const REFUND_TYPES = ['credit_note', 'refund_receipt'] as const;

function sellerOf(
  store: {
    name: string;
    address: string | null;
    phone: string | null;
    email: string | null;
  },
  order: { sellerTaxRegistrationNumber: string | null; sellerTaxLegalName: string | null }
): SaleDocumentPayload['seller'] {
  return {
    name: store.name,
    legalName: order.sellerTaxLegalName,
    trn: order.sellerTaxRegistrationNumber,
    address: store.address,
    phone: store.phone,
    email: store.email,
  };
}

function buyerName(order: { shippingAddress: unknown; billingAddress: unknown }): string {
  const b = (order.billingAddress ?? order.shippingAddress ?? {}) as Record<string, unknown>;
  const s = (order.shippingAddress ?? {}) as Record<string, unknown>;
  const first = (typeof b.firstName === 'string' && b.firstName) || (s.firstName as string) || '';
  const last = (typeof b.lastName === 'string' && b.lastName) || (s.lastName as string) || '';
  return `${first} ${last}`.trim();
}

export class FiscalDocumentService {
  /**
   * Issue the sale document (tax invoice or receipt) for an order, inside the
   * caller's transaction. Idempotent: an order already holding a sale document
   * gets that one back. Throws (rolling the order back) if the document would
   * not balance — an invoice whose lines do not add up is never issued.
   */
  static async issueSaleDocument(tx: Prisma.TransactionClient, storeId: string, orderId: string) {
    const existing = await tx.fiscalDocument.findFirst({
      where: { storeId, orderId, docType: { in: [...SALE_TYPES] } },
    });
    if (existing) return existing;

    const order = (await tx.order.findFirst({
      where: { id: orderId, storeId },
      include: {
        items: { include: { product: { select: { nameAr: true } } } },
        appliedPromotion: { select: { name: true, nameAr: true } },
        payments: { select: { provider: true, method: true }, take: 1 },
      },
    })) as SaleOrder | null;
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    const store = await tx.store.findUnique({
      where: { id: storeId },
      select: { name: true, address: true, phone: true, email: true },
    });
    if (!store) throw new AppError(404, 'NOT_FOUND', 'Store not found');

    const isTaxInvoice = !!order.sellerTaxRegistrationNumber;
    const docType = isTaxInvoice ? 'tax_invoice' : 'receipt';
    const { lines, discounts } = buildSaleLines(order);
    const off = documentBalance({
      lines,
      discounts,
      vat: order.tax,
      taxIncludedInPrice: order.taxIncludedInPrice,
      total: order.total,
    });
    if (off !== 0) {
      logger.error(
        { storeId, orderId, off, total: order.total },
        '[FISCAL] sale document does not balance — refusing to issue'
      );
      throw new AppError(
        500,
        'INVOICE_UNBALANCED',
        'The order total does not match its lines; the invoice was not issued'
      );
    }
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
    const issuedAt = new Date();
    const serial = await allocateSerial(tx, storeId, docType);
    const shipping = order.shippingAddress as Record<string, unknown> | null;
    const payload: SaleDocumentPayload = {
      version: 1,
      orderNumber: order.orderNumber,
      orderDate: order.createdAt.toISOString(),
      currency: order.currency,
      isTaxInvoice,
      seller: sellerOf(store, order),
      // PDPL minimisation (ruling MONEYB-4): a tax invoice must name the buyer
      // and address (UTPL Art. 37); a plain consumer receipt does not, so its
      // archived copy carries no buyer data at all.
      buyer: isTaxInvoice
        ? {
            name: buyerName(order),
            addressAr: orderAddressLines(shipping, 'ar'),
            addressEn: orderAddressLines(shipping, 'en'),
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
      paymentMethod: order.payments[0]?.provider ?? null,
    };
    return tx.fiscalDocument.create({
      data: {
        storeId,
        orderId,
        docType,
        serial,
        number: fiscalNumber(docType, serial),
        issuedAt,
        currency: order.currency,
        netAmount: taxable,
        vatAmount: order.tax,
        totalAmount: order.total,
        vatRateBps: order.taxRateBps,
        sellerTrn: order.sellerTaxRegistrationNumber,
        payload: payload as unknown as Prisma.InputJsonValue,
        retainUntil: retainUntil(issuedAt),
      },
    });
  }

  /** The order's sale document, if one was issued (legacy orders have none). */
  static async saleDocumentFor(storeId: string, orderId: string) {
    return (await storeDb(storeId)).fiscalDocument.findFirst({
      where: { storeId, orderId, docType: { in: [...SALE_TYPES] } },
    });
  }

  /** Every document of an order (sale first, then refunds in issue order). */
  static async documentsForOrder(storeId: string, orderId: string) {
    return (await storeDb(storeId)).fiscalDocument.findMany({
      where: { storeId, orderId },
      orderBy: [{ issuedAt: 'asc' }, { serial: 'asc' }],
      select: {
        id: true,
        docType: true,
        number: true,
        status: true,
        issuedAt: true,
        cancelledAt: true,
        originalNumber: true,
        netAmount: true,
        vatAmount: true,
        totalAmount: true,
        currency: true,
      },
    });
  }

  /**
   * Cancel the sale document of an order that never took money. Keeps the
   * number and the document (Art. 37). No-op when there is none or it is
   * already cancelled.
   */
  static async cancelSaleDocument(tx: Prisma.TransactionClient, storeId: string, orderId: string) {
    const doc = await tx.fiscalDocument.findFirst({
      where: { storeId, orderId, docType: { in: [...SALE_TYPES] } },
      select: { id: true, status: true },
    });
    if (!doc || doc.status === 'cancelled') return null;
    return tx.fiscalDocument.update({
      where: { id: doc.id, storeId },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
  }

  /**
   * Issue the credit note (tax invoice) or refund receipt (receipt) for a
   * refund, inside the caller's transaction. `refundRef` is the idempotency
   * key of the refund event (a Return id, `refund:<providerRefundId>`, or
   * `order:<id>:full`): the same refund never gets two documents. The amount is
   * capped at what is still un-credited on the sale document, and its VAT is
   * the sale document's VAT share of that amount.
   *
   * Returns null when there is no sale document (legacy order) or nothing is
   * left to credit.
   */
  static async issueRefundDocument(
    tx: Prisma.TransactionClient,
    storeId: string,
    orderId: string,
    input: { refundRef: string; amount: number | 'remaining'; reason?: string | null }
  ) {
    const dup = await tx.fiscalDocument.findFirst({
      where: { storeId, refundRef: input.refundRef },
    });
    if (dup) return dup;
    const sale = await tx.fiscalDocument.findFirst({
      where: { storeId, orderId, docType: { in: [...SALE_TYPES] } },
    });
    if (!sale) return null;
    const prior = await tx.fiscalDocument.findMany({
      where: { storeId, orderId, docType: { in: [...REFUND_TYPES] } },
      select: { totalAmount: true, vatAmount: true },
    });
    const creditedTotal = prior.reduce((n, d) => n + d.totalAmount, 0);
    const creditedVat = prior.reduce((n, d) => n + d.vatAmount, 0);
    const remaining = Math.max(0, sale.totalAmount - creditedTotal);
    const requested = input.amount === 'remaining' ? remaining : Math.max(0, input.amount);
    const total = Math.min(requested, remaining);
    if (total <= 0) return null;
    // The VAT inside this refund = the sale's VAT share of it; the last credit
    // takes exactly what is left so the notes sum to the invoice's VAT.
    const vat =
      total === remaining
        ? Math.max(0, sale.vatAmount - creditedVat)
        : sale.totalAmount > 0
          ? Math.min(
              Math.max(0, sale.vatAmount - creditedVat),
              mulDivRound(total, sale.vatAmount, sale.totalAmount)
            )
          : 0;
    const salePayload = sale.payload as unknown as SaleDocumentPayload;
    const docType = sale.docType === 'tax_invoice' ? 'credit_note' : 'refund_receipt';
    const serial = await allocateSerial(tx, storeId, docType);
    const issuedAt = new Date();
    const payload: RefundDocumentPayload = {
      version: 1,
      orderNumber: salePayload.orderNumber,
      currency: sale.currency,
      isTaxInvoice: sale.docType === 'tax_invoice',
      seller: salePayload.seller,
      buyerName: salePayload.buyer?.name ?? '',
      original: {
        number: sale.number!,
        issuedAt: sale.issuedAt.toISOString(),
        total: sale.totalAmount,
        vat: sale.vatAmount,
      },
      reason: input.reason ?? null,
      scope: total === sale.totalAmount ? 'full' : 'partial',
      totals: { net: total - vat, vat, total, vatRateBps: sale.vatRateBps },
    };
    return tx.fiscalDocument.create({
      data: {
        storeId,
        orderId,
        docType,
        serial,
        number: fiscalNumber(docType, serial),
        issuedAt,
        originalDocumentId: sale.id,
        originalNumber: sale.number,
        originalIssuedAt: sale.issuedAt,
        currency: sale.currency,
        netAmount: total - vat,
        vatAmount: vat,
        totalAmount: total,
        vatRateBps: sale.vatRateBps,
        sellerTrn: sale.sellerTrn,
        payload: payload as unknown as Prisma.InputJsonValue,
        refundRef: input.refundRef,
        retainUntil: retainUntil(issuedAt),
      },
    });
  }

  /** Paged list for the merchant's Invoices page. */
  static async list(
    storeId: string,
    opts: { cursor?: string; limit?: number; docType?: FiscalDocTypeValue; q?: string } = {}
  ) {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
    const rows = await (
      await storeDb(storeId)
    ).fiscalDocument.findMany({
      where: {
        storeId,
        ...(opts.docType ? { docType: opts.docType } : {}),
        // Document numbers are issued upper-case (INV-000042), so an upper-cased substring needs no case-insensitive mode.
        ...(opts.q
          ? {
              OR: [
                { number: { contains: opts.q.toUpperCase() } },
                { originalNumber: { contains: opts.q.toUpperCase() } },
              ],
            }
          : {}),
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        orderId: true,
        docType: true,
        number: true,
        status: true,
        issuedAt: true,
        cancelledAt: true,
        originalNumber: true,
        netAmount: true,
        vatAmount: true,
        totalAmount: true,
        currency: true,
        payload: true,
      },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      documents: page.map(({ payload, ...d }) => ({
        ...d,
        orderNumber: (payload as { orderNumber?: string } | null)?.orderNumber ?? null,
      })),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  static async getById(storeId: string, id: string) {
    const doc = await (await storeDb(storeId)).fiscalDocument.findFirst({ where: { id, storeId } });
    if (!doc) throw new AppError(404, 'NOT_FOUND', 'Document not found');
    return doc;
  }
}
