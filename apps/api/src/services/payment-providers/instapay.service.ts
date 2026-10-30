/**
 * InstaPay manual-confirmation lifecycle (SP6a, Review Focus 3).
 *
 *   pending --initiate--> awaiting_payment_confirmation --confirm--> confirmed (paid)
 *                                    |
 *                                    +--expiry cron / merchant cancel--> cancelled
 *
 * Where each rule is enforced:
 *
 *  - DOES NOT SHIP: `awaiting_payment_confirmation` allows only `confirmed` and
 *    `cancelled` in the one state machine (`order-status-machine.ts`, mirrored in
 *    @ebda/shared), and `assertOrderFulfillable` blocks carrier booking.
 *  - DOES NOT COUNT AS REVENUE: the order stays `paymentStatus='unpaid'` with a
 *    `pending` Payment until `confirm`; every revenue aggregate excludes the status
 *    (`NON_REVENUE_ORDER_STATUSES`), and the GL only posts `paymentStatus='paid'`.
 *  - EXPIRES: `expireDue` (Inngest cron, one tenant transaction per store) cancels
 *    awaiting orders past `payment_confirmation_expires_at`, releasing stock through
 *    the normal cancel path, and notifies the merchant (the customer gets the
 *    cancelled notification from the status fan-out).
 *  - CONFIRMED ONCE: confirm and expiry both take `SELECT ... FOR UPDATE` on the
 *    order row, so a concurrent double confirm (or confirm racing expiry) is
 *    serialised: the loser sees the new status. A repeat confirm is an idempotent
 *    no-op (`changed:false`), and a confirm of an expired or cancelled order is
 *    refused (409).
 *
 *  - PROOF (money batch A, Rulings EBDA-MONEYA-1/5): the shopper uploads the transfer
 *    receipt screenshot (`instapay-receipt.service`), the AI pre-fills it, the shopper
 *    submits it. Submitting FREEZES the hold (`payment_confirmation_expires_at = NULL`):
 *    an order whose shopper already sent proof is never auto-cancelled while it waits
 *    for the merchant, and the merchant can still confirm it. The merchant (the store's
 *    owner/staff — never Ebda's super-admin) approves (= `confirm`) or rejects with a
 *    reason (the hold restarts: max(original deadline, now + 24 h)).
 *
 * No external call happens here: the only I/O is Postgres (and the private bucket). Notifications and the
 * `order/created` fan-out are deferred until after the tenant transaction commits.
 */
import {
  currentTenantGucs,
  hasTenantContext,
  prisma,
  withStore,
  type Prisma,
} from '@ebda/database';
import {
  AWAITING_PAYMENT_CONFIRMATION,
  INSTAPAY_DEFAULT_EXPIRY_HOURS,
  REGION,
  normalizeInstapayReference,
  zonedLocalToUtc,
  type InstapayInstructions,
  type InstapayReceiptFields,
  type InstapayRefundRecord,
} from '@ebda/shared';
import { AppError } from '../../middleware/error-handler';
import { storeDb, storeMoney } from '../../lib/repo-factory';
import logger from '../../lib/logger';
import { inngest } from '../../lib/inngest/client';
import { deferAfterTenantCommit } from '../../lib/after-tenant-commit';
import { invalidateCustomersCache } from '../../lib/public-cache';
import { OrderService } from '../order.service';
import { OneSignalService } from '../onesignal.service';
import { socketService } from '../socket.service';
import { recordPaymentEvent } from '../payment-event.service';
import { toProviderCredentials } from './credentials';
import { instapayProvider, parseInstapaySettings } from './instapay.provider';
import {
  InstapayReceiptService,
  sniffReceiptMime,
  toReceiptView,
} from './instapay-receipt.service';
import { StorageService } from '../storage.service';
import { withClaimReleases } from '../../lib/instapay-ref-claim';

const HOUR_MS = 3_600_000;

export type ConfirmOutcome =
  | { changed: true; orderId: string; status: 'confirmed' }
  | { changed: false; orderId: string; status: string };

interface LockedOrder {
  id: string;
  status: string;
  payment_status: string;
  payment_confirmation_expires_at: Date | null;
}

/** Take the row lock that serialises confirm / expiry / cancel for ONE order. */
async function lockOrder(
  tx: Prisma.TransactionClient,
  storeId: string,
  orderId: string
): Promise<LockedOrder | null> {
  const rows = await tx.$queryRaw<LockedOrder[]>`
    SELECT id, status::text AS status, payment_status::text AS payment_status,
           payment_confirmation_expires_at
      FROM orders
     WHERE id = ${orderId} AND store_id = ${storeId} AND deleted_at IS NULL
       FOR UPDATE`;
  return rows[0] ?? null;
}

/** Work that must only run once the transaction that decided it has COMMITTED. */
export type PostCommit = (name: string, task: () => Promise<unknown>) => void;

/**
 * `withStore` plus a post-commit queue that is correct wherever the caller sits:
 *  - inside a request's tenant transaction (the admin route under `tenantContext`):
 *    tasks go to `deferAfterTenantCommit`, which drains them after the request COMMITs;
 *  - anywhere else (the expiry cron, a script): `withStore` opens its own short
 *    transaction, and the tasks run right after IT commits. Running them inside it
 *    would touch a transaction that is already closing (P2028).
 */
