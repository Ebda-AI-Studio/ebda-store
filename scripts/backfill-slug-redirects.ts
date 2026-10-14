/**
 * One-time product SlugRedirect back-fill from retained bulk-import CSVs.
 *
 * RUN BY AHMAD ONLY (needs a live DATABASE_URL). Slug redirects are normally
 * captured going forward whenever ProductService.update changes a slug (see
 * apps/api/src/services/slug-redirect.service.ts). But every rename that
 * happened via a CSV bulk import *before* that capture existed left no
 * SlugRedirect row — those old product URLs 404 instead of 301-ing.
 *
 * Ebda retains the raw CSV text of every bulk import forever
 * (BulkImportJob.csvData, @db.Text — see packages/database/prisma/schema.prisma).
 * This script mines that retained history to reconstruct old -> new handle
 * mappings, joined by SKU:
 *
 *   - SKU is a stable merchant-assigned identity that survives a slug/handle
 *     rename (unlike the slug itself, which IS the thing that changed).
 *   - For a given SKU, every "slug" value that ever appeared in an import CSV
 *     for that store is a handle the product used to answer to.
 *   - The CURRENT live product row for that SKU tells us the handle it
 *     answers to now.
 *   - old-handle -> current-handle is therefore a VERIFIED fact recovered
 *     from data Ebda already has on disk — never a guess, never a
 *     slug-stripping heuristic. If a SKU can't be joined (no `sku` column in
 *     the CSV, or no live product for that SKU), we skip it and report it —
 *     we do not fabricate a mapping.
 *
 * Modes:
 *   - Default: DRY RUN. Prints the full candidate list + conflicts, writes
 *     nothing.
 *   - `--apply`: writes the candidates via recordSlugRedirect (idempotent —
 *     safe to re-run; upserts on (storeId, entityType, fromSlug)).
 *
 * Usage (from repo root, with a live DATABASE_URL):
 *   npx tsx scripts/backfill-slug-redirects.ts --store <storeId|slug|domain>
 *   npx tsx scripts/backfill-slug-redirects.ts --store <storeId|slug|domain> --apply
 */
import { fileURLToPath } from 'node:url';
import { prisma, SlugEntityType, withTenantContext } from '@ebda/database';
import { BulkService } from '../apps/api/src/services/bulk.service';
import { recordSlugRedirect } from '../apps/api/src/services/slug-redirect.service';

/**
 * Faithful copy of BulkService's private parseCSVLine — must match the
 * import pipeline's exact quote-aware parsing so the columns we read line up
 * with what was written to `products` at import time. Kept in this script
 * (rather than importing the private method) since it's `private static` on
 * BulkService; `BulkService.splitCsvRecords` IS public and reused directly.
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    if (char === '"' && !inQuotes) inQuotes = true;
    else if (char === '"' && inQuotes) {
      if (nextChar === '"') {
        current += '"';
        i++;
      } else inQuotes = false;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else current += char;
  }
  result.push(current.trim());
  return result;
}

export interface ImportCsvRow {
  slug: string;
  sku: string | undefined;
}

export interface ParsedImportCsv {
  rows: ImportCsvRow[];
  /** true when the CSV has no usable `slug` or `sku` column at all. */
  unusable: boolean;
}

/**
 * Parse one BulkImportJob.csvData blob into { slug, sku } rows, using the
 * exact same record/line splitting the import pipeline used. Header maps
 * 1:1 to field names — no aliasing. A CSV missing either the `slug` or `sku`
 * column is reported as unusable (its rows are not joinable at all).
 */
export function parseImportCsv(csvData: string): ParsedImportCsv {
  const records = BulkService.splitCsvRecords(csvData).filter(line => line.trim());
  if (records.length < 2) return { rows: [], unusable: true };

  const headers = parseCSVLine(records[0]).map(h => h.trim());
  const slugIdx = headers.indexOf('slug');
  const skuIdx = headers.indexOf('sku');
  if (slugIdx === -1 || skuIdx === -1) return { rows: [], unusable: true };

  const rows: ImportCsvRow[] = [];
  for (const record of records.slice(1)) {
    const values = parseCSVLine(record);
    const slug = values[slugIdx]?.trim();
    const sku = values[skuIdx]?.trim() || undefined;
    if (!slug) continue; // no handle in this row at all — nothing to map
    rows.push({ slug, sku });
  }
  return { rows, unusable: false };
}

