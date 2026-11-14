/**
 * InstaPay auto-confirm for a merchant's SUBSCRIPTION payment (Ruling INSTAPAY-AUTO-1; plan 2026-11-14-instapay-auto-confirm S4 + S5 + S6).
 *
 * The model only EXTRACTS (typed object, foundation `instapay-extract`); this file and the foundation's `decideInstapay` DECIDE. A receipt
 * that fully matches (amount === the quoted charge to the piastre, recipient === Ebda's handle, transfer within 48 h, reference and image
 * never seen on ANY merchant or product, under the first-payment cap, switches on) activates through the SAME `recordManualPayment` the
 * human path uses. Anything off waits for Ahmad (the existing human review is unchanged).
 *
 * State machine (foundation `nextAutoState`): pending_decision -> auto_confirmed | needs_human | failed; auto_confirmed -> reverted.
 * Money: integer piastres; idempotent on `autoConfirmKey('store', receiptId)` AND on recordManualPayment's own `manual:instapay:<ref>`.
 * Compensation: a failed activation releases ONLY the dedupe claim this call made, and only when no ledger row exists for the key.
 */
import crypto from 'node:crypto';
import { prisma, withStore } from '@ebda/database';
import {
  REASON_ORDER,
  REVERT_GRACE_MS,
  autoConfirmKey,
  decideInstapay,
  firstPaymentCapMinor,
  isCleanPayment,
  nextAutoState,
  normalizeInstapayReference,
  normalizeReferenceKey,
  revertGraceUntil,
  type AutoEvent,
  type AutoState,
  type DecisionInput,
  type ParsedExtraction,
  type ReasonCode,
  type ReceiptExtract,
} from '@ebda/shared';
import { AppError } from '../../middleware/error-handler';
import { auditLog } from '../../middleware/security';
import logger from '../../lib/logger';
import { sendAlert } from '../alerts.service';
import { getDuplicateIndex } from '../../lib/instapay-dedupe';
import { platformDb } from '../../lib/platform-db';
import { platformFamilyOnD1 } from '../platform/cutover';
import { autoReadOf } from '../payment-providers/instapay-receipt.service';
import { instapayHandle } from './manual-config';
import { chargeFor } from './charge-amount';
import { isInterval, type BillingInterval } from './period';
import { manualPaymentKey, recordManualPayment, recordManualRefund } from './account.service';
import {
  getAutoMode,
  isStoreAutoEnabled,
  setStoreAuto,
  type AutoMode,
} from './instapay-auto-settings';
import { notifyBrain } from './instapay-notify-brain';
import { runBillingEffects } from './billing-notify';

export const AUTO_ACTOR = 'system:auto-confirm';
/** A pure switch outcome (off / shadow / store off) is the normal manual flow, not "waiting on you". */
const QUIET_REASONS: ReadonlySet<ReasonCode> = new Set([
  'SHADOW_MODE',
  'KILL_GLOBAL',
  'KILL_STORE',
]);

export type AutoOutcome = {
  state: AutoState | 'skipped';
  reasons: ReasonCode[];
  billingEventId?: string;
  id?: string;
};

type RowShape = {
  id: string;
  storeId: string;
  claimId: string;
  receiptId: string;
  state: string;
  verdict: string | null;
  reasons: string[];
  amountMinor: number | null;
  billingEventId: string | null;
  confirmedAt: Date | null;
  digestSentAt: Date | null;
  revertedAt: Date | null;
  graceUntil: Date | null;
  createdAt: Date;
};

const sortReasons = (r: Iterable<ReasonCode>): ReasonCode[] => {
  const have = new Set(r);
  return REASON_ORDER.filter(x => have.has(x));
};

const asOutcome = (row: RowShape): AutoOutcome => ({
  state: row.state as AutoState,
  reasons: row.reasons as ReasonCode[],
  billingEventId: row.billingEventId ?? undefined,
  id: row.id,
});

