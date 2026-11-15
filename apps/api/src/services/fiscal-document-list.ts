import { storeDb } from '../lib/repo-factory';
import logger from '../lib/logger';
import type { FiscalDocType } from '@ebda/database';

/**
 * Fiscal document LIST layer shared by the merchant Invoices page and the super-admin tax archive.
 *
 *  - keyset pagination over (issued_at desc, id desc) — never offset; every column is an explicit select.
 *  - filters: document type, issue-date range, search by document number / original number / order number.
 *  - each row is enriched with: customer NAME (never a full phone/email — contact is masked), payment
 *    method + status, and the ETA e-receipt state (status + UUID) when the order has one.
 *
 * Index check (docs: this file's header is the record): the list and the period totals run on
 * `fiscal_documents (store_id, issued_at DESC)` which serves the date range and the ordering; `doc_type`
 * is a 6-value residual filter on that range; number search is a substring (no btree can serve it) and
 * is bounded by the store's own documents; the order-number search resolves through the unique
 * `orders.order_number` index (prefix match, 50 ids max) and then `fiscal_documents (store_id, order_id)`.
 */

const SALE_DOC_TYPES = ['tax_invoice', 'receipt'] as const;
const REFUND_DOC_TYPES = ['credit_note', 'refund_receipt'] as const;

export interface FiscalListFilters {
  cursor?: string;
  limit?: number;
  docType?: string;
  q?: string;
  from?: Date;
  to?: Date;
}

interface FiscalListRowBase {
  id: string;
  orderId: string | null;
  docType: string;
  number: string | null;
  status: string;
  issuedAt: Date;
  cancelledAt: Date | null;
  originalNumber: string | null;
  netAmount: number;
  vatAmount: number;
  totalAmount: number;
  currency: string;
  refundRef?: string | null;
  payload: unknown;
}

// pq-allow(unused-export): named in the declared return type of FiscalDocumentService.list (TS4050 without the export)
export interface FiscalListRow extends Omit<FiscalListRowBase, 'payload' | 'refundRef'> {
  orderNumber: string | null;
  customerName: string | null;
  /** Masked phone/email of the order's buyer, e.g. `•••••678`; null when unknown or erased. */
  contactMasked: string | null;
  paymentMethod: string | null;
  paymentStatus: string | null;
  etaStatus: string | null;
  etaUuid: string | null;
}

const LIST_SELECT = {
  id: true,
  orderId: true,
  docType: true,
  number: true,
  status: true,
  issuedAt: true,
  cancelledAt: true,
  originalNumber: true,
  netAmount: true,
  vatAmount: true,
  totalAmount: true,
  currency: true,
  refundRef: true,
  payload: true,
} as const;

/** Phone → last 3 digits behind bullets; e-mail → first letter + domain. Never the full value. */
// pq-allow(unused-export): imported by tests/unit/fiscal-archive-full-receipt.test.ts, which pins the masking format
export function maskContact(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  if (v.includes('@')) {
    const [local, domain] = v.split('@');
    return `${local.slice(0, 1)}•••@${domain}`;
  }
  const digits = v.replace(/\D/g, '');
  return digits.length >= 4 ? `•••••${digits.slice(-3)}` : '•••';
}

function nameFromAddress(addr: unknown): string | null {
  const a = (addr ?? {}) as Record<string, unknown>;
  const n =
    `${typeof a.firstName === 'string' ? a.firstName : ''} ${typeof a.lastName === 'string' ? a.lastName : ''}`.trim();
  return n || null;
}

/** A sale document carries `buyer.name` (tax invoices only); a refund document `buyerName`. */
function nameFromPayload(payload: unknown): string | null {
  const p = (payload ?? {}) as { buyer?: { name?: string }; buyerName?: string };
  return p.buyer?.name?.trim() || p.buyerName?.trim() || null;
}

/** Opaque keyset cursor: the position (issued_at, id) of the last row served, not a reference to that row. */
function encodeCursor(r: { issuedAt: Date; id: string }): string {
  return `${r.issuedAt.toISOString()}_${r.id}`;
}
function decodeCursor(c: string | undefined): { at: Date; id: string } | null {
  const m = c ? /^(.+Z)_([0-9a-f-]{36})$/i.exec(c) : null;
  const at = m ? new Date(m[1]) : null;
  return m && at && !Number.isNaN(at.getTime()) ? { at, id: m[2] } : null;
}

