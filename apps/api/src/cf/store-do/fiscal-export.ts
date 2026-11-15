/**
 * Read-only export of a StoreDO's fiscal records for the platform fiscal archive (Ruling FISCAL-ARCHIVE-1). Works on a CLOSED store
 * (closing blocks writes, never reads). Keyset pages by primary key so a store with many documents never loads in one call.
 *
 * PII (Ruling FISCAL-ARCHIVE-1): fiscal_documents.payload goes out AS STORED (it legally contains what the document needs: nothing
 * for a plain receipt, buyer name + address for a tax invoice). eta_receipts goes out WITHOUT `document` (the submitted buyer block)
 * and WITHOUT `error_message` (can echo it): only the submission state and ids. Those two columns stay in the closed DO.
 */
export type FiscalSection = 'documents' | 'eta' | 'counters';

export interface SqlExec {
  exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] };
}

const DOC_COLUMNS = [
  'id',
  'store_id',
  'order_id',
  'doc_type',
  'serial',
  'number',
  'status',
  'issued_at',
  'cancelled_at',
  'original_document_id',
  'original_number',
  'original_issued_at',
  'currency',
  'net_amount',
  'vat_amount',
  'total_amount',
  'vat_rate_bps',
  'seller_trn',
  'payload',
  'refund_ref',
  'eta_uuid',
  'eta_submission_id',
  'eta_status',
  'eta_submitted_at',
  'retain_until',
  'created_at',
];
const ETA_COLUMNS = [
  'id',
  'store_id',
  'order_id',
  'kind',
  'seq',
  'refund_key',
  'status',
  'environment',
  'receipt_number',
  'uuid',
  'previous_uuid',
  'total_piastres',
  'issued_at',
  'deadline_at',
  'submission_uuid',
  'long_id',
  'attempts',
  'error_code',
  'accepted_at',
  'created_at',
  'updated_at',
];

export const MAX_FISCAL_PAGE = 500;

export function exportFiscalPage(
  sql: SqlExec,
  section: FiscalSection,
  after: string | null,
  limit: number
): { rows: Record<string, unknown>[]; next: string | null } {
  const n = Math.min(Math.max(1, Math.trunc(limit) || 1), MAX_FISCAL_PAGE);
  if (section === 'counters') {
    const rows = sql
      .exec(
        `SELECT store_id, doc_type, last_serial, updated_at FROM fiscal_document_counters ORDER BY doc_type`
      )
      .toArray();
    return { rows: rows as Record<string, unknown>[], next: null };
  }
  const cols = (section === 'documents' ? DOC_COLUMNS : ETA_COLUMNS).join(', ');
  const table = section === 'documents' ? 'fiscal_documents' : 'eta_receipts';
  const rows = sql
    .exec(
      `SELECT ${cols} FROM ${table} WHERE (?1 IS NULL OR id > ?1) ORDER BY id LIMIT ?2`,
      after,
      n + 1
    )
    .toArray() as Record<string, unknown>[];
  const more = rows.length > n;
  const page = more ? rows.slice(0, n) : rows;
  return { rows: page, next: more ? String(page[page.length - 1]!.id) : null };
}
