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
    field: 'wbsTemplates',
    table: 'stores',
    column: 'wbs_templates',
    kind: 'json',
    why: 'WhatsApp template header media (logo header)',
  },
  {
    model: 'Store',
    field: 'botCopy',
    table: 'stores',
    column: 'bot_copy',
    kind: 'json',
    why: 'bot copy; may carry media URLs',
  },
  {
    model: 'Store',
    field: 'aboutJson',
    table: 'stores',
    column: 'about_json',
    kind: 'json',
    why: 'about page content; may carry images',
  },
  {
    model: 'Store',
    field: 'botServiceMenu',
    table: 'stores',
    column: 'bot_service_menu',
    kind: 'json',
    why: 'bot service menu; may carry media URLs',
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

/** Registered columns grouped by table, in registry order. */
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
