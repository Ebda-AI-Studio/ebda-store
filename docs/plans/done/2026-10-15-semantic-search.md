# Arabic + English Search Program (P0–P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ebda storefront and admin search find what Egyptian shoppers and merchants actually type (hamza/ta-marbuta/ya variants, diacritics, Arabic-Indic digits, Egyptian dialect, Franco-Arabic, English, phone numbers in any form). Measure what fails, using a privacy-safe search log that merchants can see.

**Architecture:** P0 folds Arabic text in ONE immutable SQL function (`public.ebda_ar_norm`), mirrored byte-for-byte in TypeScript (`normalizeArabicSearch`) and pinned by one shared vector set. Every product search runs over trigram GIN _expression_ indexes on that function. P1 adds merchant-editable, AI-filled `search_terms`, bge-m3 embeddings in a pgvector child table under strict RLS, and reciprocal-rank fusion of lexical and vector results. P2 moves admin customer, order and phone search into SQL behind the same folding and adds a ⌘K palette. P3 adds catalogue import from photos and PDFs with Gemini vision, plus a review screen.

**Tech Stack:** Postgres 17 on Neon (17.11, measured 2026-10-16) (pg_trgm installed, pgvector new), Prisma 6.19 (`@prisma/adapter-pg`, raw SQL for expression and vector predicates), Express on Cloudflare Workers (`ebda-api`), Workers AI `@cf/baai/bge-m3`, Inngest, Gemini `gemini-flash-lite-latest`, Next.js 16 admin and storefront, vitest, k6.

**Spec:** `.superpowers/shared/semantic-search-research.md` (the research brief, 2026-10-15) plus Ahmad's brief of 2026-10-15 ("do the whole thing we need this type of searching and optimizing"). The phase list in that brief is binding where it differs from the research sketch.

---

## Coordinator amendments (binding; override task text where they conflict)

Preflight (22 findings) — every suggested ruling in `.superpowers/sdd/2026-10-15-semantic-search/progress.md` § Preflight scan items 1–22 is ADOPTED as written; implementers read that list for their task. Highlights:

- **E1** migrations renumbered at PR-cut time to sort after the newest migration on main + open branches (P0 → 20261019000100/000200; P1–P3 shift by a day each).
- **E2 (T5)** search log writes go through `deferAfterTenantCommit('search-log', () => recordSearch(...))`; **E3** `isPersonalDataTerm` normalises digits first.
- **E10 (T12)** keyword leg uses the 1000 cap; fuse only the head, append the keyword tail; **E11** query embedding raced against ~400 ms with keyword-only fallback (ruling: the one sanctioned synchronous third-party call in a GET).
- **E8 (T3)** every product-search surface (bulk.routes.ts:125, bundle.routes.ts:387, bulk.service.ts:325, promotion.service.ts:54, wa-bridge.routes.ts:186) goes through `searchProductIds(..., 'admin')`.
- **E18–E20** email search via ILIKE (trigram); order search returns two truncated flags; ⌘K lookups keep `storeId` and include guest customers (key = email/phone).
- **E22** snippet corrections exactly as in item 22.

Ahmad 2026-10-15 additions:

- **E23 (NEW task in P2, after T18) — admin settings search:** ⌘K and the admin search box find ANY admin page AND individual setting (e.g. "واتساب", "الشحن", "أيام بدون توصيل", "delivery days", "change logo", "دليل المقاسات") in Arabic and English including everyday synonyms and the Arabic normaliser from T1, and deep-link to the exact control (scroll + highlight). Build it from a typed settings registry (route, section anchor, ar/en label, keywords) generated/validated against the admin i18n keys and the app router so a new setting without a registry entry fails a test. Role-aware (staff vs owner vs super-admin pages), feature-flag aware (no hidden/disabled features). Tests + docs.
- **E24 (P3)** no real catalogues exist: Task 22's evaluation uses 10 SYNTHETIC Arabic catalogue pages generated from the Qamar demo catalogue (photo-grid page, PDF price list, handwritten-style price tag, mixed ar/en, Arabic-Indic digits), clearly labelled synthetic; Baidu Unlimited-OCR is run ONLY locally (Ahmad's Mac Studio, Apple Silicon/MPS if it works; otherwise the comparison records "not run" with the reason) and NEVER in production; production import uses Gemini vision.

## Global Constraints

- Every phase is its own PR off `main`, reviewed and merged on its own. P1 is split into PR 2 to PR 5 (marked below). No PR depends on an unmerged later PR.
- **RLS strict (R-EBDA-001):** every new table with `store_id` gets `ENABLE` + `FORCE ROW LEVEL SECURITY`, the single `ebda_tenant_isolation` policy (`store_id = nullif(current_setting('app.current_store_id', true), '')` in USING and WITH CHECK, `TO ebda_app`) and `GRANT SELECT, INSERT, UPDATE, DELETE … TO ebda_app`. No `IS NULL` allowance and no bypass.
- **Tenant guard (R-EBDA-003..008):** after any Prisma model change, run `npm run gen:tenant-guard-schema -w packages/database` and commit `packages/database/src/tenant-guard-schema.generated.ts`. Raw SQL runs only inside a tenant or store scope, and every raw query that names a tenant table carries `store_id = ${storeId}`.
- **Inngest for >300 ms or any third-party call** (Gemini, Workers AI REST, R2 fetches). Mark the row `failed` when an enqueue throws. Bulk loops sleep `AI_BULK_THROTTLE_MS` after each success.
- **Redis/KV TTL floor 120 s.** Anything shorter uses `apps/api/src/lib/bounded-map.ts`.
- **Gemini generative calls use `process.env.GEMINI_MODEL || 'gemini-flash-lite-latest'`**, never a versioned name. Each call does `assertAiQuota({ storeId, bulk })` first and `recordUsage(...)` after.
- **Migrations:** hand-written SQL in `packages/database/prisma/migrations/<ts>_<name>/migration.sql`, with a header comment (what / why / lock note / rollback) and a `rollback.sql` next to any index. Every index statement uses `IF NOT EXISTS`. **No `lock_timeout`** (docs/DB-INDEX-MIGRATIONS.md). An index on `products`, `orders` or `users` gets the "PRODUCTION PREREQUISITE: pre-build CONCURRENTLY on DIRECT_URL" block, because those tables are live. Prisma cannot declare expression indexes, so each one is added to the "Trigram (GIN) indexes and Prisma drift" list in `docs/DB-INDEX-MIGRATIONS.md`.
- **Functions used in an index are schema-qualified inside their body (`public.ebda_ar_norm`)**: `pg_dump`/`pg_restore` runs with an empty `search_path`, and an unqualified call makes the restore fail to rebuild the index.
- **Every data has a UI:** `search_query_daily` (P0), `products.search_terms` (P0/P1), `product_embeddings` status (P1, counts on the search insights page) and `catalog_import_*` (P3) each name their viewer in the task that creates them.
- **Arabic-first, platform-level:** all admin copy goes in `apps/admin/src/i18n/messages/{ar,en}.json` and all storefront copy in `apps/web/src/contexts/LanguageContext.tsx`. Never branch on a store slug. Screenshots for review are taken in Arabic.
- **Doc parity in the same PR:** `docs/ENVIRONMENT.md` (every new env var), `docs/RETENTION.md` + `docs/privacy/data-map.md` (search log, catalogue uploads), `docs/DB-INDEX-MIGRATIONS.md` (new expression indexes), `docs/RULINGS.md` (rulings listed at the end of this plan) and `CLAUDE.md` § Tech stack (Workers AI binding, P1).
- **Commits:** commitlint `type(scope): lower-case subject`, with the scope from `api|web|admin|database|ui|shared|config|auth|store|product|order|cart|deps|ci`. Leave a blank line before the trailers:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5`. `git add` takes explicit paths only. Never use `--no-verify`.
- **Local DB for integration tests** is the same image CI uses after Task 9. Before Task 9, `postgres:16-alpine` is enough for P0.
  ```bash
  # docker, or Apple `container run` with identical flags
  docker run -d --name ebda-search-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=force_test -p 5432:5432 pgvector/pgvector:0.8.0-pg17
  export TEST_DB=postgresql://test:test@localhost:5432/force_test
  DATABASE_URL=$TEST_DB DIRECT_URL=$TEST_DB npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
  ```
- **No production access by the implementer.** Every production action is a STOP point (section "STOP points").
- **Latency bar:** storefront search p95 < 500 ms under k6 (Task 14). **Quality bar:** the eval harness pass bar in Task 13.

## Review Focus

1. **LIKE metacharacters in a shopper's query** (`%`, `_`, `\`). Searching `50%` or `a_b` must match those literal characters, not everything. The old Prisma `contains` escaped them; the new raw SQL must too. Pinned in Task 3 (`escapes LIKE wildcards`). The pre-existing unescaped `like = %${q}%` in `customers.routes.ts` `/customers/search` is fixed in Task 16.
2. **TS/SQL normaliser drift.** A future edit to one side only makes typeahead and the index disagree silently. Pinned by the shared vector set run through BOTH implementations (Task 2 parity test). Task 1 also adds a vector for every character in the fold table, so a missed character fails.
3. **Personal data typed into the search box** (a shopper pastes their phone or email). It must never be stored in `search_query_daily`. Pinned in Task 5 (`drops phone- and email-shaped terms`).
4. **Store isolation of the vector leg.** A vector KNN that forgets `store_id` returns another tenant's products, and RLS hides that only for the `ebda_app` role. Pinned in Task 12 (`never returns another store's product`), on an `ebda_app` client.
5. **Semantic leg unavailable** (no `AI` binding locally, Workers AI 5xx, kill-switch off, no embeddings yet). Search must degrade to lexical results with HTTP 200, never 500 and never empty when lexical matches exist. Pinned in Task 12 (`falls back to lexical when the provider throws`).

---

## File Structure

| File                                                                              | Phase | Responsibility                                                                        |
| --------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------- |
| `packages/shared/src/search/arabic-normalize.ts`                                  | P0    | `normalizeArabicSearch`, `searchTokens`, `escapeLike`. The TS twin of `ebda_ar_norm`. |
| `packages/shared/src/search/normalize-vectors.ts`                                 | P0    | The ONE vector set both implementations are tested against                            |
| `packages/shared/src/search/phone-search.ts`                                      | P2    | `phoneSearchDigits`: Egyptian phone query → national digits                           |
| `packages/database/prisma/migrations/20261018000100_search_normalisation/`        | P0    | `ebda_ar_norm`, doc functions, `products.search_terms`, 2 expression trgm indexes     |
| `packages/database/prisma/migrations/20261018000200_search_query_daily/`          | P0    | Search log table + RLS                                                                |
| `apps/api/src/services/product-search.service.ts`                                 | P0→P1 | `searchProductIds` (lexical), later `rankedSearch` (hybrid)                           |
| `apps/api/src/services/search-log.service.ts`                                     | P0    | `recordSearch`, `isPersonalDataTerm`                                                  |
| `apps/api/src/routes/search-insights.routes.ts`                                   | P0    | Admin read API for the search log                                                     |
| `apps/admin/src/app/stores/[id]/insights/searches/page.tsx`                       | P0    | "What shoppers searched" page                                                         |
| `apps/admin/src/app/stores/[id]/analytics/_components/ZeroResultSearchesCard.tsx` | P0    | Overview card                                                                         |
| `apps/api/src/lib/ai/product-search-terms-generator.ts`                           | P1    | Gemini dialect/Franco/EN terms                                                        |
| `packages/database/prisma/migrations/20261019000100_product_embeddings/`          | P1    | pgvector + `product_embeddings` + `ebda_product_embed_doc`                            |
| `apps/api/src/lib/search/embedding-provider.ts`                                   | P1    | Workers AI binding, REST fallback, null provider                                      |
| `apps/api/src/lib/search/rrf.ts`                                                  | P1    | Reciprocal rank fusion                                                                |
| `apps/api/src/services/product-index.service.ts`                                  | P1    | Stale detection + embed + upsert                                                      |
| `apps/api/src/lib/inngest/functions/search-product-index.ts`                      | P1    | Debounced per-store indexer + cron backstop                                           |
| `apps/api/src/lib/search/reindex.ts`                                              | P1    | `requestStoreReindex` (fire-and-forget event)                                         |
| `tests/search-eval/`                                                              | P1    | 200-query eval set + harness                                                          |
| `loadtests/scenarios/storefront-search.js`                                        | P1    | k6 p95 gate                                                                           |
| `packages/database/prisma/migrations/20261020000100_admin_search_norm/`           | P2    | phone/name expression indexes on users + guest orders                                 |
| `apps/api/src/services/admin-search.service.ts`                                   | P2    | customers, orders, products for ⌘K                                                    |
| `apps/admin/src/components/CommandPalette.tsx`                                    | P2    | Record results section                                                                |
| `packages/database/prisma/migrations/20261021000100_catalog_import/`              | P3    | `catalog_import_jobs`, `catalog_import_items`                                         |
| `apps/api/src/services/catalog-import.service.ts` + Inngest fn                    | P3    | Vision extraction → items                                                             |
| `apps/admin/src/app/stores/[id]/bulk/catalog-import/[jobId]/page.tsx`             | P3    | Review → create drafts                                                                |
| `scripts/eval/catalog-ocr-head-to-head.ts`                                        | P3    | Offline Gemini vs Unlimited-OCR (never imported by apps)                              |

**Verified facts this plan relies on** (measured by reading the repo or docs on 2026-10-15):

- No `CREATE EXTENSION vector` exists in any of the 179 migrations. `pg_trgm` exists (`20260902120000`).
- Every Postgres in CI/compose is `postgres:16-alpine` (`ci.yml` lines 408/682/879/981/1050, `cf-api-deploy.yml:18`, `docker-compose.yml:7`), which does not ship pgvector.
- `apps/api/wrangler.jsonc` has no `ai` block. The Workers AI binding is `"ai": { "binding": "AI" }` with no id, so `scripts/ebda-cf-api-config.mjs` (which substitutes only the two placeholder ids) needs no change. AI bindings always run remotely, even in `wrangler dev`, and the smoke test runs `wrangler dev --local` (`scripts/ci/workerd-smoke.mjs:112`), so the smoke config must not carry the binding (Task 10).
- bge-m3 on Workers AI costs **$0.0118 per M input tokens** (developers.cloudflare.com/workers-ai/models/bge-m3). The 1024-dim output is [i] from the BAAI model card; Task 10 Step 1 measures it on the real binding and the code asserts it.
- `product.upserted` is fired only by `ProductService.create` (`product.service.ts:845`) and `ProductService.update` (`:1060`). MCP admin writes go through those (`mcp/tools/admin-write.tools.ts:116,136`).
- Writes that change product text but fire nothing: `bulk.service.ts:1026,1049` (CSV/XLSX import), `bulk-ai-translate.ts:267`, `ai-autofill.service.ts:271,516,569` (fill, balance, revert), `ai.routes.ts:2044` (hand-back clears a field). Status-only, price, inventory and flag writes do not change search text.
- `AI_AUTOFILL_FIELDS` (`packages/shared/src/types/ai-autofill.ts`) drives human/ai provenance stamping (`product.service.ts:778,920-930`), the autopilot fill core, the hand-back route (`ai.routes.ts:2029`), the 3-day stale sweep and `AiFieldBadge`.

---

# PHASE P0: measure + normalise (PR 1, `feat/search-p0-normalise`)

## Task 1: Shared Arabic search normaliser (TypeScript)

**Files:**

- Create: `packages/shared/src/search/arabic-normalize.ts`
- Create: `packages/shared/src/search/normalize-vectors.ts`
- Create: `packages/shared/src/search/index.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from './search';`)
- Modify: `apps/admin/src/components/CommandPalette.tsx:25-35` (its private `normalize` is a second copy of the same fold; replace it)
- Test: `packages/shared/src/search/__tests__/arabic-normalize.test.ts`

**Interfaces:**

- Produces: `normalizeArabicSearch(input: string): string`, `searchTokens(input: string, max?: number): string[]` (default max 8), `escapeLike(token: string): string`, `NORMALIZE_VECTORS: ReadonlyArray<readonly [input: string, expected: string]>`, `AR_FOLD_FROM: string`, `AR_FOLD_TO: string`

- [ ] **Step 1: Write the vector set (the contract both implementations obey)**

```ts
// packages/shared/src/search/normalize-vectors.ts
/**
 * THE contract for Arabic search folding. `normalizeArabicSearch` (TS) and
 * `public.ebda_ar_norm` (SQL, migration 20261018000100) are BOTH tested against
 * every row (packages/shared/src/search/__tests__ + tests/integration/search-normalize-parity.test.ts).
 * Change a rule => change it in both and add a row here.
 * Rows are real Egyptian shopper spellings (hamza dropped, ta-marbuta as ha, ya without dots).
 */
export const NORMALIZE_VECTORS: ReadonlyArray<readonly [string, string]> = [
  ['أحذية', 'احذيه'],
  ['احذيه', 'احذيه'],
  ['مكرونة', 'مكرونه'],
  ['إسدال', 'اسدال'],
  ['آيس كريم', 'ايس كريم'],
  ['ٱلقاهرة', 'القاهره'],
  ['مستشفى', 'مستشفي'],
  ['شنطة جلد', 'شنطه جلد'],
  ['جَزْمَة', 'جزمه'],
  ['عبـــاية', 'عبايه'],
  ['مقاس ٤٢', 'مقاس 42'],
  ['مقاس ۴۲', 'مقاس 42'],
  ['مسئول', 'مسيول'],
  ['مسؤول', 'مسوول'],
  ['کوتشی', 'كوتشي'],
  ['أحمر', 'احمر'], // alef + combining hamza above
  ['قُطْنٌ ١٠٠٪', 'قطن 100٪'],
  ['3abaya', '3abaya'],
  ['SHOES', 'shoes'],
  ['Abaya   Black', 'abaya black'],
  ['فستان سواريه', 'فستان سواريه'],
  ['  طقم  حريمي  ', 'طقم حريمي'],
  ['iPhone ١٥ Pro', 'iphone 15 pro'],
  ['ى', 'ي'],
  ['ة', 'ه'],
  ['ـ', ''],
  ['', ''],
];
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/shared/src/search/__tests__/arabic-normalize.test.ts
import { describe, it, expect } from 'vitest';
import {
  normalizeArabicSearch,
  searchTokens,
  escapeLike,
  AR_FOLD_FROM,
  AR_FOLD_TO,
} from '../arabic-normalize';
import { NORMALIZE_VECTORS } from '../normalize-vectors';

describe('normalizeArabicSearch', () => {
  it.each(NORMALIZE_VECTORS)('%j -> %j', (input, expected) => {
    expect(normalizeArabicSearch(input)).toBe(expected);
  });

  it('fold table is aligned 1:1 (a missing char would shift every later mapping)', () => {
    expect([...AR_FOLD_FROM].length).toBe([...AR_FOLD_TO].length);
  });

  it('every folded char has a vector (no untested rule)', () => {
    const covered = NORMALIZE_VECTORS.map(([i]) => i).join('');
    for (const ch of new Set([...AR_FOLD_FROM].filter(c => !/[A-Z0-9]/.test(c)))) {
      if (/[٠-٩۰-۹]/.test(ch)) continue; // digits covered by the ٤٢ / ۴۲ / ١٠٠ / ١٥ rows as a class
      expect(covered, `no vector exercises ${ch}`).toContain(ch);
    }
  });

  it('is idempotent', () => {
    for (const [input] of NORMALIZE_VECTORS) {
      const once = normalizeArabicSearch(input);
      expect(normalizeArabicSearch(once)).toBe(once);
    }
  });
});

describe('searchTokens', () => {
  it('normalises, splits on space and caps at 8 tokens', () => {
    expect(searchTokens('أحذية  رجالي')).toEqual(['احذيه', 'رجالي']);
    expect(searchTokens('a b c d e f g h i j')).toHaveLength(8);
    expect(searchTokens('   ')).toEqual([]);
  });
});

describe('escapeLike', () => {
  it('escapes backslash, percent and underscore', () => {
    expect(escapeLike('50%_off\\x')).toBe('50\\%\\_off\\\\x');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/search/__tests__/arabic-normalize.test.ts`
Expected: FAIL with `Cannot find module '../arabic-normalize'`

- [ ] **Step 4: Write the implementation**

```ts
// packages/shared/src/search/arabic-normalize.ts
/**
 * Arabic + English search folding. TS twin of SQL `public.ebda_ar_norm`
 * (migration 20261018000100_search_normalisation). The two MUST stay identical:
 * both are tested against NORMALIZE_VECTORS. Deliberately NO Unicode
 * normalize() and NO locale lowercasing: Postgres cannot reproduce either
 * immutably, so parity would break (Ruling SEARCH-2).
 */
// alef forms -> ا ; ى ی ئ -> ي ; ؤ -> و ; ة -> ه ; Persian kaf -> ك ; then ASCII upper, then digits
export const AR_FOLD_FROM = 'أإآٱىیئؤةکABCDEFGHIJKLMNOPQRSTUVWXYZ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
export const AR_FOLD_TO = 'اااايييوهكabcdefghijklmnopqrstuvwxyz01234567890123456789';

const FOLD = new Map<string, string>();
{
  const from = [...AR_FOLD_FROM];
  const to = [...AR_FOLD_TO];
  from.forEach((c, i) => FOLD.set(c, to[i]));
}

// tashkeel U+064B..U+065F, dagger alef U+0670, tatweel U+0640
const STRIP = /[ً-ٰٟـ]/g;
// explicit set (NOT \s): Postgres' [[:space:]] is locale-dependent
const SPACES = /[ \t\n\r ]+/g;

export function normalizeArabicSearch(input: string): string {
  if (!input) return '';
  const stripped = input.replace(STRIP, '');
  let out = '';
  for (const ch of stripped) out += FOLD.get(ch) ?? ch;
  return out.replace(SPACES, ' ').trim();
}

export function searchTokens(input: string, max = 8): string[] {
  return normalizeArabicSearch(input ?? '')
    .split(' ')
    .filter(Boolean)
    .slice(0, max);
}

/** Escape a token for a LIKE pattern with the default `\` escape. */
export function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, m => `\\${m}`);
}
```

```ts
// packages/shared/src/search/index.ts
export * from './arabic-normalize';
export * from './normalize-vectors';
```

In `apps/admin/src/components/CommandPalette.tsx`, delete the local `normalize` function (lines 25-35) and add `import { normalizeArabicSearch as normalize } from '@ebda/shared';` next to the other imports. Call sites are unchanged.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/shared/src/search/__tests__/arabic-normalize.test.ts && npm run build -w packages/shared && npm run typecheck`
Expected: PASS; typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/search packages/shared/src/index.ts apps/admin/src/components/CommandPalette.tsx
git commit -m "$(cat <<'EOF'
feat(shared): arabic search normaliser with shared vector set

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 2: SQL normaliser, `search_terms` column, expression trigram indexes

**Files:**

- Create: `packages/database/prisma/migrations/20261018000100_search_normalisation/migration.sql`
- Create: `packages/database/prisma/migrations/20261018000100_search_normalisation/rollback.sql`
- Modify: `packages/database/prisma/schema.prisma` (model `Product`: add `searchTerms`)
- Modify: `docs/DB-INDEX-MIGRATIONS.md` (§ Trigram indexes and Prisma drift: add the 2 indexes)
- Test: `tests/integration/search-normalize-parity.test.ts`

**Interfaces:**

- Consumes: `NORMALIZE_VECTORS` (Task 1)
- Produces (SQL): `public.ebda_ar_norm(text) → text`, `public.ebda_product_search_doc(name, name_ar, search_terms, description, description_ar) → text`, `public.ebda_product_name_doc(name, name_ar, search_terms) → text`. Indexes `products_search_doc_trgm_idx` and `products_name_doc_trgm_idx`. Column `products.search_terms TEXT NULL`, Prisma `searchTerms String? @map("search_terms")`.

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/search-normalize-parity.test.ts
import { describe, it, expect } from 'vitest';
import { prisma } from '@ebda/database';
import { NORMALIZE_VECTORS, normalizeArabicSearch } from '@ebda/shared';
import { hasDb } from '../helpers/bundle-fixtures';

describe.skipIf(!hasDb)('ebda_ar_norm parity with normalizeArabicSearch', () => {
  it.each(NORMALIZE_VECTORS)('SQL and TS agree on %j', async input => {
    const [row] = await prisma.$queryRaw<
      Array<{ n: string | null }>
    >`SELECT public.ebda_ar_norm(${input}) AS n`;
    expect(row.n).toBe(normalizeArabicSearch(input));
  });

  it('functions are IMMUTABLE (required for index expressions)', async () => {
    const rows = await prisma.$queryRaw<Array<{ proname: string; provolatile: string }>>`
      SELECT proname, provolatile FROM pg_proc
      WHERE proname IN ('ebda_ar_norm','ebda_product_search_doc','ebda_product_name_doc')`;
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.provolatile).toBe('i');
  });

  it('both expression indexes exist and are valid', async () => {
    const rows = await prisma.$queryRaw<Array<{ relname: string; valid: boolean }>>`
      SELECT c.relname, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname IN ('products_search_doc_trgm_idx','products_name_doc_trgm_idx')`;
    expect(rows.map(r => r.relname).sort()).toEqual([
      'products_name_doc_trgm_idx',
      'products_search_doc_trgm_idx',
    ]);
    expect(rows.every(r => r.valid)).toBe(true);
  });

  it('the planner can use the doc index for a normalised LIKE', async () => {
    await prisma.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
    const plan = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
      `EXPLAIN SELECT id FROM products WHERE public.ebda_product_search_doc(name, name_ar, search_terms, description, description_ar) LIKE '%احذيه%'`
    );
    expect(plan.map(p => p['QUERY PLAN']).join('\n')).toContain('products_search_doc_trgm_idx');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/search-normalize-parity.test.ts`
Expected: FAIL with `function public.ebda_ar_norm(unknown) does not exist`

- [ ] **Step 3: Write the migration**