export function listWhere(storeId: string, f: FiscalListFilters, orderIdsForQ: string[]) {
  const q = f.q?.toUpperCase();
  const cur = decodeCursor(f.cursor);
  return {
    storeId,
    // Continue strictly after the cursor position in (issued_at desc, id desc): works whether or not that row still exists.
    ...(cur
      ? { AND: [{ OR: [{ issuedAt: { lt: cur.at } }, { issuedAt: cur.at, id: { lt: cur.id } }] }] }
      : {}),
    ...(f.docType ? { docType: f.docType as FiscalDocType } : {}),
    ...(f.from || f.to
      ? { issuedAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } }
      : {}),
    // Document numbers are issued upper-case (INV-000042), so an upper-cased substring needs no case-insensitive mode.
    ...(q
      ? {
          OR: [
            { number: { contains: q } },
            { originalNumber: { contains: q } },
            ...(orderIdsForQ.length ? [{ orderId: { in: orderIdsForQ } }] : []),
          ],
        }
      : {}),
  };
}

async function orderIdsMatching(storeId: string, q: string | undefined): Promise<string[]> {
  if (!q) return [];
  try {
    const rows = await (
      await storeDb(storeId)
    ).order.findMany({
      where: { storeId, orderNumber: { startsWith: q.toUpperCase() } },
      select: { id: true },
      take: 50,
    });
    return rows.map(r => r.id);
  } catch (err) {
    logger.warn({ err, storeId }, '[FISCAL] order-number search unavailable');
    return [];
  }
}

/** Matching ETA receipt of a document: sale docs ↔ the latest sale receipt, refund docs ↔ the return with the same key. */
export function pickEtaReceipt<T extends { kind: string; seq: number; refundKey: string | null }>(
  doc: { docType: string; refundRef?: string | null },
  receipts: T[]
): T | null {
  const isRefund = (REFUND_DOC_TYPES as readonly string[]).includes(doc.docType);
  const pool = receipts
    .filter(r => r.kind === (isRefund ? 'return' : 'sale'))
    .sort((a, b) => b.seq - a.seq);
  if (!isRefund) return pool[0] ?? null;
  const ref = doc.refundRef ?? '';
  return (
    pool.find(r => r.refundKey && (ref === r.refundKey || ref.endsWith(`:${r.refundKey}`))) ?? null
  );
}

/** Adds customer / payment / ETA fields. Every lookup is best-effort: a deleted store or an erased order just yields nulls. */
async function enrichFiscalRows(
  storeId: string,
  rows: FiscalListRowBase[]
): Promise<FiscalListRow[]> {
  const orderIds = [...new Set(rows.map(r => r.orderId).filter((x): x is string => !!x))];
  const orders = new Map<string, { paymentStatus: string | null; shippingAddress: unknown }>();
  const etaByOrder = new Map<
    string,
    Array<{
      kind: string;
      seq: number;
      refundKey: string | null;
      status: string;
      uuid: string | null;
    }>
  >();
  if (orderIds.length) {
    try {
      const db = await storeDb(storeId);
      const [os, es] = await Promise.all([
        db.order.findMany({
          where: { storeId, id: { in: orderIds } },
          select: { id: true, paymentStatus: true, shippingAddress: true },
        }),
        db.etaReceipt.findMany({
          where: { storeId, orderId: { in: orderIds } },
          select: {
            orderId: true,
            kind: true,
            seq: true,
            refundKey: true,
            status: true,
            uuid: true,
          },
        }),
      ]);
      for (const o of os)
        orders.set(o.id, { paymentStatus: o.paymentStatus, shippingAddress: o.shippingAddress });
      for (const e of es) {
        const arr = etaByOrder.get(e.orderId) ?? [];
        arr.push(e);
        etaByOrder.set(e.orderId, arr);
      }
    } catch (err) {
      logger.warn({ err, storeId }, '[FISCAL] list enrichment unavailable (deleted store?)');
    }
  }
  return rows.map(({ payload, refundRef, ...d }) => {
    const p = (payload ?? {}) as {
      orderNumber?: string;
      paymentMethod?: string | null;
      paymentStatus?: string | null;
    };
    const order = d.orderId ? orders.get(d.orderId) : undefined;
    const eta = d.orderId
      ? pickEtaReceipt({ docType: d.docType, refundRef }, etaByOrder.get(d.orderId) ?? [])
      : null;
    const addr = (order?.shippingAddress ?? {}) as Record<string, unknown>;
    return {
      ...d,
      orderNumber: p.orderNumber ?? null,
      customerName: nameFromPayload(payload) ?? nameFromAddress(order?.shippingAddress),
      contactMasked: maskContact(addr.phone) ?? maskContact(addr.email),
      paymentMethod: p.paymentMethod ?? null,
      paymentStatus: p.paymentStatus ?? order?.paymentStatus ?? null,
      etaStatus: eta?.status ?? null,
      etaUuid: eta?.uuid ?? null,
    };
  });
}

