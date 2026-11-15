import { withStoreRw } from '../lib/jobs/store-db';
import {
  ETA_SUBMISSION_WINDOW_MS,
  etaConnectionInputSchema,
  etaReturnReasonSchema,
  isMaskedSecret,
  type EtaConnectionInput,
  type EtaEnvironment,
  type EtaSeller,
} from '@ebda/shared';
import { inngest } from '../lib/inngest/client';
import logger from '../lib/logger';
import { AppError } from '../middleware/error-handler';
import { auditLog } from '../middleware/security';
import { parseInput } from '../lib/parse-input';
import { encryption } from './encryption.service';
import { featureService } from './feature.service';
import { sendAlert } from './alerts.service';
import QRCode from 'qrcode';
import { etaQrPayload } from '../lib/eta/qr';
import { EtaClient, type EtaCredentials } from '../lib/eta/client';
import {
  buildReturnReceipt,
  buildReturnWithoutReference,
  buildSaleReceipt,
  EtaMapError,
  type EtaOrderInput,
  type LineQty,
} from '../lib/eta/receipt-mapper';
import {
  applySubmitOutcome,
  applyVerdict,
  isPastDeadline,
  type Patch,
} from '../lib/eta/receipt-state';
import { serializeEtaValue, type Json } from '../lib/eta/serialize';
import { BridgeSigner, NoopSigner, type ReceiptSigner } from '../lib/eta/signer';

/**
 * Egypt ETA e-receipt connector (Ruling ETA-1). Everything here is store-scoped and uses only
 * portable ORM calls (create / findFirst / findMany / update / updateMany with plain where), so it
 * runs unchanged on the Postgres path and on the StoreDO prisma-lite path (#229/#230).
 * Credentials: AES-256-GCM JSON blob in `eta_connections.credentials_enc`, decrypted only inside
 * `loadCredentials` (worker side), never returned, logged or put in an error.
 */
const FEATURE = 'eta_ereceipt' as const;
type Actor = { userId: string; ip?: string; userAgent?: string };

/** `partial` of the order/refunded event (OrderService.applyRefundEffects). */
export interface ReturnEvent {
  items?: Array<{ orderItemId: string; quantity: number }>;
  refundKey?: string;
  refundAmount?: number;
  amountOnly?: boolean;
}

interface StoredSecrets {
  clientId: string;
  clientSecret: string;
  preSharedKey?: string;
  signingBridgeToken?: string;
}

const mask = (v: string | undefined): string | null => (v ? `****${v.slice(-4)}` : null);

export interface EtaConnectionView {
  connected: boolean;
  enabled: boolean;
  environment: EtaEnvironment;
  clientId: string | null;
  clientSecret: string | null;
  posSerial: string | null;
  posPreSharedKey: string | null;
  branchCode: string | null;
  activityCode: string | null;
  defaultItemCode: string | null;
  address: EtaSeller['address'] | null;
  signingBridgeUrl: string | null;
  lastCheckStatus: string | null;
  lastCheckedAt: Date | null;
}

function decryptSecrets(enc: string): StoredSecrets {
  return JSON.parse(encryption.decrypt(enc)) as StoredSecrets;
}