async function withStoreAfterCommit<T>(
  storeId: string,
  fn: (after: PostCommit) => Promise<T>
): Promise<T> {
  const inRequestTx = hasTenantContext() && currentTenantGucs()?.storeId === storeId;
  const tasks: Array<{ name: string; task: () => Promise<unknown> }> = [];
  const after: PostCommit = (name, task) => {
    if (inRequestTx) void deferAfterTenantCommit(name, task);
    else tasks.push({ name, task: () => withStore(storeId, task) });
  };
  const result = await withStore(storeId, () => fn(after));
  await runPostCommit(tasks);
  return result;
}

/** Run collected post-commit tasks; a failing notification never fails the money path. */
export async function runPostCommit(
  tasks: Array<{ name: string; task: () => Promise<unknown> }>
): Promise<void> {
  for (const { name, task } of tasks) {
    try {
      await task();
    } catch (err) {
      logger.error({ err, task: name }, '[INSTAPAY] post-commit task failed');
    }
  }
}

function metaOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export class InstapayService {
  /** The store's enabled InstaPay config, or null. (No global fallback: the handle is per merchant.) */
  static async getConfig(storeId: string) {
    return prisma.paymentConfig.findFirst({
      where: { storeId, provider: 'instapay', isEnabled: true },
    });
  }

  /**
   * Put a freshly created (`pending`, unpaid) order on hold for an InstaPay
   * transfer. Runs INSIDE the caller's tenant transaction (no network). Returns
   * what the checkout shows. A replay while the order is already awaiting returns
   * the SAME instructions and creates nothing.
   */
  static async initiate(args: {
    storeId: string;
    order: {
      id: string;
      orderNumber: string;
      total: number;
      walletAmount: number;
      currency: string;
      status: string;
    };
    customer: { name: string; email: string; phone?: string };
    userId?: string | null;
    now?: Date;
    /** Collects work to run AFTER the caller's transaction commits (the merchant notification). */
    postCommit?: PostCommit;
  }): Promise<{ payment: { id: string }; instructions: InstapayInstructions; created: boolean }> {
    const { storeId, order } = args;
    const now = args.now ?? new Date();
    const cfg = await this.getConfig(storeId);
    if (!cfg) {
      throw new AppError(400, 'INSTAPAY_NOT_AVAILABLE', 'InstaPay is not available for this store');
    }
    const settings = parseInstapaySettings(
      toProviderCredentials({ ...cfg, fixedFee: cfg.fixedFee }).settings
    );
    const hours = settings.expiryHours ?? INSTAPAY_DEFAULT_EXPIRY_HOURS;

    // Same lock as confirm/expiry, so initiate cannot interleave with them.
    const locked = await lockOrder(
      prisma as unknown as Prisma.TransactionClient,
      storeId,
      order.id
    );
    if (!locked) throw new AppError(404, 'NOT_FOUND', 'Order not found');

    const amountMinor = order.total - order.walletAmount;

    if (locked.status === AWAITING_PAYMENT_CONFIRMATION) {
      const existing = await prisma.payment.findFirst({
        where: { orderId: order.id, provider: 'instapay', status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        return {
          payment: { id: existing.id },
          instructions: this.instructionsFor({
            order,
            amountMinor: existing.amount,
            payment: existing,
            expiresAt:
              locked.payment_confirmation_expires_at ?? new Date(now.getTime() + hours * HOUR_MS),
          }),
          created: false,
        };
      }
    }
    if (locked.status !== 'pending' || locked.payment_status !== 'unpaid') {
      throw new AppError(409, 'ORDER_NOT_PAYABLE', 'This order can no longer be paid by InstaPay');
    }
    if (amountMinor <= 0) {
      throw new AppError(409, 'ORDER_ALREADY_PAID', 'Nothing is due on this order');
    }

    const expiresAt = new Date(now.getTime() + hours * HOUR_MS);
    const result = await instapayProvider.createPayment(
      {
        orderId: order.id,
        orderNumber: order.orderNumber,
        amountMinor,
        currency: 'EGP',
        customer: args.customer,
        returnUrls: { success: '', failure: '' },
        idempotencyKey: `${order.id}:instapay`,
        expiresAt,
      },
      toProviderCredentials(cfg)
    );

    const claimed = await prisma.order.updateMany({
      where: { id: order.id, storeId, status: 'pending', paymentStatus: 'unpaid' },
      data: { status: AWAITING_PAYMENT_CONFIRMATION, paymentConfirmationExpiresAt: expiresAt },
    });
    if (claimed.count !== 1) {
      throw new AppError(409, 'ORDER_NOT_PAYABLE', 'This order can no longer be paid by InstaPay');
    }

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        provider: 'instapay',
        method: 'instapay',
        status: 'pending',
        amount: amountMinor,
        currency: order.currency,
        transactionId: result.providerRef,
        metadata: {
          reference: order.orderNumber,
          handle: settings.handle ?? null,
          phone: settings.phone ?? null,
          accountName: settings.accountName ?? null,
          noteEn: settings.noteEn ?? null,
          noteAr: settings.noteAr ?? null,
          expiresAt: expiresAt.toISOString(),
          customerReference: null,
        },
      },
    });
    await prisma.orderEvent.create({
      data: {
        storeId,
        orderId: order.id,
        fromStatus: 'pending',
        toStatus: AWAITING_PAYMENT_CONFIRMATION,
        actorId: args.userId ?? null,
        metadata: { via: 'instapay_initiate', expiresAt: expiresAt.toISOString() },
      },
    });
    await recordPaymentEvent({
      paymentId: payment.id,
      storeId,
      orderId: order.id,
      eventType: 'created',
      toStatus: 'pending',
      provider: 'instapay',
      triggeredByUserId: args.userId ?? null,
      details: { amount: amountMinor, expiresAt: expiresAt.toISOString() },
    });

    // The merchant has to act: tell them (after COMMIT, never inside the transaction).
    // Its own short store scope: it runs after the caller's transaction is gone.
    args.postCommit?.('instapay.awaiting.notify', () =>
      withStore(storeId, () => InstapayService.notifyMerchantAwaiting(storeId, order.id))
    );

    return {
      payment: { id: payment.id },
      instructions: this.instructionsFor({ order, amountMinor, payment, expiresAt }),
      created: true,
    };
  }

  /** What the customer sees. Built from the stored payment, so a replay shows exactly what was first shown. */
  static instructionsFor(args: {
    order: { orderNumber: string; currency: string };
    amountMinor: number;
    payment: { metadata: unknown };
    expiresAt: Date;
  }): InstapayInstructions {
    const m = metaOf(args.payment.metadata);
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    return {
      kind: 'manual-instructions',
      method: 'instapay',
      handle: str(m.handle),
      phone: str(m.phone),
      accountName: str(m.accountName),
      amountMinor: args.amountMinor,
      currency: args.order.currency,
      reference: args.order.orderNumber,
      expiresAt: args.expiresAt.toISOString(),
      noteEn: str(m.noteEn),
      noteAr: str(m.noteAr),
      customerReference: str(m.customerReference) ?? null,
    };
  }

  /** The customer's view of an InstaPay order (public by order id, like payments/create). */
  static async getInstructions(storeId: string, orderId: string) {
    const money = await storeMoney(storeId);
    const scoped = <T>(fn: () => Promise<T>): Promise<T> => (money ? fn() : withStore(storeId, fn));
    return scoped(async () => {
      const db = money ? await storeDb(storeId) : prisma;
      const order = await db.order.findFirst({
        where: { id: orderId, storeId, deletedAt: null },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          currency: true,
          paymentConfirmationExpiresAt: true,
          payments: {
            where: { provider: 'instapay' },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      });
      const payment = order?.payments[0];
      if (!order || !payment)
        throw new AppError(404, 'NOT_FOUND', 'No InstaPay payment for this order');
      const latest = money
        ? await money.receiptList({ orderId }).then(rows => {
            const r = rows[0];
            return r
              ? {
                  id: r.id,
                  status: r.status,
                  reviewNote: r.reviewNote,
                  submittedAt: r.submittedAt === null ? null : new Date(r.submittedAt),
                  reviewedAt: r.reviewedAt === null ? null : new Date(r.reviewedAt),
                }
              : null;
          })
        : await prisma.instapayReceipt.findFirst({
            where: { storeId, kind: 'order', orderId, status: { not: 'draft' } },
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              status: true,
              reviewNote: true,
              submittedAt: true,
              reviewedAt: true,
            },
          });
      return {
        orderStatus: order.status,
        paymentStatus: order.paymentStatus,
        /** The shopper's latest submitted receipt and the store's decision (null = none yet). */
        proof: latest
          ? {
              receiptId: latest.id,
              status: latest.status,
              reviewNote: latest.reviewNote,
              submittedAt: latest.submittedAt?.toISOString() ?? null,
              reviewedAt: latest.reviewedAt?.toISOString() ?? null,
            }
          : null,
        instructions: this.instructionsFor({
          order,
          amountMinor: payment.amount,
          payment,
          expiresAt: order.paymentConfirmationExpiresAt ?? new Date(0),
        }),
      };
    });
  }

  /**
   * The merchant confirms the money arrived. ONE transition, whatever the
   * concurrency: see the file header. Idempotent for an already confirmed order.
   */
  static async confirm(args: {
    storeId: string;
    orderId: string;
    actorUserId: string | null;
    now?: Date;
  }): Promise<ConfirmOutcome> {
    const { storeId, orderId } = args;
    const now = args.now ?? new Date();
    // Store on its Durable Object (Ruling CF-ORDERS-1): the claim, the payment row and both audit rows are ONE section there.
    // The shopper's proof is read from the DO payment metadata and the DO receipts; unknown = proof.
    const money = await storeMoney(storeId);
    if (money) {
      const r = await money.confirmPayment({
        orderId,
        actorUserId: args.actorUserId,
        proofSubmitted: await InstapayService.proofOnDo(storeId, orderId),
      });
      if (r.changed) {
        // the same post-commit work as the Postgres path: the merchant's confirm approves the submitted receipts and the
        // screenshots are deleted (M-003), the customers cache is busted, the post-payment fan-out and the socket push fire
        try {
          // the receipts were approved INSIDE the DO section (INSTAPAY-DO-1); only the screenshots are left to delete
          await InstapayReceiptService.deleteImages(storeId, r.approvedReceiptIds ?? []);
        } catch (err) {
          logger.error({ err, orderId }, '[INSTAPAY] receipt approval after confirm failed');
        }
        await invalidateCustomersCache(storeId);
        await inngest
          .send({ name: 'order/created', data: { orderId, storeId, paymentMethod: 'instapay' } })
          .catch((err: unknown) =>
            logger.error({ err, orderId }, '[INSTAPAY] failed to enqueue order/created')
          );
        const order = await (
          await storeDb(storeId)
        ).order.findFirst({
          where: { id: orderId, storeId },
          select: { orderNumber: true, total: true, shippingAddress: true },
        });
        if (order) {
          const addr = metaOf(order.shippingAddress);
          const shopper = [addr.firstName, addr.lastName]
            .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
            .join(' ');
          try {
            socketService.newOrderNotification(storeId, {
              orderId,
              orderNumber: order.orderNumber,
              total: order.total,
              customerName: shopper || order.orderNumber,
            });
          } catch (err) {
            logger.warn({ err, orderId }, '[INSTAPAY] socket emit failed');
          }
        }
      }
      return r.changed
        ? { changed: true, orderId: r.orderId, status: 'confirmed' }
        : { changed: false, orderId: r.orderId, status: r.status };
    }
    return withStoreAfterCommit(storeId, async after => {
      const locked = await lockOrder(
        prisma as unknown as Prisma.TransactionClient,
        storeId,
        orderId
      );
      if (!locked) throw new AppError(404, 'NOT_FOUND', 'Order not found');

      if (locked.status !== AWAITING_PAYMENT_CONFIRMATION) {
        // Idempotent: it was confirmed already (by this merchant's second tap, a second
        // staff member, or a retry) and has moved on or not. Nothing changes, nothing re-fires.
        const confirmedBefore = await prisma.payment.findFirst({
          where: { orderId, provider: 'instapay', status: 'completed' },
          select: { id: true },
        });
        if (confirmedBefore && locked.status !== 'cancelled' && locked.status !== 'refunded') {
          return { changed: false, orderId, status: locked.status };
        }
        if (locked.status === 'cancelled') {
          throw new AppError(
            409,
            'INSTAPAY_ORDER_CANCELLED',
            'This order was cancelled (the confirmation window may have expired)'
          );
        }
        throw new AppError(
          409,
          'INSTAPAY_NOT_AWAITING',
          'This order is not waiting for an InstaPay confirmation'
        );
      }

      const payment = await prisma.payment.findFirst({
        where: { orderId, provider: 'instapay', status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      if (!payment) throw new AppError(409, 'INSTAPAY_NOT_AWAITING', 'No pending InstaPay payment');

      // A shopper who already sent proof keeps the order confirmable past the window
      // (audit O1): the merchant was the one who had not looked yet.
      const expiresAt = locked.payment_confirmation_expires_at;
      if (
        expiresAt &&
        expiresAt.getTime() <= now.getTime() &&
        !(await InstapayService.proofSubmitted(storeId, orderId, payment.metadata))
      ) {
        throw new AppError(
          409,
          'INSTAPAY_CONFIRMATION_EXPIRED',
          'The confirmation window for this order has expired'
        );
      }

      const claimed = await prisma.order.updateMany({
        where: { id: orderId, storeId, status: AWAITING_PAYMENT_CONFIRMATION },
        data: { status: 'confirmed', paymentStatus: 'paid' },
      });
      if (claimed.count !== 1) {
        // Cannot happen under the row lock; refuse rather than half-apply.
        throw new AppError(409, 'INSTAPAY_NOT_AWAITING', 'The order changed while confirming');
      }
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'completed',
          paidAt: now,
          metadata: {
            ...metaOf(payment.metadata),
            confirmedVia: 'merchant_instapay_confirm',
            confirmedBy: args.actorUserId,
            confirmedAt: now.toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
      // The merchant's confirm IS the approval of the shopper's submitted receipt(s).
      const approvedReceiptIds = await InstapayReceiptService.approveSubmitted(
        prisma as unknown as Prisma.TransactionClient,
        storeId,
        { orderId },
        args.actorUserId,
        now
      );
      // The screenshot has done its job once a human approved the payment (M-003): delete it after the COMMIT.
      after('instapay.receipt.image-delete', () =>
        InstapayReceiptService.deleteImages(storeId, approvedReceiptIds)
      );
      await prisma.orderEvent.create({
        data: {
          storeId,
          orderId,
          fromStatus: AWAITING_PAYMENT_CONFIRMATION,
          toStatus: 'confirmed',
          actorId: args.actorUserId,
          metadata: { via: 'instapay_confirm', amountMinor: payment.amount },
        },
      });
      await recordPaymentEvent({
        paymentId: payment.id,
        storeId,
        orderId,
        eventType: 'admin_action',
        fromStatus: 'pending',
        toStatus: 'completed',
        provider: 'instapay',
        triggeredByUserId: args.actorUserId,
        details: { reason: 'merchant_confirmed_instapay_transfer', amountMinor: payment.amount },
      });

      // After COMMIT, exactly once (we are inside the one winning transition): the same
      // post-payment fan-out a gateway webhook triggers (customer confirmation, admin push,
      // accounting journal, loyalty) and the customers-cache bust.
      after('instapay.confirmed.fanout', async () => {
        await invalidateCustomersCache(storeId);
        await inngest
          .send({
            name: 'order/created',
            data: { orderId, storeId, paymentMethod: 'instapay' },
          })
          .catch((err: unknown) =>
            logger.error({ err, orderId }, '[INSTAPAY] failed to enqueue order/created')
          );
        const order = await prisma.order.findFirst({
          where: { id: orderId, storeId },
          select: { orderNumber: true, total: true, shippingAddress: true },
        });
        if (order) {
          // The shopper's name (audit X4), not the payment method.
          const addr = metaOf(order.shippingAddress);
          const shopper = [addr.firstName, addr.lastName]
            .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
            .join(' ');
          try {
            socketService.newOrderNotification(storeId, {
              orderId,
              orderNumber: order.orderNumber,
              total: order.total,
              customerName: shopper || order.orderNumber,
            });
          } catch (err) {
            logger.warn({ err, orderId }, '[INSTAPAY] socket emit failed');
          }
        }
      });
      return { changed: true, orderId, status: 'confirmed' };
    });
  }

  /**
   * Cancel ONE awaiting order whose hold has run out. Inventory is released by the
   * normal cancel path (`OrderService.updateStatus`), which also enqueues the
   * customer's cancellation notification. Safe to call repeatedly and concurrently
   * with `confirm` (row lock): an order confirmed first is skipped.
   */
  static async expireOne(
    storeId: string,
    orderId: string,
    now: Date = new Date()
  ): Promise<'expired' | 'skipped'> {
    // Store on its Durable Object (Ruling CF-ORDERS-1): the window check, the cancel with its whole reversal and the
    // payment expiry are ONE section there, safe against a concurrent confirm. A shopper who sent proof is never expired
    // (audit O1); if the proof state cannot be read the order is SKIPPED (fail closed), never cancelled.
    const money = await storeMoney(storeId);
    if (money) {
      let proof: boolean;
      try {
        proof = await InstapayService.proofOnDo(storeId, orderId, true);
      } catch (err) {
        logger.error({ err, orderId }, '[INSTAPAY] proof state unreadable, expiry skipped');
        return 'skipped';
      }
      const r = await money.expireHold({ orderId, proofSubmitted: proof });
      if (r === 'expired') {
        await OrderService.applyRefundEffects(storeId, orderId, { fireRefundNotification: false });
        await InstapayService.notifyMerchantExpired(storeId, orderId).catch((err: unknown) =>
          logger.error({ err, orderId }, '[INSTAPAY] expiry notification failed')
        );
      }
      return r;
    }
    return withStoreAfterCommit(storeId, async after => {
      const locked = await lockOrder(
        prisma as unknown as Prisma.TransactionClient,
        storeId,
        orderId
      );
      if (
        !locked ||
        locked.status !== AWAITING_PAYMENT_CONFIRMATION ||
        !locked.payment_confirmation_expires_at ||
        locked.payment_confirmation_expires_at.getTime() > now.getTime()
      ) {
        return 'skipped';
      }
      // Never cancel an order whose shopper already sent proof (audit O1): it waits for
      // the merchant's review. (A submitted receipt also clears the deadline; this catches
      // orders whose reference was sent before receipts existed.)
      const pendingPayment = await prisma.payment.findFirst({
        where: { orderId, provider: 'instapay', status: 'pending' },
        orderBy: { createdAt: 'desc' },
        select: { metadata: true },
      });
      if (await InstapayService.proofSubmitted(storeId, orderId, pendingPayment?.metadata)) {
        return 'skipped';
      }
      const before = await prisma.order.findFirst({
        where: { id: orderId, storeId },
        select: { notes: true },
      });
      await OrderService.updateStatus(storeId, orderId, 'cancelled');
      await prisma.order.update({
        where: { id: orderId, storeId },
        data: {
          notes:
            (before?.notes ? before.notes + '\n' : '') +
            '[auto-cancelled: InstaPay confirmation window expired]',
        },
      });
      const payment = await prisma.payment.findFirst({
        where: { orderId, provider: 'instapay', status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      if (payment) {
        await prisma.payment.update({ where: { id: payment.id }, data: { status: 'expired' } });
        await recordPaymentEvent({
          paymentId: payment.id,
          storeId,
          orderId,
          eventType: 'status_change',
          fromStatus: 'pending',
          toStatus: 'expired',
          provider: 'instapay',
          details: { reason: 'instapay_confirmation_window_expired' },
        });
      }
      after('instapay.expired.notify', () =>
        InstapayService.notifyMerchantExpired(storeId, orderId)
      );
      return 'expired';
    });
  }

  /** The expiry sweep for ONE store (called per store by the cron, `acrossStores`). */
  static async expireDue(storeId: string, now: Date = new Date(), limit = 200) {
    const due = await withStore(storeId, () =>
      prisma.order.findMany({
        where: {
          storeId,
          status: AWAITING_PAYMENT_CONFIRMATION,
          deletedAt: null,
          paymentConfirmationExpiresAt: { lte: now },
        },
        select: { id: true },
        orderBy: { paymentConfirmationExpiresAt: 'asc' },
        take: limit,
      })
    );
    let expired = 0;
    let failed = 0;
    for (const { id } of due) {
      try {
        if ((await this.expireOne(storeId, id, now)) === 'expired') expired += 1;
      } catch (err) {
        failed += 1;
        logger.error({ err, storeId, orderId: id }, '[INSTAPAY] expiry failed for order');
      }
    }
    return { storeId, scanned: due.length, expired, failed };
  }

  /**
   * Has the shopper sent proof of this InstaPay transfer? The reference lives in the pending payment's metadata (on the
   * store's Durable Object), the receipts in Postgres until they move. With `strict` an unreadable state THROWS (the caller
   * fails closed); otherwise it answers true (a confirm past the window is the safe direction).
   */
  static async proofOnDo(storeId: string, orderId: string, strict = false): Promise<boolean> {
    try {
      const pay = await (
        await storeDb(storeId)
      ).payment.findFirst({
        where: { orderId, provider: 'instapay', status: 'pending' },
        orderBy: { createdAt: 'desc' },
        select: { metadata: true },
      });
      return await InstapayService.proofSubmitted(storeId, orderId, pay?.metadata);
    } catch (err) {
      if (strict) throw err;
      logger.error({ err, orderId }, '[INSTAPAY] proof state unreadable, treated as proof sent');
      return true;
    }
  }

  /** The shopper sent proof that is waiting for the merchant: a submitted receipt, or a legacy reference. */
  static async proofSubmitted(
    storeId: string,
    orderId: string,
    paymentMetadata: unknown
  ): Promise<boolean> {
    if (typeof metaOf(paymentMetadata).customerReference === 'string') return true;
    const money = await storeMoney(storeId);
    if (money) return (await money.receiptProof({ orderId })).submitted > 0;
    const n = await prisma.instapayReceipt.count({
      where: { storeId, kind: 'order', orderId, status: 'submitted' },
    });
    return n > 0;
  }

  /** The order + its pending InstaPay payment, for the receipt endpoints (public by order id). */
  private static async awaitingOrder(storeId: string, orderId: string) {
    const db = (await storeMoney(storeId)) ? await storeDb(storeId) : prisma;
    const order = await db.order.findFirst({
      where: { id: orderId, storeId, deletedAt: null },
      select: { id: true, status: true, createdAt: true },
    });
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    if (order.status !== AWAITING_PAYMENT_CONFIRMATION) {
      throw new AppError(409, 'INSTAPAY_NOT_AWAITING', 'This order is not waiting for a transfer');
    }
    const payment = await db.payment.findFirst({
      where: { orderId, provider: 'instapay', status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) throw new AppError(404, 'NOT_FOUND', 'No InstaPay payment for this order');
    return { order, payment };
  }

  /** Shopper: upload the transfer screenshot (the AI read is queued). */
  static async uploadReceipt(storeId: string, orderId: string, file: Buffer) {
    const { payment } = (await storeMoney(storeId))
      ? await this.awaitingOrder(storeId, orderId)
      : await withStore(storeId, () => this.awaitingOrder(storeId, orderId));
    return InstapayReceiptService.upload({
      storeId,
      kind: 'order',
      orderId,
      paymentId: payment.id,
      file,
    });
  }

  /** Shopper: poll the AI read of one of this order's receipts. */
  static async getReceipt(storeId: string, orderId: string, receiptId: string) {
    return toReceiptView(
      await InstapayReceiptService.get(storeId, receiptId, { kind: 'order', orderId })
    );
  }

  /**
   * Shopper: submit the (corrected) receipt fields. Duplicate reference anywhere = 409;
   * every other check is a flag for the merchant. Freezes the hold so the order is not
   * auto-cancelled while the merchant reviews (audit O1), and tells the merchant.
   */
  static async submitReceipt(args: {
    storeId: string;
    orderId: string;
    receiptId: string;
    fields: InstapayReceiptFields;
    now?: Date;
  }) {
    const { storeId, orderId } = args;
    const now = args.now ?? new Date();
    // Store on its Durable Object (Ruling INSTAPAY-DO-1): the receipt, the hold freeze, the payment metadata and the payment
    // event are ONE section there, in place of lockOrder + the savepoint below. No Postgres transaction is open around it.
    if (await storeMoney(storeId)) {
      const { order, payment } = await this.awaitingOrder(storeId, orderId);
      const m = metaOf(payment.metadata);
      const receipt = await InstapayReceiptService.submit({
        storeId,
        receiptId: args.receiptId,
        scope: { kind: 'order', orderId },
        fields: args.fields,
        expectedAmountMinor: payment.amount,
        expectedReceivers: [m.handle, m.phone].filter((v): v is string => typeof v === 'string'),
        notBefore: new Date(order.createdAt.getTime() - 5 * 60_000),
        now,
      });
      await InstapayService.notifyMerchant(storeId, orderId, 'proof_submitted').catch(
        (err: unknown) => logger.error({ err, orderId }, '[INSTAPAY] proof notification failed')
      );
      return toReceiptView(receipt);
    }
    return withStoreAfterCommit(storeId, async after => {
      const locked = await lockOrder(
        prisma as unknown as Prisma.TransactionClient,
        storeId,
        orderId
      );
      if (!locked) throw new AppError(404, 'NOT_FOUND', 'Order not found');
      const { order, payment } = await this.awaitingOrder(storeId, orderId);
      const live = await prisma.instapayReceipt.count({
        where: { storeId, kind: 'order', orderId, status: 'submitted' },
      });
      if (live > 0) {
        throw new AppError(
          409,
          'PROOF_PENDING_REVIEW',
          'Your receipt is already waiting for the store'
        );
      }
      const m = metaOf(payment.metadata);
      const receipt = await InstapayReceiptService.submit({
        storeId,
        receiptId: args.receiptId,
        scope: { kind: 'order', orderId },
        fields: args.fields,
        expectedAmountMinor: payment.amount,
        expectedReceivers: [m.handle, m.phone].filter((v): v is string => typeof v === 'string'),
        notBefore: new Date(order.createdAt.getTime() - 5 * 60_000),
        now,
      });
      await prisma.order.updateMany({
        where: { id: orderId, storeId, status: AWAITING_PAYMENT_CONFIRMATION },
        data: { paymentConfirmationExpiresAt: null },
      });
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          metadata: {
            ...m,
            customerReference: receipt.reference,
            customerReferenceAt: now.toISOString(),
            receiptId: receipt.id,
          } as Prisma.InputJsonValue,
        },
      });
      await recordPaymentEvent({
        paymentId: payment.id,
        storeId,
        orderId,
        eventType: 'status_change',
        fromStatus: 'pending',
        toStatus: 'pending',
        provider: 'instapay',
        details: {
          reason: 'customer_receipt_submitted',
          receiptId: receipt.id,
          flags: receipt.flags,
        },
      });
      after('instapay.proof.notify', () =>
        InstapayService.notifyMerchant(storeId, orderId, 'proof_submitted')
      );
      return toReceiptView(receipt);
    });
  }

  /**
   * Merchant: reject the shopper's receipt with a reason. The order stays awaiting; the
   * hold restarts at max(original deadline, now + 24 h) so the shopper can send the
   * right receipt; the reference is freed.
   */
  static async rejectReceipt(args: {
    storeId: string;
    orderId: string;
    receiptId: string;
    note: string;
    actorUserId: string;
    now?: Date;
  }) {
    const { storeId, orderId } = args;
    const now = args.now ?? new Date();
    const note = args.note.trim();
    if (note.length < 3)
      throw new AppError(400, 'REASON_REQUIRED', 'Write why the receipt is rejected');
    // Store on its Durable Object (Ruling INSTAPAY-DO-1): the decision, the new deadline, the payment metadata and the event are one section
    const onDo = await InstapayReceiptService.rejectOnDo({ ...args, note });
    if (onDo) return onDo;
    return withClaimReleases(() => InstapayService.rejectReceiptPg(args, note, now));
  }

  private static async rejectReceiptPg(
    args: { storeId: string; orderId: string; receiptId: string; actorUserId: string },
    note: string,
    now: Date
  ) {
    const { storeId, orderId } = args;
    return withStoreAfterCommit(storeId, async () => {
      const locked = await lockOrder(
        prisma as unknown as Prisma.TransactionClient,
        storeId,
        orderId
      );
      if (!locked) throw new AppError(404, 'NOT_FOUND', 'Order not found');
      if (locked.status !== AWAITING_PAYMENT_CONFIRMATION) {
        throw new AppError(
          409,
          'INSTAPAY_NOT_AWAITING',
          'This order is not waiting for a transfer'
        );
      }
      await InstapayReceiptService.get(storeId, args.receiptId, { kind: 'order', orderId });
      const n = await InstapayReceiptService.markReviewed(
        storeId,
        args.receiptId,
        { status: 'rejected', note },
        args.actorUserId,
        now
      );
      if (n === 0)
        throw new AppError(409, 'RECEIPT_NOT_PENDING', 'This receipt is not waiting for review');
      const payment = await prisma.payment.findFirst({
        where: { orderId, provider: 'instapay', status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      const m = metaOf(payment?.metadata);
      const original = typeof m.expiresAt === 'string' ? new Date(m.expiresAt).getTime() : 0;
      const expiresAt = new Date(Math.max(original, now.getTime() + 24 * HOUR_MS));
      await prisma.order.updateMany({
        where: { id: orderId, storeId, status: AWAITING_PAYMENT_CONFIRMATION },
        data: { paymentConfirmationExpiresAt: expiresAt },
      });
      if (payment) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            metadata: {
              ...m,
              customerReference: null,
              receiptRejectedAt: now.toISOString(),
            } as Prisma.InputJsonValue,
          },
        });
        await recordPaymentEvent({
          paymentId: payment.id,
          storeId,
          orderId,
          eventType: 'admin_action',
          fromStatus: 'pending',
          toStatus: 'pending',
          provider: 'instapay',
          triggeredByUserId: args.actorUserId,
          details: { reason: 'merchant_rejected_receipt', receiptId: args.receiptId, note },
        });
      }
      return {
        receiptId: args.receiptId,
        status: 'rejected' as const,
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  /**
   * Merchant: RECORD an InstaPay refund that was made outside Ebda (audit M1 twin for
   * orders). Idempotent on the refund reference. The full amount moves the order to
   * `refunded` through the normal status path (stock, coupon, loyalty reversal and the
   * customer's refund notice — true now: the money went back); a part is recorded on
   * the payment (partially_refunded) without touching stock.
   */
  static async recordRefund(args: {
    storeId: string;
    orderId: string;
    input: InstapayRefundRecord;
    screenshot?: Buffer | null;
    actorUserId: string;
    now?: Date;
  }) {
    const { storeId, orderId, input } = args;
    const now = args.now ?? new Date();
    const refundRef = normalizeInstapayReference(input.reference);
    if (!refundRef)
      throw new AppError(400, 'INVALID_REFERENCE', 'The refund reference is 8 to 20 digits');
    const refundedAt = zonedLocalToUtc(input.refundDate, input.refundTime, REGION.timezone);
    if (!refundedAt) throw new AppError(400, 'INVALID_DATE', 'The refund date is not valid');
    if (refundedAt.getTime() > now.getTime() + 10 * 60_000) {
      throw new AppError(400, 'DATE_IN_FUTURE', 'The refund date is in the future');
    }
    let screenshotKey: string | null = null;
    if (args.screenshot?.length) {
      const mime = sniffReceiptMime(args.screenshot);
      if (!mime)
        throw new AppError(400, 'INVALID_FILE_TYPE', 'Upload a JPG, PNG or WebP screenshot');
      screenshotKey = (
        await StorageService.putPrivate(args.screenshot, {
          storeId,
          folder: 'instapay-refunds',
          ext: mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg',
          contentType: mime,
        })
      ).key;
    }
    try {
      return await withStore(storeId, async () => {
        const order = await prisma.order.findFirst({
          where: { id: orderId, storeId, deletedAt: null },
          select: { id: true, status: true, paymentStatus: true },
        });
        if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
        // Serialise recorders (M-063): the SAME order lock confirm / expiry / cancel take, then the payment row. The
        // payment is re-read AFTER the locks, so a double submit (or two staff) sees the first one's refund: the
        // duplicate-reference check, `remaining` and the metadata array are all judged on the locked row.
        await lockOrder(prisma as unknown as Prisma.TransactionClient, storeId, orderId);
        const candidate = await prisma.payment.findFirst({
          where: {
            orderId,
            provider: 'instapay',
            status: { in: ['completed', 'partially_refunded', 'refunded'] },
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (candidate) {
          await prisma.$queryRaw`SELECT id FROM payments WHERE id = ${candidate.id} FOR UPDATE`;
        }
        const payment = candidate
          ? await prisma.payment.findUnique({ where: { id: candidate.id } })
          : null;
        if (!payment) {
          throw new AppError(
            409,
            'NO_INSTAPAY_PAYMENT',
            'This order has no confirmed InstaPay payment'
          );
        }
        const m = metaOf(payment.metadata);
        const refunds = Array.isArray(m.refunds)
          ? (m.refunds as Array<Record<string, unknown>>)
          : [];
        const dup = refunds.find(r => r.referenceKey === refundRef);
        if (dup)
          return {
            duplicate: true,
            refundedAmount: payment.refundedAmount,
            status: payment.status,
          };
        const remaining = payment.amount - payment.refundedAmount;
        if (remaining <= 0)
          throw new AppError(409, 'ALREADY_REFUNDED', 'This payment is fully refunded');
        if (input.amountMinor > remaining) {
          throw new AppError(
            400,
            'INVALID_REFUND_AMOUNT',
            `Refund must be between 1 and ${remaining} piastres`
          );
        }
        const full = input.amountMinor === remaining;
        const record = {
          referenceKey: refundRef,
          reference: input.reference.trim(),
          refundedAt: refundedAt.toISOString(),
          recipientName: input.recipientName.trim(),
          amountMinor: input.amountMinor,
          note: input.note?.trim() || null,
          screenshotKey,
          recordedBy: args.actorUserId,
          recordedAt: now.toISOString(),
        };
        if (full && order.status !== 'refunded') {
          // Before the payment flip: the refund effects key off the PRE-transition snapshot.
          await OrderService.updateStatus(storeId, orderId, 'refunded');
        }
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: full ? 'refunded' : 'partially_refunded',
            refundedAmount: { increment: input.amountMinor },
            metadata: { ...m, refunds: [...refunds, record] } as Prisma.InputJsonValue,
          },
        });
        if (full) {
          await prisma.order.updateMany({
            where: { id: orderId, storeId },
            data: { paymentStatus: 'refunded' },
          });
        }
        await recordPaymentEvent({
          paymentId: payment.id,
          storeId,
          orderId,
          eventType: 'refund',
          fromStatus: payment.status,
          toStatus: full ? 'refunded' : 'partially_refunded',
          provider: 'instapay',
          triggeredByUserId: args.actorUserId,
          details: { reason: 'merchant_recorded_instapay_refund', ...record },
        });
        return {
          duplicate: false,
          refundedAmount: payment.refundedAmount + input.amountMinor,
          status: full ? 'refunded' : 'partially_refunded',
        };
      });
    } catch (err) {
      if (screenshotKey) await StorageService.deletePrivate(screenshotKey).catch(() => undefined);
      throw err;
    }
  }

  static async notifyMerchantAwaiting(storeId: string, orderId: string): Promise<void> {
    await this.notifyMerchant(storeId, orderId, 'awaiting');
  }

  static async notifyMerchantExpired(storeId: string, orderId: string): Promise<void> {
    await this.notifyMerchant(storeId, orderId, 'expired');
  }

  static async notifyMerchant(
    storeId: string,
    orderId: string,
    kind: 'awaiting' | 'expired' | 'proof_submitted'
  ): Promise<void> {
    const order = await (
      await storeDb(storeId)
    ).order.findFirst({
      where: { id: orderId, storeId },
      select: { orderNumber: true, total: true, currency: true },
    });
    const store = await withStore(storeId, tx =>
      tx.store.findUnique({ where: { id: storeId }, select: { name: true } })
    );
    if (!order) return;
    await OneSignalService.notifyAdminsOfInstapay({
      orderId,
      orderNumber: order.orderNumber,
      storeId,
      storeName: store?.name ?? storeId,
      total: order.total,
      currency: order.currency,
      kind,
    });
  }
}
