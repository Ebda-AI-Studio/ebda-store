/**
 * PLATFORM FISCAL ARCHIVE for stores on their Durable Object (Ruling FISCAL-ARCHIVE-1).
 *
 * Why: a fiscal document must be retained AND producible for FISCAL_RETENTION_YEARS after issue, even after its store is deleted.
 * A deleted DO store keeps its rows (nothing wipes a DO) but every read resolves the store through its retired D1 directory row, so
 * the records exist and cannot be produced. This module copies them, BEFORE the directory row is retired, into R2 (`STORE_BACKUPS`
 * = bucket ebda-private) where the platform reads them without the store DO.
 *
 * Layout (the prefix is NOT under `stores/<id>/`, `exports/` or `store-do-backups/`, so no store purge, PDPL export sweep or
 * backup rotation touches it; `exports/` is the only prefix with an expiry lifecycle rule):
 *   fiscal-archive/v1/data/<storeId>.ndjson.gz       one JSON object per line, `t` = doc | eta | counter | billing
 *   fiscal-archive/v1/manifests/<storeId>.json       written LAST: its presence means the data object is complete + checksummed
 *
 * Idempotent: a retry re-reads the (closed, so unchanging) DO, and writes only when the checksum differs. It REFUSES to shrink an
 * existing archive (fewer documents than the manifest records) rather than overwrite a longer record with a shorter one.
 * PII: only what the fiscal document legally contains (see cf/store-do/fiscal-export.ts); no PII in logs (ids and counts only).
 */
import { createHash } from 'node:crypto';

export const FISCAL_ARCHIVE_PREFIX = 'fiscal-archive/v1/';
export const dataKey = (storeId: string) => `${FISCAL_ARCHIVE_PREFIX}data/${storeId}.ndjson.gz`;
export const manifestKey = (storeId: string) => `${FISCAL_ARCHIVE_PREFIX}manifests/${storeId}.json`;
const MANIFEST_PREFIX = `${FISCAL_ARCHIVE_PREFIX}manifests/`;
/** Mirrors apps/api/src/config/retention.ts (kept literal so this module loads on workerd without the config chain). */
export const ARCHIVE_RETENTION_YEARS = 7;

