/**
 * The admin "refund this order through its payment provider" action, shared by `POST /stores/:storeId/orders/:orderId/refund-via-provider`
 * (routes/order.routes.ts) and the Ebda assistant tool `order_refund`. The route keeps its HTTP answers and audit row; everything that decides
 * whether money can move and then moves it lives here once, so the two callers cannot drift.
 */
import logger from '../lib/logger';
import { storeDb } from '../lib/repo-factory';
import { runInStoreCtx } from '../lib/jobs/store-db';
import { opKey, withIdempotencyKey } from '../lib/money-idempotency';
import { AppError } from '../middleware/error-handler';
import { PaymentService } from './payment-providers/payment.factory';
import { refundMayHaveExecuted } from './payment-providers/refund-outcome';

type RefundLookup =
  | { kind: 'not_found' }
  | { kind: 'no_payment' }
  | { kind: 'already_refunded' }
  | {
      kind: 'ok';
      order: { id: string; orderNumber: string; paymentStatus: string };
      payment: {
        transactionId: string;
        provider: string;
        amount: number | null;
        refundedAmount: number | null;
      };
    };

/** The order and the one payment a provider refund would act on. A partially refunded payment still has a refundable balance (#1360). */
export async function lookupRefundTarget(storeId: string, orderId: string): Promise<RefundLookup> {
  const db = await storeDb(storeId);
  const order = await db.order.findFirst({
    where: { id: orderId, storeId, deletedAt: null },
    include: {
      payments: {
        where: { status: { in: ['completed', 'partially_refunded'] } },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });
  if (!order) return { kind: 'not_found' };
  const payment = order.payments[0];
  if (!payment || !payment.transactionId) return { kind: 'no_payment' };
  if (order.paymentStatus === 'refunded') return { kind: 'already_refunded' };
  return {
    kind: 'ok',
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      paymentStatus: String(order.paymentStatus),
    },
    payment: {
      transactionId: payment.transactionId,
      provider: String(payment.provider),
      amount: payment.amount ?? null,
      refundedAmount: payment.refundedAmount ?? null,
    },
  };
}

/** Calls the provider and books the refund. A failure anywhere in the chain is a non-2xx AppError; a possibly-executed refund keeps its own code. */
export async function refundThroughProvider(args: {
  storeId: string;
  orderId: string;
  orderNumber: string;
  payment: { transactionId: string; provider: string };
  amount?: number;
  reason?: string;
  idempotencyKey: string;
}) {
  const { storeId, orderId, payment, idempotencyKey: idem } = args;
  try {
    const scope = `refund-via-provider:${storeId}:${orderId}`;
    return (
      await withIdempotencyKey(
        scope,
        idem,
        () =>
          runInStoreCtx(storeId, async () =>
            // the store id selects the store's backend (a Durable Object store refunds through its own section)
            PaymentService.refund(
              {
                transactionId: payment.transactionId,
                amount: args.amount,
                reason: args.reason,
                attemptKey: opKey(scope, idem),
              },
              undefined,
              storeId
            )
          ),
        refundMayHaveExecuted,
        { required: true }
      )
    ).value;
  } catch (refundError) {
    // a replay refusal / a may-have-executed failure keeps its own code (409 / 502): the admin must check, not retry
    if (
      refundError instanceof AppError &&
      (refundError.statusCode < 500 || refundMayHaveExecuted(refundError))
    )
      throw refundError;
    const refundMessage =
      refundError instanceof Error ? refundError.message : 'Unknown refund error';
    logger.error(
      {
        err: refundError,
        orderId,
        orderNumber: args.orderNumber,
        transactionId: payment.transactionId,
        provider: payment.provider,
        amount: args.amount,
      },
      '[Refund] admin-initiated provider refund failed'
    );
    throw new AppError(502, 'REFUND_FAILED', refundMessage);
  }
}