```sql
-- packages/database/prisma/migrations/20261018000100_search_normalisation/migration.sql
-- Arabic search normalisation (search program P0, plan docs/plans/done/2026-10-15-semantic-search.md).
--
-- WHAT: public.ebda_ar_norm(text) folds alef forms (أإآٱ->ا), ى/ی/ئ->ي, ؤ->و, ة->ه, Persian kaf->ك,
--   strips tashkeel (U+064B-U+065F, U+0670) and tatweel (U+0640), maps Arabic-Indic and
--   Persian digits to 0-9, lowercases ASCII A-Z only, collapses [ \t\n\r NBSP]+ to one space.
--   Twin of normalizeArabicSearch (@ebda/shared); both are tested against NORMALIZE_VECTORS.
--   Two IMMUTABLE doc functions build the searched text; two trigram GIN EXPRESSION indexes
--   serve '%token%' LIKE on them. products.search_terms (merchant-editable; AI-filled in P1)
--   is added now so the doc functions' signature is final and P1 does not rebuild the indexes.
-- WHY: ILIKE does not fold Arabic letter variants: "احذيه" never matched "أحذية".
-- IMMUTABLE contract: changing a function body REQUIRES `REINDEX INDEX CONCURRENTLY` of both
--   indexes in the same change (the index stores the old output). Bodies call public.* fully
--   qualified so pg_restore (empty search_path) can rebuild the index.
-- concat_ws/array_to_string are STABLE, so the docs use coalesce(...) || ' ' || ... (immutable).
--
-- >>> PRODUCTION PREREQUISITE (do NOT skip): `products` is a live table. Before this reaches
-- production, run on DIRECT_URL in psql autocommit, then confirm `NOT indisvalid` returns 0 rows:
--   <the CREATE FUNCTION statements below, then>
--   ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "search_terms" TEXT;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_search_doc_trgm_idx" ON "products" USING gin
--     (public.ebda_product_search_doc("name","name_ar","search_terms","description","description_ar") gin_trgm_ops);
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "products_name_doc_trgm_idx" ON "products" USING gin
--     (public.ebda_product_name_doc("name","name_ar","search_terms") gin_trgm_ops);
-- ADD COLUMN of a nullable TEXT without default is catalog-only (no rewrite).
-- KNOWN DRIFT: Prisma cannot declare expression indexes; never accept a `migrate dev` DROP of them.
-- Rollback: rollback.sql (drops the two indexes CONCURRENTLY; keeps the column and functions).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION public.ebda_ar_norm(t text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT btrim(regexp_replace(
    translate(
      regexp_replace(t, '[ً-ٰٟـ]', '', 'g'),
      'أإآٱىیئؤةکABCDEFGHIJKLMNOPQRSTUVWXYZ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
      'اااايييوهكabcdefghijklmnopqrstuvwxyz01234567890123456789'
    ),
    '[ \t\n\r ]+', ' ', 'g'
  ), ' ')
$$;

CREATE OR REPLACE FUNCTION public.ebda_product_search_doc(
  p_name text, p_name_ar text, p_terms text, p_desc text, p_desc_ar text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT public.ebda_ar_norm(
    coalesce(p_name, '') || ' ' || coalesce(p_name_ar, '') || ' ' || coalesce(p_terms, '') || ' ' ||
    coalesce(p_desc, '') || ' ' || coalesce(p_desc_ar, '')
  )
$$;

CREATE OR REPLACE FUNCTION public.ebda_product_name_doc(
  p_name text, p_name_ar text, p_terms text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT public.ebda_ar_norm(coalesce(p_name, '') || ' ' || coalesce(p_name_ar, '') || ' ' || coalesce(p_terms, ''))
$$;

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "search_terms" TEXT;

CREATE INDEX IF NOT EXISTS "products_search_doc_trgm_idx" ON "products" USING gin
  (public.ebda_product_search_doc("name", "name_ar", "search_terms", "description", "description_ar") gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "products_name_doc_trgm_idx" ON "products" USING gin
  (public.ebda_product_name_doc("name", "name_ar", "search_terms") gin_trgm_ops);
```

```sql
-- rollback.sql — run on DIRECT_URL in autocommit. Column + functions are kept (no data loss);
-- roll the code back first, it is what queries the indexes.
DROP INDEX CONCURRENTLY IF EXISTS "products_search_doc_trgm_idx";
DROP INDEX CONCURRENTLY IF EXISTS "products_name_doc_trgm_idx";
```

In `schema.prisma`, `model Product`, add after `descriptionAr`:

```prisma
  // Extra words shoppers type for this product: Egyptian dialect, Franco-Arabic, English
  // ("جزمة, كوتشي, 3abaya, sneakers"). Comma-separated, merchant-editable, AI-filled when empty
  // (P1, AI_AUTOFILL_FIELDS). Searched through public.ebda_product_search_doc /
  // ebda_product_name_doc (expression trigram indexes, migration 20261018000100) — never shown on the storefront.
  searchTerms          String?       @map("search_terms")
```

In `docs/DB-INDEX-MIGRATIONS.md` § "Trigram (GIN) indexes and Prisma drift", add one bullet:
`- products_{search_doc,name_doc}_trgm_idx (EXPRESSION indexes on public.ebda_product_*_doc; changing ebda_ar_norm requires REINDEX CONCURRENTLY of both)`.

- [ ] **Step 4: Apply and run the test**

Run: `DATABASE_URL=$TEST_DB DIRECT_URL=$TEST_DB npx prisma migrate deploy --schema packages/database/prisma/schema.prisma && npm run db:generate && DATABASE_URL=$TEST_DB npx vitest run tests/integration/search-normalize-parity.test.ts`
Expected: PASS (27 parity rows + 3).

- [ ] **Step 5: Run the tenant-guard snapshot test (the column changes the DMMF)**

Run: `npm run gen:tenant-guard-schema -w packages/database && npx vitest run tests/unit/tenant-guard-schema-snapshot.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/database/prisma/migrations/20261018000100_search_normalisation packages/database/prisma/schema.prisma packages/database/src/tenant-guard-schema.generated.ts docs/DB-INDEX-MIGRATIONS.md tests/integration/search-normalize-parity.test.ts
git commit -m "$(cat <<'EOF'
feat(database): arabic search normalisation function and trigram expression indexes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 3: Product search through the normalised indexes (storefront list, typeahead, admin list, advanced search)

**Files:**

- Create: `apps/api/src/services/product-search.service.ts`
- Modify: `apps/api/src/services/product.service.ts:57-75` (`buildProductSearchAnd` becomes an id-set filter), `:557` (admin `list`), `:1386` (`listPublic`), `:2144` (`advancedSearch`), `:2311-2352` (`getSuggestSuggestions`), `:2367+` (`getSearchSuggestions`)
- Modify: every test importing `buildProductSearchAnd` (`grep -rln buildProductSearchAnd tests apps`)
- Test: `tests/integration/product-search-normalised.test.ts`

**Interfaces:**

- Consumes: `searchTokens`, `escapeLike` (Task 1); the SQL doc functions (Task 2)
- Produces:
  - `searchProductIds(storeId: string, raw: string, opts: { scope: 'storefront' | 'admin'; field?: 'doc' | 'name'; limit?: number }): Promise<string[]>`. Ids ordered by name similarity desc. Empty when there are no tokens. Storefront scope = `status='active' AND deleted_at IS NULL`; admin scope = `deleted_at IS NULL` and also matches SKU.
  - `PRODUCT_SEARCH_ID_CAP = 1000`
  - `buildProductSearchWhere(storeId, search, scope): Promise<Prisma.ProductWhereInput[]>` returns `[]` for a blank query, else `[{ id: { in: ids } }]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/product-search-normalised.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma, runInTenantContext } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

vi.mock('../../apps/api/src/lib/inngest/client', () => ({
  inngest: { send: vi.fn(async () => ({ ids: [] })), createFunction: vi.fn(() => ({})) },
}));
const { searchProductIds } = await import('../../apps/api/src/services/product-search.service');

const run = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
let storeId: string;
let otherStoreId: string;
const ids: Record<string, string> = {};

async function mkStore(slug: string) {
  const owner = await prisma.user.create({
    data: { email: `ps-${slug}@t.local`, role: 'store_admin' },
  });
  return (await prisma.store.create({ data: { name: slug, slug, ownerId: owner.id } })).id;
}
async function mk(store: string, key: string, data: Record<string, unknown>) {
  const p = await prisma.product.create({
    data: {
      storeId: store,
      slug: `${key}-${run}`,
      price: 1000,
      status: 'active',
      name: key,
      ...data,
    },
  });
  ids[key] = p.id;
}

