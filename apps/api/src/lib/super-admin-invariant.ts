/**
 * Platform-admin invariant (Ruling ID-20). On 2026-11-11 the identity D1 held ZERO super_admins, so nobody could open the
 * super-admin pages and nothing said so. Once a day this asks the identity service (Service Binding RPC
 * `Accounts.superAdminSummary`, counts only) and raises a P1 when:
 *  - no super_admin is active at all, or
 *  - none of the active ones can act (address verified = password set, AND a second factor enrolled, which is what mints `pa`).
 * A missing binding or a failed RPC is also a P1: an invariant that cannot be measured must not read as healthy.
 *
 * Staleness class: NEVER-stale, no cache (one live RPC per run).
 */
import { cfBindings } from '../cf/bindings';
import { sendAlert } from '../services/alerts.service';

export type SuperAdminInvariant = 'ok' | 'none-active' | 'none-ready' | 'unmeasured';

export async function checkSuperAdminInvariant(): Promise<SuperAdminInvariant> {
  const accounts = cfBindings()?.ACCOUNTS;
  let summary: { active: number; ready: number };
  try {
    if (!accounts?.superAdminSummary)
      throw new Error('ACCOUNTS.superAdminSummary binding is missing');
    summary = await accounts.superAdminSummary();
  } catch (e) {
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'api.super_admin_invariant',
      title: 'Platform-admin invariant could not be checked',
      body: `The identity service did not answer superAdminSummary: ${(e as Error).message}`,
    });
    return 'unmeasured';
  }
  if (summary.active === 0) {
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'api.super_admin_invariant',
      title: 'No active platform administrator',
      body: 'The identity service has 0 active super_admin accounts: nobody can open the super-admin pages. Bootstrap one with apps/accounts/scripts/bootstrap-super-admin.mjs (Ruling ID-20).',
    });
    return 'none-active';
  }
  if (summary.ready === 0) {
    await sendAlert({
      level: 'p1',
      scope: 'platform',
      source: 'api.super_admin_invariant',
      title: 'No platform administrator can act yet',
      body: `${summary.active} active super_admin account(s), but none has set a password AND enrolled a second factor (TOTP or passkey), so no session carries admin power.`,
    });
    return 'none-ready';
  }
  return 'ok';
}
