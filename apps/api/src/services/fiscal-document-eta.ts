import { EtaReceiptService } from './eta-receipt.service';
import { pickEtaReceipt } from './fiscal-document-list';
import type { RenderableEta } from './fiscal-document-render';
import logger from '../lib/logger';

/**
 * The ETA e-receipt state of a fiscal document, read LIVE at render time (submission to ETA happens after the
 * document is issued, so it can never be part of the immutable payload). Null when the order has no matching
 * receipt, ETA is not connected, or the store no longer exists.
 */
export async function etaForDocument(
  storeId: string,
  doc: { orderId: string | null; docType: string; refundRef?: string | null }
): Promise<RenderableEta | null> {
  if (!doc.orderId) return null;
  try {
    const receipts = await EtaReceiptService.listForOrder(storeId, doc.orderId);
    const r = pickEtaReceipt(doc, receipts);
    if (!r) return null;
    return {
      status: r.status,
      uuid: r.uuid ?? null,
      longId: r.longId ?? null,
      receiptNumber: r.receiptNumber ?? null,
      environment: r.environment,
      qr: r.qr,
      qrSvg: r.qrSvg,
    };
  } catch (err) {
    logger.warn({ err, storeId }, '[FISCAL] ETA state unavailable for document render');
    return null;
  }
}
