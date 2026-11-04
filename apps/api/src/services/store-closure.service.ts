import type { Prisma } from '@ebda/database';
import { AppError } from '../middleware/error-handler';
import logger from '../lib/logger';
import { FISCAL_RETENTION_YEARS } from './fiscal-document.service';
import { onD1 } from './platform/billing-d1';
import crypto from 'crypto';

/**
 * What a store deletion must check and keep (ruling MONEYB-4).
 *
 * 1. REFUSE while money is in flight — a hard delete would erase the only
 *    record of money the merchant or Ebda still owes or is owed:
 *    paid-but-undelivered orders, InstaPay transfers awaiting confirmation,
 *    returns not yet settled, COD shipments still out or delivered with the
 *    cash not yet recorded, payments mid-refund or disputed.
 * 2. ARCHIVE the fiscal records the delete would otherwise cascade away, into
 *    the immutable `fiscal_documents` table (no FK to stores, kept 6 years):
 *    every order that has no issued sale document (orders placed before
 *    numbering existed) as an `order_record`, and every row of Ebda's own
 *    `billing_events` VAT ledger as a `billing_record`. Issued invoices,
 *    receipts and credit notes are already there and are untouched.
 *    Personal data is minimised: archive records carry no buyer name,
 *    address, phone or email (PDPL 151/2020 Art. 3 — legal-obligation basis
 *    covers the fiscal fields only).
 *
 * Both run inside the deletion's own store-scoped transaction, so a refusal or
 * an archive failure rolls the whole deletion back.
 */

export interface MoneyInFlight {
  paidUndelivered: number;
  awaitingTransferConfirmation: number;
  openReturns: number;
  codOutstanding: number;
  paymentsInDispute: number;
}

export async function moneyInFlight(
  tx: Prisma.TransactionClient,
  storeId: string
): Promise<MoneyInFlight> {
  const rows = await tx.$queryRaw<
    Array<{
      paid_undelivered: bigint;
      awaiting: bigint;
      open_returns: bigint;
      cod_outstanding: bigint;
      disputed: bigint;
    }>
  >`
    SELECT
      (SELECT count(*) FROM public.orders o
        WHERE o.store_id = ${storeId}
          AND o.payment_status = 'paid'
          AND o.status NOT IN ('delivered', 'cancelled', 'refunded')) AS paid_undelivered,
      (SELECT count(*) FROM public.orders o
        WHERE o.store_id = ${storeId}
          AND o.status = 'awaiting_payment_confirmation') AS awaiting,
      (SELECT count(*) FROM public.returns r
        WHERE r.store_id = ${storeId}
          AND r.status IN ('pending', 'approved', 'shipped', 'received', 'inspecting')) AS open_returns,
      (SELECT count(*) FROM public.shipments s
         JOIN public.orders o ON o.id = s.order_id
        WHERE s.store_id = ${storeId}
          AND s.cod_amount > 0
          AND (s.status NOT IN ('delivered', 'cancelled', 'returned')
               OR (s.status = 'delivered' AND o.payment_status <> 'paid'))) AS cod_outstanding,
      (SELECT count(*) FROM public.payments p
         JOIN public.orders o ON o.id = p.order_id
        WHERE o.store_id = ${storeId}
          AND p.status IN ('processing', 'disputed')) AS disputed`;
  const r = rows[0];
  return {
    paidUndelivered: Number(r?.paid_undelivered ?? 0),
    awaitingTransferConfirmation: Number(r?.awaiting ?? 0),
    openReturns: Number(r?.open_returns ?? 0),
    codOutstanding: Number(r?.cod_outstanding ?? 0),
    paymentsInDispute: Number(r?.disputed ?? 0),
  };
}

export async function assertNoMoneyInFlight(
  tx: Prisma.TransactionClient,
  storeId: string
): Promise<void> {
  const flight = await moneyInFlight(tx, storeId);
  const total = Object.values(flight).reduce((n, v) => n + v, 0);
  if (total > 0) {
    throw new AppError(
      409,
      'STORE_HAS_MONEY_IN_FLIGHT',
      'This store still has money in flight (paid orders not delivered, transfers awaiting confirmation, open returns, cash on delivery not settled, or payments in dispute). Settle them before deleting the store.',
      { ...flight }
    );
  }
}

/**
 * Copy the fiscal records a store deletion would cascade away into the
 * immutable archive. Returns how many rows were archived.
 */
