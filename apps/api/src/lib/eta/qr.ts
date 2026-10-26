import { ETA_HOSTS, type EtaEnvironment } from '@ebda/shared';

/**
 * Receipt QR payload, https://sdk.invoicing.eta.gov.eg/receiptissuancefaq/ (read 2026-10-26):
 * `{portal}/receipts/search/{uuid}/share/{issuedUtc}#Total:{total},IssuerRIN:{rin}`.
 * The link resolves only after ETA accepted the receipt; callers render it for accepted rows.
 */
export function etaQrPayload(a: {
  environment: EtaEnvironment;
  uuid: string;
  dateTimeIssued: string;
  total: number;
  rin: string;
}): string {
  return `${ETA_HOSTS[a.environment].portal}/receipts/search/${a.uuid}/share/${a.dateTimeIssued}#Total:${a.total},IssuerRIN:${a.rin}`;
}