/** What a row keeps of the receipt read: amount, reference, date, handle only (never the image, never payer data). */
function masked(extract: ReceiptExtract | null, flags: ParsedExtraction['flags'] | null) {
  return {
    extract: extract
      ? {
          amountMinor: extract.amountMinor,
          reference: extract.reference,
          transferredAt: extract.transferredAt,
          recipientHandle: extract.recipientHandle,
        }
      : null,
    flags,
  };
}

/** Earlier payments of this store that count as CLEAN (INSTAPAY-CLEAN-1): human-confirmed at once, auto only after a SENT digest, never reverted. */
async function hasCleanPayment(storeId: string, now: number): Promise<boolean> {
  const [events, autos] = await withStore(storeId, () =>
    Promise.all([
      prisma.billingEvent.findMany({
        where: { storeId, type: 'manual_payment', status: 'succeeded' },
        select: { id: true, createdAt: true },
        take: 200,
      }),
      prisma.instapayAutoConfirmation.findMany({
        where: { storeId, billingEventId: { not: null } },
        select: { billingEventId: true, confirmedAt: true, digestSentAt: true, revertedAt: true },
        take: 200,
      }),
    ])
  );
  const autoByEvent = new Map(autos.map(a => [a.billingEventId as string, a]));
  return events.some(e => {
    const a = autoByEvent.get(e.id);
    return a
      ? isCleanPayment(
          {
            confirmedBy: 'auto',
            confirmedAt: (a.confirmedAt ?? e.createdAt).getTime(),
            digestSentAt: a.digestSentAt?.getTime() ?? null,
            revertedAt: a.revertedAt?.getTime() ?? null,
          },
          now
        )
      : isCleanPayment(
          {
            confirmedBy: 'human',
            confirmedAt: e.createdAt.getTime(),
            digestSentAt: null,
            revertedAt: null,
          },
          now
        );
  });
}

/** The reference a ledger row of this claim is recorded under (the payer's, as the human path does). */
const claimReference = (c: { payerReference: string }) =>
  normalizeInstapayReference(c.payerReference) ?? c.payerReference;

async function ownerLabel(storeId: string): Promise<string> {
  try {
    const s = await withStore(storeId, () =>
      prisma.store.findUnique({ where: { id: storeId }, select: { name: true } })
    );
    return (s?.name ?? storeId.slice(0, 8)).slice(0, 80);
  } catch {
    return storeId.slice(0, 8);
  }
}

/** "waiting on you" notice for a payment that needs Ahmad; best effort (the daily digest also lists pending claims). */
async function notifyWaiting(
  row: RowShape,
  amountMinor: number,
  reasons: ReasonCode[]
): Promise<void> {
  try {
    await notifyBrain('waiting', [
      {
        product: 'store',
        id: row.id,
        ownerLabel: await ownerLabel(row.storeId),
        amountMinor,
        kind: 'subscription',
        confirmedAt: row.createdAt.getTime(),
        reasons,
      },
    ]);
  } catch (err) {
    logger.warn({ err, id: row.id }, '[instapay-auto] waiting notice failed');
  }
}

