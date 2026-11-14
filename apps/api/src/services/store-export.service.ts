import { strToU8, zipSync } from 'fflate';

/**
 * Whole-store export for the OWNER (SELF-SERVICE gap A11, Ruling STORE-LIFECYCLE-1): one zip with an NDJSON file per table and a
 * manifest. Synchronous and bounded: above EXPORT_ROW_CAP rows in total the request is refused with 413 (an async job for larger
 * stores is NOT built). The cap keeps the bundle inside a Worker's memory. Secrets (API key hashes, provider credentials, payment
 * tokens) are in tables that are deliberately not listed here.
 */
export const EXPORT_ROW_CAP = 20_000;
export const EXPORT_TABLES = [
  'product',
  'category',
  'order',
  'customer',
  'coupon',
  'review',
  'return',
  'expense',
] as const;
type ExportTable = (typeof EXPORT_TABLES)[number];

type Reader = (storeId: string, table: string, take: number) => Promise<unknown[]>;

function ndjson(rows: unknown[]): string {
  return rows
    .map(r => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
    .join('\n');
}

type BundleResult =
  | { ok: true; zip: Uint8Array; rows: number }
  | { ok: false; rows: number; cap: number };

export async function buildStoreBundle(args: {
  storeId: string;
  tables: readonly string[];
  read: Reader;
  cap: number;
  now?: () => Date;
}): Promise<BundleResult> {
  const files: Record<string, Uint8Array> = {};
  const counts: Record<string, number> = {};
  let total = 0;
  for (const table of args.tables) {
    // Always the CALLER's store id: a table reader never sees another id.
    const rows = await args.read(args.storeId, table, args.cap - total + 1);
    total += rows.length;
    if (total > args.cap) return { ok: false, rows: total, cap: args.cap };
    counts[table] = rows.length;
    files[`${table}.ndjson`] = strToU8(ndjson(rows));
  }
  files['manifest.json'] = strToU8(
    JSON.stringify(
      {
        storeId: args.storeId,
        generatedAt: (args.now?.() ?? new Date()).toISOString(),
        format: 'ndjson',
        tables: counts,
      },
      null,
      2
    )
  );
  return { ok: true, zip: zipSync(files), rows: total };
}