describe.skipIf(!hasDb)('normalised product search', () => {
  beforeAll(async () => {
    storeId = await mkStore(`ps-a-${run}`);
    otherStoreId = await mkStore(`ps-b-${run}`);
    await mk(storeId, 'shoes', { name: 'Leather shoes', nameAr: 'أحذية جلد طبيعي' });
    await mk(storeId, 'pasta', { name: 'Pasta', nameAr: 'مكرونة إيطالي' });
    await mk(storeId, 'abaya', {
      name: 'Abaya',
      nameAr: 'عباية سوداء',
      searchTerms: '3abaya, عبايه',
    });
    await mk(storeId, 'pct', { name: 'Sale 50% off bundle' });
    await mk(storeId, 'size', { name: 'Shirt', nameAr: 'قميص مقاس 42' });
    await mk(storeId, 'draft', { name: 'Draft shoes', nameAr: 'أحذية', status: 'draft' });
    await mk(storeId, 'skuonly', { name: 'Mug', sku: 'MUG-٧٧' });
    await mk(otherStoreId, 'foreign', { name: 'Leather shoes', nameAr: 'أحذية' });
  });
  afterAll(async () => {
    await prisma.product.deleteMany({ where: { id: { in: Object.values(ids) } } });
  });

  const q = (raw: string, scope: 'storefront' | 'admin' = 'storefront', field?: 'doc' | 'name') =>
    runInTenantContext(storeId, () => searchProductIds(storeId, raw, { scope, field }));

  it('hamza + ta-marbuta spelling finds the product', async () => {
    expect(await q('احذيه')).toEqual([ids.shoes]);
  });
  it('dialect spelling of pasta', async () => {
    expect(await q('مكرونه')).toContain(ids.pasta);
  });
  it('Franco-Arabic via merchant search terms', async () => {
    expect(await q('3abaya')).toEqual([ids.abaya]);
  });
  it('Arabic-Indic digits match Latin digits', async () => {
    expect(await q('مقاس ٤٢')).toEqual([ids.size]);
  });
  it('word-AND, any order', async () => {
    expect(await q('جلد احذيه')).toEqual([ids.shoes]);
  });
  it('escapes LIKE wildcards', async () => {
    expect(await q('50%')).toEqual([ids.pct]);
    expect(await q('%')).toEqual([]);
    expect(await q('_')).toEqual([]);
  });
  it('storefront hides drafts, admin shows them', async () => {
    expect(await q('احذيه')).not.toContain(ids.draft);
    expect(await q('احذيه', 'admin')).toContain(ids.draft);
  });
  it('admin matches SKU with Arabic-Indic digits', async () => {
    expect(await q('mug-77', 'admin')).toEqual([ids.skuonly]);
    expect(await q('mug-77')).toEqual([]);
  });
  it('typeahead (name field) does not match description-only words', async () => {
    await prisma.product.update({
      where: { id: ids.pasta },
      data: { description: 'contains durum wheat' },
    });
    expect(await q('durum', 'storefront', 'name')).toEqual([]);
    expect(await q('durum')).toEqual([ids.pasta]);
  });
  it('never returns another store', async () => {
    expect(await q('leather shoes')).not.toContain(ids.foreign);
  });
  it('blank query returns []', async () => {
    expect(await q('   ')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/product-search-normalised.test.ts`
Expected: FAIL with `Cannot find module '../../apps/api/src/services/product-search.service'`

- [ ] **Step 3: Write `product-search.service.ts`**

```ts
// apps/api/src/services/product-search.service.ts
import { prisma, Prisma } from '@ebda/database';
import { searchTokens, escapeLike, normalizeArabicSearch } from '@ebda/shared';

/** Most ids a lexical search binds into the follow-up Prisma query. */
export const PRODUCT_SEARCH_ID_CAP = 1000;

export interface ProductSearchOpts {
  scope: 'storefront' | 'admin';
  /** 'doc' = names + search terms + descriptions (list); 'name' = names + search terms (typeahead). */
  field?: 'doc' | 'name';
  limit?: number;
}

/**
 * Lexical product search over the Arabic-normalised trigram expression indexes
 * (migration 20261018000100). Every token must appear (word-AND), in any order.
 * Raw SQL because Prisma cannot express a function-call predicate; it runs in the
 * caller's tenant scope (RLS) AND names store_id explicitly (tenant guard R-EBDA-004).
 * Result is ordered by name similarity so callers that rank (typeahead, P1 RRF) can use it.
 */
export async function searchProductIds(
  storeId: string,
  raw: string,
  opts: ProductSearchOpts
): Promise<string[]> {
  const tokens = searchTokens(raw);
  if (tokens.length === 0) return [];
  const limit = Math.min(PRODUCT_SEARCH_ID_CAP, Math.max(1, opts.limit ?? PRODUCT_SEARCH_ID_CAP));
  const doc =
    opts.field === 'name'
      ? Prisma.sql`public.ebda_product_name_doc(p.name, p.name_ar, p.search_terms)`
      : Prisma.sql`public.ebda_product_search_doc(p.name, p.name_ar, p.search_terms, p.description, p.description_ar)`;
  const arms = tokens.map(t => {
    const pattern = `%${escapeLike(t)}%`;
    return opts.scope === 'admin'
      ? Prisma.sql`(${doc} LIKE ${pattern} OR public.ebda_ar_norm(coalesce(p.sku, '')) LIKE ${pattern})`
      : Prisma.sql`${doc} LIKE ${pattern}`;
  });
  const status = opts.scope === 'storefront' ? Prisma.sql`AND p.status = 'active'` : Prisma.empty;
  const qNorm = normalizeArabicSearch(raw);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT p.id FROM products p
    WHERE p.store_id = ${storeId} AND p.deleted_at IS NULL ${status}
      AND ${Prisma.join(arms, ' AND ')}
    ORDER BY similarity(public.ebda_product_name_doc(p.name, p.name_ar, p.search_terms), ${qNorm}) DESC, p.id
    LIMIT ${limit}`;
  return rows.map(r => r.id);
}

/** Drop-in replacement for the old ILIKE AND-array: an id filter, or [] for a blank query. */
export async function buildProductSearchWhere(
  storeId: string,
  search: string | null | undefined,
  scope: 'storefront' | 'admin'
): Promise<Prisma.ProductWhereInput[]> {
  if (!search || searchTokens(search).length === 0) return [];
  const ids = await searchProductIds(storeId, search, { scope });
  return [{ id: { in: ids } }];
}
```

- [ ] **Step 4: Wire every caller in `product.service.ts`**

1. Delete `buildProductSearchAnd` (lines 36-75, doc comment included) and import `buildProductSearchWhere, searchProductIds` from `./product-search.service`.
2. Admin `list` (`:557`): replace `...buildProductSearchAnd(search, true),` with `...(await buildProductSearchWhere(storeId, search, 'admin')),`.
3. `listPublic` (`:1386`): replace `...buildProductSearchAnd(search, false),` with `...(await buildProductSearchWhere(storeId, search, 'storefront')),`.
4. `advancedSearch` (`:2144`): replace `...buildProductSearchAnd(query, true),` with `...(await buildProductSearchWhere(storeId, query, 'admin')),`.
5. `getSuggestSuggestions`: replace the `suggestTokens` block and the `AND:` arm with an id lookup that keeps the existing `featured desc, name asc` order:

```ts
const matchIds = await searchProductIds(storeId, trimmed, {
  scope: 'storefront',
  field: 'name',
  limit: 200,
});
if (matchIds.length === 0) return { suggestions: [] as Array<unknown> };
const products = await prisma.product.findMany({
  where: { storeId, status: 'active', deletedAt: null, id: { in: matchIds } },
  select: {
    id: true,
    slug: true,
    name: true,
    nameAr: true,
    price: true,
    images: { select: { url: true }, orderBy: { position: 'asc' }, take: 1 },
  },
  orderBy: [{ featured: 'desc' }, { name: 'asc' }],
  take,
});
```

6. `getSearchSuggestions`: replace its `OR: [{ name: { contains: query … } }, …]` with `id: { in: await searchProductIds(storeId, query, { scope: 'storefront', field: 'name', limit: 50 }) }`.

Then run `grep -rn "buildProductSearchAnd" apps tests packages`. Every hit is an existing unit test of the 8-token cap. Repoint each to `searchTokens` from `@ebda/shared` (the cap now lives there) and assert `expect(searchTokens('a b c d e f g h i j')).toHaveLength(8)`.

- [ ] **Step 5: Run the tests**

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/product-search-normalised.test.ts tests/integration/product-search-floor.test.ts && npx vitest run tests/unit && npm run typecheck`
Expected: all PASS. `product-search-floor.test.ts` still proves the 1-char floor and the 100-char cap in `public.routes.ts`, which is unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/product-search.service.ts apps/api/src/services/product.service.ts tests/integration/product-search-normalised.test.ts $(grep -rln "searchTokens" tests/unit)
git commit -m "$(cat <<'EOF'
feat(product): search products through arabic-normalised trigram indexes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 4: Merchant-editable "search words" field

**Files:**

- Modify: `apps/api/src/routes/product.routes.ts:~96` (`createProductSchema`)
- Modify: `apps/api/src/services/product.service.ts` (`CreateProductData`/`UpdateProductData` near `:290`, `create` data near `:811`, `update` data near `:1010`)
- Modify: `apps/admin/src/app/stores/[id]/products/[productId]/edit/page.tsx` (form state, load, save payload, field)
- Modify: `apps/admin/src/app/stores/[id]/products/new/page.tsx` (same field)
- Modify: `apps/admin/src/i18n/messages/{ar,en}.json` (`products.edit.searchTerms*`)
- Create: `packages/shared/src/search/search-terms.ts` (+ export from `search/index.ts`)
- Test: `packages/shared/src/search/__tests__/search-terms.test.ts`, `tests/integration/product-search-terms-field.test.ts`

**Interfaces:**

- Produces: `SEARCH_TERMS_MAX_LENGTH = 500`, `SEARCH_TERMS_MAX_COUNT = 30`, `cleanSearchTerms(raw: string | null | undefined): string | null` (split on `,` or `،` or newline, trim, dedupe case-insensitively after `normalizeArabicSearch`, cap the count, join with `, `, empty → null). Zod field `searchTerms: z.string().max(SEARCH_TERMS_MAX_LENGTH).nullable().optional().transform(cleanSearchTerms)`.

- [ ] **Step 1: Write the failing unit test**

```ts
// packages/shared/src/search/__tests__/search-terms.test.ts
import { describe, it, expect } from 'vitest';
import { cleanSearchTerms, SEARCH_TERMS_MAX_COUNT } from '../search-terms';

describe('cleanSearchTerms', () => {
  it('splits on latin comma, arabic comma and newlines; trims; dedupes by normalised form', () => {
    expect(cleanSearchTerms('جزمة، جزمه ,  كوتشي\n3abaya')).toBe('جزمة, كوتشي, 3abaya');
  });
  it('empty → null (clears)', () => {
    expect(cleanSearchTerms('  ,، ')).toBeNull();
    expect(cleanSearchTerms(null)).toBeNull();
  });
  it('caps the count', () => {
    const many = Array.from({ length: 40 }, (_, i) => `t${i}`).join(',');
    expect(cleanSearchTerms(many)!.split(', ')).toHaveLength(SEARCH_TERMS_MAX_COUNT);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/shared/src/search/__tests__/search-terms.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/search/search-terms.ts
import { normalizeArabicSearch } from './arabic-normalize';

export const SEARCH_TERMS_MAX_LENGTH = 500;
export const SEARCH_TERMS_MAX_COUNT = 30;

/** Canonical stored form of products.search_terms: "a, b, c" or null. */
export function cleanSearchTerms(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,،\n]/)) {
    const term = part.trim().slice(0, 60);
    const key = normalizeArabicSearch(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= SEARCH_TERMS_MAX_COUNT) break;
  }
  return out.length ? out.join(', ') : null;
}
```

In `product.routes.ts` `createProductSchema`, after `leadTimeDays`:

```ts
  // Extra words shoppers type (dialect / Franco / English). Searched, never displayed.
  searchTerms: z.string().max(SEARCH_TERMS_MAX_LENGTH).nullable().optional().transform(v =>
    v === undefined ? undefined : cleanSearchTerms(v)
  ),
```

In `product.service.ts`: add `searchTerms?: string | null;` to the data interface. In `create`, add `searchTerms: data.searchTerms ?? null,` next to `badgeLabelAr`. In `update`, add `...(data.searchTerms !== undefined ? { searchTerms: data.searchTerms } : {}),` next to `badgeLabelAr`. Admin reads use `getById`, which selects all scalars, so `searchTerms` comes back without a select change. Do NOT add it to the public select (`:495-505`): it is never shown to shoppers.

Admin edit page: add `searchTerms: string` to the form type and initial state (`''`), load it with `searchTerms: p.searchTerms || ''`, and send `searchTerms: formData.searchTerms.trim() === '' ? null : formData.searchTerms` in the PUT payload. Render the field directly under the Arabic description, inside the same content section:

```tsx
<div>
  <label htmlFor="searchTerms" className="block text-sm font-medium text-foreground">
    {t('searchTerms')}
  </label>
  <p className="mt-1 text-xs text-muted-foreground">{t('searchTermsHint')}</p>
  <textarea
    id="searchTerms"
    rows={2}
    dir="auto"
    maxLength={500}
    value={formData.searchTerms}
    onChange={e => updateField('searchTerms', e.target.value)}
    className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
  />
</div>
```

Add the same block to `products/new/page.tsx`. i18n under the existing `products.edit` object (and `products.new` if the new page uses its own namespace; follow whichever `useT(...)` namespace that page calls):

- en: `"searchTerms": "Search words"`, `"searchTermsHint": "Other words shoppers type for this product, separated by commas: Egyptian spellings, Franco (3abaya), English. Not shown in the store."`
- ar: `"searchTerms": "كلمات البحث"`, `"searchTermsHint": "كلمات تانية ممكن العميل يكتبها للمنتج ده، افصل بينها بفاصلة: الكتابة المصري، الفرانكو (3abaya)، الإنجليزي. مش بتظهر في المتجر."`

- [ ] **Step 4: Write the integration test (route → DB → search)**

```ts
// tests/integration/product-search-terms-field.test.ts
// Uses the same harness as tests/integration/product-search-normalised.test.ts (copy its
// mkStore/mk helpers and the inngest mock). Then:
it('PUT searchTerms is cleaned, stored, and searchable', async () => {
  const { ProductService } = await import('../../apps/api/src/services/product.service');
  await runInTenantContext(storeId, () =>
    ProductService.update(storeId, ids.shoes, { searchTerms: 'كوتشي، كوتشى , sneakers' } as never)
  );
  const row = await prisma.product.findUnique({
    where: { id: ids.shoes },
    select: { searchTerms: true },
  });
  expect(row!.searchTerms).toBe('كوتشي, sneakers');
  expect(await q('sneakers')).toEqual([ids.shoes]);
});
```

The route-level Zod transform is what does the cleaning, so this test calls the schema first: `const body = updateProductSchema.parse({ searchTerms: 'كوتشي، كوتشى , sneakers' })`. It then passes `body` to `ProductService.update`, and `updateProductSchema` is imported from `apps/api/src/routes/product.routes`.

- [ ] **Step 5: Run**

Run: `npx vitest run packages/shared/src/search && DATABASE_URL=$TEST_DB npx vitest run tests/integration/product-search-terms-field.test.ts && npx vitest run tests/unit/admin-i18n-key-parity.test.ts tests/unit/admin-i18n-keys-resolve.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/search apps/api/src/routes/product.routes.ts apps/api/src/services/product.service.ts "apps/admin/src/app/stores/[id]/products/[productId]/edit/page.tsx" "apps/admin/src/app/stores/[id]/products/new/page.tsx" apps/admin/src/i18n/messages/ar.json apps/admin/src/i18n/messages/en.json tests/integration/product-search-terms-field.test.ts
git commit -m "$(cat <<'EOF'
feat(product): merchant-editable search words field

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 5: Search-query log (privacy-safe daily aggregate) + retention

**Files:**

- Create: `packages/database/prisma/migrations/20261018000200_search_query_daily/migration.sql`
- Modify: `packages/database/prisma/schema.prisma` (new model `SearchQueryDaily`, back-relation `searchQueryDaily SearchQueryDaily[]` on `Store`)
- Create: `apps/api/src/services/search-log.service.ts`
- Modify: `apps/api/src/routes/public.routes.ts` (list route, after `result` is computed, ~line 290)
- Modify: `apps/api/src/lib/inngest/functions/data-retention.ts` (+ `searchLogPurge`), `apps/api/src/lib/inngest/functions/index.ts` (register)
- Modify: `docs/RETENTION.md` (matrix row + cron row), `docs/privacy/data-map.md` (one row)
- Test: `tests/unit/search-log-privacy.test.ts`, `tests/integration/search-log.test.ts`

**Interfaces:**

- Produces: `isPersonalDataTerm(norm: string): boolean`, `recordSearch(storeId: string, rawTerm: string, resultCount: number): Promise<boolean>` (fail-open; false when skipped), `SEARCH_LOG_RETENTION_DAYS = 90`, Prisma model `SearchQueryDaily { id, storeId, date, term, searches, zeroResults, lastResultCount, updatedAt }`.
- Viewer (every-data-needs-UI): Task 6 page `/stores/[id]/insights/searches` + overview card.

- [ ] **Step 1: Write the failing privacy unit test**

```ts
// tests/unit/search-log-privacy.test.ts
import { describe, it, expect } from 'vitest';
import { isPersonalDataTerm } from '../../apps/api/src/services/search-log.service';

describe('isPersonalDataTerm', () => {
  it.each([
    'ahmed@example.com',
    '01012345678',
    '+20 101 234 5678',
    '٠١٠١٢٣٤٥٦٧٨',
    '0020 1012345678',
    '29801011234567', // national-id shaped (14 digits)
  ])('drops %j', t => expect(isPersonalDataTerm(t)).toBe(true));
  it.each(['جزمه 42', 'iphone 15 pro', 'مقاس 44', 'sku-1234', 'كوتشي'])('keeps %j', t =>
    expect(isPersonalDataTerm(t)).toBe(false)
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/search-log-privacy.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Migration + model**

```sql
-- 20261018000200_search_query_daily/migration.sql
-- First-party storefront search log (search program P0). One row per (store, Cairo day,
-- NORMALISED term): a counter, not an event log. No user id, session id, IP or user agent
-- is stored; phone/email/ID-shaped terms are dropped before insert (search-log.service.ts).
-- Viewer: admin /stores/[id]/insights/searches + the analytics overview card.
-- Retention: 90 days (search-log-purge-weekly). Store delete CASCADEs.
-- Additive only; small new table, no lock concern. Rollback: DROP TABLE search_query_daily.
CREATE TABLE "search_query_daily" (
  "id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "date" DATE NOT NULL,
  "term" VARCHAR(100) NOT NULL,
  "searches" INTEGER NOT NULL DEFAULT 0,
  "zero_results" INTEGER NOT NULL DEFAULT 0,
  "last_result_count" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "search_query_daily_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "search_query_daily_store_id_date_term_key" ON "search_query_daily"("store_id", "date", "term");
CREATE INDEX "search_query_daily_store_id_date_idx" ON "search_query_daily"("store_id", "date" DESC);
ALTER TABLE "search_query_daily" ADD CONSTRAINT "search_query_daily_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE search_query_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_query_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON search_query_daily AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON search_query_daily TO ebda_app;
```

```prisma
// Storefront search log: one counter row per store, Cairo day and NORMALISED term.
// No shopper identity is stored. Viewer: /stores/[id]/insights/searches. Retention 90 days.
model SearchQueryDaily {
  id              String   @id @default(uuid())
  storeId         String   @map("store_id")
  date            DateTime @db.Date
  term            String   @db.VarChar(100)
  searches        Int      @default(0)
  zeroResults     Int      @default(0) @map("zero_results")
  lastResultCount Int      @default(0) @map("last_result_count")
  updatedAt       DateTime @default(now()) @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, date, term])
  @@index([storeId, date(sort: Desc)])
  @@map("search_query_daily")
}
```

- [ ] **Step 4: Service**

```ts
// apps/api/src/services/search-log.service.ts
import { withStore } from '@ebda/database';
import { normalizeArabicSearch, regionDayStart } from '@ebda/shared';
import logger from '../lib/logger';

export const SEARCH_LOG_RETENTION_DAYS = 90;

/** True for terms that look like a phone, an email or a 14-digit national id: never stored. */
export function isPersonalDataTerm(norm: string): boolean {
  if (/@/.test(norm) && /\.[a-z]{2,}/.test(norm)) return true;
  const digits = norm.replace(/[^0-9]/g, '');
  return digits.length >= 8 && digits.length / norm.replace(/\s/g, '').length > 0.6;
}

/**
 * Count one storefront search (page 1 of a real query). Fail-open: tracking never
 * breaks a search. Runs in its own store scope (withStore) so it is independent of
 * the request transaction; called via cfWaitUntil, after the response.
 */
export async function recordSearch(
  storeId: string,
  rawTerm: string,
  resultCount: number
): Promise<boolean> {
  const term = normalizeArabicSearch(rawTerm).slice(0, 100);
  if (term.length < 2 || isPersonalDataTerm(term)) return false;
  const zero = resultCount === 0 ? 1 : 0;
  const date = regionDayStart(new Date());
  try {
    await withStore(
      storeId,
      tx =>
        tx.$executeRaw`
        INSERT INTO search_query_daily (id, store_id, date, term, searches, zero_results, last_result_count, updated_at)
        VALUES (gen_random_uuid(), ${storeId}, ${date}, ${term}, 1, ${zero}, ${resultCount}, now())
        ON CONFLICT (store_id, date, term) DO UPDATE SET
          searches = search_query_daily.searches + 1,
          zero_results = search_query_daily.zero_results + ${zero},
          last_result_count = ${resultCount},
          updated_at = now()`
    );
    return true;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : 'unknown', storeId },
      '[SEARCH-LOG] skipped'
    );
    return false;
  }
}
```

In `public.routes.ts` list route, right after `const result = await getCached(...)` and before `setEdgeCache`:

```ts
// First-party search log (search program P0): page 1 of a real query only, so paging
// does not double count. After the response; fail-open. Typeahead is NOT logged (keystrokes).
if (effectiveSearch && (!page || page === '1') && !validCursor) {
  const total = (result as { meta?: { total?: number } }).meta?.total ?? 0;
  cfWaitUntil(recordSearch(storeId, effectiveSearch, total));
}
```

Add `import { cfWaitUntil } from '../cf/bindings';` and `import { recordSearch } from '../services/search-log.service';`. Every request reaches the Worker: a Worker response is not stored by the CF CDN, and `s-maxage` is ignored by browsers. So a cached `getCached` hit is still counted, which is intended: it counts searches, not DB reads [i, measured in Step 7].

Retention, in `data-retention.ts`:

```ts
export const searchLogPurge: InngestFunction.Any = inngest.createFunction(
  {
    id: 'search-log-purge-weekly',
    name: 'Purge storefront search log rows older than 90 days',
    retries: 1,
    triggers: [{ cron: '0 5 * * 0' }],
  },
  async ({ step }) => {
    const cutoff = new Date(Date.now() - SEARCH_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const purged = await step.run('purge', async () => {
      let n = 0;
      for (const { value } of await acrossStores(storeId =>
        prisma.searchQueryDaily
          .deleteMany({ where: { storeId, date: { lt: cutoff } } })
          .then(r => r.count)
      ))
        n += value;
      return n;
    });
    logger.info({ cutoff, purged }, 'search-log-purge: completed');
    return { purged };
  }
);
```

Register `searchLogPurge` in `functions/index.ts` next to `abandonedCartPurge`. `docs/RETENTION.md`: add a matrix row (`search_query_daily` | normalised term, counts; no identity; phone/email-shaped terms never stored | 90 days | `search-log-purge-weekly` | legitimate interest, Art. 6(1)(f)) and a cron row (`search-log-purge-weekly` | `0 5 * * 0` | Sun 08:00). Under "Erasure paths", note that the table holds no customer identity, so a customer erasure has nothing to remove, and a store deletion cascades. `docs/privacy/data-map.md`: one row "Storefront search log: first-party, Neon, no identity, 90 d".

- [ ] **Step 5: Integration test**

```ts
// tests/integration/search-log.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';
const { recordSearch } = await import('../../apps/api/src/services/search-log.service');

describe.skipIf(!hasDb)('recordSearch', () => {
  let storeId: string;
  const run = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { email: `sl-${run}@t.local`, role: 'store_admin' },
    });
    storeId = (
      await prisma.store.create({ data: { name: 'sl', slug: `sl-${run}`, ownerId: owner.id } })
    ).id;
  });
  it('aggregates spelling variants into one normalised row and counts zero results', async () => {
    expect(await recordSearch(storeId, 'أحذية', 0)).toBe(true);
    expect(await recordSearch(storeId, 'احذيه', 3)).toBe(true);
    const rows = await prisma.searchQueryDaily.findMany({ where: { storeId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      term: 'احذيه',
      searches: 2,
      zeroResults: 1,
      lastResultCount: 3,
    });
  });
  it('never stores a phone', async () => {
    expect(await recordSearch(storeId, '٠١٠١٢٣٤٥٦٧٨', 0)).toBe(false);
    expect(
      await prisma.searchQueryDaily.count({ where: { storeId, term: { contains: '0101' } } })
    ).toBe(0);
  });
});
```

The RLS proof needs no new test: `tests/integration/rls-ebda-app.test.ts` enumerates every `store_id` table from `information_schema`, so it now covers `search_query_daily` automatically.

- [ ] **Step 6: Run**

Run: `npm run db:generate && npm run gen:tenant-guard-schema -w packages/database && DATABASE_URL=$TEST_DB DIRECT_URL=$TEST_DB npx prisma migrate deploy --schema packages/database/prisma/schema.prisma && npx vitest run tests/unit/search-log-privacy.test.ts tests/unit/tenant-guard-schema-snapshot.test.ts && DATABASE_URL=$TEST_DB npx vitest run tests/integration/search-log.test.ts tests/integration/rls-ebda-app.test.ts`
Expected: PASS

- [ ] **Step 7: Prove the route logs through the real HTTP path**

Run: `npm run dev:api`. In a second shell, run `curl -s "http://localhost:4000/api/v1/public/products?search=%D8%A7%D8%AD%D8%B0%D9%8A%D9%87" -H "x-store-id: <a seeded store id>"` twice. Then `psql $TEST_DB -c "select term, searches from search_query_daily order by updated_at desc limit 1"`.
Expected: `احذيه | 2`. If the API port or prefix differs, read it from `apps/api/src/config` and adjust; record the real one in the PR body.

- [ ] **Step 8: Commit**

```bash
git add packages/database/prisma/migrations/20261018000200_search_query_daily packages/database/prisma/schema.prisma packages/database/src/tenant-guard-schema.generated.ts apps/api/src/services/search-log.service.ts apps/api/src/routes/public.routes.ts apps/api/src/lib/inngest/functions/data-retention.ts apps/api/src/lib/inngest/functions/index.ts docs/RETENTION.md docs/privacy/data-map.md tests/unit/search-log-privacy.test.ts tests/integration/search-log.test.ts
git commit -m "$(cat <<'EOF'
feat(api): privacy-safe storefront search log with 90-day retention

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 6: Admin "What shoppers searched" page + "searches with no results" card

**Files:**

- Create: `apps/api/src/routes/search-insights.routes.ts`; mount in `apps/api/src/routes/index.ts` next to `insightsRoutes` (`router.use('/stores', tenantContext, searchInsightsRoutes);`)
- Create: `packages/shared/src/search/search-insights.ts` (response types; export from `search/index.ts`)
- Create: `apps/admin/src/app/stores/[id]/insights/searches/page.tsx`
- Create: `apps/admin/src/app/stores/[id]/analytics/_components/ZeroResultSearchesCard.tsx`; render in `apps/admin/src/app/stores/[id]/analytics/page.tsx` below `TopProductsTable`
- Modify: `apps/admin/src/components/admin-layout/hubs.ts` (analytics hub tab `insightsSearches`), `apps/admin/src/components/AdminLayout.tsx:~172` (label), i18n `{ar,en}.json` (`hubTabs.insightsSearches`, `insights.searches.*`)
- Test: `tests/integration/search-insights-route.test.ts`, `apps/admin/src/app/stores/[id]/insights/searches/page.test.tsx`

**Interfaces:**

- Consumes: `SearchQueryDaily` (Task 5)
- Produces: `GET /api/v1/stores/:storeId/search-insights?days=7|30|90&filter=zero|all` → `SearchInsightsResponse = { days: number; totals: { searches: number; zeroResultSearches: number; zeroResultRate: number | null }; terms: Array<{ term: string; searches: number; zeroResults: number; lastResultCount: number }> }`. `zeroResultRate` is null when searches = 0 (unknown is never rendered as 0%). Top 50 terms, ordered by `zeroResults desc` (filter=zero) or `searches desc`.

- [ ] **Step 1: Shared types**

```ts
// packages/shared/src/search/search-insights.ts
export type SearchInsightsFilter = 'zero' | 'all';
export interface SearchInsightsTerm {
  term: string;
  searches: number;
  zeroResults: number;
  lastResultCount: number;
}
export interface SearchInsightsResponse {
  days: number;
  totals: { searches: number; zeroResultSearches: number; zeroResultRate: number | null };
  terms: SearchInsightsTerm[];
}
```

- [ ] **Step 2: Write the failing route test**

```ts
// tests/integration/search-insights-route.test.ts
// Builds an express app with the real router mounted as in routes/index.ts, with
// authenticate/authorize/requireStoreAccess mocked the way tests/integration/insights-*.test.ts
// already does (copy that file's vi.mock block verbatim: grep -l "insights.routes" tests/integration).
it('returns zero-result terms first with a null rate when nothing was searched', async () => {
  const empty = await request(app).get(`/api/v1/stores/${emptyStoreId}/search-insights?days=30`);
  expect(empty.status).toBe(200);
  expect(empty.body.data.totals).toEqual({
    searches: 0,
    zeroResultSearches: 0,
    zeroResultRate: null,
  });

  await recordSearch(storeId, 'كوتشي', 0);
  await recordSearch(storeId, 'كوتشي', 0);
  await recordSearch(storeId, 'تيشرت', 5);
  const res = await request(app).get(
    `/api/v1/stores/${storeId}/search-insights?days=30&filter=zero`
  );
  expect(res.body.data.terms).toEqual([
    { term: 'كوتشي', searches: 2, zeroResults: 2, lastResultCount: 0 },
  ]);
  expect(res.body.data.totals.zeroResultRate).toBeCloseTo(2 / 3);
});
it('rejects days outside 7|30|90', async () => {
  expect(
    (await request(app).get(`/api/v1/stores/${storeId}/search-insights?days=400`)).status
  ).toBe(400);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/search-insights-route.test.ts`
Expected: FAIL (404 on the route).

- [ ] **Step 4: Implement the route**

```ts
// apps/api/src/routes/search-insights.routes.ts
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '@ebda/database';
import { regionDayStart, type SearchInsightsResponse } from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { requireMfaEnrolled } from '../middleware/mfa';
import { AppError } from '../middleware/error-handler';

const router = Router();
const query = z.object({
  days: z.enum(['7', '30', '90']).default('30'),
  filter: z.enum(['zero', 'all']).default('zero'),
});

router.get(
  '/:storeId/search-insights',
  authenticate,
  requireMfaEnrolled,
  authorize('store_admin', 'super_admin'),
  requireStoreAccess,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = query.safeParse(req.query);
      if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'days must be 7, 30 or 90');
      const storeId = req.params.storeId;
      const days = Number(parsed.data.days);
      const since = regionDayStart(new Date(Date.now() - (days - 1) * 86_400_000));
      const where = { storeId, date: { gte: since } };
      const [agg, grouped] = await Promise.all([
        prisma.searchQueryDaily.aggregate({ where, _sum: { searches: true, zeroResults: true } }),
        prisma.searchQueryDaily.groupBy({
          by: ['term'],
          where: parsed.data.filter === 'zero' ? { ...where, zeroResults: { gt: 0 } } : where,
          _sum: { searches: true, zeroResults: true },
          _max: { lastResultCount: true },
          orderBy:
            parsed.data.filter === 'zero'
              ? { _sum: { zeroResults: 'desc' } }
              : { _sum: { searches: 'desc' } },
          take: 50,
        }),
      ]);
      const searches = agg._sum.searches ?? 0;
      const zero = agg._sum.zeroResults ?? 0;
      const data: SearchInsightsResponse = {
        days,
        totals: {
          searches,
          zeroResultSearches: zero,
          zeroResultRate: searches === 0 ? null : zero / searches,
        },
        terms: grouped.map(g => ({
          term: g.term,
          searches: g._sum.searches ?? 0,
          zeroResults: g._sum.zeroResults ?? 0,
          lastResultCount: g._max.lastResultCount ?? 0,
        })),
      };
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);
export default router;
```

Check the real import path of `requireMfaEnrolled` with `grep -n "requireMfaEnrolled" apps/api/src/routes/insights.routes.ts | head -1` and copy that import line exactly. No analytics-tier gate: this is a core search tool (Ruling SEARCH-5).

- [ ] **Step 5: Admin page + card**

The page follows `insights/products/page.tsx` (same `AdminLayout`, `useT`, `apiGet`, `DataTable`, `ErrorState`, spinner). It adds a 7/30/90 segmented control and a "no results only / all" toggle. It has three columns: term (`dir="auto"`), searches, no-result searches. Each zero-result row gets an action link "أضف كلمة بحث لمنتج", which opens `/stores/${storeId}/products?search=` with the term. The empty state reads `t('empty')`. The totals line shows `zeroResultRate === null ? '—' : percent`.

```tsx
// apps/admin/src/app/stores/[id]/analytics/_components/ZeroResultSearchesCard.tsx
'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet } from '@/lib/api';
import { useT } from '@/i18n/useT';
import type { SearchInsightsResponse } from '@ebda/shared';

export function ZeroResultSearchesCard({ storeId }: { storeId: string }) {
  const t = useT('insights.searches');
  const [data, setData] = useState<SearchInsightsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    apiGet<SearchInsightsResponse>(`/api/v1/stores/${storeId}/search-insights?days=7&filter=zero`)
      .then(({ data: d, error }) => (error ? setFailed(true) : setData(d ?? null)))
      .catch(() => setFailed(true));
  }, [storeId]);
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{t('cardTitle')}</h2>
        <Link href={`/stores/${storeId}/insights/searches`} className="text-xs text-primary">
          {t('viewAll')}
        </Link>
      </div>
      {failed ? (
        <p className="mt-3 text-xs text-muted-foreground">{t('loadFailed')}</p>
      ) : !data ? (
        <div className="mt-3 h-16 animate-pulse rounded bg-muted" />
      ) : data.terms.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{t('cardEmpty')}</p>
      ) : (
        <ul className="mt-3 space-y-1">
          {data.terms.slice(0, 5).map(r => (
            <li key={r.term} className="flex justify-between text-sm">
              <span dir="auto">{r.term}</span>
              <span className="text-muted-foreground tabular-nums">{r.zeroResults}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

`hubs.ts`: add `insightsSearches: string;` to the labels type and `{ label: labels.insightsSearches, href: \`/stores/${storeId}/insights/searches\` }`after`insightsProducts`. `AdminLayout.tsx`: add `insightsSearches: t('hubTabs.insightsSearches'),`.

i18n (ar shown; en mirrors it):
`hubTabs.insightsSearches`: "عمليات البحث" / "Searches". `insights.searches`: `title` "العملاء بيدوروا على إيه" / "What shoppers searched", `cardTitle` "عمليات بحث من غير نتايج (آخر 7 أيام)" / "Searches with no results (last 7 days)", `viewAll` "عرض الكل" / "View all", `cardEmpty` "مفيش عمليات بحث من غير نتايج" / "No searches without results", `empty` "لسه مفيش عمليات بحث متسجلة" / "No searches recorded yet", `term` "الكلمة" / "Term", `searches` "مرات البحث" / "Searches", `zeroResults` "من غير نتايج" / "No results", `addTerm` "أضف كلمة بحث لمنتج" / "Add as a product search word", `onlyZero` "من غير نتايج بس" / "No results only", `all` "الكل" / "All", `rate` "نسبة البحث من غير نتايج" / "No-result rate", `loadFailed` "تعذر التحميل" / "Could not load".

Page test (render with mocked `apiGet`, matching the existing `CashflowChart.test.tsx` setup): it asserts that `'كوتشي'` renders, and that the rate renders `—` when `zeroResultRate` is null.

- [ ] **Step 6: Run**

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/search-insights-route.test.ts && npx vitest run "apps/admin/src/app/stores/[id]/insights/searches" tests/unit/admin-i18n-key-parity.test.ts tests/unit/admin-i18n-keys-resolve.test.ts && npm run typecheck && npm run lint`
Expected: PASS

- [ ] **Step 7: Drive the UI (not just compile)**

Run `npm run dev:api` and `npm run dev:admin`. Sign in as a seeded merchant with the admin in Arabic. Open `/stores/<id>/analytics`: the card renders. Open `/stores/<id>/insights/searches`: rows render RTL. Take screenshots in Arabic at desktop and 390 px and attach both to the PR.
Expected: the rows created in Step 7 of Task 5 are visible.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/search-insights.routes.ts apps/api/src/routes/index.ts packages/shared/src/search "apps/admin/src/app/stores/[id]/insights/searches" "apps/admin/src/app/stores/[id]/analytics/_components/ZeroResultSearchesCard.tsx" "apps/admin/src/app/stores/[id]/analytics/page.tsx" apps/admin/src/components/admin-layout/hubs.ts apps/admin/src/components/AdminLayout.tsx apps/admin/src/i18n/messages/ar.json apps/admin/src/i18n/messages/en.json tests/integration/search-insights-route.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): searches page and no-result searches card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 7: P0 rulings, docs, PR 1

**Files:** `docs/RULINGS.md` (append SEARCH-1..SEARCH-6 from the end of this plan), `ROADMAP.md` (one line under search).

- [ ] **Step 1:** Append the P0 rulings verbatim from "Rulings + assumptions" below.
- [ ] **Step 2: Blast-radius sweep.** Run `grep -rn "buildProductSearchAnd\|search_terms\|searchTerms\|search_query_daily\|ebda_ar_norm" apps packages tests docs scripts .github`. Every hit must be intended. State the result in the PR body (`blast-radius: swept … → clean`).
- [ ] **Step 3: Full local gate.** Run `npm run lint && npm run typecheck && npm run test:unit && DATABASE_URL=$TEST_DB npm run test:integration`. Expected: exit 0.
- [ ] **Step 4: Commit + open PR 1.**

```bash
git add docs/RULINGS.md ROADMAP.md
git commit -m "$(cat <<'EOF'
docs(product): search program p0 rulings

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

**PR 1 boundary.** Merge → **STOP-1** (pre-build the two expression indexes CONCURRENTLY on production before `cf-api-deploy.yml` runs the migration) → deploy. After the deploy: check that `/health` reports the merge commit, search an Arabic store with `احذيه` in the Arabic locale, and confirm the search log row is written (read-only SELECT by Ahmad). Collect the zero-result rate for 14 days. That number decides how P1 is prioritised, not whether P1 ships (Ahmad: "do the whole thing").

---

# PHASE P1: AI search terms, embeddings, hybrid ranking

## PR 2 (`feat/search-p1a-terms`)

## Task 8: AI-generated search terms through the autofill engine

**Files:**

- Create: `apps/api/src/lib/ai/product-search-terms-generator.ts`
- Modify: `packages/shared/src/types/ai-autofill.ts` (`AI_AUTOFILL_FIELDS` + 1 entry)
- Modify: `apps/api/src/services/ai.service.ts:59` (`Feature` union + `'search-terms'`)
- Modify: `apps/api/src/services/ai-autofill.service.ts` (`fillProductFields`: new block before the categorize block)
- Modify: `apps/admin/src/app/stores/[id]/products/[productId]/edit/page.tsx` (`<AiFieldBadge field="searchTerms" sources={aiSources} />` beside the Task 4 label)
- Modify: `apps/admin/src/app/stores/[id]/products/[productId]/edit/_components/AiFieldBadge.coverage.test.ts` (`searchTerms` in the covered list)
- Test: `tests/unit/product-search-terms-generator.test.ts`, `tests/unit/ai-autofill-search-terms.test.ts`, `packages/shared/src/types/__tests__/ai-autofill.test.ts` (extend)

**Interfaces:**

- Consumes: `cleanSearchTerms` (Task 4), `assertAiQuota`, `recordUsage`, `GeminiFailoverClient`, `parseAiJson`, `rethrowAsAppError`
- Produces: `generateProductSearchTerms(input: { storeId: string; storeName: string; product: { name: string; nameAr?: string | null; description?: string | null; descriptionAr?: string | null }; categoryNames: string[] }, apiKey: string, modelName: string): Promise<string | null>`, `buildSearchTermsPrompt(input): string`. Autofill field `searchTerms` with sources `['name','nameAr','description','descriptionAr']`.

- [ ] **Step 1: Write the failing generator test**

```ts
// tests/unit/product-search-terms-generator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateContent = vi.fn();
vi.mock('../../apps/api/src/lib/ai/gemini-keys', () => ({
  GeminiFailoverClient: vi.fn(() => ({ getGenerativeModel: () => ({ generateContent }) })),
}));
const recordUsage = vi.fn(async () => undefined);
vi.mock('../../apps/api/src/services/ai.service', () => ({ recordUsage }));
const assertAiQuota = vi.fn(async () => undefined);
vi.mock('../../apps/api/src/lib/ai-quota', () => ({
  assertAiQuota,
  isAiQuotaCapError: () => false,
}));

const { generateProductSearchTerms, buildSearchTermsPrompt } =
  await import('../../apps/api/src/lib/ai/product-search-terms-generator');
const input = {
  storeId: 's1',
  storeName: 'متجر',
  product: { name: 'Black abaya', nameAr: 'عباية سوداء', description: null, descriptionAr: null },
  categoryNames: ['ملابس حريمي'],
};

describe('generateProductSearchTerms', () => {
  beforeEach(() => {
    generateContent.mockReset();
    recordUsage.mockClear();
    assertAiQuota.mockClear();
  });

  it('prompt asks for Egyptian dialect, Franco-Arabic and English and forbids brand invention', () => {
    const p = buildSearchTermsPrompt(input);
    expect(p).toMatch(/Egyptian/);
    expect(p).toMatch(/Franco/);
    expect(p).toMatch(/3abaya/);
    expect(p).toMatch(/Do not invent brand/);
  });

  it('checks bulk quota, records usage, returns cleaned comma list', async () => {
    generateContent.mockResolvedValue({
      response: {
        text: () => '{"terms":["عبايه","3abaya","abaya","عباية","",  "خمار"]}',
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 },
      },
    });
    const out = await generateProductSearchTerms(input, 'k', 'gemini-flash-lite-latest');
    expect(assertAiQuota).toHaveBeenCalledWith({ storeId: 's1', bulk: true });
    expect(recordUsage).toHaveBeenCalledWith('s1', 'search-terms', 50, 20, false, {
      model: 'gemini-flash-lite-latest',
    });
    expect(out).toBe('عبايه, 3abaya, abaya, خمار'); // عباية folds onto عبايه → deduped
  });

  it('returns null on an unexpected shape', async () => {
    generateContent.mockResolvedValue({ response: { text: () => 'nope', usageMetadata: {} } });
    expect(await generateProductSearchTerms(input, 'k', 'm')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/product-search-terms-generator.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the generator**

```ts
// apps/api/src/lib/ai/product-search-terms-generator.ts
/**
 * Search words for a product: how Egyptian shoppers actually type it (dialect,
 * Franco-Arabic, common misspellings, English). Written into products.search_terms
 * through the autofill engine (field 'searchTerms'); never overwrites a merchant's
 * own words ('human' provenance). Bulk-quota: runs from Inngest only.
 */
import { cleanSearchTerms } from '@ebda/shared';
import { GeminiFailoverClient } from './gemini-keys';
import { parseAiJson } from './parse-ai-json';
import { rethrowAsAppError } from './gemini-errors';
import { recordUsage } from '../../services/ai.service';
import { assertAiQuota } from '../ai-quota';

export interface SearchTermsInput {
  storeId: string;
  storeName: string;
  product: {
    name: string;
    nameAr?: string | null;
    description?: string | null;
    descriptionAr?: string | null;
  };
  categoryNames: string[];
}

export function buildSearchTermsPrompt(i: SearchTermsInput): string {
  const desc = (i.product.descriptionAr || i.product.description || '').slice(0, 600);
  return `You write SEARCH WORDS for a product in an Egyptian online store called ${i.storeName}.
Shoppers in Egypt search in Egyptian Arabic dialect, in Franco-Arabic (Arabic in Latin letters with
digits, e.g. "3abaya", "gazma", "kotshy", "shanta"), with dropped hamza / ta marbuta written as ha,
and in English.

Product (English name): ${i.product.name || '(none)'}
Product (Arabic name): ${i.product.nameAr || '(none)'}
Categories: ${i.categoryNames.join(', ') || '(none)'}
Description: ${desc || '(none)'}

Return 8 to 20 short terms a shopper would TYPE to find this exact product: Egyptian dialect words,
Franco-Arabic spellings, common misspellings, and plain English words. Synonyms of the product type
are good. Do not invent brand names, sizes, colours or materials that are not in the product data.
Do not repeat the product name verbatim.

Return ONLY valid JSON: { "terms": ["...", "..."] }`;
}

export async function generateProductSearchTerms(
  input: SearchTermsInput,
  apiKey: string,
  modelName: string
): Promise<string | null> {
  await assertAiQuota({ storeId: input.storeId, bulk: true });
  const model = new GeminiFailoverClient(apiKey).getGenerativeModel({ model: modelName });
  let result;
  try {
    result = await model.generateContent(buildSearchTermsPrompt(input));
  } catch (err) {
    rethrowAsAppError(err, 'AI search terms failed');
  }
  const usage = result.response.usageMetadata;
  await recordUsage(
    input.storeId,
    'search-terms',
    usage?.promptTokenCount ?? 0,
    usage?.candidatesTokenCount ?? 0,
    false,
    { model: modelName }
  );
  const parsed = parseAiJson<{ terms?: unknown }>(result.response.text());
  if (!parsed || !Array.isArray(parsed.terms)) return null;
  return cleanSearchTerms(parsed.terms.filter((t): t is string => typeof t === 'string').join(','));
}
```

`ai.service.ts` `Feature` union: add `| 'search-terms'`.

- [ ] **Step 4: Register the field + fill block (failing tests first)**

Extend `packages/shared/src/types/__tests__/ai-autofill.test.ts`:

```ts
it('searchTerms refreshes when either language name or description changes, never when human', () => {
  expect(fieldsNeedingRefresh({ searchTerms: 'ai' }, ['nameAr'])).toContain('searchTerms');
  expect(fieldsNeedingRefresh({ searchTerms: 'human' }, ['nameAr'])).not.toContain('searchTerms');
});
```

```ts
// tests/unit/ai-autofill-search-terms.test.ts — mock prisma + AIService like the existing
// tests/unit/ai-autofill*.test.ts (grep -l fillProductFields tests/unit, copy its mock block), plus:
vi.mock('../../apps/api/src/lib/ai/product-search-terms-generator', () => ({
  generateProductSearchTerms: vi.fn(async () => 'جزمه, gazma, shoes'),
}));
it('fills empty searchTerms and stamps it ai', async () => {
  productRow = { ...baseProduct, searchTerms: null, aiFieldSources: {} };
  await fillProductFields('s1', 'p1', { op: 'create' });
  expect(updateSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        searchTerms: 'جزمه, gazma, shoes',
        aiFieldSources: expect.objectContaining({ searchTerms: 'ai' }),
      }),
    })
  );
});
it('never overwrites merchant words', async () => {
  productRow = { ...baseProduct, searchTerms: 'كوتشي', aiFieldSources: { searchTerms: 'human' } };
  await fillProductFields('s1', 'p1', { op: 'update', changedFields: ['nameAr'] });
  expect(generateProductSearchTerms).not.toHaveBeenCalled();
});
```

Run `npx vitest run packages/shared/src/types/__tests__/ai-autofill.test.ts tests/unit/ai-autofill-search-terms.test.ts`. Expected: FAIL.

Then, in `ai-autofill.ts` `AI_AUTOFILL_FIELDS`, append:

```ts
  // Search words (dialect / Franco / EN) — derive from content in EITHER language. Search program P1.
  { field: 'searchTerms', sources: ['name', 'nameAr', 'description', 'descriptionAr'] },