export async function decideAndActivate(args: {
  storeId: string;
  claimId: string;
  now?: number;
}): Promise<AutoOutcome> {
  const { storeId, claimId } = args;
  const now = args.now ?? Date.now();

  const [claim, receipt] = await withStore(storeId, () =>
    Promise.all([
      prisma.manualPaymentClaim.findFirst({ where: { id: claimId, storeId } }),
      prisma.instapayReceipt.findFirst({ where: { storeId, claimId, kind: 'subscription' } }),
    ])
  );
  if (!claim || !receipt || claim.method !== 'instapay') return { state: 'skipped', reasons: [] };

  const key = autoConfirmKey('store', receipt.id);
  // 1. Idempotency: the row is born `pending_decision`; a replay loads it and returns it (never re-decides, never re-activates).
  const existing = await withStore(storeId, () =>
    prisma.instapayAutoConfirmation.findUnique({ where: { idempotencyKey: key } })
  );
  if (existing) return asOutcome(existing as RowShape);
  if (claim.status !== 'pending') return { state: 'skipped', reasons: [] };

  // 2. Inputs. Expected amount = the quoted charge for the CLAIM's plan + interval through the one VAT seam (strict equality).
  const interval: BillingInterval = isInterval(claim.billingInterval)
    ? claim.billingInterval
    : 'monthly';
  const plan = await prisma.plan.findUnique({ where: { code: claim.planCode } });
  const listPrice = plan
    ? interval === 'yearly'
      ? plan.priceYearlyMinor
      : plan.priceMonthlyMinor
    : null;
  const expectedAmountMinor = listPrice ? (await chargeFor(listPrice)).totalMinor : 0;
  const monthlyAmount = plan?.priceMonthlyMinor
    ? (await chargeFor(plan.priceMonthlyMinor)).totalMinor
    : null;
  const parsed = autoReadOf(receipt.extracted);
  const read = parsed?.read ?? null;
  const refKey = read?.extract ? normalizeReferenceKey(read.extract.reference) : null;
  const extract: ReceiptExtract | null =
    read?.extract && refKey ? { ...read.extract, reference: refKey } : null;

  // The read may not have finished yet (the merchant submitted first): wait for it instead of deciding on nothing; the stuck sweep
  // decides anything still undecided 10 minutes after submission.
  if (
    !parsed &&
    receipt.extractionStatus === 'pending' &&
    now - claim.createdAt.getTime() < 10 * 60_000
  ) {
    return { state: 'skipped', reasons: [] };
  }

  // 3. Switches: read from the database on every decision (NEVER-stale), again just before activating.
  let mode: AutoMode = await getAutoMode();
  let storeEnabled = await isStoreAutoEnabled(storeId);

  // 4. Dedupe claim BEFORE the decision (a duplicate is a reason, not an error). Skipped with the switch off: an off store holds no index entries.
  const index = getDuplicateIndex();
  let claimResult:
    | 'claimed'
    | 'ours'
    | 'duplicate_reference'
    | 'duplicate_image'
    | 'unavailable'
    | 'skipped' = 'skipped';
  let duplicate: DecisionInput['duplicate'] = 'none';
  const dedupeEntry = extract
    ? {
        referenceKey: extract.reference,
        imageSha256: receipt.sha256,
        product: 'store' as const,
        ownerId: storeId,
        paymentId: receipt.id,
      }
    : null;
  if (extract && dedupeEntry && mode !== 'off' && storeEnabled) {
    if (!index) {
      claimResult = 'unavailable';
      duplicate = 'reference'; // FAIL CLOSED: no index, no automatic activation
    } else {
      claimResult = await index.claim(dedupeEntry);
      if (claimResult === 'duplicate_reference' || claimResult === 'duplicate_image') {
        duplicate = await index.peek(dedupeEntry.referenceKey, dedupeEntry.imageSha256);
        if (duplicate === 'none')
          duplicate = claimResult === 'duplicate_reference' ? 'reference' : 'image';
      }
    }
  }

  const handle = instapayHandle();
  const isFirstPayment = !(await hasCleanPayment(storeId, now));
  const decideWith = (m: AutoMode, enabled: boolean) => {
    const d = decideInstapay({
      extract,
      expected: { amountMinor: expectedAmountMinor, payeeHandle: handle ?? '' },
      now,
      mode: m,
      storeEnabled: enabled,
      isFirstPayment,
      firstPaymentCapMinor: firstPaymentCapMinor({ monthlyPriceMinor: monthlyAmount }),
      dualControlThresholdMinor: null,
      duplicate,
      flags: read?.flags ?? { looksEdited: false, suspiciousText: false, confidence: 0 },
    });
    const extra = new Set<ReasonCode>(d.reasons);
    // the claim must be the quoted charge too, and the merchant's typed reference must be the one on the image
    if (claim.amountMinor !== expectedAmountMinor) extra.add('AMOUNT_MISMATCH');
    if (extract && claimReference(claim) !== extract.reference) extra.add('EXTRACT_INCOMPLETE');
    if (!handle) extra.add('WRONG_HANDLE');
    const reasons = sortReasons(extra);
    return {
      verdict: reasons.length === 0 ? ('auto_confirm' as const) : ('needs_human' as const),
      reasons,
    };
  };
  let decision = decideWith(mode, storeEnabled);
  const wouldBe = mode === 'shadow' ? decideWith('live', storeEnabled).verdict : decision.verdict;

  // Re-read the switches immediately before money moves: a flip between decision and activation wins.
  if (decision.verdict === 'auto_confirm') {
    mode = await getAutoMode();
    storeEnabled = await isStoreAutoEnabled(storeId);
    if (mode !== 'live' || !storeEnabled) decision = decideWith(mode, storeEnabled);
  }

  // 5. Persist the row (pending_decision first; the unique key makes a concurrent twin lose).
  const created = await withStore(storeId, () =>
    prisma.instapayAutoConfirmation.createMany({
      data: [
        {
          id: crypto.randomUUID(),
          storeId,
          claimId,
          receiptId: receipt.id,
          state: 'pending_decision',
          verdict: wouldBe,
          reasons: decision.reasons,
          amountMinor: extract?.amountMinor ?? null,
          expectedAmountMinor,
          isFirstPayment,
          extractedMasked: masked(extract, read?.flags ?? null),
          idempotencyKey: key,
        },
      ],
      skipDuplicates: true,
    })
  );
  const row = (await withStore(storeId, () =>
    prisma.instapayAutoConfirmation.findUnique({ where: { idempotencyKey: key } })
  )) as RowShape | null;
  if (!row)
    throw new AppError(500, 'AUTO_ROW_MISSING', 'The auto-confirm row could not be read back');
  // lost the race: the winner's call owns the outcome (its dedupe claim has the same payment id, so ours was `ours`)
  if (created.count === 0) return asOutcome(row);

  const settle = async (to: AutoEvent, extra: Record<string, unknown> = {}) => {
    const next = nextAutoState('pending_decision', to);
    if (next === 'illegal') throw new Error(`illegal auto transition ${to}`);
    await withStore(storeId, () =>
      prisma.instapayAutoConfirmation.updateMany({
        where: { id: row.id, storeId, state: 'pending_decision' },
        data: { state: next, ...extra },
      })
    );
    return next;
  };

  // 6a. Waits for a human (mode off / shadow, any reason).
  if (decision.verdict !== 'auto_confirm') {
    const state = await settle('decide_human');
    await auditLog({
      action: 'billing.instapay_auto_decided',
      storeId,
      resourceType: 'instapay_auto_confirmation',
      resourceId: row.id,
      details: {
        state,
        verdict: decision.verdict,
        wouldBe,
        reasons: decision.reasons,
        mode,
        amountMinor: extract?.amountMinor ?? null,
      },
    });
    if (decision.reasons.some(r => !QUIET_REASONS.has(r)))
      await notifyWaiting(row, claim.amountMinor, decision.reasons);
    return { state, reasons: decision.reasons, id: row.id };
  }

  // 6b. Live + auto_confirm: activate through the SAME ledger path as a human. Idempotent on `manual:instapay:<ref>`.
  const reference = claimReference(claim);
  const activate = () =>
    recordManualPayment({
      storeId,
      planCode: claim.planCode,
      interval,
      amountMinor: extract!.amountMinor,
      method: 'instapay',
      reference,
      paidAt: new Date(extract!.transferredAt),
      actorId: AUTO_ACTOR,
      claimId: claim.id,
      now: new Date(now),
    });
  try {
    let paid;
    try {
      paid = await activate();
    } catch (first) {
      // one idempotent retry heals a half-finished manual payment (the ledger key makes it a replay)
      logger.warn(
        { err: first, storeId, claimId },
        '[instapay-auto] activation failed, retrying once'
      );
      paid = await activate();
    }
    const state = await settle('decide_auto', {
      billingEventId: paid.billingEventId,
      confirmedAt: new Date(now),
    });
    await auditLog({
      action: 'billing.instapay_auto_confirmed',
      storeId,
      resourceType: 'instapay_auto_confirmation',
      resourceId: row.id,
      details: {
        billingEventId: paid.billingEventId,
        amountMinor: extract!.amountMinor,
        claimId,
        duplicate: paid.duplicate,
      },
    });
    return { state, reasons: [], billingEventId: paid.billingEventId, id: row.id };
  } catch (err) {
    // Compensation. Free ONLY the dedupe claim this call made (never `ours`), and only when no ledger row exists for the key: a recorded
    // payment keeps its claim (it must stay unreusable), a failed one frees it for the human flow.
    const recorded = await withStore(storeId, () =>
      prisma.billingEvent.findFirst({
        where: { storeId, idempotencyKey: manualPaymentKey('instapay', reference) },
        select: { id: true },
      })
    ).catch(() => null);
    if (!recorded && claimResult === 'claimed' && index && dedupeEntry) {
      await index
        .release(dedupeEntry)
        .catch(releaseErr =>
          logger.error({ err: releaseErr, storeId }, '[instapay-auto] dedupe release failed')
        );
    }
    await settle('activation_failed').catch(() => undefined);
    void sendAlert({
      level: 'p1',
      title: 'InstaPay auto-confirm: activation failed, claim left pending for a human',
      body: `store ${storeId}, claim ${claimId}, row ${row.id}, ledger row ${recorded ? 'EXISTS (retry the manual payment, it is idempotent)' : 'absent'}: ${(err as Error)?.message ?? err}`,
    }).catch(() => undefined);
    await notifyWaiting(row, claim.amountMinor, ['EXTRACT_INCOMPLETE']);
    return { state: 'failed', reasons: [], id: row.id };
  }
}

