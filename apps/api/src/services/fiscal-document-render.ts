import { intlLocale } from '@ebda/shared';
import { moneyHtml } from './email-templates/_util';
import { orderBarcodeBlock, ORDER_BARCODE_CSS } from './order-barcode';
import type { RefundDocumentPayload, SaleDocumentPayload } from './fiscal-document.service';

/**
 * Printable view of an ISSUED fiscal document, rendered from the immutable
 * payload it was issued with (ruling MONEYB-1) — never from the live order, so
 * a later edit, a refund or a store deletion cannot change what it says.
 * Used for credit notes / refund receipts, and for any document in the tax
 * archive (super-admin), including documents of a deleted store.
 */

export interface RenderableDocument {
  docType: string;
  number: string | null;
  status: string;
  issuedAt: Date | string;
  cancelledAt?: Date | string | null;
  originalNumber?: string | null;
  originalIssuedAt?: Date | string | null;
  currency: string;
  netAmount: number;
  vatAmount: number;
  totalAmount: number;
  vatRateBps: number | null;
  sellerTrn: string | null;
  payload: unknown;
}

const L = {
  en: {
    tax_invoice: 'Tax invoice',
    receipt: 'Sales receipt',
    credit_note: 'Credit note',
    refund_receipt: 'Refund receipt',
    order_record: 'Order record (archived)',
    billing_record: 'Subscription billing record (archived)',
    number: 'No.',
    date: 'Date',
    order: 'Order',
    original: 'Adjusts',
    originalDate: 'dated',
    trn: 'Tax registration no.',
    billTo: 'Bill to',
    item: 'Item',
    qty: 'Qty',
    unit: 'Unit price',
    amount: 'Amount',
    discount: 'Discount',
    net: 'Amount excl. VAT',
    vat: 'VAT',
    total: 'Total',
    cancelled: 'CANCELLED',
    reason: 'Reason',
  },
  ar: {
    tax_invoice: 'فاتورة ضريبية',
    receipt: 'إيصال بيع',
    credit_note: 'إشعار دائن',
    refund_receipt: 'إيصال استرداد',
    order_record: 'سجل طلب (مؤرشف)',
    billing_record: 'سجل فاتورة اشتراك (مؤرشف)',
    number: 'رقم',
    date: 'التاريخ',
    order: 'الطلب',
    original: 'تعديل على',
    originalDate: 'بتاريخ',
    trn: 'رقم التسجيل الضريبي',
    billTo: 'العميل',
    item: 'البند',
    qty: 'الكمية',
    unit: 'سعر الوحدة',
    amount: 'القيمة',
    discount: 'خصم',
    net: 'المبلغ بدون الضريبة',
    vat: 'ضريبة القيمة المضافة',
    total: 'الإجمالي',
    cancelled: 'ملغى',
    reason: 'السبب',
  },
} as const;

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function renderFiscalDocumentHtml(
  doc: RenderableDocument,
  locale: 'ar' | 'en',
  timeZone = 'Africa/Cairo',
  /** The store's `settings.receiptBarcodeShape` (unset = plain, `off` = none). */
  barcodeShape?: unknown
): string {
  const ar = locale === 'ar';
  const l = ar ? L.ar : L.en;
  // The document's language, not English: Arabic prints «ج.م» (never "EGP") and a sign stays with its number in RTL.
  const money = (n: number) => moneyHtml(n, doc.currency || 'EGP', locale);
  const minus = (n: number) => moneyHtml(n, doc.currency || 'EGP', locale, '\u2212');
  const date = (d: Date | string | null | undefined) =>
    d
      ? new Date(d).toLocaleDateString(intlLocale(locale), {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone,
        })
      : '';
  const title = (l as Record<string, string>)[doc.docType] ?? doc.docType;
  const p = (doc.payload ?? {}) as Partial<SaleDocumentPayload & RefundDocumentPayload> & {
    lines?: SaleDocumentPayload['lines'];
    orderNumber?: string;
  };
  const seller = p.seller;
  const rate = doc.vatRateBps != null ? ` (${doc.vatRateBps / 100}%)` : '';

  // Shipping, COD fee and extra charge are totals lines, not purchased items (QA-70): no qty, no unit price.
  const isCharge = (k: string | undefined) => k === 'shipping' || k === 'cod_fee' || k === 'extra';
  const allLines = Array.isArray(p.lines) ? p.lines : [];
  const lines = allLines.some(ln => !isCharge(ln.kind))
    ? allLines
        .filter(ln => !isCharge(ln.kind))
        .map(
          ln => `<tr><td>${esc(ar && ln.descriptionAr ? ln.descriptionAr : ln.description)}${
            (ar ? (ln.priceLabelAr ?? ln.priceLabel) : ln.priceLabel)
              ? `<div class="muted" data-price-label="1">${esc(ar ? (ln.priceLabelAr ?? ln.priceLabel) : ln.priceLabel)}</div>`
              : ''
          }</td>
            <td class="n">${esc(ln.quantity)}</td>
            <td class="n">${ln.unitPrice == null ? '—' : `${ln.listPrice != null ? `<s style="opacity:.6">${money(ln.listPrice)}</s> ` : ''}${money(ln.unitPrice)}`}</td>
            <td class="n">${money(ln.amount)}</td></tr>`
        )
        .join('')
    : '';
  const charges = allLines
    .filter(ln => isCharge(ln.kind))
    .map(
      ln =>
        `<tr><td colspan="3">${esc(ar && ln.descriptionAr ? ln.descriptionAr : ln.description)}</td><td class="n">${money(ln.amount)}</td></tr>`
    )
    .join('');
  const discounts = Array.isArray(p.discounts)
    ? p.discounts
        .map(
          d =>
            `<tr><td colspan="3">${esc(l.discount)}${d.label ? ` (${esc(d.label)})` : ''}</td><td class="n">${minus(d.amount)}</td></tr>`
        )
        .join('')
    : '';

  // QA-69: the order barcode the store configured in /codes (Code 128 of the order number), as the invoice page prints it.
  const barcode = p.orderNumber ? orderBarcodeBlock(p.orderNumber, barcodeShape) : '';

  return `<!DOCTYPE html>
<html lang="${locale}" dir="${ar ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} ${esc(doc.number ?? '')}</title>
<style>
  body{font-family:${ar ? '"Noto Sans Arabic",Tahoma,Arial' : '-apple-system,Segoe UI,Roboto,Arial'},sans-serif;color:#0f172a;margin:0;background:#f8fafc}
  .page{max-width:800px;margin:24px auto;background:#fff;border-radius:12px;padding:32px;position:relative}
  h1{font-size:20px;margin:0 0 4px} .muted{color:#475569;font-size:13px}
  table{width:100%;border-collapse:collapse;margin-top:20px;font-size:14px}
  th,td{padding:8px 6px;border-bottom:1px solid #e2e8f0;text-align:start}
  .n{text-align:end;white-space:nowrap} .tot td{font-weight:700}
  .stamp{position:absolute;top:40%;left:50%;transform:translate(-50%,-50%) rotate(-18deg);font-size:72px;font-weight:900;color:#dc2626;opacity:.08}
  ${ORDER_BARCODE_CSS}
  @media print{body{background:#fff}.page{margin:0;border-radius:0}}
</style></head>
<body><div class="page">
${doc.status === 'cancelled' ? `<div class="stamp">${esc(l.cancelled)}</div>` : ''}
<h1>${esc(title)}</h1>
<div class="muted">${esc(l.number)} <span dir="ltr">${esc(doc.number ?? '—')}</span> · ${esc(l.date)} ${esc(date(doc.issuedAt))}${p.orderNumber ? ` · ${esc(l.order)} <span dir="ltr">${esc(p.orderNumber)}</span>` : ''}</div>
${doc.originalNumber ? `<div class="muted">${esc(l.original)} <span dir="ltr">${esc(doc.originalNumber)}</span> ${esc(l.originalDate)} ${esc(date(doc.originalIssuedAt ?? p.original?.issuedAt))}</div>` : ''}
${seller ? `<p class="muted">${esc(seller.name)}${seller.legalName ? ` · ${esc(seller.legalName)}` : ''}${doc.sellerTrn ? ` · ${esc(l.trn)}: <span dir="ltr">${esc(doc.sellerTrn)}</span>` : ''}</p>` : ''}
${p.buyer?.name ? `<p class="muted">${esc(l.billTo)}: ${esc(p.buyer.name)}${(ar ? p.buyer.addressAr : p.buyer.addressEn)?.length ? ` — ${(ar ? p.buyer.addressAr : p.buyer.addressEn).map(esc).join('، ')}` : ''}</p>` : ''}
${p.buyerName ? `<p class="muted">${esc(l.billTo)}: ${esc(p.buyerName)}</p>` : ''}
${p.reason ? `<p class="muted">${esc(l.reason)}: ${esc(p.reason)}</p>` : ''}
<table>
  ${lines ? `<thead><tr><th>${esc(l.item)}</th><th class="n">${esc(l.qty)}</th><th class="n">${esc(l.unit)}</th><th class="n">${esc(l.amount)}</th></tr></thead>` : ''}
  <tbody>
    ${lines}${discounts}${charges}
    <tr><td colspan="3">${esc(l.net)}</td><td class="n">${money(doc.netAmount)}</td></tr>
    <tr><td colspan="3">${esc(l.vat)}${esc(rate)}</td><td class="n">${money(doc.vatAmount)}</td></tr>
    <tr class="tot"><td colspan="3">${esc(l.total)}</td><td class="n">${doc.docType === 'credit_note' || doc.docType === 'refund_receipt' ? minus(doc.totalAmount) : money(doc.totalAmount)}</td></tr>
  </tbody>
</table>
${barcode}
</div></body></html>`;
}
