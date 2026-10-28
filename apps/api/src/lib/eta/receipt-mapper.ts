import { receiptUuid, type Json } from './serialize';
import type { EtaSeller } from '@ebda/shared';

/**
 * Order -> ETA Receipt v1.2 (sale, `documentType.receiptType = "s"`) and Return Receipt v1.2 (`"r"`).
 * Field names, lengths and rules: https://sdk.invoicing.eta.gov.eg/documents/receipt-v1-2/ and
 * https://sdk.invoicing.eta.gov.eg/documents/return-receipt-v1-2/ (read 2026-10-26). Payment codes:
 * https://sdk.invoicing.eta.gov.eg/codes/payment-methods/ ; VAT = tax type T1, subtype V009
 * "General Item sales" (https://sdk.invoicing.eta.gov.eg/codes/tax-types/); unit EA (unit-types).
 *
 * Pure and integer-exact: money is piastres until the last step. The mapper REFUSES (throws
 * EtaMapError with a stable code) when it cannot produce a receipt whose totalAmount equals what
 * the customer was charged, instead of submitting a document ETA or the customer would dispute.
 */
export class EtaMapError extends Error {
  constructor(
    public readonly code:
      | 'ETA_UNSUPPORTED_CURRENCY'
      | 'ETA_TOTAL_MISMATCH'
      | 'ETA_BUYER_ID_REQUIRED'
      | 'ETA_NO_LINES'
      | 'ETA_NO_ITEM_CODE'
      | 'ETA_RETURN_EXCEEDS'
      | 'ETA_RETURN_TOTAL_MISMATCH',
    message: string
  ) {
    super(message);
  }
}

export interface EtaOrderItem {
  id: string;
  productId: string;
  productName: string;
  sku: string | null;
  quantity: number;
  /** piastres, the line total (quantity * unit), tax-exclusive on exclusive orders. */
  total: number;
}
export interface EtaOrderInput {
  orderNumber: string;
  createdAt: Date;
  currency: string;
  /** piastres */
  discount: number;
  shipping: number;
  codFee: number;
  extraAmount: number;
  tax: number;
  total: number;
  taxableAmount: number | null;
  taxRateBps: number | null;
  /** 'cod' | 'card' | provider name ... */
  paymentProvider: string | null;
  buyer: { name: string; mobile: string | null; nationalId?: string | null };
  items: EtaOrderItem[];
}

/** ETA's configured threshold above which a person buyer must be identified: 150,000 EGP (receipt-v1-2). */
export const ETA_BUYER_ID_THRESHOLD_PIASTRES = 150_000 * 100;

const EGP = (p: number): number => p / 100;
const round5 = (n: number): number => Math.round(n * 1e5) / 1e5;
/** ETA time: UTC, seconds precision, same text in the header and the QR URL. */
export const etaTime = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Largest-remainder split of `total` by `weights`; the parts always sum to `total`. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (sum <= 0) {
    const out = weights.map(() => 0);
    out[0] = total;
    return out;
  }
  const raw = weights.map(w => (total * w) / sum);
  const base = raw.map(Math.floor);
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) base[order[k].i] += 1;
  return base;
}

function paymentCode(provider: string | null): string {
  const p = (provider ?? '').toLowerCase();
  if (p === 'cod' || p.includes('cash')) return 'C';
  if (['paymob', 'kashier', 'fawry', 'paysky', 'geidea', 'opay', 'card'].some(x => p.includes(x)))
    return 'V';
  return 'O';
}

export interface BuildReceiptArgs {
  order: EtaOrderInput;
  seller: EtaSeller;
  defaultItemCode: string;
  previousUuid: string;
  /** Receipt number; unique per branch within a submission. */
  receiptNumber: string;
  issuedAt: Date;
  /** Re-issue of a refused receipt: ETA links the corrected document through this header field. */
  referenceOldUuid?: string;
}

interface Line {
  internalCode: string;
  description: string;
  quantity: number;
  net: number;
  disc: number;
  tax: number;
}

