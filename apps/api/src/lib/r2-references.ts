/**
 * THE single registry of every database column that can hold an R2 object URL,
 * and the two readers built on it.
 *
 * Why this file exists: three places decide whether an R2 object is still
 * referenced, and each used to keep its own hand-written column list —
 *
 *   - scripts/r2-orphan-audit.ts                        (manual audit, `--apply` deletes)
 *   - apps/api/src/lib/inngest/functions/r2-orphan-sweep.ts (weekly cron)
 *   - apps/api/src/services/r2-cleanup.service.ts        (per-URL delete on replace)
 *
 * The lists drifted. None of them read `Store.pwaSettings`, the ONLY place the
 * generated PWA icon/favicon URLs are stored, so an audit `--apply` would have
 * deleted every live PWA icon. The per-URL check did not read ANY JSON column,
 * so replacing a hero slide in one store deleted the same image out from under
 * a cloned store whose `layoutSettings` still pointed at it. Every list also
 * missed `Store.theme` (footer logo), `Store.typography` (custom fonts),
 * `StorePage.contentBlocks` (image blocks), `Bundle.image` and
 * `Expense.receiptImageUrl`.
 *
 * All three now read `R2_REFERENCE_COLUMNS`, and
 * tests/unit/r2-reference-registry.test.ts parses schema.prisma and fails when
 * a URL-shaped or Json column is neither registered here nor explicitly
 * allowlisted with a reason. The schema is the checklist.
 *
 * Direction of safety: a column listed here that never actually holds an R2
 * URL costs one extra query and deletes nothing; a column MISSING from here
 * deletes live files. When unsure, register it.
 *
 * This module has no imports on purpose: the standalone audit script loads it
 * without pulling in the API's config/logger.
 */

/**
 * How a column's value is read.
 *  - `url`  — the whole value is one URL (exact match).
 *  - `json` — a JSON document; every string anywhere inside it is scanned.
 *  - `text` — free text / HTML / markdown that may embed URLs.
 */
export type R2ReferenceKind = 'url' | 'json' | 'text';

export interface R2ReferenceColumn {
  /** Prisma model name, as written in schema.prisma. */
  model: string;
  /** Prisma field name. */
  field: string;
  /** Physical table (the model's `@@map`). Verified against the schema by test. */
  table: string;
  /** Physical column (the field's `@map`). Verified against the schema by test. */
  column: string;
  kind: R2ReferenceKind;
  /** What puts an R2 URL in this column. */
  why: string;
}

