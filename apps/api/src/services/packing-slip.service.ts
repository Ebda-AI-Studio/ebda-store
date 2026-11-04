import { storeDb } from '../lib/repo-factory';
import {
  BARCODE_DISPLAY_PX,
  groupOrderLinesForDisplay,
  orderAddressLines,
  orderLineVariantTitle,
  renderBarcodeSvg,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { escapeHtml } from './email-templates/_util';

/** One print job is capped here (a browser print dialog chokes well before the API does). */
export const PACKING_SLIP_MAX_ORDERS = 100;

export type PackingSlipSize = 'a4' | 'label';

const L = {
  en: {
    title: 'Packing slip',
    order: 'Order',
    date: 'Date',
    shipTo: 'Ship to',
    phone: 'Phone',
    item: 'Item',
    sku: 'SKU',
    qty: 'Qty',
    packed: 'Packed',
    items: 'Items',
    notes: 'Order notes',
    bundle: 'Bundle',
  },
  ar: {
    title: 'قائمة التغليف',
    order: 'طلب رقم',
    date: 'التاريخ',
    shipTo: 'الشحن إلى',
    phone: 'التليفون',
    item: 'الصنف',
    sku: 'كود الصنف',
    qty: 'الكمية',
    packed: 'اتجهز',
    items: 'عدد القطع',
    notes: 'ملاحظات الطلب',
    bundle: 'باقة',
  },
} as const;

const httpsUrl = (u: unknown): string | null =>
  typeof u === 'string' && /^https:\/\//i.test(u) ? u : null;

const CSS = (size: PackingSlipSize) => `
    @page { size: ${size === 'a4' ? 'A4' : '4in 6in'}; margin: ${size === 'a4' ? '12mm' : '4mm'}; }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: #fff; color: #111; }
    body { font-family: system-ui, -apple-system, 'Segoe UI', Tahoma, Arial, sans-serif; font-size: ${size === 'a4' ? '13px' : '11px'}; line-height: 1.45; }
    .slip { padding: ${size === 'a4' ? '8px' : '2px'}; break-after: page; }
    .slip:last-child { break-after: auto; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 2px solid #111; padding-bottom: 8px; }
    .logo { max-height: ${size === 'a4' ? '48px' : '32px'}; max-width: 40%; object-fit: contain; }
    .store { font-size: ${size === 'a4' ? '20px' : '15px'}; font-weight: 700; }
    .doc { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .barcode { text-align: center; margin: 10px 0 4px; }
    .barcode svg { width: 100%; max-width: ${size === 'a4' ? BARCODE_DISPLAY_PX.packingSlipA4 : BARCODE_DISPLAY_PX.packingSlipLabel}px; height: auto; color: #111; }
    .num { text-align: center; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 15px; letter-spacing: .12em; font-weight: 700; margin-bottom: 8px; }
    .meta { display: flex; gap: 16px; justify-content: space-between; margin: 8px 0; }
    .meta > div { flex: 1; }
    .label { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #333; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { border-bottom: 1px solid #999; padding: 5px 4px; text-align: start; vertical-align: middle; }
    th { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
    td.n, th.n { text-align: center; width: 48px; }
    .thumb { width: 36px; height: 36px; object-fit: cover; border: 1px solid #999; display: block; }
    .variant, .note-line { font-size: 11px; color: #222; }
    .tick { display: inline-block; width: 14px; height: 14px; border: 1.5px solid #111; vertical-align: middle; }
    .sub td { padding-inline-start: 18px; }
    .count { margin-top: 8px; font-size: 14px; }
    .notes { margin-top: 10px; border: 1px solid #111; padding: 6px 8px; white-space: pre-wrap; }
    .foot { margin-top: 12px; padding-top: 8px; border-top: 1px dashed #666; font-size: 11px; text-align: center; }
    @media print { html, body { background: #fff; } }`;

type SlipOrder = Awaited<ReturnType<typeof loadSlipOrders>>[number];

const SLIP_STORE_SELECT = {
  name: true,
  nameAr: true,
  logo: true,
  logoAr: true,
  timezone: true,
  settings: true,
} as const;

/**
 * The orders a packing slip prints, read through the store's backend (NEON-ZERO-1, Ruling NZ-A-3). `Store` is a platform row a
 * Durable Object cannot join, so it is attached after the order read with the select the Postgres join had.
 */
async function loadSlipOrders(storeId: string, ids: string[]) {
  const orders = await (
    await storeDb(storeId)
  ).order.findMany({
    where: { storeId, id: { in: ids }, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      orderNumber: true,
      locale: true,
      createdAt: true,
      customerNotes: true,
      shippingAddress: true,
      items: {
        select: {
          id: true,
          productName: true,
          variantName: true,
          variantNameAr: true,
          sku: true,
          quantity: true,
          personalisation: true,
          bundleGroupId: true,
          bundleName: true,
          bundleNameAr: true,
          product: { select: { nameAr: true, images: { take: 1, select: { url: true } } } },
        },
      },
    },
  });
  if (orders.length === 0) return [];
  const store = await (
    await storeDb(storeId)
  ).store.findUnique({ where: { id: storeId }, select: SLIP_STORE_SELECT });
  // an order whose store row is gone cannot be printed (the join returned no row for it either)
  return store ? orders.map(o => ({ ...o, store })) : [];
}

function lineRow(item: SlipOrder['items'][number], ar: boolean, sub: boolean): string {
  const name = (ar && item.product?.nameAr) || item.productName;
  const variant = orderLineVariantTitle(item, ar);
  const thumb = httpsUrl(item.product?.images?.[0]?.url);
  return `<tr class="${sub ? 'sub' : 'line'}">
        <td>${thumb ? `<img class="thumb" src="${escapeHtml(thumb)}" width="36" height="36" alt="" />` : ''}</td>
        <td><strong>${escapeHtml(name)}</strong>${variant ? `<div class="variant"><bdi>${escapeHtml(variant)}</bdi></div>` : ''}${item.personalisation ? `<div class="note-line">&#9998; <bdi>${escapeHtml(item.personalisation)}</bdi></div>` : ''}</td>
        <td><bdi dir="ltr">${escapeHtml(item.sku ?? '')}</bdi></td>
        <td class="n"><strong>${item.quantity}</strong></td>
        <td class="n"><span class="tick"></span></td>
      </tr>`;
}

function slipHtml(order: SlipOrder, ar: boolean, size: PackingSlipSize): string {
  const t = ar ? L.ar : L.en;
  const store = order.store;
  const settings = (store.settings ?? {}) as Record<string, unknown>;
  const storeName = (ar && store.nameAr) || store.name;
  const logo = httpsUrl(ar && store.logoAr ? store.logoAr : store.logo);
  const addr = (order.shippingAddress ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const shipName = `${str(addr.firstName)} ${str(addr.lastName)}`.trim();
  const phone = str(addr.phone);
  const lines = orderAddressLines(addr, ar ? 'ar' : 'en');

  const shape =
    typeof settings.receiptBarcodeShape === 'string' ? settings.receiptBarcodeShape : 'plain';
  let barcode = '';
  if (shape !== 'off') {
    try {
      barcode = `<div class="barcode"><bdi dir="ltr">${renderBarcodeSvg({
        value: order.orderNumber,
        shape,
        label: false,
        ink: '#111111',
        idSuffix: order.id,
        displayPx:
          size === 'a4' ? BARCODE_DISPLAY_PX.packingSlipA4 : BARCODE_DISPLAY_PX.packingSlipLabel,
      })}</bdi></div>`;
    } catch {
      barcode = ''; // a number Code 128 cannot carry: the printed number stays
    }
  }

  const rows = groupOrderLinesForDisplay(
    order.items as unknown as Array<Parameters<typeof groupOrderLinesForDisplay>[0][number]>
  );
  let count = 0;
  const body = rows
    .map(r => {
      if (r.kind === 'bundle') {
        const comps = (r.lines as unknown as SlipOrder['items']).map(i => {
          count += i.quantity;
          return lineRow(i, ar, true);
        });
        return `<tr class="line"><td></td><td colspan="4"><strong>${escapeHtml(t.bundle)}: ${escapeHtml((ar && r.nameAr) || r.name)}</strong></td></tr>${comps.join('')}`;
      }
      count += r.item.quantity;
      return lineRow(r.item as unknown as SlipOrder['items'][number], ar, false);
    })
    .join('');

  const date = new Intl.DateTimeFormat(ar ? 'ar-EG-u-nu-latn' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: store.timezone || 'Africa/Cairo',
  }).format(new Date(order.createdAt));
  const note = str(order.customerNotes);
  const footer = str(settings.packingSlipNote);

  return `<section class="slip" data-order="${escapeHtml(order.orderNumber)}">
    <div class="head">
      <div>${logo ? `<img class="logo" src="${escapeHtml(logo)}" alt="${escapeHtml(storeName)}" />` : ''}<div class="store">${escapeHtml(storeName)}</div></div>
      <div class="doc">${escapeHtml(t.title)}</div>
    </div>
    ${barcode}
    <div class="num"><bdi dir="ltr">${escapeHtml(order.orderNumber)}</bdi></div>
    <div class="meta">
      <div><div class="label">${escapeHtml(t.shipTo)}</div>
        <div><strong>${escapeHtml(shipName)}</strong></div>
        ${lines.map(l => `<div>${escapeHtml(l)}</div>`).join('')}
        ${phone ? `<div>${escapeHtml(t.phone)}: <bdi dir="ltr">${escapeHtml(phone)}</bdi></div>` : ''}</div>
      <div><div class="label">${escapeHtml(t.date)}</div><div>${escapeHtml(date)}</div></div>
    </div>
    <table>
      <thead><tr><th></th><th>${escapeHtml(t.item)}</th><th>${escapeHtml(t.sku)}</th><th class="n">${escapeHtml(t.qty)}</th><th class="n">${escapeHtml(t.packed)}</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div class="count">${escapeHtml(t.items)}: <strong>${count}</strong></div>
    ${note ? `<div class="notes"><div class="label">${escapeHtml(t.notes)}</div>${escapeHtml(note)}</div>` : ''}
    ${footer ? `<div class="foot">${escapeHtml(footer)}</div>` : ''}
  </section>`;
}

export class PackingSlipService {
  /** Same as `generate`, but also lists the requested ids that printed nothing (other store, deleted). */
  static async generateDetailed(
    storeId: string,
    orderIds: string[],
    opts: { size?: PackingSlipSize; locale?: string } = {}
  ): Promise<{ html: string; skippedIds: string[] }> {
    return PackingSlipService.build(storeId, orderIds, opts);
  }

  /**
   * Printable packing slip(s): one page per order, no prices or totals.
   * Tenant-scoped (`storeId` + the ids; other stores' ids print nothing),
   * capped at PACKING_SLIP_MAX_ORDERS. Must run inside the request's tenant
   * context like the invoice. The admin-only `notes` (internal) never print;
   * the customer's order note does.
   */
  static async generate(
    storeId: string,
    orderIds: string[],
    opts: { size?: PackingSlipSize; locale?: string } = {}
  ): Promise<string> {
    return (await PackingSlipService.build(storeId, orderIds, opts)).html;
  }

  private static async build(
    storeId: string,
    orderIds: string[],
    opts: { size?: PackingSlipSize; locale?: string }
  ): Promise<{ html: string; skippedIds: string[] }> {
    const ids = [...new Set(orderIds)];
    if (ids.length === 0) throw new AppError(400, 'NO_ORDERS', 'Select at least one order');
    if (ids.length > PACKING_SLIP_MAX_ORDERS) {
      throw new AppError(
        400,
        'TOO_MANY_ORDERS',
        `Print at most ${PACKING_SLIP_MAX_ORDERS} orders at a time`
      );
    }
    const orders = await loadSlipOrders(storeId, ids);
    if (orders.length === 0) throw new AppError(404, 'NOT_FOUND', 'Order not found');

    const size: PackingSlipSize = opts.size === 'label' ? 'label' : 'a4';
    const first = orders[0]!;
    const locale =
      opts.locale === 'ar' || opts.locale === 'en'
        ? opts.locale
        : first.locale === 'ar'
          ? 'ar'
          : 'en';
    const ar = locale === 'ar';
    const printed = new Set(orders.map(o => o.id));
    const html = `<!doctype html>
<html lang="${locale}" dir="${ar ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml((ar ? L.ar : L.en).title)}</title>
<style>${CSS(size)}</style>
</head>
<body>
${orders.map(o => slipHtml(o, ar, size)).join('\n')}
</body>
</html>`;
    return { html, skippedIds: ids.filter(id => !printed.has(id)) };
  }
}
