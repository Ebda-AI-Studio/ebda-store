# Template Editor Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin page editor, the theme settings and the look switcher first-class for the new Ebda templates (Qamar on main; Souq, Jasmine, Lamma and the Dahab redesign as they land; three looks each). A merchant switches look without losing content and sees the result in their own content before applying. Every section control matches that template's real section variants, no control exists that does nothing on the merchant's template, the admin reads top to bottom like the storefront, and every new control is findable with ⌘K, in Arabic first, in RTL.

**Architecture:** No new editor. The editor already has the pieces (`apps/admin/src/app/stores/[id]/builder/_components/{BuilderEditor,SectionTree,SettingsPanel,ThemeSettingsPanel,Canvas}.tsx`, `components/looks/{LookPicker,LookSwitchDialog}.tsx`, `ThemeTab.tsx`, `lib/settings-registry.ts`) and the shared contracts (`packages/shared/src/builder/{registry,settings-schema,template-families,layout-schema}.ts`, `packages/shared/src/looks/*`). This plan (1) measures the gap with a generated matrix (Task 1), then (2) closes it by giving every settings field and every section a `shownFor` rule keyed on the resolved template, so a control appears only where a renderer reads it (Tasks 3, 4); (3) adds a read-only look-switch preview that runs the existing pure `applyTemplateFamily` and renders the proposed draft in the merchant's content (Task 2); (4) orders the admin by the storefront's flow and registers every control for ⌘K (Tasks 5, 6); (5) pins Arabic-first RTL with a screenshot walk (Task 7). The matrix is the finish line: the plan is done when it has zero `no-op` and zero `missing` rows for the shipped templates.

**Tech Stack:** Next.js 16 App Router (apps/admin, apps/web), Express on Cloudflare Workers (apps/api), Zod in `@ebda/shared`, Vitest + Testing Library, Playwright + axe-core, `tsx` for scripts.

**Spec / read with it:** `docs/plans/done/2026-10-14-templates-and-editor-program.md` (Phase E, Rulings TPL-1..3), `docs/ebda/templates/{2026-10-14-directions,looks,qamar,dahab,quality-bar}.md` (+ `souq.md` once Souq merges), `docs/plans/done/2026-10-15-phase-b1-qamar.md` (Rulings B1-3, B1-4 "a merchant setting belongs to Phase E's editor pass", C6, C8), `docs/plans/done/2026-10-21-phase-b2-souq.md` (rail/tiles/stage/on_sale variants), `docs/plans/done/2026-10-14-phase-b0-platform-commerce.md` (§ Taste bar), `docs/architecture/store-theme-flags.md` (ThemeTab ceiling, canonical owners), `docs/architecture/admin-search.md`, and Ahmad's taste profile (`AHMAD-TASTE-PROFILE.md`: no orange, metal accents on deep grounds, merchandising that sells beats decoration, Egyptian full sentences, photo-led).

## Global Constraints