/** One keyset page for a store, straight from the database. */
export async function listFiscalDocuments(storeId: string, f: FiscalListFilters = {}) {
  const limit = Math.min(100, Math.max(1, f.limit ?? 50));
  const orderIds = await orderIdsMatching(storeId, f.q);
  const rows = await (
    await storeDb(storeId)
  ).fiscalDocument.findMany({
    where: listWhere(storeId, f, orderIds),
    orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: LIST_SELECT,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    documents: await enrichFiscalRows(storeId, page),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]!) : null,
  };
}

/**
 * Same page contract over rows a SECURITY DEFINER function already returned (Postgres retention path for stores
 * whose live tables are gone). RESIDUAL: the definer returns the store's documents whole, so this filters and
 * pages in memory (still keyset, never offset). Cost if wrong: a very large deleted store's archive loads slowly.
 */
export async function pageFiscalRows(
  storeId: string,
  all: Array<FiscalListRowBase>,
  f: FiscalListFilters = {}
) {
  const limit = Math.min(100, Math.max(1, f.limit ?? 50));
  const q = f.q?.toUpperCase();
  const sorted = all
    .filter(r => !f.docType || r.docType === f.docType)
    .filter(r => !f.from || r.issuedAt >= f.from)
    .filter(r => !f.to || r.issuedAt <= f.to)
    .filter(r => {
      if (!q) return true;
      const on = ((r.payload as { orderNumber?: string } | null)?.orderNumber ?? '').toUpperCase();
      return (
        (r.number ?? '').toUpperCase().includes(q) ||
        (r.originalNumber ?? '').toUpperCase().includes(q) ||
        on.startsWith(q)
      );
    })
    .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime() || (a.id < b.id ? 1 : -1));
  // Keyset: continue after the cursor's POSITION, so a vanished cursor row cannot restart the list.
  const cur = decodeCursor(f.cursor);
  const rest = cur
    ? sorted.filter(
        r =>
          r.issuedAt.getTime() < cur.at.getTime() ||
          (r.issuedAt.getTime() === cur.at.getTime() && r.id < cur.id)
      )
    : sorted;
  const page = rest.slice(0, limit);
  return {
    documents: await enrichFiscalRows(storeId, page),
    nextCursor: rest.length > limit ? encodeCursor(page[page.length - 1]!) : null,
  };
}

interface FiscalStoreSummary {
  documentCount: number;
  lastIssuedAt: Date | null;
  lastNumber: string | null;
  period: { from: Date; to: Date; net: number; vat: number; gross: number; count: number };
  taxProfileStatus: string | null;
  trnPresent: boolean;
  etaConnected: boolean;
  etaEnabled: boolean;
  etaEnvironment: string | null;
}

/** First instant of the current month (UTC) → now: the default period of the store summary. */
export function defaultPeriod(now = new Date()): { from: Date; to: Date } {
  return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now };
}

/** Archive card of one LIVE store: counts, last document, issued totals in the period, tax registration + ETA status. */
export async function fiscalStoreSummary(
  storeId: string,
  period: { from: Date; to: Date }
): Promise<FiscalStoreSummary> {
  const db = await storeDb(storeId);
  const [documentCount, last, sums, trnDoc, profile, conn] = await Promise.all([
    db.fiscalDocument.count({ where: { storeId } }),
    db.fiscalDocument.findFirst({
      where: { storeId },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      select: { issuedAt: true, number: true },
    }),
    db.fiscalDocument.aggregate({
      where: {
        storeId,
        docType: { in: [...SALE_DOC_TYPES] as FiscalDocType[] },
        status: 'issued',
        issuedAt: { gte: period.from, lte: period.to },
      },
      _sum: { netAmount: true, vatAmount: true, totalAmount: true },
      _count: { _all: true },
    }),
    db.fiscalDocument.findFirst({
      where: { storeId, sellerTrn: { not: null } },
      orderBy: { issuedAt: 'desc' },
      select: { id: true },
    }),
    db.storeTaxProfile.findFirst({
      where: { storeId },
      select: { status: true, taxRegistrationNumber: true },
    }),
    db.etaConnection.findFirst({
      where: { storeId },
      select: { enabled: true, environment: true },
    }),
  ]);
  return {
    documentCount,
    lastIssuedAt: last?.issuedAt ?? null,
    lastNumber: last?.number ?? null,
    period: {
      ...period,
      net: sums._sum.netAmount ?? 0,
      vat: sums._sum.vatAmount ?? 0,
      gross: sums._sum.totalAmount ?? 0,
      count: sums._count._all,
    },
    taxProfileStatus: profile?.status ?? null,
    trnPresent: !!profile?.taxRegistrationNumber || !!trnDoc,
    etaConnected: !!conn,
    etaEnabled: !!conn?.enabled,
    etaEnvironment: conn?.environment ?? null,
  };
}
