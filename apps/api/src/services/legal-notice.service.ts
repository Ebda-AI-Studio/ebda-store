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
import { asPlatformOperator, prisma, withUser } from '@ebda/database';
import {
  LEGAL_DOC_KEYS,
  LEGAL_DOC_TITLE,
  LEGAL_POLICIES,
  computePendingNotices,
  currentLegalVersion,
  findLegalVersion,
  formatLegalDate,
  isLegalDocKey,
  legalPolicyUrl,
  type LegalDocKey,
  type LegalDocRef,
  type LegalPolicies,
  type PendingLegalNotice,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { awaitCampaignSendSlot } from '../lib/campaign-send-pacer';
import { sendLegalNoticeEmail } from './platform-mailer';

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

// ---------------------------------------------------------------------------
// Email fan-out (Ruling LEGAL-4): run by the `legal-notice-send` Inngest function.
//
// Every DB call runs through `asPlatformOperator(operatorId)`, the super admin who pressed
// "Send notice": the deliveries/sends WITH CHECK requires an active super_admin acting user
// (app.current_user_id), and the code-level tenant guard admits user-keyed rows of OTHER
// users (LegalNoticeDelivery) only under that hatch. No owner connection, no RLS bypass.
// Each call is its own short transaction: nothing is held open across a mail send.
// ---------------------------------------------------------------------------

/** Recipients per Inngest step (at most; a step also stops at its wall-clock budget). */
export const LEGAL_NOTICE_BATCH_SIZE = 20;
/**
 * Wall-clock budget for ONE batch step. A step is one HTTP request from Inngest Cloud through
 * Cloudflare (524 at 100 s); the shared 1/s platform pacer can make the next slot arbitrarily
 * far when campaigns are sending, so the step waits for a slot only within this budget and
 * otherwise ends, leaving the rest `queued` for the next step (same shape as campaign-send).
 */
export const LEGAL_NOTICE_STEP_BUDGET_MS = 60_000;
/**
 * Upper bound on batch steps in one run (Inngest caps a run at 1,000 steps; materialize and
 * the leftover/alert steps need a few). Steps spent on a deferral count too. Whatever is still
 * `queued` when it is reached is failed with SEND_WINDOW_EXHAUSTED, never left queued.
 */
export const LEGAL_NOTICE_MAX_BATCH_STEPS = 900;
const ERROR_MAX = 300;
type DeliveryStatus = 'sent' | 'failed';

/**
 * Who is notified: every OWNER of a store that is not soft-deleted and not a demo store,
 * whose account is a live merchant (role store_admin, not deleted). One id per user, so a
 * merchant with several stores is notified once. Read as the operator who pressed send.
 */
export async function listNoticeRecipients(operatorId: string): Promise<string[]> {
  return asPlatformOperator(operatorId, async () => {
    const stores = await prisma.store.findMany({
      where: { deletedAt: null, isDemo: false },
      select: { ownerId: true },
    });
    const ownerIds = [...new Set(stores.map(s => s.ownerId))];
    if (ownerIds.length === 0) return [];
    const users = await prisma.user.findMany({
      where: { id: { in: ownerIds }, role: 'store_admin', deletedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return users.map(u => u.id);
  });
}

/**
 * One `queued` delivery row per recipient (skipDuplicates: re-running is a no-op for rows
 * that exist). Skips when the send row is gone: the request that emitted the event was
 * compensated after an enqueue failure.
 */
export async function materializeDeliveries(
  operatorId: string,
  docKey: string,
  version: string
): Promise<{ ok: true; recipientCount: number } | { ok: false; reason: string }> {
  const send = await asPlatformOperator(operatorId, () =>
    prisma.legalNoticeSend.findUnique({
      where: { docKey_version: { docKey, version } },
      select: { id: true },
    })
  );
  if (!send) return { ok: false, reason: 'SEND_ROW_MISSING' };
  const userIds = await listNoticeRecipients(operatorId);
  for (let i = 0; i < userIds.length; i += 500) {
    const slice = userIds.slice(i, i + 500);
    await asPlatformOperator(operatorId, () =>
      prisma.legalNoticeDelivery.createMany({
        data: slice.map(userId => ({ userId, docKey, version })),
        skipDuplicates: true,
      })
    );
  }
  await asPlatformOperator(operatorId, () =>
    prisma.legalNoticeSend.update({
      where: { docKey_version: { docKey, version } },
      data: { recipientCount: userIds.length },
    })
  );
  return { ok: true, recipientCount: userIds.length };
}

async function markDelivery(
  operatorId: string,
  userId: string,
  docKey: string,
  version: string,
  status: DeliveryStatus,
  error: string | null
): Promise<void> {
  await asPlatformOperator(operatorId, () =>
    prisma.legalNoticeDelivery.updateMany({
      where: { userId, docKey, version, status: 'sending' },
      data: { status, error },
    })
  );
}

/**
 * Mail up to `size` still-`queued` recipients inside ONE step's wall-clock budget.
 *
 * Order per recipient (Ruling LEGAL-5, Coordinator amendment A4):
 *  1. read the address (a DB error here retries the step; the row is still `queued`);
 *  2. wait for a platform send slot WITH the step's remaining budget. No slot in time ->
 *     stop (`deferred`), the row is untouched and a later step picks it up;
 *  3. CLAIM the row queued -> sending, so no retry, overlap or re-run can mail anyone twice;
 *  4. send; 5. mark `sent` or `failed`.
 * A crash between the send and the mark leaves the row in `sending`, which is never re-sent.
 */
export async function sendNextBatch(
  operatorId: string,
  docKey: string,
  version: string,
  size: number = LEGAL_NOTICE_BATCH_SIZE,
  budgetMs: number = LEGAL_NOTICE_STEP_BUDGET_MS
): Promise<{ sent: number; failed: number; remaining: number; deferred: boolean }> {
  const entry = findLegalVersion(activePolicies, docKey, version);
  if (!entry || !isLegalDocKey(docKey)) {
    throw new Error(`legal notice: ${docKey}@${version} is not in LEGAL_POLICIES`);
  }
  const content = {
    title: LEGAL_DOC_TITLE[docKey],
    summary: entry.summary,
    effectiveOn: {
      ar: formatLegalDate(entry.effectiveAt, 'ar'),
      en: formatLegalDate(entry.effectiveAt, 'en'),
    },
    url: { ar: legalPolicyUrl(docKey, 'ar'), en: legalPolicyUrl(docKey, 'en') },
  };
  const queued = await asPlatformOperator(operatorId, () =>
    prisma.legalNoticeDelivery.findMany({
      where: { docKey, version, status: 'queued' },
      orderBy: { userId: 'asc' },
      take: size,
      select: { userId: true },
    })
  );
  const startedAt = Date.now();
  let sent = 0;
  let failed = 0;
  let deferred = false;
  for (const { userId } of queued) {
    const user = await asPlatformOperator(operatorId, () =>
      prisma.user.findUnique({ where: { id: userId }, select: { email: true, firstName: true } })
    );
    const left = budgetMs - (Date.now() - startedAt);
    if (left <= 0 || !(await awaitCampaignSendSlot(left))) {
      deferred = true;
      break;
    }
    const claimed = await asPlatformOperator(operatorId, () =>
      prisma.legalNoticeDelivery.updateMany({
        where: { userId, docKey, version, status: 'queued' },
        data: { status: 'sending' },
      })
    );
    if (claimed.count !== 1) continue;
    let error: string | null = null;
    try {
      if (!user) throw new Error('USER_GONE');
      await sendLegalNoticeEmail({
        email: user.email,
        name: user.firstName || user.email,
        ...content,
      });
    } catch (err) {
      error = String((err as Error)?.message ?? err).slice(0, ERROR_MAX);
      logger.warn({ err, userId, docKey, version }, '[LEGAL-NOTICE] send failed');
    }
    // Outside the try: if this mark throws, the step retries and the row stays `sending`
    // (never re-sent), instead of a delivered mail being recorded as failed.
    await markDelivery(operatorId, userId, docKey, version, error ? 'failed' : 'sent', error);
    if (error) failed++;
    else sent++;
  }
  const remaining = await asPlatformOperator(operatorId, () =>
    prisma.legalNoticeDelivery.count({ where: { docKey, version, status: 'queued' } })
  );
  return { sent, failed, remaining, deferred };
}

/**
 * No orphan `queued` rows (queue-then-send fails fast): the job marks what it never reached,
 * at the step cap and from its failure handler.
 */
export async function failQueuedDeliveries(
  operatorId: string,
  docKey: string,
  version: string,
  reason: string
): Promise<number> {
  const r = await asPlatformOperator(operatorId, () =>
    prisma.legalNoticeDelivery.updateMany({
      where: { docKey, version, status: 'queued' },
      data: { status: 'failed', error: reason },
    })
  );
  return r.count;
}
