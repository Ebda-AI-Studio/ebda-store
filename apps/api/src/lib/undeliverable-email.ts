/**
 * Addresses that can never receive mail. RFC 2606 reserves `.invalid` (plus `.test`, `.example`,
 * `.localhost`) so no registrar can ever sell them; a placeholder address must use one of them and
 * never a domain somebody might own (the legacy WhatsApp bridge minted `@placeholder.<registered
 * domain>` and order PII could have left our control, Ruling WA-LEGACY-1).
 *
 * Every outbound email path filters its recipients through `deliverableOnly` so a placeholder is
 * dropped (and logged) instead of sent.
 */
import logger from './logger';

const RESERVED_TLD = /\.(?:invalid|test|example|localhost)$/i;

/** True when the address's domain is in an RFC 2606 reserved TLD. */
export function isUndeliverableAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  return RESERVED_TLD.test(address.slice(at + 1).trim());
}

/** The recipients that can receive mail; the rest are logged and dropped. */
export function deliverableOnly(to: string | string[]): string[] {
  const all = Array.isArray(to) ? to : [to];
  const ok = all.filter(a => !isUndeliverableAddress(a));
  if (ok.length < all.length) {
    logger.warn(
      { dropped: all.length - ok.length },
      '[email] dropped recipient(s) on a reserved undeliverable domain'
    );
  }
  return ok;
}