export function buildSaleReceipt(a: BuildReceiptArgs) {
  const { order, seller } = a;
  if (order.currency !== 'EGP')
    throw new EtaMapError('ETA_UNSUPPORTED_CURRENCY', `currency ${order.currency} is not EGP`);
  if (!a.defaultItemCode) throw new EtaMapError('ETA_NO_ITEM_CODE', 'no registered EGS item code');
  if (order.items.length === 0) throw new EtaMapError('ETA_NO_LINES', 'order has no lines');
  if (
    order.total >= ETA_BUYER_ID_THRESHOLD_PIASTRES &&
    !(order.buyer.nationalId && order.buyer.name)
  )
    throw new EtaMapError('ETA_BUYER_ID_REQUIRED', 'buyer id and name are required at this total');

  // Components: goods lines (after their share of the discount), then the fee lines.
  const goodsGross = order.items.map(i => i.total);
  const discAlloc = allocate(
    Math.min(
      order.discount,
      goodsGross.reduce((x, y) => x + y, 0)
    ),
    goodsGross
  );
  const fees: Array<{ code: string; description: string; amount: number }> = [
    { code: 'SHIPPING', description: 'Shipping', amount: order.shipping },
    { code: 'COD-FEE', description: 'Cash on delivery fee', amount: order.codFee },
    {
      code: 'EXTRA',
      description: order.extraAmount ? 'Additional charge' : '',
      amount: order.extraAmount,
    },
  ].filter(f => f.amount > 0);
  const weights = [...goodsGross.map((g, i) => g - discAlloc[i]), ...fees.map(f => f.amount)];
  const W = weights.reduce((x, y) => x + y, 0);
  const E = order.taxableAmount ?? order.total - order.tax; // tax-exclusive base
  const nets = allocate(E, weights);
  const taxes = allocate(order.tax, nets);
  const scale = W > 0 ? E / W : 1;

  const lines: Line[] = [
    ...order.items.map((it, i) => ({
      internalCode: (it.sku || it.productId).slice(0, 50),
      description: it.productName.slice(0, 500),
      quantity: it.quantity,
      net: nets[i],
      disc: Math.round(discAlloc[i] * scale),
      tax: taxes[i],
    })),
    ...fees.map((f, k) => ({
      internalCode: f.code,
      description: f.description,
      quantity: 1,
      net: nets[order.items.length + k],
      disc: 0,
      tax: taxes[order.items.length + k],
    })),
  ];

  const totalAmountP = lines.reduce((s, l) => s + l.net + l.tax, 0);
  if (totalAmountP !== order.total)
    throw new EtaMapError(
      'ETA_TOTAL_MISMATCH',
      `receipt total ${totalAmountP} != order total ${order.total}`
    );

  const rateBps = order.taxRateBps ?? 0;
  const itemData = lines.map(l => {
    const totalSale = l.net + l.disc;
    const item: { [k: string]: Json } = {
      internalCode: l.internalCode,
      description: l.description,
      itemType: 'EGS',
      itemCode: a.defaultItemCode,
      unitType: 'EA',
      quantity: l.quantity,
      unitPrice: round5(EGP(totalSale) / l.quantity),
      netSale: EGP(l.net),
      totalSale: EGP(totalSale),
      total: EGP(l.net + l.tax),
    };
    if (l.disc > 0)
      item.commercialDiscountData = [{ amount: EGP(l.disc), description: 'discount' }];
    if (order.tax > 0)
      item.taxableItems = [
        { taxType: 'T1', amount: EGP(l.tax), subType: 'V009', rate: rateBps / 100 },
      ];
    return item;
  });

  const totalSales = lines.reduce((s, l) => s + l.net + l.disc, 0);
  const totalDisc = lines.reduce((s, l) => s + l.disc, 0);
  const doc: { [k: string]: Json } & { header: { [k: string]: Json; uuid: string } } = {
    header: {
      dateTimeIssued: etaTime(a.issuedAt),
      receiptNumber: a.receiptNumber.slice(0, 50),
      uuid: '',
      previousUUID: a.previousUuid,
      currency: 'EGP',
      ...(a.referenceOldUuid ? { referenceOldUUID: a.referenceOldUuid } : {}),
    },
    documentType: { receiptType: 's', typeVersion: '1.2' },
    seller: sellerBlock(seller),
    buyer: buyerBlock(order),
    itemData,
    totalSales: EGP(totalSales),
    ...(totalDisc > 0 ? { totalCommercialDiscount: EGP(totalDisc) } : {}),
    netAmount: EGP(lines.reduce((s, l) => s + l.net, 0)),
    totalAmount: EGP(totalAmountP),
    ...(order.tax > 0 ? { taxTotals: [{ taxType: 'T1', amount: EGP(order.tax) }] } : {}),
    paymentMethod: paymentCode(order.paymentProvider),
  };
  doc.header.uuid = receiptUuid(doc);
  return doc;
}

function sellerBlock(s: EtaSeller): Json {
  return {
    rin: s.rin,
    companyTradeName: s.companyTradeName.slice(0, 200),
    branchCode: s.branchCode,
    branchAddress: {
      country: 'EG',
      governate: s.address.governate,
      regionCity: s.address.regionCity,
      street: s.address.street,
      buildingNumber: s.address.buildingNumber,
      ...(s.address.postalCode ? { postalCode: s.address.postalCode } : {}),
    },
    deviceSerialNumber: s.deviceSerialNumber,
    activityCode: s.activityCode,
  };
}