```

In `fillProductFields`, before `// Categorize ONLY when…`:

```ts
if (canWrite('searchTerms', product.searchTerms) && (effName?.trim() || effNameAr?.trim())) {
  const catNames = product.categories.length
    ? (
        await prisma.category.findMany({
          where: { storeId, id: { in: product.categories.map(c => c.categoryId) } },
          select: { name: true, nameAr: true },
        })
      ).flatMap(c => [c.nameAr, c.name].filter((v): v is string => !!v))
    : [];
  const terms = await generateProductSearchTerms(
    {
      storeId,
      storeName: store?.nameAr || store?.name || '',
      product: {
        name: effName ?? '',
        nameAr: effNameAr,
        description: effDescription,
        descriptionAr: effDescriptionAr,
      },
      categoryNames: catNames,
    },
    getGeminiApiKey(),
    process.env.GEMINI_MODEL || 'gemini-flash-lite-latest'
  );
  if (terms) {
    writes.searchTerms = terms;
    stampedSources.searchTerms = 'ai';
  }
}
```

`getGeminiApiKey` is whatever accessor `bulk-ai-tags.ts` passes as `apiKey` (it reads `config.gemini…`). Copy that exact expression and import from `bulk-ai-tags.ts`; do not create a new accessor. The block sits inside the existing try, so a quota-cap error is logged as "deferring" and the remaining writes still persist. The 3-day `ai-autofill-sweep` fills `searchTerms` for every existing product with no extra code: that is the backfill for terms. **STOP-4 applies before it runs at scale in production.**

- [ ] **Step 5: Run**

Run: `npx vitest run packages/shared/src/types/__tests__/ai-autofill.test.ts tests/unit/ai-autofill-search-terms.test.ts tests/unit/product-search-terms-generator.test.ts "apps/admin/src/app/stores/[id]/products/[productId]/edit/_components/AiFieldBadge.coverage.test.ts" && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Live prompt check (manual, costs ~10 Gemini calls).** Run `GEMINI_API_KEY=… npx tsx -e "…"` to call `generateProductSearchTerms` on 10 products from `tests/search-eval/catalogue.ts` (Task 13). Paste the outputs into the PR body. Reject the prompt if any output invents a brand or a colour that is not in the product data.

- [ ] **Step 7: Commit (PR 2)**

```bash
git add apps/api/src/lib/ai/product-search-terms-generator.ts packages/shared/src/types/ai-autofill.ts packages/shared/src/types/__tests__/ai-autofill.test.ts apps/api/src/services/ai.service.ts apps/api/src/services/ai-autofill.service.ts "apps/admin/src/app/stores/[id]/products/[productId]/edit/page.tsx" "apps/admin/src/app/stores/[id]/products/[productId]/edit/_components/AiFieldBadge.coverage.test.ts" tests/unit/product-search-terms-generator.test.ts tests/unit/ai-autofill-search-terms.test.ts
git commit -m "$(cat <<'EOF'
feat(product): ai search words in egyptian dialect, franco and english

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

**PR 2 boundary.** No migration. The 3-day autofill sweep backfills terms in production under the existing bulk quota → **STOP-4**.

## PR 3 (`feat/search-p1b-embeddings`)

## Task 9: pgvector in every Postgres + `product_embeddings` table

**Files:**

- Modify: `.github/workflows/ci.yml` (5× `image: postgres:16-alpine` → `image: pgvector/pgvector:0.8.0-pg17`; Ruling SEARCH-T9-4), `.github/workflows/cf-api-deploy.yml:18`, `docker-compose.yml:7`
- Create: `packages/database/prisma/migrations/20261019000100_product_embeddings/migration.sql`
- Modify: `packages/database/prisma/schema.prisma` (model `ProductEmbedding`; back-relations on `Product` and `Store`)
- Test: `tests/integration/product-embeddings-schema.test.ts`

**Interfaces:**

- Produces (SQL): extension `vector`; table `product_embeddings(product_id PK FK→products ON DELETE CASCADE, store_id FK→stores CASCADE, model text, content_hash text, embedding halfvec(1024), embedded_at timestamptz)`; index `(store_id)` and `(store_id, embedded_at)`; `public.ebda_product_embed_doc(name, name_ar, search_terms, description, description_ar) → text` (IMMUTABLE: raw (un-normalised) text, HTML tags stripped, each description capped at 1500 chars). Prisma: `ProductEmbedding { productId, storeId, model, contentHash, embedding Unsupported("halfvec(1024)"), embeddedAt }`.
- Viewer: Task 12 adds "indexed N of M products" to the searches page header.

- [ ] **Step 1: Swap the CI/compose images.** In `ci.yml`, run `sed -i '' 's#image: postgres:16-alpine#image: pgvector/pgvector:0.8.0-pg17#' .github/workflows/ci.yml .github/workflows/cf-api-deploy.yml docker-compose.yml`, then confirm with `grep -n "image: .*postgres\|pgvector" .github/workflows/*.yml docker-compose.yml`: 7 lines, all `pgvector/pgvector:0.8.0-pg17`. The image is Debian-based and includes contrib (pg_trgm, pg_stat_statements). Check that the tag exists: `docker manifest inspect pgvector/pgvector:0.8.0-pg17 >/dev/null && echo ok`, expected `ok`. If that tag is absent, use the newest `0.8.x-pg17` tag listed at hub.docker.com/r/pgvector/pgvector and record it in Ruling SEARCH-7.

- [ ] **Step 2: Write the failing test**