// ───────────────────────────── revert ("not received") ─────────────────────────────

export type RevertResult = { result: 'reverted' | 'already_reverted'; graceUntil: number };

/**
 * The store of an auto-confirmation row, from its id alone (a Telegram tap carries only the id). Read on the platform D1 client, which has no
 * tenant context by design: the id is an unguessable uuid, the route that calls this verifies the bridge signature first, and the answer
 * is only used to open that row's own store scope (every later query names the store).
 */
export async function autoConfirmationStoreId(id: string): Promise<string | null> {
  const db = (await platformDb()) ?? prisma;
  const row = await db.instapayAutoConfirmation.findFirst({
    where: { id },
    select: { storeId: true },
  });
  return row?.storeId ?? null;
}

/** Super-admin list across stores (newest first). The route is super_admin-only. */
export async function listAutoConfirmationsForAdmin(state?: string, take = 100) {
  const db = (await platformDb()) ?? prisma;
  return db.instapayAutoConfirmation.findMany({
    where: state ? { state } : {},
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(take, 1), 200),
  });
}

/**
 * "Not received": the money did not arrive. Only an `auto_confirmed` row reverts (a human-confirmed payment is Ahmad's own decision).
 * Effects: the existing void path (keeps the reference, forces `past_due` + a 48 h grace when this payment owns the current period, revokes the
 * free months it earned), the dedupe entries are BURNED (a not-received receipt can never auto-confirm again), auto-confirm is switched off for
 * the store until Ahmad re-enables it, the merchant is told. Idempotent: a replay returns `already_reverted` and writes nothing.
 */
