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

/** The platform client with no tenant scope: the D1 client on a Worker (the production shape), else the process prisma (Node tests). */
async function platformScope() {
  return (await platformDb()) ?? prisma;
}
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
import { cfBindings } from '../../cf/bindings';
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

const AUTO_ACTOR = 'system:auto-confirm';
/** A pure switch outcome (off / shadow / store off) is the normal manual flow, not "waiting on you". */
const QUIET_REASONS: ReadonlySet<ReasonCode> = new Set([
  'SHADOW_MODE',
  'KILL_GLOBAL',
  'KILL_STORE',
]);

type AutoOutcome = {
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
  revertedBy?: string | null;
  revertReason?: string | null;
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

/**
 * Earlier payments of this store that count as CLEAN (INSTAPAY-CLEAN-1): human-confirmed at once, auto only after a SENT digest, never
 * reverted. Also the sum of auto-confirmed amounts that are NOT clean yet (Ruling INSTAPAY-CAP-1: the first-payment cap is cumulative over
 * them, so two quick uploads cannot each take a full month before Ahmad has seen either).
 */
async function cleanState(
  storeId: string,
  now: number
): Promise<{ clean: boolean; pendingAutoMinor: number }> {
  const autos = await withStore(storeId, tx =>
    tx.instapayAutoConfirmation.findMany({
      where: { storeId, state: 'auto_confirmed' },
      select: { amountMinor: true, confirmedAt: true, digestSentAt: true, revertedAt: true },
      take: 200,
    })
  );
  const pendingAutoMinor = autos
    .filter(
      a =>
        !isCleanPayment(
          {
            confirmedBy: 'auto',
            confirmedAt: (a.confirmedAt ?? new Date(0)).getTime(),
            digestSentAt: a.digestSentAt?.getTime() ?? null,
            revertedAt: a.revertedAt?.getTime() ?? null,
          },
          now
        )
    )
    .reduce((sum, a) => sum + (a.amountMinor ?? 0), 0);
  return { clean: await hasCleanPayment(storeId, now), pendingAutoMinor };
}

async function hasCleanPayment(storeId: string, now: number): Promise<boolean> {
  const [events, autos] = await withStore(storeId, tx =>
    Promise.all([
      tx.billingEvent.findMany({
        where: { storeId, type: 'manual_payment', status: 'succeeded' },
        select: { id: true, createdAt: true },
        take: 200,
      }),
      tx.instapayAutoConfirmation.findMany({
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
    const s = await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { name: true } })
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

  const [claim, receipt] = await withStore(storeId, tx =>
    Promise.all([
      tx.manualPaymentClaim.findFirst({ where: { id: claimId, storeId } }),
      tx.instapayReceipt.findFirst({ where: { storeId, claimId, kind: 'subscription' } }),
    ])
  );
  if (!claim || !receipt || claim.method !== 'instapay') return { state: 'skipped', reasons: [] };

  const key = autoConfirmKey('store', receipt.id);
  // 1. Idempotency: the row is born `pending_decision`; a replay loads it and returns it (never re-decides, never re-activates).
  const existing = await withStore(storeId, tx =>
    tx.instapayAutoConfirmation.findUnique({ where: { idempotencyKey: key } })
  );
  if (existing) return asOutcome(existing as RowShape);
  if (claim.status !== 'pending') return { state: 'skipped', reasons: [] };

  // 2. Inputs. Expected amount = the quoted charge for the CLAIM's plan + interval through the one VAT seam (strict equality).
  const interval: BillingInterval = isInterval(claim.billingInterval)
    ? claim.billingInterval
    : 'monthly';
  const plan = await (await platformScope()).plan.findUnique({ where: { code: claim.planCode } });
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
  const { clean, pendingAutoMinor } = await cleanState(storeId, now);
  const isFirstPayment = !clean;
  const capLeft = Math.max(
    0,
    firstPaymentCapMinor({ monthlyPriceMinor: monthlyAmount }) - pendingAutoMinor
  );
  const decideWith = (m: AutoMode, enabled: boolean) => {
    const d = decideInstapay({
      extract,
      expected: { amountMinor: expectedAmountMinor, payeeHandle: handle ?? '' },
      now,
      mode: m,
      storeEnabled: enabled,
      isFirstPayment,
      firstPaymentCapMinor: capLeft,
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
  const created = await withStore(storeId, tx =>
    tx.instapayAutoConfirmation.createMany({
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
  const row = (await withStore(storeId, tx =>
    tx.instapayAutoConfirmation.findUnique({ where: { idempotencyKey: key } })
  )) as RowShape | null;
  if (!row)
    throw new AppError(500, 'AUTO_ROW_MISSING', 'The auto-confirm row could not be read back');
  // lost the race: the winner's call owns the outcome (its dedupe claim has the same payment id, so ours was `ours`)
  if (created.count === 0) return asOutcome(row);

  const settle = async (to: AutoEvent, extra: Record<string, unknown> = {}) => {
    const next = nextAutoState('pending_decision', to);
    if (next === 'illegal') throw new Error(`illegal auto transition ${to}`);
    await withStore(storeId, tx =>
      tx.instapayAutoConfirmation.updateMany({
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
    const recorded = await withStore(storeId, tx =>
      tx.billingEvent.findFirst({
        where: { storeId, idempotencyKey: manualPaymentKey('instapay', reference) },
        select: { id: true },
      })
    ).catch(() => null);
    const claimNow = await withStore(storeId, tx =>
      tx.manualPaymentClaim.findFirst({ where: { id: claimId, storeId }, select: { status: true } })
    ).catch(() => null);
    if (recorded) {
      // Money WAS recorded by this system decision: the row must be auto_confirmed so it reaches the digest and stays revertable
      // (review finding 3). The dedupe claim stays held.
      await settle('decide_auto', {
        billingEventId: recorded.id,
        confirmedAt: new Date(now),
      }).catch(() => undefined);
      void sendAlert({
        level: 'p1',
        title: 'InstaPay auto-confirm: payment recorded but the activation did not finish',
        body: `store ${storeId}, claim ${claimId}, row ${row.id}, event ${recorded.id}: listed in the digest and revertable; retry the manual payment (idempotent) to finish the claim and receipt. ${(err as Error)?.message ?? err}`,
      }).catch(() => undefined);
      return { state: 'auto_confirmed', reasons: [], billingEventId: recorded.id, id: row.id };
    }
    // a person confirmed the claim meanwhile (lost race): the payment is real, keep the claim (review finding 2)
    if (claimNow?.status !== 'confirmed' && claimResult === 'claimed' && index && dedupeEntry) {
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

type RevertResult = { result: 'reverted' | 'already_reverted'; graceUntil: number };

const isUniqueViolation = (err: unknown) =>
  (err as { code?: string })?.code === 'P2002' ||
  /UNIQUE constraint/i.test(String((err as Error)?.message ?? ''));

/**
 * The effects of a "not received" revert, each idempotent so a replay finishes a crashed revert without doing anything twice: the void
 * (keyed `manual-void:<event>`), the burn (INSERT OR IGNORE + UPDATE), the store switch (an upsert), and the merchant notice ONLY when this
 * call created the void (so the notice goes out once). Throws only when the void itself fails.
 */
async function finishRevert(
  storeId: string,
  row: RowShape,
  actor: string,
  reason: string,
  now: number,
  graceUntil: number
): Promise<void> {
  let voidedNow = false;
  try {
    const r = await recordManualRefund({
      eventId: row.billingEventId!,
      kind: 'void',
      refundedAt: new Date(now),
      note: `not received: ${reason}`.slice(0, 300),
      actorId: actor,
      now: new Date(now),
      graceUntil: new Date(graceUntil),
      keepReference: true,
    });
    voidedNow = !r.duplicate;
  } catch (err) {
    const code = (err as { code?: string }).code;
    // already voided (a human voided it meanwhile, or a concurrent finish won the void key): the same end state
    if (code !== 'ALREADY_REFUNDED' && code !== 'NOT_REFUNDABLE' && !isUniqueViolation(err))
      throw err;
  }
  // Burn the dedupe entries (reference + image) so this receipt can never auto-confirm again, and switch auto off for this store.
  const receipt = await withStore(storeId, tx =>
    tx.instapayReceipt.findFirst({ where: { id: row.receiptId, storeId } })
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
  await setStoreAuto(storeId, false, actor, 'reverted payment');
  await auditLog({
    action: 'billing.instapay_auto_reverted',
    storeId,
    resourceType: 'instapay_auto_confirmation',
    resourceId: row.id,
    details: {
      billingEventId: row.billingEventId,
      reason,
      actor: actor,
      graceUntil: new Date(graceUntil).toISOString(),
      graceMs: REVERT_GRACE_MS,
    },
  });
  if (voidedNow)
    await runBillingEffects([
      {
        kind: 'instapay_not_received',
        storeId,
        graceUntil: new Date(graceUntil),
        billingEventId: row.billingEventId ?? undefined,
      },
    ]).catch(err => logger.warn({ err, storeId }, '[instapay-auto] revert notice failed'));
}

/**
 * The store of an auto-confirmation row, from its id alone (a Telegram tap carries only the id). Read on the platform D1 client, which has no
 * tenant context by design: the id is an unguessable uuid, the route that calls this verifies the bridge signature first, and the answer
 * is only used to open that row's own store scope (every later query names the store).
 */
async function autoConfirmationStoreId(id: string): Promise<string | null> {
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

type D1Run = {
  prepare(sql: string): {
    bind(...v: unknown[]): { run(): Promise<{ meta?: { changes?: number } }> };
  };
};

/**
 * The ONE atomic compare-and-set of the revert: `auto_confirmed` -> `reverted`. On D1 the router's `updateMany` is a SELECT of primary keys
 * followed by an UPDATE by key (no state guard in the statement), so two simultaneous taps would both "win"; the production path is therefore
 * ONE guarded statement whose `changes` says who won. Without a platform D1 (Postgres tests / local) `updateMany` with the same `where` is atomic.
 */
async function claimRevert(
  storeId: string,
  id: string,
  actor: string,
  reason: string,
  now: number,
  graceUntil: number
): Promise<{ count: number }> {
  const d1 = (cfBindings() as { PLATFORM_DB?: D1Run } | undefined)?.PLATFORM_DB;
  if (d1 && (await platformFamilyOnD1('payments'))) {
    const r = await d1
      .prepare(
        "UPDATE instapay_auto_confirmations SET state = 'reverted', reverted_at = ?, reverted_by = ?, revert_reason = ?, grace_until = ?, updated_at = ? WHERE id = ? AND store_id = ? AND state = 'auto_confirmed'"
      )
      .bind(now, actor.slice(0, 120), reason.slice(0, 300), graceUntil, now, id, storeId)
      .run();
    return { count: Number(r.meta?.changes ?? 0) };
  }
  return withStore(storeId, tx =>
    tx.instapayAutoConfirmation.updateMany({
      where: { id, storeId, state: 'auto_confirmed' },
      data: {
        state: 'reverted',
        revertedAt: new Date(now),
        revertedBy: actor.slice(0, 120),
        revertReason: reason.slice(0, 300),
        graceUntil: new Date(graceUntil),
      },
    })
  );
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
  const row = (await withStore(storeId, tx =>
    tx.instapayAutoConfirmation.findFirst({ where: { id: args.id, storeId } })
  )) as RowShape | null;
  if (!row)
    throw new AppError(404, 'AUTO_CONFIRMATION_NOT_FOUND', 'Auto-confirmed payment not found');

  if (row.state === 'reverted') {
    // A crash between the state claim and the effects must not strand the revert (review finding 9): every effect is idempotent, so a
    // replay finishes what is missing and writes nothing twice.
    const grace = (row.graceUntil ?? new Date(revertGraceUntil(now))).getTime();
    if (row.billingEventId)
      await finishRevert(
        storeId,
        row,
        row.revertedBy ?? args.actor,
        row.revertReason ?? reason,
        row.revertedAt?.getTime() ?? now,
        grace
      ).catch(err =>
        logger.warn({ err, storeId }, '[instapay-auto] revert replay could not finish')
      );
    return { result: 'already_reverted', graceUntil: grace };
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
  const won = await claimRevert(storeId, row.id, args.actor, reason, now, graceUntil);
  if (won.count === 0) {
    const again = await withStore(storeId, tx =>
      tx.instapayAutoConfirmation.findFirst({ where: { id: row.id, storeId } })
    );
    return {
      result: 'already_reverted',
      graceUntil: (again?.graceUntil ?? new Date(graceUntil)).getTime(),
    };
  }
  try {
    await finishRevert(storeId, row, args.actor, reason, now, graceUntil);
  } catch (err) {
    // Compensate the state claim: the void did not happen, so the payment is still auto-confirmed and the tap can be retried.
    await withStore(storeId, tx =>
      tx.instapayAutoConfirmation.updateMany({
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
  const [receipt, claim] = await withStore(storeId, tx =>
    Promise.all([
      tx.instapayReceipt.findFirst({ where: { storeId, claimId, kind: 'subscription' } }),
      tx.manualPaymentClaim.findFirst({ where: { id: claimId, storeId } }),
    ])
  );
  if (!receipt || !claim) return;
  await withStore(storeId, tx =>
    tx.instapayAutoConfirmation.createMany({
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
  const stale: Array<{ id: string; storeId: string }> = await (
    await platformScope()
  ).manualPaymentClaim.findMany({
    where: {
      status: 'pending',
      method: 'instapay',
      createdAt: { lte: new Date(now - 10 * 60_000) },
    },
    select: { id: true, storeId: true },
    orderBy: { createdAt: 'asc' },
    take: 100,
  });
  await resolveStuckDecisions(now);
  if (stale.length === 0) return 0;
  const decided: Array<{ claimId: string }> = await (
    await platformScope()
  ).instapayAutoConfirmation.findMany({
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

/**
 * A human REJECTED the claim of a payment that waited (or failed): free the dedupe entries it held so a corrected receipt of the same
 * transfer is not blocked forever. Never touches an auto-confirmed or reverted payment (those stay held / burned).
 */
export async function releaseDedupeAfterReject(storeId: string, claimId: string): Promise<void> {
  const index = getDuplicateIndex();
  if (!index) return;
  const row = await withStore(storeId, tx =>
    tx.instapayAutoConfirmation.findFirst({ where: { storeId, claimId } })
  );
  if (!row || row.state === 'auto_confirmed' || row.state === 'reverted') return;
  const receipt = await withStore(storeId, tx =>
    tx.instapayReceipt.findFirst({ where: { id: row.receiptId, storeId } })
  );
  const refKey = receipt
    ? normalizeReferenceKey(autoReadOf(receipt.extracted)?.read?.extract?.reference ?? '')
    : null;
  if (!receipt || !refKey) return;
  await index
    .release({
      referenceKey: refKey,
      imageSha256: receipt.sha256,
      product: 'store',
      ownerId: storeId,
      paymentId: receipt.id,
    })
    .catch(err =>
      logger.error({ err, storeId }, '[instapay-auto] dedupe release after reject failed')
    );
}

// ───────────────────────────── daily digest + waiting reminders (S8) ─────────────────────────────

type DigestRow = RowShape & { expectedAmountMinor: number };
const DIGEST_PAGE = 200;
const STALE_DIGEST_MS = 26 * 3600_000;
const REMINDER_MAX = 5;

/**
 * The daily digest: every `auto_confirmed` payment not yet listed goes to Ahmad in ONE brain message (cursor-paginated, 200 per page). A row
 * is stamped `digestSentAt` ONLY when the brain answered `sent:true` for the page that listed it (INSTAPAY-CLEAN-1: that stamp is what makes the
 * payment "clean"); a failure leaves the rows for the next run and raises a P1 once the oldest undelivered row is older than 26 h.
 * An empty set sends nothing. A reverted payment is not `auto_confirmed` any more, so it is never listed.
 *
 * The brain allows ONE digest per product per UTC day: a second page the same day is refused (429) and simply waits for tomorrow's run.
 * Also reminds (max 5, as `waiting` notices) of claims that still wait for a human, so nothing depends on the one immediate notice.
 */
export async function runAutoDigest(
  now: number = Date.now()
): Promise<{ listed: number; stamped: number; reminded: number }> {
  const db = (await platformDb()) ?? prisma;
  let listed = 0;
  let stamped = 0;
  let oldestUndelivered: number | null = null;
  // Stamped rows leave the filter, so each loop reads the FIRST page again (a cursor on a row that just left the filter would skip one).
  for (let page = 0; page < 25; page++) {
    const rows: DigestRow[] = await db.instapayAutoConfirmation.findMany({
      where: { state: 'auto_confirmed', digestSentAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: DIGEST_PAGE,
    });
    if (rows.length === 0) break;
    listed += rows.length;
    const items = await Promise.all(
      rows.map(async r => ({
        product: 'store' as const,
        id: r.id,
        ownerLabel: await ownerLabel(r.storeId),
        amountMinor: r.amountMinor ?? r.expectedAmountMinor,
        kind: 'subscription',
        confirmedAt: (r.confirmedAt ?? r.createdAt).getTime(),
      }))
    );
    const ok = await notifyBrain('digest', items);
    if (!ok) {
      oldestUndelivered = rows[0].createdAt.getTime();
      break;
    }
    // stamp each row inside its own store scope (it names the store); a row reverted meanwhile is simply stamped too (it can never be clean)
    for (const r of rows) {
      await withStore(r.storeId, tx =>
        tx.instapayAutoConfirmation.updateMany({
          where: { id: r.id, storeId: r.storeId },
          data: { digestSentAt: new Date(now) },
        })
      );
      stamped++;
    }
    if (rows.length < DIGEST_PAGE) break;
  }
  if (oldestUndelivered !== null && now - oldestUndelivered > STALE_DIGEST_MS) {
    void sendAlert({
      level: 'p1',
      title: 'InstaPay auto-confirm: the daily digest has not reached Ahmad for over 26 hours',
      body: `oldest undelivered auto-confirmed payment: ${new Date(oldestUndelivered).toISOString()}. Check the brain bridge (BRAIN_BRIDGE_URL, INSTAPAY_BRIDGE_SECRET) and Telegram.`,
    }).catch(() => undefined);
  }

  // claims still waiting for a human (a lost immediate notice must not leave one unseen)
  let reminded = 0;
  const waiting: DigestRow[] = await db.instapayAutoConfirmation.findMany({
    where: { state: 'needs_human', digestSentAt: null },
    orderBy: { createdAt: 'asc' },
    take: REMINDER_MAX,
  });
  const live: typeof waiting = [];
  for (const r of waiting) {
    const claim = await withStore(r.storeId, tx =>
      tx.manualPaymentClaim.findFirst({ where: { id: r.claimId, storeId: r.storeId } })
    );
    const quiet = (r.reasons as ReasonCode[]).every(x => QUIET_REASONS.has(x));
    if (claim?.status === 'pending' && !quiet) live.push(r);
  }
  if (live.length > 0) {
    const ok = await notifyBrain(
      'waiting',
      await Promise.all(
        live.map(async r => ({
          product: 'store' as const,
          id: r.id,
          ownerLabel: await ownerLabel(r.storeId),
          amountMinor: r.amountMinor ?? r.expectedAmountMinor,
          kind: 'subscription',
          confirmedAt: r.createdAt.getTime(),
          reasons: r.reasons as string[],
        }))
      )
    );
    if (ok) {
      for (const r of live) {
        await withStore(r.storeId, tx =>
          tx.instapayAutoConfirmation.updateMany({
            where: { id: r.id, storeId: r.storeId },
            data: { digestSentAt: new Date(now) },
          })
        );
        reminded++;
      }
    }
  }
  return { listed, stamped, reminded };
}

/**
 * A decision row stuck in `pending_decision` (the run died between writing the row and settling it) would otherwise block its claim forever,
 * because a replay returns the existing row (review finding 3). Older than 10 minutes: if the claim was confirmed by that run's ledger row,
 * the row becomes `auto_confirmed` (so it reaches the digest and stays revertable); otherwise it waits for a person.
 */
async function resolveStuckDecisions(now: number): Promise<number> {
  const db = await platformScope();
  const stuck: RowShape[] = await db.instapayAutoConfirmation.findMany({
    where: { state: 'pending_decision', createdAt: { lte: new Date(now - 10 * 60_000) } },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  let fixed = 0;
  for (const r of stuck) {
    const claim = await withStore(r.storeId, tx =>
      tx.manualPaymentClaim.findFirst({
        where: { id: r.claimId, storeId: r.storeId },
        select: { status: true, billingEventId: true, amountMinor: true },
      })
    );
    const paid = claim?.status === 'confirmed' && claim.billingEventId;
    await withStore(r.storeId, tx =>
      tx.instapayAutoConfirmation.updateMany({
        where: { id: r.id, storeId: r.storeId, state: 'pending_decision' },
        data: paid
          ? {
              state: 'auto_confirmed',
              billingEventId: claim!.billingEventId,
              confirmedAt: new Date(now),
            }
          : { state: 'needs_human' },
      })
    );
    if (!paid) await notifyWaiting(r, claim?.amountMinor ?? 0, ['EXTRACT_INCOMPLETE']);
    fixed++;
  }
  return fixed;
}

/**
 * Review finding 1: a payment a PERSON confirmed (the existing manual path) also claims its receipt in the platform-global index, so the
 * same transfer can never be auto-confirmed later on another merchant or in Ebda Chat. Best effort after the money committed: a duplicate is
 * a P1 for Ahmad (he confirmed a receipt already used elsewhere), never a refusal of his decision.
 */
export async function claimDedupeForHumanConfirm(
  storeId: string,
  billingEventId: string
): Promise<void> {
  const index = getDuplicateIndex();
  if (!index) return;
  const receipts = await withStore(storeId, tx =>
    tx.manualPaymentClaim
      .findMany({ where: { storeId, billingEventId }, select: { id: true } })
      .then(claims =>
        claims.length
          ? tx.instapayReceipt.findMany({
              where: { storeId, claimId: { in: claims.map(c => c.id) } },
              select: { id: true, referenceKey: true, sha256: true },
            })
          : []
      )
  );
  for (const r of receipts) {
    const referenceKey = normalizeReferenceKey(r.referenceKey ?? '');
    if (!referenceKey) continue;
    const result = await index
      .claim({
        referenceKey,
        imageSha256: r.sha256,
        product: 'store',
        ownerId: storeId,
        paymentId: r.id,
      })
      .catch(err => {
        logger.error({ err, storeId }, '[instapay-auto] dedupe claim for a human confirm failed');
        return null;
      });
    if (result === 'duplicate_reference' || result === 'duplicate_image')
      void sendAlert({
        level: 'p1',
        title: 'InstaPay: a person confirmed a receipt already used elsewhere',
        body: `store ${storeId}, event ${billingEventId}, receipt ${r.id}: ${result}. Check the transfer before keeping this payment.`,
      }).catch(() => undefined);
  }
}

/**
 * Review finding 1 / plan R1 step 3: every receipt a person already APPROVED is burned in the global index so an old receipt can never be
 * replayed into an automatic confirmation. Idempotent (burn = INSERT OR IGNORE + UPDATE), `dryRun` only counts. Super-admin route.
 */
export async function backfillDedupeFromHistory(opts: { dryRun: boolean }): Promise<{
  scanned: number;
  burned: number;
  skipped: number;
}> {
  const index = getDuplicateIndex();
  if (!index && !opts.dryRun)
    throw new AppError(503, 'DEDUPE_UNBOUND', 'The InstaPay dedupe database is not bound');
  const db = await platformScope();
  const rows: Array<{ id: string; storeId: string; referenceKey: string | null; sha256: string }> =
    await db.instapayReceipt.findMany({
      where: { status: 'approved' },
      select: { id: true, storeId: true, referenceKey: true, sha256: true },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    });
  let burned = 0;
  let skipped = 0;
  for (const r of rows) {
    const referenceKey = normalizeReferenceKey(r.referenceKey ?? '');
    if (!referenceKey || !/^[0-9a-f]{64}$/.test(r.sha256)) {
      skipped++;
      continue;
    }
    if (!opts.dryRun)
      await index!.burn({
        referenceKey,
        imageSha256: r.sha256,
        product: 'store',
        ownerId: r.storeId,
        paymentId: r.id,
      });
    burned++;
  }
  return { scanned: rows.length, burned, skipped };
}
