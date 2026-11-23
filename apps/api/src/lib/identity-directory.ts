/**
 * What the shared identity service (accounts.ebda.app) may ask the Store: which stores a user acts on, and sending
 * its one-time-code mail through the Store's platform mailer. Called over Service Binding RPC (cf/identity-rpc in
 * worker.ts), never over HTTP. Token contract: business/ebda/plans/2026-10-24-ebda-identity-token-contract.md.
 */
import { prisma, withUser } from '@ebda/database';
import { liveStoreIdsD1, onAccessD1 } from '../services/platform/access-d1';
import { config } from '../config';
import { lookupStore, ownedStoreIds } from './definer';
import {
  sendMerchantPasswordResetEmail,
  sendStaffInviteEmail,
  sendFactorEnrolCodeEmail,
  sendFactorAddedNoticeEmail,
  sendRecoveryCodesChangedNoticeEmail,
  sendMerchantVerificationEmail,
} from '../services/platform-mailer';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type StoreRole = 'owner' | 'staff';
export type StoreClaim = { id: string; role: StoreRole };
const OWNER: StoreRole = 'owner';
const STAFF: StoreRole = 'staff';

/** owner = Store.ownerId (live stores), staff = a StoreStaff row on a live store. An owner is never listed twice. */
export async function storesForUser(userId: string): Promise<StoreClaim[]> {
  if (!UUID_RE.test(userId)) throw new Error('storesForUser: userId must be a UUID');
  // NEON-ZERO-1 (N-6): after the `access` cutover membership AND the live-store check are D1 (no Postgres scope, no relation).
  if (await onAccessD1()) {
    const owned = await ownedStoreIds(userId);
    const staff = await prisma.storeStaff.findMany({
      where: { userId },
      select: { storeId: true },
    });
    const live = await liveStoreIdsD1(staff.map((s: { storeId: string }) => s.storeId));
    const out: StoreClaim[] = owned.map(id => ({ id, role: OWNER }));
    const seen = new Set(owned);
    for (const s of staff as Array<{ storeId: string }>) {
      if (seen.has(s.storeId) || !live.has(s.storeId)) continue;
      seen.add(s.storeId);
      out.push({ id: s.storeId, role: STAFF });
    }
    return out;
  }
  return withUser(userId, async tx => {
    const owned = await ownedStoreIds(userId);
    const staff = await tx.storeStaff.findMany({
      where: { userId },
      select: { storeId: true, store: { select: { deletedAt: true } } },
    });
    const out: StoreClaim[] = owned.map(id => ({ id, role: OWNER }));
    const seen = new Set(owned);
    for (const s of staff) {
      if (seen.has(s.storeId) || s.store.deletedAt !== null) continue;
      seen.add(s.storeId);
      out.push({ id: s.storeId, role: STAFF });
    }
    return out;
  });
}

/**
 * Is this store still in the directory (any status, not soft-deleted)? The identity service asks before it issues or honours an
 * integrator client token (v1.3), so deleting a store ends its clients' access at the commit, whatever the cleanup does later.
 */
export async function storeLive(storeId: string): Promise<boolean> {
  if (!UUID_RE.test(storeId)) return false;
  return !!(await lookupStore({ id: storeId }, ['active', 'inactive', 'suspended']));
}

/**
 * Can this store's integrator clients act right now? Not deleted AND not suspended (an admin suspension ends integrations at
 * once; a merely inactive store keeps them). `storeLive` is the broader "still exists" test the cleanup sweep uses.
 */
export async function storeActive(storeId: string): Promise<boolean> {
  if (!UUID_RE.test(storeId)) return false;
  return !!(await lookupStore({ id: storeId }, ['active', 'inactive']));
}

export interface CodeMail {
  to: string;
  kind: 'email_verify' | 'password_reset' | 'staff_invite' | 'factor_enrol';
  code: string;
  language: 'en' | 'ar';
  firstName: string;
  ttlMinutes: number;
  storeName?: string;
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
      m.language,
      true
    );
  } else if (m.kind === 'factor_enrol') {
    await sendFactorEnrolCodeEmail(
      { email: m.to, name: m.firstName, code: m.code, expiresInMinutes: m.ttlMinutes },
      m.language,
      true
    );
  } else if (m.kind === 'staff_invite') {
    await sendStaffInviteEmail(
      {
        email: m.to,
        name: m.firstName,
        storeName: m.storeName ?? 'your store',
        loginUrl: `${config.adminUrl}/login`,
        setPasswordUrl: `${config.adminUrl}/reset-password?${q}`,
        expiresInMinutes: m.ttlMinutes,
      },
      m.language,
      true
    );
  } else {
    await sendMerchantPasswordResetEmail(
      {
        email: m.to,
        name: m.firstName,
        resetUrl: `${config.adminUrl}/reset-password?${q}`,
        expiresInMinutes: m.ttlMinutes,
      },
      m.language,
      true
    );
  }
}

export type NoticeMail =
  | {
      to: string;
      kind: 'factor_added';
      factor: 'totp' | 'passkey';
      language: 'en' | 'ar';
      firstName: string;
    }
  | { to: string; kind: 'recovery_codes_changed'; language: 'en' | 'ar'; firstName: string };

/** Security notices from the identity service that carry no code. */
export async function sendNoticeMail(m: NoticeMail): Promise<void> {
  if (m.kind === 'recovery_codes_changed') {
    await sendRecoveryCodesChangedNoticeEmail({ email: m.to, name: m.firstName }, m.language, true);
    return;
  }
  await sendFactorAddedNoticeEmail(
    { email: m.to, name: m.firstName, factor: m.factor },
    m.language,
    true
  );
}
