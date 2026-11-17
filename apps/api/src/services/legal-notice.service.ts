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
import { z } from 'zod/v3';
import { prisma, type withUser } from '@ebda/database';
import {
  LEGAL_DOC_KEYS,
  LEGAL_DOC_TITLE,
  LEGAL_POLICIES,
  computePendingNotices,
  currentLegalVersion,
  feeNoticeTooLate,
  noticeableVersions,
  baselineMissing,
  findLegalVersion,
  formatLegalDate,
  isLegalDocKey,
  legalPolicyUrl,
  type LegalDocKey,
  type LegalDocRef,
  type LegalVersion,
  type LegalPolicies,
  type PendingLegalNotice,
} from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { inngest } from '../lib/inngest/client';
import { withdrawLegalNoticeSend } from '../lib/definer';
import { onD1 } from './platform/billing-d1';
import { listDirectoryStores } from './platform/directory-d1';
import { asOperator, platformHubOnD1, withPlatformUser } from '../lib/platform-scope';
import { getAccountsBrief } from '../lib/identity-client';
import { legalSendRowD1, sendRowStillExistsD1 } from './platform/platform-d1';
import { maskEmail, maskIp, scrubEmails } from '../lib/pii-mask';
import { sendAlert } from './alerts.service';
import { isP2002 } from '../lib/prisma-errors';
import logger from '../lib/logger';
import { awaitCampaignSendSlot } from '../lib/campaign-send-pacer';
import { legalNoticeMailerReady, sendLegalNoticeEmail } from './platform-mailer';

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
      .array(
        z.object({ docKey: z.string().min(1).max(40), version: z.string().min(1).max(20) }).strict()
      )
      .min(1)
      .max(LEGAL_DOC_KEYS.length),
  })
  .strict();