export async function revertAutoConfirmed(args: {
  id: string;
  actor: string;
  reason: string;
  now?: number;
}): Promise<RevertResult> {
  const now = args.now ?? Date.now();
  const reason = (args.reason ?? '').trim();
  if (reason.length < 3) throw new AppError(400, 'REASON_REQUIRED', 'Write why');
  const storeId = await autoConfirmationStoreId(args.id);
  if (!storeId)
    throw new AppError(404, 'AUTO_CONFIRMATION_NOT_FOUND', 'Auto-confirmed payment not found');
  const row = (await withStore(storeId, () =>
    prisma.instapayAutoConfirmation.findFirst({ where: { id: args.id, storeId } })
  )) as RowShape | null;
  if (!row)
    throw new AppError(404, 'AUTO_CONFIRMATION_NOT_FOUND', 'Auto-confirmed payment not found');

  if (row.state === 'reverted') {
    return {
      result: 'already_reverted',
      graceUntil: (row.graceUntil ?? new Date(revertGraceUntil(now))).getTime(),
    };
  }
  if (row.state !== 'auto_confirmed' || nextAutoState('auto_confirmed', 'revert') === 'illegal') {
    throw new AppError(
      409,
      'NOT_AUTO_CONFIRMED',
      'Only an automatically confirmed payment can be marked not received'
    );
  }
  if (!row.billingEventId)
    throw new AppError(409, 'NOT_AUTO_CONFIRMED', 'This payment has no ledger row to reverse');

  const graceUntil = revertGraceUntil(now);
  // Claim the transition FIRST (compare-and-set on state): of two concurrent taps exactly one proceeds to the money step.
  const won = await withStore(storeId, () =>
    prisma.instapayAutoConfirmation.updateMany({
      where: { id: row.id, storeId, state: 'auto_confirmed' },
      data: {
        state: 'reverted',
        revertedAt: new Date(now),
        revertedBy: args.actor.slice(0, 120),
        revertReason: reason.slice(0, 300),
        graceUntil: new Date(graceUntil),
      },
    })
  );
  if (won.count === 0) {
    const again = await withStore(storeId, () =>
      prisma.instapayAutoConfirmation.findFirst({ where: { id: row.id, storeId } })
    );
    return {
      result: 'already_reverted',
      graceUntil: (again?.graceUntil ?? new Date(graceUntil)).getTime(),
    };
  }
  try {
    await recordManualRefund({
      eventId: row.billingEventId,
      kind: 'void',
      refundedAt: new Date(now),
      note: `not received: ${reason}`.slice(0, 300),
      actorId: args.actor,
      now: new Date(now),
      graceUntil: new Date(graceUntil),
      keepReference: true,
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    // an already-voided ledger row (a human voided it meanwhile) is the same end state: keep it reverted
    if (code !== 'ALREADY_REFUNDED' && code !== 'NOT_REFUNDABLE') {
      // Compensate the state claim: the void did not happen, so the payment is still auto-confirmed and the tap can be retried.
      await withStore(storeId, () =>
        prisma.instapayAutoConfirmation.updateMany({
          where: { id: row.id, storeId, state: 'reverted' },
          data: {
            state: 'auto_confirmed',
            revertedAt: null,
            revertedBy: null,
            revertReason: null,
            graceUntil: null,
          },
        })
      ).catch(() => undefined);
      throw err;
    }
  }

  // Burn the dedupe entries (reference + image) so this receipt can never auto-confirm again, and switch auto off for this store.
  const receipt = await withStore(storeId, () =>
    prisma.instapayReceipt.findFirst({ where: { id: row.receiptId, storeId } })
  );
  const index = getDuplicateIndex();
  const refKey = receipt
    ? normalizeReferenceKey(
        autoReadOf(receipt.extracted)?.read?.extract?.reference ?? receipt.referenceKey ?? ''
      )
    : null;
  if (index && receipt && refKey) {
    await index
      .burn({
        referenceKey: refKey,
        imageSha256: receipt.sha256,
        product: 'store',
        ownerId: storeId,
        paymentId: receipt.id,
      })
      .catch(err => logger.error({ err, storeId }, '[instapay-auto] burn failed'));
  } else {
    void sendAlert({
      level: 'p1',
      title: 'InstaPay auto-confirm: a reverted receipt could not be burned in the dedupe index',
      body: `store ${storeId}, row ${row.id}: the reference/image may be reusable until burned by hand`,
    }).catch(() => undefined);
  }
  await setStoreAuto(storeId, false, args.actor, 'reverted payment');
  await auditLog({
    action: 'billing.instapay_auto_reverted',
    storeId,
    resourceType: 'instapay_auto_confirmation',
    resourceId: row.id,
    details: {
      billingEventId: row.billingEventId,
      reason,
      actor: args.actor,
      graceUntil: new Date(graceUntil).toISOString(),
      graceMs: REVERT_GRACE_MS,
    },
  });
  await runBillingEffects([
    {
      kind: 'instapay_not_received',
      storeId,
      graceUntil: new Date(graceUntil),
      billingEventId: row.billingEventId,
    },
  ]).catch(err => logger.warn({ err, storeId }, '[instapay-auto] revert notice failed'));
  return { result: 'reverted', graceUntil };
}

// ───────────────────────────── trigger, fail-fast, stuck sweep (S5) ─────────────────────────────

const AUTO_EVENT = 'instapay/auto-confirm.requested';

/** A `needs_human` row written WITHOUT a decision run (the enqueue failed): the claim waits in Ahmad's queue instead of "queued" forever. */
async function recordNeedsHuman(
  storeId: string,
  claimId: string,
  reasons: ReasonCode[]
): Promise<void> {
  const [receipt, claim] = await withStore(storeId, () =>
    Promise.all([
      prisma.instapayReceipt.findFirst({ where: { storeId, claimId, kind: 'subscription' } }),
      prisma.manualPaymentClaim.findFirst({ where: { id: claimId, storeId } }),
    ])
  );
  if (!receipt || !claim) return;
  await withStore(storeId, () =>
    prisma.instapayAutoConfirmation.createMany({
      data: [
        {
          id: crypto.randomUUID(),
          storeId,
          claimId,
          receiptId: receipt.id,
          state: 'needs_human',
          verdict: 'needs_human',
          reasons,
          amountMinor: null,
          expectedAmountMinor: claim.amountMinor,
          isFirstPayment: false,
          extractedMasked: masked(null, null),
          idempotencyKey: autoConfirmKey('store', receipt.id),
        },
      ],
      skipDuplicates: true,
    })
  );
}

/**
 * After a claim exists (and again when the typed read lands later): ask the job to decide. Mode `off` enqueues nothing (the existing human
 * review is untouched). An enqueue that throws is FAILED FAST: the claim gets a `needs_human` row (EXTRACT_INCOMPLETE) and a P2 log.
 */
export async function enqueueAutoConfirm(
  storeId: string,
  claimId: string
): Promise<'queued' | 'skipped' | 'failed'> {
  try {
    if ((await getAutoMode()) === 'off') return 'skipped';
    const { inngest } = await import('../../lib/inngest/client.js');
    await inngest.send({ name: AUTO_EVENT, data: { storeId, claimId } } as never);
    return 'queued';
  } catch (err) {
    logger.error(
      { err, storeId, claimId },
      '[P2][instapay-auto] enqueue failed; the claim waits for a human'
    );
    await recordNeedsHuman(storeId, claimId, ['EXTRACT_INCOMPLETE']).catch(e =>
      logger.error(
        { err: e, storeId, claimId },
        '[instapay-auto] could not record the needs_human row'
      )
    );
    return 'failed';
  }
}

/**
 * Claims still `pending` 10 minutes after submission with no decision row get the event again (a lost event, a read that finished late).
 * Runs inside the existing hourly `instapay-expiry` cron: no new schedule, no new database wake-up. D1 only (the production shape).
 */
export async function sweepStuckAutoConfirmations(now: number = Date.now()): Promise<number> {
  if (!(await platformFamilyOnD1('payments'))) return 0;
  if ((await getAutoMode()) === 'off') return 0;
  const stale = await prisma.manualPaymentClaim.findMany({
    where: {
      status: 'pending',
      method: 'instapay',
      createdAt: { lte: new Date(now - 10 * 60_000) },
    },
    select: { id: true, storeId: true },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  if (stale.length === 0) return 0;
  const decided = await prisma.instapayAutoConfirmation.findMany({
    where: { claimId: { in: stale.map(c => c.id) } },
    select: { claimId: true },
  });
  const done = new Set(decided.map(d => d.claimId));
  let sent = 0;
  for (const c of stale) {
    if (done.has(c.id)) continue;
    if ((await enqueueAutoConfirm(c.storeId, c.id)) === 'queued') sent++;
  }
  return sent;
}