export interface Candidate {
  sku: string;
  from: string;
  to: string;
}

export interface Conflict {
  sku: string;
  message: string;
}

export interface ComputeCandidatesInput {
  /** sku -> set of every import-time slug/handle ever seen for that sku */
  oldHandlesBySku: Map<string, Set<string>>;
  /** sku -> current live product slug */
  currentBySku: Map<string, string>;
  /** every slug currently live on a product (any sku) */
  liveSlugs: Set<string>;
}

export interface ComputeCandidatesResult {
  candidates: Candidate[];
  conflicts: Conflict[];
}

/**
 * Per-SKU pass: for each sku's historical handles, map every non-current,
 * non-live handle to the sku's current live slug. Never guesses — a sku
 * with no live product, or a handle that collides with a currently-live
 * slug, is reported as a conflict instead of redirected.
 */
function buildCandidatesPerSku(
  oldHandlesBySku: Map<string, Set<string>>,
  currentBySku: Map<string, string>,
  liveSlugs: Set<string>
): ComputeCandidatesResult {
  const candidates: Candidate[] = [];
  const conflicts: Conflict[] = [];

  for (const [sku, handles] of oldHandlesBySku) {
    const currentSlug = currentBySku.get(sku);
    if (!currentSlug) {
      conflicts.push({
        sku,
        message: `sku ${sku}: import handle(s) [${[...handles].join(', ')}] but no live product (deleted?) — skipped`,
      });
      continue;
    }

    for (const from of handles) {
      if (from === currentSlug) continue; // unchanged — nothing to redirect
      if (liveSlugs.has(from)) {
        conflicts.push({
          sku,
          message: `handle '${from}' is ALSO a live product slug — NOT redirecting`,
        });
        continue;
      }
      candidates.push({ sku, from, to: currentSlug });
    }
  }

  return { candidates, conflicts };
}

/**
 * Cross-sku ambiguity pass: catches the case where the SAME historical
 * `from` handle was produced for two DIFFERENT skus (e.g. a product was
 * deleted and its handle later reused by a different product). Since slug
 * is unique per store, two skus can never legitimately share a `from` that
 * maps to the same `to` — any duplicate `from` is therefore an ambiguity:
 * applying both candidates would make the upsert on
 * (storeId, entityType, fromSlug) silently keep whichever is written last,
 * 301-ing the old URL to the wrong product. Every candidate sharing that
 * `from` is pulled OUT of `candidates` and reported in `conflicts` instead.
 */
function dropAmbiguousFroms(candidates: Candidate[]): ComputeCandidatesResult {
  const byFrom = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const bucket = byFrom.get(c.from) ?? [];
    bucket.push(c);
    byFrom.set(c.from, bucket);
  }

  const ambiguousFroms = [...byFrom.keys()].filter(from => byFrom.get(from)!.length > 1).sort();
  if (ambiguousFroms.length === 0) return { candidates, conflicts: [] };

  const ambiguousSet = new Set(ambiguousFroms);
  const deduped = candidates.filter(c => !ambiguousSet.has(c.from));

  const conflicts: Conflict[] = ambiguousFroms.map(from => {
    const claimants = [...byFrom.get(from)!].sort((a, b) => a.sku.localeCompare(b.sku));
    const mapping = claimants.map(c => `${c.sku}→${c.to}`).join(', ');
    return {
      sku: claimants.map(c => c.sku).join(','),
      message: `ambiguous: handle '${from}' maps to multiple SKUs [${mapping}] — NOT backfilled, needs manual review`,
    };
  });

  return { candidates: deduped, conflicts };
}

