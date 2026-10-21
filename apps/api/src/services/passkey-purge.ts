import { insertAuditLog } from '../lib/definer';
import logger from '../lib/logger';
import { sendPasskeyNotice } from './passkey-notices';

/**
 * A password change or reset removes EVERY passkey of the account (Rulings PASSKEY-10, PASSKEY-13): the
 * person who knows the new password is the owner, and a passkey an attacker registered while holding a
 * session must not outlive that. The delete runs in the SAME transaction as the password write; this
 * file is the part that runs after it commits: the audit row and the notice, both best-effort and only
 * when something was actually removed.
 */
export async function announcePasskeyPurge(args: {
  user: {
    id: string;
    email: string;
    firstName: string;
    language?: string | null;
    storeId: string | null;
  };
  count: number;
  reason: 'password_changed' | 'password_reset';
}): Promise<void> {
  if (args.count <= 0) return;
  const { user, count, reason } = args;
  try {
    await insertAuditLog({
      action: 'passkey.purged',
      userId: user.id,
      storeId: user.storeId,
      resourceType: 'passkey',
      resourceId: user.id,
      details: { count, reason },
    });
  } catch (err) {
    logger.error({ err, userId: user.id }, '[passkey] purge audit failed');
  }
  try {
    await sendPasskeyNotice(
      {
        email: user.email,
        name: user.firstName,
        kind: 'purged',
        passkeyName: '',
        count,
        reason,
        at: new Date().toISOString(),
        storeId: user.storeId,
      },
      user.language === 'ar' ? 'ar' : 'en'
    );
  } catch (err) {
    logger.error({ err, userId: user.id }, '[passkey] purge notice failed');
  }
}
