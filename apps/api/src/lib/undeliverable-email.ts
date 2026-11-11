/**
 * Addresses that can never receive mail. RFC 2606 reserves `.invalid` so no registrar can ever sell
 * it; a placeholder address must use it and never a domain somebody might own (the legacy WhatsApp bridge minted `@placeholder.<registered
 * domain>` and order PII could have left our control, Ruling WA-LEGACY-1).
 *
 * Every outbound email path filters its recipients through `deliverableOnly` so a placeholder is
 * dropped (and logged) instead of sent.
 */
import { z } from 'zod';
import logger from './logger';

const emailSchema = z.string().trim().email();

/** True when `address` is a syntactically valid email (Zod). Empty / blank / missing domain = false. */
export function isValidEmailAddress(address: unknown): address is string {
  return emailSchema.safeParse(address).success;
}

/** The valid, deliverable recipients of `to`; empty when none (callers must then NOT enqueue/send). */
export function validRecipients(to: unknown): string[] {
  const all = Array.isArray(to) ? to : [to];
  return all
    .filter(isValidEmailAddress)
    .map(a => a.trim())
    .filter(a => !isUndeliverableAddress(a));
}

const RESERVED_TLD = /\.invalid$/i;

/** True when the address's domain is in the RFC 2606 `.invalid` TLD (never deliverable). */
export function isUndeliverableAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  return RESERVED_TLD.test(address.slice(at + 1).trim());
}

/** The recipients that can receive mail; the rest are logged and dropped. */
export function deliverableOnly(to: string | string[]): string[] {
  const all = Array.isArray(to) ? to : [to];
  const ok = validRecipients(all);
  if (ok.length < all.length) {
    logger.warn(
      { dropped: all.length - ok.length },
      '[email] dropped recipient(s): invalid or reserved undeliverable address'
    );
  }
  return ok;
}