```ts
// tests/integration/product-embeddings-schema.test.ts
import { describe, it, expect } from 'vitest';
import { prisma } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';

describe.skipIf(!hasDb)('product_embeddings', () => {
  it('pgvector supports halfvec and cosine distance', async () => {
    const [r] = await prisma.$queryRaw<
      Array<{ d: number }>
    >`SELECT ('[1,0]'::halfvec(2) <=> '[0,1]'::halfvec(2))::float8 AS d`;
    expect(r.d).toBeCloseTo(1);
  });
  it('is RLS-forced with the strict policy', async () => {
    const [r] = await prisma.$queryRaw<Array<{ f: boolean; p: bigint }>>`
      SELECT c.relforcerowsecurity AS f, (SELECT count(*) FROM pg_policies WHERE tablename='product_embeddings') AS p
      FROM pg_class c WHERE c.relname='product_embeddings'`;
    expect(r.f).toBe(true);
    expect(Number(r.p)).toBe(1);
  });
  it('embed doc strips html, keeps arabic as written, caps description', async () => {
    const long = 'x'.repeat(4000);
    const [r] = await prisma.$queryRaw<Array<{ d: string }>>`
      SELECT public.ebda_product_embed_doc('Shoes', 'أحذية', '3abaya', ${'<p>جلد <b>طبيعي</b></p>'}, ${long}) AS d`;
    expect(r.d).toContain('أحذية');
    expect(r.d).toContain('جلد طبيعي');
    expect(r.d).not.toContain('<b>');
    expect(r.d.length).toBeLessThan(1500 + 200);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `docker rm -f ebda-search-pg; docker run -d --name ebda-search-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=force_test -p 5432:5432 pgvector/pgvector:0.8.0-pg17 && sleep 3 && DATABASE_URL=$TEST_DB DIRECT_URL=$TEST_DB npx prisma migrate deploy --schema packages/database/prisma/schema.prisma && DATABASE_URL=$TEST_DB npx vitest run tests/integration/product-embeddings-schema.test.ts`
Expected: FAIL. The first case fails with `type "halfvec" does not exist`.

- [ ] **Step 4: Migration + model**

```sql
-- 20261019000100_product_embeddings/migration.sql
-- Semantic search vectors (search program P1). One row per product: bge-m3 (1024 dims) embedding of
-- public.ebda_product_embed_doc(...), with md5(content) in content_hash so a stale row is found in SQL.
-- Child of products (ON DELETE CASCADE) and carries store_id, so the strict R-EBDA-001 policy applies
-- and the vector KNN can filter by store with a btree before ranking (exact KNN; no HNSW until a store
-- passes ~20k products — Ruling SEARCH-8).
-- >>> PRODUCTION PREREQUISITE: STOP-2 (Ahmad confirms `vector` >= 0.7 in pg_available_extensions on
-- the production compute, read-only, before this migration is deployed). The neondb_owner migration role
-- can create it on Neon. New table + new function only: no lock on an existing table.
-- Rollback: DROP TABLE product_embeddings; DROP FUNCTION public.ebda_product_embed_doc(text,text,text,text,text);
-- (the extension is left installed).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE OR REPLACE FUNCTION public.ebda_product_embed_doc(
  p_name text, p_name_ar text, p_terms text, p_desc text, p_desc_ar text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT btrim(
    coalesce(p_name_ar, '') || E'\n' || coalesce(p_name, '') || E'\n' || coalesce(p_terms, '') || E'\n' ||
    left(regexp_replace(coalesce(p_desc_ar, ''), '<[^>]*>', '', 'g'), 1500) || E'\n' ||
    left(regexp_replace(coalesce(p_desc, ''), '<[^>]*>', '', 'g'), 1500)
  )
$$;

CREATE TABLE "product_embeddings" (
  "product_id" TEXT NOT NULL,
  "store_id" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "content_hash" TEXT NOT NULL,
  "embedding" halfvec(1024) NOT NULL,
  "embedded_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "product_embeddings_pkey" PRIMARY KEY ("product_id")
);
CREATE INDEX "product_embeddings_store_id_idx" ON "product_embeddings"("store_id");
CREATE INDEX "product_embeddings_store_id_embedded_at_idx" ON "product_embeddings"("store_id", "embedded_at");
ALTER TABLE "product_embeddings" ADD CONSTRAINT "product_embeddings_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "product_embeddings" ADD CONSTRAINT "product_embeddings_store_id_fkey"
  FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE product_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_embeddings FORCE ROW LEVEL SECURITY;
CREATE POLICY ebda_tenant_isolation ON product_embeddings AS PERMISSIVE FOR ALL TO ebda_app
  USING (store_id = nullif(current_setting('app.current_store_id', true), ''))
  WITH CHECK (store_id = nullif(current_setting('app.current_store_id', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON product_embeddings TO ebda_app;
```

```prisma
// Semantic search vector per product (search program P1). Written ONLY by raw SQL in
// product-index.service.ts (Prisma cannot read/write halfvec). CACHE CLASS: BOUNDED-stale content
// index (seconds to minutes after a write); never used for price/stock (read live from products).
model ProductEmbedding {
  productId   String                     @id @map("product_id")
  storeId     String                     @map("store_id")
  model       String
  contentHash String                     @map("content_hash")
  embedding   Unsupported("halfvec(1024)")
  embeddedAt  DateTime                   @default(now()) @map("embedded_at") @db.Timestamptz(6)

  product Product @relation(fields: [productId], references: [id], onDelete: Cascade)
  store   Store   @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([storeId])
  @@index([storeId, embeddedAt])
  @@map("product_embeddings")
}
```

Add `embedding ProductEmbedding?` to `Product` and `productEmbeddings ProductEmbedding[]` to `Store`.

FK sweep (CLAUDE rule): run `psql $TEST_DB -c "select conname, confdeltype from pg_constraint where conrelid='product_embeddings'::regclass and contype='f'"`. Expected: both `c` (cascade). No `NO ACTION` child is added, so the product hard-delete and store-delete paths need no change.

- [ ] **Step 5: Run**

Run: `npm run db:generate && npm run gen:tenant-guard-schema -w packages/database && DATABASE_URL=$TEST_DB DIRECT_URL=$TEST_DB npx prisma migrate deploy --schema packages/database/prisma/schema.prisma && DATABASE_URL=$TEST_DB npx vitest run tests/integration/product-embeddings-schema.test.ts tests/integration/rls-ebda-app.test.ts tests/integration/tenant-guard-ebda-app.test.ts && npx vitest run tests/unit/tenant-guard-schema-snapshot.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/cf-api-deploy.yml docker-compose.yml packages/database/prisma/migrations/20261019000100_product_embeddings packages/database/prisma/schema.prisma packages/database/src/tenant-guard-schema.generated.ts tests/integration/product-embeddings-schema.test.ts
git commit -m "$(cat <<'EOF'
feat(database): pgvector product embeddings under strict rls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 10: Embedding provider (Workers AI binding, REST fallback, null) + wrangler binding

**Files:**

- Create: `apps/api/src/lib/search/embedding-provider.ts`
- Modify: `apps/api/src/cf/bindings.ts` (`AiBindingLike`, `AI?: AiBindingLike` in `CfBindings`)
- Modify: `apps/api/wrangler.jsonc` (`"ai": { "binding": "AI" }` after `services`)
- Modify: `scripts/ci/workerd-smoke.mjs` (boot a copy of the config without the `ai` block)
- Modify: `docs/ENVIRONMENT.md` (`SEARCH_SEMANTIC_ENABLED`, `SEARCH_EMBED_STORE_DAILY_CAP`, `SEARCH_VECTOR_MAX_DISTANCE`, `CF_AI_ACCOUNT_ID`, `CF_AI_API_TOKEN`), `apps/api/.dev.vars.example`, `CLAUDE.md` § Tech stack (one sentence: Workers AI `AI` binding, bge-m3, search only)
- Test: `tests/unit/embedding-provider.test.ts`, `tests/unit/workerd-smoke-config.test.ts`

**Interfaces:**

- Produces: `EMBED_MODEL = '@cf/baai/bge-m3'`, `EMBED_DIMS = 1024`, `interface EmbeddingProvider { model: string; embed(texts: string[]): Promise<number[][]> }`, `getEmbeddingProvider(): EmbeddingProvider | null` (binding, then REST when `CF_AI_ACCOUNT_ID` + `CF_AI_API_TOKEN` are set, else null), `setEmbeddingProviderForTests(p: EmbeddingProvider | null | undefined): void`, `toHalfvecLiteral(v: number[]): string`, `semanticSearchEnabled(): boolean` (`SEARCH_SEMANTIC_ENABLED === 'true'` AND a provider exists).

- [ ] **Step 1: Measure the real output shape (once, manually; costs < $0.0001).** With wrangler logged in to the Ebda account, run `cd apps/api && npx wrangler ai models --json | node -e "const m=JSON.parse(require('fs').readFileSync(0));console.log(JSON.stringify(m.find(x=>x.name==='@cf/baai/bge-m3'),null,1))"`. Then run `curl -s https://api.cloudflare.com/client/v4/accounts/$CF_AI_ACCOUNT_ID/ai/run/@cf/baai/bge-m3 -H "Authorization: Bearer $CF_AI_API_TOKEN" -d '{"text":["أحذية جلد","3abaya"]}' | node -e "const r=JSON.parse(require('fs').readFileSync(0)).result;console.log(r.shape, r.data.length, r.data[0].length)"`.
      Expected: `[ 2, 1024 ] 2 1024`. If the shape key or dims differ, change `EMBED_DIMS`, the migration's `halfvec(1024)` (still unmerged) and this task's parser before continuing, and record the measurement in Ruling SEARCH-7. Without the credentials this is a STOP for Ahmad, and the task continues against the fake provider.

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/embedding-provider.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { setCfBindings, clearCfBindings } from '../../apps/api/src/cf/bindings';
import {
  getEmbeddingProvider,
  toHalfvecLiteral,
  EMBED_DIMS,
  semanticSearchEnabled,
} from '../../apps/api/src/lib/search/embedding-provider';

afterEach(() => {
  clearCfBindings();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const vec = () => Array.from({ length: EMBED_DIMS }, (_, i) => i / EMBED_DIMS);

describe('embedding provider', () => {
  it('uses the AI binding when present', async () => {
    const run = vi.fn(async () => ({ shape: [1, EMBED_DIMS], data: [vec()] }));
    setCfBindings({ HYPERDRIVE: { connectionString: '' }, AI: { run } } as never);
    const out = await getEmbeddingProvider()!.embed(['أحذية']);
    expect(run).toHaveBeenCalledWith('@cf/baai/bge-m3', { text: ['أحذية'] });
    expect(out[0]).toHaveLength(EMBED_DIMS);
  });
  it('rejects a wrong-dimension answer loudly', async () => {
    setCfBindings({
      HYPERDRIVE: { connectionString: '' },
      AI: { run: async () => ({ data: [[1, 2]] }) },
    } as never);
    await expect(getEmbeddingProvider()!.embed(['x'])).rejects.toThrow(/expected 1024/);
  });
  it('falls back to REST when only credentials exist', async () => {
    vi.stubEnv('CF_AI_ACCOUNT_ID', 'acc');
    vi.stubEnv('CF_AI_API_TOKEN', 'tok');
    const f = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, result: { data: [vec()] } }))
      );
    await getEmbeddingProvider()!.embed(['x']);
    expect(String(f.mock.calls[0][0])).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/baai/bge-m3'
    );
  });
  it('null provider and disabled semantic search when nothing is configured', () => {
    expect(getEmbeddingProvider()).toBeNull();
    vi.stubEnv('SEARCH_SEMANTIC_ENABLED', 'true');
    expect(semanticSearchEnabled()).toBe(false);
  });
  it('halfvec literal', () => expect(toHalfvecLiteral([0.5, -1])).toBe('[0.5,-1]'));
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/unit/embedding-provider.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

```ts
// apps/api/src/cf/bindings.ts — add next to the other *Like interfaces
export interface AiBindingLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
// and in CfBindings:
  /** Workers AI (search embeddings, bge-m3). Always remote, also in `wrangler dev`. */
  AI?: AiBindingLike;
```

```ts
// apps/api/src/lib/search/embedding-provider.ts
import { cfBindings } from '../../cf/bindings';

export const EMBED_MODEL = '@cf/baai/bge-m3';
export const EMBED_DIMS = 1024;

export interface EmbeddingProvider {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

function check(data: unknown, n: number): number[][] {
  if (!Array.isArray(data) || data.length !== n)
    throw new Error(`embedding: expected ${n} vectors`);
  for (const v of data) {
    if (!Array.isArray(v) || v.length !== EMBED_DIMS)
      throw new Error(`embedding: expected ${EMBED_DIMS} dims`);
  }
  return data as number[][];
}

const bindingProvider = (): EmbeddingProvider | null => {
  const ai = cfBindings()?.AI;
  if (!ai) return null;
  return {
    model: EMBED_MODEL,
    async embed(texts) {
      const out = (await ai.run(EMBED_MODEL, { text: texts })) as { data?: unknown };
      return check(out?.data, texts.length);
    },
  };
};

const restProvider = (): EmbeddingProvider | null => {
  const acct = process.env.CF_AI_ACCOUNT_ID;
  const token = process.env.CF_AI_API_TOKEN;
  if (!acct || !token) return null;
  return {
    model: EMBED_MODEL,
    async embed(texts) {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${EMBED_MODEL}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: texts }),
        }
      );
      if (!res.ok) throw new Error(`embedding REST ${res.status}`);
      const body = (await res.json()) as { result?: { data?: unknown } };
      return check(body.result?.data, texts.length);
    },
  };
};

let override: EmbeddingProvider | null | undefined;
export function setEmbeddingProviderForTests(p: EmbeddingProvider | null | undefined): void {
  override = p;
}
export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (override !== undefined) return override;
  return bindingProvider() ?? restProvider();
}
export function semanticSearchEnabled(): boolean {
  return process.env.SEARCH_SEMANTIC_ENABLED === 'true' && getEmbeddingProvider() !== null;
}
export function toHalfvecLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}
```

`wrangler.jsonc`, after the `services` line:

```jsonc
  // Workers AI: search embeddings only (@cf/baai/bge-m3, apps/api/src/lib/search/embedding-provider.ts).
  // No id; billed per input token to the account. AI bindings always run remotely, so the
  // workerd smoke (wrangler dev --local) boots a copy WITHOUT this block (scripts/ci/workerd-smoke.mjs).
  "ai": { "binding": "AI" },
```

In `scripts/ci/workerd-smoke.mjs`, right after `const config = arg('config') ?? 'wrangler.jsonc';`, export a pure function and use its output as the config path:

```js
export function stripAiBinding(source) {
  return source.replace(/^\s*"ai":\s*\{\s*"binding":\s*"AI"\s*\},?\s*$/m, '');
}
// … in main():
const smokeConfig = join(apiDir, '.wrangler.smoke.jsonc');
writeFileSync(smokeConfig, stripAiBinding(readFileSync(join(apiDir, config), 'utf8')));
// pass '.wrangler.smoke.jsonc' instead of `config` to `wrangler dev`
```

`apiDir` is the directory the script already `cd`s or `cwd`s into for wrangler (read `:100-115` and reuse that variable). Add `apps/api/.wrangler.smoke.jsonc` to `.gitignore`.

```ts
// tests/unit/workerd-smoke-config.test.ts
import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
const { stripAiBinding } = await import('../../scripts/ci/workerd-smoke.mjs');
it('smoke config has no AI binding but keeps every other binding', () => {
  const src = readFileSync('apps/api/wrangler.jsonc', 'utf8');
  expect(src).toMatch(/"ai":\s*\{\s*"binding":\s*"AI"\s*\}/);
  const out = stripAiBinding(src);
  expect(out).not.toMatch(/"ai":/);
  expect(out).toMatch(/"hyperdrive"/);
  expect(out).toMatch(/"kv_namespaces"/);
});
```

If `workerd-smoke.mjs` runs `main()` on import, guard the call with `if (import.meta.url === \`file://${process.argv[1]}\`)` so the test can import it.

`docs/ENVIRONMENT.md` rows: `SEARCH_SEMANTIC_ENABLED` (default unset = off; `true` turns on the vector leg; prod switch = STOP-3), `SEARCH_EMBED_STORE_DAILY_CAP` (default 3000 product embeddings per store per Cairo day), `SEARCH_VECTOR_MAX_DISTANCE` (default 0.55 cosine distance; tuned by Task 13), `CF_AI_ACCOUNT_ID` + `CF_AI_API_TOKEN` (local/dev REST fallback only; never set on the Worker, which uses the binding). Add the same keys, commented out, to `.dev.vars.example`.

- [ ] **Step 5: Run**

Run: `npx vitest run tests/unit/embedding-provider.test.ts tests/unit/workerd-smoke-config.test.ts && npm run typecheck && SMOKE_PG_PORT=5432 SMOKE_OWNER_DATABASE_URL=postgresql://test:test@localhost:5432/ebda_smoke bash scripts/ci/workerd-smoke.sh`
Expected: unit PASS, and the smoke boots and serves `/health` (create the `ebda_smoke` DB first: `psql $TEST_DB -c 'create database ebda_smoke'`).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/search/embedding-provider.ts apps/api/src/cf/bindings.ts apps/api/wrangler.jsonc scripts/ci/workerd-smoke.mjs .gitignore docs/ENVIRONMENT.md apps/api/.dev.vars.example CLAUDE.md tests/unit/embedding-provider.test.ts tests/unit/workerd-smoke-config.test.ts
git commit -m "$(cat <<'EOF'
feat(api): workers ai embedding provider with rest and null fallbacks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 11: Indexer: stale detection, every write path, backfill + backstop cron

> **Task 9 contract (Ruling SEARCH-T9-1):** `public.ebda_product_embed_doc(...)` returns **NULL** (never `''`) when every part is empty or whitespace-only. Stale detection and the embed loop must skip a NULL doc (no row, or delete an existing row) and never embed or hash `md5('')`. HTML tags become a space, whitespace collapses, each description is capped at 1500 chars.

**Files:**

- Create: `apps/api/src/services/product-index.service.ts`
- Create: `apps/api/src/lib/search/reindex.ts`
- Create: `apps/api/src/lib/inngest/functions/search-product-index.ts`; register both exports in `functions/index.ts`
- Modify (emit `requestStoreReindex` after the write commits): `apps/api/src/services/bulk.service.ts` (after the Phase-4 import transaction, once per store), `apps/api/src/lib/inngest/functions/bulk-ai-translate.ts` (after each batch step that wrote ≥1 product), `apps/api/src/services/ai-autofill.service.ts` (after the `prisma.product.update` at `:271`, `:516`, `:569`), `apps/api/src/routes/ai.routes.ts` (after the hand-back update at `:2044`)
- Test: `tests/integration/product-index.test.ts`, `tests/unit/reindex-write-paths.test.ts`

**Interfaces:**

- Consumes: `getEmbeddingProvider`, `toHalfvecLiteral`, `EMBED_MODEL` (Task 10); `ebda_product_embed_doc` (Task 9); `deferAfterTenantCommit` (`lib/after-tenant-commit.ts`)
- Produces:
  - `findStaleProducts(storeId: string, limit: number): Promise<Array<{ id: string; doc: string; hash: string }>>`
  - `indexStore(storeId: string, opts?: { batchSize?: number; maxDocs?: number }): Promise<{ embedded: number; remaining: boolean; capped: boolean; skipped?: 'no-provider' }>`
  - `storeIndexStatus(storeId: string): Promise<{ products: number; indexed: number; stale: number }>`
  - `requestStoreReindex(storeId: string, reason: string): Promise<void>` (sends `search/store.reindex-requested`, deferred after commit, never throws)
  - Inngest `search-product-index` (triggers `product.upserted` + `search/store.reindex-requested`; debounce 20 s per store; concurrency 1 per store) and `search-index-backstop` (cron `17 */6 * * *`, sends one event per store that has stale rows).

**Write-path enumeration (text-affecting product writes, verified 2026-10-15):**

| #   | Site                                                                                               | Emits today        | After this task                                             |
| --- | -------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------- |
| 1   | `ProductService.create` `product.service.ts:783` (+ MCP `admin-write.tools.ts:116`)                | `product.upserted` | covered by trigger                                          |
| 2   | `ProductService.update` `:982` (+ MCP `:136`)                                                      | `product.upserted` | covered by trigger                                          |
| 3   | bulk import create/update `bulk.service.ts:1026,1049`                                              | nothing            | `requestStoreReindex(storeId,'bulk-import')`                |
| 4   | `bulk-ai-translate.ts:267`                                                                         | nothing            | `requestStoreReindex(storeId,'bulk-ai-translate')`          |
| 5   | autofill fill `ai-autofill.service.ts:271` (writes name/nameAr/description\*/searchTerms)          | nothing            | `requestStoreReindex(storeId,'ai-autofill')`                |
| 6   | balance `:516` / revert `:569`                                                                     | nothing            | `requestStoreReindex(storeId,'ai-balance')`                 |
| 7   | hand-back clear `ai.routes.ts:2044`                                                                | nothing            | `requestStoreReindex(storeId,'ai-handback')`                |
| 8   | soft delete `product.service.ts:1088`, bulk delete `bulk.service.ts:1306`                          | —                  | none needed: query joins `deleted_at IS NULL`               |
| 9   | status/price/inventory/flags (`bulkUpdate`, inventory, accounting, refunds, variant `hasVariants`) | —                  | none: not in the embed doc                                  |
| 10  | variant writes (`variant.service.ts`)                                                              | —                  | none: option values are not in the doc (Ruling SEARCH-9)    |
| —   | any path missed above                                                                              | —                  | `search-index-backstop` finds it by content hash within 6 h |

- [ ] **Step 1: Write the failing integration test (fake provider, real DB)**

```ts
// tests/integration/product-index.test.ts
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { prisma, runInStoreScope } from '@ebda/database';
import { hasDb } from '../helpers/bundle-fixtures';
const { setEmbeddingProviderForTests, EMBED_DIMS } =
  await import('../../apps/api/src/lib/search/embedding-provider');
const { indexStore, findStaleProducts, storeIndexStatus } =
  await import('../../apps/api/src/services/product-index.service');

/** Deterministic fake: same text → same vector; counts calls. */
export function fakeProvider() {
  const calls: string[][] = [];
  return {
    calls,
    provider: {
      model: '@cf/baai/bge-m3',
      async embed(texts: string[]) {
        calls.push(texts);
        return texts.map(t => {
          const h = createHash('sha256').update(t).digest();
          return Array.from({ length: EMBED_DIMS }, (_, i) => (h[i % 32] - 128) / 128);
        });
      },
    },
  };
}

describe.skipIf(!hasDb)('indexStore', () => {
  let storeId: string;
  let pid: string;
  const run = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { email: `ix-${run}@t.local`, role: 'store_admin' },
    });
    storeId = (
      await prisma.store.create({ data: { name: 'ix', slug: `ix-${run}`, ownerId: owner.id } })
    ).id;
    pid = (
      await prisma.product.create({
        data: { storeId, slug: `p-${run}`, name: 'Shoes', nameAr: 'أحذية', price: 100 },
      })
    ).id;
  });
  afterEach(() => setEmbeddingProviderForTests(undefined));

  it('embeds stale products once, then is a no-op until the text changes', async () => {
    const f = fakeProvider();
    setEmbeddingProviderForTests(f.provider);
    expect((await runInStoreScope(storeId, () => indexStore(storeId))).embedded).toBe(1);
    expect((await runInStoreScope(storeId, () => indexStore(storeId))).embedded).toBe(0);
    await prisma.product.update({ where: { id: pid }, data: { searchTerms: 'gazma' } });
    expect(await runInStoreScope(storeId, () => findStaleProducts(storeId, 10))).toHaveLength(1);
    expect((await runInStoreScope(storeId, () => indexStore(storeId))).embedded).toBe(1);
    expect(f.calls.flat().some(t => t.includes('gazma'))).toBe(true);
  });
  it('honours the per-store daily cap', async () => {
    process.env.SEARCH_EMBED_STORE_DAILY_CAP = '0';
    await prisma.product.update({ where: { id: pid }, data: { searchTerms: 'kotshy' } });
    setEmbeddingProviderForTests(fakeProvider().provider);
    const r = await runInStoreScope(storeId, () => indexStore(storeId));
    expect(r).toMatchObject({ embedded: 0, capped: true });
    delete process.env.SEARCH_EMBED_STORE_DAILY_CAP;
  });
  it('no provider → skipped, nothing written, no throw', async () => {
    setEmbeddingProviderForTests(null);
    expect(await runInStoreScope(storeId, () => indexStore(storeId))).toMatchObject({
      skipped: 'no-provider',
    });
  });
  it('status counts', async () => {
    setEmbeddingProviderForTests(fakeProvider().provider);
    await runInStoreScope(storeId, () => indexStore(storeId));
    expect(await runInStoreScope(storeId, () => storeIndexStatus(storeId))).toEqual({
      products: 1,
      indexed: 1,
      stale: 0,
    });
  });
  it('hard delete cascades the embedding', async () => {
    await prisma.product.delete({ where: { id: pid } });
    expect(
      await prisma.$queryRaw<unknown[]>`SELECT 1 FROM product_embeddings WHERE product_id = ${pid}`
    ).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/product-index.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the service**

```ts
// apps/api/src/services/product-index.service.ts
import { prisma } from '@ebda/database';
import { regionDayStart } from '@ebda/shared';
import {
  getEmbeddingProvider,
  toHalfvecLiteral,
  EMBED_MODEL,
} from '../lib/search/embedding-provider';
import logger from '../lib/logger';

const DOC = `public.ebda_product_embed_doc(p.name, p.name_ar, p.search_terms, p.description, p.description_ar)`;
const dailyCap = () => parseInt(process.env.SEARCH_EMBED_STORE_DAILY_CAP ?? '3000', 10);

/** Non-deleted products whose embedding is missing, from another model, or for older text. */
export async function findStaleProducts(storeId: string, limit: number) {
  return prisma.$queryRawUnsafe<Array<{ id: string; doc: string; hash: string }>>(
    `SELECT p.id, ${DOC} AS doc, md5(${DOC}) AS hash
       FROM products p LEFT JOIN product_embeddings e ON e.product_id = p.id
      WHERE p.store_id = $1 AND p.deleted_at IS NULL AND length(${DOC}) > 0
        AND (e.product_id IS NULL OR e.model <> $2 OR e.content_hash <> md5(${DOC}))
      ORDER BY p.updated_at DESC LIMIT $3`,
    storeId,
    EMBED_MODEL,
    limit
  );
}

export async function storeIndexStatus(storeId: string) {
  const [r] = await prisma.$queryRawUnsafe<
    Array<{ products: bigint; indexed: bigint; stale: bigint }>
  >(
    `SELECT count(*) AS products,
            count(e.product_id) AS indexed,
            count(*) FILTER (WHERE e.product_id IS NULL OR e.model <> $2 OR e.content_hash <> md5(${DOC})) AS stale
       FROM products p LEFT JOIN product_embeddings e ON e.product_id = p.id
      WHERE p.store_id = $1 AND p.deleted_at IS NULL`,
    storeId,
    EMBED_MODEL
  );
  return { products: Number(r.products), indexed: Number(r.indexed), stale: Number(r.stale) };
}

/**
 * Embed this store's stale products in batches (bge-m3 takes a text array). Runs in a store
 * scope (runInStoreScope): every statement is its own transaction, never one held across the
 * Workers AI call. Daily per-store cap counted from product_embeddings.embedded_at.
 */
export async function indexStore(
  storeId: string,
  opts: { batchSize?: number; maxDocs?: number } = {}
) {
  const provider = getEmbeddingProvider();
  if (!provider)
    return { embedded: 0, remaining: false, capped: false, skipped: 'no-provider' as const };
  const since = regionDayStart(new Date());
  const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM product_embeddings WHERE store_id = ${storeId} AND embedded_at >= ${since}`;
  const budget = Math.max(0, Math.min(opts.maxDocs ?? 500, dailyCap() - Number(n)));
  if (budget === 0) return { embedded: 0, remaining: true, capped: true };
  const batchSize = opts.batchSize ?? 25;
  let embedded = 0;
  while (embedded < budget) {
    const stale = await findStaleProducts(storeId, Math.min(batchSize, budget - embedded));
    if (stale.length === 0) return { embedded, remaining: false, capped: false };
    const vectors = await provider.embed(stale.map(s => s.doc));
    for (let i = 0; i < stale.length; i++) {
      await prisma.$executeRaw`
        INSERT INTO product_embeddings (product_id, store_id, model, content_hash, embedding, embedded_at)
        VALUES (${stale[i].id}, ${storeId}, ${provider.model}, ${stale[i].hash},
                ${toHalfvecLiteral(vectors[i])}::halfvec(1024), now())
        ON CONFLICT (product_id) DO UPDATE SET model = EXCLUDED.model, content_hash = EXCLUDED.content_hash,
          embedding = EXCLUDED.embedding, embedded_at = now()`;
    }
    embedded += stale.length;
  }
  logger.info({ storeId, embedded }, '[search-index] budget used');
  return { embedded, remaining: true, capped: embedded >= budget };
}
```

```ts
// apps/api/src/lib/search/reindex.ts
import { inngest } from '../inngest/client';
import { deferAfterTenantCommit } from '../after-tenant-commit';
import logger from '../logger';

/** Ask the indexer to look at this store. Deferred past the tenant COMMIT; never throws. */
export async function requestStoreReindex(storeId: string, reason: string): Promise<void> {
  await deferAfterTenantCommit(async () => {
    try {
      await inngest.send({ name: 'search/store.reindex-requested', data: { storeId, reason } });
    } catch (err) {
      // Not a lost write: search-index-backstop finds stale rows by content hash within 6 h.
      logger.warn(
        { err, storeId, reason },
        '[search-index] enqueue failed; backstop will catch it'
      );
    }
  });
}
```

Before writing this, read the signature of `deferAfterTenantCommit` in `apps/api/src/lib/after-tenant-commit.ts`. If it takes a task function and returns `void`, drop the `await`. `enqueueRecommendationsSweepForNewProduct` in `ai-autofill.service.ts:660` is the in-repo example of its use.

```ts
// apps/api/src/lib/inngest/functions/search-product-index.ts
import type { InngestFunction } from 'inngest';
import { runInStoreScope, acrossStores } from '@ebda/database';
import { inngest } from '../client';
import { indexStore, findStaleProducts } from '../../../services/product-index.service';
import { getEmbeddingProvider } from '../../search/embedding-provider';
import logger from '../../logger';

export const searchProductIndex: InngestFunction.Any = inngest.createFunction(
  {
    id: 'search-product-index',
    name: 'Search: embed stale products for a store',
    concurrency: { key: 'event.data.storeId', limit: 1 },
    debounce: { key: 'event.data.storeId', period: '20s' },
    retries: 3,
    triggers: [
      { event: 'product.upserted' as any },
      { event: 'search/store.reindex-requested' as any },
    ],
  },
  async ({ event, step }) => {
    const { storeId } = event.data as { storeId?: string };
    if (!storeId) return { skipped: 'missing-store' };
    let more = true;
    let round = 0;
    while (more && round < 20) {
      const r = await step.run(`index-${round}`, () =>
        runInStoreScope(storeId, () => indexStore(storeId))
      );
      more = r.remaining && !r.capped && !r.skipped;
      round++;
    }
    return { rounds: round };
  }
);

export const searchIndexBackstop: InngestFunction.Any = inngest.createFunction(
  {
    id: 'search-index-backstop',
    name: 'Search: find stores with stale embeddings',
    retries: 1,
    triggers: [{ cron: '17 */6 * * *' }],
  },
  async ({ step }) => {
    if (!getEmbeddingProvider()) return { skipped: 'no-provider' };
    const stores = await step.run('find', async () =>
      (await acrossStores(id => findStaleProducts(id, 1).then(r => r.length > 0)))
        .filter(s => s.value)
        .map(s => s.storeId)
    );
    if (stores.length) {
      await step.sendEvent(
        'fan-out',
        stores.map(storeId => ({
          name: 'search/store.reindex-requested',
          data: { storeId, reason: 'backstop' },
        }))
      );
    }
    logger.info({ stores: stores.length }, '[search-index-backstop] done');
    return { stores: stores.length };
  }
);
```

This is the **backfill**: the first backstop run after deploy finds every store whose products have no embedding and fans out to them, under the per-store daily cap. Nothing extra is needed. **STOP-4** applies because it embeds the production catalogue.

Insert the seven `await requestStoreReindex(storeId, '<reason>')` calls at the write-path table rows 3-7. In `bulk-ai-translate.ts`, call it inside the batch `step.run` after the writes, guarded by `if (written > 0)`; that function runs under `runInStoreScope`, so `deferAfterTenantCommit` runs immediately (verify in that file and note it in the commit body).

- [ ] **Step 4: Guard test so a new text writer cannot forget the reindex**

```ts
// tests/unit/reindex-write-paths.test.ts
import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
/** Every file that writes product TEXT outside ProductService.create/update must request a reindex.
 *  Adding a new writer to this list without a requestStoreReindex call fails here. */
const WRITERS = [
  'apps/api/src/services/bulk.service.ts',
  'apps/api/src/lib/inngest/functions/bulk-ai-translate.ts',
  'apps/api/src/services/ai-autofill.service.ts',
  'apps/api/src/routes/ai.routes.ts',
];
it.each(WRITERS)('%s requests a reindex', f => {
  expect(readFileSync(f, 'utf8')).toMatch(/requestStoreReindex\(/);
});
it('no other file writes name/nameAr/description/descriptionAr/searchTerms on product', () => {
  const { execSync } = require('node:child_process') as typeof import('node:child_process');
  const hits = execSync(
    `grep -rlE "product\\.(update|updateMany|create|upsert)\\(" apps/api/src --include=*.ts | xargs grep -lE "(name|nameAr|description|descriptionAr|searchTerms)\\s*:" || true`,
    { encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean)
    .filter(f => !f.includes('__tests__'));
  const allowed = new Set([...WRITERS, 'apps/api/src/services/product.service.ts']);
  expect(hits.filter(h => !allowed.has(h))).toEqual([]);
});
```

If the second case lists a real file, apply rule C (fix the class): add the reindex call there and add the file to `WRITERS`. If a hit is a false positive (the file writes no product text), add it to `allowed` with a one-line comment saying why.

- [ ] **Step 5: Run**

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/product-index.test.ts && npx vitest run tests/unit/reindex-write-paths.test.ts tests/unit && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit (PR 3)**

```bash
git add apps/api/src/services/product-index.service.ts apps/api/src/lib/search/reindex.ts apps/api/src/lib/inngest/functions/search-product-index.ts apps/api/src/lib/inngest/functions/index.ts apps/api/src/services/bulk.service.ts apps/api/src/lib/inngest/functions/bulk-ai-translate.ts apps/api/src/services/ai-autofill.service.ts apps/api/src/routes/ai.routes.ts tests/integration/product-index.test.ts tests/unit/reindex-write-paths.test.ts
git commit -m "$(cat <<'EOF'
feat(api): product embedding indexer on every text write path with backstop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

**PR 3 boundary.** Merge → **STOP-2** (pgvector on production) and **STOP-3** (Workers AI binding and billing) → deploy. `SEARCH_SEMANTIC_ENABLED` stays unset, so the vector leg is off. The indexer runs only once the binding exists → **STOP-4** (backfill).

## PR 4 (`feat/search-p1c-hybrid`)

## Task 12: Hybrid ranking (lexical + vector RRF), zero-result fallback, relevance order

**Files:**

- Create: `apps/api/src/lib/search/rrf.ts`
- Modify: `apps/api/src/services/product-search.service.ts` (+ `semanticProductIds`, `rankedSearch`, query-embedding cache)
- Modify: `apps/api/src/services/product.service.ts` (`listPublic`: when `search` is present and `sort` is absent, use the ranked path)
- Modify: `apps/api/src/routes/public.routes.ts` (accept `sort=relevance`)
- Modify: `apps/web/src/app/search/SearchClient.tsx` (default sort `relevance` = keep server order; selector option), `apps/web/src/contexts/LanguageContext.tsx` (`Most relevant` / `الأكثر صلة`)
- Modify: `apps/admin/src/app/stores/[id]/insights/searches/page.tsx` + `search-insights.routes.ts` (index status line: "Smart search: N of M products indexed" / "البحث الذكي: N من M منتج متجهز")
- Test: `tests/unit/rrf.test.ts`, `tests/integration/hybrid-search.test.ts`

**Interfaces:**

- Consumes: `searchProductIds` (Task 3), `getEmbeddingProvider`, `semanticSearchEnabled` (Task 10), `storeIndexStatus` (Task 11)
- Produces: `rrfFuse(lists: string[][], k?: number): string[]`; `semanticProductIds(storeId: string, raw: string, limit?: number): Promise<string[]>` (returns `[]` when disabled or on any provider error); `rankedSearch(storeId: string, raw: string): Promise<string[]>` (≤ 200 ids, fused order); `SearchInsightsResponse.index?: { products: number; indexed: number; stale: number; semanticEnabled: boolean }`

- [ ] **Step 1: RRF unit test, then implementation**

```ts
// tests/unit/rrf.test.ts
import { it, expect } from 'vitest';
import { rrfFuse } from '../../apps/api/src/lib/search/rrf';
it('rewards items found by both legs and keeps single-leg items', () => {
  expect(
    rrfFuse([
      ['a', 'b', 'c'],
      ['c', 'd'],
    ])
  ).toEqual(['c', 'a', 'b', 'd']);
});
it('empty legs', () => {
  expect(rrfFuse([[], ['x']])).toEqual(['x']);
  expect(rrfFuse([[], []])).toEqual([]);
});
```

```ts
// apps/api/src/lib/search/rrf.ts
/** Reciprocal rank fusion (Cormack et al. 2009), k=60. Ties break by id for determinism. */
export function rrfFuse(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists)
    list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)));
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id]) => id);
}
```

Run: `npx vitest run tests/unit/rrf.test.ts`. Expected: FAIL first (no module), then PASS after the file is written. (`c` scores 1/63 + 1/61; `a` 1/61; `b` 1/62; `d` 1/62, with the tie broken b < d.)

- [ ] **Step 2: Write the failing hybrid integration test**

```ts
// tests/integration/hybrid-search.test.ts
// Reuses fakeProvider() from tests/integration/product-index.test.ts (move it to
// tests/helpers/fake-embeddings.ts in this step and import it from both files).
// The fake embeds identical text to identical vectors, so a query equal to a product's
// embed doc lands at distance 0: enough to prove plumbing, isolation and fallback;
// semantic QUALITY is Task 13's job with the real model.
it('zero lexical hits → vector leg still returns the product', async () => {
  process.env.SEARCH_SEMANTIC_ENABLED = 'true';
  setEmbeddingProviderForTests(f.provider);
  await runInStoreScope(storeId, () => indexStore(storeId));
  const doc = await docOf(pid); // SELECT ebda_product_embed_doc(...) for the product
  const ids = await runInTenantContext(storeId, () => rankedSearch(storeId, doc));
  expect(ids[0]).toBe(pid);
});
it("never returns another store's product (ebda_app client, RLS + explicit store_id)", async () => {
  const appDb = createPrismaClient({ connectionString: process.env.EBDA_APP_DATABASE_URL! });
  const ids = await runWithRequestDb(
    () => appDb,
    () => runInTenantContext(storeId, () => semanticProductIds(storeId, await docOf(foreignPid)))
  );
  expect(ids).not.toContain(foreignPid);
});
it('falls back to lexical when the provider throws', async () => {
  setEmbeddingProviderForTests({
    model: '@cf/baai/bge-m3',
    embed: async () => {
      throw new Error('5xx');
    },
  });
  const ids = await runInTenantContext(storeId, () => rankedSearch(storeId, 'احذيه'));
  expect(ids).toEqual([pid]);
});
it('disabled flag → lexical only, provider never called', async () => {
  process.env.SEARCH_SEMANTIC_ENABLED = 'false';
  const spy = vi.fn();
  setEmbeddingProviderForTests({ model: 'm', embed: spy });
  await runInTenantContext(storeId, () => rankedSearch(storeId, 'احذيه'));
  expect(spy).not.toHaveBeenCalled();
});
it('soft-deleted and draft products never come back from the vector leg', async () => {
  /* soft-delete pid2, assert absent */
});
```

Read how `tests/integration/store-creation-tenant-guard.test.ts` builds its `ebda_app` client URL and binds it per request, and use exactly that (env name, `runWithRequestDb` import path). Do not invent `EBDA_APP_DATABASE_URL` if that file uses another name.

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/hybrid-search.test.ts`
Expected: FAIL, `rankedSearch` is not exported.

- [ ] **Step 3: Implement the vector leg + fusion**

```ts
// additions to apps/api/src/services/product-search.service.ts
import { normalizeArabicSearch } from '@ebda/shared';
import { BoundedMap } from '../lib/bounded-map';
import {
  getEmbeddingProvider,
  semanticSearchEnabled,
  toHalfvecLiteral,
} from '../lib/search/embedding-provider';
import { rrfFuse } from '../lib/search/rrf';
import logger from '../lib/logger';

const LEG = 50;
const RANKED_CAP = 200;
// Query vectors: in-isolate cache (TTL floor rule: <120s caches are bounded-map only).
// BOUNDED-stale by construction: a query's vector never changes for a fixed model.
const qCache = new BoundedMap<string, { v: number[]; exp: number }>(2000);
const Q_TTL_MS = 10 * 60 * 1000;

async function queryVector(raw: string): Promise<number[] | null> {
  const provider = getEmbeddingProvider();
  if (!provider) return null;
  const key = `${provider.model}:${normalizeArabicSearch(raw)}`;
  const hit = qCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.v;
  const [v] = await provider.embed([raw.trim().slice(0, 200)]);
  qCache.set(key, { v, exp: Date.now() + Q_TTL_MS });
  return v;
}

export async function semanticProductIds(
  storeId: string,
  raw: string,
  limit = LEG
): Promise<string[]> {
  if (!semanticSearchEnabled() || !raw.trim()) return [];
  try {
    const v = await queryVector(raw);
    if (!v) return [];
    const maxDist = Number(process.env.SEARCH_VECTOR_MAX_DISTANCE ?? '0.55');
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT e.product_id AS id FROM product_embeddings e
      JOIN products p ON p.id = e.product_id AND p.store_id = ${storeId}
      WHERE e.store_id = ${storeId} AND p.status = 'active' AND p.deleted_at IS NULL
        AND (e.embedding <=> ${toHalfvecLiteral(v)}::halfvec(1024)) <= ${maxDist}
      ORDER BY e.embedding <=> ${toHalfvecLiteral(v)}::halfvec(1024)
      LIMIT ${limit}`;
    return rows.map(r => r.id);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : 'unknown', storeId },
      '[search] vector leg failed; lexical only'
    );
    return [];
  }
}