export const R2_REFERENCE_COLUMNS: readonly R2ReferenceColumn[] = [
  // ── Store: single-URL brand images ─────────────────────────────────────────
  {
    model: 'Store',
    field: 'logo',
    table: 'stores',
    column: 'logo',
    kind: 'url',
    why: 'branding logo upload',
  },
  {
    model: 'Store',
    field: 'logoAr',
    table: 'stores',
    column: 'logo_ar',
    kind: 'url',
    why: 'branding Arabic logo upload',
  },
  {
    model: 'Store',
    field: 'favicon',
    table: 'stores',
    column: 'favicon',
    kind: 'url',
    why: 'branding favicon upload',
  },
  {
    model: 'Store',
    field: 'heroImage',
    table: 'stores',
    column: 'hero_image',
    kind: 'url',
    why: 'legacy hero image upload',
  },
  {
    model: 'Store',
    field: 'bestSellersImage',
    table: 'stores',
    column: 'best_sellers_image',
    kind: 'url',
    why: 'best-sellers banner upload',
  },
  {
    model: 'Store',
    field: 'ogImage',
    table: 'stores',
    column: 'og_image',
    kind: 'url',
    why: 'SEO og:image upload',
  },
  {
    model: 'Store',
    field: 'heroCtaLink',
    table: 'stores',
    column: 'hero_cta_link',
    kind: 'url',
    why: 'merchant-typed link; may point at an uploaded file (PDF menu, lookbook)',
  },
  // ── Store: JSON documents ──────────────────────────────────────────────────
  {
    model: 'Store',
    field: 'pwaSettings',
    table: 'stores',
    column: 'pwa_settings',
    kind: 'json',
    why: 'generated PWA icons, apple-touch-icon, favicons (pwa.service generatePwaIconSet)',
  },
  {
    model: 'Store',
    field: 'layoutSettings',
    table: 'stores',
    column: 'layout_settings',
    kind: 'json',
    why: 'page-builder hero slides and section images',
  },
  {
    model: 'StorePageRevision',
    field: 'document',
    table: 'store_page_revisions',
    column: 'document',
    kind: 'json',
    // Every revision (draft, published AND archived) keeps its images live:
    // rollback republishes an archived document, so an image that only an
    // old revision still names must not be swept as an orphan.
    why: 'visual-builder page revisions (draft / published / archived; rollback restores them)',
  },
  {
    model: 'Store',
    field: 'theme',
    table: 'stores',
    column: 'theme',
    kind: 'json',
    why: 'theme footer logo and theme images',
  },
  {
    model: 'Store',
    field: 'typography',
    table: 'stores',
    column: 'typography',
    kind: 'json',
    why: 'custom font files uploaded to the fonts/ folder',
  },
  {
    model: 'Store',
    field: 'settings',
    table: 'stores',
    column: 'settings',
    kind: 'json',
    why: 'free-form store settings; may carry image URLs',
  },
  {
    model: 'Store',
    field: 'announcementBar',
    table: 'stores',
    column: 'announcement_bar',
    kind: 'json',
    why: 'announcement bar content; may carry image URLs',
  },
  {
    model: 'Store',
    field: 'socialLinks',
    table: 'stores',
    column: 'social_links',
    kind: 'json',
    why: 'link map; registered so any uploaded asset linked here survives',
  },
  {
    model: 'Store',
    field: 'marketingPixels',
    table: 'stores',
    column: 'marketing_pixels',
    kind: 'json',
    why: 'pixel config; the old audit walker documented it but never read it',
  },
  {
    model: 'Store',
    field: 'loyaltySettings',
    table: 'stores',
    column: 'loyalty_settings',
    kind: 'json',
    why: 'loyalty/reward config; may carry reward imagery',
  },
  {
    model: 'Store',
    field: 'aboutJson',
    table: 'stores',
    column: 'about_json',
    kind: 'json',
    why: 'about page content; may carry images',
  },
  // ── Content ────────────────────────────────────────────────────────────────
  {
    model: 'StorePage',
    field: 'coverImage',
    table: 'store_pages',
    column: 'cover_image',
    kind: 'url',
    why: 'CMS page cover upload',
  },
  {
    model: 'StorePage',
    field: 'contentBlocks',
    table: 'store_pages',
    column: 'content_blocks',
    kind: 'json',
    why: 'CMS image blocks (block.url)',
  },
  {
    model: 'StorePage',
    field: 'contentBlocksAr',
    table: 'store_pages',
    column: 'content_blocks_ar',
    kind: 'json',
    why: 'Arabic CMS image blocks',
  },
  {
    model: 'BlogPost',
    field: 'coverImage',
    table: 'blog_posts',
    column: 'cover_image',
    kind: 'url',
    why: 'blog cover upload',
  },
  {
    model: 'BlogPost',
    field: 'content',
    table: 'blog_posts',
    column: 'content',
    kind: 'text',
    why: 'rendered as HTML on the storefront; may embed uploaded images',
  },
  {
    model: 'BlogPost',
    field: 'contentAr',
    table: 'blog_posts',
    column: 'content_ar',
    kind: 'text',
    why: 'Arabic blog HTML; may embed uploaded images',
  },
  {
    model: 'StoreHowto',
    field: 'steps',
    table: 'store_howtos',
    column: 'steps',
    kind: 'json',
    why: 'how-to steps; may carry step images',
  },
  {
    model: 'StoreHowto',
    field: 'stepsAr',
    table: 'store_howtos',
    column: 'steps_ar',
    kind: 'json',
    why: 'Arabic how-to steps; may carry step images',
  },
  {
    model: 'Campaign',
    field: 'bodyHtml',
    table: 'campaigns',
    column: 'body_html',
    kind: 'text',
    why: 'sent email HTML embeds images that must keep loading in inboxes',
  },
  {
    model: 'Campaign',
    field: 'bodyHtmlAr',
    table: 'campaigns',
    column: 'body_html_ar',
    kind: 'text',
    why: 'Arabic email HTML',
  },
  // ── Catalog ────────────────────────────────────────────────────────────────
  {
    model: 'Category',
    field: 'image',
    table: 'categories',
    column: 'image',
    kind: 'url',
    why: 'category image upload',
  },
  {
    model: 'ProductImage',
    field: 'url',
    table: 'product_images',
    column: 'url',
    kind: 'url',
    why: 'product gallery upload',
  },
  {
    model: 'ProductVariant',
    field: 'imageUrl',
    table: 'product_variants',
    column: 'image_url',
    kind: 'url',
    why: 'per-variant image upload',
  },
  {
    model: 'ProductOptionValue',
    field: 'swatchImageUrl',
    table: 'product_option_values',
    column: 'swatch_image_url',
    kind: 'url',
    why: 'option-value swatch photo upload',
  },
  // ── Product 3D models (docs/plans/2026-10-07-product-3d-viewer.md) ─────────
  {
    model: 'ProductModel',
    field: 'modelUrl',
    table: 'product_models',
    column: 'model_url',
    kind: 'url',
    why: 'product 3D model (.glb) upload, stores/<id>/models/',
  },
  {
    model: 'ProductModel',
    field: 'usdzUrl',
    table: 'product_models',
    column: 'usdz_url',
    kind: 'url',
    why: 'optional iOS Quick Look .usdz upload, stores/<id>/models/',
  },
  {
    model: 'ProductModel',
    field: 'posterUrl',
    table: 'product_models',
    column: 'poster_url',
    kind: 'url',
    why: '3D viewer poster (captured from the preview or uploaded), products/ folder',
  },
  {
    model: 'Bundle',
    field: 'image',
    table: 'bundles',
    column: 'image',
    kind: 'url',
    why: 'bundle image upload',
  },
  {
    model: 'AbandonedCart',
    field: 'cartItems',
    table: 'abandoned_carts',
    column: 'cart_items',
    kind: 'json',
    why: 'snapshot productImage used by recovery emails',
  },
  // ── People ─────────────────────────────────────────────────────────────────
  {
    model: 'User',
    field: 'avatar',
    table: 'users',
    column: 'avatar',
    kind: 'url',
    why: 'customer/admin avatar upload',
  },
  // ── Back office ────────────────────────────────────────────────────────────
  {
    model: 'Expense',
    field: 'receiptImageUrl',
    table: 'expenses',
    column: 'receipt_image_url',
    kind: 'url',
    why: 'receipt photo uploaded to R2 (expenses.routes)',
  },
  {
    model: 'StockAdjustment',
    field: 'evidenceUrl',
    table: 'stock_adjustments',
    column: 'evidence_url',
    kind: 'url',
    why: 'adjustment evidence link; may be an uploaded photo',
  },
  {
    model: 'SystemSetting',
    field: 'value',
    table: 'system_settings',
    column: 'value',
    kind: 'json',
    why: 'platform settings; may carry platform branding images',
  },
  // ── Billing: InstaPay payment proof (signup funnel) ────────────────────────
  {
    model: 'ManualPaymentClaim',
    field: 'proofUrl',
    table: 'manual_payment_claims',
    column: 'proof_url',
    kind: 'url',
    why: 'optional InstaPay transfer screenshot uploaded by the merchant',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// URL extraction
// ─────────────────────────────────────────────────────────────────────────────

/** An http(s) URL embedded in text: stops at whitespace, quotes, brackets. */
const URL_IN_TEXT = /https?:\/\/[^\s"'<>()[\]{}\\`]+/g;

/**
 * Every URL a string may be referring to. Deliberately over-inclusive: an
 * extra candidate only makes an object look MORE referenced (never deleted);
 * a missed candidate deletes a live file. So for each embedded match we add
 * the raw match, the match with trailing sentence punctuation stripped, and
 * the match with its query/fragment stripped.
 */
export function urlsInString(s: string): string[] {
  const out = new Set<string>();
  if (s.startsWith('http://') || s.startsWith('https://')) out.add(s);
  for (const match of s.matchAll(URL_IN_TEXT)) {
    const raw = match[0];
    const trimmed = raw.replace(/[.,;:!?]+$/, '');
    out.add(raw);
    out.add(trimmed);
    out.add(trimmed.replace(/[?#].*$/, ''));
  }
  return [...out];
}

/**
 * Recursively walk a JSON value (object / array / string) and collect every
 * URL found in any string inside it — whole-string URLs and URLs embedded in
 * HTML/markdown strings alike.
 */
export function collectUrlsFromJson(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (v == null) return;
    if (typeof v === 'string') {
      out.push(...urlsInString(v));
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (typeof v === 'object') {
      for (const inner of Object.values(v as Record<string, unknown>)) visit(inner);
    }
  };
  visit(value);
  return out;
}

/** Every URL a registered column's value may hold, per its kind. */
export function urlsInColumnValue(kind: R2ReferenceKind, value: unknown): string[] {
  if (value == null) return [];
  if (kind === 'json') return collectUrlsFromJson(value);
  if (typeof value !== 'string' || value.length === 0) return [];
  return kind === 'url' ? [value] : urlsInString(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Readers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The only client surface the readers need. A `PrismaClient` and an
 * interactive-transaction client (`withRlsBypass`'s `tx`) both satisfy it.
 */
export interface R2ReferenceDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/** Runs one unit of DB work — `fn => fn(prisma)` or `withRlsBypass`. */
export type R2ReferenceRunner = <T>(fn: (db: R2ReferenceDb) => Promise<T>) => Promise<T>;

const q = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

/**
 * Registry tables whose RLS policy is STRICT — no contextless allowance, so a
 * read without the bypass sees nothing (the pinned list is STRICT_TABLES in
 * tests/integration/rls-ebda-app.test.ts; tests/unit/r2-orphan-classify.test.ts
 * keeps this in step with it and the registry).
 */
export const STRICT_R2_TABLES: readonly string[] = [
  'blog_posts',
  'expenses',
  'stock_adjustments',
  'store_howtos',
];

/** A catalog handle: reads pg_class/pg_stat and may run ANALYZE. */
export interface R2CatalogDb extends R2ReferenceDb {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * Last line before an irreversible bulk R2 delete (issues 2251, 2288), and a
 * validity check on any orphan REPORT an operator will act on.
 *
 * Through the SAME runner the collection used, every STRICT registered table
 * must show rows whenever the table has any. Zero visible rows over a
 * non-empty table means the read was filtered by RLS, the referenced set is
 * incomplete, and every key those rows point to would be deleted as an
 * "orphan". Refuse instead.
 *
 * "Has any" cannot come from a count on another connection — that count is
 * subject to the very policy under test. It comes from the catalog, which RLS
 * does not filter, and the catalog's answer can be UNKNOWN: `pg_class.reltuples`
 * is -1 on PostgreSQL 14+ for a table never vacuumed or analyzed — exactly a
 * freshly branched/restored database, or a small per-tenant table that sits
 * below autovacuum's analyze threshold forever. The old check collapsed -1 to 0
 * with GREATEST(), read "empty", and passed having proved nothing (issue 2288).
 * So: ANALYZE the table first (cheap for the small tables this is about, and
 * not filtered by RLS), then read reltuples AND the stats collector's
 * n_live_tup. Either one positive → non-empty → refuse.
 *
 * reltuples still -1 → UNKNOWN. That used to refuse unconditionally, which has
 * no way out for the role it gates (issue 2354): after the ebda_app cutover the
 * connection role is NOT the table owner, so ANALYZE is skipped with a WARNING,
 * and a table that has never had a row is never auto-analyzed — reltuples stays
 * -1 forever and the sweep would refuse (and page p1) every week. So the bypass
 * is now proven POSITIVELY, inside the same runner the collection used: the
 * connection role bypasses RLS BY ITSELF (`rolsuper OR rolbypassrls`; Ebda has
 * no `app.bypass_rls` flag any more — the policies are strict and the only way
 * to read every row is an owner-role connection). With the bypass proven a 0 is
 * a real 0 and UNKNOWN passes; the catalog is then only POSITIVE evidence
 * against it. Without the bypass proven, UNKNOWN still refuses.
 */
export async function assertStrictTablesVisible(
  run: R2ReferenceRunner,
  catalog: R2CatalogDb,
  tables: readonly string[] = STRICT_R2_TABLES
): Promise<void> {
  const [role] = await run(db =>
    db.$queryRawUnsafe<Array<{ bypass: boolean | null }>>(
      `SELECT (rolsuper OR rolbypassrls) AS bypass FROM pg_roles WHERE rolname = current_user`
    )
  );
  const bypassProven = role?.bypass === true;

  for (const table of tables) {
    const [seen] = await run(db =>
      db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${q(table)}`)
    );
    if (Number(seen?.n ?? 0) > 0) continue;

    try {
      // Not owner → Postgres skips with a WARNING (no throw) and reltuples
      // stays as it was; a -1 then refuses below. Any other failure: same.
      await catalog.$executeRawUnsafe(`ANALYZE ${q(table)}`);
    } catch {
      /* fall through to what the catalog already knows */
    }
    const [stat] = await catalog.$queryRawUnsafe<Array<{ reltuples: number; live: number }>>(
      `SELECT c.reltuples::float8 AS reltuples, COALESCE(s.n_live_tup, 0)::float8 AS live
         FROM pg_class c LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
        WHERE c.oid = $1::regclass`,
      `public.${table}`
    );
    const reltuples = Number(stat?.reltuples ?? -1);
    const live = Number(stat?.live ?? 0);
    if (reltuples > 0 || live > 0) {
      throw new Error(
        `REFUSING: "${table}" shows 0 rows to the collector while the catalog says it has rows ` +
          `(reltuples ${reltuples}, n_live_tup ${live}). RLS is filtering the registry read, so ` +
          `its R2 references are missing and would be treated as orphans. Check the connection ` +
          `role (an owner-role connection is required).`
      );
    }
    if (reltuples !== 0 && !bypassProven) {
      throw new Error(
        `REFUSING: "${table}" shows 0 rows to the collector and the catalog cannot say whether ` +
          `it is empty (reltuples ${reltuples}: never analyzed, and ANALYZE did not update it — ` +
          `the connection role may not own the table), and the runner did not prove that the ` +
          `connection role bypasses RLS. Run ANALYZE "${table}" as the owner, or run the ` +
          `collection on an owner-role connection, then retry.`
      );
    }
  }
}

/** Registered columns grouped by table, in registry order. */
/**
 * Registry tables that are platform rows (Postgres / D1 for every store, whatever backend serves it). Every other registry table
 * is store data: for a store on its Durable Object it is read from the DO (`r2References`), and `tests` prove the DO schema has it.
 */
export const PLATFORM_R2_TABLES: readonly string[] = [
  'stores',
  'users',
  'system_settings',
  'manual_payment_claims',
];

export function columnsByTable(
  columns: readonly R2ReferenceColumn[] = R2_REFERENCE_COLUMNS
): Map<string, R2ReferenceColumn[]> {
  const byTable = new Map<string, R2ReferenceColumn[]>();
  for (const c of columns) {
    const list = byTable.get(c.table) ?? [];
    list.push(c);
    byTable.set(c.table, list);
  }
  return byTable;
}

const DEFAULT_PAGE_SIZE = 1000;

/**
 * Every R2 key referenced by any registered column, across all tenants.
 *
 * Reads each table with keyset pagination on `id` (one bounded query per
 * page, each inside its own `run` call so a cron never holds one giant
 * transaction open). `toKey` maps a URL to its R2 key, or null for a
 * foreign URL — the audit script and the API resolve that differently.
 */
export async function collectReferencedR2Keys(opts: {
  run: R2ReferenceRunner;
  toKey: (url: string) => string | null;
  pageSize?: number;
  columns?: readonly R2ReferenceColumn[];
}): Promise<Set<string>> {
  const { run, toKey } = opts;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const keys = new Set<string>();

  for (const [table, cols] of columnsByTable(opts.columns)) {
    const select = cols.map(c => q(c.column)).join(', ');
    let cursor = '';
    for (;;) {
      const rows = await run(db =>
        db.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT "id", ${select} FROM ${q(table)} WHERE "id" > $1::text ORDER BY "id" ASC LIMIT $2::int`,
          cursor,
          pageSize
        )
      );
      for (const row of rows) {
        for (const c of cols) {
          for (const url of urlsInColumnValue(c.kind, row[c.column])) {
            const key = toKey(url);
            if (key) keys.add(key);
          }
        }
      }
      if (rows.length < pageSize) break;
      cursor = String(rows[rows.length - 1]!.id);
    }
  }
  return keys;
}

/**
 * A statement answering "does any registered column still reference this
 * object?". `url` columns match the exact URL (an index probe, as before);
 * `json`/`text` columns match the R2 KEY as a substring of the value's text,
 * which also catches the other URL form (public vs endpoint) and URLs
 * embedded in HTML. A substring false positive only keeps a file alive.
 *
 * `part` (issue 2249): the substring branches are unindexable by construction
 * — a full scan with a per-row jsonb→text cast over `abandoned_carts`,
 * `campaigns`, `blog_posts`, `store_pages`, 13 JSON columns on `stores` —
 * measured at ~480 ms against 200k abandoned carts on Postgres 16. So
 * `isR2UrlReferenced` runs the cheap `'exact'` half first and only falls back
 * to `'substring'` when no exact reference exists. `'all'` is the combined
 * statement (kept for tests and ad-hoc audits).
 */
export function buildIsReferencedSql(
  columns: readonly R2ReferenceColumn[] = R2_REFERENCE_COLUMNS,
  part: 'all' | 'exact' | 'substring' = 'all'
): string {
  const clauses: string[] = [];
  for (const [table, all] of columnsByTable(columns)) {
    const cols = all.filter(c =>
      part === 'all' ? true : part === 'exact' ? c.kind === 'url' : c.kind !== 'url'
    );
    if (cols.length === 0) continue;
    // Placeholders: 'all' binds ($1 = url, $2 = key); each half binds only
    // the one value it uses, as $1 — Postgres rejects an unused parameter.
    const keyParam = part === 'substring' ? '$1' : '$2';
    const where = cols
      .map(c =>
        c.kind === 'url'
          ? `${q(c.column)} = $1::text`
          : `position(${keyParam}::text in ${q(c.column)}::text) > 0`
      )
      .join(' OR ');
    clauses.push(`EXISTS (SELECT 1 FROM ${q(table)} WHERE ${where})`);
  }
  if (clauses.length === 0) return `SELECT false AS "referenced"`;
  return `SELECT (${clauses.join(' OR ')}) AS "referenced"`;
}

const IS_REFERENCED_EXACT_SQL = buildIsReferencedSql(R2_REFERENCE_COLUMNS, 'exact');
const IS_REFERENCED_SUBSTRING_SQL = buildIsReferencedSql(R2_REFERENCE_COLUMNS, 'substring');

/**
 * True when any registered column still references `url` (whose R2 key is
 * `key`). Exact-URL probes first; the expensive substring scan only when they
 * miss.
 */
export async function isR2UrlReferenced(
  db: R2ReferenceDb,
  url: string,
  key: string
): Promise<boolean> {
  const exact = await db.$queryRawUnsafe<Array<{ referenced: boolean | null }>>(
    IS_REFERENCED_EXACT_SQL,
    url
  );
  if (exact[0]?.referenced) return true;
  const rows = await db.$queryRawUnsafe<Array<{ referenced: boolean | null }>>(
    IS_REFERENCED_SUBSTRING_SQL,
    key
  );
  return Boolean(rows[0]?.referenced);
}

// ── Derived objects: in R2, referenced by NO database column ─────────────────

/**
 * Objects the API renders itself and addresses by a deterministic keyed name,
 * so no column holds their URL (`stores/<id>/barcodes/<hmac>.png`, the email
 * barcode PNGs). They are not orphans (the diff against `R2_REFERENCE_COLUMNS`
 * would call every one an orphan and `--apply` would delete live email images),
 * and they are re-renderable, so they expire by AGE instead.
 */
export const DERIVED_R2_KEY_PATTERNS: readonly RegExp[] = [
  /^stores\/[0-9a-f-]{36}\/barcodes\/[0-9a-f]{32}\.png$/,
];
export const DERIVED_R2_RETENTION_DAYS = 400;

export const isDerivedR2Key = (key: string): boolean =>
  DERIVED_R2_KEY_PATTERNS.some(p => p.test(key));

export function isExpiredDerivedKey(
  key: string,
  lastModified: Date | undefined,
  now: number
): boolean {
  if (!isDerivedR2Key(key) || !lastModified) return false;
  return now - lastModified.getTime() > DERIVED_R2_RETENTION_DAYS * 86400_000;
}
