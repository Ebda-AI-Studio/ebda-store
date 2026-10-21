import { escapeHtml } from './_util';

/** A rendered barcode PNG (see lib/barcode-png): absolute https URL + the size it is shown at. */
export interface EmailBarcode {
  url: string;
  width: number;
  height: number;
}

const ALT = {
  order: { en: 'Order number', ar: 'رقم الطلب' },
  billing: { en: 'Payment number', ar: 'رقم الدفعة' },
} as const;

/**
 * The barcode `<img>` for an email, or '' (the number stays as text elsewhere
 * in the email) when there is no image yet, the render failed, or the URL is
 * not absolute https. Width/height are set so layouts do not jump while it
 * loads; the alt names the number for clients that block images. Returned with
 * no surrounding whitespace so dropping it leaves the rest of the email
 * byte-identical.
 */
export function barcodeImgHtml(
  barcode: EmailBarcode | null | undefined,
  number: string,
  lang: 'en' | 'ar',
  kind: keyof typeof ALT
): string {
  if (!barcode || !/^https:\/\//i.test(barcode.url)) return '';
  const alt = escapeHtml(`${ALT[kind][lang]} ${number}`);
  return `<img src="${escapeHtml(barcode.url)}" width="${Math.round(barcode.width)}" height="${Math.round(barcode.height)}" alt="${alt}" style="display:block;margin:12px 0;max-width:100%;height:auto;border:0;" />`;
}