/** Storefront relevance order: RRF(lexical top 50, vector top 50). Lexical alone when the vector leg is off or failing. */
export async function rankedSearch(storeId: string, raw: string): Promise<string[]> {
  const [lex, vec] = await Promise.all([
    searchProductIds(storeId, raw, { scope: 'storefront', limit: LEG }),
    semanticProductIds(storeId, raw),
  ]);
  return rrfFuse([lex, vec]).slice(0, RANKED_CAP);
}
```

Before running the integration test, measure the store-filtered KNN plan. Run `EXPLAIN (ANALYZE, BUFFERS)` of the vector SELECT on a seeded store with 2,000 products. Expected: Index Scan on `product_embeddings_store_id_idx` + top-N sort, **< 30 ms**. Paste the plan in the PR.

- [ ] **Step 4: Ranked listing in `listPublic`**

In `listPublic`, before the existing `if (search)` block:

```ts
if (search && (!sort || sort === 'relevance')) {
  const ranked = await rankedSearch(storeId, search);
  // Apply every other filter (category, price, featured, option facets) to the ranked set,
  // then page through it in rank order.
  where.id = { in: ranked };
  const allowed = new Set(
    (await prisma.product.findMany({ where, select: { id: true } })).map(r => r.id)
  );
  const ordered = ranked.filter(id => allowed.has(id));
  const pageIds = ordered.slice((pageNum - 1) * take, pageNum * take);
  const rows = await prisma.product.findMany({
    where: { storeId, id: { in: pageIds } },
    select: publicProductSelect,
  });
  const byId = new Map(rows.map(r => [r.id, r]));
  return {
    products: pageIds
      .map(id => byId.get(id))
      .filter(Boolean)
      .map(withAvailability),
    meta: {
      page: pageNum,
      limit: take,
      total: ordered.length,
      totalPages: Math.ceil(ordered.length / take),
    },
    ...(await facetsFor(whereBeforeOptions)),
  };
}
```

`pageNum`, `take`, the public select constant, the availability mapper and the facet computation already exist in `listPublic` under their own names. Read `:1330-1520` and use those exact identifiers. Do not create new ones (the snippet's names stand in for them and must be replaced 1:1 before compiling). Facets must come from the same pre-option `where` snapshot the existing path uses, so the sidebar counts stay identical. Adding `'relevance'` to `sortValue`'s accepted values in `public.routes.ts` is a one-line change; the cache key already includes the sort.

`SearchClient.tsx`: add `'relevance'` to `SortValue`, make it the default when `q` is present, and skip the client-side re-sort when `sortBy === 'relevance'`. Add the option label to `LanguageContext.tsx` (`'Most relevant'` / `'الأكثر صلة'`). Check every theme that renders a search sort selector: `grep -rn "price_asc" apps/web/src/components apps/web/src/app | grep -v test`. Each hit gets the option (platform-level rule).

- [ ] **Step 5: Index status on the searches page.** In `search-insights.routes.ts`, add `index: { ...(await storeIndexStatus(storeId)), semanticEnabled: semanticSearchEnabled() }` to the response. The page shows one line under the title with the i18n keys `indexStatus` ("البحث الذكي: {indexed} من {products} منتج متجهز" / "Smart search: {indexed} of {products} products ready") and `indexOff` ("البحث الذكي مش شغال لسه" / "Smart search is not on yet") when `semanticEnabled` is false. This line is the viewer for `product_embeddings`.

- [ ] **Step 6: Run**

Run: `npx vitest run tests/unit/rrf.test.ts && DATABASE_URL=$TEST_DB npx vitest run tests/integration/hybrid-search.test.ts tests/integration/product-search-normalised.test.ts tests/integration/product-search-floor.test.ts && npm run typecheck && npm run lint && npx vitest run apps/web`
Expected: PASS

- [ ] **Step 7: Drive the storefront in Arabic.** Run `npm run dev:api` + `npm run dev:web` with `SEARCH_SEMANTIC_ENABLED=true` and REST credentials (or the fake provider through `.dev.vars` if none are available; say which one in the PR). Open the store's `/search?q=احذيه` in the Arabic locale and screenshot at 390 px and desktop. Then search a term with no lexical match (`كوتشي` on a product named "حذاء رياضي" with no search terms) and screenshot the semantic hit. Attach all to PR 4.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/search/rrf.ts apps/api/src/services/product-search.service.ts apps/api/src/services/product.service.ts apps/api/src/routes/public.routes.ts apps/api/src/routes/search-insights.routes.ts packages/shared/src/search apps/web/src/app/search/SearchClient.tsx apps/web/src/contexts/LanguageContext.tsx "apps/admin/src/app/stores/[id]/insights/searches/page.tsx" apps/admin/src/i18n/messages/ar.json apps/admin/src/i18n/messages/en.json tests/unit/rrf.test.ts tests/integration/hybrid-search.test.ts tests/helpers/fake-embeddings.ts tests/integration/product-index.test.ts
git commit -m "$(cat <<'EOF'
feat(product): hybrid lexical and semantic storefront search with rrf

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 13: 200-query eval set + scored harness with a pass bar

**Files:**

- Create: `tests/search-eval/catalogue.ts` (50 Egyptian products × 4 query forms = 200 queries)
- Create: `tests/search-eval/run.ts` (harness; `npm run search:eval`)
- Create: `tests/unit/search-eval-scoring.test.ts`
- Modify: `package.json` (`"search:eval": "tsx tests/search-eval/run.ts"`)

**Interfaces:**

- Produces: `EVAL_PRODUCTS: Array<{ key: string; nameAr: string; name: string; q: { msa: string; dialect: string; franco: string; en: string } }>`, `recallAt(ranked: string[], target: string, k: number): 0 | 1`, `reciprocalRank(ranked: string[], target: string): number`, harness exit code 1 below the bar.
- **Pass bar (Ruling SEARCH-10):** hybrid recall@10 ≥ 0.90 overall and ≥ 0.80 on each of dialect and franco; MRR ≥ 0.70; hybrid must not be worse than lexical-only on msa or en (Δ ≥ −0.02). It must beat lexical-only by ≥ +0.15 recall@10 on dialect + franco combined, or semantic is not earning its cost: the report says so and **STOP-3** stays off.

- [ ] **Step 1: Catalogue (real Egyptian shopper vocabulary; the `nameAr` is what a merchant writes, the queries are what shoppers type)**

```ts
// tests/search-eval/catalogue.ts
export const EVAL_PRODUCTS = [
  {
    key: 'abaya',
    nameAr: 'عباية كريب سوداء',
    name: 'Black crepe abaya',
    q: { msa: 'عباءة سوداء', dialect: 'عبايه سودا', franco: '3abaya soda', en: 'black abaya' },
  },
  {
    key: 'sneakers',
    nameAr: 'حذاء رياضي رجالي',
    name: "Men's sport shoes",
    q: { msa: 'حذاء رياضي', dialect: 'كوتشي رجالي', franco: 'kotshy', en: 'sneakers men' },
  },
  {
    key: 'boots',
    nameAr: 'بوت جلد حريمي',
    name: "Women's leather boots",
    q: { msa: 'حذاء طويل جلد', dialect: 'بوت جلد حريمي', franco: 'boot geld', en: 'leather boots' },
  },
  {
    key: 'slippers',
    nameAr: 'شبشب منزلي',
    name: 'House slippers',
    q: { msa: 'نعال منزلي', dialect: 'شبشب بيتي', franco: 'shebsheb', en: 'slippers' },
  },
  {
    key: 'handbag',
    nameAr: 'حقيبة يد جلد',
    name: 'Leather handbag',
    q: { msa: 'حقيبة يد', dialect: 'شنطه ايد', franco: 'shanta', en: 'handbag' },
  },
  {
    key: 'backpack',
    nameAr: 'حقيبة ظهر مدرسية',
    name: 'School backpack',
    q: { msa: 'حقيبة ظهر', dialect: 'شنطه مدرسه', franco: 'shantet madrasa', en: 'school bag' },
  },
  {
    key: 'galabeya',
    nameAr: 'جلابية قطن رجالي',
    name: "Men's cotton galabeya",
    q: { msa: 'جلباب رجالي', dialect: 'جلابيه قطن', franco: 'galabeya', en: 'galabiya' },
  },
  {
    key: 'isdal',
    nameAr: 'إسدال صلاة',
    name: 'Prayer isdal',
    q: { msa: 'ثوب صلاة', dialect: 'اسدال صلاه', franco: 'esdal', en: 'prayer dress' },
  },
  {
    key: 'hijab',
    nameAr: 'طرحة شيفون',
    name: 'Chiffon hijab',
    q: { msa: 'حجاب شيفون', dialect: 'طرحه شيفون', franco: 'tar7a', en: 'hijab' },
  },
  {
    key: 'tshirt',
    nameAr: 'تيشيرت قطن بيزك',
    name: 'Basic cotton t-shirt',
    q: { msa: 'قميص قطني قصير', dialect: 'تيشرت', franco: 'tshirt', en: 't-shirt' },
  },
  {
    key: 'jeans',
    nameAr: 'بنطلون جينز سليم',
    name: 'Slim jeans',
    q: { msa: 'سروال جينز', dialect: 'بنطلون جينز', franco: 'bantalon jeans', en: 'jeans' },
  },
  {
    key: 'pajama',
    nameAr: 'بيجامة شتوي',
    name: 'Winter pajamas',
    q: { msa: 'ملابس نوم شتوية', dialect: 'بيجامه شتوي', franco: 'bejama', en: 'pajamas' },
  },
  {
    key: 'socks',
    nameAr: 'شراب قطن',
    name: 'Cotton socks',
    q: { msa: 'جوارب قطن', dialect: 'شراب', franco: 'shrab', en: 'socks' },
  },
  {
    key: 'underwear',
    nameAr: 'طقم داخلي رجالي',
    name: "Men's underwear set",
    q: { msa: 'ملابس داخلية', dialect: 'هدوم داخليه', franco: 'hdoom dakhleya', en: 'underwear' },
  },
  {
    key: 'perfume',
    nameAr: 'برفان عود',
    name: 'Oud perfume',
    q: { msa: 'عطر عود', dialect: 'برفيوم عود', franco: 'parfan 3od', en: 'oud perfume' },
  },
  {
    key: 'bakhoor',
    nameAr: 'بخور معطر',
    name: 'Scented incense',
    q: { msa: 'بخور', dialect: 'بخور للبيت', franco: 'bo5oor', en: 'incense' },
  },
  {
    key: 'lipstick',
    nameAr: 'روج مات',
    name: 'Matte lipstick',
    q: { msa: 'أحمر شفاه', dialect: 'روج', franco: 'rouge', en: 'lipstick' },
  },
  {
    key: 'kohl',
    nameAr: 'كحل عيون أسود',
    name: 'Black kohl eyeliner',
    q: { msa: 'كحل', dialect: 'كحل اسود', franco: 'ko7l', en: 'eyeliner' },
  },
  {
    key: 'shampoo',
    nameAr: 'شامبو للشعر الجاف',
    name: 'Shampoo for dry hair',
    q: {
      msa: 'منظف شعر',
      dialect: 'شامبو شعر ناشف',
      franco: 'shampoo sha3r',
      en: 'dry hair shampoo',
    },
  },
  {
    key: 'moisturizer',
    nameAr: 'كريم مرطب للوجه',
    name: 'Face moisturizer',
    q: { msa: 'مرطب بشرة', dialect: 'كريم للوش', franco: 'kreem lel wesh', en: 'moisturizer' },
  },
  {
    key: 'koshari',
    nameAr: 'كشري مصري',
    name: 'Egyptian koshari',
    q: { msa: 'طبق كشري', dialect: 'كشري', franco: 'koshary', en: 'koshari' },
  },
  {
    key: 'pasta',
    nameAr: 'مكرونة إسباجتي',
    name: 'Spaghetti pasta',
    q: { msa: 'معكرونة', dialect: 'مكرونه', franco: 'makarona', en: 'spaghetti' },
  },
  {
    key: 'rice',
    nameAr: 'أرز مصري',
    name: 'Egyptian rice',
    q: { msa: 'أرز', dialect: 'رز', franco: 'roz', en: 'rice' },
  },
  {
    key: 'foul',
    nameAr: 'فول مدمس',
    name: 'Fava beans',
    q: { msa: 'فول', dialect: 'فول مدمس', franco: 'fool', en: 'fava beans' },
  },
  {
    key: 'taameya',
    nameAr: 'طعمية مجمدة',
    name: 'Frozen falafel',
    q: { msa: 'فلافل', dialect: 'طعميه', franco: 'ta3meya', en: 'falafel' },
  },
  {
    key: 'feteer',
    nameAr: 'فطير مشلتت',
    name: 'Feteer meshaltet',
    q: { msa: 'فطيرة', dialect: 'فطير', franco: 'feteer', en: 'layered pastry' },
  },
  {
    key: 'kunafa',
    nameAr: 'كنافة بالقشطة',
    name: 'Kunafa with cream',
    q: { msa: 'كنافة', dialect: 'كنافه بالقشطه', franco: 'konafa', en: 'kunafa' },
  },
  {
    key: 'basbousa',
    nameAr: 'بسبوسة بالمكسرات',
    name: 'Basbousa with nuts',
    q: { msa: 'حلوى السميد', dialect: 'بسبوسه', franco: 'basbosa', en: 'semolina cake' },
  },
  {
    key: 'dates',
    nameAr: 'تمر سيوي',
    name: 'Siwa dates',
    q: { msa: 'تمور', dialect: 'بلح', franco: 'bala7', en: 'dates' },
  },
  {
    key: 'tea',
    nameAr: 'شاي أسود ناعم',
    name: 'Fine black tea',
    q: { msa: 'شاي', dialect: 'شاي كشري', franco: 'shay', en: 'black tea' },
  },
  {
    key: 'coffee',
    nameAr: 'بن محوج',
    name: 'Spiced ground coffee',
    q: { msa: 'قهوة مطحونة', dialect: 'بن محوج', franco: 'bon', en: 'ground coffee' },
  },
  {
    key: 'honey',
    nameAr: 'عسل نحل طبيعي',
    name: 'Natural bee honey',
    q: { msa: 'عسل', dialect: 'عسل نحل', franco: '3asal', en: 'honey' },
  },
  {
    key: 'phonecase',
    nameAr: 'جراب موبايل سيليكون',
    name: 'Silicone phone case',
    q: { msa: 'غطاء هاتف', dialect: 'جراب موبايل', franco: 'grab mobile', en: 'phone case' },
  },
  {
    key: 'charger',
    nameAr: 'شاحن سريع ٢٠ وات',
    name: '20W fast charger',
    q: { msa: 'شاحن هاتف', dialect: 'شاحن سريع 20', franco: 'sha7en', en: 'fast charger' },
  },
  {
    key: 'earbuds',
    nameAr: 'سماعة بلوتوث',
    name: 'Bluetooth earbuds',
    q: { msa: 'سماعات لاسلكية', dialect: 'سماعه بلوتوث', franco: 'sama3a', en: 'earbuds' },
  },
  {
    key: 'powerbank',
    nameAr: 'باور بانك ١٠٠٠٠',
    name: 'Power bank 10000',
    q: { msa: 'بطارية متنقلة', dialect: 'باور بانك', franco: 'power bank', en: 'portable battery' },
  },
  {
    key: 'watch',
    nameAr: 'ساعة يد رجالي',
    name: "Men's wristwatch",
    q: { msa: 'ساعة', dialect: 'ساعه ايد', franco: 'sa3a', en: 'watch' },
  },
  {
    key: 'ring',
    nameAr: 'خاتم فضة',
    name: 'Silver ring',
    q: { msa: 'خاتم فضي', dialect: 'دبله فضه', franco: '5atem', en: 'silver ring' },
  },
  {
    key: 'necklace',
    nameAr: 'سلسلة ذهب عيار ٢١',
    name: '21k gold necklace',
    q: { msa: 'قلادة ذهب', dialect: 'سلسله دهب', franco: 'selsela dahab', en: 'gold necklace' },
  },
  {
    key: 'kettle',
    nameAr: 'غلاية كهربائية',
    name: 'Electric kettle',
    q: { msa: 'غلاية ماء', dialect: 'كاتل', franco: 'kettle', en: 'kettle' },
  },
  {
    key: 'blender',
    nameAr: 'خلاط كهربائي',
    name: 'Electric blender',
    q: { msa: 'خلاط', dialect: 'خلاط عصير', franco: '5alat', en: 'blender' },
  },
  {
    key: 'pot',
    nameAr: 'حلة جرانيت',
    name: 'Granite pot',
    q: { msa: 'قدر طبخ', dialect: 'حله', franco: '7alla', en: 'cooking pot' },
  },
  {
    key: 'mug',
    nameAr: 'مج سيراميك',
    name: 'Ceramic mug',
    q: { msa: 'كوب سيراميك', dialect: 'مج', franco: 'mug', en: 'coffee mug' },
  },
  {
    key: 'blanket',
    nameAr: 'بطانية شتوي',
    name: 'Winter blanket',
    q: { msa: 'غطاء سرير', dialect: 'بطانيه', franco: 'bataneya', en: 'blanket' },
  },
  {
    key: 'bedsheet',
    nameAr: 'ملاية سرير قطن',
    name: 'Cotton bed sheet',
    q: { msa: 'شرشف سرير', dialect: 'ملايه', franco: 'malaya', en: 'bed sheet' },
  },
  {
    key: 'curtain',
    nameAr: 'ستارة بلاك أوت',
    name: 'Blackout curtain',
    q: { msa: 'ستارة', dialect: 'ستاره', franco: 'setara', en: 'curtain' },
  },
  {
    key: 'stroller',
    nameAr: 'عربية أطفال',
    name: 'Baby stroller',
    q: { msa: 'عربة أطفال', dialect: 'عربيه بيبي', franco: '3arabeyet baby', en: 'stroller' },
  },
  {
    key: 'diapers',
    nameAr: 'حفاضات مقاس ٤',
    name: 'Diapers size 4',
    q: { msa: 'حفاضات', dialect: 'بامبرز مقاس 4', franco: 'pampers', en: 'diapers' },
  },
  {
    key: 'toycar',
    nameAr: 'عربية ريموت للأطفال',
    name: 'Remote control car',
    q: { msa: 'سيارة لعبة', dialect: 'عربيه ريموت', franco: '3arabeya remote', en: 'rc car' },
  },
  {
    key: 'notebook',
    nameAr: 'كشكول ١٠٠ ورقة',
    name: '100-page notebook',
    q: { msa: 'دفتر', dialect: 'كشكول', franco: 'koshkol', en: 'notebook' },
  },
] as const;
```

- [ ] **Step 2: Scoring unit test, then the harness**

```ts
// tests/unit/search-eval-scoring.test.ts
import { it, expect } from 'vitest';
import { recallAt, reciprocalRank } from '../search-eval/run';
import { EVAL_PRODUCTS } from '../search-eval/catalogue';
it('scores', () => {
  expect(recallAt(['a', 'b'], 'b', 1)).toBe(0);
  expect(recallAt(['a', 'b'], 'b', 2)).toBe(1);
  expect(reciprocalRank(['a', 'b', 'c'], 'c')).toBeCloseTo(1 / 3);
  expect(reciprocalRank([], 'c')).toBe(0);
});
it('200 queries, unique keys', () => {
  expect(EVAL_PRODUCTS.length * 4).toBe(200);
  expect(new Set(EVAL_PRODUCTS.map(p => p.key)).size).toBe(50);
});
```

```ts
// tests/search-eval/run.ts
/**
 * Search quality eval: seeds EVAL_PRODUCTS into a throwaway store on DATABASE_URL (a LOCAL
 * scratch DB — never production), embeds them with the REAL provider (CF_AI_ACCOUNT_ID +
 * CF_AI_API_TOKEN, ~$0.0002 per run), runs all 200 queries through lexical-only and hybrid,
 * prints recall@10 / MRR per form, exits 1 below the bar (Ruling SEARCH-10).
 * Manual / nightly, NOT per-push (costs money, needs credentials) — same cadence as ai:eval.
 *   DATABASE_URL=$TEST_DB SEARCH_SEMANTIC_ENABLED=true CF_AI_ACCOUNT_ID=… CF_AI_API_TOKEN=… npm run search:eval
 */
import { prisma, runInStoreScope, runInTenantContext } from '@ebda/database';
import { EVAL_PRODUCTS } from './catalogue';

export const recallAt = (r: string[], t: string, k: number): 0 | 1 =>
  r.slice(0, k).includes(t) ? 1 : 0;
export const reciprocalRank = (r: string[], t: string) => {
  const i = r.indexOf(t);
  return i < 0 ? 0 : 1 / (i + 1);
};

async function main() {
  const { searchProductIds, rankedSearch } =
    await import('../../apps/api/src/services/product-search.service');
  const { indexStore } = await import('../../apps/api/src/services/product-index.service');
  const run = Date.now().toString(36);
  const owner = await prisma.user.create({
    data: { email: `eval-${run}@t.local`, role: 'store_admin' },
  });
  const store = await prisma.store.create({
    data: { name: 'eval', slug: `eval-${run}`, ownerId: owner.id },
  });
  const idOf: Record<string, string> = {};
  for (const p of EVAL_PRODUCTS) {
    idOf[p.key] = (
      await prisma.product.create({
        data: {
          storeId: store.id,
          slug: `${p.key}-${run}`,
          name: p.name,
          nameAr: p.nameAr,
          price: 1000,
          status: 'active',
        },
      })
    ).id;
  }
  while (
    (await runInStoreScope(store.id, () => indexStore(store.id, { maxDocs: 100 }))).remaining
  ) {
    /* drain */
  }

  const forms = ['msa', 'dialect', 'franco', 'en'] as const;
  const score: Record<string, { lexR: number; hyR: number; hyMrr: number; n: number }> = {};
  for (const f of forms) score[f] = { lexR: 0, hyR: 0, hyMrr: 0, n: 0 };
  for (const p of EVAL_PRODUCTS)
    for (const f of forms) {
      const target = idOf[p.key];
      const lex = await runInTenantContext(store.id, () =>
        searchProductIds(store.id, p.q[f], { scope: 'storefront', limit: 50 })
      );
      const hy = await runInTenantContext(store.id, () => rankedSearch(store.id, p.q[f]));
      const s = score[f];
      s.n++;
      s.lexR += recallAt(lex, target, 10);
      s.hyR += recallAt(hy, target, 10);
      s.hyMrr += reciprocalRank(hy, target);
    }
  let overallR = 0,
    overallMrr = 0,
    ok = true;
  for (const f of forms) {
    const s = score[f];
    const lex = s.lexR / s.n,
      hy = s.hyR / s.n,
      mrr = s.hyMrr / s.n;
    overallR += hy / 4;
    overallMrr += mrr / 4;
    console.log(
      `${f.padEnd(8)} lexical@10=${lex.toFixed(2)} hybrid@10=${hy.toFixed(2)} MRR=${mrr.toFixed(2)}`
    );
    if ((f === 'dialect' || f === 'franco') && hy < 0.8) ok = false;
    if ((f === 'msa' || f === 'en') && hy - lex < -0.02) ok = false;
  }
  const lift =
    (score.dialect.hyR + score.franco.hyR - score.dialect.lexR - score.franco.lexR) /
    (score.dialect.n + score.franco.n);
  console.log(
    `overall hybrid@10=${overallR.toFixed(2)} MRR=${overallMrr.toFixed(2)} dialect+franco lift=${lift.toFixed(2)}`
  );
  if (overallR < 0.9 || overallMrr < 0.7) ok = false;
  if (lift < 0.15) {
    console.log(
      'SEMANTIC NOT EARNING ITS COST: keep SEARCH_SEMANTIC_ENABLED off (Ruling SEARCH-10)'
    );
    ok = false;
  }
  await prisma.store.delete({ where: { id: store.id } });
  process.exit(ok ? 0 : 1);
}
if (process.argv[1]?.endsWith('run.ts'))
  main().catch(e => {
    console.error(e);
    process.exit(2);
  });
```

The products are seeded WITHOUT search terms on purpose: the eval measures the raw model. Then do a second run with AI search terms filled (Task 8 generator on all 50; costs about 50 Gemini calls, under the bulk quota). Report both tables in PR 4. Tune `SEARCH_VECTOR_MAX_DISTANCE` (try 0.45/0.55/0.65) on the first run and record the winner in `docs/ENVIRONMENT.md` and Ruling SEARCH-10.

- [ ] **Step 3: Run**

Run: `npx vitest run tests/unit/search-eval-scoring.test.ts`. Then, with credentials: `DATABASE_URL=$TEST_DB SEARCH_SEMANTIC_ENABLED=true CF_AI_ACCOUNT_ID=… CF_AI_API_TOKEN=… npm run search:eval`.
Expected: the unit test passes. The harness prints 4 rows + overall and exits 0 if the bar is met. A non-zero exit is a finding, reported VERIFIED/NOT VERIFIED in the PR; it is not a test to edit until it passes.

- [ ] **Step 4: Commit**

```bash
git add tests/search-eval tests/unit/search-eval-scoring.test.ts package.json
git commit -m "$(cat <<'EOF'
test(product): 200-query arabic dialect franco english search eval with pass bar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 14: Load test: storefront search p95 < 500 ms

**Files:**

- Create: `loadtests/scenarios/storefront-search.js`
- Modify: `loadtests/README.md` (one section)

- [ ] **Step 1: Scenario**

```js
// loadtests/scenarios/storefront-search.js
// Storefront search under load: 70% full search (hybrid path), 30% typeahead (lexical).
// Run against LOCAL dev or a staging Worker only — never production (search writes the search log).
//   BASE_URL=http://localhost:4000/api/v1 STORE_ID=<uuid> k6 run loadtests/scenarios/storefront-search.js
import http from 'k6/http';
import { check } from 'k6';

const TERMS = [
  'احذيه',
  'عبايه سودا',
  '3abaya',
  'كوتشي',
  'شنطه',
  'مكرونه',
  'phone case',
  'سماعه بلوتوث',
  'بيجامه',
  'روج',
  'كشكول',
  'بطانيه',
  'جراب موبايل',
  'ساعه',
  'برفيوم',
  'تيشرت',
  'jeans',
  'رز',
  'بلح',
  'كنافه',
];

export const options = {
  scenarios: {
    search: {
      executor: 'constant-arrival-rate',
      rate: 30,
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 40,
      maxVUs: 120,
    },
  },
  thresholds: {
    'http_req_duration{kind:search}': ['p(95)<500'],
    'http_req_duration{kind:suggest}': ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const term =
    TERMS[Math.floor(Math.random() * TERMS.length)] +
    (Math.random() < 0.5 ? '' : ` ${__ITER % 97}`);
  const base = __ENV.BASE_URL;
  const store = __ENV.STORE_ID;
  if (Math.random() < 0.7) {
    const r = http.get(`${base}/public/products?search=${encodeURIComponent(term)}`, {
      headers: { 'x-store-id': store },
      tags: { kind: 'search' },
    });
    check(r, { 'search 200': x => x.status === 200 });
  } else {
    const r = http.get(
      `${base}/public/${store}/search/suggest?q=${encodeURIComponent(term.slice(0, 4))}`,
      { tags: { kind: 'suggest' } }
    );
    check(r, { 'suggest 200': x => x.status === 200 });
  }
}
```

