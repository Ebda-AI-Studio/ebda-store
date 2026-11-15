/**
 * SELF-SERVICE trust and support (A13 suspension reason + appeal, A14 support request, A16 slug claim + store cap).
 *
 * One table (`trust_requests`, kind column). A merchant FILES a request; staff DECIDE it. This module has no function
 * that sets `resolved`/`rejected` on a merchant's behalf, and the routes expose none. The ONLY write that reaches
 * `resolved` is `closeAppealsOnReactivation`, called by the super-admin status route.
 *
 * Callers run these inside the request's tenant scope (store routes: `prisma`) or `withUser(userId, tx => ...)`
 * (the two pre-store kinds), so RLS applies as well as the explicit store/user filters below.
 *
 * Super-admin override stays on every route: staff reactivate a store, lift a protected slug (`allowProtected`) and
 * raise the daily cap through the existing super-admin paths; nothing here bypasses them.
 */
import { BRAND, validateStoreSlug, type SupportTopic } from '@ebda/shared';
import { AppError } from '../middleware/error-handler';
import { withSavepoint } from '../lib/savepoint';
import { isP2002 } from '../lib/prisma-errors';
import logger from '../lib/logger';
import { sendAlert } from './alerts.service';
import { emailQueue } from './email-queue.service';

/** Support requests per store per UTC day (slots 1..N, each claimed by a unique insert). */
const SUPPORT_REQUESTS_PER_DAY = 5;
/** A rejected appeal cannot be re-filed for this long (staff replied; no hammering). */
const APPEAL_COOLDOWN_MS = 24 * 3600_000;
/** Open protected-address claims one user may hold at once. */
const MAX_OPEN_SLUG_CLAIMS = 3;

/** The slice of the Prisma client these functions use (the tenant tx, `prisma`, or `withUser`'s tx). */
export interface TrustDb {
  trustRequest: {
    create(args: { data: Record<string, unknown> }): Promise<TrustRow>;
    findFirst(args: Record<string, unknown>): Promise<TrustRow | null>;
    count(args: Record<string, unknown>): Promise<number>;
    updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  };
  store: {
    findUnique(args: Record<string, unknown>): Promise<{
      status: string;
      billingSuspendedReason: string | null;
      billingSuspendedAt?: Date | null;
    } | null>;
  };
}
interface TrustRow {
  id: string;
  kind: string;
  status: string;
  message?: string | null;
  createdAt: Date;
}

interface Requester {
  userId: string;
  email?: string;
}

// ---------------------------------------------------------------------------
// Notification (best effort: the row is the record)
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

/**
 * Email the support inbox + an info alert. Called AFTER the request transaction committed.
 * The FULL text (merchant e-mail, free-text message: may hold customer names/phones) goes ONLY in the e-mail.
 * The alert is routine and non-paging (level info) and carries ids + kind/topic only (Telegram/brain mirror = no PII).
 */
export async function notifyStaff(args: {
  subject: string;
  lines: string[];
  replyTo?: string;
  storeId?: string;
  /** Ids-only alert payload: request id, kind (support, suspension_appeal, slug_claim, store_cap), topic if any. */
  ref: { requestId: string; kind: string; topic?: string };
}): Promise<{ emailQueued: boolean }> {
  let emailQueued = false;
  try {
    await emailQueue.enqueue(null, {
      to: BRAND.supportEmail,
      subject: args.subject,
      text: args.lines.join('\n'),
      html: `<p>${args.lines.map(esc).join('<br>')}</p>`,
      ...(args.replyTo ? { replyTo: args.replyTo } : {}),
    });
    emailQueued = true;
  } catch (err) {
    logger.error({ err, subject: args.subject }, '[TRUST] could not queue the staff email');
  }
  void sendAlert({
    level: 'info',
    scope: args.storeId ? 'store' : 'platform',
    ...(args.storeId ? { store: { id: args.storeId, name: args.storeId } } : {}),
    source: 'trust-requests',
    title: `Trust request: ${args.ref.kind}`,
    body: [
      args.storeId ? `store=${args.storeId}` : '',
      `request=${args.ref.requestId}`,
      `kind=${args.ref.kind}`,
      args.ref.topic ? `topic=${args.ref.topic}` : '',
    ]
      .filter(l => l !== '')
      .join('\n'),
  } as Parameters<typeof sendAlert>[0]).catch(() => undefined);
  return { emailQueued };
}

// ---------------------------------------------------------------------------
// A14 support request
// ---------------------------------------------------------------------------