- **Arabic-first RTL:** every admin surface this plan touches is designed and screenshotted in Arabic (RTL) first, then English. All copy lives in `apps/admin/messages/{ar,en}.json` (and `LanguageContext.tsx` for storefront strings); Arabic is Egyptian full sentences, short neutral button labels. No logical-property regressions (`ms-`/`me-`/`start-`/`end-`, never `ml-`/`left-` in new code).
- **Taste bar** (B0-4 as amended by B0-49) binds every UI task: at most one helper line per control, one accent for the primary action, unfilled features render nothing, no gradient text / side-stripe borders / glassmorphism / ghost cards, radius from `var(--radius)`, no HOT/FEATURED chrome, motion only where it means something (the preview crossfade is the only new motion, 200 ms ease-out-quint, instant under reduced motion). An `impeccable` critique runs before each UI commit.
- **ThemeTab ceiling = 7 toggles** (`docs/architecture/store-theme-flags.md` rule 4). ThemeTab must not grow; excess goes to a dedicated `/stores/[id]/<feature>` page or a Page Builder card. Task 4 adds a test that counts them.
- **Admin mirrors the storefront top to bottom** (rule 5): never alphabetical, never grouped by control type; `groupHeading` clusters + nested sub-controls.
- **Platform-level (CLAUDE.md):** one implementation for every store; never branch on a slug; a control is gated by the resolved template/look, never by a tenant id. No new product-card render path (Ruling B1-1); the card paths rule (`CLAUDE.md` § Platform-level fixes 1) is unchanged by this plan.
- **Looks are data over the shared section registry** (LOOKS-1). A look switch never forks commerce code. Legacy stores (`look = null`) and every store that is not previewing a switch stay byte-identical (Phase S characterization tests stay green unchanged).
- **Must not change:** checkout, pricing, inventory, permissions, tenant isolation, published pages (a switch writes the DRAFT only, per LOOKS-8..10), the storefront render output of any existing store, the `look` column contract, the revision history.
- **Tenant guard:** every Prisma query carries a top-level `storeId` = the ambient store. The preview endpoint is read-only, owner/editor-role gated like `applyLook`, and writes nothing.
- **ColorField everywhere** (`grep -rn 'type="color"' apps/admin/src | grep -v ColorField` stays empty); `token:X` falls back to `hsl(var(--<key>))`.
- **Settings registry:** every new page or control gets a `settings-registry.ts` entry and a `data-setting-id` anchor in the same commit; `tests/unit/settings-registry.test.ts` and `npm run gen:settings-search -w apps/admin` stay green.
- **Docs parity in the same task:** `docs/architecture/store-theme-flags.md`, `docs/architecture/admin-search.md`, `docs/ebda/templates/looks.md`, the template doc of any template touched, `docs/RULINGS.md`.
- Commits: `git add <explicit paths>` only (never `-A` or `.`), lowercase commitlint subjects, never `--no-verify`, blank line before the trailers, and every commit ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5`
- Gates are run with the exit code captured on the command itself, never through a pipe (`cmd; echo "exit=$?"`).
- No production access by an agent. This plan needs none.

## Review Focus

1. **A merchant on Atelier switches to Vitrine** → hero slides, image-text copy, carousel product choices, testimonials survive; only design keys change; a section type Vitrine does not use leaves the DRAFT (never live) and is restorable from revisions; the preview shows exactly that draft in the merchant's own products before they confirm. Pinned by Task 2's keep-content and preview-equals-apply tests.
2. **A control is visible on a template whose skin ignores it** (the editor lies). Pinned by Task 1's flip-probe (renders the section with the value flipped and compares output) and Task 4's zero-no-op gate on the committed matrix.
3. **A template's own variant has no control** (Souq `rail`, `tiles`, `stage`, `on_sale`; Jasmine `steps`; Lamma `menu`, `maker-profile`; Dahab `gift-finder`, `steps`, `maker-profile`; Qamar `chips`, `collage`, `full-bleed`, `band`, `single`, `shop-the-look`) → the merchant can only get it by switching look and cannot re-add it after deleting it. Pinned by Task 1's `missing` rows and Task 3's per-template variant coverage test.
4. **ThemeTab grows past 7** while a new template adds a "just one more toggle". Pinned by Task 4's ceiling test.
5. **Arabic at 390px in the editor**: the look preview, the section tree and the variant controls do not overflow, truncate a label mid-word, or flip a control's reading order. Pinned by Task 7's RTL screenshot walk and the axe pass.
6. **⌘K finds the new controls** by Arabic and English words ("شريط الأقسام", "category rail"), and the deep link opens the builder on the right section with the field highlighted. Pinned by Task 6.
7. **A look switch on a store with a stale preview**: preview computed from the draft at T0, the merchant edits in another tab, then confirms → apply must be computed again on the server from the current draft (never from the preview payload) and refused with a conflict if the draft revision moved. Pinned by Task 2's revision-token test.

---

## Rulings made by this plan

Appended to `docs/RULINGS.md` under `## 2026-10-21 — Template editor pass (EP-*)` in Task 8 (each ruling is written at the moment the task that makes it lands; Task 8 only checks the set is complete).

