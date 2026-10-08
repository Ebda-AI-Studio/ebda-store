/**
 * Server-to-server confirmation of a Kashier webhook (Ruling PROVIDERS-17).
 *
 * Kashier's webhook signature covers the `data` keys the payload lists in `signatureKeys`,
 * but NOT the top-level `event` that says whether the delivery is a payment, an
 * authorization or a refund. A captured genuine delivery can therefore be relabelled
 * (`pay` -> `refund`, `authorize` -> `pay`) and still verify. Before any Kashier delivery
 * changes money state it is confirmed against Kashier's own record of that transaction:
 *
 *   GET {test-api|api}.kashier.io/v2/aggregator/transactions/:transactionId
 *   Authorization: <secret key>                                  (raw, no Bearer)
 *
 * Source: developers.kashier.io/docs/accept-payments/transactions and the API reference
 * `getTransactionDetails` (fetched 2026-10-08). Documented: the path, the auth header, that
 * the response is `{ body: {...}, message }`, that `body.status` is the STORED status
 * (`SUCCESS` | `FAILURE` | `PENDING`, the same vocabulary as the webhook's `data.status`), and
 * the example's `body.transactionId`, `body.trxType: "payment"`, `body.merchantOrderId`
 * (a number in the example) and `body.transactions[]` (`operation`, `status`,
 * `transactionId`). `TransactionStatus` also lists INITIATED / UNKNOWN / EXPIRED / CANCEL /
 * REVOKED.
 *
 * UNVERIFIED (docs are silent; the example is a payment, abridged):
 *  - the `trxType` / `operation` value of a REFUND transaction. The list endpoint's `type`
 *    filter documents `REFUND` (and `refund`), the order-search example documents operations
 *    `pay` and `3dsecure_verify`, the webhook names `refund`; we accept `refund`,
 *    `partial_refund`, `void`, `reversal` as refunds and nothing else;
 *  - whether a refund transaction's details carry `merchantOrderId`: checked when present;
 *  - whether a transaction can be queried the instant its webhook arrives. A 404 is
 *    treated as "not confirmable YET" (retried), never as "did not happen".
 *
 * Anything the answer does not state clearly is NOT a confirmation: the caller throws, the
 * webhook queue retries, and nothing is applied until Kashier answers.
 */

export const KASHIER_TRANSACTION_DETAILS_SOURCE =
  'kashier GET /v2/aggregator/transactions/:transactionId';

export const kashierTransactionDetailsPath = (transactionId: string): string =>
  `/v2/aggregator/transactions/${encodeURIComponent(transactionId)}`;

/** What a Kashier transaction IS, according to Kashier. */
export type KashierTxnKind = 'payment' | 'authorize' | 'refund';
/** Kashier's stored status, folded to the three outcomes money logic can act on. */
export type KashierTxnStatus = 'SUCCESS' | 'FAILURE' | 'PENDING';

export interface KashierConfirmedTxn {
  kind: KashierTxnKind;
  status: KashierTxnStatus;
  /** The operation or trxType Kashier reported (lowercase), for the audit row. */
  operation: string;
}

/** Why a details answer is not a confirmation. Callers turn it into "retry, apply nothing". */
export class KashierUnconfirmedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KashierUnconfirmedError';
  }
}

const REFUND_OPS = new Set(['refund', 'partial_refund', 'void', 'reversal']);
const PAYMENT_OPS = new Set(['pay', 'payment', 'capture']);
const AUTHORIZE_OPS = new Set(['authorize', 'authorization']);

const STATUS_FOLD: Record<string, KashierTxnStatus> = {
  SUCCESS: 'SUCCESS',
  FAILURE: 'FAILURE',
  PENDING: 'PENDING',
  // Docs: INITIATED, UNKNOWN and PENDING all map to order INITIATED, "neither paid nor failed".
  INITIATED: 'PENDING',
  UNKNOWN: 'PENDING',
  // Terminal non-success outcomes: nothing was taken / returned.
  EXPIRED: 'FAILURE',
  CANCEL: 'FAILURE',
  REVOKED: 'FAILURE',
};

const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';

/**
 * Read a `getTransactionDetails` answer for `transactionId` (and, when Kashier states one,
 * `merchantOrderId`). Throws `KashierUnconfirmedError` for anything that is not a clear,
 * matching record: a missing body, a different transaction, a different order, an
 * operation or status we do not know.
 */
export function classifyKashierTransaction(
  response: unknown,
  expect: { transactionId: string; merchantOrderId: string | null }
): KashierConfirmedTxn {
  const body =
    response && typeof response === 'object' ? (response as { body?: unknown }).body : undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new KashierUnconfirmedError('transaction details carried no body');
  }
  const b = body as Record<string, unknown>;
  if (str(b.transactionId) !== expect.transactionId) {
    throw new KashierUnconfirmedError('transaction details are for a different transaction');
  }
  const reportedOrder = str(b.merchantOrderId);
  if (reportedOrder && expect.merchantOrderId && reportedOrder !== expect.merchantOrderId) {
    throw new KashierUnconfirmedError('transaction belongs to a different order');
  }

  // The entry for THIS transaction in `transactions[]` is the most specific statement of what
  // it is; `trxType` is the record-level fallback.
  const entries = Array.isArray(b.transactions) ? b.transactions : [];
  const entry = entries.find(
    (t): t is Record<string, unknown> =>
      !!t &&
      typeof t === 'object' &&
      str((t as Record<string, unknown>).transactionId) === expect.transactionId
  );
  const operation = (str(entry?.operation) || str(b.trxType)).toLowerCase();
  let kind: KashierTxnKind;
  if (REFUND_OPS.has(operation)) kind = 'refund';
  else if (AUTHORIZE_OPS.has(operation)) kind = 'authorize';
  else if (PAYMENT_OPS.has(operation)) kind = 'payment';
  else throw new KashierUnconfirmedError(`unknown transaction operation "${operation}"`);

  const rawStatus = (str(entry?.status) || str(b.status)).toUpperCase();
  const status = STATUS_FOLD[rawStatus];
  if (!status) throw new KashierUnconfirmedError(`unknown transaction status "${rawStatus}"`);
  return { kind, status, operation };
}