type UserTx = Parameters<Parameters<typeof withUser>[1]>[0];
/** `withUser` that works with Postgres dead (the user-keyed legal rows are D1 once the platform family moved). */
const inUserScope = <T>(userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T> =>
  withPlatformUser(userId, () => fn(prisma as unknown as UserTx));

async function sentAndAccepted(
  tx: UserTx,
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
  return inUserScope(userId, async tx => {
    const { sent, accepted } = await sentAndAccepted(tx, userId);
    return computePendingNotices(activePolicies, sent, accepted, { requireBaseline: true });
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
  return inUserScope(userId, async tx => {
    const { sent, accepted } = await sentAndAccepted(tx, userId);
    const same = (a: LegalDocRef, b: LegalDocRef) =>
      a.docKey === b.docKey && a.version === b.version;
    // The same rule the banner uses (isNoticeable in @ebda/shared): sent + material + current.
    const eligible: LegalDocRef[] = [
      ...noticeableVersions(activePolicies, sent),
      // No record at all for a document: its current version is pending too (baselineMissing).
      ...baselineMissing(activePolicies, accepted),
    ];
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
// Every DB call runs through `asOperator(operatorId)`, the super admin who pressed
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
  return asOperator(operatorId, async () => {
    if (await platformHubOnD1()) {
      // NEON-ZERO (Ruling NZ-C-6): the directory is D1 `stores`, the accounts are the identity service's (an erased account is absent).
      const owners = [
        ...new Set((await listDirectoryStores()).filter(s => !s.isDemo).map(s => s.ownerId)),
      ];
      const accounts = await getAccountsBrief(owners);
      return accounts
        .filter(a => a.role === NOTICE_ROLE)
        .map(a => a.id)
        .sort();
    }
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
 * One `queued` delivery row per recipient, for the send row `sendId` (M1: a run is pinned to
 * ONE send row, so a stale run never adopts a newer send of the same version).
 *
 * Idempotent (I5): when the send already has `recipient_count`, recipients were materialised by
 * an earlier run and nothing is inserted; a Resume just carries on with whatever is `queued`.
 * Skips when the send row is gone: the request that emitted the event was compensated after an
 * enqueue failure.
 */
export async function materializeDeliveries(
  operatorId: string,
  sendId: string,
  docKey: string,
  version: string
): Promise<{ ok: true; recipientCount: number; queued: number } | { ok: false; reason: string }> {
  const userIds = await listNoticeRecipients(operatorId);
  // ONE transaction: lock the send row FIRST, then insert. The enqueue-failure withdrawal
  // (ebda_withdraw_legal_notice_send) takes the same lock, so it either deletes the row before
  // we get here (we abort, nobody is mailed) or waits for us and then sees our deliveries
  // and refuses to delete.
  return asOperator(operatorId, async () => {
    // D1 has no row lock: read the row, fan out, then re-check it still exists (the withdrawal is one
    // statement that refuses once a delivery exists, so it either ran first or sees our deliveries).
    const d1 = await onD1('platform');
    const locked = d1
      ? [await legalSendRowD1(sendId)].filter(<T>(r: T | null): r is T => r !== null)
      : await prisma.$queryRaw<
          Array<{ id: string; doc_key: string; version: string; recipient_count: number | null }>
        >`
      SELECT id, doc_key, version, recipient_count FROM public.legal_notice_sends
       WHERE id = ${sendId} FOR UPDATE`;
    const row = locked[0];
    if (!row || row.doc_key !== docKey || row.version !== version) {
      return { ok: false as const, reason: 'SEND_ROW_MISSING' };
    }
    let recipientCount = row.recipient_count;
    if (recipientCount === null) {
      for (let i = 0; i < userIds.length; i += 500) {
        await prisma.legalNoticeDelivery.createMany({
          data: userIds.slice(i, i + 500).map(userId => ({ userId, docKey, version })),
          skipDuplicates: true,
        });
      }
      recipientCount = userIds.length;
      if (d1 && !(await sendRowStillExistsD1(sendId))) {
        // withdrawn between our read and the fan-out: take our deliveries back so nobody is mailed
        await prisma.legalNoticeDelivery.deleteMany({
          where: { docKey, version, status: 'queued' },
        });
        return { ok: false as const, reason: 'SEND_ROW_MISSING' };
      }
      await prisma.legalNoticeSend.update({
        where: { id: sendId },
        data: { recipientCount },
      });
    }
    const queued = await prisma.legalNoticeDelivery.count({
      where: { docKey, version, status: 'queued' },
    });
    return { ok: true as const, recipientCount, queued };
  });
}

async function markDelivery(
  operatorId: string,
  userId: string,
  docKey: string,
  version: string,
  status: DeliveryStatus,
  error: string | null
): Promise<void> {
  await asOperator(operatorId, () =>
    prisma.legalNoticeDelivery.updateMany({
      where: { userId, docKey, version, status: 'sending' },
      data: { status, error },
    })
  );
}

/**
 * Failure reason for a send whose outcome we cannot know: the request timed out or the
 * connection died after the provider may have accepted it. The mail MAY have been delivered,
 * so "Retry failed" never re-sends these rows (Ruling LEGAL-5); a super admin checks first.
 */
export const TIMEOUT_UNKNOWN = 'TIMEOUT_UNKNOWN';
const UNKNOWN_OUTCOME_RE =
  /time(?:d)?[ -]?out|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EPIPE|socket hang up|aborted|AbortError|UND_ERR_(?:HEADERS|BODY|SOCKET)/i;

/** True for a timeout / dropped-connection error: the send may or may not have gone out. */
export function isUnknownOutcomeError(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown } | null;
  const parts = [e?.name, e?.code, e?.message, (e?.cause as { code?: unknown } | undefined)?.code]
    .filter(x => typeof x === 'string')
    .join(' ');
  return UNKNOWN_OUTCOME_RE.test(parts || String(err));
}

/** Provider text, emails scrubbed, cut to ERROR_MAX. Pre-sliced so a huge message is cheap (M9). */
function deliveryError(err: unknown, recipient?: string): string {
  const msg = String((err as Error)?.message ?? err);
  return scrubEmails(msg.slice(0, ERROR_MAX * 2), [recipient]).slice(0, ERROR_MAX);
}

/**
 * Mail up to `size` still-`queued` recipients inside ONE step's wall-clock budget.
 *
 * Order per recipient (Ruling LEGAL-5, Coordinator amendment A4):
 *  1. read the account (a DB error here retries the step; the row is still `queued`). An account
 *     deleted, or no longer a store owner, since the recipients were listed is claimed and
 *     failed (USER_GONE / NOT_RECIPIENT) without a mail or a pacer slot (M3);
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
  const queued = await asOperator(operatorId, () =>
    prisma.legalNoticeDelivery.findMany({
      where: { docKey, version, status: 'queued' },
      orderBy: { userId: 'asc' },
      take: size,
      select: { userId: true },
    })
  );
  const claim = (userId: string) =>
    asOperator(operatorId, () =>
      prisma.legalNoticeDelivery.updateMany({
        where: { userId, docKey, version, status: 'queued' },
        data: { status: 'sending' },
      })
    );
  const startedAt = Date.now();
  let sent = 0;
  let failed = 0;
  let deferred = false;
  for (const { userId } of queued) {
    const user = await asOperator(operatorId, async () => {
      if (await platformHubOnD1()) {
        const [a] = await getAccountsBrief([userId]);
        return a
          ? { email: a.email, firstName: a.firstName, deletedAt: null, role: a.role as string }
          : null;
      }
      return prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, firstName: true, deletedAt: true, role: true },
      });
    });
    const gone =
      !user || user.deletedAt ? 'USER_GONE' : user.role !== NOTICE_ROLE ? 'NOT_RECIPIENT' : null;
    if (gone) {
      if ((await claim(userId)).count === 1) {
        await markDelivery(operatorId, userId, docKey, version, 'failed', gone);
        failed++;
      }
      continue;
    }
    const left = budgetMs - (Date.now() - startedAt);
    if (left <= 0 || !(await awaitCampaignSendSlot(left))) {
      deferred = true;
      break;
    }
    if ((await claim(userId)).count !== 1) continue;
    let error: string | null = null;
    try {
      await sendLegalNoticeEmail({
        email: user!.email,
        name: user!.firstName || user!.email,
        ...content,
      });
    } catch (err) {
      error = isUnknownOutcomeError(err) ? TIMEOUT_UNKNOWN : deliveryError(err, user!.email);
      // No raw recipient address in logs (the drain is off-platform): the scrubbed reason only.
      logger.warn({ reason: error, userId, docKey, version }, '[LEGAL-NOTICE] send failed');
    }
    // Outside the try: if this mark throws, the step retries and the row stays `sending`
    // (never re-sent), instead of a delivered mail being recorded as failed.
    await markDelivery(operatorId, userId, docKey, version, error ? 'failed' : 'sent', error);
    if (error) failed++;
    else sent++;
  }
  const remaining = await asOperator(operatorId, () =>
    prisma.legalNoticeDelivery.count({ where: { docKey, version, status: 'queued' } })
  );
  return { sent, failed, remaining, deferred };
}

/**
 * No orphan `queued` rows (queue-then-send fails fast): the job marks what it never reached,
 * at the step cap, when the mailer is not configured, and from its failure handler.
 * With `sendId` (the failure handler) it acts only while THAT send row exists, so a stale
 * run's handler never fails the rows of a newer send of the same version (M1).
 */
export async function failQueuedDeliveries(
  operatorId: string,
  docKey: string,
  version: string,
  reason: string,
  sendId?: string
): Promise<number> {
  return asOperator(operatorId, async () => {
    if (sendId) {
      const own = await prisma.legalNoticeSend.findFirst({
        where: { id: sendId, docKey, version },
        select: { id: true },
      });
      if (!own) return 0;
    }
    const r = await prisma.legalNoticeDelivery.updateMany({
      where: { docKey, version, status: 'queued' },
      data: { status: 'failed', error: reason },
    });
    return r.count;
  });
}

// ---------------------------------------------------------------------------
// Super-admin "Policy updates" (Ruling LEGAL-4): overview, Send, Resume, Retry failed.
// ---------------------------------------------------------------------------

/** Failed deliveries listed per version (the count above is exact; the list is capped). */
export const FAILED_DELIVERIES_LIST_MAX = 100;
/**
 * A `sending` row is normal for the length of one mail. Only one untouched this long is stuck
 * (the job died between claim and mark); it is never re-sent and never completes by itself.
 */
export const LEGAL_NOTICE_STUCK_AFTER_MS = 15 * 60_000;
/** A send with no recipients materialised this long after Send never started its email run. */
export const LEGAL_NOTICE_NO_RUN_AFTER_MS = 10 * 60_000;

export interface FailedDeliveryRow {
  maskedEmail: string;
  error: string | null;
  at: string;
}

export interface LegalPolicyOverviewRow {
  docKey: LegalDocKey;
  title: { ar: string; en: string };
  current: LegalVersion;
  send: { sentAt: string; sentBy: string; recipientCount: number | null } | null;
  /** `sending` counts every claimed row, healthy (mid-mail) or not; see `stuckSending`. */
  deliveries: { queued: number; sending: number; sent: number; failed: number };
  /** `sending` rows untouched for LEGAL_NOTICE_STUCK_AFTER_MS: the only ones labelled stuck (I4). */
  stuckSending: number;
  /** Send pressed more than LEGAL_NOTICE_NO_RUN_AFTER_MS ago and no recipients materialised (I4). */
  noRun: boolean;
  /**
   * The email run is not moving: no recipients (noRun), or rows still `queued` with no delivery
   * touched for LEGAL_NOTICE_STUCK_AFTER_MS. The page offers "Resume" (I5).
   */
  stalled: boolean;
  /** Newest first, capped at FAILED_DELIVERIES_LIST_MAX (A11: no SQL-only runbook step). */
  failedDeliveries: FailedDeliveryRow[];
  /**
   * Rows that failed with TIMEOUT_UNKNOWN: the mail MAY have been delivered. NOT counted in
   * `deliveries.failed`, NOT requeued by Retry failed; listed separately, newest first.
   */
  unknownOutcome: number;
  unknownDeliveries: FailedDeliveryRow[];
  acceptedCount: number;
  /** Material, current, not yet announced, and (fee change) still 30 days out. */
  canSend: boolean;
  /** Why a material, unsent version cannot be sent (I1): too late for a fee change's 30 days. */
  sendBlocked: 'NOTICE_TOO_LATE' | null;
}

/** The super-admin page: each document's current version, its notice and delivery state. */
export async function policyOverview(
  operatorId: string,
  now: Date = new Date()
): Promise<LegalPolicyOverviewRow[]> {
  return asOperator(operatorId, async () => {
    const sends = await prisma.legalNoticeSend.findMany({
      select: { docKey: true, version: true, sentAt: true, sentBy: true, recipientCount: true },
    });
    const stuckBefore = new Date(now.getTime() - LEGAL_NOTICE_STUCK_AFTER_MS);
    const rows: LegalPolicyOverviewRow[] = [];
    for (const docKey of LEGAL_DOC_KEYS) {
      const current = currentLegalVersion(activePolicies, docKey);
      const version = current.version;
      const send = sends.find(s => s.docKey === docKey && s.version === version) ?? null;
      const deliveries = { queued: 0, sending: 0, sent: 0, failed: 0 };
      let failedDeliveries: FailedDeliveryRow[] = [];
      let unknownDeliveries: FailedDeliveryRow[] = [];
      let unknownOutcome = 0;
      let stuckSending = 0;
      let noRun = false;
      let stalled = false;
      if (send) {
        const grouped = await prisma.legalNoticeDelivery.groupBy({
          by: ['status'],
          where: { docKey, version },
          _count: { _all: true },
          _max: { updatedAt: true },
        });
        let lastActivity = send.sentAt.getTime();
        for (const g of grouped) {
          if (g.status in deliveries)
            deliveries[g.status as keyof typeof deliveries] = g._count._all;
          const at = g._max.updatedAt?.getTime() ?? 0;
          if (g.status !== 'queued' && at > lastActivity) lastActivity = at;
        }
        if (deliveries.sending > 0) {
          stuckSending = await prisma.legalNoticeDelivery.count({
            where: { docKey, version, status: 'sending', updatedAt: { lt: stuckBefore } },
          });
        }
        noRun =
          send.recipientCount === null &&
          now.getTime() - send.sentAt.getTime() > LEGAL_NOTICE_NO_RUN_AFTER_MS;
        stalled =
          noRun ||
          (deliveries.queued > 0 && now.getTime() - lastActivity > LEGAL_NOTICE_STUCK_AFTER_MS);
        if (deliveries.failed > 0) {
          unknownOutcome = await prisma.legalNoticeDelivery.count({
            where: { docKey, version, status: 'failed', error: TIMEOUT_UNKNOWN },
          });
          deliveries.failed -= unknownOutcome;
          const failed = await prisma.legalNoticeDelivery.findMany({
            where: { docKey, version, status: 'failed' },
            orderBy: { updatedAt: 'desc' },
            take: FAILED_DELIVERIES_LIST_MAX,
            select: { userId: true, error: true, updatedAt: true },
          });
          const users = (await platformHubOnD1())
            ? await getAccountsBrief(failed.map(f => f.userId))
            : await prisma.user.findMany({
                where: { id: { in: failed.map(f => f.userId) } },
                select: { id: true, email: true },
              });
          const emailOf = new Map(users.map(u => [u.id, u.email]));
          const toRow = (f: (typeof failed)[number]): FailedDeliveryRow => ({
            maskedEmail: maskEmail(emailOf.get(f.userId)) ?? '***',
            error: f.error
              ? scrubEmails(f.error, [emailOf.get(f.userId)]).slice(0, ERROR_MAX)
              : null,
            at: f.updatedAt.toISOString(),
          });
          failedDeliveries = failed.filter(f => f.error !== TIMEOUT_UNKNOWN).map(toRow);
          unknownDeliveries = failed.filter(f => f.error === TIMEOUT_UNKNOWN).map(toRow);
        }
      }
      const acceptedCount = await prisma.legalAcceptance.count({ where: { docKey, version } });
      const sendBlocked =
        current.material && !send && feeNoticeTooLate(current, now) ? 'NOTICE_TOO_LATE' : null;
      rows.push({
        docKey,
        title: LEGAL_DOC_TITLE[docKey],
        current,
        send: send
          ? {
              sentAt: send.sentAt.toISOString(),
              sentBy: send.sentBy,
              recipientCount: send.recipientCount,
            }
          : null,
        deliveries,
        stuckSending,
        noRun,
        stalled,
        failedDeliveries,
        unknownOutcome,
        unknownDeliveries,
        acceptedCount,
        canSend: current.material && !send && !sendBlocked,
        sendBlocked,
      });
    }
    return rows;
  });
}

async function emitSendRequested(data: {
  sendId: string;
  docKey: string;
  version: string;
  sentBy: string;
}): Promise<void> {
  await inngest.send({ name: 'legal/notice.send-requested', data });
}

/**
 * Announce a material version: one `legal_notice_sends` row (UNIQUE per version -> a second
 * click is 409), then the Inngest event. Queue-then-send fails fast: if the enqueue throws,
 * the row is removed and the caller gets 502, so nothing is left half-announced (no banner
 * without an email run). Writes run as the acting super admin (RLS: sends are super-admin-write).
 *
 * A fee change is refused (422 NOTICE_TOO_LATE) when its effective date is less than
 * LEGAL_FEE_NOTICE_DAYS after NOW: the 30 days the Terms promise run from when merchants are
 * told, not from publishedAt (I1). Non-fee material changes have no minimum.
 */
export async function requestNoticeSend(
  operatorId: string,
  docKey: string,
  version: string,
  now: Date = new Date()
): Promise<{ docKey: string; version: string; sentAt: string }> {
  if (!isLegalDocKey(docKey)) throw new AppError(404, 'NOT_FOUND', 'Unknown legal document');
  const current = currentLegalVersion(activePolicies, docKey);
  if (current.version !== version) {
    throw new AppError(
      422,
      'NOT_CURRENT',
      'Only the current version of a document can be announced'
    );
  }
  if (!current.material) {
    throw new AppError(
      422,
      'NOT_MATERIAL',
      'This version is not marked material in LEGAL_POLICIES'
    );
  }
  if (feeNoticeTooLate(current, now)) {
    throw new AppError(
      422,
      'NOTICE_TOO_LATE',
      'A fee change needs 30 days between the notice and its effective date. Move effectiveAt later in LEGAL_POLICIES and redeploy.'
    );
  }
  let row: { id: string; sentAt: Date };
  try {
    row = await asOperator(operatorId, () =>
      prisma.legalNoticeSend.create({
        data: { docKey, version, sentBy: operatorId },
        select: { id: true, sentAt: true },
      })
    );
  } catch (err) {
    if (isP2002(err)) {
      throw new AppError(409, 'ALREADY_SENT', 'A notice for this version was already sent');
    }
    throw err;
  }
  try {
    await emitSendRequested({ sendId: row.id, docKey, version, sentBy: operatorId });
  } catch (err) {
    logger.error(
      { err, docKey, version },
      '[LEGAL-NOTICE] enqueue failed, withdrawing the send row'
    );
    let withdrawn = 0;
    let withdrawError: unknown = null;
    try {
      withdrawn = await asOperator(operatorId, () => withdrawLegalNoticeSend(row.id, operatorId));
    } catch (e) {
      withdrawError = e;
    }
    if (withdrawn !== 1) {
      // The row stays announced (banner on) and the send may or may not have started: never
      // tell the operator "nothing was sent".
      logger.error(
        { err: withdrawError, docKey, version, withdrawn },
        '[LEGAL-NOTICE] could not withdraw the send row after an enqueue failure'
      );
      await sendAlert({
        level: 'p1',
        source: 'legal.notice.withdraw_failed',
        // The doc + version in the title: two documents within the dedupe window are two alerts (M10).
        title: `Legal notice ${docKey}@${version} announced but its email run may not have started`,
        body:
          `Enqueueing the ${docKey}@${version} notice failed and the send row could not be ` +
          `withdrawn (${withdrawError ? 'withdraw errored' : "refused: deliveries already exist or the row is not the caller's fresh one"}). ` +
          `Merchants may see the banner without an email run. Check the Policy updates page ` +
          `(Resume) and docs/runbooks/legal-policy-change.md § Recover a stalled or failed run.`,
        context: { docKey, version, withdrawn },
      }).catch(() => undefined);
      throw new AppError(
        502,
        'WITHDRAW_FAILED',
        'The notice is recorded but its email run could not be confirmed. Check the Policy updates page before retrying.'
      );
    }
    throw new AppError(
      502,
      'ENQUEUE_FAILED',
      'Could not start the email send; nothing was sent. Try again.'
    );
  }
  return { docKey, version, sentAt: row.sentAt.toISOString() };
}

async function findSendRow(
  operatorId: string,
  docKey: string,
  version: string
): Promise<{ id: string }> {
  if (!isLegalDocKey(docKey)) throw new AppError(404, 'NOT_FOUND', 'Unknown legal document');
  // A superseded version can no longer be acknowledged by merchants: never re-mail it.
  if (currentLegalVersion(activePolicies, docKey).version !== version) {
    throw new AppError(
      409,
      'NOT_CURRENT',
      'This version is no longer the current version of the document'
    );
  }
  const send = await asOperator(operatorId, () =>
    prisma.legalNoticeSend.findUnique({
      where: { docKey_version: { docKey, version } },
      select: { id: true },
    })
  );
  if (!send) throw new AppError(404, 'NOT_SENT', 'No notice was sent for this version');
  return send;
}

/**
 * "Resume" (I5): re-emit the fan-out event for an existing send, acting as `operatorId`.
 * Safe to press at any time: the run materialises recipients only if none were
 * (recipient_count IS NULL), then mails only `queued` rows, each claimed queued -> sending
 * first, so nobody is mailed twice. Rows in `sending` are never touched.
 */
export async function resumeNoticeSend(
  operatorId: string,
  docKey: string,
  version: string
): Promise<{ docKey: string; version: string }> {
  const send = await findSendRow(operatorId, docKey, version);
  try {
    await emitSendRequested({ sendId: send.id, docKey, version, sentBy: operatorId });
  } catch (err) {
    logger.error({ err, docKey, version }, '[LEGAL-NOTICE] resume enqueue failed');
    throw new AppError(502, 'ENQUEUE_FAILED', 'Could not start the email run. Try again.');
  }
  return { docKey, version };
}

/**
 * "Retry failed" (I5): move this send's `failed` rows back to `queued` (an UPDATE: DELETE is
 * revoked on deliveries; RLS admits it for a super admin only), then Resume. `sending` and `sent`
 * rows are never touched, so nobody already mailed is mailed again. If the enqueue fails, the
 * rows it moved go back to `failed` (RETRY_ENQUEUE_FAILED): no orphan `queued` rows.
 */
export async function retryFailedDeliveries(
  operatorId: string,
  docKey: string,
  version: string
): Promise<{ docKey: string; version: string; requeued: number }> {
  const send = await findSendRow(operatorId, docKey, version);
  const moved = await asOperator(operatorId, async () => {
    const failed = await prisma.legalNoticeDelivery.findMany({
      // TIMEOUT_UNKNOWN rows may have been delivered: never re-sent here. NOT IN would drop
      // NULL errors, hence the explicit OR.
      where: {
        docKey,
        version,
        status: 'failed',
        OR: [{ error: null }, { error: { not: TIMEOUT_UNKNOWN } }],
      },
      select: { userId: true },
    });
    const ids = failed.map(f => f.userId);
    if (ids.length === 0) return ids;
    await prisma.legalNoticeDelivery.updateMany({
      where: { docKey, version, status: 'failed', userId: { in: ids } },
      data: { status: 'queued', error: null },
    });
    return ids;
  });
  if (moved.length === 0) return { docKey, version, requeued: 0 };
  try {
    await emitSendRequested({ sendId: send.id, docKey, version, sentBy: operatorId });
  } catch (err) {
    logger.error({ err, docKey, version }, '[LEGAL-NOTICE] retry enqueue failed, re-failing rows');
    await asOperator(operatorId, () =>
      prisma.legalNoticeDelivery.updateMany({
        where: { docKey, version, status: 'queued', userId: { in: moved } },
        data: { status: 'failed', error: 'RETRY_ENQUEUE_FAILED' },
      })
    );
    throw new AppError(502, 'ENQUEUE_FAILED', 'Could not start the email run. Try again.');
  }
  return { docKey, version, requeued: moved.length };
}

// ---------------------------------------------------------------------------
// Acceptance records (I6, "every data has a UI"): the dispute evidence LEGAL-4 cites.
// ---------------------------------------------------------------------------

export interface AcceptanceRecord {
  docKey: string;
  version: string;
  source: string;
  acceptedAt: string;
}

/** The signed-in user's own acceptance rows, newest first (merchant account settings). */
export async function myAcceptances(userId: string): Promise<AcceptanceRecord[]> {
  const rows = await inUserScope(userId, tx =>
    tx.legalAcceptance.findMany({
      where: { userId },
      orderBy: [{ acceptedAt: 'desc' }, { docKey: 'asc' }],
      select: { docKey: true, version: true, source: true, acceptedAt: true },
    })
  );
  return rows.map(r => ({ ...r, acceptedAt: r.acceptedAt.toISOString() }));
}

export interface UserLegalRecord {
  acceptances: Array<AcceptanceRecord & { maskedIp: string | null }>;
  deliveries: Array<{
    docKey: string;
    version: string;
    status: string;
    error: string | null;
    at: string;
  }>;
}

/**
 * One account's acceptances (with masked IP) and notice deliveries, for the super-admin user
 * page: the answer to "I never agreed" without SQL. Read as the operator.
 */
export async function userLegalRecord(
  operatorId: string,
  userId: string
): Promise<UserLegalRecord> {
  return asOperator(operatorId, async () => {
    const acceptances = await prisma.legalAcceptance.findMany({
      where: { userId },
      orderBy: [{ acceptedAt: 'desc' }, { docKey: 'asc' }],
      select: { docKey: true, version: true, source: true, acceptedAt: true, ip: true },
    });
    const account = (await platformHubOnD1())
      ? ((await getAccountsBrief([userId]))[0] ?? null)
      : await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const deliveries = await prisma.legalNoticeDelivery.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: { docKey: true, version: true, status: true, error: true, updatedAt: true },
    });
    return {
      acceptances: acceptances.map(a => ({
        docKey: a.docKey,
        version: a.version,
        source: a.source,
        acceptedAt: a.acceptedAt.toISOString(),
        maskedIp: maskIp(a.ip),
      })),
      deliveries: deliveries.map(d => ({
        docKey: d.docKey,
        version: d.version,
        status: d.status,
        error: d.error ? scrubEmails(d.error, [account?.email]).slice(0, ERROR_MAX) : null,
        at: d.updatedAt.toISOString(),
      })),
    };
  });
}