/**
 * Pure join: see `buildCandidatesPerSku` and `dropAmbiguousFroms` for the two
 * passes this composes. Never guesses — every skip/exclusion is reported in
 * `conflicts`, never silently dropped.
 */
export function computeCandidates(input: ComputeCandidatesInput): ComputeCandidatesResult {
  const { oldHandlesBySku, currentBySku, liveSlugs } = input;
  const perSku = buildCandidatesPerSku(oldHandlesBySku, currentBySku, liveSlugs);
  const deduped = dropAmbiguousFroms(perSku.candidates);
  return {
    candidates: deduped.candidates,
    conflicts: [...perSku.conflicts, ...deduped.conflicts],
  };
}

function parseArgs(argv: string[]): { store: string | undefined; apply: boolean } {
  const storeIdx = argv.indexOf('--store');
  const store = storeIdx !== -1 ? argv[storeIdx + 1] : undefined;
  const apply = argv.includes('--apply');
  return { store, apply };
}

interface TargetStore {
  id: string;
  slug: string;
  domain: string | null;
  name: string;
}

/** Resolve `--store` to a real row (by id, slug, or domain). Logs and returns `null` on any failure — the caller aborts. */
async function resolveTargetStore(storeSelector: string | undefined): Promise<TargetStore | null> {
  if (!storeSelector) {
    // eslint-disable-next-line no-console
    console.error(
      '[backfill-slug-redirects] missing --store <storeId|slug|domain>. Aborting — nothing done.'
    );
    return null;
  }

  const store = await prisma.store.findFirst({
    where: { OR: [{ id: storeSelector }, { slug: storeSelector }, { domain: storeSelector }] },
    select: { id: true, slug: true, domain: true, name: true },
  });

  if (!store) {
    // eslint-disable-next-line no-console
    console.error(`[backfill-slug-redirects] no store matches "${storeSelector}". Aborting.`);
    return null;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[backfill-slug-redirects] store: ${store.name} (${store.id}) slug=${store.slug} domain=${store.domain ?? '(none)'}`
  );
  return store;
}

interface OldHandleScanResult {
  importJobCount: number;
  unusableCsvCount: number;
  skuLessRows: number;
  oldHandlesBySku: Map<string, Set<string>>;
}

/** Mines every retained BulkImportJob CSV for this store into sku -> {historical handles}. */
async function loadOldHandlesBySku(storeId: string): Promise<OldHandleScanResult> {
  const importJobs = await prisma.bulkImportJob.findMany({
    where: { storeId },
    select: { id: true, csvData: true, createdAt: true },
  });

  const oldHandlesBySku = new Map<string, Set<string>>();
  let skuLessRows = 0;
  let unusableCsvCount = 0;

  for (const job of importJobs) {
    const { rows, unusable } = parseImportCsv(job.csvData);
    if (unusable) {
      unusableCsvCount++;
      // eslint-disable-next-line no-console
      console.log(
        `[backfill-slug-redirects]   import job ${job.id} (${job.createdAt.toISOString()}): missing slug or sku column — skipped`
      );
      continue;
    }
    for (const row of rows) {
      if (!row.sku) {
        skuLessRows++;
        continue;
      }
      const set = oldHandlesBySku.get(row.sku) ?? new Set<string>();
      set.add(row.slug);
      oldHandlesBySku.set(row.sku, set);
    }
  }

  return { importJobCount: importJobs.length, unusableCsvCount, skuLessRows, oldHandlesBySku };
}

interface CurrentProductState {
  liveProductCount: number;
  currentBySku: Map<string, string>;
  liveSlugs: Set<string>;
}

/** The CURRENT live slug + sku for every non-deleted, sku-bearing product — the "answers to now" half of the join. */
async function loadCurrentProductState(storeId: string): Promise<CurrentProductState> {
  const liveProducts = await prisma.product.findMany({
    where: { storeId, sku: { not: null }, deletedAt: null },
    select: { id: true, slug: true, sku: true },
  });

  const currentBySku = new Map<string, string>();
  const liveSlugs = new Set<string>();
  for (const p of liveProducts) {
    if (!p.sku) continue;
    currentBySku.set(p.sku, p.slug);
    liveSlugs.add(p.slug);
  }

  return { liveProductCount: liveProducts.length, currentBySku, liveSlugs };
}

/** Prints the summary + candidate list + conflict list. Pure logging — no state, no writes. */
function reportResults(
  scan: OldHandleScanResult,
  productState: CurrentProductState,
  result: ComputeCandidatesResult
): void {
  const { candidates, conflicts } = result;

  // eslint-disable-next-line no-console
  console.log('\n[backfill-slug-redirects] === SUMMARY ===');
  // eslint-disable-next-line no-console
  console.log(
    `  import jobs scanned: ${scan.importJobCount} (${scan.unusableCsvCount} unusable — no slug/sku column)`
  );
  // eslint-disable-next-line no-console
  console.log(`  skus with import history: ${scan.oldHandlesBySku.size}`);
  // eslint-disable-next-line no-console
  console.log(`  live products (with sku): ${productState.liveProductCount}`);
  // eslint-disable-next-line no-console
  console.log(`  candidate redirects: ${candidates.length}`);
  // eslint-disable-next-line no-console
  console.log(
    `  sku-less import rows (had a slug but no sku — CANNOT be joined, not backfilled): ${scan.skuLessRows}`
  );
  // eslint-disable-next-line no-console
  console.log(`  conflicts/skips: ${conflicts.length}`);

  if (candidates.length > 0) {
    // eslint-disable-next-line no-console
    console.log('\n[backfill-slug-redirects] === CANDIDATES (from -> to [sku]) ===');
    for (const c of candidates) {
      // eslint-disable-next-line no-console
      console.log(`  ${c.from}  ->  ${c.to}   [${c.sku}]`);
    }
  }

  if (conflicts.length > 0) {
    // eslint-disable-next-line no-console
    console.log('\n[backfill-slug-redirects] === CONFLICTS / SKIPS ===');
    for (const c of conflicts) {
      // eslint-disable-next-line no-console
      console.log(`  ${c.message}`);
    }
  }
}

/** Writes every candidate via `recordSlugRedirect`, batched. Idempotent — safe to re-run. */
async function applyCandidates(storeId: string, candidates: Candidate[]): Promise<number> {
  const BATCH_SIZE = 100;
  let appliedCount = 0;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    await withTenantContext(storeId, async tx => {
      for (const c of batch) {
        await recordSlugRedirect(tx, storeId, SlugEntityType.PRODUCT, c.from, c.to);
        appliedCount++;
      }
    });
  }
  return appliedCount;
}

/** Orchestration only — each phase (resolve store, scan history, load current state, compute, report, apply) is its own named function above. */
async function main() {
  const { store: storeSelector, apply } = parseArgs(process.argv.slice(2));

  const store = await resolveTargetStore(storeSelector);
  if (!store) {
    process.exitCode = 1;
    return;
  }

  const scan = await loadOldHandlesBySku(store.id);
  const productState = await loadCurrentProductState(store.id);
  const result = computeCandidates({
    oldHandlesBySku: scan.oldHandlesBySku,
    currentBySku: productState.currentBySku,
    liveSlugs: productState.liveSlugs,
  });

  reportResults(scan, productState, result);

  if (!apply) {
    // eslint-disable-next-line no-console
    console.log('\n[backfill-slug-redirects] DRY RUN — no rows written; re-run with --apply');
    return;
  }

  const appliedCount = await applyCandidates(store.id, result.candidates);
  // eslint-disable-next-line no-console
  console.log(`\n[backfill-slug-redirects] APPLIED — ${appliedCount} redirect row(s) written`);
}

// Only run when this file is executed directly as a CLI (`npx tsx
// scripts/backfill-slug-redirects.ts`) — never as a side effect of the test
// file importing `parseImportCsv`/`computeCandidates` from this module.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .catch(err => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
