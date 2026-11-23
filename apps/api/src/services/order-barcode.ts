import { renderBarcodeSvg, BARCODE_DISPLAY_PX, scanCodeFor } from '@ebda/shared';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Order barcode styles: ink on paper, always LTR, kept together when printing. */
export const ORDER_BARCODE_CSS = `
    .doc-barcode { margin-top: 28px; text-align: center; color: var(--ink, #0f172a); break-inside: avoid; }
    .doc-barcode svg { width: 100%; max-width: 360px; height: auto; }
    .doc-barcode-num { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; letter-spacing: 0.2em; color: var(--ink-soft, #475569); margin-top: 4px; }
    .doc-barcode-digits { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 10px; letter-spacing: 0.12em; color: var(--ink-soft, #64748b); margin-top: 2px; }`;

/**
 * The order barcode: a real, scannable Code 128 of the order number in the
 * store's chosen shape (`settings.receiptBarcodeShape`, default plain, `off`
 * hides it), with the big order number and, when the bars carry a packed scan code, those digits small under it so a
 * failed scan can be typed (BC1). Shape drawings: BARKOD studio (barkod.studio), used with permission.
 * An un-encodable number or an unknown shape degrades to plain / nothing, never
 * a broken invoice.
 */
export function orderBarcodeBlock(orderNumber: string, rawShape: unknown): string {
  const shape = typeof rawShape === 'string' ? rawShape : 'plain';
  if (shape === 'off') return '';
  try {
    const svg = renderBarcodeSvg({
      value: orderNumber,
      shape,
      label: false,
      displayPx: BARCODE_DISPLAY_PX.invoice,
    });
    return `<div class="doc-barcode"><bdi dir="ltr">${svg}</bdi><div class="doc-barcode-num" dir="ltr">${escapeHtml(orderNumber)}</div>${
      scanCodeFor(orderNumber) !== orderNumber
        ? `<div class="doc-barcode-digits" dir="ltr">${escapeHtml(scanCodeFor(orderNumber))}</div>`
        : ''
    }</div>`;
  } catch {
    return '';
  }
}