export interface R2ArchiveBucket {
  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<unknown>;
  get(
    key: string
  ): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  list(opts?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}

export interface ArchiveManifest {
  version: 1;
  storeId: string;
  storeName: string | null;
  exportedAt: string;
  source: 'store-do';
  counts: { documents: number; eta: number; counters: number; billing: number };
  lastIssuedAt: number | null;
  /** The LATEST retain_until of any document: the archive may not be purged before it. */
  retainUntilMax: number | null;
  sha256: string;
  bytes: number;
}

export class FiscalArchiveError extends Error {
  constructor(
    public readonly code: 'EXPORT_FAILED' | 'WOULD_SHRINK' | 'VERIFY_FAILED' | 'NO_BUCKET',
    message: string
  ) {
    super(message);
  }
}

type Row = Record<string, unknown>;
export interface FiscalExportSource {
  page(
    section: 'documents' | 'eta' | 'counters',
    after: string | null,
    limit: number
  ): Promise<{ rows: Row[]; next: string | null }>;
  /** Ebda's own subscription VAT ledger for the store (platform D1 `billing_events`), mapped by the caller. */
  billing(): Promise<Row[]>;
  storeName(): Promise<string | null>;
}

const PAGE = 500;
const MAX_ROWS = 2_000_000;

async function drain(src: FiscalExportSource, section: 'documents' | 'eta' | 'counters') {
  const out: Row[] = [];
  let after: string | null = null;
  do {
    const p = await src.page(section, after, PAGE);
    out.push(...p.rows);
    after = p.next;
    if (out.length > MAX_ROWS)
      throw new FiscalArchiveError('EXPORT_FAILED', `${section}: over ${MAX_ROWS} rows`);
  } while (after);
  return out;
}

export async function gzip(text: string): Promise<Uint8Array> {
  const s = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function gunzip(buf: ArrayBuffer | Uint8Array): Promise<string> {
  const s = new Blob([buf as unknown as ArrayBuffer])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(s).text();
}
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Retain-until for a billing event: issue date + the retention years (same rule as the document rows). */
export const billingRetainUntil = (createdAtMs: number): number => {
  const d = new Date(createdAtMs);
  d.setUTCFullYear(d.getUTCFullYear() + ARCHIVE_RETENTION_YEARS);
  return d.getTime();
};

export async function readManifest(
  r2: R2ArchiveBucket,
  storeId: string
): Promise<ArchiveManifest | null> {
  const o = await r2.get(manifestKey(storeId));
  return o ? (JSON.parse(await o.text()) as ArchiveManifest) : null;
}

/**
 * Export a DO store's fiscal records to the platform archive. Throws FiscalArchiveError (never returns a partial success) so the
 * caller can fail the deletion closed. Returns the manifest on success, `written:false` when an identical archive already exists.
 */
export async function exportFiscalToArchive(
  storeId: string,
  src: FiscalExportSource,
  r2: R2ArchiveBucket | undefined,
  now: () => Date = () => new Date()
): Promise<{ manifest: ArchiveManifest; written: boolean }> {
  if (!r2) throw new FiscalArchiveError('NO_BUCKET', 'STORE_BACKUPS binding missing');
  let rows: { documents: Row[]; eta: Row[]; counters: Row[]; billing: Row[] };
  let storeName: string | null;
  try {
    const [documents, eta, counters, billing, name] = await Promise.all([
      drain(src, 'documents'),
      drain(src, 'eta'),
      drain(src, 'counters'),
      src.billing(),
      src.storeName(),
    ]);
    rows = { documents, eta, counters, billing };
    storeName = name;
  } catch (e) {
    if (e instanceof FiscalArchiveError) throw e;
    throw new FiscalArchiveError('EXPORT_FAILED', `read failed: ${(e as Error).message}`);
  }
  const lines = [
    ...rows.documents.map(r => JSON.stringify({ t: 'doc', ...r })),
    ...rows.eta.map(r => JSON.stringify({ t: 'eta', ...r })),
    ...rows.counters.map(r => JSON.stringify({ t: 'counter', ...r })),
    ...rows.billing.map(r => JSON.stringify({ t: 'billing', ...r })),
  ];
  const data = await gzip(lines.join('\n') + (lines.length ? '\n' : ''));
  const digest = sha256(data);
  const issued = [...rows.documents.map(d => Number(d.issued_at))].filter(Number.isFinite);
  const retain = [
    ...rows.documents.map(d => Number(d.retain_until)),
    ...rows.billing.map(b => Number(b.retain_until)),
  ].filter(Number.isFinite);
  const manifest: ArchiveManifest = {
    version: 1,
    storeId,
    storeName,
    exportedAt: now().toISOString(),
    source: 'store-do',
    counts: {
      documents: rows.documents.length,
      eta: rows.eta.length,
      counters: rows.counters.length,
      billing: rows.billing.length,
    },
    lastIssuedAt: issued.length ? Math.max(...issued) : null,
    retainUntilMax: retain.length ? Math.max(...retain) : null,
    sha256: digest,
    bytes: data.byteLength,
  };
  const existing = await readManifest(r2, storeId);
  if (existing) {
    if (existing.sha256 === digest) return { manifest: existing, written: false };
    if (
      manifest.counts.documents < existing.counts.documents ||
      manifest.counts.eta < existing.counts.eta ||
      manifest.counts.billing < existing.counts.billing
    )
      throw new FiscalArchiveError(
        'WOULD_SHRINK',
        `store ${storeId}: the new export holds fewer records than the existing archive`
      );
  }
  await r2.put(dataKey(storeId), data);
  // Read back and verify BEFORE the manifest exists: a manifest is only ever written over data that was checked.
  const back = await r2.get(dataKey(storeId));
  if (!back || sha256(new Uint8Array(await back.arrayBuffer())) !== digest)
    throw new FiscalArchiveError('VERIFY_FAILED', `store ${storeId}: archive read-back mismatch`);
  await r2.put(manifestKey(storeId), JSON.stringify(manifest));
  return { manifest, written: true };
}

// ---------------------------------------------------------------------------------------------------- reads (super-admin)

export interface ArchivedStore {
  storeId: string;
  storeName: string | null;
  documentCount: number;
  lastIssuedAt: Date | null;
  storeExists: false;
}

export async function listArchivedStores(
  r2: R2ArchiveBucket,
  opts: { cursor?: string; limit?: number } = {}
): Promise<{ stores: ArchivedStore[]; nextCursor: string | null }> {
  const page = await r2.list({
    prefix: MANIFEST_PREFIX,
    cursor: opts.cursor,
    limit: Math.min(opts.limit ?? 100, 1000),
  });
  const stores: ArchivedStore[] = [];
  for (const o of page.objects) {
    const m = JSON.parse((await (await r2.get(o.key))!.text()) || 'null') as ArchiveManifest | null;
    if (!m) continue;
    stores.push({
      storeId: m.storeId,
      storeName: m.storeName,
      documentCount: m.counts.documents + m.counts.billing,
      lastIssuedAt: m.lastIssuedAt === null ? null : new Date(m.lastIssuedAt),
      storeExists: false,
    });
  }
  return { stores, nextCursor: page.truncated ? (page.cursor ?? null) : null };
}

/** The shape the existing viewers and `renderFiscalDocumentHtml` take (definer.ts FiscalArchiveRow). */
export interface ArchivedDocument {
  id: string;
  storeId: string;
  orderId: string | null;
  docType: string;
  number: string | null;
  status: string;
  issuedAt: Date;
  cancelledAt: Date | null;
  originalNumber: string | null;
  originalIssuedAt: Date | null;
  currency: string;
  netAmount: number;
  vatAmount: number;
  totalAmount: number;
  vatRateBps: number | null;
  sellerTrn: string | null;
  payload: unknown;
  retainUntil: Date;
  etaStatus: string | null;
  etaUuid: string | null;
}

const date = (v: unknown) => (v === null || v === undefined ? null : new Date(Number(v)));
const parse = (v: unknown) => {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

/** Loads and VERIFIES (checksum against the manifest) a deleted store's archive. Returns null when none exists. */
export async function loadArchive(
  r2: R2ArchiveBucket,
  storeId: string
): Promise<{
  manifest: ArchiveManifest;
  documents: ArchivedDocument[];
  eta: Row[];
  counters: Row[];
} | null> {
  const manifest = await readManifest(r2, storeId);
  if (!manifest) return null;
  const obj = await r2.get(dataKey(storeId));
  if (!obj) throw new FiscalArchiveError('VERIFY_FAILED', `store ${storeId}: data object missing`);
  const raw = new Uint8Array(await obj.arrayBuffer());
  if (sha256(raw) !== manifest.sha256)
    throw new FiscalArchiveError('VERIFY_FAILED', `store ${storeId}: checksum mismatch`);
  const all = (await gunzip(raw))
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Row);
  const documents: ArchivedDocument[] = [];
  for (const r of all) {
    if (r.t === 'doc')
      documents.push({
        id: String(r.id),
        storeId,
        orderId: (r.order_id as string | null) ?? null,
        docType: String(r.doc_type),
        number: (r.number as string | null) ?? null,
        status: String(r.status),
        issuedAt: date(r.issued_at)!,
        cancelledAt: date(r.cancelled_at),
        originalNumber: (r.original_number as string | null) ?? null,
        originalIssuedAt: date(r.original_issued_at),
        currency: String(r.currency),
        netAmount: Number(r.net_amount),
        vatAmount: Number(r.vat_amount),
        totalAmount: Number(r.total_amount),
        vatRateBps: r.vat_rate_bps === null ? null : Number(r.vat_rate_bps),
        sellerTrn: (r.seller_trn as string | null) ?? null,
        payload: parse(r.payload),
        retainUntil: date(r.retain_until)!,
        etaStatus: (r.eta_status as string | null) ?? null,
        etaUuid: (r.eta_uuid as string | null) ?? null,
      });
    else if (r.t === 'billing')
      documents.push({
        id: String(r.id),
        storeId,
        orderId: null,
        docType: 'billing_record',
        number: null,
        status: 'issued',
        issuedAt: date(r.issued_at)!,
        cancelledAt: null,
        originalNumber: null,
        originalIssuedAt: null,
        currency: String(r.currency),
        netAmount: Number(r.net_amount),
        vatAmount: Number(r.vat_amount),
        totalAmount: Number(r.total_amount),
        vatRateBps: r.vat_rate_bps === null ? null : Number(r.vat_rate_bps),
        sellerTrn: (r.seller_trn as string | null) ?? null,
        payload: parse(r.payload),
        retainUntil: date(r.retain_until)!,
        etaStatus: null,
        etaUuid: null,
      });
  }
  return {
    manifest,
    documents,
    eta: all.filter(r => r.t === 'eta'),
    counters: all.filter(r => r.t === 'counter'),
  };
}

export interface ArchiveListQuery {
  /** Keyset cursor `<issuedAtMs>:<id>` from the previous page (newest first). */
  cursor?: string;
  limit?: number;
  docType?: string;
  /** Document number, or the number of the document a credit note reverses. */
  q?: string;
}

/** Newest first, keyset on (issuedAt, id): stable while nothing changes, which is the case for an immutable archive. */
export function pageArchivedDocuments(
  docs: ArchivedDocument[],
  q: ArchiveListQuery
): { documents: ArchivedDocument[]; nextCursor: string | null } {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const needle = q.q?.toLowerCase();
  const sorted = docs
    .filter(d => !q.docType || d.docType === q.docType)
    .filter(
      d =>
        !needle ||
        (d.number ?? '').toLowerCase().includes(needle) ||
        (d.originalNumber ?? '').toLowerCase().includes(needle)
    )
    .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime() || (a.id < b.id ? 1 : -1));
  let start = 0;
  if (q.cursor) {
    const i = q.cursor.indexOf(':');
    const at = Number(q.cursor.slice(0, i));
    const id = q.cursor.slice(i + 1);
    start = sorted.findIndex(
      d => d.issuedAt.getTime() < at || (d.issuedAt.getTime() === at && d.id < id)
    );
    if (start < 0) start = sorted.length;
  }
  const documents = sorted.slice(start, start + limit);
  const last = documents[documents.length - 1];
  const more = start + limit < sorted.length;
  return {
    documents,
    nextCursor: more && last ? `${last.issuedAt.getTime()}:${last.id}` : null,
  };
}