function buyerBlock(order: EtaOrderInput): Json {
  const b = order.buyer;
  return {
    type: 'P',
    ...(b.nationalId ? { id: b.nationalId } : {}),
    ...(b.name ? { name: b.name.slice(0, 100) } : {}),
    ...(b.mobile ? { mobileNumber: b.mobile.slice(0, 30) } : {}),
  };
}

export interface LineQty {
  orderItemId: string;
  quantity: number;
}

type SaleDoc = { [k: string]: Json } & { header: { [k: string]: Json; uuid: string } };

const toP = (egp: unknown): number => Math.round(Number(egp) * 100);

/**
 * Return Receipt v1.2 (`receiptType "r"`, `referenceUUID` = the sale) for part or all of a sale, built from
 * the SALE DOCUMENT's own lines so the returned amounts always agree with what was receipted.
 *
 *  - `saleLines`   the sale's goods lines, aligned with `sale.itemData` (index i <-> saleLines[i]).
 *  - `alreadyReturned`  quantity per orderItemId on earlier return receipts that were not refused.
 *  - `returned`    what THIS receipt returns. A line's value is proportional to the units returned and
 *    cumulative (value(cum) - value(cumBefore), rounded in piastres) so the pieces of several partial
 *    returns add up to exactly the sale line.
 *  - `includeFees` also return the non-goods lines (shipping, COD fee, extra charge): only on a
 *    whole-order refund that has no earlier whole-order return.
 * Throws EtaMapError('ETA_RETURN_EXCEEDS') when more units are returned than were sold and not yet returned.
 */
export function buildReturnReceipt(a: {
  sale: SaleDoc;
  saleLines: LineQty[];
  alreadyReturned: Record<string, number>;
  returned: LineQty[];
  includeFees: boolean;
  previousUuid: string;
  receiptNumber: string;
  issuedAt: Date;
  referenceOldUuid?: string;
}) {
  const sale = JSON.parse(JSON.stringify(a.sale)) as SaleDoc;
  const lines = sale.itemData as Array<{ [k: string]: Json }>;
  const want = new Map(a.returned.map(r => [r.orderItemId, r.quantity]));
  const out: Array<{ [k: string]: Json }> = [];
  const piece = (value: number, cum: number, before: number, q: number) =>
    Math.round((value * cum) / q) - Math.round((value * before) / q);

  a.saleLines.forEach((sl, i) => {
    const take = want.get(sl.orderItemId) ?? 0;
    if (take <= 0) return;
    const before = a.alreadyReturned[sl.orderItemId] ?? 0;
    if (before + take > sl.quantity)
      throw new EtaMapError(
        'ETA_RETURN_EXCEEDS',
        `returning ${take} of line ${i} exceeds what was sold`
      );
    out.push(scaleLine(lines[i], sl.quantity, before, before + take, take, piece));
  });
  if (a.includeFees)
    for (let i = a.saleLines.length; i < lines.length; i++)
      out.push(scaleLine(lines[i], 1, 0, 1, 1, piece));
  if (out.length === 0) throw new EtaMapError('ETA_NO_LINES', 'nothing left to return');

  const sum = (k: string) => out.reduce((t, l) => t + toP(l[k]), 0);
  const tax = out.reduce(
    (t, l) =>
      t +
      (Array.isArray(l.taxableItems) ? toP((l.taxableItems[0] as { amount: number }).amount) : 0),
    0
  );
  const disc = out.reduce(
    (t, l) =>
      t +
      (Array.isArray(l.commercialDiscountData)
        ? toP((l.commercialDiscountData[0] as { amount: number }).amount)
        : 0),
    0
  );
  const doc: SaleDoc = {
    header: {
      dateTimeIssued: etaTime(a.issuedAt),
      receiptNumber: a.receiptNumber.slice(0, 50),
      uuid: '',
      previousUUID: a.previousUuid,
      referenceUUID: a.sale.header.uuid,
      salesIssuedDateTime: a.sale.header.dateTimeIssued,
      currency: 'EGP',
      ...(a.referenceOldUuid ? { referenceOldUUID: a.referenceOldUuid } : {}),
    },
    documentType: { receiptType: 'r', typeVersion: '1.2' },
    seller: sale.seller,
    buyer: sale.buyer,
    itemData: out,
    totalSales: sum('totalSale') / 100,
    ...(disc > 0 ? { totalCommercialDiscount: disc / 100 } : {}),
    netAmount: sum('netSale') / 100,
    totalAmount: sum('total') / 100,
    ...(tax > 0 ? { taxTotals: [{ taxType: 'T1', amount: tax / 100 }] } : {}),
    paymentMethod: sale.paymentMethod,
  };
  doc.header.uuid = receiptUuid(doc);
  return doc;
}

