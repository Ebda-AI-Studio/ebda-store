import { hkdfSync } from 'crypto';
import { config } from '../config';

/**
 * A purpose-bound 256-bit key, derived with HKDF-SHA256 from the API's
 * ENCRYPTION_KEY (issue 2424).
 *
 * Why ENCRYPTION_KEY and not JWT_SECRET: JWT_SECRET signs sessions, and
 * rotating it is a normal way to sign everyone out. A link that lives in an
 * inbox or an SMS thread (an opt-out, an unsubscribe, a review request) must
 * NOT die with the sessions. ENCRYPTION_KEY is the secret this codebase
 * treats as stable: rotating it means re-encrypting every stored TOTP secret,
 * payment config and agent key, so it is never rotated casually. Production
 * refuses to boot without it (config/index.ts), so deriving from it needs no
 * new env var and no deploy step.
 *
 * Why HKDF with a label: each purpose gets its own key, so a MAC valid for one
 * purpose is meaningless for every other, and none of them is ENCRYPTION_KEY
 * itself. Add a new label for a new purpose; never reuse one.
 *
 * Throws when ENCRYPTION_KEY is empty (only possible outside production):
 * an empty key would make every derived MAC forgeable, so this fails loud
 * instead of signing with a value anyone can reproduce.
 */
export type DerivedSecretLabel =
  | 'ebda:sms-optout-mac:v2'
  | 'ebda:campaign-unsubscribe-mac:v1'
  | 'ebda:lifecycle-unsubscribe-mac:v1'
  | 'ebda:review-link-mac:v1'
  | 'ebda:cart-restore-mac:v1'
  | 'ebda:order-view-mac:v1'
  | 'ebda:mcp-confirm-mac:v1'
  | 'ebda:search-searcher-salt:v1'
  | 'ebda:barcode-key:v1'
  | 'ebda:wa-checkout-mac:v1';

const SALT = 'ebda:derived-secret';

export function derivedSecret(label: DerivedSecretLabel): Buffer {
  if (!config.encryptionKey) {
    throw new Error(`ENCRYPTION_KEY is not set; cannot derive the ${label} key`);
  }
  return Buffer.from(hkdfSync('sha256', config.encryptionKey, SALT, label, 32));
}
