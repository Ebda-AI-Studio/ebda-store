# Delete the Five Old Force Skins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the five inherited Force skins (`apps/web/src/templates/{modern,elegant,classic,minimal,bold}`) and every code path, card path, rule, test, snapshot, registry entry and enum value that exists only for them, without breaking any production store and without breaking any saved page document, revision or theme that still contains an old skin name.

**Architecture:** Three PRs in a fixed order, with a data gate and an Ahmad-approved production step between them, because a Postgres enum cannot lose a value while a row uses it and a deployed reader must already tolerate the old value before the writer stops producing it (expand, migrate, contract):

1. **PR A (safe, additive):** a read-only preflight SQL gate; the ruling table that maps each old skin to the nearest Ebda template + look; a tolerant reader (`normalizeLegacyTemplate`) so old values still parse everywhere; a strict writer limited to `updateTemplate` and the admin picker (signup and the default template are fixed in a separate PR, see Precondition); a dry-run-first migration script that moves any remaining old-skin store to its mapped Ebda look, keeping its content.
2. **STOP 1 (Ahmad):** the preflight shows zero old-skin stores (after the script ran on the approved list). The production run of the migration script is Ahmad's approval, not an agent action.
3. **PR B (deletion):** re-home the shared storefront components that Qamar and Souq still import from `templates/minimal/*` into a skin-less `templates/base/`, delete the five skin directories and everything keyed on them, rewrite the CLAUDE.md platform-level rules and `store-theme-flags.md` in the same PR.
4. **PR C (enum contract):** after PR B is deployed and the preflight is still zero, a migration replaces the `StoreTemplate` enum without the five values and moves the column default.

**Order constraint:** the program order is Souq → Jasmine → Lamma → Dahab → this plan. It starts after the Dahab redesign ships (the old `templates/dahab` night skin and its own old-skin handover code are retired by that work, and the card-path list below depends on what Dahab leaves behind), and after Souq has merged (Souq imports `../minimal/*`, exactly as Qamar does).

**Tech Stack:** Prisma + Neon (Postgres 17, strict RLS, tenant guard), Zod in `@ebda/shared`, Next.js 16 (apps/web, apps/admin, apps/marketing), Express on Cloudflare Workers (apps/api), Vitest, `tsx`/Node scripts.

**Spec / read with it:** `docs/ebda/templates/{looks,qamar,dahab}.md` (+ `souq.md`), `docs/plans/done/2026-10-15-phase-b1-qamar.md` (Rulings B1-1 "Qamar owns chrome only; cards, PDP, cart and checkout stay shared/minimal" and B1-17), `docs/plans/done/2026-10-14-looks-phase-s.md` (LOOKS-5, LOOKS-8..10), `docs/ROLLBACK.md` ("enum value added" section), `docs/architecture/store-theme-flags.md`, `CLAUDE.md` § Platform-level fixes.

## What the code says today (measured on `origin/main` at `ab6417fce`, 2026-10-21)

- `StoreTemplate` enum = `modern classic minimal bold elegant dahab qamar`; `stores.template` is the ONLY column using it.
- `TemplateId` (`packages/shared/src/types/store-theme.ts:26`) is the same union; it is the key of six exhaustive `Record<TemplateId, …>` maps (`TEMPLATE_THEMES`, `TEMPLATE_LAYOUT_BASELINES`, `image-standards`, web `templates/index.ts`, `serverTemplate.ts`, `pack-styles.ts`) plus `apps/marketing/src/lib/demo-stores.ts` (`DEMO_STORES`).
- **Precondition, owned by another PR:** self-serve signup offering the old five (`SELF_SERVE_TEMPLATES`) and the `modern` column/brand-theme default are being fixed NOW in their own PR. This plan only references it: PR A starts after that PR merges, and Task 1's gate re-checks that no new store appears on an old skin. This plan does not touch `onboarding.service.ts`, `onboarding.routes.ts`, `TemplateStep.tsx` or the default.
- **`minimal` is not only an old skin; it is today's shared base.** `templates/qamar/index.ts` and `templates/souq/index.ts` re-export `../minimal/{Footer,Hero,ProductCard,ProductGrid,CategoryCard,CategoryGrid,AnnouncementBar,CartTable,OrderSummary,EmptyState,FormCard}` (Ruling B1-1: cards, PDP, cart and checkout stay shared/minimal). And **12 of the 15 looks** in `packages/shared/src/looks/registry.ts` carry `skin: 'minimal'` (souq ×3 until Souq flips them, jasmine ×3, lamma ×3, dahab ×3 until the Dahab redesign sets its skin); `applyLook` writes `stores.template = look.skin`. So a store on `jasmine.bloom` has `template = 'minimal'` in the database and is NOT an old-skin store. The gate and the migration therefore classify by `look`, never by `template` alone.
- Old-skin identifiers also live in: 5 `DESIGN.md` files, `TEMPLATES` entries with `/templates/<id>.png` thumbnails, `TemplateFamily` mapping, `skins.*` i18n keys (`template.page.skins.*`), demo clone scripts, `docs/architecture/store-theme-flags.md` (flag rows that only one old skin reads: `rtlPolish` for elegant's `EmptyState`, `personaChromeV2` for bold's header/footer), `CLAUDE.md` rules 1 and 2. `FontFamily` also has a `'modern'` value (`store-theme.ts:31`, `settings-schema.ts:339`): it is a different enum and is a known false positive for every grep below.
- ~143 files mention one of the five names as a quoted string; ~35 reference `templates/<old>/`; 6 files use snapshot assertions (`git grep -E "toMatchSnapshot|toMatchInlineSnapshot"`), none is a committed `.snap` file for an old skin by name (verify in Task 6).

## Global Constraints