function scaleLine(
  line: { [k: string]: Json },
  soldQty: number,
  before: number,
  cum: number,
  take: number,
  piece: (value: number, cum: number, before: number, q: number) => number
): { [k: string]: Json } {
  const net = piece(toP(line.netSale), cum, before, soldQty);
  const totalSale = piece(toP(line.totalSale), cum, before, soldQty);
  const total = piece(toP(line.total), cum, before, soldQty);
  const out: { [k: string]: Json } = {
    ...line,
    quantity: take,
    unitPrice: round5(totalSale / 100 / take),
    netSale: net / 100,
    totalSale: totalSale / 100,
    total: total / 100,
  };
  const d = Array.isArray(line.commercialDiscountData)
    ? (line.commercialDiscountData[0] as { amount: number; description: string })
    : null;
  if (d) {
    const amt = piece(toP(d.amount), cum, before, soldQty);
    if (amt > 0) out.commercialDiscountData = [{ amount: amt / 100, description: d.description }];
    else delete out.commercialDiscountData;
  }
  const t = Array.isArray(line.taxableItems)
    ? (line.taxableItems[0] as { taxType: string; amount: number; subType: string; rate: number })
    : null;
  if (t) out.taxableItems = [{ ...t, amount: piece(toP(t.amount), cum, before, soldQty) / 100 }];
  return out;
}

/**
 * Return Receipt Without Reference v1.2 (`receiptType "RWR"`) for a PRICE-ONLY refund: money went back
 * (provider-dashboard or partial-amount refund) with no goods lines to return. One synthetic line carries
 * the refunded amount, split into net and VAT at the sale's own rate. `documentUseReason` is mandatory and
 * is one of the ETA reason codes (`ETA_RETURN_NO_REF_REASONS`); `salesIssuedDateTime` is mandatory; the
 * sale uuid is NOT sent as `referenceUUID` (the type exists for sales the ETA cannot reference).
 * Source: https://sdk.invoicing.eta.gov.eg/documents/return-receipt-without-reference-v1-2/ (read 2026-10-26).
 */
export function buildReturnWithoutReference(a: {
  sale: SaleDoc;
  /** piastres actually refunded (tax-inclusive) */
  refundAmount: number;
  reason: 'I' | 'B';
  previousUuid: string;
  receiptNumber: string;
  issuedAt: Date;
  referenceOldUuid?: string;
}) {
  if (!(a.refundAmount > 0)) throw new EtaMapError('ETA_NO_LINES', 'nothing was refunded');
  const sale = JSON.parse(JSON.stringify(a.sale)) as SaleDoc;
  const template = (sale.itemData as Array<{ [k: string]: Json }>)[0];
  const tax0 = Array.isArray(template.taxableItems)
    ? (template.taxableItems[0] as { rate: number })
    : null;
  const bps = tax0 ? Math.round(Number(tax0.rate) * 100) : 0;
  const net = bps > 0 ? Math.round((a.refundAmount * 10000) / (10000 + bps)) : a.refundAmount;
  const tax = a.refundAmount - net;
  const line: { [k: string]: Json } = {
    internalCode: 'PRICE-ADJ',
    description: 'Price adjustment refund',
    itemType: template.itemType,
    itemCode: template.itemCode,
    unitType: template.unitType,
    quantity: 1,
    unitPrice: net / 100,
    netSale: net / 100,
    totalSale: net / 100,
    total: a.refundAmount / 100,
    ...(tax > 0
      ? { taxableItems: [{ taxType: 'T1', amount: tax / 100, subType: 'V009', rate: bps / 100 }] }
      : {}),
  };
  const doc: SaleDoc = {
    header: {
      dateTimeIssued: etaTime(a.issuedAt),
      receiptNumber: a.receiptNumber.slice(0, 50),
      uuid: '',
      previousUUID: a.previousUuid,
      currency: 'EGP',
      documentUseReason: a.reason,
      salesIssuedDateTime: sale.header.dateTimeIssued,
      ...(a.referenceOldUuid ? { referenceOldUUID: a.referenceOldUuid } : {}),
    },
    documentType: { receiptType: 'RWR', typeVersion: '1.2' },
    seller: sale.seller,
    buyer: sale.buyer,
    itemData: [line],
    totalSales: net / 100,
    netAmount: net / 100,
    totalAmount: a.refundAmount / 100,
    ...(tax > 0 ? { taxTotals: [{ taxType: 'T1', amount: tax / 100 }] } : {}),
    paymentMethod: sale.paymentMethod,
  };
  doc.header.uuid = receiptUuid(doc);
  return doc;
}