The ` ${__ITER % 97}` suffix makes most terms unique, which defeats the 120 s `getCached` on purpose so the DB path is what gets measured.

- [ ] **Step 2: Run against a seeded 2,000-product store on the local Worker (`npx wrangler dev` in `apps/api`, with the AI binding remote → real query embeds).**

Run: `BASE_URL=http://localhost:8787/api/v1 STORE_ID=<id> k6 run loadtests/scenarios/storefront-search.js`
Expected: thresholds pass. Run `benchmark-vet` on the p95 before quoting it. If the run is from a laptop over residential network to Neon, label the number "local, not production-representative" (measured vs inferred).

- [ ] **Step 3: Commit (PR 4)**

```bash
git add loadtests/scenarios/storefront-search.js loadtests/README.md
git commit -m "$(cat <<'EOF'
test(product): k6 storefront search scenario with p95 gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

**PR 4 boundary.** Merge + deploy with the flag still off → `/health` commit = the merge commit → follow-up CONTRACT PR drops the 5-argument `ebda_product_embed_doc` (SEARCH-T13-8; never in the same deploy as the expand) → STOP-4 backfill confirmed complete (searches page shows "N of M") → Task 8 search-words autofill done → Task 13 eval re-run on the first REAL catalogue meets the bar with the msa/en floors (SEARCH-T13-4) → **STOP-3b** (Ahmad sets `SEARCH_SEMANTIC_ENABLED=true` as a Worker var) → live checks: `/health` commit, Arabic-locale search on one store, `wrangler tail` showing no `[search] vector leg failed` lines over 15 min, Workers AI usage in the CF dashboard.

---

# PHASE P2: admin search (PR 5, `feat/search-p2-admin`)

## Task 15: Phone + name normalisation in SQL with expression indexes

**Files:**

- Create: `packages/shared/src/search/phone-search.ts` (+ export) and `packages/shared/src/search/__tests__/phone-search.test.ts`
- Create: `packages/database/prisma/migrations/20261020000100_admin_search_norm/migration.sql` + `rollback.sql`
- Modify: `docs/DB-INDEX-MIGRATIONS.md` (drift list)
- Test: `tests/integration/admin-search-norm.test.ts`

**Interfaces:**

- Produces: `phoneSearchDigits(q: string): string | null` (Latin digits only after folding; strips a leading `0020`/`+20`/`20`/`0` when ≥ 9 digits remain; null when fewer than 4 digits). SQL: `public.ebda_digits(text) → text` (Arabic-Indic and Persian → Latin, every non-digit dropped). Indexes: `users_phone_digits_trgm_idx` on `public.ebda_digits(phone)`, `users_name_norm_trgm_idx` on `public.ebda_ar_norm(coalesce(first_name,'') || ' ' || coalesce(last_name,''))`, `orders_guest_phone_digits_trgm_idx` on `public.ebda_digits(shipping_address ->> 'phone') WHERE customer_id IS NULL`, `orders_guest_name_norm_trgm_idx` on `public.ebda_ar_norm(coalesce(shipping_address->>'firstName','') || ' ' || coalesce(shipping_address->>'lastName','')) WHERE customer_id IS NULL`.

- [ ] **Step 1: Failing unit test**

```ts
// packages/shared/src/search/__tests__/phone-search.test.ts
import { it, expect } from 'vitest';
import { phoneSearchDigits } from '../phone-search';
it.each([
  ['01012345678', '1012345678'],
  ['+20 101 234 5678', '1012345678'],
  ['00201012345678', '1012345678'],
  ['٠١٠١٢٣٤٥٦٧٨', '1012345678'],
  ['010-1234', '0101234'],
  ['5678', '5678'],
  ['12', null],
  ['احمد', null],
])('%j -> %j', (q, out) => expect(phoneSearchDigits(q)).toBe(out));
```

(`010-1234` keeps its leading 0, because fewer than 9 digits would remain after stripping it: a partial number is matched as typed.)

Run: `npx vitest run packages/shared/src/search/__tests__/phone-search.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement**

```ts
// packages/shared/src/search/phone-search.ts
import { normalizeArabicSearch } from './arabic-normalize';
export function phoneSearchDigits(q: string): string | null {
  const digits = normalizeArabicSearch(q ?? '').replace(/[^0-9]/g, '');
  if (digits.length < 4) return null;
  const national = digits.replace(/^(?:0020|20|0)/, '');
  return national.length >= 9 ? national : digits;
}
```

```sql
-- 20261020000100_admin_search_norm/migration.sql
-- Admin customer/order search (search program P2): Arabic-normalised names and digit-only phones,
-- so "احمد" finds "أحمد" and "0101 234 5678" / "+20101…" / "٠١٠…" find the same customer.
-- public.ebda_digits is IMMUTABLE and schema-qualified (pg_restore rebuilds the index).
-- >>> PRODUCTION PREREQUISITE (STOP-5): `users` and `orders` are live and `orders` is write-hot.
-- Pre-build all four indexes with CREATE INDEX CONCURRENTLY IF NOT EXISTS on DIRECT_URL (autocommit,
-- outside peak hours), confirm no INVALID index, then merge. This file is then a no-op there.
-- Rollback: rollback.sql.
CREATE OR REPLACE FUNCTION public.ebda_digits(t text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT regexp_replace(translate(t, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g')
$$;
CREATE INDEX IF NOT EXISTS "users_phone_digits_trgm_idx" ON "users" USING gin (public.ebda_digits("phone") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "users_name_norm_trgm_idx" ON "users" USING gin
  (public.ebda_ar_norm(coalesce("first_name", '') || ' ' || coalesce("last_name", '')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "orders_guest_phone_digits_trgm_idx" ON "orders" USING gin
  (public.ebda_digits("shipping_address" ->> 'phone') gin_trgm_ops) WHERE "customer_id" IS NULL;
CREATE INDEX IF NOT EXISTS "orders_guest_name_norm_trgm_idx" ON "orders" USING gin
  (public.ebda_ar_norm(coalesce("shipping_address" ->> 'firstName', '') || ' ' || coalesce("shipping_address" ->> 'lastName', '')) gin_trgm_ops)
  WHERE "customer_id" IS NULL;
```

`rollback.sql` holds the 4 `DROP INDEX CONCURRENTLY IF EXISTS`.

- [ ] **Step 3: Integration test.** Assert: `ebda_digits('+20 ١٠١-234')` = `'20101234'`; all 4 indexes are valid; under `SET LOCAL enable_seqscan=off`, an `EXPLAIN` of `public.ebda_digits(phone) LIKE '%1012345678%'` on `users` names `users_phone_digits_trgm_idx`. Use the same shape as Task 2's test. Then run the build time on 100k orders: `\timing on` + the CREATE INDEX in psql on a seeded scratch DB. Record the number in the migration header (DB-INDEX-MIGRATIONS "measure, don't guess").

Run: `DATABASE_URL=$TEST_DB DIRECT_URL=$TEST_DB npx prisma migrate deploy --schema packages/database/prisma/schema.prisma && npx vitest run packages/shared/src/search && DATABASE_URL=$TEST_DB npx vitest run tests/integration/admin-search-norm.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/search packages/database/prisma/migrations/20261020000100_admin_search_norm docs/DB-INDEX-MIGRATIONS.md tests/integration/admin-search-norm.test.ts
git commit -m "$(cat <<'EOF'
feat(database): normalised phone and name expression indexes for admin search

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 16: Customers search in SQL (list, export, typeahead)

**Files:**

- Create: `apps/api/src/services/admin-search.service.ts`
- Modify: `apps/api/src/services/customer-aggregate.service.ts` (`aggregateCustomersUncached(storeId, scope?)`, new `aggregateCustomersMatching(storeId, search)`)
- Modify: `apps/api/src/routes/customers.routes.ts:67-100` (`applyCustomerListFilters` loses its in-memory search; the list and export call `aggregateCustomersMatching` when `search` is set), `:605-700` (`/customers/search` uses the service; fixes the unescaped LIKE)
- Test: `tests/integration/customers-search-sql.test.ts`

**Interfaces:**

- Consumes: `phoneSearchDigits`, `searchTokens`, `escapeLike`, SQL from Task 15
- Produces:
  - `matchingCustomers(storeId: string, q: string): Promise<{ userIds: string[]; guestOrderIds: string[]; truncated: boolean }>`. Registered users = users with an order in this store OR `users.store_id = storeId` whose normalised name contains every token, or whose email ILIKE (escaped), or whose digits contain `phoneSearchDigits(q)`. Guests = orders with `customer_id IS NULL` in this store, matched on the shipping_address name/email/phone. Caps: 1000 users, 20000 guest orders.
  - `aggregateCustomersMatching(storeId, search)` has the same return shape as `aggregateCustomers`. It is uncached (the result is small and query-specific) and scoped by `{ orderWhere: { OR: [{ customerId: { in: userIds } }, { id: { in: guestOrderIds } }] }, zeroOrderUserIds: userIds }`.

- [ ] **Step 1: Failing test**

```ts
// tests/integration/customers-search-sql.test.ts — fixtures per CALL (retry-safe, CLAUDE.md)
it.each([
  ['احمد', 'أحمد علي (registered)'],
  ['0101 234 5678', 'registered, stored +201012345678'],
  ['٠١٠١٢٣٤٥٦٧٨', 'same, Arabic-Indic digits'],
  ['منى', 'guest منى (shipping_address only)'],
  ['01123456789', 'guest phone stored as "0112 345 6789" (legacy, unnormalised)'],
])('%s finds %s', async (q, _label) => {
  /* assert the expected customer key is in the result */
});
it('a customer beyond the 20k aggregation cap is still found', async () => {
  // seed 1 matching order older than 20,001 non-matching orders (bulk insert via createMany in a
  // per-call store); aggregateCustomersMatching must return it, the old in-memory filter could not.
});
it('"%" matches nothing (escaped)', async () => {
  /* /customers/search?q=%25 → [] */
});
it('staff cannot filter by segment (403 unchanged)', async () => {
  /* regression on applyCustomerListFilters */
});
```

Write each case fully, with the seeds inline, following `tests/integration/order-search-guest-contact.test.ts` (per-call `run` id, `finally` cleanup). The `/* … */` bodies above say what each case asserts; the implementer writes the full code in this step, and none may be left as a comment.

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/customers-search-sql.test.ts`. Expected: FAIL.

- [ ] **Step 2: Implement**

```ts
// apps/api/src/services/admin-search.service.ts
import { prisma, Prisma } from '@ebda/database';
import { searchTokens, escapeLike, phoneSearchDigits } from '@ebda/shared';

export const CUSTOMER_MATCH_USER_CAP = 1000;
export const CUSTOMER_MATCH_GUEST_ORDER_CAP = 20000;

export async function matchingCustomers(storeId: string, q: string) {
  const tokens = searchTokens(q);
  const digits = phoneSearchDigits(q);
  const email = q.includes('@') ? `%${escapeLike(q.trim().toLowerCase())}%` : null;
  if (tokens.length === 0 && !digits) return { userIds: [], guestOrderIds: [], truncated: false };

  const nameU = tokens.length
    ? Prisma.sql`(${Prisma.join(
        tokens.map(
          t =>
            Prisma.sql`public.ebda_ar_norm(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) LIKE ${`%${escapeLike(t)}%`}`
        ),
        ' AND '
      )})`
    : Prisma.sql`false`;
  const phoneU = digits
    ? Prisma.sql`public.ebda_digits(u.phone) LIKE ${`%${digits}%`}`
    : Prisma.sql`false`;
  const emailU = email ? Prisma.sql`lower(u.email) LIKE ${email}` : Prisma.sql`false`;
  const users = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT u.id FROM users u
    WHERE u.deleted_at IS NULL AND (${nameU} OR ${phoneU} OR ${emailU})
      AND (u.store_id = ${storeId} OR EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = u.id AND o.store_id = ${storeId}))
    LIMIT ${CUSTOMER_MATCH_USER_CAP + 1}`;

  const nameG = tokens.length
    ? Prisma.sql`(${Prisma.join(
        tokens.map(
          t =>
            Prisma.sql`public.ebda_ar_norm(coalesce(o.shipping_address->>'firstName','') || ' ' || coalesce(o.shipping_address->>'lastName','')) LIKE ${`%${escapeLike(t)}%`}`
        ),
        ' AND '
      )})`
    : Prisma.sql`false`;
  const phoneG = digits
    ? Prisma.sql`public.ebda_digits(o.shipping_address->>'phone') LIKE ${`%${digits}%`}`
    : Prisma.sql`false`;
  const emailG = email
    ? Prisma.sql`lower(o.shipping_address->>'email') LIKE ${email}`
    : Prisma.sql`false`;
  const guests = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT o.id FROM orders o
    WHERE o.store_id = ${storeId} AND o.customer_id IS NULL AND o.deleted_at IS NULL
      AND (${nameG} OR ${phoneG} OR ${emailG})
    ORDER BY o.created_at DESC LIMIT ${CUSTOMER_MATCH_GUEST_ORDER_CAP + 1}`;

  return {
    userIds: users.slice(0, CUSTOMER_MATCH_USER_CAP).map(r => r.id),
    guestOrderIds: guests.slice(0, CUSTOMER_MATCH_GUEST_ORDER_CAP).map(r => r.id),
    truncated:
      users.length > CUSTOMER_MATCH_USER_CAP || guests.length > CUSTOMER_MATCH_GUEST_ORDER_CAP,
  };
}
```

`users` has no `store_id` RLS for staff-of-store reads: it is identity-keyed (`app.current_user_id`). Check this before relying on it: `grep -n "ON users" packages/database/prisma/migrations/20261004000000_ebda_strict_rls/migration.sql`. The existing `/customers/search` already reads `customer` through `orders`, the path RLS allows. If a direct `FROM users` returns 0 rows under `ebda_app`, rewrite the user arm as `SELECT DISTINCT o.customer_id FROM orders o JOIN users u ON u.id = o.customer_id WHERE o.store_id = … AND (…)`, the same shape `order.service.ts:201-240` uses. Then drop the zero-order arm. In its place, add a zero-order lookup through the `ebda_*` definer `customer-aggregate` already relies on for that union, if one exists. If none exists, record that registered customers with zero orders are not searchable (Ruling SEARCH-12). **This must be proven in the Step 1 test with an `ebda_app` client, not the owner fixture client** (CLAUDE.md: in-process suites run as owner by default).

`customer-aggregate.service.ts`: add an optional second parameter `scope?: { orderWhere: Prisma.OrderWhereInput; zeroOrderUserIds: string[] }` to `aggregateCustomersUncached`. Spread `...(scope ? scope.orderWhere : {})` into the order `where` (AND it with the existing `storeId, deletedAt` terms) and `...(scope ? { id: { in: scope.zeroOrderUserIds } } : {})` into the zero-order `where`. Add:

```ts
export async function aggregateCustomersMatching(storeId: string, search: string) {
  const m = await matchingCustomers(storeId, search);
  const r = await aggregateCustomersUncached(storeId, {
    orderWhere: { OR: [{ customerId: { in: m.userIds } }, { id: { in: m.guestOrderIds } }] },
    zeroOrderUserIds: m.userIds,
  });
  return { ...r, truncated: r.truncated || m.truncated };
}
```

In `customers.routes.ts`, make the list and export call `const aggregated = search ? await aggregateCustomersMatching(storeId, search) : await aggregateCustomers(storeId);`. Remove the `search ? bySegment.filter(...)` branch from `applyCustomerListFilters` (it then only does segments). `/customers/search` becomes `matchingCustomers` + a `findMany` of those users (select the same 5 fields) + the guest rows by id. Keep its `{ id, isGuest, firstName, lastName, email, phone }` response shape and the 10-row cap. This removes the unescaped `like = %${q}%`.

- [ ] **Step 3: Run**

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/customers-search-sql.test.ts $(ls tests/integration | grep -i customer | sed 's#^#tests/integration/#') && npm run typecheck`
Expected: PASS (new + every existing customers suite).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/admin-search.service.ts apps/api/src/services/customer-aggregate.service.ts apps/api/src/routes/customers.routes.ts tests/integration/customers-search-sql.test.ts
git commit -m "$(cat <<'EOF'
fix(api): customers search in sql with arabic names and any phone format

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 17: Orders search: number, phone in any form, Arabic names

**Files:**

- Modify: `apps/api/src/services/order.service.ts:201-300` (the two-step `orderSearchWhere` / `guestOrderIdsMatching`)
- Test: extend `tests/integration/order-search-indexes.test.ts` and `tests/integration/order-search-guest-contact.test.ts`

**Interfaces:**

- Consumes: `matchingCustomers` (Task 16)
- Produces: unchanged `OrderListWhere.search` contract. The customer-id step uses `matchingCustomers(storeId, term).userIds` (normalised name + digit phone + email). The guest step uses `.guestOrderIds`. The order-number arm stays `order_number ILIKE` with an escaped pattern, plus a digits-only arm when the term is ≥ 4 digits (`#١٢٣٤` finds `EB-1234`).

- [ ] **Step 1: Failing tests (append to the two existing files, same per-call fixture style):** `'أحمد'` finds the order of the customer stored as `'احمد'`; `'0101 234 5678'` finds a registered and a guest order stored as `+201012345678`; `'١٢٣٤'` finds order number `EB-1234`; `'%'` returns 0 rows. Keep the existing "same rows as the relation filter" assertions for Latin terms. They must still pass, which proves no regression for English.

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/order-search-indexes.test.ts tests/integration/order-search-guest-contact.test.ts`. Expected: the new cases FAIL.

- [ ] **Step 2: Implement.** Replace the body that resolves customer ids, and the `guestOrderIdsMatching` call, with one `matchingCustomers(storeId, term)` call. Keep `ORDER_SEARCH_CUSTOMER_ID_CAP` semantics: when `truncated`, fall back to the relation filter exactly as today. Build the number arm as `{ orderNumber: { contains: term, mode: 'insensitive' } }` (Prisma escapes it) OR, when `normalizeArabicSearch(term).replace(/\D/g,'')` has ≥ 4 digits, `{ orderNumber: { contains: thoseDigits } }`. Update the long doc comment above it: say that the normalised expression indexes of `20261020000100` now serve the customer arms, and keep the BitmapOr explanation.

- [ ] **Step 3: Run**

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/order-search-indexes.test.ts tests/integration/order-search-guest-contact.test.ts && npx vitest run tests/unit && npm run typecheck`
Expected: PASS. The Orders PWA (`apps/orders`) calls the same `OrderService.list`: run `grep -rn "search" apps/orders/src/lib/api* | head` and record in the PR that it inherits the change with no client edit.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/order.service.ts tests/integration/order-search-indexes.test.ts tests/integration/order-search-guest-contact.test.ts
git commit -m "$(cat <<'EOF'
fix(order): order search by any phone format, arabic names and arabic digits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 18: ⌘K palette: products, orders, customers

**Files:**

- Create: `apps/api/src/routes/admin-search.routes.ts` (`GET /stores/:storeId/search?q=`), mounted with `tenantContext` like the other `/stores` routers
- Create: `packages/shared/src/search/admin-search.ts` (`AdminSearchResponse`)
- Modify: `apps/admin/src/components/CommandPalette.tsx` (debounced record search below the navigation items)
- Modify: `apps/admin/src/i18n/messages/{ar,en}.json` (`components.commandPalette.products|orders|customers|searching|noRecords`)
- Test: `tests/integration/admin-search-route.test.ts`, `apps/admin/src/components/__tests__/CommandPalette.records.test.tsx`

**Interfaces:**

- Produces: `AdminSearchResponse = { products: Array<{ id: string; name: string; nameAr: string | null; sku: string | null }>; orders: Array<{ id: string; orderNumber: string; customerName: string; total: number }>; customers: Array<{ key: string; name: string; phone: string; isGuest: boolean }> }`, 5 of each. Route chain: `authenticate → authorize('store_admin','super_admin','staff') → requireStoreAccess`. Staff see products and orders; customers only if staff may read `/customers`, which matches `customers.routes.ts` `adminMiddleware` (it includes `staff`).

- [ ] **Step 1: Failing route test:** `q='احذيه'` returns the product; `q='0101 234 5678'` returns the customer and their order; a query shorter than 2 chars returns three empty arrays; another store's records never come back. The test builds the app with this router and the auth mocks copied from an existing `tests/integration/*-route*.test.ts`.

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/admin-search-route.test.ts`. Expected: FAIL (404).

- [ ] **Step 2: Implement the route**

```ts
// apps/api/src/routes/admin-search.routes.ts
import { Router } from 'express';
import { prisma } from '@ebda/database';
import type { AdminSearchResponse } from '@ebda/shared';
import { authenticate, authorize } from '../middleware/auth';
import { requireStoreAccess } from '../middleware/store-access';
import { searchProductIds } from '../services/product-search.service';
import { matchingCustomers } from '../services/admin-search.service';
import { OrderService } from '../services/order.service';

