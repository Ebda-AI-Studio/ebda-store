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
      | 'ETA_NO_ITEM_CODE',
    message: string
  ) {
    super(message);
  }
}

export interface EtaOrderItem {
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

/**
 * Whole-order return: mirrors the original sale document line for line (full refunds only; a
 * partial return is `manual`, see Ruling ETA-1). `referenceUUID` points at the sale receipt.
 */
export function buildReturnReceipt(a: {
  sale: { [k: string]: Json } & { header: { [k: string]: Json; uuid: string } };
  previousUuid: string;
  receiptNumber: string;
  issuedAt: Date;
  referenceOldUuid?: string;
}) {
  const sale = JSON.parse(JSON.stringify(a.sale)) as typeof a.sale;
  const doc: typeof a.sale = {
    ...sale,
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
  };
  doc.header.uuid = receiptUuid(doc);
  return doc;
}
