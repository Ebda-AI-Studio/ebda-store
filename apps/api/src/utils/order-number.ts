import crypto from 'crypto';

const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** N cryptographically-random uppercase base36 chars. */
function randomBase36(n: number): string {
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += BASE36[bytes[i] % 36];
  return out;
}

/**
 * Short, unique, human-readable order number.
 *
 *   <PREFIX>-<base36 seconds>-<5 random base36>   e.g. ORD-TQX2P9-7A3FQ
 *
 * ~15 chars vs the old ~24-char `ORD-<13-digit ms>-<8 hex>` form, so it fits
 * tight order-summary rows, WhatsApp messages, and email subjects without
 * truncation. The base36 *seconds* timestamp keeps chronological sortability;
 * the random suffix guarantees uniqueness within a second (`Order.orderNumber`
 * is `@unique`). Existing orders keep their current numbers — only newly
 * generated ones use this shorter format.
 */
export function generateOrderNumber(prefix = 'ORD'): string {
  const t = Math.floor(Date.now() / 1000)
    .toString(36)
    .toUpperCase();
  return `${prefix}-${t}-${randomBase36(5)}`;
}
