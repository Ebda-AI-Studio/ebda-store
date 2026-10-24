/**
 * What the shared identity service (accounts.ebda.app) may ask the Store: which stores a user acts on, and sending
 * its one-time-code mail through the Store's platform mailer. Called over Service Binding RPC (cf/identity-rpc in
 * worker.ts), never over HTTP. Token contract: business/ebda/plans/2026-10-24-ebda-identity-token-contract.md.
 */
import { withUser } from '@ebda/database';
import { config } from '../config';
import { ownedStoreIds } from './definer';
import {
  sendMerchantPasswordResetEmail,
  sendMerchantVerificationEmail,
} from '../services/platform-mailer';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StoreClaim = { id: string; role: 'owner' | 'staff' };

/** owner = Store.ownerId (live stores), staff = a StoreStaff row on a live store. An owner is never listed twice. */
export async function storesForUser(userId: string): Promise<StoreClaim[]> {
  if (!UUID_RE.test(userId)) throw new Error('storesForUser: userId must be a UUID');
  return withUser(userId, async tx => {
    const owned = await ownedStoreIds(userId);
    const staff = await tx.storeStaff.findMany({
      where: { userId },
      select: { storeId: true, store: { select: { deletedAt: true } } },
    });
    const out: StoreClaim[] = owned.map(id => ({ id, role: 'owner' as const }));
    const seen = new Set(owned);
    for (const s of staff) {
      if (seen.has(s.storeId) || s.store.deletedAt !== null) continue;
      seen.add(s.storeId);
      out.push({ id: s.storeId, role: 'staff' });
    }
    return out;
  });
}

export interface CodeMail {
  to: string;
  kind: 'email_verify' | 'password_reset';
  code: string;
  language: 'en' | 'ar';
  firstName: string;
  ttlMinutes: number;
}

/** The code travels in the link the existing branded templates already render, so no new template is needed. */
export async function sendCodeMail(m: CodeMail): Promise<void> {
  if (!/^\d{6}$/.test(m.code)) throw new Error('sendCodeMail: code must be 6 digits');
  // The code rides in the URL FRAGMENT: it is never sent to a server, a Referer header, analytics or an access log.
  const q = `email=${encodeURIComponent(m.to)}#code=${m.code}`;
  if (m.kind === 'email_verify') {
    await sendMerchantVerificationEmail(
      {
        email: m.to,
        name: m.firstName,
        verificationUrl: `${config.adminUrl}/verify-email?${q}`,
        expiresInHours: Math.max(1, Math.round(m.ttlMinutes / 60)),
      },
      m.language
    );
  } else {
    await sendMerchantPasswordResetEmail(
      {
        email: m.to,
        name: m.firstName,
        resetUrl: `${config.adminUrl}/reset-password?${q}`,
        expiresInMinutes: m.ttlMinutes,
      },
      m.language
    );
  }
}
