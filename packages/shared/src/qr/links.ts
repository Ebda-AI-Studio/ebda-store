import type { QrKind } from './schema';

/**
 * The short link a printed code carries. Stateless on purpose: the storefront resolves
 * `/q/<kind>[/<slug>]` at scan time, so renaming a product or changing the WhatsApp number
 * never invalidates a printed code, and no short-link table has to exist.
 */
export function qrLink(kind: QrKind, origin: string, slug?: string): string {
  const base = origin.replace(/\/+$/, '');
  switch (kind) {
    case 'store':
      return `${base}/q/s`;
    case 'whatsapp':
      return `${base}/q/w`;
    case 'product':
    case 'category': {
      if (!slug) throw new Error(`qrLink: ${kind} needs a slug`);
      return `${base}/q/${kind === 'product' ? 'p' : 'c'}/${encodeURIComponent(slug)}`;
    }
  }
}

/** UTM tags the storefront redirect adds, so merchant analytics (GA, pixels) attribute scans. */
export function qrUtm(kind: QrKind): string {
  return `utm_source=qr&utm_medium=print&utm_campaign=${kind}`;
}
