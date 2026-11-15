import { minorToDecimalString, withNumerals } from '@ebda/shared';

/** Document kinds the fiscal-document API issues (rulings MONEYB-1, MONEYB-4). */
export const FISCAL_DOC_TYPES = [
  'tax_invoice',
  'receipt',
  'credit_note',
  'refund_receipt',
  'order_record',
  'billing_record',
] as const;

export type FiscalDocType = (typeof FISCAL_DOC_TYPES)[number];

export interface FiscalDocument {
  id: string;
  orderId: string | null;
  docType: FiscalDocType;
  number: string;
  status: 'issued' | 'cancelled';
  issuedAt: string;
  cancelledAt: string | null;
  originalNumber: string | null;
  /** Integer piastres. */
  netAmount: number;
  vatAmount: number;
  totalAmount: number;
  currency: string;
  orderNumber: string | null;
  /** Archive / list enrichment (optional: older API responses lack it). */
  customerName?: string | null;
  /** Masked phone/e-mail, never the full value. */
  contactMasked?: string | null;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  etaStatus?: string | null;
  etaUuid?: string | null;
}

export interface ArchiveStoreSummary {
  documentCount: number;
  lastIssuedAt: string | null;
  lastNumber: string | null;
  period: { from: string; to: string; net: number; vat: number; gross: number; count: number };
  taxProfileStatus: string | null;
  trnPresent: boolean;
  etaConnected: boolean;
  etaEnabled: boolean;
  etaEnvironment: string | null;
}

export type ArchivePeriod = 'thisMonth' | 'lastMonth' | 'thisYear';

/** ISO bounds of a preset period in the viewer's local calendar. */
export function periodRange(period: ArchivePeriod, now = new Date()): { from: string; to: string } {
  const y = now.getFullYear();
  const m = now.getMonth();
  if (period === 'lastMonth')
    return {
      from: new Date(y, m - 1, 1).toISOString(),
      to: new Date(y, m, 1, 0, 0, 0, -1).toISOString(),
    };
  if (period === 'thisYear')
    return { from: new Date(y, 0, 1).toISOString(), to: now.toISOString() };
  return { from: new Date(y, m, 1).toISOString(), to: now.toISOString() };
}

/** `YYYY-MM-DD` from a date input → ISO instant at the start / end of that local day. */
export function dayBound(day: string, end: boolean): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return new Date(`${day}T${end ? '23:59:59.999' : '00:00:00'}`).toISOString();
}

export function formatFiscalMoney(minor: number, currency: string): string {
  return `${minorToDecimalString(minor, currency)} ${currency}`;
}

/** Issue date in the store's timezone (an Egyptian merchant's day, not the browser's). */
export function formatFiscalDate(iso: string, locale: string, timeZone?: string | null): string {
  const opts = withNumerals({
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timeZone || undefined,
  });
  try {
    return new Date(iso).toLocaleString(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', opts);
  } catch {
    // An unknown timezone string must not blank the row.
    return new Date(iso).toLocaleString(
      locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB',
      withNumerals({ dateStyle: 'medium', timeStyle: 'short' })
    );
  }
}