export async function createSupportRequest(
  db: TrustDb,
  storeId: string,
  who: Requester,
  input: { topic: SupportTopic; message: string; pageUrl?: string }
): Promise<TrustRow> {
  // Atomic and backend-neutral (Postgres and D1): each request claims one slot 1..N for (store, UTC day) through the
  // partial UNIQUE (store_id, cap_day, cap_slot). A burst cannot overrun: the loser gets a unique violation and
  // takes the next slot, and once all N are taken it is refused. No advisory lock, no read-then-write.
  const capDay = new Date().toISOString().slice(0, 10);
  const used = await db.trustRequest.count({
    where: { storeId, kind: 'support', capDay },
  });
  for (let slot = used + 1; slot <= SUPPORT_REQUESTS_PER_DAY; slot++) {
    try {
      return await withSavepoint(() =>
        db.trustRequest.create({
          data: {
            kind: 'support',
            storeId,
            userId: who.userId,
            topic: input.topic,
            message: input.message,
            pageUrl: input.pageUrl ?? null,
            capDay,
            capSlot: slot,
          },
        })
      );
    } catch (err) {
      if (!isP2002(err)) throw err; // slot taken by a parallel request: try the next one
    }
  }
  throw new AppError(
    429,
    'SUPPORT_REQUEST_LIMIT',
    `You can send ${SUPPORT_REQUESTS_PER_DAY} requests a day. Please try again tomorrow.`
  );
}

// ---------------------------------------------------------------------------
// A13 suspension reason + appeal
// ---------------------------------------------------------------------------

/**
 * Super-admin side: remember WHY a store was suspended so the merchant can read it. Never on a reactivation.
 * One note per suspension EPISODE: written when the store is not already suspended (even with no reason, so a stale
 * note from an earlier episode can never be shown), and on a repeat suspend only when a new reason is given. A repeat
 * suspend with no reason writes nothing, so it never masks the real reason with null. `getSuspension` reads the latest
 * note, which is therefore always the current episode's. Returns whether a note was written.
 */
export async function recordSuspension(
  db: TrustDb,
  storeId: string,
  actor: { userId: string },
  reason: string | undefined,
  alreadySuspended: boolean
): Promise<boolean> {
  if (alreadySuspended && !reason) return false;
  await db.trustRequest.create({
    data: { kind: 'suspension', storeId, userId: actor.userId, message: reason ?? null },
  });
  return true;
}

/**
 * Super-admin side: reject the open appeal (staff replied by e-mail, the store stays suspended). Stamps `rejected_at`,
 * which starts the merchant's 24 h cooldown. 404 when there is no open appeal.
 */
export async function rejectAppeal(db: TrustDb, storeId: string): Promise<{ id: string }> {
  const open = await db.trustRequest.findFirst({
    where: { storeId, kind: 'suspension_appeal', status: 'open' },
  });
  if (!open) throw new AppError(404, 'NO_OPEN_APPEAL', 'This store has no open appeal');
  // conditional on still being open: two staff clicking at once reject it once
  const { count } = await db.trustRequest.updateMany({
    where: { id: open.id, storeId, status: 'open' },
    data: { status: 'rejected', rejectedAt: new Date() },
  });
  if (count === 0) throw new AppError(404, 'NO_OPEN_APPEAL', 'This store has no open appeal');
  return { id: open.id };
}

/** Reactivation resolves the open appeal (staff acted on it). Super-admin status route only. */
export async function closeAppealsOnReactivation(db: TrustDb, storeId: string): Promise<void> {
  await db.trustRequest.updateMany({
    where: { storeId, kind: 'suspension_appeal', status: 'open' },
    data: { status: 'resolved' },
  });
}

interface SuspensionView {
  kind: 'policy' | 'billing';
  reason: string | null;
  suspendedAt: string | null;
  appeal: { status: string; createdAt: string } | null;
}

async function suspendedStore(db: TrustDb, storeId: string) {
  const store = await db.store.findUnique({
    where: { id: storeId },
    select: { status: true, billingSuspendedReason: true, billingSuspendedAt: true },
  });
  // Not suspended (or not there): the same 404 for both, nothing about the store is revealed.
  if (!store || store.status !== 'suspended') {
    throw new AppError(404, 'NOT_SUSPENDED', 'This store is not suspended');
  }
  return store;
}

export async function getSuspension(db: TrustDb, storeId: string): Promise<SuspensionView> {
  const store = await suspendedStore(db, storeId);
  const appeal = await db.trustRequest.findFirst({
    where: { storeId, kind: 'suspension_appeal' },
    orderBy: { createdAt: 'desc' },
  });
  const appealView = appeal
    ? { status: appeal.status, createdAt: appeal.createdAt.toISOString() }
    : null;
  if (store.billingSuspendedReason) {
    return {
      kind: 'billing',
      reason: store.billingSuspendedReason,
      suspendedAt: store.billingSuspendedAt?.toISOString() ?? null,
      appeal: appealView,
    };
  }
  const note = await db.trustRequest.findFirst({
    where: { storeId, kind: 'suspension' },
    orderBy: { createdAt: 'desc' },
  });
  return {
    kind: 'policy',
    reason: note?.message ?? null,
    suspendedAt: note?.createdAt.toISOString() ?? null,
    appeal: appealView,
  };
}