- **No production store may change appearance by accident.** A store still on an old skin is moved by the migration script to a mapped Ebda look with `design:'keep'` (its colours and fonts), and its content (hero slides, products, copy, blocks) is untouched. A store that is already on an Ebda look is never touched.
- **Content kept, always:** the script calls `StoreService.applyLook` (the existing path: `applyTemplateFamily` semantics of Rulings B1-3/C6/C8, one transaction, a `store_page_revisions` row so the previous state is restorable). It never edits `stores.template` directly.
- **Old values must keep parsing forever.** Saved page documents, `store_page_revisions` rows, `stores.theme` JSON, `layout_settings`, backups and restores can all contain an old skin name. Every reader maps through `normalizeLegacyTemplate()`; only writers are strict (Task 3). A restore of a pre-deletion revision must not 500.
- **Enum contract is last and guarded.** The migration refuses (`RAISE EXCEPTION`) if any `stores.template` row still holds a removed value, and is the only place the enum changes. `lock_timeout` is not set (B0-50). Rollback = `ALTER TYPE … ADD VALUE IF NOT EXISTS` for the five values (additive, trivially reversible); documented in `docs/ROLLBACK.md` in the same PR.
- **Production access:** the preflight is `SELECT` only. Every production write (the migration script's `--yes-production` run, the contract migration's deploy) is a STOP for Ahmad. An agent runs the dry run against a local or throwaway database only. Pre-launch note: Ebda is not launched, but that rule is for seeds and backfills Ahmad has already approved; this plan asks for the approval explicitly at STOP 1 and STOP 2 because it changes live merchants' storefronts.
- **Tenant guard:** every Prisma query in scripts and services carries a top-level `storeId` = the ambient store; the script uses `createPrismaClient({ role: 'owner' })` and binds a tenant scope per store (`runInStoreScope`) exactly as the seeds do; `withOwnerTx` and `withRlsBypass` stay out of `apps/api/src`.
- **Platform-level, no slug branching:** the ruling table maps by skin id (and by the store's vertical when onboarding recorded one), never by `store.slug`.
- **Doc parity in the same PR as the code:** `CLAUDE.md` (card paths and rule 2), `docs/architecture/store-theme-flags.md`, `docs/ebda/templates/{looks,qamar,souq,dahab}.md`, `docs/ROLLBACK.md`, `docs/RULINGS.md`, `docs/ENVIRONMENT.md` only if an env var changes (none expected).
- **No product-card render path is added; four are removed** (the old skins' cards). The Taste bar and Arabic-first rules apply to anything visible: the only merchant-visible text added is the migration notice (Task 4), written in Egyptian Arabic first.
- Commits: `git add <explicit paths>` only (never `-A` or `.`; a deletion PR stages each deleted path by name via `git rm`), lowercase commitlint subjects, never `--no-verify`, blank line before the trailers, and every commit ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5`
- Gates are run with the exit code captured on the command itself, never through a pipe (`cmd; echo "exit=$?"`).

## Review Focus

1. **A store whose `template` is `minimal` but whose `look` is `jasmine.bloom`** (an Ebda store that renders on the shared base) must be classified as already migrated by the gate, untouched by the script, and unchanged after PR B. The opposite error (treating it as an old-skin store and re-looking it) changes a live merchant's look. Pinned by Task 1's classification test with that exact fixture.
2. **A revision saved before deletion is restored after deletion** (a page document or theme containing `"template":"elegant"`): it parses, normalizes to the mapped template, and renders; it does not 500 and does not write an old value back. Pinned by Task 3's reader tests and Task 8's migration test over a restored backup fixture.
3. **Qamar and Souq storefronts are byte-identical after PR B.** The re-home of `templates/minimal/*` to `templates/base/*` is a pure `git mv` plus import rewrites. Pinned by Task 5's before/after render equality over the Qamar and Souq scenario stores and by `git diff -M --stat` showing renames, not rewrites.
4. **Something still names an old skin and silently falls back** (a `Record<TemplateId>` indexed with a stale value returns `undefined`, a CSS `[data-pack='elegant']` rule is orphaned, `getTemplateComponents('bold')` throws at render). Pinned by Task 9's blast-radius grep plan, whose final grep must return zero outside the allowlisted legacy-reader file, and by a typecheck that fails when the union loses a member.
5. **The enum migration under load:** no row holds a removed value at apply time, the default is moved before the old type is dropped, and nothing else references the type. Pinned by Task 8's migration test (a throwaway Postgres with a seeded old-value row must make the migration abort; with the row migrated it must apply) and by a `pg_depend` check in the plan's runbook.
6. **CLAUDE.md still says "8 card paths" after the deletion** and the next card change is audited against a list that names files that no longer exist. Pinned by Task 7's doc test (`tests/unit/claude-md-card-paths.test.ts` asserts every path named in the platform-level rule exists on disk).
7. **A new store lands on an old skin after the migration ran** (signup default, owned by the separate fix PR). Pinned by Task 1's gate, re-run before PR B and PR C, which reports any new old-skin store.

---

## Rulings made by this plan

Appended to `docs/RULINGS.md` under `## 2026-10-21 — Old Force skin deletion (SKIN-DEL-*)` as each task lands.

- **Ruling SKIN-DEL-1 — the mapping table (the migration's authority). APPROVED as written by the controller, including the `qamar.atelier` fallback.** Each old skin maps to the nearest built Ebda look by character (read from each skin's `DESIGN.md`), with a fixed fallback and a vertical override. Cost if wrong: a merchant lands on a look that is not their taste; they can switch back in one step (the dialog, with preview, from the editor pass) and the previous state is in revision history.

  | Old skin                     | What it is (its DESIGN.md)                                                       | Maps to          | Why                                                   | Fallback                |
  | ---------------------------- | -------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------- | ----------------------- |
  | `modern` (the old default)   | friendly general-purpose retail, rounded, conversion clarity                     | `souq.catalogue` | general retail, white, dense grid, search first       | `qamar.atelier`         |
  | `elegant`                    | editorial fashion, whitespace, hairlines, quiet                                  | `qamar.atelier`  | white, ink, one accent, the clothes are the interface | none (Atelier is built) |
  | `classic`                    | formal heritage, centred logo, hairline rules, square corners, gifting/jewellery | `dahab.worn`     | restrained white, hairline, karat and scale visible   | `qamar.atelier`         |
  | `minimal` (by `look = null`) | typography-first, no chrome, calm                                                | `souq.showroom`  | grey/ink, one object per screen, quiet                | `qamar.atelier`         |
  | `bold`                       | high-energy, heavy borders, streetwear                                           | `qamar.lookbook` | deep ink-indigo, collage, loud display type           | `qamar.atelier`         |

  Rules: (a) a target look whose `status` is not `built` at run time uses its fallback; (b) if the store's onboarding vertical is recorded, a vertical-to-family override applies first (`TEMPLATE_FAMILIES` already pairs verticals with templates; beauty to `jasmine.*`, food to `lamma.*` only once those looks are `built`); (c) no mapping depends on the store slug.

- **Ruling SKIN-DEL-6 — expand, migrate, contract, in that order, in three PRs.** Evidence: a Postgres enum cannot drop a value in use, and a deployed writer that still emits the old value after the contract fails. Cost if wrong: a window where the API accepts a value the database no longer has; closed by the guarded migration and the strict writer shipping first.
- **Ruling SKIN-DEL-7 — `templates/minimal/*` is re-homed, not deleted.** It is the shared storefront base for Qamar and Souq (Ruling B1-1). It moves to `templates/base/` (a directory, not a skin id, not a `TemplateId`). Evidence: the import lines above and Review Focus 3. Cost if wrong: a rename diff on ~12 files; reverting is a `git mv`.
- **Ruling SKIN-DEL-2 — Jasmine and Lamma ship first; their looks are retargeted to their own skins in their own builds.** The program order is Souq → Jasmine → Lamma → Dahab → delete the skins, so no look says `skin: 'minimal'` when this plan starts. Evidence: the program order, and 12 of 15 looks carrying `skin: 'minimal'` today (`packages/shared/src/looks/registry.ts`). `tests/unit/looks-skin-valid.test.ts` (every look's `skin` ∈ the new `TemplateId`) stays as the red guard and blocks PR B. Cost if wrong: if the order slips, PR B waits; nothing is retargeted to `qamar` as a stopgap.
- **Ruling SKIN-DEL-5 — flags that only a deleted skin read are retired from the editor but never stripped from stored themes.** `rtlPolish` (elegant `EmptyState` arrow) and the bold-only parts of `personaChromeV2` stop being read; their keys stay in the theme Zod schema as accepted-and-ignored (same stance as Ruling EP-5 in the editor-pass plan). Cost if wrong: dead keys sit in JSON; no render changes.
- **Ruling SKIN-DEL-3 — the migration publishes, with the revision kept and a one-click undo. APPROVED (the program is pre-launch).** An old-skin store's live storefront must not depend on code that is about to be deleted, so the script applies the look and publishes in one step, writing a revision first. Evidence: leaving it as a draft would leave the live store on code PR B removes; pre-launch status. Cost if wrong: a live look changes without the merchant's click; mitigated by SKIN-DEL-1's nearest-look mapping, `design:'keep'`, and the revision.
- **Ruling SKIN-DEL-4 — the production migration run EXCLUDES `qa-walk-store-1010` (standing rule: never touch it) and any store the gate cannot classify (`class = 'UNKNOWN'`).** Those stores are listed for Ahmad instead of migrated. The preflight therefore reports "all stores migrated except the excluded list", and PR B is BLOCKED until that list is empty or Ahmad rules on each entry. The enum contract deploy (PR C) happens only after that. Evidence: controller ruling 2026-10-21 and the standing rule. Cost if wrong: PR B and C wait on Ahmad's ruling; no excluded store is touched.

---

## File map

| File                                                                                                                                                                                                                                                                                                             | Responsibility                                                       | Task |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---- |
| `scripts/skins/preflight.sql`, `scripts/skins/preflight.mjs`                                                                                                                                                                                                                                                     | read-only gate (counts and classification)                           | 1    |
| `packages/shared/src/templates/legacy-skin-map.ts` (+ test)                                                                                                                                                                                                                                                      | ruling table as code, `normalizeLegacyTemplate`, `RETIRED_TEMPLATES` | 2, 3 |
| `apps/api/src/services/{onboarding,store,provisioning}.service.ts`, `apps/api/src/routes/onboarding.routes.ts`, `apps/api/src/lib/store-brand-theme.ts`                                                                                                                                                          | strict writer, tolerant reader                                       | 3    |
| `apps/admin/src/app/stores/[id]/template/page.tsx`, onboarding `TemplateStep.tsx`, `apps/admin/messages/{ar,en}.json`                                                                                                                                                                                            | stop offering old skins, one-time notice                             | 3, 4 |
| `scripts/skins/migrate-old-skins.mjs` (+ `scripts/skins/README` section in `docs/ROLLBACK.md`)                                                                                                                                                                                                                   | dry-run-first migration                                              | 4    |
| `apps/web/src/templates/base/*` (moved from `minimal/*`), `apps/web/src/templates/{qamar,souq}/index.ts`                                                                                                                                                                                                         | shared base re-home                                                  | 5    |
| `apps/web/src/templates/{modern,elegant,classic,minimal,bold}/`                                                                                                                                                                                                                                                  | deleted                                                              | 6    |
| `packages/shared/src/types/{store-theme,template-baselines,image-standards}.ts`, `apps/web/src/{templates/index.ts,lib/serverTemplate.ts,templates/shared/pack-styles.ts}`, `apps/marketing/src/lib/demo-stores.ts`, `packages/shared/src/builder/template-families.ts`, `packages/shared/src/looks/registry.ts` | registry/union/maps                                                  | 6    |
| `apps/web/src/styles/globals.css`, `apps/web/public/templates/*.png`                                                                                                                                                                                                                                             | orphaned CSS and thumbnails                                          | 6    |
| `CLAUDE.md`, `docs/architecture/store-theme-flags.md`, `docs/ebda/templates/*.md`, `docs/RULINGS.md`                                                                                                                                                                                                             | rules and docs                                                       | 7    |
| `packages/database/prisma/{schema.prisma,migrations/<ts>_store_template_contract/migration.sql}`, `docs/ROLLBACK.md`                                                                                                                                                                                             | enum contract                                                        | 8    |
| `scripts/skins/blast-radius.sh`                                                                                                                                                                                                                                                                                  | the grep plan as an executable gate                                  | 9    |

---

### Task 1: The precondition gate — read-only SQL, classified by `look`

**Files:**

- Create: `scripts/skins/preflight.sql` (SELECT only)
- Create: `scripts/skins/preflight.mjs` (runs the file with `createPrismaClient({ role: 'owner' })` against the DSN you pass, prints the table, exits 1 unless the old-skin count is 0)
- Test: `tests/unit/skins-preflight.test.ts`, `tests/integration/skins-preflight-classification.test.ts`

`scripts/skins/preflight.sql`:

```sql
-- READ ONLY. Old-skin stores = stores still on a retired template with no Ebda look.
-- A store on an Ebda look is never old-skin, even when its template column says 'minimal'
-- (applyLook writes template = look.skin and 12 looks still render on the 'minimal' base).
WITH classified AS (
  SELECT
    id,
    slug,
    template::text AS template,
    look,
    CASE
      WHEN look IS NOT NULL AND look ~ '^(qamar|souq|jasmine|lamma|dahab)\.' THEN 'ebda-look'
      WHEN template::text IN ('modern','classic','minimal','bold','elegant') THEN 'OLD-SKIN'
      WHEN template::text IN ('dahab','qamar')                                THEN 'ebda-template'
      ELSE 'UNKNOWN'
    END AS class
  FROM stores
)
SELECT class, template, COALESCE(look, '(none)') AS look, count(*) AS stores
FROM classified
GROUP BY class, template, look
ORDER BY class DESC, template, look;

-- The gate: reports "all stores migrated except the excluded list" (Ruling SKIN-DEL-4). Excluded: slug 'qa-walk-store-1010' and any UNKNOWN-class store; they are listed for Ahmad, never migrated. PRs B and C are blocked until the excluded list is empty or ruled on.
SELECT count(*) AS old_skin_stores
FROM stores
WHERE slug <> 'qa-walk-store-1010'
  AND template::text IN ('modern','classic','minimal','bold','elegant')
  AND (look IS NULL OR look !~ '^(qamar|souq|jasmine|lamma|dahab)\.');

-- The excluded list, for Ahmad (never migrated by the script):
SELECT id, slug, template::text AS template, look FROM stores
WHERE slug = 'qa-walk-store-1010'
   OR NOT (template::text IN ('modern','classic','minimal','bold','elegant','dahab','qamar') OR look ~ '^(qamar|souq|jasmine|lamma|dahab)\.');

-- Persisted places that may carry an old skin name (they must still parse; see Task 3).
SELECT 'store_page_revisions' AS surface, count(*) AS rows_naming_old_skin
FROM store_page_revisions
WHERE definition::text ~ '"(modern|classic|minimal|bold|elegant)"'
UNION ALL
SELECT 'stores.theme', count(*) FROM stores WHERE theme::text ~ '"template"\s*:\s*"(modern|classic|minimal|bold|elegant)"'
UNION ALL
SELECT 'stores.layout_settings', count(*) FROM stores WHERE layout_settings::text ~ '"template"\s*:\s*"(modern|classic|minimal|bold|elegant)"';

-- The type has exactly one dependent column (confirm before the contract migration, Task 8).
SELECT c.relname AS table_name, a.attname AS column_name
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_type t ON t.oid = a.atttypid
WHERE t.typname = 'StoreTemplate' AND a.attnum > 0 AND NOT a.attisdropped;
```

(Verify the column names `definition`, `theme`, `layout_settings` against `StorePageRevision` and `Store` in `schema.prisma` before running; the plan names them from the model map and the revision table is `store_page_revisions`. A wrong column name makes the statement fail loudly, which is the correct failure.)

- [ ] **Step 1: Write the failing tests**
  - `skins-preflight.test.ts`: the SQL file contains no `INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE` keyword (case-insensitive, comments stripped) and no `lock_timeout`; the script requires the owner role (it refuses a DSN whose user is `ebda_app`) because `stores` is under strict RLS and the app role would see zero rows (a false-green gate). The test asserts the script exits non-zero with a clear message when it connects as `ebda_app`, so the gate cannot pass on invisible data.
  - `skins-preflight-classification.test.ts` (throwaway Postgres, owner-role fixtures): five stores (a) `modern`/`null`, (b) `minimal`/`jasmine.bloom`, (c) `qamar`/`qamar.atelier`, (d) `dahab`/`null`, (e) `bold`/`null` → the gate count is 2 (a and e only); (b) classifies `ebda-look` (Review Focus 1).
- [ ] **Step 2: Run** `npx vitest run tests/unit/skins-preflight.test.ts tests/integration/skins-preflight-classification.test.ts; echo "exit=$?"` → FAIL.
- [ ] **Step 3: Implement** the two files. The `.mjs` prints the result as a table, prints the persisted-surface counts, exits 1 when `old_skin_stores > 0` or when connected as `ebda_app`, and states "gate NOT evidence of production until run with the owner DSN" if given a loopback DSN.
- [ ] **Step 4: Run** the two files → PASS.
- [ ] **Step 5: Hand the production run to Ahmad.** The agent does not run it against production. The report asks for the output (class table and the three counts). Label every claim downstream measured / inferred / guess; until that output exists the production count is NOT VERIFIED.
- [ ] **Step 6: Commit** → `chore(skins): add the read-only old-skin preflight gate`.

---

### Task 2: The ruling table as code (SKIN-DEL-1)

**Files:**

- Create: `packages/shared/src/templates/legacy-skin-map.ts`
- Modify: `packages/shared/src/index.ts` (export)
- Test: `packages/shared/src/templates/legacy-skin-map.test.ts`

**Interfaces:**

- Produces: `RETIRED_TEMPLATES = ['modern','classic','minimal','bold','elegant'] as const`, `type RetiredTemplate`, `isRetiredTemplate(v: unknown): v is RetiredTemplate`, `mapRetiredSkin(skin: RetiredTemplate, opts?: { vertical?: string; isBuilt?: (lookId: LookId) => boolean }): LookId` (pure; the table of Ruling SKIN-DEL-1 with the fallback and the vertical override).

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/templates/legacy-skin-map.test.ts
import { describe, it, expect } from 'vitest';
import { RETIRED_TEMPLATES, mapRetiredSkin, isRetiredTemplate } from './legacy-skin-map';
import { LOOKS } from '../looks';

const allBuilt = () => true;
const noneBuilt = () => false;

describe('legacy skin map (Ruling SKIN-DEL-1)', () => {
  it('maps every retired skin to a look that exists in the registry', () => {
    const ids = new Set(LOOKS.map(l => l.id));
    for (const s of RETIRED_TEMPLATES)
      expect(ids.has(mapRetiredSkin(s, { isBuilt: allBuilt }))).toBe(true);
  });
  it('the table', () => {
    const m = (s: (typeof RETIRED_TEMPLATES)[number]) => mapRetiredSkin(s, { isBuilt: allBuilt });
    expect(m('modern')).toBe('souq.catalogue');
    expect(m('elegant')).toBe('qamar.atelier');
    expect(m('classic')).toBe('dahab.worn');
    expect(m('minimal')).toBe('souq.showroom');
    expect(m('bold')).toBe('qamar.lookbook');
  });
  it('falls back to a BUILT look when the target is not built', () => {
    for (const s of RETIRED_TEMPLATES) {
      const id = mapRetiredSkin(s, { isBuilt: noneBuilt });
      expect(id).toBe('qamar.atelier');
    }
  });
  it('never returns a look whose skin is a retired template', () => {
    for (const s of RETIRED_TEMPLATES) {
      const look = LOOKS.find(l => l.id === mapRetiredSkin(s, { isBuilt: allBuilt }))!;
      expect(isRetiredTemplate(look.skin)).toBe(false);
    }
  });
});
```

The last test fails until SKIN-DEL-2 is decided (Souq/Dahab looks still say `skin: 'minimal'`), which is intended: it makes the open decision a red test, not a note.

- [ ] **Step 2: Run** `npx vitest run packages/shared/src/templates/legacy-skin-map.test.ts; echo "exit=$?"` → FAIL.
- [ ] **Step 3: Implement** the pure table. `isBuilt` defaults to `getLook(id).status === 'built'`.
- [ ] **Step 4: Run** → the first three PASS; the fourth passes once Souq and Dahab have flipped their looks' `skin` (it is the Task 6 precondition and is allowed to be red in PR A only if marked `it.fails` with a TODO naming SKIN-DEL-2; remove `.fails` in PR B).
- [ ] **Step 5: Commit** → `feat(skins): add the retired-skin to ebda-look mapping`.

---

### Task 3: Tolerant reader, strict writer, and stop offering old skins (PR A)

**Files:**

- Modify: `packages/shared/src/types/store-theme.ts` (keep `TemplateId` unchanged in PR A; add `normalizeLegacyTemplate(v: unknown): TemplateId`: a retired value returns the template of its mapped look, an unknown value returns the default Ebda template)
- Modify (writers): `apps/api/src/services/store.service.ts:944` (`updateTemplate` refuses retired values with 400 `TEMPLATE_RETIRED`), `apps/api/src/services/provisioning.service.ts:57` (type union only). Signup is out of scope (Precondition).
- Modify (readers): `apps/api/src/lib/store-brand-theme.ts:22` (`normalizeLegacyTemplate(store.template)`), every site that reads a template out of a saved document or theme (found by Task 9's grep; at minimum `apps/web/src/lib/serverTemplate.ts`, `apps/web/src/templates/index.ts`, `StoreContext.tsx`, `page-builder.service.ts`, the revision restore path)
- Modify: `apps/admin/src/app/stores/[id]/template/page.tsx` (`SKIN_IDS` loses the five; a store still on one shows its mapped look as "current" with the notice of Task 4), `apps/admin/messages/{ar,en}.json`
- Test: `tests/unit/normalize-legacy-template.test.ts`, `tests/integration/retired-template-writes.test.ts`, `tests/unit/revision-restore-legacy.test.ts`

- [ ] **Step 1: Write the failing tests**
  - `normalize-legacy-template.test.ts`: each retired value normalizes to its mapped look's template; `qamar`, `dahab`, `souq` pass through; `null`, `undefined`, `''` and an unknown string return the default Ebda template and never throw.
  - `retired-template-writes.test.ts` (HTTP, owner and staff): `PUT /stores/:id/template` with each retired value returns 400 `TEMPLATE_RETIRED`, writes no row, changes no cache; an Ebda value still works.
  - `revision-restore-legacy.test.ts`: a revision fixture whose document and theme contain `"template":"elegant"` restores successfully, the stored result contains the mapped template, and no old value is written back (Review Focus 2).
- [ ] **Step 2: Run** the three files → FAIL.
- [ ] **Step 3: Implement.** Zod at every edge: the response and request schemas use `z.enum(EBDA_TEMPLATES)` for writes and `z.string().transform(normalizeLegacyTemplate)` for reads of persisted values. Cache: a template change already busts the store caches in `applyLook`; confirm `updateTemplate`'s retired-value branch does not reach the cache bust (it throws first).
- [ ] **Step 4: Run** the three files + `npm run typecheck; echo "exit=$?"` → PASS.
- [ ] **Step 5: Commit** → `feat(skins): refuse retired skins on write and map them on read`.

---

### Task 4: The migration for any store still on an old skin (PR A, run is STOP 1)

**Files:**

- Create: `scripts/skins/migrate-old-skins.mjs`
- Modify: `apps/admin/messages/{ar,en}.json`, a one-time admin notice component (re-use the existing dismissible notice pattern; find it with `git grep -n "dismiss" apps/admin/src/components | head`), `docs/ROLLBACK.md` (new section "Old skin migration: undo one store")
- Test: `tests/integration/migrate-old-skins.test.ts`

**Behaviour:**

1. Default is `--dry-run`: lists every old-skin store (same predicate as the preflight), the look it would get (`mapRetiredSkin` with the store's vertical and the registry's `built` flags), and what the keep/reset report would be (`diffTemplateFamily` if the editor-pass plan has landed, else `applyTemplateFamily` run in memory).
2. `--apply --store <id>[,<id>…]` or `--apply --all` runs per store, each in its own tenant scope and transaction: `StoreService.applyLook(storeId, mappedLook, { design: 'keep' }, actingOwnerId)`, then publish the resulting draft (Ruling SKIN-DEL-3), then record `{ storeId, from, to, revisionId, at }` to `docs/ops-ledger` equivalent (a JSONL file the script prints and the operator commits only if Ahmad asks; never into git automatically).
3. Idempotent and resumable: a store that is no longer old-skin is skipped; a second run changes nothing; a failure on store N stops that store (its transaction rolls back), logs it, continues, and exits non-zero at the end.
4. Always skips `slug = 'qa-walk-store-1010'` and any store `mapRetiredSkin` cannot classify, and prints them as the excluded list (Ruling SKIN-DEL-4). Refuses a non-loopback database without `--yes-production`; with it, also requires `--expect <N>` equal to the live old-skin count so a drifted set aborts. Refuses the `ebda_app` role (must see all stores). Prints the plan first, then asks no questions (non-interactive), because the STOP is Ahmad running or approving the command.
5. Rollback per store: the revision written before the apply is restorable from the editor (revision history) and by `scripts/skins/migrate-old-skins.mjs --undo <storeId>` which restores that revision and sets `template`/`look` back; after PR C this is no longer possible for the removed enum values (documented; the undo is only valid before PR C).

- [ ] **Step 1: Write the failing integration test** (throwaway Postgres, owner fixtures, real `StoreService`): seed (a) a `modern` store with 2 hero slides, 3 products and an image-text block, (b) a `bold` store, (c) a `minimal`+`jasmine.bloom` store, (d) a `qamar.atelier` store. Dry run changes nothing (row hashes equal before/after). `--apply --all` migrates (a) to `souq.catalogue` and (b) to `qamar.lookbook`; (a)'s hero slides, products and image-text copy are byte-equal after (content kept); its colours equal before (`keep`); (c) and (d) are untouched; a second run is a no-op; `--undo` restores (a). Per-store failure injection: make (b) throw inside `applyLook`; (a) stays migrated, (b) is unchanged, exit code non-zero. The script refuses `ebda_app` and refuses a production-shaped DSN without both flags.
- [ ] **Step 2: Run** `npx vitest run tests/integration/migrate-old-skins.test.ts; echo "exit=$?"` → FAIL.
- [ ] **Step 3: Implement** the script and the notice. Notice copy, Arabic first, one line: «حدّثنا شكل متجرك لقالب جديد. محتواك زي ما هو، وتقدر ترجع للشكل اللي قبله من سجل التعديلات.» / "We moved your store to a new template. Your content is unchanged; you can go back from revision history."
- [ ] **Step 4: Run** the test → PASS; run the dry run against a local database seeded with `scripts/storedemo` stores and read the output.
- [ ] **Step 5: STOP 1 (Ahmad).** The report asks for: (a) the preflight output from production (Task 1), (b) the approval of the ruling table (Ruling SKIN-DEL-1) for the stores listed, and (c) a go to run `--apply --all --yes-production --expect <N>`. After the run, the preflight is re-run and must print `old_skin_stores = 0`; the live storefront of each migrated store is opened in Arabic and screenshotted; what cannot be verified (a merchant's custom domain behind CF-for-SaaS cache, 5-minute public cache) is stated.
- [ ] **Step 6: Commit** → `feat(skins): migrate stores still on an old skin to a mapped ebda look`.

---

### Task 5: Re-home the shared base — `templates/minimal/*` becomes `templates/base/*` (PR B, first commit)

**Files:**

- Move (git mv): `apps/web/src/templates/minimal/{Footer,Hero,ProductCard,ProductGrid,CategoryCard,CategoryGrid,AnnouncementBar,CartTable,OrderSummary,EmptyState,FormCard,Header}.tsx` → `apps/web/src/templates/base/`; `minimal/DESIGN.md` is deleted in Task 6 (a skin design doc), `minimal/index.ts` is replaced by `base/index.ts`
- Modify: `apps/web/src/templates/{qamar,souq}/index.ts` and `templates/qamar/Header.tsx`, `templates/souq/Header.tsx` (imports `../minimal/…` → `../base/…`), every other importer found by `git grep -n "templates/minimal\|\.\./minimal" -- apps packages tests`
- Modify: `packages/shared/src/looks/registry.ts` (12 looks: `skin: 'minimal'` retargeted per SKIN-DEL-2)
- Test: `tests/unit/templates-base-rehome.test.ts`, the existing Qamar/Souq characterization tests unchanged

- [ ] **Step 1: Write the failing tests:** `templates-base-rehome.test.ts` asserts `templates/base/` exists and `templates/minimal/` does not; no file under `apps/` or `packages/` imports a path containing `/minimal/`; `getTemplateComponents('qamar')` and `('souq')` resolve the same component identities as before (compare function names and a render of each of the eleven pieces over a fixed fixture to the committed pre-move HTML captured in Step 2).
- [ ] **Step 2: Before moving anything,** capture the pre-move render of the Qamar and Souq scenario stores (home, PLP, PDP, cart, checkout) as HTML fixtures under `tests/fixtures/skin-deletion/` (these are the equality baseline for Review Focus 3).
- [ ] **Step 3: Run** the test → FAIL; `git mv` the files, rewrite imports, run the tests → PASS with HTML equal to the fixtures.
- [ ] **Step 4: Verify the rename is a rename:** `git diff -M --stat origin/main...HEAD -- apps/web/src/templates | head -40` shows renames with only import-line changes.
- [ ] **Step 5: Commit** (stage each moved path by name) → `refactor(web): move the shared storefront base out of the minimal skin`.

---

### Task 6: Delete the five skins and everything keyed on them (PR B)

**Files (delete with `git rm`, listed by name in the commit):**

- `apps/web/src/templates/{modern,elegant,classic,bold}/` (all files incl. `DESIGN.md`) and the now-empty `minimal/` remnants (`DESIGN.md`)
- Old-skin card/carousel paths: the four `ProductCard.tsx` copies go with their directories; `shared/StorefrontProductCard.tsx` stays unless Task 9's grep proves only an old skin uses it (decide in the PR, write the evidence)
- Old-skin tests and snapshots: every test file under `apps/web/src/templates/<old>/` and every test in `tests/` whose subject is one old skin (found by `git grep -l "templates/\(modern\|elegant\|classic\|bold\)" -- tests apps packages`); inline snapshots naming an old skin updated or removed per file (6 snapshot-assertion files to read; none is deleted blindly)
- `apps/web/public/templates/{modern,elegant,classic,minimal,bold}.png` thumbnails

**Files (modify):**

- `packages/shared/src/types/store-theme.ts`: `TemplateId` loses the five; `TEMPLATE_THEMES`, `TEMPLATES`, the five thumbnail paths; `packages/shared/src/types/template-baselines.ts` (`Exclude<…>` at `:193-195` and `TEMPLATE_LAYOUT_BASELINES`); `packages/shared/src/types/image-standards.ts`
- `apps/web/src/templates/index.ts`, `apps/web/src/lib/serverTemplate.ts`, `apps/web/src/templates/shared/pack-styles.ts` (`PACK_STYLES` loses five keys), `apps/web/src/app/layout.tsx` (`data-pack`)
- `apps/web/src/styles/globals.css`: every `[data-pack='modern'|'elegant'|'classic'|'minimal'|'bold']` rule (Task 9 lists them); `tests/unit/looks-fonts.test.ts` stays satisfied (the "Looks (Phase S)" block remains `[data-look]`-scoped)
- `apps/marketing/src/lib/demo-stores.ts` (`DEMO_STORES: Record<TemplateId, …>` loses five entries), `packages/shared/src/builder/template-families.ts` (any old-skin id), `packages/shared/src/looks/registry.ts` (`skin` values, SKIN-DEL-2)
- `apps/api/src/services/{store,provisioning}.service.ts`, `apps/api/src/lib/store-brand-theme.ts` (fallback uses `normalizeLegacyTemplate`; the default itself comes from the separate fix PR), demo clone scripts (`scripts/storedemo/*`, `clone-demo-stores.ts` equivalents found by grep)
- `legacy-skin-map.ts` remains and becomes the ONLY file in the repo allowed to contain the five names as strings (the allowlist of Task 9's final grep)
- Flags per Ruling SKIN-DEL-5: remove the reads in deleted code (they go with the files); keep the keys in the theme Zod schema as accepted-and-ignored; delete the flags' rows from `store-theme-flags.md` or rewrite them (Task 7)

**Tests:** `tests/unit/looks-skin-valid.test.ts` (every look's `skin` ∈ `TemplateId`; the previously `it.fails` test of Task 2 is un-failed here), `tests/unit/no-retired-skin-strings.test.ts` (the final grep of Task 9 as a Vitest: zero matches outside the allowlist), the Qamar/Souq equality tests from Task 5 (still green), and `npm run typecheck`, which is the primary test: removing a union member turns every stale `Record<TemplateId>` and every `case 'bold':` into a compile error.

- [ ] **Step 1: Write the failing tests** (`looks-skin-valid`, `no-retired-skin-strings`); run → FAIL.
- [ ] **Step 2: Delete and edit** in this order, running `npm run typecheck; echo "exit=$?"` after each group so the compiler leads: (1) web template directories, (2) web registries and CSS, (3) shared types, (4) api, (5) admin and marketing, (6) tests and fixtures, (7) public assets.
- [ ] **Step 3: Run** `npm run typecheck; npm run lint; npm run test:unit; npm run test:integration; echo "exit=$?"` (each with its own captured exit code) → all 0.
- [ ] **Step 4: Run Task 9's blast-radius script** → zero hits outside the allowlist.
- [ ] **Step 5: Build every app** (`npm run build; echo "exit=$?"`): a deleted skin referenced by a dynamic import string would typecheck and still fail at build/runtime on the Worker bundle.
- [ ] **Step 6: Browser check** on the local stack: Qamar (3 looks), Souq (3 looks), a Dahab-redesign store and a `look = null` store that the migration has already moved, each home, PLP, PDP, cart, checkout in Arabic at 390; read the PNGs; confirm the pixels equal Task 5's baseline for Qamar and Souq.
- [ ] **Step 7: Commit** (explicit `git rm`/`git add` paths) → `refactor(web): delete the five old force skins`.

---

### Task 7: CLAUDE.md platform-level rules and docs, in the same PR as Task 6

**Files:** `CLAUDE.md`, `docs/architecture/store-theme-flags.md`, `docs/ebda/templates/{looks,qamar,souq,dahab}.md`, `docs/RULINGS.md`, `docs/ROLLBACK.md`, `tests/unit/claude-md-card-paths.test.ts`.

The new text (write it from the post-Dahab, post-Souq tree; names below are the current expectation and the test in Step 1 is the authority):

- **CLAUDE.md § Platform-level fixes, rule 1 (card paths):** replace "ALL render paths: `shared/StorefrontProductCard.tsx`, the 5 `templates/{modern,elegant,classic,minimal,bold}/ProductCard.tsx`, `shared/ProductCarousel.tsx` (+ `ProductListItem` …) = 8 paths, plus `templates/dahab/…` … Card paths = the 8 card paths + Dahab + the 4 hand-built mappers" with: **"the core card paths: `shared/StorefrontProductCard.tsx` (only if Task 9 keeps it), `templates/base/ProductCard.tsx` (the shared card Qamar and Souq render), `shared/ProductCarousel.tsx`, `ProductListItem` (CTA/OOS system) = 4 paths, plus any card a template ships on top of the base (the redesigned Dahab's, if it ships one) + the 4 hand-built mappers (`YouMightAlsoLike`, `CartRecommendations`, `FrequentlyBoughtTogether`, `WishlistClient`)"**. The product-ROW paragraph (`ShopTheLookSection.tsx`, `LookPiecesClient.tsx`, `ProductSpotlightSection.tsx` and anything B2 adds, e.g. Souq's stage) is kept verbatim apart from the count.
- **Rule 2 (header/footer/nav):** "all 5 themes + Dahab … the other 4" becomes: "the base chrome (`templates/base/{Header,Footer,AnnouncementBar}`) and each template's chrome wrapper (`templates/{qamar,souq,…}/Header.tsx`); ship the merchant's template first and land the others in the same batch."
- Anywhere else the "8 card paths" phrase or the five names appear in `CLAUDE.md` or `docs/architecture/store-theme-flags.md` (the "Card elements rendered from data, on every card path" paragraph names "the 8 card paths + Dahab … the five `{modern,elegant,classic,minimal,bold}/ProductCard`").
- `docs/architecture/store-theme-flags.md`: the flag rows for `rtlPolish`, `personaChromeV2` (bold-only parts), `frameChromeDedup`/`showCardFrame` interplay for skins that no longer exist: rewritten to "read by: <current skins>" or marked retired-and-ignored (SKIN-DEL-5); the canonical-owners table is unchanged.
- `docs/ebda/templates/looks.md`: "Phase S: all looks render on `minimal`" → "on the shared base via their skin"; `dahab.md` historical note updated.

- [ ] **Step 1: Write the failing test** `tests/unit/claude-md-card-paths.test.ts`: parse the backticked paths in CLAUDE.md rule 1 and the `store-theme-flags.md` card paragraph; assert each file exists under `apps/web/src`; assert the strings `8 card paths` and each of `modern`, `elegant`, `classic`, `bold` as a template directory do not appear; assert the product-card paths named are exactly those the repo's card-path coverage test knows (find it: `git grep -n "StorefrontProductCard" tests | head`).
- [ ] **Step 2: Run** → FAIL. **Step 3:** edit the docs. **Step 4:** run → PASS.
- [ ] **Step 5: Docs parity check:** `docs/ENVIRONMENT.md` unaffected (state it), `docs/RULINGS.md` has SKIN-DEL-1..7 each with `Cost if wrong:`.
- [ ] **Step 6: Commit with Task 6's PR** (a separate commit) → `docs(skins): card paths and chrome rules after the old skins`.

---

### Task 8: Enum contract migration (PR C)

**Files:**

- Create: `packages/database/prisma/migrations/<next-ts>_store_template_contract/migration.sql` (timestamp after the latest migration at write time; `ls packages/database/prisma/migrations | tail -3` showed `20261028000700…` on 2026-10-21; also run `scripts/check-migration-order.mjs`)
- Modify: `packages/database/prisma/schema.prisma` (`enum StoreTemplate` loses five values; `template StoreTemplate @default(<chosen Ebda template>)`)
- Modify: `docs/ROLLBACK.md` ("enum value removed" section: the rollback is `ALTER TYPE "StoreTemplate" ADD VALUE IF NOT EXISTS …` for each removed value, outside a transaction block per Postgres rules, and re-pointing nothing)
- Test: `tests/integration/store-template-contract-migration.test.ts`

`migration.sql` (the values list is computed at write time from the schema's surviving members; shown here with the post-Souq set):

```sql
-- Refuse if any row still uses a removed value (the data gate of Task 1 must be 0).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "stores"
    WHERE "template"::text IN ('modern','classic','minimal','bold','elegant')
  ) THEN
    RAISE EXCEPTION 'store_template_contract: stores still use a retired template; run the old-skin migration first';
  END IF;
END $$;

ALTER TABLE "stores" ALTER COLUMN "template" DROP DEFAULT;
ALTER TYPE "StoreTemplate" RENAME TO "StoreTemplate_old";
CREATE TYPE "StoreTemplate" AS ENUM ('dahab', 'qamar', 'souq');   -- + any template enum value added since
ALTER TABLE "stores"
  ALTER COLUMN "template" TYPE "StoreTemplate" USING "template"::text::"StoreTemplate";
ALTER TABLE "stores" ALTER COLUMN "template" SET DEFAULT 'qamar';  -- the chosen default Ebda template
DROP TYPE "StoreTemplate_old";
```

(RLS: `stores` is under strict RLS and FORCE; the `ALTER TABLE` runs as the migration owner role, which owns the table. Confirm no policy, view, index or generated column references `template` with `SELECT polname, pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polrelid = 'stores'::regclass` and `pg_depend`; the preflight's last query already proves the column is the only dependent of the type.)

- [ ] **Step 1: Write the failing integration test** (throwaway Postgres 17 with all prior migrations applied): (a) with a `bold` row present, applying the migration aborts with the message above and leaves the old type intact; (b) with the row moved to an Ebda look, the migration applies, `\dT+ "StoreTemplate"` lists exactly the surviving values, the column default is the chosen one, `INSERT` of `'bold'` is rejected by the database, and a Prisma `store.create` with no template gets the new default; (c) the tenant guard and RLS suites that enumerate `stores` still pass; (d) `ALTER TYPE … ADD VALUE` for a removed value works (the documented rollback), run outside a transaction.
- [ ] **Step 2: Run** `npx vitest run tests/integration/store-template-contract-migration.test.ts; echo "exit=$?"` → FAIL.
- [ ] **Step 3: Implement** the migration and the schema change; run `npm run db:generate; npm run typecheck; echo "exit=$?"`; commit the regenerated tenant-guard snapshot only if it changes (`npm run gen:tenant-guard-schema -w packages/database`; the model set is unchanged, so expect no diff).
- [ ] **Step 4: Preconditions re-checked before merging, in this order:** PR B deployed (`/health` `commit` equals the tip of `main`; both Workers checked), preflight run again against production = 0 and no row names a retired value in `stores.theme`/revisions in a way the reader cannot handle (reader tolerance stays, so those counts are informational), a Neon PITR point noted in the PR body (rollback anchor).
- [ ] **Step 5: STOP 2 (Ahmad).** The API deploy (`cf-api-deploy.yml` is `workflow_dispatch` only) runs the migration against production; the agent does not dispatch it. After it: `curl https://api.ebda.app/health` commit equals `main`'s tip; a read-only `SELECT enumlabel FROM pg_enum …` lists the new values; one existing store's storefront and admin template page load; what could NOT be verified is stated (every custom-domain host, CF-for-SaaS edge caches).
- [ ] **Step 6: Commit** → `feat(db): drop the retired skins from the store template enum`.

---

### Task 9: Blast-radius grep plan (runs in Tasks 3, 6, 7 and again before each PR; the result is stated in each PR body)

**Files:** `scripts/skins/blast-radius.sh` (read-only; exits 1 on any hit outside the allowlist), `tests/unit/no-retired-skin-strings.test.ts` (Task 6).

**Identifiers swept:** the five names `modern|elegant|classic|minimal|bold` as skin ids; `templates/{old}`; `[data-pack='{old}']`; `PACK_STYLES`; `getTemplateComponents`; `Record<TemplateId`; `StoreTemplate`; `SELF_SERVE_TEMPLATES`; `TemplateStep`; `SKIN_IDS`; `skins.` i18n keys; `/templates/<old>.png`; `DESIGN.md`; the flag keys `rtlPolish`, `personaChromeV2`; `8 card paths`; `minimal/` import paths; `@default(modern)`.

**Scopes and commands (run each; every hit is classified deleted / renamed / allowlisted, none ignored):**

```bash
# 1. quoted skin ids in code, tests, scripts, CI (FontFamily 'modern' is a known false positive: exclude by file, list it)
git grep -n -E "['\"](modern|elegant|classic|minimal|bold)['\"]" -- apps packages tests scripts .github \
  ':!packages/shared/src/templates/legacy-skin-map.ts' ':!*/migrations/*' ':!docs/*'
# 2. directory and import references
git grep -n -E "templates/(modern|elegant|classic|minimal|bold)|\.\./(modern|elegant|classic|minimal|bold)/|/minimal/" -- apps packages tests scripts
# 3. CSS and data attributes
git grep -n -E "data-pack=.?(modern|elegant|classic|minimal|bold)|\[data-pack" -- apps/web/src/styles apps/web/src/app apps/marketing
# 4. exhaustive maps and switches that must lose a member (the compiler finds them; the grep lists them for the PR body)
git grep -n -E "Record<TemplateId|case '(modern|elegant|classic|minimal|bold)'" -- apps packages
# 5. DB, API edges, signup
git grep -n -E "StoreTemplate|SELF_SERVE_TEMPLATES|@default\(modern\)|validTemplates" -- apps packages
# 6. i18n and assets
git grep -n -E "skins\.(modern|elegant|classic|minimal|bold)|public/templates/(modern|elegant|classic|minimal|bold)" -- apps packages
# 7. config, CI, cron, monitoring, docs, env examples, sibling repos
git grep -n -E "modern|elegant|classic|bold" -- .github '*.yml' '*.yaml' '*.json' ':!package-lock.json' ':!*.generated.json'   # list, then classify by hand
git grep -n -E "8 card paths|five .*ProductCard|\{modern,elegant,classic,minimal,bold\}" -- CLAUDE.md docs
git grep -n -E "rtlPolish|personaChromeV2" -- apps packages docs tests
ls ../ebda-* ~/Desktop/projects/Ebda-AI-Studio 2>/dev/null   # sibling repos: marketing twin / demo-store scripts that name a skin
```

Final gate (also `tests/unit/no-retired-skin-strings.test.ts`): command 1 and 2 return zero lines. The only allowed carrier of the five names is `legacy-skin-map.ts` (the tolerant reader), `docs/RULINGS.md` and migration SQL history.

- [ ] **Step 1: Write `scripts/skins/blast-radius.sh`** from the commands above, with the allowlist file `scripts/skins/blast-radius.allow` (each entry: path, reason).
- [ ] **Step 2: Run it at the start of Task 6 (the work list), and after Task 7 (must be clean).** Capture the exit code on the script itself.
- [ ] **Step 3: State the result in each PR body** in the repo's form: `blast-radius: swept <ids> across <scopes> → clean` or `→ found + fixed N`.
- [ ] **Step 4: Commit** → `chore(skins): add the retired-skin blast-radius gate`.

---

## Dependencies and order

1. **Dahab redesign ships** and **Souq merges** (hard preconditions for the whole plan).
2. PR A: Tasks 1, 2, 3, 4 (merge, deploy). Task 4's script is run only at **STOP 1**.
3. Preflight on production = 0 (Ahmad's output).
4. PR B: Tasks 5, 6, 7, 9 (one PR, several commits). Needs Jasmine and Lamma shipped (SKIN-DEL-2) and the excluded-store list empty or ruled on by Ahmad (SKIN-DEL-4).
5. Deploy B, re-verify `/health` commit and the storefronts.
6. PR C: Task 8, **STOP 2** (the API deploy that runs the migration).

The editor-pass plan (`2026-10-21-template-editor-pass.md`) is independent; if both are in flight, the editor pass's Task 4 (no-op control removal) and this plan's Task 6 both touch `store-theme-flags.md` and `ThemeTab`: land the editor pass first, or rebase this plan's flag-row edits onto it.

## Self-review (done while writing)

- Spec coverage: precondition SQL gate (Task 1, read-only, classified by `look`); migration of remaining old-skin stores with content kept, mapping as a ruling table (SKIN-DEL-1, Tasks 2 and 4); code, card paths, "8 card paths" rule, tests, snapshots, registry/enum removal (Tasks 5 to 8); enum contract migration safe for saved documents that must still parse old values (Tasks 3 and 8); blast-radius grep plan (Task 9); CLAUDE.md updated in the same PR (Task 7); order after Dahab (header).
- Not verified here (stated, not assumed): production store counts per skin (no production access from this plan; Task 1 produces the numbers), the exact column names in the persisted-surface counts (checked against `schema.prisma` in Task 1 Step 3), whether `StorefrontProductCard` is used only by an old skin (decided from Task 9's output).
