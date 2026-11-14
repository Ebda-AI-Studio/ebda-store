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

/** Support requests per store per rolling 24 h. */
const SUPPORT_REQUESTS_PER_DAY = 5;

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

/** Email the support inbox + P1 alert. Called AFTER the request transaction committed. */
export async function notifyStaff(args: {
  subject: string;
  lines: string[];
  replyTo?: string;
  storeId?: string;
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
    level: 'p1',
    scope: args.storeId ? 'store' : 'platform',
    ...(args.storeId ? { store: { id: args.storeId, name: args.storeId } } : {}),
    source: 'trust-requests',
    title: args.subject,
    body: args.lines.join('\n'),
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
  const since = new Date(Date.now() - 24 * 3600_000);
  const today = await db.trustRequest.count({
    where: { storeId, kind: 'support', createdAt: { gte: since } },
  });
  if (today >= SUPPORT_REQUESTS_PER_DAY) {
    throw new AppError(
      429,
      'SUPPORT_REQUEST_LIMIT',
      `You can send ${SUPPORT_REQUESTS_PER_DAY} requests a day. Please try again tomorrow.`
    );
  }
  return db.trustRequest.create({
    data: {
      kind: 'support',
      storeId,
      userId: who.userId,
      topic: input.topic,
      message: input.message,
      pageUrl: input.pageUrl ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// A13 suspension reason + appeal
// ---------------------------------------------------------------------------

/** Super-admin side: remember WHY a store was suspended so the merchant can read it. Never on a reactivation. */
export async function recordSuspension(
  db: TrustDb,
  storeId: string,
  actor: { userId: string },
  reason: string | undefined
): Promise<void> {
  await db.trustRequest.create({
    data: { kind: 'suspension', storeId, userId: actor.userId, message: reason ?? null },
  });
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