const router = Router();
router.get(
  '/:storeId/search',
  authenticate,
  authorize('store_admin', 'super_admin', 'staff'),
  requireStoreAccess,
  async (req, res, next) => {
    try {
      const storeId = req.params.storeId;
      const q = String(req.query.q ?? '')
        .trim()
        .slice(0, 100);
      const empty: AdminSearchResponse = { products: [], orders: [], customers: [] };
      if (q.length < 2) return void res.json({ success: true, data: empty });
      const [productIds, cust, orders] = await Promise.all([
        searchProductIds(storeId, q, { scope: 'admin', limit: 5 }),
        matchingCustomers(storeId, q),
        OrderService.list(storeId, { search: q, page: 1, limit: 5 }),
      ]);
      const [products, users] = await Promise.all([
        prisma.product.findMany({
          where: { storeId, id: { in: productIds } },
          select: { id: true, name: true, nameAr: true, sku: true },
        }),
        prisma.user.findMany({
          where: { id: { in: cust.userIds.slice(0, 5) } },
          select: { id: true, firstName: true, lastName: true, phone: true },
        }),
      ]);
      const data: AdminSearchResponse = {
        products: productIds.map(id => products.find(p => p.id === id)!).filter(Boolean),
        orders: orders.orders.map(o => ({
          id: o.id,
          orderNumber: o.orderNumber,
          customerName: [o.customer?.firstName, o.customer?.lastName].filter(Boolean).join(' '),
          total: o.total,
        })),
        customers: users.map(u => ({
          key: u.id,
          name: [u.firstName, u.lastName].filter(Boolean).join(' '),
          phone: u.phone ?? '',
          isGuest: false,
        })),
      };
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  }
);
export default router;
```

Read `OrderService.list`'s real signature and return field names (`grep -n "static async list" -A15 apps/api/src/services/order.service.ts`) and match them exactly; the `orders.orders`, `customer`, `total` names above must be replaced 1:1. The `prisma.user.findMany` by id runs under the request's tenant context. If the RLS check in Task 16 showed that `users` is not readable that way, fetch the 5 customers through `orders` the way Task 16 settled it, and reuse that helper rather than duplicating it.

- [ ] **Step 3: Palette.** Add state `records: AdminSearchResponse | null` and an effect that, 200 ms after `query` changes and if `query.trim().length >= 2`, calls `apiGet<AdminSearchResponse>(\`/api/v1/stores/${storeId}/search?q=${encodeURIComponent(query)}\`)`. `storeId`comes from`useParams()`(the palette mounts inside store routes; when there is no`id`param, skip the effect). Abort stale requests with an`AbortController`whose`signal`goes to`apiGet`(check that`lib/api.ts`accepts`init`; if not, keep a request counter and drop out-of-order replies). Render three groups under the navigation list, headed `t('products')`, `t('orders')`and`t('customers')`, and wire them into the same keyboard `active`index. On Enter or click, navigate to`/stores/${storeId}/products/${id}/edit`, `/stores/${storeId}/orders/${id}`and`/stores/${storeId}/customers/${encodeURIComponent(key)}`. Check that each route exists with `ls apps/admin/src/app/stores/[id]/{products/[productId]/edit,orders,customers}`. While loading show `t('searching')`, and with zero records show `t('noRecords')`. i18n ar: `منتجات`/`طلبات`/`عملاء`/`بيدور…`/`مفيش نتايج`.

Component test: mock `apiGet`, type `احمد`, advance timers 200 ms, and assert that the customer row renders and that ArrowDown + Enter calls `router.push` with the customer URL.

- [ ] **Step 4: Run + drive**

Run: `DATABASE_URL=$TEST_DB npx vitest run tests/integration/admin-search-route.test.ts && npx vitest run apps/admin/src/components/__tests__/CommandPalette.records.test.tsx tests/unit/admin-i18n-key-parity.test.ts && npm run typecheck && npm run lint`
Then run `dev:api` + `dev:admin` in the Arabic admin and press ⌘K. Type `احمد`, then `٠١٠`, then an order number. Take a screenshot each time and attach them to PR 5.
Expected: PASS; three groups render RTL.

- [ ] **Step 5: Commit (PR 5)**

```bash
git add apps/api/src/routes/admin-search.routes.ts apps/api/src/routes/index.ts packages/shared/src/search apps/admin/src/components/CommandPalette.tsx apps/admin/src/components/__tests__/CommandPalette.records.test.tsx apps/admin/src/i18n/messages/ar.json apps/admin/src/i18n/messages/en.json tests/integration/admin-search-route.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): command palette searches products, orders and customers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

**PR 5 follow-ups (tracked in ROADMAP "Search program").** CONTRACT migration dropping the unused per-key trigram indexes and the `ebda_order_search_ids` kinds `guest`/`customers` (SEARCH-P2-5), after the P2 deploy is confirmed and never in the same deploy; removal of the deprecated `?search=`/`?q=` fallbacks one release after the header-sending clients ship (SEARCH-P2-9).

**PR 5 boundary.** **STOP-5** (pre-build the 4 indexes CONCURRENTLY on production before deploy) → merge → deploy → verify live: ⌘K on a real store in Arabic, plus `pg_stat_user_indexes.idx_scan > 0` on the new indexes after a day (read-only, by Ahmad).

---

# PHASE P3: catalogue import from photos/PDFs (PR 6, `feat/search-p3-catalog-import`)

## Task 19: Catalogue import tables

**Files:**

- Create: `packages/database/prisma/migrations/20261021000100_catalog_import/migration.sql`
- Modify: `packages/database/prisma/schema.prisma` (`CatalogImportJob`, `CatalogImportItem`, back-relations on `Store`)
- Test: `tests/integration/catalog-import-schema.test.ts`

**Interfaces:**

- Produces: `CatalogImportJob { id, storeId, status: 'queued'|'processing'|'review'|'failed'|'done', sourceUrls Json (string[]), pageCount Int, itemCount Int, error String?, createdBy String?, createdAt, updatedAt }`; `CatalogImportItem { id, jobId, storeId, page Int, name String, nameAr String?, description String?, descriptionAr String?, price Int? (piastres), sku String?, confidence Float, status: 'pending'|'accepted'|'rejected'|'created', productId String?, createdAt, updatedAt }`. FKs: job→store CASCADE, item→job CASCADE, item→store CASCADE, item.productId→products SET NULL. Both tables get the strict RLS policy.
- Viewer: Task 21 review screen + the jobs list on the Bulk page.

- [ ] **Step 1:** Write the test (both tables forced RLS with 1 policy; deleting a job cascades its items; deleting a product sets `product_id` NULL). Run it and watch it FAIL.
- [ ] **Step 2:** Write the migration in the exact shape of `20261016000900_size_charts` (CREATE TABLE ×2, indexes `(store_id, created_at DESC)` on jobs and `(job_id)` on items, FKs as above, `CHECK` constraints on both `status` columns listing the enum values, RLS ENABLE/FORCE/POLICY/GRANT ×2). Add the Prisma models with `@@map("catalog_import_jobs")` / `@@map("catalog_import_items")`.
- [ ] **Step 3:** Run `npm run db:generate && npm run gen:tenant-guard-schema -w packages/database && DATABASE_URL=$TEST_DB DIRECT_URL=$TEST_DB npx prisma migrate deploy --schema packages/database/prisma/schema.prisma && DATABASE_URL=$TEST_DB npx vitest run tests/integration/catalog-import-schema.test.ts tests/integration/rls-ebda-app.test.ts && npx vitest run tests/unit/tenant-guard-schema-snapshot.test.ts`. Expected: PASS.
- [ ] **Step 4: Commit**

```bash
git add packages/database/prisma/migrations/20261021000100_catalog_import packages/database/prisma/schema.prisma packages/database/src/tenant-guard-schema.generated.ts tests/integration/catalog-import-schema.test.ts
git commit -m "$(cat <<'EOF'
feat(database): catalogue import jobs and items under strict rls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 20: Upload + Gemini vision extraction on Inngest

**Files:**

- Create: `apps/api/src/services/catalog-import.service.ts`
- Create: `apps/api/src/lib/inngest/functions/catalog-import-extract.ts` (register in `functions/index.ts`)
- Create: `apps/api/src/routes/catalog-import.routes.ts` (mount under `/stores` with `tenantContext`)
- Modify: `apps/api/src/services/ai.service.ts` (`Feature` + `'catalog-import'`), `apps/api/src/services/accounting/gemini-ai.service.ts` only if `callGemini`'s feature type is `AccountingAiFeature`. In that case, do NOT widen it. Write `extractCatalogPage` with `GeminiFailoverClient` directly (as Task 8 does) and keep accounting's types untouched.
- Test: `tests/unit/catalog-import-extract.test.ts`, `tests/integration/catalog-import-route.test.ts`

**Interfaces:**

- Produces: `POST /api/v1/stores/:storeId/catalog-import` (multipart `files[]`, ≤ 10 files, each ≤ 10 MB, `image/jpeg|png|webp|application/pdf`) → 202 `{ jobId }`; `GET /api/v1/stores/:storeId/catalog-import` (last 20 jobs); `GET …/:jobId` (job + items); `extractCatalogPage({ storeId, mimeType, base64 }): Promise<ExtractedItem[]>`, where `ExtractedItem = { name: string; nameAr: string | null; description: string | null; descriptionAr: string | null; priceEgp: number | null; sku: string | null; confidence: number }`; event `catalog-import/extract` `{ storeId, jobId }`.
- Caps: env `CATALOG_IMPORT_DAILY_JOBS_PER_STORE` (default 5) is checked in the route (counts today's jobs; 429 above it). Every Gemini call goes through `assertAiQuota({ storeId, bulk: true })`. At most 30 pages per job (PDF pages are read by Gemini natively as `application/pdf`, so one call per file, capped by the `pageCount` estimate `≤ 30`).

- [ ] **Step 1: Failing unit test for the extractor** (mock `GeminiFailoverClient` as in Task 8). It must assert:
  - the prompt demands JSON `{ "items": [...] }` and says "prices in EGP as numbers, Arabic as written, never invent".
  - `priceEgp` of `"١٢٥ ج.م"` coming back as a string is parsed to `125`, and a non-numeric price becomes `null`.
  - items with an empty name are dropped.
  - at most 200 items are kept per file.
  - `recordUsage` is called with `'catalog-import'`.

- [ ] **Step 2: Implement `catalog-import.service.ts`.**
  - `extractCatalogPage`: the prompt as above, `inlineData` with the file's mime type, `parseAiJson`, then normalise each item. Use `normalizeArabicSearch(...).replace(/[^0-9.]/g,'')` for digit folding in prices.
  - `processJob(storeId, jobId)`: load the job, set `processing`, and for each `sourceUrl` fetch the bytes. Fetch them with `fetch()` from R2's public URL; the URL must start with the configured R2 public base, so this is not an SSRF. Assert it with the same check `StorageService` uses (find it with `grep -n "publicUrl\|PUBLIC_BASE" apps/api/src/services/storage.service.ts`). Then call `extractCatalogPage` and `createMany` the items with `price = Math.round(priceEgp*100)`. Throttle `AI_BULK_THROTTLE_MS` between files.
  - Set `review` with `itemCount`. Any error sets `failed` + `error`, and a quota-cap error sets `failed` with `error='AI_QUOTA'`, so the UI shows "try again tomorrow".
- [ ] **Step 3: Inngest function.** `concurrency: { key: 'event.data.storeId', limit: 1 }`, `retries: 2`, one `step.run('extract', () => runInStoreScope(storeId, () => processJob(storeId, jobId)))`.
- [ ] **Step 4: Route.** It follows `expenses.routes.ts` `upload-receipt`: `authenticate, authorize('store_admin','super_admin'), requireStoreAccess, uploadLimiter, dailyUploadLimiter`, then a multer `.array('files', 10)` built like `receiptUpload` with the PDF mime added. `StorageService.isAvailable()` → 503. Images go through `enforceMaxDimensions` (PDFs are skipped). Upload with `StorageService.upload(buf, name, { folder: 'misc', storeId, contentType, allowedTypes: [...] })`. Create the job `queued`, then `inngest.send('catalog-import/extract')`. **On a send throw, update the job to `failed` with `error: 'ENQUEUE_FAILED'` and return 503** (queue-then-send fails fast).
- [ ] **Step 5: Retention.** Add `catalogImportPurge` to `data-retention.ts`: weekly, deletes jobs older than 30 days (items cascade) and deletes their R2 source files through `StorageService.delete` (each in `try`, logged). Add the `docs/RETENTION.md` row + cron row and the `docs/privacy/data-map.md` row (catalogue photos may contain a merchant's phone number; kept ≤ 30 days).
- [ ] **Step 6: Route integration test.**
  - 202 + a job row on a valid PNG, with `StorageService.upload` and `inngest.send` mocked.
  - `inngest.send` throwing leaves the job `failed` + `ENQUEUE_FAILED`.
  - a 6th job the same day returns 429.
  - another store's `jobId` returns 404 (RLS/tenant guard).
- [ ] **Step 7: Run** `npx vitest run tests/unit/catalog-import-extract.test.ts && DATABASE_URL=$TEST_DB npx vitest run tests/integration/catalog-import-route.test.ts && npm run typecheck`. Expected: PASS.
- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/catalog-import.service.ts apps/api/src/lib/inngest/functions/catalog-import-extract.ts apps/api/src/lib/inngest/functions/index.ts apps/api/src/lib/inngest/functions/data-retention.ts apps/api/src/routes/catalog-import.routes.ts apps/api/src/routes/index.ts apps/api/src/services/ai.service.ts docs/RETENTION.md docs/privacy/data-map.md docs/ENVIRONMENT.md tests/unit/catalog-import-extract.test.ts tests/integration/catalog-import-route.test.ts
git commit -m "$(cat <<'EOF'
feat(api): catalogue import from photos and pdfs with gemini vision on inngest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 21: Review screen → create draft products

**Files:**

- Modify: `apps/api/src/routes/catalog-import.routes.ts` (+ `PATCH …/:jobId/items/:itemId`, `POST …/:jobId/create-drafts`)
- Modify: `apps/admin/src/app/stores/[id]/bulk/_components/BulkTabs.tsx` (tab "من صور أو PDF" / "From photos or PDF") + new `_components/CatalogImportPanel.tsx` (upload + job list)
- Create: `apps/admin/src/app/stores/[id]/bulk/catalog-import/[jobId]/page.tsx` (review table)
- Modify: i18n `{ar,en}.json` (`bulk.catalogImport.*`)
- Test: `tests/integration/catalog-import-create-drafts.test.ts`, `apps/admin/src/app/stores/[id]/bulk/catalog-import/[jobId]/page.test.tsx`

**Interfaces:**

- Produces: `PATCH` body `{ name?, nameAr?, description?, descriptionAr?, price?: number | null, sku?, status?: 'accepted'|'rejected' }` (Zod; `price` in piastres). `POST create-drafts` creates a product with `ProductService.create(storeId, { name, nameAr, description, descriptionAr, price: price ?? 0, sku, status: 'draft' })` for each `accepted` item whose `productId` is null. It sets the item to `created` + `productId` and returns `{ created: number }`. Because it goes through `ProductService.create`, it fires `product.upserted` → autofill (translation, search terms) + search indexing for free.

- [ ] **Step 1: Failing test.**
  - 3 items (accepted, rejected, accepted-with-null-price) → `create-drafts` → 2 draft products.
  - the null price becomes 0 and the product is `draft`, never `active`, so a 0 price can never be bought.
  - re-running creates 0 (idempotent through `productId`).
  - `ProductService.create`'s `inngest.send` mock was called twice.
- [ ] **Step 2: Implement.** Write the two routes (same middleware chain). The loop over items runs one `ProductService.create` per item in the request context. Cap it at 200 items per call, and wrap each create in `withSavepoint` so one bad SKU (unique clash) does not abort the rest: collect it as an error row and return `{ created, errors: [{ itemId, code }] }`.
- [ ] **Step 3: Admin.**
  - `CatalogImportPanel`: a file input (`accept="image/*,application/pdf"`, multiple), the upload with `apiPost` FormData, and the job list (status chip; `review` links to the review page; `failed` shows the reason: `AI_QUOTA` → "الحد اليومي للذكاء الاصطناعي خلص، جرّب بكرة"). It polls every 5 s while any job is `queued|processing`.
  - Review page: a table of items with inline editable name/nameAr/price (EGP input converted with `Math.round(x*100)`) and SKU, accept/reject toggles, the confidence shown as a chip under 0.6 ("راجع ده" / "Check this"), and the primary button "اعمل مسودات للمنتجات المقبولة" / "Create drafts for accepted items". After success, it links to `/stores/${id}/products?status=draft`.
  - All copy goes in i18n, and the page renders RTL.
- [ ] **Step 4: Run + drive.** Run `DATABASE_URL=$TEST_DB npx vitest run tests/integration/catalog-import-create-drafts.test.ts && npx vitest run "apps/admin/src/app/stores/[id]/bulk" tests/unit/admin-i18n-key-parity.test.ts && npm run typecheck && npm run lint`. Then do the real flow locally with a real `GEMINI_API_KEY`: upload one Arabic price-list photo, wait for `review`, edit one price, create drafts, and open the products list filtered to drafts. Take screenshots (Arabic, 390 px + desktop) for PR 6.
- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/catalog-import.routes.ts "apps/admin/src/app/stores/[id]/bulk" apps/admin/src/i18n/messages/ar.json apps/admin/src/i18n/messages/en.json tests/integration/catalog-import-create-drafts.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): review extracted catalogue items and create draft products

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

## Task 22: Offline head-to-head: Gemini vision vs Baidu Unlimited-OCR (optional evaluation, never runtime)

**Files:**

- Create: `scripts/eval/catalog-ocr-head-to-head.ts`
- Create: `scripts/eval/catalog-ocr-pages/README.md` (where to put the 10 pages + the hand-written truth file; the pages themselves are NOT committed: they are merchant material)
- Create: `tests/unit/no-eval-scripts-in-runtime.test.ts`

**Interfaces:**

- Input: `scripts/eval/catalog-ocr-pages/*.{jpg,png,pdf}` (10 real Arabic catalogue pages Ahmad provides, **STOP-6**) and `truth.json`, which maps each file to `[{ name, priceEgp }]` and is hand-written by Ahmad or the implementer from the page.
- Output: a table per page and overall: item recall (name match after `normalizeArabicSearch` + Levenshtein ≤ 2), price accuracy (exact), and wall time. Gemini goes through `extractCatalogPage`. Unlimited-OCR goes through `UNLIMITED_OCR_URL` (an HF Space or Baidu Cloud endpoint Ahmad picks) whose markdown output is turned into items by the SAME Gemini text-only structuring call, so only the OCR stage differs. Results go to `scripts/eval/catalog-ocr-results-<date>.md`, to be summarised in Ruling SEARCH-14.

- [ ] **Step 1: Guard test first.** No runtime code may import the eval script or call the Unlimited-OCR endpoint:

```ts
// tests/unit/no-eval-scripts-in-runtime.test.ts
import { execSync } from 'node:child_process';
import { it, expect } from 'vitest';
it('apps never import scripts/eval or reference UNLIMITED_OCR_URL', () => {
  const out = execSync(
    `grep -rlE "scripts/eval|UNLIMITED_OCR_URL" apps packages --include=*.ts --include=*.tsx || true`,
    { encoding: 'utf8' }
  );
  expect(out.trim()).toBe('');
});
```

Run: `npx vitest run tests/unit/no-eval-scripts-in-runtime.test.ts`. Expected: PASS now, and it stays green after Step 2.

- [ ] **Step 2: Write the script.**
  - Top-of-file doc: offline only, never deployed. It costs Gemini quota (≈ 20 calls) and the third-party endpoint's own cost. It runs with `GEMINI_API_KEY=… UNLIMITED_OCR_URL=… npx tsx scripts/eval/catalog-ocr-head-to-head.ts`.
  - For each page: time `extractCatalogPage`. Then POST the file to `UNLIMITED_OCR_URL` (multipart `file`, expecting `{ markdown }`; adapt to the chosen endpoint's documented contract and write that contract in the README). Feed the markdown to a text-only `extractCatalogPage` variant (`extractCatalogFromText`, defined in this script, not in the app).
  - Score both against `truth.json` with an inline `levenshtein` (15 lines; no new dependency) and print the table.
  - Exit 0 always: it is an evaluation, not a gate.
- [ ] **Step 3: Run it** once the pages exist. If they do not exist yet, record "NOT RUN — waiting on STOP-6" in the PR body (state the unblock condition, do not claim a result).
- [ ] **Step 4: Commit (PR 6)**

```bash
git add scripts/eval/catalog-ocr-head-to-head.ts scripts/eval/catalog-ocr-pages/README.md tests/unit/no-eval-scripts-in-runtime.test.ts
git commit -m "$(cat <<'EOF'
test(product): offline gemini vs unlimited-ocr catalogue head-to-head script

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

**PR 6 boundary.** Migration `20261021000100` adds only new tables, so there is no pre-build. Merge → deploy → live check: upload one real page on a test store in production (a guest-shaped write of the merchant's own data, allowed; it creates drafts only, never an active product).

---

## STOP points (Ahmad only; the implementer stops and reports the unblock condition)

| ID      | When                                                                                                                                                                                                                                                                                                                                                                         | What Ahmad does                                                                                                                                                                                            | Unblock evidence                                                                                                                                                                                                                                                                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STOP-1  | Before deploying PR 1                                                                                                                                                                                                                                                                                                                                                        | Run the two `CREATE INDEX CONCURRENTLY` (and the functions + `ADD COLUMN`) from migration `20261018000100`'s header on production `DIRECT_URL`; check `NOT indisvalid` = 0 rows                            | psql output pasted in the PR                                                                                                                                                                                                                                                                                                                 |
| STOP-2  | Before deploying PR 3                                                                                                                                                                                                                                                                                                                                                        | Read-only `SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name='vector'` on production; need ≥ 0.7 (halfvec). The migration then creates it during `cf-api-deploy.yml` | Query output in the PR                                                                                                                                                                                                                                                                                                                       |
| STOP-3  | Before deploying PR 3                                                                                                                                                                                                                                                                                                                                                        | Accept Workers AI billing on the Ebda Cloudflare account (bge-m3 $0.0118/M input tokens; free daily neurons first) and dispatch `cf-api-deploy.yml` with the `ai` binding                                  | `wrangler deployments list --name ebda-api` + the dashboard showing the binding                                                                                                                                                                                                                                                              |
| STOP-3b | After STOP-4 backfill + the Task 8 search-words autofill on the store's catalogue + the synthetic eval passing (it does since the second vector, SEARCH-T13-7: two runs, franco +3, floors +1) + `npm run search:eval -- --real` RE-RUN ON THE FIRST REAL CATALOGUE meeting the SEARCH-10 bar with the msa/en floors (SEARCH-T13-4; the synthetic run alone never clears it) | Set `SEARCH_SEMANTIC_ENABLED=true` on `ebda-api` (wrangler var)                                                                                                                                            | `/health` + one Arabic search returning a semantic-only hit                                                                                                                                                                                                                                                                                  |
| STOP-4  | Before the first production backfill (autofill sweep filling `searchTerms` for every product = Gemini bulk quota; the indexer embedding every product = Workers AI)                                                                                                                                                                                                          | Approve the run window and the caps (`SEARCH_EMBED_STORE_DAILY_CAP`, `AI_DAILY_REQUEST_CAP` interactive reserve)                                                                                           | A written go in the PR; then the searches page shows "N of M" climbing. Note: `SEARCH_EMBED_STORE_DAILY_CAP` counts DISTINCT products embedded per Cairo day, not provider calls, so it does not bound spend from repeated edits of the same product (SEARCH-T11-2); `SEARCH_EMBED_STORE_DAILY_CAP=0` stops all indexer calls (SEARCH-T11-8) |
| STOP-5  | Before deploying PR 5                                                                                                                                                                                                                                                                                                                                                        | Pre-build the 4 `users`/`orders` expression indexes CONCURRENTLY on `DIRECT_URL`, off-peak; check none INVALID                                                                                             | psql output in the PR                                                                                                                                                                                                                                                                                                                        |
| STOP-6  | For Task 22                                                                                                                                                                                                                                                                                                                                                                  | Provide 10 real Arabic catalogue pages (with the merchant's consent) + pick the Unlimited-OCR endpoint (HF Space or Baidu Cloud) and its key                                                               | Files present locally, not committed                                                                                                                                                                                                                                                                                                         |

## Rulings + assumptions (append to `docs/RULINGS.md` in the PR that implements them)

- **Ruling SEARCH-1:** Lexical search runs on trigram GIN _expression_ indexes over an IMMUTABLE normaliser, not a generated column. Evidence: Prisma would read a generated column on every product select, and P1 would need a table rewrite to change it, whereas an expression index adds nothing to row payloads. Cost if wrong: every query must repeat the exact function call to hit the index; a hand-written variant silently seq-scans (pinned by the EXPLAIN test in Task 2).
- **Ruling SEARCH-2:** The fold uses no Unicode `normalize()` and no locale lowercasing (ASCII A-Z only), in both TS and SQL. Evidence: neither is reproducible as an IMMUTABLE Postgres function, so they would break parity. Cost if wrong: uppercase accented Latin (É) and presentation-form Arabic ligatures are not folded; both are rare in Egyptian queries.
- **Ruling SEARCH-3:** `products.search_terms` ships in P0 as a manual field, before AI fills it. Evidence: it fixes the doc functions' signature, so P1 needs no index rebuild, and merchants can add "3abaya" from day one. Cost if wrong: an empty column on most rows until P1, which costs nothing.
- **Ruling SEARCH-4:** The search log stores a normalised term + counts per Cairo day, with no identity; phone/email/ID-shaped terms are dropped; retention is 90 days. Evidence: what merchants need is "what wasn't found", not who searched. Cost if wrong: no per-session funnel analysis (out of scope).
- **Ruling SEARCH-5:** The searches page is not behind `requireAnalyticsTier`. Evidence: it is a core catalogue-fixing tool, and its viewer is every merchant (every-data-needs-UI). Cost if wrong: one analytics feature outside the paid tier.
- **Ruling SEARCH-6:** Typeahead stays lexical-only and is not logged. Evidence: latency, and logging keystrokes would pollute the log with prefixes. Cost if wrong: a dialect-only term finds nothing in the dropdown until Enter (the full search page has the vector leg).
- **Ruling SEARCH-7:** pgvector `halfvec(1024)` for bge-m3. The CI/compose image is `pgvector/pgvector:0.8.0-pg17` (production's major; SEARCH-T9-4), and the dims are measured in Task 10 Step 1. Cost if wrong: an image pull fails in CI, which is loud, not silent.
- **Ruling SEARCH-8:** Exact KNN per store (btree `store_id` + ORDER BY distance), no HNSW. Evidence: per-store catalogues are hundreds to low thousands of rows [i], and filtered HNSW has a recall trap. Cost if wrong: a 20k+ product store pays a slower vector leg; revisit with `EXPLAIN ANALYZE` when any store passes 20k.
- **Ruling SEARCH-9:** The embed doc covers names, search terms and descriptions only, not variant option values or category names. Evidence: it keeps staleness detectable in pure SQL (content hash), and the AI search terms already carry category vocabulary. Cost if wrong: "فستان احمر" relies on lexical match for a colour that exists only as a variant option.
- **Ruling SEARCH-10:** Semantic search ships OFF and is turned on only when the eval bar holds: hybrid recall@10 ≥ 0.90, dialect and franco each ≥ 0.80, MRR ≥ 0.70, no msa/en regression > 0.02, and a dialect+franco lift ≥ 0.15 over lexical. Cost if wrong: a bar that is too strict leaves a working feature off; the eval output in PR 4 makes that visible.
- **Ruling SEARCH-11:** The index is BOUNDED-stale (debounce 20 s + the Inngest queue; backstop ≤ 6 h for any missed writer). It never serves price, stock or status, which are read live and filtered in the same SQL. Cost if wrong: a just-renamed product ranks by its old name for up to ~1 min.
- **Ruling SEARCH-12:** Customer search covers registered customers through their orders in this store (RLS-readable). Zero-order registered customers are searchable only if Task 16's RLS check proves they are readable through an existing definer; otherwise this is a documented residual. Cost if wrong: a merchant cannot find a customer who signed up and never ordered by searching (the list without search still shows them).
- **Ruling SEARCH-13:** The old raw-column trigram indexes (`products_{name,name_ar,description,description_ar}_trgm_idx`, `users_*_trgm_idx`, `orders_guest_*`) are NOT dropped in this program. Evidence: DB-INDEX-MIGRATIONS requires a drop to be its own reviewed migration with `idx_scan = 0` evidence over time. Unblock: 30 days after PR 1/PR 5, read `pg_stat_user_indexes` and drop in a follow-up. Cost if wrong: extra write amplification on products/users/orders until then.
- **Ruling SEARCH-14:** Unlimited-OCR is evaluated offline only and never enters runtime. Evidence: it needs a CUDA GPU host (a second runtime and ops surface), and Gemini vision already runs on Inngest. Cost if wrong: if it clearly beats Gemini on long Arabic PDFs, a GPU path is a separate decision with its own plan.

**Assumptions labelled:**

- [m] Everything in "Verified facts".
- [i] Per-store catalogues are under 20k products. The query embed adds about 30-80 ms. Logging every list search is fine because Worker responses are not CDN-cached (Task 5 Step 7 measures it).
- [g] The cost of AI search terms (≈ one Flash Lite call per product per content change); Task 8 Step 6 and STOP-4 bound it.

## Self-review (done while writing)

- **Spec coverage:**
  - P0 log + privacy + retention + erasure → Task 5 (erasure: no identity, store cascade; documented).
  - Zero-result card/page → Task 6.
  - Normalisation in SQL+TS with tests → Tasks 1-2.
  - Storefront + typeahead + admin product search → Task 3.
  - P1 terms + editable → Tasks 4 and 8.
  - Embeddings + binding + fallback → Tasks 9-10.
  - Every write path → Task 11 table + guard test.
  - RRF + lexical typeahead → Task 12.
  - Eval 200 + bar → Task 13.
  - k6 → Task 14.
  - Cost caps → Tasks 8, 11, 20.
  - Backfill → Task 8 (sweep) + Task 11 (backstop).
  - P2 customers SQL / phone / orders / ⌘K → Tasks 15-18.
  - P3 vision import + review + drafts + quota + Inngest → Tasks 19-21.
  - Optional head-to-head → Task 22.
  - STOP points → table above.
- **Placeholder scan:** three spots tell the implementer to read the real identifiers before compiling: Task 12 Step 4's `listPublic` locals, Task 18's `OrderService.list` fields and Task 8's Gemini key accessor. Each names the exact file and line range to read and says the snippet's names are replaced 1:1. Those identifiers differ per file and guessing them would be wrong. No step leaves code unwritten.
- **Type consistency:** `searchProductIds(storeId, raw, { scope, field?, limit? })` is used identically in Tasks 3, 12, 13 and 18. `matchingCustomers` → `{ userIds, guestOrderIds, truncated }` is the same in Tasks 16-18. `indexStore` / `findStaleProducts` / `storeIndexStatus` match between Tasks 11, 12 and 13. `EMBED_DIMS = 1024` matches `halfvec(1024)`.
