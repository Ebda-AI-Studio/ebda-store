/**
 * Legal policy acceptance and material-change notices (Ruling LEGAL-4).
 *
 * Versions come from LEGAL_POLICIES (@ebda/shared). This service records acceptance
 * (signup click-wrap, dashboard "Got it"), computes which notices a merchant still has to
 * see, and runs the email fan-out the super-admin "Send notice" starts.
 *
 * Staleness class of the pending-notice read: NEVER-stale. It is computed per request and
 * never cached (no Redis/KV/bounded-map, `Cache-Control: no-store` on the route), so ack
 * and send need no invalidation.
 */
import { z } from 'zod';
import { withUser } from '@ebda/database';
import {
  LEGAL_DOC_KEYS,
  LEGAL_POLICIES,
  computePendingNotices,
  currentLegalVersion,
  type LegalDocKey,
  type LegalDocRef,
  type LegalPolicies,
  type PendingLegalNotice,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';

/** Longest user-agent stored on an acceptance row. */
export const LEGAL_UA_MAX = 512;

/** Cut at a code-point boundary so a surrogate pair is never split. */
function truncateByCodePoints(value: string, max: number): string {
  if (value.length <= max) return value;
  return Array.from(value).slice(0, max).join('');
}

export type LegalAcceptanceSource = 'signup' | 'notice_ack';

let activePolicies: LegalPolicies = LEGAL_POLICIES;

/** The registry in force (the shipped LEGAL_POLICIES outside tests). */
export function activeLegalPolicies(): LegalPolicies {
  return activePolicies;
}

/** Tests only: run against a fixture registry (e.g. one with a material version). `null` restores. */
export function __setLegalPoliciesForTests(p: LegalPolicies | null): void {
  activePolicies = p ?? LEGAL_POLICIES;
}

/**
 * The ONE place an acceptance row is shaped (user-agent truncation, null for absent
 * ip/UA). Signup click-wrap and the dashboard ack both build their rows with it.
 */
export function buildAcceptanceRow(
  userId: string,
  docKey: LegalDocKey,
  version: string,
  source: LegalAcceptanceSource,
  request: { ip?: string; userAgent?: string },
  now: Date = new Date()
) {
  return {
    userId,
    docKey,
    version,
    acceptedAt: now,
    ip: request.ip ?? null,
    userAgent: request.userAgent ? truncateByCodePoints(request.userAgent, LEGAL_UA_MAX) : null,
    source,
  };
}

/** The click-wrap rows for a new account: every document at its CURRENT version. */
export function signupAcceptanceRows(
  userId: string,
  request: { ip?: string; userAgent?: string },
  now: Date = new Date()
) {
  return LEGAL_DOC_KEYS.map(docKey =>
    buildAcceptanceRow(
      userId,
      docKey,
      currentLegalVersion(activePolicies, docKey).version,
      'signup',
      request,
      now
    )
  );
}

/** Only the merchant account (store owner) is a party to the merchant documents. */
const NOTICE_ROLE = 'store_admin';

export const ackItemsSchema = z
  .object({
    items: z
      .array(z.object({ docKey: z.string().max(40), version: z.string().max(20) }).strict())
      .min(1)
      .max(LEGAL_DOC_KEYS.length),
  })
  .strict();

async function sentAndAccepted(
  tx: Parameters<Parameters<typeof withUser>[1]>[0],
  userId: string
): Promise<{ sent: LegalDocRef[]; accepted: LegalDocRef[] }> {
  const sent = await tx.legalNoticeSend.findMany({ select: { docKey: true, version: true } });
  const accepted = await tx.legalAcceptance.findMany({
    where: { userId },
    select: { docKey: true, version: true },
  });
  return { sent, accepted };
}

/**
 * Notices this user still has to see. Computed live on every call, never cached
 * (NEVER-stale). A user with zero acceptance rows (staff-provisioned) simply has
 * every sent material current version pending.
 */
export async function pendingNoticesFor(
  userId: string,
  role: string
): Promise<PendingLegalNotice[]> {
  if (role !== NOTICE_ROLE) return [];
  return withUser(userId, async tx => {
    const { sent, accepted } = await sentAndAccepted(tx, userId);
    return computePendingNotices(activePolicies, sent, accepted);
  });
}

/**
 * Record "Got it". Every item must be SENT + MATERIAL + CURRENT (A6); one that is already
 * acknowledged is a harmless no-op. Anything else (a version accepted at signup, a
 * superseded or unsent one) refuses the whole request with 422 NOT_PENDING, writing nothing.
 */
export async function ackNotices(
  userId: string,
  role: string,
  items: Array<{ docKey: string; version: string }>,
  request: { ip?: string; userAgent?: string }
): Promise<{ acknowledged: number }> {
  if (role !== NOTICE_ROLE) {
    throw new AppError(403, 'FORBIDDEN', 'Only a store owner acknowledges policy notices');
  }
  return withUser(userId, async tx => {
    const { sent, accepted } = await sentAndAccepted(tx, userId);
    const same = (a: LegalDocRef, b: LegalDocRef) =>
      a.docKey === b.docKey && a.version === b.version;
    const eligible: LegalDocRef[] = LEGAL_DOC_KEYS.flatMap(docKey => {
      const cur = currentLegalVersion(activePolicies, docKey);
      const ref = { docKey, version: cur.version };
      return cur.material && sent.some(s => same(s, ref)) ? [ref] : [];
    });
    const bad = items.filter(i => !eligible.some(e => same(e, i)));
    if (bad.length > 0) {
      throw new AppError(422, 'NOT_PENDING', 'These notices are not pending for this account', {
        items: bad,
      });
    }
    const now = new Date();
    const seen = new Set<string>();
    const fresh = items.filter(i => {
      const k = `${i.docKey}@${i.version}`;
      if (seen.has(k) || accepted.some(a => same(a, i))) return false;
      seen.add(k);
      return true;
    });
    if (fresh.length === 0) return { acknowledged: 0 };
    const r = await tx.legalAcceptance.createMany({
      data: fresh.map(i =>
        buildAcceptanceRow(userId, i.docKey as LegalDocKey, i.version, 'notice_ack', request, now)
      ),
      skipDuplicates: true,
    });
    return { acknowledged: r.count };
  });
}