export async function archiveFiscalRecords(
  tx: Prisma.TransactionClient,
  storeId: string
): Promise<{ orders: number; billingEvents: number }> {
  const years = FISCAL_RETENTION_YEARS;
  // Orders with no issued sale document: their fiscal fields + lines, NO buyer data.
  const orders = await tx.$executeRaw`
    INSERT INTO public.fiscal_documents
      (id, store_id, order_id, doc_type, status, issued_at, currency,
       net_amount, vat_amount, total_amount, vat_rate_bps, seller_trn, payload, retain_until)
    SELECT
      gen_random_uuid()::text, o.store_id, o.id, 'order_record'::"FiscalDocType", 'issued',
      o.created_at, o.currency,
      GREATEST(0, COALESCE(o.taxable_amount,
        o.subtotal - o.discount - CASE WHEN o.tax_included_in_price THEN o.tax ELSE 0 END)),
      GREATEST(0, o.tax), GREATEST(0, o.total), o.tax_rate_bps, o.seller_tax_registration_number,
      jsonb_build_object(
        'version', 1,
        'archivedAt', now(),
        'reason', 'store_deleted',
        'orderNumber', o.order_number,
        'orderDate', o.created_at,
        'status', o.status,
        'paymentStatus', o.payment_status,
        'seller', jsonb_build_object(
          'name', st.name, 'legalName', o.seller_tax_legal_name,
          'trn', o.seller_tax_registration_number),
        'totals', jsonb_build_object(
          'subtotal', o.subtotal, 'discount', o.discount, 'shipping', o.shipping,
          'codFee', o.cod_fee, 'extra', o.extra_amount, 'taxable', o.taxable_amount,
          'vat', o.tax, 'vatRateBps', o.tax_rate_bps,
          'taxIncludedInPrice', o.tax_included_in_price, 'total', o.total,
          'wallet', o.wallet_amount),
        'lines', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'description', i.product_name, 'sku', i.sku, 'quantity', i.quantity,
            'unitPrice', i.price, 'amount', i.total) ORDER BY i.id)
          FROM public.order_items i WHERE i.order_id = o.id), '[]'::jsonb)
      ),
      o.created_at + make_interval(years => ${years})
    FROM public.orders o
    JOIN public.stores st ON st.id = o.store_id
    WHERE o.store_id = ${storeId}
      AND NOT EXISTS (
        SELECT 1 FROM public.fiscal_documents d
        WHERE d.store_id = o.store_id AND d.order_id = o.id
          AND d.doc_type IN ('tax_invoice', 'receipt', 'order_record'))`;
  // Ebda's own subscription billing ledger (its VAT on the store's plan).
  // NEON-ZERO-1 (N-10): billing_events live in D1 after the cutover, so the INSERT ... SELECT across them cannot be one
  // Postgres statement: read the ledger through the routed model and insert the archive rows.
  const billingEvents = (await onD1())
    ? await archiveBillingEventsFromD1(tx, storeId, years)
    : await tx.$executeRaw`
    INSERT INTO public.fiscal_documents
      (id, store_id, order_id, doc_type, status, issued_at, currency,
       net_amount, vat_amount, total_amount, vat_rate_bps, seller_trn, payload, retain_until)
    SELECT
      gen_random_uuid()::text, b.store_id, NULL, 'billing_record'::"FiscalDocType", 'issued',
      b.created_at, b.currency,
      GREATEST(0, b.amount_minor - b.vat_minor), GREATEST(0, b.vat_minor), GREATEST(0, b.amount_minor),
      NULLIF((b.vat ->> 'rateBps'), '')::int, b.vat ->> 'trn',
      jsonb_build_object(
        'version', 1,
        'archivedAt', now(),
        'reason', 'store_deleted',
        'billingEventId', b.id,
        'type', b.type,
        'status', b.status,
        'planCode', b.plan_code,
        'billingInterval', b.billing_interval,
        'forPeriodEnd', b.for_period_end,
        'provider', b.provider,
        'providerRef', b.provider_ref,
        'relatedEventId', b.related_event_id,
        'vat', b.vat,
        'seller', jsonb_build_object('name', st.name)
      ),
      b.created_at + make_interval(years => ${years})
    FROM public.billing_events b
    JOIN public.stores st ON st.id = b.store_id
    WHERE b.store_id = ${storeId}`;
  logger.info({ storeId, orders, billingEvents }, '[STORE_DELETE] fiscal records archived');
  return { orders, billingEvents };
}

async function archiveBillingEventsFromD1(
  tx: Prisma.TransactionClient,
  storeId: string,
  years: number
): Promise<number> {
  const [store, events] = await Promise.all([
    tx.store.findUnique({ where: { id: storeId }, select: { name: true } }),
    tx.billingEvent.findMany({ where: { storeId } }),
  ]);
  if (events.length === 0) return 0;
  const archivedAt = new Date().toISOString();
  const { count } = await tx.fiscalDocument.createMany({
    data: events.map(b => {
      const vat = (b.vat ?? null) as { rateBps?: number | string; trn?: string } | null;
      const rate = vat?.rateBps === undefined || vat.rateBps === '' ? null : Number(vat.rateBps);
      const retainUntil = new Date(b.createdAt);
      retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + years);
      return {
        id: crypto.randomUUID(),
        storeId: b.storeId,
        orderId: null,
        docType: 'billing_record' as const,
        status: 'issued',
        issuedAt: b.createdAt,
        currency: b.currency,
        netAmount: Math.max(0, b.amountMinor - b.vatMinor),
        vatAmount: Math.max(0, b.vatMinor),
        totalAmount: Math.max(0, b.amountMinor),
        vatRateBps: Number.isInteger(rate) ? rate : null,
        sellerTrn: vat?.trn ?? null,
        retainUntil,
        payload: {
          version: 1,
          archivedAt,
          reason: 'store_deleted',
          billingEventId: b.id,
          type: b.type,
          status: b.status,
          planCode: b.planCode,
          billingInterval: b.billingInterval,
          forPeriodEnd: b.forPeriodEnd,
          provider: b.provider,
          providerRef: b.providerRef,
          relatedEventId: b.relatedEventId,
          vat: b.vat,
          seller: { name: store?.name ?? null },
        },
      };
    }),
  });
  return count;
}