- **Ruling EP-1 — visibility of a control is a declared rule, not a render accident.** Each settings field and each section type carries `shownFor` (`{ templates?: TemplateId[]; looks?: LookId[]; variants?: Record<string,string[]> }`) in `packages/shared/src/builder/settings-schema.ts` / `registry.ts`; absent = shown for every template (today's behaviour). Evidence: Phase S contract §2 (templates contribute variants of shared sections); B1 cross-skin render tests prove every variant renders on every skin, so most controls stay universal and only genuinely skin-owned ones are narrowed. Cost if wrong: a control hidden that a renderer does read; mitigated by the flip-probe, which fails the build on a hidden-but-wired control.
- **Ruling EP-2 — the matrix script is the editor's definition of done and is committed.** `scripts/editor-audit/` generates `docs/ebda/templates/editor-matrix.md` + `.json`; CI regenerates and diffs (stale matrix = red), and a baseline file lists any accepted `no-op`/`missing` row with a reason. Evidence: the CLAUDE.md rule "ThemeTab full" and the `rtlPolish`/`personaChromeV2` history show controls outliving the skins that read them. Cost if wrong: one more generated file to review per template.
- **Ruling EP-3 — look-switch preview is computed server-side by the same pure function that applies.** `POST /stores/:id/look/preview` calls `applyTemplateFamily(draft, family, look, { design })` and returns the proposed draft + a field-level change report; the client renders it with the existing Canvas against the merchant's real data. Evidence: Ruling B1-3/C6/C8 already define the semantics in that function; a second client-side implementation would drift. Cost if wrong: one extra round trip per dialog open.
- **Ruling EP-4 — merchant chrome controls (logo placement, header band, search placement) are look chrome overrides in the theme draft, edited in the Header card.** Closes the Ruling B1-4 deferral ("a merchant setting belongs to Phase E's editor pass"). Precedence merchant > look > skin, as `composeStoreTheme` already does for tokens. Cost if wrong: a Qamar/Souq merchant who set a chrome override keeps it after a look switch with `keep`, and loses it with `reset` (stated in the dialog).
- **Ruling EP-5 — controls that do nothing are removed, not hidden behind a flag**; a stored value for a removed control stays in saved documents and is ignored by the reader (`passthrough`), never migrated or deleted. Cost if wrong: a stale key sits in JSON.

---

## File map

| File                                                                                                                                                                | Responsibility                                     | Task          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------- |
| `scripts/editor-audit/{gen-matrix.ts,probe.ts,classify.ts}`, `scripts/editor-audit/baseline.json`                                                                   | audit method + matrix generator                    | 1             |
| `docs/ebda/templates/editor-matrix.{md,json}`                                                                                                                       | committed matrix (generated)                       | 1, 4          |
| `tests/unit/editor-matrix.test.ts`                                                                                                                                  | matrix current + zero unaccepted no-op/missing     | 1, 4          |
| `apps/api/src/services/store.service.ts` (`previewLook`), `apps/api/src/routes/store.routes.ts`, `packages/shared/src/builder/template-families.ts` (change report) | look preview endpoint                              | 2             |
| `apps/admin/src/components/looks/{LookSwitchDialog,LookPreviewPane}.tsx`, `apps/admin/src/app/stores/[id]/template/page.tsx`                                        | preview before apply                               | 2             |
| `packages/shared/src/builder/{settings-schema.ts,registry.ts}`                                                                                                      | `shownFor` metadata, variant options               | 3             |
| `apps/admin/src/app/stores/[id]/builder/_components/{SettingsPanel,AddSectionDialog,SectionTree}.tsx`                                                               | template-aware controls and section picker         | 3             |
| `apps/admin/src/app/stores/[id]/branding/_components/ThemeTab.tsx`, `apps/admin/src/components/ThemeSettings*`                                                      | no-op removal, ceiling                             | 4             |
| `apps/admin/src/app/stores/[id]/builder/_components/ThemeSettingsPanel.tsx`, `ChromeContentPanel.tsx`                                                               | storefront-order grouping, chrome overrides (EP-4) | 5             |
| `apps/admin/src/lib/settings-registry.ts`, `apps/admin/src/lib/settings-search-index.generated.json`, `apps/admin/messages/{ar,en}.json`                            | ⌘K entries + deep link into builder                | 6             |
| `playwright.editor.config.ts`, `tests/editor/*.spec.ts`                                                                                                             | RTL screenshot walk + axe                          | 7             |
| `docs/architecture/{store-theme-flags,admin-search}.md`, `docs/ebda/templates/looks.md`, `docs/RULINGS.md`                                                          | docs                                               | each task + 8 |

Order: Task 1 (measure) → Task 2 (switch + preview, independent of Task 1's result) in parallel with Task 3 → Task 4 (needs 1 and 3) → Task 5 → Task 6 → Task 7 → Task 8. Per-template increments: Souq controls wait for the Souq PR to merge; Jasmine, Lamma and Dahab rows are generated as `pending-template` until their registry entries exist and flip to gated rows automatically.

---

### Task 1: The audit method — a script that generates the control/section matrix

**Files:**

- Create: `scripts/editor-audit/gen-matrix.ts` (entry; `tsx scripts/editor-audit/gen-matrix.ts [--check]`)
- Create: `scripts/editor-audit/classify.ts` (pure: row model + classification), `scripts/editor-audit/probe.ts` (the flip probe)
- Create: `scripts/editor-audit/baseline.json` (accepted rows, each `{ id, status, reason }`; starts as `[]`)
- Create: `docs/ebda/templates/editor-matrix.md`, `docs/ebda/templates/editor-matrix.json` (generated, committed)
- Modify: `package.json` (`"editor:matrix": "tsx scripts/editor-audit/gen-matrix.ts"`, `"editor:matrix:check": "tsx scripts/editor-audit/gen-matrix.ts --check"`)
- Modify: `.github/workflows/ci.yml` (add `npm run editor:matrix:check` to the unit job's script list)
- Test: `tests/unit/editor-matrix.test.ts`, `scripts/editor-audit/classify.test.ts`

**Method (what the script does; this is the audit's definition):**

1. **Enumerate the axes** from code, not from docs: templates + looks from `packages/shared/src/looks/registry.ts` (`LOOKS`, `skin`, `status`, `sections` mix); sections and every settings field from `SECTION_REGISTRY` (`packages/shared/src/builder/registry.ts`) and `settings-schema.ts` (field key, kind, options); theme controls from `ThemeTab.tsx` (`data-setting-id`s), the Page Builder theme panel (`ThemeSettingsPanel.tsx`) and `TYPOGRAPHY_ZONES`; look switcher behaviours from `LookSwitchDialog` choices.
2. **One row per (template, look, surface, control)** with `surface` = `section:<type>` | `theme` | `chrome` | `look-switch`, and `value-set` = the control's option list (or `[true,false]` for toggles).
3. **Classify each row** with two independent evidence sources (both must agree to call it `wired`):
   - **static:** the control's key is read by a renderer that the template's resolved skin reaches — a reverse grep of `apps/web/src/{builder/sections,templates/<skin>,templates/shared,app}` for the key, following the skin map `look.skin` → `apps/web/src/templates/<skin>/index.ts` re-exports;
   - **flip probe:** `probe.ts` renders the section (or the theme-scoped component) through `PageRenderer` / the skin component with `react-dom/server` on a fixed fixture store (3 products, 2 categories, Arabic copy) once per option value, with the look's tokens applied, and compares serialized HTML after stripping generated ids. All values identical = the control changes nothing on that template.
4. **Status:** `wired` (static hit and probe differs) · `no-op` (shown in the editor, probe identical or no static reader on this skin) · `missing` (the template/look's real variant — taken from the look's `sections` mix and `docs/ebda/templates/<id>.md` variant table — has no editable control, or the section is in the mix but not in `AddSectionDialog` for that template) · `pending-template` (look `status !== 'built'` and the skin does not exist yet; reported, not failed) · `exempt` (listed in `baseline.json` with a reason).
5. **Output:** one table per template (rows = sections in storefront top-to-bottom order from the mix, columns = controls) in `editor-matrix.md` with a summary header (`wired N · no-op N · missing N · pending N · exempt N`) and the same data in `editor-matrix.json`. `--check` regenerates in memory and exits 1 if the committed files differ or if any `no-op`/`missing` row is not in `baseline.json`.

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/editor-audit/classify.test.ts
import { describe, it, expect } from 'vitest';
import { classify } from './classify';

describe('classify', () => {
  it('wired needs BOTH a static reader and a differing probe', () => {
    expect(classify({ staticHit: true, probeDiffers: true, shown: true })).toBe('wired');
    expect(classify({ staticHit: true, probeDiffers: false, shown: true })).toBe('no-op');
    expect(classify({ staticHit: false, probeDiffers: false, shown: true })).toBe('no-op');
  });
  it('a variant in the look mix with no control is missing', () => {
    expect(classify({ inMix: true, hasControl: false })).toBe('missing');
  });
  it('a look whose skin does not exist yet is pending, not failed', () => {
    expect(classify({ lookStatus: 'designed', skinExists: false })).toBe('pending-template');
  });
});
```

```ts
// tests/unit/editor-matrix.test.ts
import { describe, it, expect } from 'vitest';
import { buildMatrix } from '../../scripts/editor-audit/gen-matrix';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
describe('editor matrix', () => {
  it('the committed matrix is current', async () => {
    const live = await buildMatrix();
    const committed = JSON.parse(
      readFileSync(path.join(root, 'docs/ebda/templates/editor-matrix.json'), 'utf8')
    );
    expect(live).toEqual(committed);
  });
  it('every no-op / missing row is accepted in baseline.json with a reason', async () => {
    const live = await buildMatrix();
    const base = JSON.parse(
      readFileSync(path.join(root, 'scripts/editor-audit/baseline.json'), 'utf8')
    ) as { id: string; reason: string }[];
    const accepted = new Set(base.map(b => b.id));
    const bad = live.rows.filter(
      r => (r.status === 'no-op' || r.status === 'missing') && !accepted.has(r.id)
    );
    expect(bad.map(r => r.id)).toEqual([]);
    for (const b of base) expect(b.reason.length).toBeGreaterThan(10);
  });
  it('covers every built look and every section type in the registry', async () => {
    const live = await buildMatrix();
    expect(new Set(live.rows.map(r => r.look))).toContain('qamar.atelier');
    expect(live.coverage.sectionTypesMissing).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run scripts/editor-audit/classify.test.ts tests/unit/editor-matrix.test.ts; echo "exit=$?"` → FAIL (modules do not exist).
- [ ] **Step 3: Implement** `classify.ts` (pure), `probe.ts` (fixture store + `renderToStaticMarkup`, stable-id stripper, never touches the network or a DB), `gen-matrix.ts` (axes enumeration from the imports above, writes both files; `buildMatrix()` exported, `--check` flag).
- [ ] **Step 4: First generation.** Run `npm run editor:matrix; echo "exit=$?"`. Read the output in full. Seed `baseline.json` with `[]` and expect the check to FAIL: the failing rows are Tasks 3 and 4's work list. Record the counts in the commit body. Do NOT accept rows into the baseline here; Task 4 empties or justifies each one.
- [ ] **Step 5: Hand-verify the method on three known cases before trusting it:** (a) a control the code review knows is wired (`category-grid layout: chips` on `qamar.atelier`) classifies `wired`; (b) `rtlPolish`-style flag on a skin that no longer reads it classifies `no-op`; (c) `souq.catalogue` rows read `pending-template` until the Souq PR is merged. A matrix that cannot reproduce these three is wrong; fix the probe, not the expectations.
- [ ] **Step 6: Commit** `git add scripts/editor-audit package.json .github/workflows/ci.yml docs/ebda/templates/editor-matrix.md docs/ebda/templates/editor-matrix.json tests/unit/editor-matrix.test.ts` → `chore(editor): generate the template control matrix`.

---

### Task 2: Look switch keeps content, with a preview before applying

**Files:**

- Modify: `packages/shared/src/builder/template-families.ts` (`applyTemplateFamily` also returns, via a sibling pure `diffTemplateFamily`, a change report: `{ keptContent: SectionRef[], designChanged: {section, field}[], added: SectionRef[], droppedFromDraft: SectionRef[], themeKeysReset: string[] }`; behaviour of the existing function unchanged)
- Modify: `apps/api/src/services/store.service.ts` (add `previewLook(storeId, lookId, { design })`: reads the current draft revision, runs the pure functions, writes nothing, returns `{ draft, report, revisionToken }`), `apps/api/src/routes/store.routes.ts` (`POST /stores/:id/look/preview`, same auth and Zod body as the apply route)
- Modify: `StoreService.applyLook` to accept the optional `revisionToken` and 409 `DRAFT_MOVED` if the draft revision differs (Review Focus 7)
- Create: `apps/admin/src/components/looks/LookPreviewPane.tsx` (renders the proposed draft with the existing `Canvas` in read-only mode over the merchant's real products; phone/desktop toggle; Arabic default)
- Modify: `apps/admin/src/components/looks/LookSwitchDialog.tsx` (two-step: choose keep/reset → preview + plain-language report → confirm), `apps/admin/src/app/stores/[id]/template/page.tsx`, `apps/admin/messages/{ar,en}.json`
- Test: `tests/unit/template-family-diff.test.ts`, `tests/integration/store-look-preview.test.ts`, `apps/admin/src/components/looks/LookSwitchDialog.test.tsx`

**Interfaces:**

- Consumes: `applyTemplateFamily(current, family, look, { design })`, `getLook`, the builder draft read (`page-builder.service.ts`).
- Produces: `POST /stores/:id/look/preview` → `{ data: { draft, report, revisionToken } }`; `applyLook(..., { design, revisionToken? })`.

- [ ] **Step 1: Write the failing tests**
  - `template-family-diff.test.ts`: Atelier → Vitrine on a fixture with 2 hero slides, an image-text block, a carousel with product refs → `report.keptContent` lists all three; `droppedFromDraft` lists exactly the section types absent from Vitrine's mix; Vitrine → Lookbook → Atelier (C6) leaves no leaked look-owned setting; `design:'keep'` preserves a merchant-changed field (C8) and `reset` does not; `diffTemplateFamily` is pure (input deep-frozen).
  - `store-look-preview.test.ts` (RLS-real store): preview returns a draft identical to what `applyLook` then writes (`expect(applied.draft).toEqual(preview.draft)`); preview writes zero rows (row counts of `page_revisions`, `stores` unchanged, `look` column unchanged); a foreign store id 404s; a viewer role 403s; after a second edit, `applyLook` with the old `revisionToken` returns 409 `DRAFT_MOVED` and writes nothing.
  - `LookSwitchDialog.test.tsx`: step 1 shows keep/reset; confirm is disabled until the preview resolved; the report renders "المحتوى باقي" with counts; Escape and focus trap still work (existing behaviour); a preview failure shows one error line and keeps the dialog open; RTL: dialog has `dir` from locale and the buttons keep reading order.
- [ ] **Step 2: Run** `npx vitest run tests/unit/template-family-diff.test.ts tests/integration/store-look-preview.test.ts apps/admin/src/components/looks/LookSwitchDialog.test.tsx; echo "exit=$?"` → FAIL.
- [ ] **Step 3: Implement** the diff function beside `applyTemplateFamily` (shared code path, not a copy), the service and route (Zod at the edge; `storeId` top-level in every query), the revision token (the draft revision id + `updatedAt`), `LookPreviewPane` and the two-step dialog. Preview copy, Egyptian full sentences, one helper line per control: «هنغيّر التصميم بس. المحتوى بتاعك زي ما هو.» / "Only the design changes. Your content stays." Do not auto-publish: the confirm result states "draft" or "published" exactly as the page already does (`result: 'draft' | 'published'`).
- [ ] **Step 4: Run** the three test files again → PASS. Then `npm run typecheck; echo "exit=$?"` → 0.
- [ ] **Step 5: Browser check** on the local stack with a seeded Qamar store that has content: switch Atelier → Lookbook, read the preview, confirm, reload the builder, check the hero slides and carousel are unchanged. Screenshot the dialog at 390 in Arabic, read the PNG. Run the `impeccable` critique on the dialog and fix P1s.
- [ ] **Step 6: Docs:** `docs/ebda/templates/looks.md` (switching section), `docs/architecture/store-theme-flags.md` (look switch row), Ruling EP-3.
- [ ] **Step 7: Commit** explicit paths → `feat(editor): preview a look switch in the merchant's own content before applying`.

---

### Task 3: Per-section controls that match each template's real variants

**Files:**

- Modify: `packages/shared/src/builder/settings-schema.ts` (field descriptor gains `shownFor`), `packages/shared/src/builder/registry.ts` (section descriptor gains `shownFor`; variant option lists carry ar + en labels; add any variant option that the renderer supports but the registry does not list, from the Task 1 `missing` rows)
- Modify: `apps/admin/src/app/stores/[id]/builder/_components/{SettingsPanel,AddSectionDialog,SectionTree}.tsx` (filter by `shownFor` against the store's resolved `{template, look}`; `AddSectionDialog` lists the template's own section types first, in storefront order, then the rest under one "more" group)
- Create: `packages/shared/src/builder/shown-for.ts` (`isShown(descriptor, { template, look }): boolean`, pure)
- Modify: `apps/admin/messages/{ar,en}.json` (variant labels, Egyptian-neutral: «شريط» rail, «مربعات» tiles, «عرض منتج واحد» stage, «المنتجات المخفّضة» on_sale, «خطوات» steps, «قايمة الأكل» menu, «بروفايل الصنايعي» maker-profile, «دوّر على هدية» gift-finder, and so on, final strings in the task)
- Test: `tests/unit/shown-for.test.ts`, `tests/unit/editor-variant-coverage.test.ts`, `apps/admin/src/app/stores/[id]/builder/_components/SettingsPanel.variants.test.tsx`

**The variant coverage table this task makes true** (authority is the Task 1 matrix; this table is the starting expectation, from the template docs):

| Template           | Section variants the editor must expose                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Qamar (main)       | hero `presentation: collage`; category-grid `layout: chips`; image-text `layout: full-bleed`; collection-list `tileShape: band` + block `tone`; testimonials `layout: single`; `shop-the-look` |
| Souq (after merge) | category-grid `layout: rail \| tiles`; product-spotlight `layout: stage`; product-carousel/featured-collection `productSource: on_sale`; search placement (chrome); compare toggle on stage    |
| Jasmine            | routine/steps (cleanse → treat → protect), ingredient lines, skin-type filter chips, concern tiles, shade dots density                                                                         |
| Lamma              | menu tabs, dish rows with portion, maker-profile strip, pre-order calendar chips, reorder row, sticky cart bar total                                                                           |
| Dahab (redesign)   | piece chips, journey steps (رسم ← صب ← تلميع), maker-profile strip, gift-finder (occasion × budget chips), packaging band, lead-time chips                                                     |

Rows for Jasmine, Lamma and Dahab stay `pending-template` until each template's registry entries merge; the coverage test reads the registry, so it begins asserting the moment the entries exist.

- [ ] **Step 1: Write the failing tests**
  - `shown-for.test.ts`: absent `shownFor` = shown everywhere; `templates`, `looks` and `variants` narrow correctly; an unknown template id (legacy store, `look = null`) shows the universal controls only and never throws.
  - `editor-variant-coverage.test.ts`: for every built look, every `type`+`layout/presentation/tileShape/productSource` value used in its `sections` mix is selectable in the registry for that template (the `missing` count from the matrix for built looks is 0); and the inverse: no `shownFor` narrows a control away from a look whose mix uses its value.
  - `SettingsPanel.variants.test.tsx`: render the settings panel for a `qamar` store, then a `souq` store, then a `look = null` legacy `minimal` store, on the same `category-grid` section → the option lists differ exactly as `shownFor` says; the legacy store's list equals today's snapshot (byte-identical expectation for legacy).
- [ ] **Step 2: Run** the three files → FAIL.
- [ ] **Step 3: Implement** `shown-for.ts`, thread the `{template, look}` context through `SettingsPanel` (it already receives the store), add `shownFor` only where the Task 1 matrix proved a control skin-owned. Default stays "shown everywhere": do not narrow a control to be tidy.
- [ ] **Step 4: Run** the test files + `npx vitest run apps/admin tests/unit/page-builder*.test.ts; echo "exit=$?"` → PASS; Phase S characterization tests unchanged and green.
- [ ] **Step 5: Run** `npm run editor:matrix; echo "exit=$?"` and confirm the `missing` count for built looks is 0. Commit the regenerated matrix with this task.
- [ ] **Step 6: Commit** → `feat(editor): section controls follow each template's real variants`.

---

### Task 4: Remove the controls that do nothing; hold the ThemeTab ceiling at 7

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/branding/_components/ThemeTab.tsx` and any control the matrix lists as `no-op` (the list is generated in Task 1; this task works through it row by row)
- Modify: `packages/shared/src/builder/settings-schema.ts` / `registry.ts` (delete the descriptor; the key stays accepted and ignored by the reader, Ruling EP-5)
- Modify: `docs/architecture/store-theme-flags.md` (the flag table: a flag no skin reads is deleted from the table, or its row is rewritten to say which skins read it)
- Modify: `scripts/editor-audit/baseline.json` (only for a `no-op` that cannot be removed this PR, each with a reason, an owner and a follow-up id; a row without those fails the test)
- Test: `tests/unit/themetab-ceiling.test.ts`, `tests/unit/editor-matrix.test.ts` (extended), `apps/admin/src/app/stores/[id]/branding/_components/ThemeTab.test.tsx`

For each `no-op` row, decide in this order and write the decision in the commit body: **(1) wire it** if the control is a platform promise a renderer should honour on this template (a bug, fix the renderer: CLAUDE.md rule "fix the defect class"); **(2) narrow it** with `shownFor` if exactly one skin owns it; **(3) remove it** if no current template reads it. A removal sweeps every consumer: the descriptor, the i18n keys in both locales, the registry entry in `settings-registry.ts`, the generated search index, the docs row, the tests.

- [ ] **Step 1: Write the failing tests**
  - `themetab-ceiling.test.ts`: parses `ThemeTab.tsx` and counts the merchant-facing toggle controls (elements carrying `data-theme-toggle`; Task 4 adds the attribute to each existing toggle) → `<= 7`; a second assertion fails with the message "next toggle goes to a dedicated page" so the failure explains itself.
  - `editor-matrix.test.ts`: the "accepted rows" test now also asserts `baseline.json` has no `no-op` row for a built look (the baseline may keep `pending-template` explanations only).
  - `ThemeTab.test.tsx`: renders for a `qamar` store and a legacy `bold` store; every rendered toggle is `wired` in the matrix for that template.
- [ ] **Step 2: Run** → FAIL on the first real `no-op` row.
- [ ] **Step 3: Implement** the decisions above; regenerate the matrix after each batch (`npm run editor:matrix`).
- [ ] **Step 4: Blast-radius sweep for every removed or narrowed control key** (state the result in the PR body): `git grep -n '<key>' -- apps packages tests docs scripts`, the i18n keys, `settings-registry.ts`, `settings-search-index.generated.json`, API Zod allow-lists (a theme PUT that still accepts the key is correct, EP-5), demo clone scripts, `.env.example`.
- [ ] **Step 5: Run** `npm run editor:matrix:check; echo "exit=$?"` → 0 with `no-op = 0` and `missing = 0` for the built templates; `npm run typecheck; echo "exit=$?"`; `npm run test:unit; echo "exit=$?"`.
- [ ] **Step 6: Commit** → `fix(editor): drop controls that do nothing on the new templates`.

---

### Task 5: The admin mirrors the storefront's top-to-bottom flow, and merchant chrome controls

**Files:**

- Modify: `apps/admin/src/app/stores/[id]/builder/_components/{ThemeSettingsPanel,ChromeContentPanel,SectionTree}.tsx` (group order derived from the template's section mix: announcement → header → hero → categories → merchandising rows → story/testimonials → newsletter → footer; `groupHeading` clusters, nested sub-controls)
- Modify: `packages/shared/src/builder/chrome-draft.ts` and `packages/shared/src/looks/types.ts` (`LookChrome` override keys the merchant may set: logo placement; search placement when Souq lands; header band), `apps/web/src/templates/qamar/Header.tsx` reads `merchant override ?? look chrome ?? default` (Ruling EP-4; `MinimalHeader`'s optional `logoPlacement` prop from B1-4 is the existing seam)
- Create: `apps/admin/src/lib/builder-flow-order.ts` (`flowOrder(template, look): SectionType[]`, pure, derived from `LookDefinition.sections` + the registry's default order)
- Test: `tests/unit/builder-flow-order.test.ts`, `apps/admin/src/app/stores/[id]/builder/_components/ThemeSettingsPanel.order.test.tsx`, `tests/unit/chrome-override.test.ts`

- [ ] **Step 1: Write the failing tests**
  - `builder-flow-order.test.ts`: for each built look, `flowOrder` equals the order sections render on the storefront home (the same list `HomePageBody` iterates, derived from the look mix); an extra merchant-added section sits at its document position.
  - `ThemeSettingsPanel.order.test.tsx`: the rendered group headings appear in `flowOrder` sequence for `qamar.atelier` and `qamar.lookbook`; no alphabetical sort; header chrome controls come before hero controls.
  - `chrome-override.test.ts`: merchant logo placement beats the look's; clearing it falls back to the look's; a look switch with `keep` retains it and with `reset` clears it (stated in the preview report, Task 2); a store with no override renders byte-identical Qamar header HTML to today (C16 snapshot unchanged).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** One helper line per control; the logo-placement control is a two-option segmented control (start / centre) with an icon, not a dropdown.
- [ ] **Step 4: Run** the three files + `npm run typecheck; echo "exit=$?"` → PASS.
- [ ] **Step 5: Browser check** in Arabic RTL at 1280 and 390: read the panel top to bottom against the storefront; screenshot both; `impeccable` critique, fix P1s.
- [ ] **Step 6: Docs:** `docs/ebda/templates/qamar.md` (chrome overrides), `docs/architecture/store-theme-flags.md` (canonical owners row), Ruling EP-4.
- [ ] **Step 7: Commit** → `feat(editor): order the admin like the storefront and add chrome overrides`.

---

### Task 6: Settings-registry entries for ⌘K, with a deep link into the builder

**Files:**

- Modify: `apps/admin/src/lib/settings-registry.ts` (one `setting` entry per new or renamed control from Tasks 3 to 5 and for every look-switch entry point; `kind: 'page'` entries for any new route; `syn` Arabic and English everyday words: «شريط الأقسام / رف / مربعات», "category rail / tiles", «غيّر الشكل», "change look")
- Modify: `apps/admin/src/lib/settings-search.ts` and the builder page (`builder/page.tsx`, `SectionTree`) so `?setting=<id>` on `/builder` selects the owning section and opens its field group (the existing `useSettingHighlight` handles scroll and highlight on pages; the builder needs section selection added)
- Modify: `apps/admin/messages/{ar,en}.json` (labels once, both languages), then `npm run gen:settings-search -w apps/admin`
- Test: `tests/unit/settings-registry.test.ts` (existing, must stay green; new cases added), `apps/admin/src/app/stores/[id]/builder/_components/builder-deeplink.test.tsx`

- [ ] **Step 1: Write the failing tests:** every control id introduced in Tasks 3 to 5 exists in the registry AND has a `data-setting-id` anchor in source (the existing coverage test enforces both directions once the anchors land; add an explicit list assertion so a forgotten control names itself); labels resolve in ar and en; the Arabic query «شريط» ranks the category-rail entry first and "rail" does too; opening `/builder?setting=category-grid.layout` selects the first category-grid section and highlights the layout field; a deep link to a control the store's template does not show falls back to the section with no highlight and no error (Review Focus 6).
- [ ] **Step 2: Run** `npx vitest run tests/unit/settings-registry.test.ts apps/admin/src/app/stores/\[id\]/builder/_components/builder-deeplink.test.tsx; echo "exit=$?"` → FAIL.
- [ ] **Step 3: Implement**; regenerate the index; confirm the generated file is the only generated diff.
- [ ] **Step 4: Run** the same files → PASS; `npm run typecheck; echo "exit=$?"`.
- [ ] **Step 5: Browser check:** type the Arabic query in ⌘K on a Qamar store, press Enter, land on the right section with the field highlighted.
- [ ] **Step 6: Docs:** `docs/architecture/admin-search.md` (builder deep link). Commit → `feat(editor): find the new template controls with command-k`.

---

### Task 7: Arabic-first RTL walk with a live preview in the merchant's own content

**Files:**

- Create: `playwright.editor.config.ts`, `tests/editor/look-switch.spec.ts`, `tests/editor/variants.spec.ts`, `tests/editor/rtl-a11y.spec.ts`
- Create: `scripts/editor-audit/seed-scenario.mjs` (a local-only store with the merchant's own products and Arabic copy, a hero, a carousel and testimonials; uses `createPrismaClient({ role: 'owner' })`, refuses a non-loopback database)
- Modify: `apps/admin/src/app/stores/[id]/builder/_components/Canvas.tsx` only if the walk finds the live preview not reflecting a settings change within one frame (the preview must use the draft, never a fixture)
- Test: the three specs

Scenario list (each runs Arabic RTL first, 390 and 1280; then English at 390): (1) switch Atelier → Vitrine with preview, confirm, content intact; (2) switch with `reset`; (3) change `category-grid` layout through every option the template exposes and see the Canvas update; (4) delete then re-add the template's own section from `AddSectionDialog`; (5) ⌘K to a control; (6) cancel the preview and confirm nothing changed in the draft; (7) empty store (no products): the preview renders what the storefront renders (nothing for unfilled features), plus one editor-only hint line; (8) near-white primary / missing logo guard (B1 Review Focus 4) still passes after a switch.

- [ ] **Step 1: Write the specs** (assertions: no horizontal page scroll at 390, every control reachable by keyboard, axe has 0 serious/critical, the dialog restores focus, text never under 12px, the Canvas shows the merchant's product names, not fixture names).
- [ ] **Step 2: Run** `npx playwright test -c playwright.editor.config.ts; echo "exit=$?"` → FAIL where the UI is not yet right.
- [ ] **Step 3: Fix** what the walk finds; screenshot and READ each PNG (Arabic first); run the `impeccable` critique and the independent taste + a11y audits (gate: at least 28/40, 0 P0/P1; the audit scores against the taste profile and `quality-bar.md`).
- [ ] **Step 4: Commit** → `test(editor): rtl walk of look switch, variants and search`.

---

### Task 8: Rulings, docs parity, close-out

**Files:** `docs/RULINGS.md`, `docs/architecture/store-theme-flags.md`, `docs/architecture/admin-search.md`, `docs/ebda/templates/{looks,qamar}.md` (+ `souq.md`, `dahab.md` when merged), `docs/ebda/templates/editor-matrix.md` (regenerated).

- [ ] **Step 1:** Append Rulings EP-1..EP-5 (each: decision, evidence, `Cost if wrong:`), check the set is complete against this plan.
- [ ] **Step 2:** `npm run editor:matrix:check; npm run typecheck; npm run lint; npm run test:unit; npm run test:integration; echo "exit=$?"` with the exit code of each captured on its own line, not through a pipe.
- [ ] **Step 3: Blast-radius sweep** over every identifier this plan added or removed (`shownFor`, `flowOrder`, `previewLook`, `DRAFT_MOVED`, `revisionToken`, each removed control key, each new `data-setting-id`) across code, CI, docs, scripts, sibling apps; state the result in the PR body (`blast-radius: swept <ids> across <scopes> → clean` or `→ found + fixed N`).
- [ ] **Step 4:** Documentation parity check, then PR. After merge and deploy: the changed paths are verified against the running admin (the preview endpoint, one look switch on a demo store, the deep link) and the PR states what could NOT be verified (production merchant data) and why.
- [ ] **Step 5: Commit** → `docs(editor): rulings and matrix for the editor pass`.

---

## Self-review (done while writing)

- Spec coverage: look switch keeps content + preview (Task 2); per-section controls per template (3); no-op removal + ceiling 7 (4); storefront flow (5); registry for ⌘K (6); Arabic-first RTL + live preview (2, 7); audit method + generator script as Task 1.
- Dependencies are explicit: Souq-specific rows wait for the Souq merge; Jasmine, Lamma, Dahab rows are `pending-template` and flip automatically; Task 4 needs Tasks 1 and 3.
- The plan adds no product-card render path and changes no checkout, pricing or inventory code.
