import { identityAccountIdByEmail } from '../lib/identity-client';
import { platformDb } from '../lib/platform-directory';
import logger from '../lib/logger';
import { maskEmail } from '../lib/pii-mask';

/**
 * Ruling B1-13 on the Worker (NEON-ZERO, Ruling NZ-DEMO-OWNER-1): the demo showroom's seeded owner
 * (`storedemo-owner@ebda.app`) has no mailbox. The Postgres path refuses it through `ownsDemoStore`; a Postgres-less
 * Worker hands every store-less address to the identity service, which mails any active account, and the identity row
 * of the demo owner exists (verified live 2026-11-23), so a reset request mailed a dead address on demand.
 *
 * The identity service knows the account id, the platform D1 directory knows who owns a demo store: ask the first,
 * then the second. Callers answer exactly as for an unknown address when this returns true.
 *
 * Failure posture: a lookup that errors returns false (the mail goes on). The harm being guarded is one bounce on the
 * platform sender; the alternative (refuse on error) would stop every merchant's password reset while identity or D1 is
 * degraded, a worse outage than the one it prevents. The failure is logged at warn so it is visible.
 */
export async function isDemoOwnerEmail(email: string): Promise<boolean> {
  try {
    const d1 = platformDb();
    if (!d1) return false; // Node / tests / local dev: the Postgres `ownsDemoStore` path owns this check
    const id = await identityAccountIdByEmail(email);
    if (!id) return false;
    const row = await d1
      .prepare('SELECT 1 AS yes FROM stores WHERE owner_id = ?1 AND is_demo = 1 LIMIT 1')
      .bind(id)
      .first<{ yes: number }>();
    return row !== null;
  } catch (err) {
    logger.warn({ err, email: maskEmail(email) }, 'demo-owner guard lookup failed; not refusing');
    return false;
  }
}