export const EtaReceiptService = {
  async isEnabledForStore(storeId: string): Promise<boolean> {
    return featureService.isFeatureEnabled(storeId, FEATURE);
  },

  async getConnection(storeId: string): Promise<EtaConnectionView> {
    const row = await withStoreRw(storeId, db =>
      db.etaConnection.findFirst({ where: { storeId } })
    );
    if (!row)
      return {
        connected: false,
        enabled: false,
        environment: 'preprod',
        clientId: null,
        clientSecret: null,
        posSerial: null,
        posPreSharedKey: null,
        branchCode: null,
        activityCode: null,
        defaultItemCode: null,
        address: null,
        signingBridgeUrl: null,
        lastCheckStatus: null,
        lastCheckedAt: null,
      };
    const s = decryptSecrets(row.credentialsEnc);
    return {
      connected: true,
      enabled: row.enabled,
      environment: row.environment as EtaEnvironment,
      clientId: mask(s.clientId),
      clientSecret: mask(s.clientSecret),
      posSerial: row.posSerial,
      posPreSharedKey: mask(s.preSharedKey),
      branchCode: row.branchCode,
      activityCode: row.activityCode,
      defaultItemCode: row.defaultItemCode,
      address: row.address as EtaSeller['address'],
      signingBridgeUrl: row.signingBridgeUrl,
      lastCheckStatus: row.lastCheckStatus,
      lastCheckedAt: row.lastCheckedAt,
    };
  },

  /** Create or update the connection. A masked or omitted secret keeps the stored one. */
  async saveConnection(storeId: string, raw: unknown, actor: Actor): Promise<EtaConnectionView> {
    const input = parseInput(etaConnectionInputSchema, raw) as EtaConnectionInput;
    const existing = await withStoreRw(storeId, db =>
      db.etaConnection.findFirst({ where: { storeId } })
    );
    const prev = existing ? decryptSecrets(existing.credentialsEnc) : null;
    const keep = (next: string | undefined, old: string | undefined) =>
      !next || isMaskedSecret(next) ? old : next;
    const clientId = isMaskedSecret(input.clientId) ? prev?.clientId : input.clientId;
    const clientSecret = keep(input.clientSecret, prev?.clientSecret);
    if (!clientId || !clientSecret)
      throw new AppError(400, 'ETA_SECRET_REQUIRED', 'client id and client secret are required');
    const secrets: StoredSecrets = {
      clientId,
      clientSecret,
      preSharedKey: keep(input.posPreSharedKey, prev?.preSharedKey),
      signingBridgeToken: keep(input.signingBridgeToken, prev?.signingBridgeToken),
    };
    const data = {
      enabled: input.enabled,
      environment: input.environment,
      credentialsEnc: encryption.encrypt(JSON.stringify(secrets)),
      posSerial: input.posSerial,
      branchCode: input.branchCode,
      activityCode: input.activityCode,
      defaultItemCode: input.defaultItemCode,
      address: input.address,
      signingBridgeUrl: input.signingBridgeUrl ?? null,
    };
    await withStoreRw(storeId, async db => {
      if (existing) {
        // Changing credentials or environment invalidates the last check.
        await db.etaConnection.update({
          where: { id: existing.id },
          data: { ...data, lastCheckStatus: null, lastCheckedAt: null },
        });
      } else {
        await db.etaConnection.create({ data: { storeId, ...data } });
      }
    });
    await auditLog({
      action: 'eta.connection.saved',
      userId: actor.userId,
      resourceType: 'eta_connection',
      storeId,
      // never the secrets
      details: {
        enabled: input.enabled,
        environment: input.environment,
        posSerial: input.posSerial,
      },
      ipAddress: actor.ip,
      userAgent: actor.userAgent,
    } as Parameters<typeof auditLog>[0]);
    return this.getConnection(storeId);
  },

  /** Authenticate against ETA with the stored credentials (read-only; no receipt is sent). */
  async checkConnection(storeId: string): Promise<{ status: string; ok: boolean }> {
    const loaded = await this.loadCredentials(storeId);
    if (!loaded) throw new AppError(404, 'ETA_NOT_CONNECTED', 'no ETA connection saved');
    const r = await new EtaClient(loaded.environment, loaded.creds).authenticate();
    const status = r.ok ? 'ok' : r.code;
    await withStoreRw(storeId, db =>
      db.etaConnection.updateMany({
        where: { storeId },
        data: { lastCheckStatus: status, lastCheckedAt: new Date() },
      })
    );
    return { status, ok: r.ok };
  },

  async loadCredentials(storeId: string) {
    const c = await withStoreRw(storeId, db => db.etaConnection.findFirst({ where: { storeId } }));
    if (!c) return null;
    const s = decryptSecrets(c.credentialsEnc);
    const creds: EtaCredentials = {
      clientId: s.clientId,
      clientSecret: s.clientSecret,
      posSerial: c.posSerial,
      preSharedKey: s.preSharedKey,
    };
    return { conn: c, creds, secrets: s, environment: c.environment as EtaEnvironment };
  },

  /**
   * Queue the e-receipt for a paid/created order. Idempotent (unique store+order+kind+seq). Fail fast:
   * if the event cannot be sent the row is marked `failed` and the error rethrown, never left `queued`.
   */
  async enqueueSale(storeId: string, orderId: string): Promise<'queued' | 'skipped'> {
    if (!(await this.isEnabledForStore(storeId))) return 'skipped';
    const conn = await withStoreRw(storeId, db =>
      db.etaConnection.findFirst({
        where: { storeId },
        select: { enabled: true, environment: true },
      })
    );
    if (!conn?.enabled) return 'skipped';
    const order = await withStoreRw(storeId, db =>
      db.order.findFirst({
        where: { id: orderId, storeId },
        select: { sellerTaxRegistrationNumber: true },
      })
    );
    // Only orders sold under a VERIFIED VAT registration are tax invoices (Ruling TAX-2).
    if (!order?.sellerTaxRegistrationNumber) return 'skipped';
    const existing = await withStoreRw(storeId, db =>
      db.etaReceipt.findFirst({ where: { storeId, orderId, kind: 'sale' }, select: { id: true } })
    );
    if (existing) return 'queued'; // the same order event delivered twice
    return this.createRowAndSend(storeId, orderId, 'sale', conn.environment);
  },

  /**
   * order/refunded -> Return Receipt. `partial.items` (the Return's own lines, carried on the event) become
   * a partial return receipt; no `partial` = a whole-order refund (every unit not yet returned, plus the fee
   * lines once). A refund with no goods lines (`amountOnly`: a provider-dashboard price adjustment) cannot be
   * a Return Receipt (no lines to return): it becomes a Return Receipt Without Reference, which the ETA
   * requires a reason code for. The reason is the merchant's, so the row waits as `manual` /
   * `reason_required` until `setReturnReason` supplies it (order page picker). Idempotent per refundKey.
   */
  async enqueueReturn(
    storeId: string,
    orderId: string,
    partial?: ReturnEvent | null
  ): Promise<'queued' | 'manual' | 'skipped'> {
    const sale = await withStoreRw(storeId, db =>
      db.etaReceipt.findFirst({ where: { storeId, orderId, kind: 'sale' } })
    );
    if (!sale || sale.status === 'failed' || sale.status === 'rejected') return 'skipped';
    const goods = partial?.items?.filter(i => i.quantity > 0) ?? [];
    const priceOnly = !!partial && (partial.amountOnly || goods.length === 0);
    const refundKey = partial
      ? partial.refundKey || `amount:${orderId}:${partial.refundAmount ?? 0}`
      : 'full';
    const done = await withStoreRw(storeId, db =>
      db.etaReceipt.findFirst({
        where: { storeId, orderId, kind: 'return', refundKey },
        select: { id: true },
      })
    );
    if (done) return priceOnly ? 'manual' : 'queued';
    if (priceOnly) {
      if (!(typeof partial!.refundAmount === 'number' && partial!.refundAmount > 0))
        return 'skipped';
      const seq = await this.nextSeq(storeId, orderId, 'return');
      await withStoreRw(storeId, db =>
        db.etaReceipt.create({
          data: {
            storeId,
            orderId,
            kind: 'return',
            seq,
            refundKey,
            status: 'manual',
            environment: sale.environment,
            lineMap: { amountOnly: true, refundAmount: partial!.refundAmount, reason: null },
            errorCode: 'reason_required',
            errorMessage: 'Choose the ETA return reason to issue this price-only refund.',
          },
        })
      );
      await sendAlert({
        level: 'info',
        source: 'eta.return.reason_required',
        title: 'ETA price-only refund waits for a return reason',
        context: { storeId, orderId },
      });
      return 'manual';
    }
    return this.createRowAndSend(storeId, orderId, 'return', sale.environment, {
      refundKey,
      lineMap: partial ? { items: goods, refundAmount: partial.refundAmount ?? null } : null,
    });
  },

  /**
   * The merchant picks the ETA return-with-no-reference reason (I | B) for a waiting price-only refund; the
   * row is claimed (manual -> queued) and the submission job sent. Fail fast like every enqueue.
   */
  async setReturnReason(storeId: string, receiptId: string, rawReason: unknown): Promise<void> {
    const { reason } = parseInput(etaReturnReasonSchema, { reason: rawReason });
    const row = await withStoreRw(storeId, db =>
      db.etaReceipt.findFirst({ where: { id: receiptId, storeId } })
    );
    const map = row?.lineMap as { amountOnly?: boolean; refundAmount?: number } | null;
    if (!row || row.kind !== 'return' || row.status !== 'manual' || !map?.amountOnly)
      throw new AppError(409, 'ETA_REASON_NOT_NEEDED', 'this receipt is not waiting for a reason');
    const claim = await withStoreRw(storeId, db =>
      db.etaReceipt.updateMany({
        where: { id: receiptId, storeId, status: 'manual' },
        data: {
          status: 'queued',
          errorCode: null,
          errorMessage: null,
          lineMap: { ...map, reason } as never,
        },
      })
    );
    if (claim.count === 0)
      throw new AppError(409, 'ETA_REASON_NOT_NEEDED', 'this receipt is not waiting for a reason');
    try {
      await inngest.send({ name: 'eta/receipt.submit', data: { storeId, receiptId } });
    } catch (err) {
      await withStoreRw(storeId, db =>
        db.etaReceipt.updateMany({
          where: { id: receiptId, storeId, status: 'queued' },
          data: {
            status: 'failed',
            errorCode: 'enqueue_failed',
            errorMessage: 'could not queue the submission job',
            nextAttemptAt: null,
          },
        })
      );
      throw err;
    }
  },

  async nextSeq(storeId: string, orderId: string, kind: string): Promise<number> {
    const last = await withStoreRw(storeId, db =>
      db.etaReceipt.findFirst({
        where: { storeId, orderId, kind },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      })
    );
    return (last?.seq ?? 0) + 1;
  },

  async createRowAndSend(
    storeId: string,
    orderId: string,
    kind: 'sale' | 'return',
    environment: string,
    extra: { refundKey?: string | null; lineMap?: unknown } = {}
  ) {
    const seq = await this.nextSeq(storeId, orderId, kind);
    let id: string | null = null;
    try {
      const row = await withStoreRw(storeId, db =>
        db.etaReceipt.create({
          data: {
            storeId,
            orderId,
            kind,
            seq,
            status: 'queued',
            environment,
            ...(extra.refundKey ? { refundKey: extra.refundKey } : {}),
            ...(extra.lineMap ? { lineMap: extra.lineMap as never } : {}),
          },
        })
      );
      id = row.id;
    } catch (err) {
      // Unique (store, order, kind, seq): the same event delivered twice raced us to this seq.
      const dup = await withStoreRw(storeId, db =>
        db.etaReceipt.findFirst({ where: { storeId, orderId, kind, seq }, select: { id: true } })
      );
      if (dup) return 'queued' as const;
      throw err;
    }
    try {
      await inngest.send({ name: 'eta/receipt.submit', data: { storeId, receiptId: id } });
    } catch (err) {
      await withStoreRw(storeId, db =>
        db.etaReceipt.updateMany({
          where: { id: id!, storeId, status: 'queued' },
          data: {
            status: 'failed',
            errorCode: 'enqueue_failed',
            errorMessage: 'could not queue the submission job',
            nextAttemptAt: null,
          },
        })
      );
      throw err;
    }
    return 'queued' as const;
  },

  /** One attempt for one row. Returns the new status; the job re-sends itself while a poll is due. */
  async processReceipt(
    storeId: string,
    receiptId: string,
    now = new Date(),
    signerOverride?: ReceiptSigner,
    clientOverride?: EtaClient
  ): Promise<string> {
    const row = await withStoreRw(storeId, db =>
      db.etaReceipt.findFirst({ where: { id: receiptId, storeId } })
    );
    if (!row || !['queued', 'retrying', 'submitted'].includes(row.status))
      return row?.status ?? 'missing';
    if (row.nextAttemptAt && row.nextAttemptAt.getTime() > now.getTime() + 1000) return row.status; // not due

    const loaded = await this.loadCredentials(storeId);
    if (!loaded || !loaded.conn.enabled || !(await this.isEnabledForStore(storeId))) {
      return this.save(storeId, row.id, {
        status: 'failed',
        attempts: row.attempts,
        nextAttemptAt: null,
        errorCode: 'ETA_NOT_CONNECTED',
        errorMessage: 'the ETA connection is off or removed',
      });
    }
    const client = clientOverride ?? new EtaClient(loaded.environment, loaded.creds);
    const state = { uuid: row.uuid, attempts: row.attempts, deadlineAt: row.deadlineAt };

    // Already sent: look at the verdict.
    if (row.status === 'submitted' && row.submissionUuid) {
      const patch = applyVerdict(state, await client.getSubmission(row.submissionUuid), now);
      return this.finish(storeId, row, patch);
    }

    // Build once; the stored document is re-sent byte-for-byte on every retry (stable uuid).
    let doc = row.document as
      | ({ [k: string]: Json } & { header: { [k: string]: Json; uuid: string } })
      | null;
    if (!doc) {
      try {
        const built = await this.build(storeId, row, loaded.conn, loaded.environment, now);
        doc = built.doc;
        await withStoreRw(storeId, db =>
          db.etaReceipt.updateMany({
            where: { id: row.id, storeId },
            data: {
              document: doc as never,
              uuid: doc!.header.uuid,
              previousUuid: doc!.header.previousUUID as string,
              receiptNumber: doc!.header.receiptNumber as string,
              issuedAt: now,
              deadlineAt: new Date(now.getTime() + ETA_SUBMISSION_WINDOW_MS),
              totalPiastres: Math.round((doc!.totalAmount as number) * 100),
              ...(built.lineMap ? { lineMap: built.lineMap as never } : {}),
            },
          })
        );
        state.uuid = doc.header.uuid;
        state.deadlineAt = new Date(now.getTime() + ETA_SUBMISSION_WINDOW_MS);
      } catch (err) {
        const code = err instanceof EtaMapError ? err.code : 'ETA_BUILD_FAILED';
        logger.warn({ storeId, receiptId, code }, '[eta] receipt could not be built');
        return this.save(storeId, row.id, {
          status: 'failed',
          attempts: row.attempts + 1,
          nextAttemptAt: null,
          errorCode: code,
          errorMessage: err instanceof EtaMapError ? err.message.slice(0, 300) : 'internal error',
        });
      }
    }
    if (isPastDeadline(state, now)) {
      return this.finish(storeId, row, {
        status: 'late',
        attempts: row.attempts + 1,
        nextAttemptAt: null,
        errorCode: 'window_elapsed',
        errorMessage: 'the 24 h submission window ran out',
      });
    }

    let signatures: Array<{ signatureType: 'I'; value: string }> = [];
    try {
      const signer =
        signerOverride ??
        (loaded.conn.signingBridgeUrl
          ? new BridgeSigner(loaded.conn.signingBridgeUrl, loaded.secrets.signingBridgeToken)
          : new NoopSigner());
      const sig = await signer.sign({
        uuid: doc.header.uuid,
        serialized: serializeEtaValue(doc as Json),
      });
      if (sig) signatures = [sig];
    } catch {
      return this.finish(
        storeId,
        row,
        applySubmitOutcome(state, { kind: 'retry', reason: 'signing_bridge', afterMs: null }, now)
      );
    }
    const outcome = await client.submitReceipts([doc], signatures);
    return this.finish(storeId, row, applySubmitOutcome(state, outcome, now));
  },

  async build(
    storeId: string,
    row: {
      id: string;
      orderId: string;
      kind: string;
      seq: number;
      refundKey: string | null;
      lineMap: unknown;
    },
    conn: {
      branchCode: string;
      activityCode: string;
      posSerial: string;
      defaultItemCode: string;
      address: unknown;
    },
    environment: string,
    now: Date
  ) {
    const order = await withStoreRw(storeId, db =>
      db.order.findFirst({
        where: { id: row.orderId, storeId },
        select: {
          orderNumber: true,
          createdAt: true,
          currency: true,
          discount: true,
          shipping: true,
          codFee: true,
          extraAmount: true,
          tax: true,
          total: true,
          taxableAmount: true,
          taxRateBps: true,
          sellerTaxRegistrationNumber: true,
          sellerTaxLegalName: true,
          shippingAddress: true,
          items: {
            select: {
              id: true,
              productId: true,
              productName: true,
              sku: true,
              quantity: true,
              total: true,
            },
            orderBy: [{ id: 'asc' }],
          },
          payments: { select: { provider: true }, take: 1 },
        },
      })
    );
    if (!order?.sellerTaxRegistrationNumber)
      throw new EtaMapError('ETA_NO_LINES', 'order has no VAT registration');
    // Chain: previousUUID = the latest receipt of this POS+environment that carries a uuid and was not
    // refused. Builds are serialized per store by the job's concurrency key.
    const prev = await withStoreRw(storeId, db =>
      db.etaReceipt.findFirst({
        where: {
          storeId,
          environment,
          uuid: { not: null },
          status: { notIn: ['failed', 'rejected'] },
          id: { not: row.id },
        },
        orderBy: { issuedAt: 'desc' },
        select: { uuid: true },
      })
    );
    const old =
      row.seq > 1
        ? await withStoreRw(storeId, db =>
            db.etaReceipt.findFirst({
              where: {
                storeId,
                orderId: row.orderId,
                kind: row.kind,
                seq: { lt: row.seq },
                ...(row.kind === 'return' ? { refundKey: row.refundKey } : {}),
                uuid: { not: null },
              },
              orderBy: { seq: 'desc' },
              select: { uuid: true },
            })
          )
        : null;
    const referenceOldUuid = old?.uuid ?? undefined;
    const seller: EtaSeller = {
      rin: order.sellerTaxRegistrationNumber,
      companyTradeName: order.sellerTaxLegalName ?? order.sellerTaxRegistrationNumber,
      branchCode: conn.branchCode,
      activityCode: conn.activityCode,
      deviceSerialNumber: conn.posSerial,
      address: conn.address as EtaSeller['address'],
    };
    if (row.kind === 'return') {
      const sale = await withStoreRw(storeId, db =>
        db.etaReceipt.findFirst({
          where: { storeId, orderId: row.orderId, kind: 'sale' },
          select: { document: true, status: true, lineMap: true },
        })
      );
      if (!sale?.document || !sale.lineMap || !['accepted', 'submitted'].includes(sale.status))
        throw new EtaMapError('ETA_NO_LINES', 'no issued sale receipt to return');
      const rowMap = row.lineMap as {
        amountOnly?: boolean;
        refundAmount?: number;
        reason?: 'I' | 'B' | null;
      } | null;
      if (rowMap?.amountOnly) {
        if (rowMap.reason !== 'I' && rowMap.reason !== 'B')
          throw new EtaMapError('ETA_NO_LINES', 'no return reason chosen');
        // Never refund more (across non-refused return receipts) than the sale receipt.
        const others = await withStoreRw(storeId, db =>
          db.etaReceipt.findMany({
            where: {
              storeId,
              orderId: row.orderId,
              kind: 'return',
              id: { not: row.id },
              status: { notIn: ['failed', 'rejected', 'manual'] },
            },
            select: { totalPiastres: true, refundKey: true },
          })
        );
        const saleRow = await withStoreRw(storeId, db =>
          db.etaReceipt.findFirst({
            where: { storeId, orderId: row.orderId, kind: 'sale' },
            select: { totalPiastres: true },
          })
        );
        const already = others
          .filter(o => o.refundKey !== row.refundKey)
          .reduce((n, o) => n + (o.totalPiastres ?? 0), 0);
        if (already + (rowMap.refundAmount ?? 0) > (saleRow?.totalPiastres ?? 0))
          throw new EtaMapError('ETA_RETURN_EXCEEDS', 'refunds exceed the sale receipt total');
        const rwr = buildReturnWithoutReference({
          sale: sale.document as never,
          refundAmount: rowMap.refundAmount ?? 0,
          reason: rowMap.reason,
          previousUuid: prev?.uuid ?? '',
          receiptNumber: `${order.orderNumber}-R${row.seq}`,
          issuedAt: now,
          referenceOldUuid,
        });
        return { doc: rwr, lineMap: undefined };
      }
      const saleLines = sale.lineMap as unknown as LineQty[];
      // Earlier return receipts that were not refused count as already returned.
      const earlier = await withStoreRw(storeId, db =>
        db.etaReceipt.findMany({
          where: {
            storeId,
            orderId: row.orderId,
            kind: 'return',
            id: { not: row.id },
            status: { notIn: ['failed', 'rejected', 'manual'] },
          },
          select: { refundKey: true, lineMap: true, seq: true },
        })
      );
      const alreadyReturned: Record<string, number> = {};
      let fullBefore = false;
      for (const e of earlier) {
        // A re-issue of THIS return (same refundKey) replaces it, it does not add to it.
        if (e.refundKey === row.refundKey) continue;
        if (e.refundKey === 'full') fullBefore = true;
        const items = ((e.lineMap as { items?: LineQty[] } | null)?.items ?? []) as LineQty[];
        for (const it of items)
          alreadyReturned[it.orderItemId] = (alreadyReturned[it.orderItemId] ?? 0) + it.quantity;
      }
      const isFull = row.refundKey === 'full';
      const requested = ((row.lineMap as { items?: LineQty[] } | null)?.items ?? []) as LineQty[];
      // A whole-order refund returns every unit not already returned.
      const returned: LineQty[] = isFull
        ? saleLines
            .map(l => ({
              orderItemId: l.orderItemId,
              quantity: l.quantity - (alreadyReturned[l.orderItemId] ?? 0),
            }))
            .filter(l => l.quantity > 0)
        : requested;
      const doc = buildReturnReceipt({
        sale: sale.document as never,
        saleLines,
        alreadyReturned,
        returned,
        includeFees: isFull && !fullBefore,
        previousUuid: prev?.uuid ?? '',
        receiptNumber: `${order.orderNumber}-R${row.seq}`,
        issuedAt: now,
        referenceOldUuid,
      });
      // The receipt must agree with what the Store refunded (within a piastre per line of rounding).
      const refunded = (row.lineMap as { refundAmount?: number | null } | null)?.refundAmount;
      if (!isFull && typeof refunded === 'number') {
        const total = Math.round((doc.totalAmount as number) * 100);
        if (Math.abs(total - refunded) > (doc.itemData as unknown[]).length)
          throw new EtaMapError(
            'ETA_RETURN_TOTAL_MISMATCH',
            `return receipt ${total} != refund ${refunded}`
          );
      }
      return { doc, lineMap: undefined };
    }
    const addr = (order.shippingAddress ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof addr[k] === 'string' ? (addr[k] as string) : '');
    const input: EtaOrderInput = {
      orderNumber: order.orderNumber,
      createdAt: order.createdAt,
      currency: order.currency,
      discount: order.discount,
      shipping: order.shipping,
      codFee: order.codFee,
      extraAmount: order.extraAmount,
      tax: order.tax,
      total: order.total,
      taxableAmount: order.taxableAmount,
      taxRateBps: order.taxRateBps,
      paymentProvider: order.payments[0]?.provider ?? null,
      buyer: {
        name: `${str('firstName')} ${str('lastName')}`.trim(),
        mobile: str('phone') || null,
      },
      items: order.items,
    };
    const doc = buildSaleReceipt({
      order: input,
      seller,
      defaultItemCode: conn.defaultItemCode,
      previousUuid: prev?.uuid ?? '',
      receiptNumber: row.seq > 1 ? `${order.orderNumber}-${row.seq}` : order.orderNumber,
      issuedAt: now,
      referenceOldUuid,
    });
    return { doc, lineMap: order.items.map(i => ({ orderItemId: i.id, quantity: i.quantity })) };
  },

  async finish(
    storeId: string,
    row: { id: string; status: string },
    patch: Patch
  ): Promise<string> {
    const status = await this.save(storeId, row.id, patch);
    if (patch.status === 'late' || patch.status === 'rejected' || patch.status === 'failed') {
      await sendAlert({
        level: patch.status === 'late' ? 'p1' : 'info',
        scope: 'platform',
        source: `eta.receipt.${patch.status}`,
        title: `ETA e-receipt ${patch.status}`,
        body: `store ${storeId} receipt ${row.id}: ${patch.errorCode ?? ''}`,
      }).catch(() => undefined);
    }
    return status;
  },

  async save(storeId: string, id: string, patch: Patch): Promise<string> {
    await withStoreRw(storeId, db =>
      db.etaReceipt.updateMany({
        where: { id, storeId },
        data: {
          status: patch.status,
          attempts: patch.attempts,
          nextAttemptAt: patch.nextAttemptAt,
          errorCode: patch.errorCode ?? null,
          errorMessage: patch.errorMessage ?? null,
          ...(patch.submissionUuid ? { submissionUuid: patch.submissionUuid } : {}),
          ...(patch.longId ? { longId: patch.longId } : {}),
          ...(patch.acceptedAt ? { acceptedAt: patch.acceptedAt } : {}),
        },
      })
    );
    return patch.status;
  },

  async listForOrder(storeId: string, orderId: string) {
    const rows = await withStoreRw(storeId, db =>
      db.etaReceipt.findMany({
        where: { storeId, orderId },
        orderBy: [{ createdAt: 'asc' }],
        select: {
          id: true,
          kind: true,
          seq: true,
          refundKey: true,
          status: true,
          uuid: true,
          longId: true,
          receiptNumber: true,
          errorCode: true,
          errorMessage: true,
          issuedAt: true,
          acceptedAt: true,
          attempts: true,
          nextAttemptAt: true,
          totalPiastres: true,
          environment: true,
          document: true,
        },
      })
    );
    return Promise.all(
      rows.map(async ({ document, ...r }) => {
        const doc = document as {
          header?: { dateTimeIssued?: string };
          seller?: { rin?: string };
        } | null;
        // The QR link resolves only once ETA has marked the receipt Valid.
        const qr =
          r.status === 'accepted' &&
          r.uuid &&
          doc?.header?.dateTimeIssued &&
          doc.seller?.rin &&
          r.totalPiastres != null
            ? etaQrPayload({
                environment: r.environment as EtaEnvironment,
                uuid: r.uuid,
                dateTimeIssued: doc.header.dateTimeIssued,
                total: r.totalPiastres / 100,
                rin: doc.seller.rin,
              })
            : null;
        const qrSvg = qr ? await QRCode.toString(qr, { type: 'svg', margin: 1 }) : null;
        return { ...r, qr, qrSvg };
      })
    );
  },

  /**
   * Re-issue a `failed` or `rejected` receipt as the NEXT seq (a corrected document gets a new uuid and
   * `referenceOldUUID` = the refused one, https://sdk.invoicing.eta.gov.eg/receiptissuancefaq/). `late`
   * receipts are not re-issued here: they need a Late Submission Request in the ETA portal first.
   */
  async retry(storeId: string, id: string): Promise<boolean> {
    const row = await withStoreRw(storeId, db =>
      db.etaReceipt.findFirst({ where: { id, storeId } })
    );
    if (!row || !['failed', 'rejected'].includes(row.status)) return false;
    const newer = await withStoreRw(storeId, db =>
      db.etaReceipt.findFirst({
        where: {
          storeId,
          orderId: row.orderId,
          kind: row.kind,
          seq: { gt: row.seq },
          ...(row.kind === 'return' ? { refundKey: row.refundKey } : {}),
        },
        select: { id: true },
      })
    );
    if (newer) return false;
    await this.createRowAndSend(
      storeId,
      row.orderId,
      row.kind as 'sale' | 'return',
      row.environment,
      {
        refundKey: row.refundKey,
        lineMap: row.kind === 'return' ? row.lineMap : null,
      }
    );
    return true;
  },

  /** Job crashed past its retries: never leave the row looking alive. */
  async markJobCrashed(storeId: string, receiptId: string): Promise<void> {
    await withStoreRw(storeId, db =>
      db.etaReceipt.updateMany({
        where: { id: receiptId, storeId, status: { in: ['queued', 'retrying', 'submitted'] } },
        data: {
          status: 'failed',
          errorCode: 'job_crashed',
          errorMessage: 'the submission job stopped; re-issue from the order page',
          nextAttemptAt: null,
        },
      })
    );
    await sendAlert({
      level: 'p1',
      source: 'eta.receipt.job_crashed',
      title: 'ETA e-receipt job crashed',
      body: `store ${storeId} receipt ${receiptId}`,
    }).catch(() => undefined);
  },
};