export async function fileAppeal(
  db: TrustDb,
  storeId: string,
  who: Requester,
  message: string
): Promise<TrustRow> {
  const store = await suspendedStore(db, storeId);
  if (store.billingSuspendedReason) {
    throw new AppError(
      409,
      'BILLING_SUSPENSION',
      'This suspension is about billing. Settle the invoice, or contact Ebda Store.'
    );
  }
  const open = await db.trustRequest.findFirst({
    where: { storeId, kind: 'suspension_appeal', status: 'open' },
  });
  if (open)
    throw new AppError(409, 'APPEAL_ALREADY_OPEN', 'You already have an appeal under review');
  const rejected = await db.trustRequest.findFirst({
    where: {
      storeId,
      kind: 'suspension_appeal',
      status: 'rejected',
      rejectedAt: { gte: new Date(Date.now() - APPEAL_COOLDOWN_MS) },
    },
  });
  if (rejected)
    throw new AppError(
      429,
      'APPEAL_COOLDOWN',
      'Your last appeal was declined. You can send another one in 24 hours.'
    );
  try {
    // the partial UNIQUE (one open appeal per store) settles a double click that passes the check above
    return await withSavepoint(() =>
      db.trustRequest.create({
        data: { kind: 'suspension_appeal', storeId, userId: who.userId, message },
      })
    );
  } catch (err) {
    if (isP2002(err))
      throw new AppError(409, 'APPEAL_ALREADY_OPEN', 'You already have an appeal under review');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// A16 protected slug claim + daily store cap request (filed before a store exists, keyed on the user)
// ---------------------------------------------------------------------------

export async function fileSlugClaim(
  db: TrustDb,
  who: Requester,
  input: { slug: string; evidence: string; evidenceUrl?: string }
): Promise<TrustRow> {
  const slug = input.slug.trim().toLowerCase();
  const check = validateStoreSlug(slug);
  if (check.ok) {
    throw new AppError(400, 'SLUG_NOT_PROTECTED', 'This address is not protected, just use it');
  }
  if (check.code !== 'SLUG_PROTECTED') {
    throw new AppError(400, check.code, check.message);
  }
  const open = await db.trustRequest.findFirst({
    where: { userId: who.userId, kind: 'slug_claim', slug, status: 'open' },
  });
  if (open) throw new AppError(409, 'CLAIM_ALREADY_OPEN', 'You already claimed this address');
  // Residual (Ruling TRUST-1): the per-user cap is count-then-insert with no unique slot (claims have no store id),
  // so a parallel burst by ONE authenticated, rate-limited user could exceed 3 by the burst size. Staff decide every
  // claim; cost if wrong: a few extra review items from one account.
  const openClaims = await db.trustRequest.count({
    where: { userId: who.userId, kind: 'slug_claim', status: 'open' },
  });
  if (openClaims >= MAX_OPEN_SLUG_CLAIMS)
    throw new AppError(
      429,
      'TOO_MANY_OPEN_CLAIMS',
      `You can have ${MAX_OPEN_SLUG_CLAIMS} address claims under review at once. Wait for a decision first.`
    );
  try {
    return await withSavepoint(() =>
      db.trustRequest.create({
        data: {
          kind: 'slug_claim',
          userId: who.userId,
          slug,
          message: input.evidence,
          evidenceUrl: input.evidenceUrl ?? null,
        },
      })
    );
  } catch (err) {
    if (isP2002(err))
      throw new AppError(409, 'CLAIM_ALREADY_OPEN', 'You already claimed this address');
    throw err;
  }
}

export async function fileStoreCapRequest(
  db: TrustDb,
  who: Requester,
  input: { message: string; evidenceUrl?: string }
): Promise<TrustRow> {
  const open = await db.trustRequest.findFirst({
    where: { userId: who.userId, kind: 'store_cap', status: 'open' },
  });
  if (open)
    throw new AppError(409, 'CAP_REQUEST_ALREADY_OPEN', 'You already asked for a higher limit');
  try {
    return await withSavepoint(() =>
      db.trustRequest.create({
        data: {
          kind: 'store_cap',
          userId: who.userId,
          message: input.message,
          evidenceUrl: input.evidenceUrl ?? null,
        },
      })
    );
  } catch (err) {
    if (isP2002(err))
      throw new AppError(409, 'CAP_REQUEST_ALREADY_OPEN', 'You already asked for a higher limit');
    throw err;
  }
}
