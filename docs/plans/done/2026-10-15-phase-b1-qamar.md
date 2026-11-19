# Phase B1 — Qamar (fashion & boutiques) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Qamar's three looks (Atelier, Lookbook, Vitrine) as real storefronts, flip them to `built`, seed a realistic Egyptian fashion catalogue on `storedemo.ebda.app` with a non-persisting template → look selector and server-refused checkout, then link it from ebda.app (MKT-15) and the unknown-subdomain 404.

**Architecture:** Qamar is ONE new skin id (`qamar`, enum value + the six `Record<TemplateId,…>` maps) that owns only chrome (a header wrapper that reads the look's chrome choice), a `PACK_STYLES.qamar` card/heading flavour and `[data-pack='qamar']` CSS; cards, PDP, cart and checkout stay on the shared/minimal components, so no new card render path and no PDP fork. Each look's character comes from data: its tokens (already in the registry), a new per-look **section mix** (`LookDefinition.sections`) applied by the existing `applyTemplateFamily`, and five **platform section variants** that every skin renders (collage hero, chip category row, full-bleed image break, band collection tiles, single testimonial) plus one new document-only section, `shop-the-look`. The demo store keeps one superset home document and renders it through the previewed look's mix at request time, only when `store.isDemo`.

**Tech Stack:** Next.js 16 App Router (apps/web, apps/admin, apps/marketing), Express on Cloudflare Workers (apps/api), Prisma + Neon (strict RLS + tenant guard), Zod in `@ebda/shared`, Vitest, Playwright + axe-core, R2 (`ebda-media`, `https://media.ebda.app`), FLUX.1 schnell on Workers AI (offline image generation), ffmpeg (hero video).

**Spec:** `docs/plans/done/2026-10-14-templates-and-editor-program.md` (Phase B, scenario matrix, review loop, Rulings TPL-1..3). Read with it: `docs/ebda/templates/2026-10-14-directions.md` (Qamar A/B/C briefs), `docs/ebda/templates/looks.md`, `docs/ebda/templates/demo-store.md`, `docs/ebda/templates/platform-commerce.md`, `docs/plans/done/2026-10-14-phase-b0-platform-commerce.md` (§ Taste bar, B0-4 as amended by B0-49), `docs/plans/done/2026-10-14-marketing-levelup.md` (MKT-3), `docs/ebda/templates/research/qamar.md`.

## Coordinator amendments (binding; override task text where they conflict)

- **C1 (T2/T3)** — T2's Atelier mix omits `layout:'chips'` and `layout:'full-bleed'`; T3 adds those values to the schemas AND to the Atelier mix, and keeps `tests/integration/store-look.test.ts` green in both tasks.
- **C2 (T3/T7)** — schema test fixtures include the required fields (`desktopColumns`, `mobileColumns`, `autoplayMs`).
- **C3 (T6)** — archive ALL five placeholder families incl. the Phase S fashion products and the `fashion` category; rename `CATALOGUE` once and update its guard test.
- **C4 (T11)** — no agent production action: the API deploy dispatch, every production SQL and the R2 upload/seed are STOP 2/3 items the controller runs only after Ahmad approves. The demo order refusal is proven LOCALLY (all order paths); no production order attempt.
- **C5 (all)** — exact test file names, no globs (e.g. `builder-homepage-characterization.test.tsx`).
- **C6 (T2)** — on a look switch, any look-owned setting the incoming look does not set is reset to the section default (no leakage between looks); test Lookbook→Atelier and Vitrine→Lookbook.
- **C7 (T2)** — Atelier's carousel preset uses `newest` (never a demo category slug).
- **C8 (T2, TPL-1)** — with `design:'keep'` a switch preserves every section-setting field the merchant changed from the OUTGOING look's preset (field-level diff); with `reset` or for newly added sections the incoming preset applies. Tests for both.
- **C9 (T2/T5)** — add the Review Focus tests: Atelier→Vitrine switch keeps content; merchant-extreme contrast guard for the Qamar looks.
- **C10 (T6/T9)** — the demo showroom page holds one hero section per look (each with its own imagery/video); each look's mix selects its own hero, consistent with B1-8.
- **C11 (T7)** — shop-the-look product refs: extend the ref collection to blocks so an unknown or cross-store id gets the existing `REF_NOT_FOUND` warning (test it); rendering is store-scoped and skips missing/foreign products (test a foreign id never renders).
- **C12 (T9)** — the demo-order coverage test pins exactly the 3 `.order.create(` sites by named function (OrderService.create, createAdminOrder, the WhatsApp payment-link creator) and fails on any `order.upsert`, `order.createMany` or raw `INSERT INTO orders`.
- **C13 (T9)** — demo store also refuses `/public/:storeId/affiliates/apply` and `/public/:storeId/push/subscribe`; correct B1-13's contact reasoning (`/contact` has no store lookup and emails Ebda's sender) — the demo refuses it anyway.
- **C14 (T9)** — `robots.ts` resolves the store via `/public/store/resolve` (`isDemo`) and emits noindex for the demo host.
- **C15 (T3/T4)** — the full-bleed image break puts a SOLID scrim (or solid panel) behind the text block; the contrast test measures text over that scrim at ≥ 4.5:1 for every Qamar look.
- **C16 (T5)** — add a before/after `MinimalHeader` snapshot proving non-Qamar headers are unchanged.
- **C17 (T6)** — SKUs from full value slugs (no collisions); shipping zones and size charts use find-then-update/create; personalisation `enabled:true`; API imports stay inside `run()`.
- **C18 (T6)** — drop `hero.webm` (one MP4 source); per-image cap 140 KB, total demo asset budget ≤ 7 MB, enforced by the test; update B1-9 text.
- **C19 (T7)** — use `HeroBannerLink`'s real props `{link, label, urlPrefix, children}`; no nested `data-section="hero"`; add "Look total" to LanguageContext (ar+en). Shop-the-look item rows ARE a product render path: add them to the CLAUDE.md card-path list and pass the same price / compare-at / sold-out fields through the shared helpers; sold-out items show the shared sold-out label and stay linkable.
- **C20 (T10)** — update the four LookPicker tests for the Qamar-first default and `git add` the test file.
- **C21 (STOP 2)** — merge order: `feat/policy-change-notify` merges BEFORE B1 (migration-order gate).
- **C22 (new STOP 1b after T8)** — Ahmad reviews Lookbook and Vitrine screenshots (same set as Atelier) before T10 flips them to `built`.
- **C23 (STOP 2)** — before merge, the controller counts production stores on a Qamar look (read-only SQL) and rules on moving them to the `qamar` skin.
- **C24 (T10)** — `docs/architecture/page-definition.md` gains the new variants and `shop-the-look`.
- **C25 (all)** — no hardcoded `:3100`; use a free port passed in, never kill processes you did not start.
- **C26 (T1)** — `ROLLBACK.md` gets a Qamar enum section (date 2026-10-18).
- **C27 (T1)** — admin `skins.qamar` label ar+en (not selectable as a raw skin).
- **C28 (T7)** — Lookbook hero overlay is a dark scrim under light text; covered by the contrast test.
- **C29** — commit scopes from commitlint's scope-enum.
- **C30 (T12)** — pass `${{ vars.SHOW_DEMO_STORE_LINK }}` via `env:` then `"$SHOW_DEMO_STORE_LINK"` in the shell.
- **C31 (Ahmad 2026-10-15, Ruling TPL-4) — NEW Task 13, after Task 12 / storedemo verified live:** replace the Qamar illustrative captures in the ebda.app looks showcase (apps/marketing: the #looks phones for Atelier / Lookbook / Vitrine, the hero phone if it cycles Qamar, any Qamar story images) with captures of the REAL storefront from storedemo (Arabic first; English variants for /en), generated by a reproducible capture script (Playwright against storedemo, deterministic, committed under scripts/), optimised WebP/AVIF within the marketing image budget. Phone-frame edge quality is the acceptance bar: the screen image clipped to the frame's exact inner radius (no square corners, seams, white/dark slivers or bleed), crisp at 1×/2×, notch/safe-area respected, consistent bezel + shadow in light and dark, RTL and LTR correct, no CLS. Gate: marketing screenshots at 390/820/1280 ar+en plus zoomed crops of all four corners of every phone, an impeccable critique pass, and the marketing checks (`check:a11y`, `check:links`, `check:lighthouse` — mobile perf must not drop >5 points). Remove the "illustrative" label only for templates now shown live. Ships as its own small marketing PR right after storedemo is verified; merged without asking per standing rule.

## Global Constraints

- Arabic-first: every surface is designed and screenshotted in Arabic (RTL, Arabic-Indic numerals on for the matrix run) first, then English. Every storefront string lives in `apps/web/src/contexts/LanguageContext.tsx` (EN + AR); no hardcoded copy in a skin.
- Taste bar (B0-4 as amended by B0-49) is binding on every UI task: card = at most 5 swatch dots (then `+N`) and at most 2 fact chips below the price, nothing else; no HOT/FEATURED badges, stock nags, countdowns or second CTA; one accent for the primary action; unfilled features render nothing; at most one helper line per control; no gradient text, side-stripe borders, glassmorphism or ghost cards; radius from `var(--radius)` only; PDP fold at 390 = gallery, title, price, first selector, add-to-cart via the sticky bar.
- Motion: the three B0 moments plus exactly the per-look hero moments in Ruling B1-7; ease-out-quint or ease-out-expo, no bounce, every animation has a reduced-motion end state.
- Shared bar from the directions doc: calm, premium, clear; AA contrast (4.5:1 text); nothing under 12px; no cream/sand body backgrounds; no eyebrow label over every section; no cards+shadow+border stacks; logo prominent; one continuous scroll; first screen shows the categories quickly.
- Card paths rule (CLAUDE.md): the 8 card paths + Dahab + the 4 hand-built mappers. B1 adds NO card render path (Ruling B1-1); a reviewer rejects any task that adds one.
- Looks are data over the shared section registry, never forked commerce code (LOOKS-1). Legacy stores (`look = null`) and every non-Qamar look stay byte-identical (Phase S characterization tests must stay green unchanged).
- Must not change: checkout, pricing, inventory (`products.inventory` stays 0 for variant products; stock is the active variants' sum), permissions, tenant isolation, existing stores' published pages, Dahab's look.
- Migrations additive only; enum value via `ALTER TYPE … ADD VALUE IF NOT EXISTS`; no `lock_timeout` (B0-50).
- Tenant guard: every Prisma query carries a top-level `storeId` = the ambient store; scripts use `createPrismaClient({ role: 'owner' })`; `withOwnerTx` / `withRlsBypass` stay out of `apps/api/src`.
- Commits: `git add <explicit paths>` only (never `-A`/`.`), lowercase commitlint subjects, never `--no-verify`, each commit ends with the two trailers below after a blank line:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5`
- No production access by an agent. Production writes (R2 upload, `--yes-production` seed, repo variable flip) are Ahmad's STOP points.
- Doc parity: `docs/ebda/templates/qamar.md`, `looks.md`, `demo-store.md`, `platform-commerce.md` (if touched), `docs/ENVIRONMENT.md`, `docs/ROLLBACK.md`, `docs/RULINGS.md` updated in the task that changes the behaviour they describe.
- Gates are run with the exit code captured per command, never through a pipe (`cmd; echo "exit=$?"`).

## Review Focus

1. **A demo visitor clicks a product on `storedemo` while previewing Lookbook** → the PDP must still render Lookbook, not silently fall back to the store's stored look (Phase S drops `?look=` on navigation). Pinned by Task 9's link-persistence test and the Task 10 Playwright walk.
2. **A merchant switches an existing store from Atelier to Vitrine** → their hero slides, image-text copy and carousel choices survive; only design keys from the mix change; a section type Vitrine does not use is dropped from the DRAFT (never from live) and is restorable from revision history. Pinned by Task 2's `applyTemplateFamily` keep-content tests.
3. **A shopper on `storedemo` tries to leave PII or place an order through any route** (checkout, admin order, WhatsApp payment link, register, newsletter, contact) → 403 `DEMO_STORE`, no row written, no email sent. Pinned by Task 9's integration test and the static `order.create(` coverage test.
4. **The look's own extremes under merchant edits**: a merchant overrides Lookbook's primary to near-white or removes the logo → no text under 4.5:1 from skin-painted pairs, header still usable, no blank wordmark. Pinned by Task 5's contrast test (merchant-extreme cases) and the Task 10 scenario stores (`qamar-edge`).
5. **Platform variants on other skins**: a Dahab or minimal store that picks the new `collage` hero / `chips` categories / `band` tiles / `single` testimonial in the editor renders a sane section, not a broken one. Pinned by the cross-skin render tests in Tasks 3, 7 and 8.

---

## Rulings made by this plan

Appended to `docs/RULINGS.md` under a new heading `## 2026-10-15 — Phase B1 Qamar (B1-*)` in Task 10 (the implementer appends each ruling at the moment the task that makes it lands; Task 10 only checks the set is complete).

- **Ruling B1-1 — Qamar is one skin, `qamar`, that owns chrome only; cards, PDP, cart and checkout stay shared.** The skin is `apps/web/src/templates/qamar/` (Header wrapper + index re-exports of `minimal` pieces) + `PACK_STYLES.qamar` + `[data-pack='qamar']` CSS. Evidence: Dahab's forked PDP/card cost 12 handover sites and a permanent extra card path (CLAUDE.md card rule); every Qamar card need (3:4 ratio, swatches, facts, no frame) is already expressible through look tokens + pack styles. Cost if wrong: a later look needing a card shape pack styles cannot express needs a card-level variant across all card paths.
- **Ruling B1-2 — the new layouts are platform section variants, rendered by every skin.** hero `presentation: 'collage'`, category-grid `layout: 'chips'`, image-text `layout: 'full-bleed'`, collection-list `tileShape: 'band'` + block `tone`, testimonials `layout: 'single'`, and a new document-only section `shop-the-look`. Evidence: Phase S contract §2 ("templates contribute variants of shared sections, not forks"), CLAUDE.md platform-level rule. Cost if wrong: each variant must keep rendering on 7 skins (tested on minimal, dahab, qamar).
- **Ruling B1-3 — a look carries an optional section mix: `LookDefinition.sections` = ordered `{ type, design?, preset? }`.** `applyTemplateFamily(current, family, look)` uses the look's order; `design` keys are applied to existing sections too (a look switch is a design change), `preset` keys only seed a section the store did not have; content keys (text, images, product refs, blocks) are never overwritten. Evidence: TPL-1 consequence "switching look keeps the merchant's content … only design changes"; today every look of a template gets the same family mix. Cost if wrong: a merchant who hand-set a design key (say hero presentation) loses it on a look switch; it stays in revision history and the draft is never auto-published for a store with content (LOOKS-8..10).
- **Ruling B1-4 — chrome choices (header logo placement, header band) are look data `LookDefinition.chrome`, read by the qamar skin, not merchant settings in B1.** `MinimalHeader` gains an optional `logoPlacement` prop (default `'start'`, byte-identical for every current caller). Evidence: header/footer live outside the page document (`applyTemplateFamily` leaves them as the store has them); a merchant setting belongs to Phase E's editor pass. Cost if wrong: a Qamar merchant cannot move the wordmark until Phase E.
- **Ruling B1-5 — Vitrine's champagne becomes its `line` token (`#D8B96A`); the hero frame hairline and the third occasion band read `--border`; no new colour role.** Evidence: ink on champagne 9.14:1, champagne on page 1.74:1 vs the old line 1.21:1 (better non-text contrast, WCAG 1.4.11); the token contract has exactly 8 roles (Phase S §1) and the editor edits roles only. Cost if wrong: every Vitrine hairline and input border is champagne; reverting is one token.
- **Ruling B1-6 — `shop-the-look` items are links (thumbnail, name, price) to the PDP: no per-item quick add, no "add the whole look".** Evidence: every Qamar demo garment needs a size (and often a length); an add-all would either fail or need a multi-size sheet, and a per-item add would be a new card path (B1-1). Cost if wrong: the "whole outfit in one tap" idea is one tap per item weaker; a size sheet can be added later on top of the same section.
- **Ruling B1-7 — motion per look.** Atelier adds none. Lookbook: the collage's three photos settle once on first paint (opacity 0→1, translateY 12px→0, 280 ms ease-out-quint, 60 ms stagger), its look carousel is native `scroll-snap` with no JS animation. Vitrine: the hero frame hairline draws once (`clip-path` inset 50%→0, 600 ms ease-out-quint). Reduced motion: final state at once. These two hero moments join B0's three. Evidence: the directions' motion lines; taste bar "motion only where it means something". Cost if wrong: one more review round on motion.
- **Ruling B1-8 — the demo store's home document is a superset of every Qamar section; on an `isDemo` store the web renders it through the current look's mix (`applyTemplateFamily(def, look.template, look)`) at request time.** Non-demo stores never take this path. Evidence: `applyDemoLook` swaps only template/look/theme (LOOKS-12), so without this every look would show Atelier's sections on `storedemo`. Cost if wrong: one pure-function call per demo home render; a merchant store is unaffected by construction (the branch keys on `store.isDemo`).
- **Ruling B1-9 — demo photos: generated in-palette (FLUX.1 schnell, the TPL-3 pipeline), labelled illustrative, committed as WebP under `scripts/qamar-demo/assets/` (≤ 140 KB each, ≤ 4 MB total), served from production R2 `ebda-media` under `demo/qamar/` with `Cache-Control: public, max-age=31536000, immutable`.** Every file is read back (viewed) before commit; any lettering → regenerate (the "ZAS" class). They are referenced by `product_images.url`, `product_option_values.swatch_image_url` and the published page document, all in `R2_REFERENCE_COLUMNS`, so the weekly orphan sweep keeps them. Local runs serve the same directory on `http://localhost:9000` (already allowed by `apps/web/next.config.js` remotePatterns in dev). Evidence: committed files make the seed reproducible (FLUX output is not); the Dahab demo used an r2.dev bucket that is preview-only. Cost if wrong: ~4 MB in git history; a later move to an assets bucket is a re-upload plus a seed re-run.
- **Ruling B1-10 — hero video = an ffmpeg slow push-in (6 s loop, 1280×720, no audio) over the Atelier hero still, MP4 (H.264, ≤ 1.5 MB) + WebM; the still is the poster.** Evidence: B0's `HeroVideo` needs a real clip to be exercised; a generated video model adds cost and text artefacts; B0-2's cap is 6 MB. Cost if wrong: the demo video reads as a slideshow, not footage; replaceable by one upload.
- **Ruling B1-11 — on a demo store, `DemoLookBar` keeps the previewed look across same-origin link clicks** (a capture-phase click handler appends `look=<id>` and does a full document load). Programmatic navigations (`router.push`, e.g. cart → checkout) still drop it. Evidence: LOOKS-12 forbids a cookie (shared-cache key); without this, clicking any product on a Lookbook preview shows Atelier. Cost if wrong: checkout shows the store's stored look; checkout is refused on the demo anyway.
- **Ruling B1-12 — the demo bar is two selects, template then look (MKT-3 wording); a template with no built look is not listed.** Cost if wrong: one extra control on a 12px bar; reverting is one component.
- **Ruling B1-13 — demo-store abuse limits: PII-collecting public writes are refused with 403 `DEMO_STORE` (customer register with a `storeId`, newsletter subscribe, contact form); carts stay allowed under the existing `cartLimiter`; orders stay refused by `assertOrderAllowed`, now pinned by a static test that every `.order.create(` in `apps/api/src` sits in a function that calls it.** No reset cron: the idempotent seed is the reset, and the owner cannot log in (`passwordHash '!seed-no-login'`). Review submit is unreachable (it needs an order). Evidence: the contact form would email `storedemo-owner@ebda.app`, a mailbox that does not exist (bounce rate); register/newsletter collect visitor PII for a store nobody runs. Cost if wrong: a visitor cannot try account sign-up on the demo; they can on their own store.
- **Ruling B1-14 — `storedemo` is noindex: `robots.txt` disallows `/`, the root metadata says `noindex, nofollow`, the sitemap is empty, when `store.isDemo`.** Cost if wrong: none; marketing links still work.
- **Ruling B1-15 — `storedemo` carries only built templates' catalogues; the Phase S placeholder families (electronics, beauty, home and kitchen, jewellery) are archived by the seed (`status: 'archived'`, category `isActive: false` when that column exists, else left with no active product), never deleted.** Cross-template catalogue scoping is decided in the B2 (Souq) plan when a second template is built. Cost if wrong: B2 needs a scoping mechanism before Souq joins the demo.
- **Ruling B1-16 — the production seed and the R2 upload are Ahmad-approved STOP points.** `scripts/storedemo/seed.mjs` keeps refusing a non-loopback DB without `--yes-production`, and with `--yes-production` also refuses an asset base that is not `https://media.ebda.app/demo/qamar`. Cost if wrong: none.
- **Ruling B1-17 — `qamar` is not a bare skin choice:** `StoreService.updateTemplate`'s valid list and the admin `SKIN_IDS` stay the legacy six; a store reaches `qamar` only through a look (`applyLook` writes `template = look.skin`). Cost if wrong: none; a bare-skin picker for Qamar has no meaning without a look.
- **Ruling B1-18 — MKT-15 and `SHOW_DEMO_STORE_LINK` ship as a second PR (`feat/b1-mkt15-demo-link`) opened only after Task 11's production verification passes; the flag becomes a `--var` fed from the repo variable `SHOW_DEMO_STORE_LINK` in `cf-web-deploy.yml`.** Evidence: `apps/web/wrangler.jsonc` is regenerated in CI by `scripts/cf-setup-local.sh` with no `vars` and no `keep_vars`, so a dashboard var would be wiped on the next deploy; linking before the seed runs is a 404 window. Cost if wrong: the marketing link lands a day later.
- **Ruling B1-19 — `LookPicker` opens on the first template that has a built look when no look is chosen (Qamar on day one); all 15 looks stay selectable (Phase S).** Cost if wrong: Dahab loses first position in the picker; one line to revert.
- **Ruling B1-20 — the scenario matrix's "card payment" case is verified by a unit render of `PaymentStep` with a card method in the mocked `/payments/config`; the local stack has no card provider credentials.** Cost if wrong: a card-only visual defect in a Qamar look reaches review; COD and the demo notice are verified in the browser.
- **Ruling B1-21 — Lookbook's card quick add is dropped; `showQuickAdd` stays a merchant behaviour flag, not a look token.** Evidence: `LOOK_TOKEN_KEYS` owns design keys only; fashion cards route to the PDP for a size anyway (`ProductCardCta`). Cost if wrong: one extra tap on Lookbook cards.
- **Ruling B1-22 — Atelier's press-logo strip (research) is left out.** A new merchant has no press; the taste bar forbids placeholders. Cost if wrong: Atelier lacks one Mamzi signal; a press section can come with real data later.
- **Ruling B1-23 — the Atelier look is reviewed by Ahmad before Lookbook and Vitrine are built (STOP 1); the scenario matrix runs on dedicated local scenario stores, not on `storedemo`.** Evidence: CLAUDE.md UI rule 10 (2–4 review rounds); the matrix needs empty / 1 / 500-product stores that a showroom must not become. Cost if wrong: a review round waits on Ahmad's availability.

---

## File map

| File                                                                                                                                                                                                                                                                                                          | Responsibility                                                             | Task               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------ |
| `packages/database/prisma/schema.prisma` (enum `StoreTemplate`) + `packages/database/prisma/migrations/20261023000100_store_template_qamar/migration.sql`                                                                                                                                                     | enum value `qamar`                                                         | 1                  |
| `packages/shared/src/types/store-theme.ts`                                                                                                                                                                                                                                                                    | `TemplateId` + `TEMPLATE_THEMES.qamar` + `TEMPLATES` entry                 | 1                  |
| `packages/shared/src/types/template-baselines.ts`, `image-standards.ts`                                                                                                                                                                                                                                       | `qamar` baseline / image hint                                              | 1                  |
| `apps/web/src/templates/{index.ts,shared/pack-styles.ts}`, `apps/web/src/lib/serverTemplate.ts`, `apps/web/src/app/layout.tsx`                                                                                                                                                                                | skin registration, `data-pack='qamar'`                                     | 1                  |
| `apps/api/src/services/provisioning.service.ts`                                                                                                                                                                                                                                                               | template union                                                             | 1                  |
| `apps/web/src/templates/qamar/{index.ts,Header.tsx}`, `apps/web/src/templates/minimal/Header.tsx` (`logoPlacement`)                                                                                                                                                                                           | Qamar chrome                                                               | 5                  |
| `packages/shared/src/looks/{types.ts,registry.ts,mix.ts}`                                                                                                                                                                                                                                                     | `LookSectionSpec`, `LookChrome`, per-look mixes, `skin: 'qamar'`, `status` | 2, 7, 8, 10        |
| `packages/shared/src/builder/template-families.ts`                                                                                                                                                                                                                                                            | `applyTemplateFamily(current, family, look?)`                              | 2                  |
| `apps/api/src/services/page-builder.service.ts`                                                                                                                                                                                                                                                               | pass the look into `applyTemplateFamily`                                   | 2                  |
| `packages/shared/src/builder/{layout-schema.ts,registry.ts,sections-document-only.ts}`, `packages/shared/src/types/store-layout.ts`                                                                                                                                                                           | variant enums + `shop-the-look`                                            | 3, 7, 8            |
| `apps/web/src/templates/shared/{CategoryChips.tsx,HeroCollage.tsx}`, `apps/web/src/builder/sections/{ImageTextSection,CollectionListSection,ShopTheLookSection}.tsx`, `apps/web/src/templates/shared/TestimonialRow.tsx`, `apps/web/src/builder/render/PageRenderer.tsx`, `apps/web/src/app/HomePageBody.tsx` | variant renderers                                                          | 3, 7, 8            |
| `apps/web/src/styles/globals.css`                                                                                                                                                                                                                                                                             | `[data-pack='qamar']` + per-look motion                                    | 5, 7, 8            |
| `scripts/qamar-demo/{catalogue.mjs,prompts.py,gen.py,make-video.sh,assets/,CREDITS.md}`                                                                                                                                                                                                                       | demo catalogue + illustrative assets                                       | 6                  |
| `scripts/storedemo/seed.mjs` (+ `scripts/storedemo/qamar-home.mjs`, `scripts/storedemo/scenario-stores.mjs`)                                                                                                                                                                                                  | showroom + local scenario stores                                           | 6, 10              |
| `apps/web/src/lib/demo-home.ts`, `apps/web/src/components/demo/DemoLookBar.tsx`, `apps/web/src/app/{robots.ts,sitemap.ts}`, `apps/web/src/lib/storefront-metadata.ts`                                                                                                                                         | demo surface                                                               | 9                  |
| `apps/api/src/services/plan-limit.service.ts` (`assertNotDemoStore`), `apps/api/src/routes/{auth.routes.ts,public.routes.ts}`                                                                                                                                                                                 | demo PII refusals                                                          | 9                  |
| `apps/admin/src/components/looks/LookPicker.tsx`                                                                                                                                                                                                                                                              | open on first built template                                               | 10                 |
| `playwright.qamar.config.ts`, `tests/qamar/*.spec.ts`                                                                                                                                                                                                                                                         | scenario matrix                                                            | 10                 |
| `apps/marketing/src/{lib/site.ts,lib/content.ts,components/Home.tsx}`, `.github/workflows/cf-web-deploy.yml`                                                                                                                                                                                                  | MKT-15 + flag (second PR)                                                  | 12                 |
| `docs/ebda/templates/{qamar.md,looks.md,demo-store.md}`, `docs/RULINGS.md`, `docs/ENVIRONMENT.md`, `docs/ROLLBACK.md`, `docs/DEPLOYMENT.md`                                                                                                                                                                   | docs                                                                       | each task + 10, 12 |

Order and STOP points: Tasks 1–6 build the platform + Atelier → **STOP 1 (Task 6, Ahmad's look review)** → Tasks 7–8 Lookbook, Vitrine → Task 9 demo surface → Task 10 matrix, flip to built, docs → **STOP 2 (Task 11: Ahmad approves merge; STOP 3: R2 upload + `--yes-production` seed)** → production verification → **STOP 4 (Task 12: Ahmad flips the repo variable)**.

---

### Task 1: `qamar` skin id end to end (enum, shared maps, web registration)

**Files:**

- Modify: `packages/database/prisma/schema.prisma:830-837` (enum `StoreTemplate`)
- Create: `packages/database/prisma/migrations/20261023000100_store_template_qamar/migration.sql`
- Modify: `packages/shared/src/types/store-theme.ts:16` (`TemplateId`), `:613` (`TEMPLATE_THEMES`), `TEMPLATES` array
- Modify: `packages/shared/src/types/template-baselines.ts:193-195` (`Exclude<…>`), `:311-318`
- Modify: `packages/shared/src/types/image-standards.ts` (only if a `Record<TemplateId>` is required there — it is `Partial`, so no entry needed; verify with typecheck)
- Modify: `apps/web/src/templates/index.ts`, `apps/web/src/templates/shared/pack-styles.ts:52`, `apps/web/src/lib/serverTemplate.ts:81`, `apps/web/src/app/layout.tsx:557`
- Modify: `apps/api/src/services/provisioning.service.ts:57`
- Create: `apps/web/src/templates/qamar/index.ts` (re-exports only in this task; the Header lands in Task 5)
- Modify: `docs/ROLLBACK.md` ("enum value added" section)
- Test: `tests/unit/qamar-template.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `TemplateId` includes `'qamar'`; `TEMPLATE_THEMES.qamar`, `TEMPLATE_LAYOUT_BASELINES.qamar`, `PACK_STYLES.qamar`, `getHomepageTemplate('qamar')`, `getTemplateComponents('qamar')`; `<body data-pack="qamar">` for a store whose `template === 'qamar'`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/qamar-template.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  TEMPLATE_THEMES,
  TEMPLATE_LAYOUT_BASELINES,
  TEMPLATES,
  getTemplateTheme,
} from '@ebda/shared';

const root = path.resolve(__dirname, '../..');

describe('qamar skin id', () => {
  it('is a StoreTemplate enum value with an additive migration', () => {
    const schema = readFileSync(path.join(root, 'packages/database/prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/enum StoreTemplate \{[^}]*\bqamar\b[^}]*\}/s);
    const mig = path.join(
      root,
      'packages/database/prisma/migrations/20261023000100_store_template_qamar/migration.sql'
    );
    expect(existsSync(mig)).toBe(true);
    const sql = readFileSync(mig, 'utf8');
    expect(sql).toContain(`ALTER TYPE "StoreTemplate" ADD VALUE IF NOT EXISTS 'qamar';`);
    expect(sql).not.toMatch(/lock_timeout|DROP|UPDATE/i);
  });

  it('has a theme, a baseline and a template entry', () => {
    expect(TEMPLATE_THEMES.qamar).toBeDefined();
    expect(TEMPLATE_LAYOUT_BASELINES.qamar).toBeDefined();
    expect(TEMPLATES.find(t => t.id === 'qamar')?.nameAr).toBe('قمر');
    // The skin theme is the neutral base under a look: true white page, ink text, no dividers.
    const t = getTemplateTheme('qamar');
    expect(t.backgroundColor).toBe('0 0% 100%');
    expect(t.dividers?.enabled).toBe(false);
  });

  it('is registered in every web skin map', () => {
    for (const f of [
      'apps/web/src/templates/index.ts',
      'apps/web/src/templates/shared/pack-styles.ts',
      'apps/web/src/lib/serverTemplate.ts',
    ]) {
      expect(readFileSync(path.join(root, f), 'utf8'), f).toMatch(/\bqamar\b/);
    }
  });

  it('is not offered as a bare skin (Ruling B1-17)', () => {
    const svc = readFileSync(path.join(root, 'apps/api/src/services/store.service.ts'), 'utf8');
    expect(svc).toContain(
      "const validTemplates = ['modern', 'classic', 'minimal', 'bold', 'elegant', 'dahab'];"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/qamar-template.test.ts; echo "exit=$?"`
Expected: FAIL (`enum StoreTemplate` has no `qamar`; `TEMPLATE_THEMES.qamar` undefined).

- [ ] **Step 3: Write minimal implementation**

`packages/database/prisma/migrations/20261023000100_store_template_qamar/migration.sql`:

```sql
-- Qamar storefront skin (Phase B1, Ruling B1-1): one more value on the store
-- template enum. Additive only: no existing row changes; a store reaches it only
-- through a Qamar look (applyLook writes template = look.skin). Rollback: see
-- docs/ROLLBACK.md ("enum value added") - Postgres cannot DROP an enum value, so
-- a rollback moves any 'qamar' stores to 'minimal' and leaves the value unused.
ALTER TYPE "StoreTemplate" ADD VALUE IF NOT EXISTS 'qamar';
```

`schema.prisma` enum gains `qamar` after `dahab`. Then `npm run db:generate; echo "exit=$?"`.

`store-theme.ts`:

```ts
export type TemplateId = 'modern' | 'classic' | 'minimal' | 'bold' | 'elegant' | 'dahab' | 'qamar';
```

`TEMPLATE_THEMES.qamar` (the neutral base a Qamar look composes over; the look supplies every colour role):

```ts
  // Qamar (fashion & boutiques, Phase B1): a neutral base. Every Qamar store has a
  // look, and the look's tokens (packages/shared/src/looks/registry.ts) own colour,
  // type, radius, density, image ratio and motion. Dividers off: the looks separate
  // sections by space and bands, never hairline-flanked labels on every section.
  qamar: {
    primaryColor: '0 0% 8%',
    primaryForeground: '0 0% 100%',
    backgroundColor: '0 0% 100%',
    foregroundColor: '0 0% 8%',
    fontFamily: 'default',
    borderRadius: 'none',
    backgroundPreset: 'none',
    showBrandStory: false,
    showTrustStrip: false,
    dividers: { ...DEFAULT_DIVIDER_SETTINGS, enabled: false },
  },
```

`TEMPLATES` entry:

```ts
  {
    id: 'qamar',
    name: 'Qamar',
    nameAr: 'قمر',
    description: 'Fashion and boutiques: Atelier, Lookbook and Vitrine looks',
    descriptionAr: 'أزياء وبوتيكات: أتيليه ولوك بوك وفاترينة',
    thumbnail: '/looks/qamar.atelier.webp',
    tags: ['fashion', 'abayas', 'boutique'],
    bestFor: 'Fashion, abayas and boutiques',
  },
```

`template-baselines.ts`: change the identities type to `Exclude<TemplateId, 'elegant' | 'dahab' | 'qamar'>` and add `qamar: buildTemplateBaseline(TEMPLATE_IDENTITIES.minimal)` to `TEMPLATE_LAYOUT_BASELINES` (the look owns the card ratio on a look store, LOOKS-15, so the minimal identity is only the fallback).

`apps/web/src/templates/qamar/index.ts`:

```ts
// Qamar template (قمر) - fashion & boutiques, Phase B1 (Ruling B1-1).
// Owns chrome only (Header lands in Task 5); every commerce surface is the
// shared/minimal component, styled by the look's tokens and PACK_STYLES.qamar.
export { default as Header } from '../minimal/Header';
export { default as Footer } from '../minimal/Footer';
export { default as Hero } from '../minimal/Hero';
export { default as ProductCard } from '../minimal/ProductCard';
export { default as ProductGrid } from '../minimal/ProductGrid';
export { default as CategoryCard } from '../minimal/CategoryCard';
export { default as CategoryGrid } from '../minimal/CategoryGrid';
export { default as AnnouncementBar } from '../minimal/AnnouncementBar';
export { default as CartTable } from '../minimal/CartTable';
export { default as OrderSummary } from '../minimal/OrderSummary';
export { default as EmptyState } from '../minimal/EmptyState';
export { default as FormCard } from '../minimal/FormCard';
export { HeroBanner } from '../shared/HeroBanner';
export { HeroSlider } from '../shared/HeroSlider';
export { CategoryStrip } from '../shared/CategoryStrip';
export { ProductCarousel } from '../shared/ProductCarousel';
export { TestimonialRow } from '../shared/TestimonialRow';
```

`apps/web/src/templates/index.ts`: add a `qamar: () => import('./qamar').then(m => ({ …same 12 keys… }))` loader and `'qamar'` to `TEMPLATE_IDS`.

`serverTemplate.ts`: `qamar: { Hero: MinimalHero, ProductGrid: MinimalProductGrid, CategoryGrid: MinimalCategoryGrid, ...shared }` (no new imports: it re-uses the minimal statics already imported).

`pack-styles.ts`: `qamar: { ...PACK_STYLES_MINIMAL_FLAVOUR }` is not allowed (the map is a literal); add a literal entry, editorial and frameless:

```ts
  qamar: {
    // Phase B1 (Ruling B1-1): the clothes are the interface. No card surface, no
    // border, no lift: the 3:4 photo carries the card. Type voice comes from the
    // look's --font-display/--font-body (looks.md), so these classes carry weight
    // and colour only.
    card: 'bg-transparent',
    categoryFrame: 'bg-transparent',
    categoryCaption: 'text-sm font-medium text-foreground',
    productCardName: 'font-normal text-foreground leading-snug',
    productCardPrice: 'font-medium text-foreground',
    productCardCta:
      'whitespace-nowrap rounded-[var(--radius)] bg-primary px-5 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors duration-[var(--motion-duration,150ms)] min-h-[44px]',
    sectionHeading:
      'font-display text-2xl sm:text-3xl md:text-4xl font-bold text-foreground leading-[1.25] text-balance',
    sectionSeeAll: 'text-sm font-medium text-foreground/70 hover:text-foreground underline-offset-4 hover:underline',
    heroOverlay: 'bg-gradient-to-b from-foreground/0 via-foreground/0 to-foreground/35',
    heroHeadline: 'font-display text-3xl sm:text-5xl md:text-6xl font-bold leading-[1.2]',
    heroCta:
      'rounded-[var(--radius)] bg-background px-8 py-3.5 text-sm font-medium text-foreground hover:bg-background/90 min-h-[44px]',
    testimonialCard: 'bg-transparent p-0',
    testimonialAuthor: 'text-sm font-medium text-muted-foreground',
  },
```

(If `PackStyles` declares optional keys such as `productCardBody`, leave them unset.)

`layout.tsx:557`:

```tsx
        data-pack={store.template === 'dahab' || store.template === 'qamar' ? store.template : undefined}
```

`provisioning.service.ts:57`: add `| 'qamar'` to the union.

`docs/ROLLBACK.md`: in "enum value added", add the line: "`qamar` (B1, 2026-10-17): `UPDATE stores SET template = 'minimal' WHERE template = 'qamar';` then redeploy; the `look` column keeps the Qamar look and renders on `minimal` until the skin is back."

- [ ] **Step 4: Run tests and gates**

Run: `npx vitest run tests/unit/qamar-template.test.ts tests/unit/looks-*.test.ts tests/unit/dahab-template-render.test.tsx; echo "exit=$?"` → exit=0.
Run: `npm run typecheck; echo "exit=$?"` → exit=0 (every exhaustive `Record<TemplateId,…>` now has `qamar`; `apps/marketing/src/lib/demo-stores.ts` has its own local `TemplateId` and is untouched).
Run the homepage characterization snapshots: `npx vitest run tests/unit -t characterization; echo "exit=$?"` → exit=0, zero snapshot updates (legacy byte-identical).

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/20261023000100_store_template_qamar/migration.sql packages/shared/src/types/store-theme.ts packages/shared/src/types/template-baselines.ts apps/web/src/templates/index.ts apps/web/src/templates/qamar/index.ts apps/web/src/templates/shared/pack-styles.ts apps/web/src/lib/serverTemplate.ts apps/web/src/app/layout.tsx apps/api/src/services/provisioning.service.ts docs/ROLLBACK.md tests/unit/qamar-template.test.ts
git commit -m "$(cat <<'EOF'
feat(templates): add the qamar skin id (enum, theme, baseline, web maps)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

Append Rulings B1-1 and B1-17 to `docs/RULINGS.md` in this commit (add the path to `git add`).

---

### Task 2: Per-look section mix + chrome data; Qamar looks render on the `qamar` skin

**Files:**

- Modify: `packages/shared/src/looks/types.ts` (add `LookSectionSpec`, `LookChrome`, optional `sections`, `chrome` on `LookDefinition`)
- Modify: `packages/shared/src/looks/registry.ts` (3 Qamar entries: `skin: 'qamar'`, Atelier `sections` + `chrome`; Lookbook/Vitrine get theirs in Tasks 7–8)
- Modify: `packages/shared/src/builder/template-families.ts` (`applyTemplateFamily(current, familyId, look?)`)
- Modify: `apps/api/src/services/page-builder.service.ts:623` (pass the look)
- Test: `tests/unit/looks-section-mix.test.ts`

**Interfaces:**

- Consumes: `TemplateId` incl. `'qamar'` (Task 1).
- Produces:

  ```ts
  export interface LookSectionSpec {
    type: string; // a SECTION_REGISTRY type with group 'template'
    design?: Record<string, unknown>; // applied to existing AND new sections
    preset?: Record<string, unknown>; // only when the section is created
  }
  export interface LookChrome {
    header: { logoPlacement: 'start' | 'centre' };
  }
  // LookDefinition gains: sections?: readonly LookSectionSpec[]; chrome?: LookChrome;
  export function applyTemplateFamily(
    current: PageDefinition,
    familyId: TemplateFamily['id'],
    look?: Pick<LookDefinition, 'sections'> | null
  ): PageDefinition;
  export const LOOK_DESIGN_KEYS: readonly string[]; // keys a look's `design` may set
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/looks-section-mix.test.ts
import { describe, it, expect } from 'vitest';
import {
  applyTemplateFamily,
  getLook,
  LOOKS,
  LOOK_DESIGN_KEYS,
  getSectionDefinition,
  sectionFromPreset,
  type PageDefinition,
} from '@ebda/shared';

const base = (): PageDefinition => {
  const hero = sectionFromPreset('hero', 1, 'hero');
  hero.settings = { ...hero.settings, presentation: 'framed' };
  hero.blocks = [
    { id: 's1', type: 'slide', settings: { image: 'https://x/a.webp', headlineAr: 'مرحبا' } },
  ];
  const it = sectionFromPreset('image-text', 0, 'story');
  it.settings = { ...it.settings, headingAr: 'حكايتي', image: 'https://x/b.webp' };
  return { version: 1, sections: [hero, it], header: [], footer: [] } as unknown as PageDefinition;
};

describe('look section mix', () => {
  it('every Qamar look renders on the qamar skin', () => {
    for (const l of LOOKS.filter(l => l.template === 'qamar')) expect(l.skin).toBe('qamar');
  });

  it('every mix entry names a template-group registry section and only design keys', () => {
    for (const l of LOOKS)
      for (const s of l.sections ?? []) {
        expect(getSectionDefinition(s.type)?.group, `${l.id}:${s.type}`).toBe('template');
        for (const k of Object.keys(s.design ?? {}))
          expect(LOOK_DESIGN_KEYS, `${l.id}:${s.type}.${k}`).toContain(k);
      }
  });

  it('follows the look order and applies design keys to an existing section', () => {
    const doc = applyTemplateFamily(base(), 'qamar', getLook('qamar.atelier'));
    const types = doc.sections.map(s => s.type);
    expect(types).toEqual((getLook('qamar.atelier')!.sections ?? []).map(s => s.type));
    const hero = doc.sections.find(s => s.type === 'hero')!;
    expect(hero.settings.presentation).toBe('full-bleed');
  });

  it('never overwrites content (Ruling B1-3)', () => {
    const doc = applyTemplateFamily(base(), 'qamar', getLook('qamar.atelier'));
    const hero = doc.sections.find(s => s.type === 'hero')!;
    expect(hero.blocks?.[0]?.settings.headlineAr).toBe('مرحبا');
    const story = doc.sections.find(s => s.id === 'story')!;
    expect(story.settings.headingAr).toBe('حكايتي');
    expect(story.settings.image).toBe('https://x/b.webp');
  });

  it('without a look (or a look with no mix) behaves exactly as before', () => {
    const a = applyTemplateFamily(base(), 'qamar');
    const b = applyTemplateFamily(base(), 'qamar', getLook('souq.catalogue'));
    expect(b).toEqual(a);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/looks-section-mix.test.ts; echo "exit=$?"`
Expected: FAIL (`LOOK_DESIGN_KEYS` not exported; Atelier skin is `'minimal'`).

- [ ] **Step 3: Write minimal implementation**

`types.ts` additions:

```ts
/** One section of a look's home mix (Ruling B1-3). */
export interface LookSectionSpec {
  type: string;
  /** Design keys (LOOK_DESIGN_KEYS only), applied to an existing section too. */
  design?: Record<string, unknown>;
  /** Starting settings for a section the store does not have yet. */
  preset?: Record<string, unknown>;
}
/** Chrome choices a skin reads from the look (Ruling B1-4). */
export interface LookChrome {
  header: { logoPlacement: 'start' | 'centre' };
}
/** Settings a look's `design` may set: layout/variant/background/spacing, never content. */
export const LOOK_DESIGN_KEYS = [
  'presentation',
  'mode',
  'layout',
  'layoutMobile',
  'captionPosition',
  'desktopColumns',
  'mobileColumns',
  'columns',
  'tileShape',
  'imagePosition',
  'imageAspect',
  'cardShape',
  'cardAspect',
  'cardGap',
  'showCardFrame',
  'bgColor',
  'paddingTop',
  'paddingBottom',
] as const;
```

and on `LookDefinition`: `sections?: readonly LookSectionSpec[]; chrome?: LookChrome;`. Export both types and `LOOK_DESIGN_KEYS` from `looks/index.ts`.

`registry.ts`, Atelier (`skin: 'qamar'` on all three Qamar entries in this task):

```ts
    skin: 'qamar',
    chrome: { header: { logoPlacement: 'start' } },
    sections: [
      { type: 'hero', design: { presentation: 'full-bleed', mode: 'single' } },
      { type: 'category-grid', design: { layout: 'chips', layoutMobile: 'chips' } },
      {
        type: 'featured-collection',
        design: { columns: 4, mobileColumns: 2 },
        preset: { productSource: 'newest', limit: 8, heading: 'New in', headingAr: 'وصل حديثًا' },
      },
      { type: 'image-text', design: { layout: 'full-bleed' } },
      {
        type: 'product-carousel',
        preset: { productSource: 'category', categorySlug: 'abayas', limit: 12 },
      },
      { type: 'brand-story' },
    ],
```

(`layout: 'chips'` / image-text `layout: 'full-bleed'` are declared in Task 3. Until Task 3 lands, this test file's design-key assertions pass because the keys are in `LOOK_DESIGN_KEYS`; the schema validation of those values is Task 3's test.)

`template-families.ts`:

```ts
export function applyTemplateFamily(
  current: PageDefinition,
  familyId: TemplateFamily['id'],
  look?: Pick<LookDefinition, 'sections'> | null
): PageDefinition {
  const family = TEMPLATE_FAMILIES.find(f => f.id === familyId);
  if (!family) throw new Error(`unknown template family ${familyId}`);
  const specs: readonly LookSectionSpec[] =
    look?.sections && look.sections.length > 0
      ? look.sections
      : family.sectionTypes.map(type => ({ type }));
  let doc: PageDefinition = { ...current, sections: [] };
  const pool = [...current.sections];
  for (const spec of specs) {
    const d = getSectionDefinition(spec.type);
    if (!d || d.group !== 'template') continue; // header/footer stay as the store has them
    const existing = pool.filter(n => n.type === spec.type);
    const take: SectionNode[] = existing.length > 0 ? existing : [];
    if (take.length === 0) {
      const fresh = sectionFromPreset(spec.type, 0, uniqueSectionId(doc, spec.type));
      fresh.settings = { ...fresh.settings, ...(spec.preset ?? {}) };
      take.push(fresh);
    }
    for (const n of take) {
      const shown = { ...n, hidden: false, settings: { ...n.settings, ...(spec.design ?? {}) } };
      doc = { ...doc, sections: [...doc.sections, shown] };
      pool.splice(pool.indexOf(n), 1);
    }
  }
  return doc;
}
```

Import `LookDefinition`, `LookSectionSpec` types from `../looks/types` (type-only import, no cycle at runtime).

`page-builder.service.ts:623`: `let definition = applyTemplateFamily(start, family, look);`

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/looks-section-mix.test.ts tests/unit/looks-*.test.ts tests/unit/template-families*.test.ts; echo "exit=$?"` → exit=0.
Run: `npm run test:integration -- tests/integration/apply-look*.test.ts; echo "exit=$?"` (the Phase S `applyLook` suite) → exit=0. If no file matches that glob, run `grep -rl applyLook tests/integration` and run those.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/looks/types.ts packages/shared/src/looks/index.ts packages/shared/src/looks/registry.ts packages/shared/src/builder/template-families.ts apps/api/src/services/page-builder.service.ts tests/unit/looks-section-mix.test.ts docs/RULINGS.md
git commit -m "$(cat <<'EOF'
feat(looks): per-look section mix and chrome; qamar looks render on the qamar skin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

(Rulings B1-3, B1-4 appended in this commit.)

---

### Task 3: Atelier's platform variants — chip category row + full-bleed image break

**Files:**

- Modify: `packages/shared/src/builder/layout-schema.ts:195,199` (`layout` / `layoutMobile` enums gain `'chips'`)
- Modify: `packages/shared/src/types/store-layout.ts` (`CategoriesSettings.layout` / `layoutMobile` union)
- Modify: `packages/shared/src/builder/registry.ts` (category-grid `layout` option; image-text `layout` setting)
- Modify: `packages/shared/src/builder/sections-document-only.ts:28-46` (`imageTextSchema.layout`)
- Create: `apps/web/src/templates/shared/CategoryChips.tsx`
- Modify: `apps/web/src/builder/render/PageRenderer.tsx` (`kindFor` → `'chips'`)
- Modify: `apps/web/src/builder/sections/ImageTextSection.tsx` (`layout: 'full-bleed'`)
- Test: `tests/unit/qamar-variants-atelier.test.tsx`, `tests/unit/layout-schema-parity.test.ts` (must stay green)

**Interfaces:**

- Consumes: `LOOK_DESIGN_KEYS` (Task 2).
- Produces: `CategoriesSettings.layout: 'grid' | 'horizontal' | 'chips'`; `ImageTextSettings.layout?: 'split' | 'full-bleed'`; `<CategoryChips categories urlPrefix isRtl />`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/qamar-variants-atelier.test.tsx
// Same harness as tests/unit/dahab-template-render.test.tsx: copy its vi.hoisted ctx and the
// vi.mock blocks for StoreContext / LanguageContext / CartContext / next/navigation verbatim.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { storeLayoutSchema, imageTextSchema, getTemplateTheme } from '@ebda/shared';
import { CategoryChips } from '../../apps/web/src/templates/shared/CategoryChips';
import { ImageTextSection } from '../../apps/web/src/builder/sections/ImageTextSection';
import { CATEGORIES } from '../fixtures/builder/homepage-data';

describe('category chips', () => {
  it('the layout schema accepts chips (no silent strip)', () => {
    const r = storeLayoutSchema.shape.categories.unwrap().safeParse({
      enabled: true,
      layout: 'chips',
      layoutMobile: 'chips',
      captionPosition: 'below',
    });
    expect(r.success).toBe(true);
  });
  it('renders one link per category, text only, in a scroll row, RTL-safe', () => {
    const html = renderToStaticMarkup(<CategoryChips categories={CATEGORIES} urlPrefix="" isRtl />);
    expect(html.match(/<a /g)?.length).toBe(CATEGORIES.length);
    expect(html).not.toContain('<img');
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('snap-x');
    expect(html).not.toMatch(/text-\[\d+px\]/); // nothing under 12px, no arbitrary sizes
  });
});

describe('image-text full-bleed', () => {
  it('schema accepts layout full-bleed', () => {
    expect(imageTextSchema.safeParse({ layout: 'full-bleed' }).success).toBe(true);
  });
  for (const skin of ['minimal', 'dahab', 'qamar'] as const)
    it(`renders edge to edge with text over a scrim on ${skin}`, () => {
      ctx.store = { ...ctx.store, template: skin, theme: getTemplateTheme(skin) };
      const html = renderToStaticMarkup(
        <ImageTextSection
          settings={{
            layout: 'full-bleed',
            image: 'https://x/a.webp',
            headingAr: 'المجموعة',
            heading: 'Collection',
          }}
        />
      );
      expect(html).toContain('data-layout="full-bleed"');
      expect(html).toContain('w-full');
      expect(html).not.toContain('md:grid-cols-2');
      expect(html).toContain('min-h-[60svh]');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/qamar-variants-atelier.test.tsx; echo "exit=$?"`
Expected: FAIL (module `CategoryChips` not found).

- [ ] **Step 3: Write minimal implementation**

`layout-schema.ts`: `layout: z.enum(['grid', 'horizontal', 'chips'])`, `layoutMobile: z.enum(['grid', 'horizontal', 'chips']).optional()`. Same union in `store-layout.ts`. Registry category-grid `layout` options gain `opt('chips', 'Text chips', 'أزرار نصية')`.

`sections-document-only.ts` `imageTextSchema`: add `layout: z.enum(['split', 'full-bleed']).optional(),`. Registry image-text settings: `s.select('layout', 'Layout', 'التخطيط', [opt('split', 'Side by side', 'جنب بعض'), opt('full-bleed', 'Full-width image', 'صورة بعرض الشاشة')])`.

`CategoryChips.tsx`:

```tsx
'use client';
import Link from 'next/link';
import type { CategoryStripProps } from '../types';

/**
 * Category row as text chips (Ruling B1-2): the fastest first-screen path to a
 * category for stores whose photos carry the page (Qamar Atelier). Text only,
 * one horizontal scroll row with snap, 44px targets, logical spacing (RTL-safe).
 */
export function CategoryChips({
  categories,
  urlPrefix = '',
  isRtl,
}: Pick<CategoryStripProps, 'categories' | 'urlPrefix' | 'isRtl'>) {
  if (!categories || categories.length === 0) return null;
  return (
    <nav aria-label={isRtl ? 'الأقسام' : 'Categories'} data-section="category-chips">
      <ul className="mx-auto flex max-w-7xl snap-x gap-2 overflow-x-auto px-4 py-4 sm:px-6 lg:px-8 [scrollbar-width:none]">
        {categories.map(c => (
          <li key={c.id} className="snap-start shrink-0">
            <Link
              href={`${urlPrefix}/products?category=${encodeURIComponent(c.slug)}`}
              className="inline-flex min-h-[44px] items-center rounded-[var(--radius)] border border-border px-4 text-sm text-foreground hover:border-foreground"
            >
              {isRtl ? c.nameAr || c.name : c.name || c.nameAr}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

(If `CategoryStripProps['categories']` items name their Arabic field differently, follow the type; do not add a new field.)

`PageRenderer.tsx`: extend the kind resolver and renderer:

```tsx
                  const kindFor = (lay: typeof layout.categories.layout) =>
                    lay === 'chips'
                      ? 'chips'
                      : lay === 'horizontal' && T.CategoryStrip
                        ? 'strip'
                        : 'grid';
                  …
                  const renderKind = (kind: 'strip' | 'grid' | 'chips', caption: Caption, vis?: string) =>
                    kind === 'chips' ? (
                      <div className={vis}>
                        <CategoryChips categories={common.categories} urlPrefix={common.urlPrefix} isRtl={isRtl} />
                      </div>
                    ) : kind === 'strip' ? renderStrip(caption, vis) : renderGrid(caption, vis);
```

`ImageTextSection.tsx`: add `layout?: 'split' | 'full-bleed'` to `ImageTextSettings`; before the split return:

```tsx
if ((settings.layout ?? 'split') === 'full-bleed' && image) {
  return (
    <section
      data-section="image-text"
      data-layout="full-bleed"
      className="relative w-full overflow-hidden"
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <img
        src={image}
        alt={alt}
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="relative flex min-h-[60svh] w-full items-end bg-gradient-to-t from-black/60 via-black/25 to-transparent">
        <div className={`${spacing.innerContainerClass} pb-10 text-start text-white`}>
          {heading && (
            <h2 className="font-display text-3xl sm:text-4xl" {...edit('heading')}>
              {heading}
            </h2>
          )}
          {body && (
            <p
              className="mt-2 max-w-prose text-base leading-relaxed text-white/90"
              {...edit('body')}
            >
              {body}
            </p>
          )}
          {button && (
            <a
              href={storeUrl(sanitizeUrl(settings.buttonLink, '/products'))}
              className="mt-5 inline-flex min-h-[44px] items-center rounded-[var(--radius)] bg-white px-5 text-sm font-medium text-black"
              {...edit('buttonText')}
            >
              {button}
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
```

(The scrim is a photographic overlay for text legibility, not gradient text. Worst case, a pure-white photo: `rgba(0,0,0,.6)` over white = `#666666`, and white text on it = 5.74:1 (checked in Task 4's test). The text block sits in the bottom band where the scrim is at 60%. A full-bleed with no image falls through to the split layout.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/qamar-variants-atelier.test.tsx tests/unit/layout-schema-parity.test.ts tests/unit/looks-section-mix.test.ts; echo "exit=$?"` → exit=0.

- [ ] **Step 5: Taste gate + commit**

Taste gate is deferred to Task 6 (first full Atelier render); record "taste: deferred to Task 6 (no seeded store yet)" in the task report.

```bash
git add packages/shared/src/builder/layout-schema.ts packages/shared/src/types/store-layout.ts packages/shared/src/builder/registry.ts packages/shared/src/builder/sections-document-only.ts apps/web/src/templates/shared/CategoryChips.tsx apps/web/src/builder/render/PageRenderer.tsx apps/web/src/builder/sections/ImageTextSection.tsx tests/unit/qamar-variants-atelier.test.tsx docs/RULINGS.md
git commit -m "$(cat <<'EOF'
feat(builder): chip category row and full-bleed image break for every skin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

(Ruling B1-2 appended here.)

---

### Task 4: Qamar look contrast + merchant-extreme guard

**Files:**

- Test: `tests/unit/qamar-looks-contrast.test.ts`
- Modify (only if a pair fails): `packages/shared/src/looks/registry.ts` (Qamar tokens)

**Interfaces:**

- Consumes: `LOOKS`, `contrastRatio`, `lookTheme` from `@ebda/shared`.
- Produces: nothing new; a gate later tasks extend (Vitrine bands in Task 8).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/qamar-looks-contrast.test.ts
import { describe, it, expect } from 'vitest';
import { LOOKS, contrastRatio } from '@ebda/shared';

const qamar = LOOKS.filter(l => l.template === 'qamar');
// Every text pair a Qamar skin paints, beyond the generic set in looks-contrast.test.ts.
const PAIRS: [string, (t: any) => [string, string]][] = [
  ['ink on surface', t => [t.surface, t.ink]],
  ['accent text on surface (prices, active)', t => [t.surface, t.accent]],
  ['onPrimary on accent (accentForeground)', t => [t.accent, t.onPrimary]],
  ['primary text on page (links, chips active)', t => [t.page, t.primary]],
];

describe('qamar looks: skin-painted text pairs ≥ 4.5', () => {
  it('there are exactly three Qamar looks', () =>
    expect(qamar.map(l => l.id).sort()).toEqual([
      'qamar.atelier',
      'qamar.lookbook',
      'qamar.vitrine',
    ]));
  for (const l of qamar)
    for (const [label, pick] of PAIRS)
      it(`${l.id}: ${label}`, () => {
        const [bg, fg] = pick(l.tokens);
        expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(4.5);
      });
});

describe('full-bleed scrim keeps white text legible over a white photo', () => {
  it('white on the 60% black scrim over a white photo ≥ 4.5', () => {
    // rgba(0,0,0,.6) over #FFFFFF = #666666 (Task 3 ImageTextSection full-bleed)
    expect(contrastRatio('#666666', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
  });
});
```

Note: `primary text on page` fails for Lookbook (`#E8A33D` saffron on `#1E2340` = 7.11, passes (superseded by moon silver `#D9DCEB`, 11.2 on the page, Ruling B1-102)) — run it; if any pair fails, adjust only that look's token and record the ratio in `qamar.md` (Task 10).

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/unit/qamar-looks-contrast.test.ts; echo "exit=$?"`
Expected: PASS for the current tokens (computed 2026-10-15: Atelier oxblood on white 11.10, Lookbook saffron on surface 5.80, Vitrine rose `#9E5E5E` on white 4.98, white on rose 4.98). If it passes on first run, mutate one token locally (e.g. Vitrine accent `#C98B8B`) to see it fail, then revert — record that in the report as the proof the gate can fail.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/qamar-looks-contrast.test.ts
git commit -m "$(cat <<'EOF'
test(looks): qamar skin-painted contrast pairs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

---

### Task 5: Qamar chrome — header wrapper, `[data-pack='qamar']` type voice

**Files:**

- Modify: `apps/web/src/templates/minimal/Header.tsx` (optional `logoPlacement` prop, default `'start'`)
- Create: `apps/web/src/templates/qamar/Header.tsx`
- Modify: `apps/web/src/templates/qamar/index.ts` (Header from `./Header`)
- Modify: `apps/web/src/templates/types.ts` (`HeaderProps.logoPlacement?: 'start' | 'centre'`)
- Modify: `apps/web/src/styles/globals.css` (a `[data-pack='qamar']` block)
- Test: `tests/unit/qamar-chrome-render.test.tsx`

**Interfaces:**

- Consumes: `getLook(store.look)?.chrome` (Task 2), `useStore()` from `apps/web/src/contexts/StoreContext`.
- Produces: `QamarHeader(props: HeaderProps)`; `HeaderProps.logoPlacement`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/qamar-chrome-render.test.tsx  (harness: copy dahab-template-render's vi.hoisted ctx + mocks)
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import QamarHeader from '../../apps/web/src/templates/qamar/Header';
import MinimalHeader from '../../apps/web/src/templates/minimal/Header';

const branding = { name: 'Qamar Demo', nameAr: 'قمر', logo: null };

describe('qamar header', () => {
  it('centres the wordmark when the look says centre', () => {
    ctx.store = { ...ctx.store, template: 'qamar', look: 'qamar.vitrine' };
    const html = renderToStaticMarkup(<QamarHeader branding={branding} />);
    expect(html).toContain('data-logo-placement="centre"');
  });
  it('keeps the wordmark at the start for Atelier', () => {
    ctx.store = { ...ctx.store, template: 'qamar', look: 'qamar.atelier' };
    expect(renderToStaticMarkup(<QamarHeader branding={branding} />)).toContain(
      'data-logo-placement="start"'
    );
  });
  it('an unknown look falls back to start, never throws', () => {
    ctx.store = { ...ctx.store, template: 'qamar', look: 'qamar.gone' };
    expect(renderToStaticMarkup(<QamarHeader branding={branding} />)).toContain(
      'data-logo-placement="start"'
    );
  });
  it('a missing logo still shows the store name (wide/tall/missing logo matrix)', () => {
    ctx.store = { ...ctx.store, template: 'qamar', look: 'qamar.atelier' };
    expect(renderToStaticMarkup(<QamarHeader branding={branding} />)).toContain('قمر');
  });
  it('minimal header without the prop is byte-identical to before (no attribute)', () => {
    ctx.store = { ...ctx.store, template: 'minimal', look: null };
    expect(renderToStaticMarkup(<MinimalHeader branding={branding} />)).not.toContain(
      'data-logo-placement'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/qamar-chrome-render.test.tsx; echo "exit=$?"` → FAIL (no `qamar/Header`).

- [ ] **Step 3: Write minimal implementation**

`qamar/Header.tsx`:

```tsx
'use client';
import { getLook } from '@ebda/shared';
import MinimalHeader from '../minimal/Header';
import type { HeaderProps } from '../types';
import { useStore } from '../../contexts/StoreContext';

/** Qamar chrome (Ruling B1-4): the minimal header with the look's wordmark placement. */
export default function QamarHeader(props: HeaderProps) {
  const { store } = useStore();
  const placement = getLook(store?.look)?.chrome?.header.logoPlacement ?? 'start';
  return <MinimalHeader {...props} logoPlacement={placement} />;
}
```

`minimal/Header.tsx`: accept `logoPlacement`; only when it is defined, put `data-logo-placement={logoPlacement}` on the root `<header>`; when `'centre'`, the logo row becomes a 3-column grid (`grid grid-cols-[1fr_auto_1fr] items-center`), nav/search at the inline start column, the logo centred and enlarged (`text-2xl sm:text-3xl font-display`, logo image `max-h-12`), cart/account at the inline end. When undefined, render exactly the current markup (the characterization snapshot proves it).

`globals.css`:

```css
/* Qamar (Phase B1): the look's faces carry the voice; headings never letter-spaced in Arabic. */
[data-pack='qamar'] .font-display,
[data-pack='qamar'] h1,
[data-pack='qamar'] h2 {
  font-family: var(--look-font-display, var(--font-display));
  font-weight: 700;
}
[data-pack='qamar'][lang='ar'] h1,
[data-pack='qamar'][lang='ar'] h2 {
  line-height: 1.4;
  letter-spacing: 0;
}
[data-pack='qamar'] [data-section] + [data-section] {
  margin-block-start: 0;
}
```

(Check where `lang` is set — `<html lang>` — and scope accordingly: `html[lang='ar'] [data-pack='qamar'] h1`. Use the selector that matches the real DOM.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/qamar-chrome-render.test.tsx tests/unit/homepage-characterization*.test.tsx; echo "exit=$?"` → exit=0, no snapshot update.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/templates/qamar/Header.tsx apps/web/src/templates/qamar/index.ts apps/web/src/templates/minimal/Header.tsx apps/web/src/templates/types.ts apps/web/src/styles/globals.css tests/unit/qamar-chrome-render.test.tsx
git commit -m "$(cat <<'EOF'
feat(qamar): header wrapper reads the look's wordmark placement

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

---

### Task 6: Qamar demo catalogue, illustrative assets, showroom seed — then **STOP 1: Ahmad's Atelier review**

**Files:**

- Create: `scripts/qamar-demo/catalogue.mjs` (data only)
- Create: `scripts/qamar-demo/prompts.py`, `scripts/qamar-demo/gen.py` (offline generator, copy of `apps/marketing/scripts/looks/gen.py` reading this `prompts.py`, writing `scripts/qamar-demo/img-src/` — gitignored)
- Create: `scripts/qamar-demo/encode.sh` (img-src → `assets/*.webp`, byte budget), `scripts/qamar-demo/make-video.sh`
- Create: `scripts/qamar-demo/assets/*.webp`, `assets/hero.mp4`, `assets/hero.webm`, `scripts/qamar-demo/CREDITS.md`
- Create: `scripts/storedemo/qamar-home.mjs` (superset home document builder)
- Modify: `scripts/storedemo/seed.mjs` (Qamar catalogue, options/variants/swatches, facts, lead time, personalisation, size chart, shipping zone, `deliveryDays`, home doc publish, archive placeholder families, asset base guard, `--local-look-stores`)
- Modify: `.gitignore` (`scripts/qamar-demo/img-src/`)
- Test: `tests/unit/storedemo-seed-guard.test.ts` (extend), `tests/unit/qamar-demo-catalogue.test.ts`

**Interfaces:**

- Consumes: `applyTemplateFamily`, `getLook`, `sectionFromPreset` (`@ebda/shared`); `getPageState`, `saveDraft`, `publishDraft` from `apps/api/src/services/page-builder.service.ts` (same import pattern as `scripts/dahab-demo/seed-dahab.mjs:66`); `runInStoreScope` from `@ebda/database`.
- Produces:
  ```js
  // scripts/qamar-demo/catalogue.mjs
  export const QAMAR_CATEGORIES: { slug, name, nameAr, sizeChart?: 'abaya' | 'apparel' }[];
  export const QAMAR_PRODUCTS: QamarProduct[];   // shape below
  export const QAMAR_LOOKS_STORY: { id, image, title, titleAr, items: string[] }[]; // shop-the-look blocks (Task 7)
  export const QAMAR_OCCASIONS: { slug, label, labelAr, image, tone }[];             // band tiles (Task 8)
  export const ASSET_FILES: string[];            // every file under assets/ the catalogue references
  // scripts/storedemo/seed.mjs
  export function assetBase(argv: string[], env: NodeJS.ProcessEnv): { ok: true, base: string } | { ok: false, why: string };
  export function buildQamarHome(base: PageDefinition, ctx: { img(f: string): string, productIdBySlug: Map<string,string> }): PageDefinition; // from qamar-home.mjs
  ```

`QamarProduct` shape (prices in piastres):

```js
/** @typedef {{ slug: string, name: string, nameAr: string, category: string, price: number,
 *   compareAtPrice?: number, images: string[], description: string, descriptionAr: string,
 *   options?: { name: string, nameAr: string, values: { value: string, valueAr: string, hex?: string, image?: string }[] }[],
 *   soldOut?: string[][],            // option-value tuples with 0 stock, e.g. [['Rose','M','56']]
 *   backorder?: boolean, facts?: { key, keyAr, value, valueAr, onCard?: boolean }[],
 *   leadTimeDays?: number, personalisation?: { label, labelAr, maxLength, required },
 *   stock?: number }} QamarProduct */
```

Catalogue content (binding, realistic Egyptian boutique; EGP; Arabic first):

- Categories: `abayas` عبايات (chart `abaya`), `kaftans` قفاطين (chart `apparel`), `scarves` طرح وشيلان, `dresses` فساتين سهرة (chart `apparel`), plus the three occasion categories used by Vitrine: `wedding` فرح, `engagement` خطوبة, `evening` سهرة (products cross-listed).
- 18 products, e.g. `linen-abaya` عباية كتان 1,490 ج.م (Colour × Size × Length; Rose has an IMAGE swatch `swatch-rose-linen.webp`, Teal/Black hex; Rose/M/56 sold out; facts Fabric/الخامة: كتان مصري onCard, Care/العناية: غسيل يدوي; personalisation "الاسم للتطريز" max 12, optional), `embroidered-kaftan` قفطان مطرز 2,250 ج.م (leadTimeDays 5, made to order), `crepe-abaya-sale` عباية كريب 1,150 → was 1,450 (sale), `chiffon-scarf` طرحة شيفون 320 ج.م (5 colour swatches + 2 more → card shows `+2`), `evening-gown-rose` فستان سهرة ستان 3,900 ج.م (backorder), `modal-scarf-no-image` (deliberately no image — scenario matrix), one product with a 70-character Arabic name and a 60-character English name. Every B0 feature appears at least once (the test below enforces it).
- Images: 2 per product (front, detail) + hero still + 3 lookbook photos + 3 occasion photos + 3 shop-the-look photos + 1 image-text break + 2 swatch fabrics. ≈ 50 files ≤ 140 KB each.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/qamar-demo-catalogue.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  QAMAR_PRODUCTS,
  QAMAR_CATEGORIES,
  ASSET_FILES,
} from '../../scripts/qamar-demo/catalogue.mjs';

const assets = path.resolve(__dirname, '../../scripts/qamar-demo/assets');

describe('qamar demo catalogue exercises every B0 feature', () => {
  const opts = QAMAR_PRODUCTS.flatMap(p => p.options ?? []);
  it('colour hex swatch', () => expect(opts.some(o => o.values.some(v => v.hex))).toBe(true));
  it('image swatch', () => expect(opts.some(o => o.values.some(v => v.image))).toBe(true));
  it('more than 5 swatches on one product (+N)', () =>
    expect(
      QAMAR_PRODUCTS.some(p =>
        (p.options ?? []).some(o => o.values.filter(v => v.hex || v.image).length > 5)
      )
    ).toBe(true));
  it('Size × Length with a struck-out combo', () =>
    expect(
      QAMAR_PRODUCTS.some(p => (p.options?.length ?? 0) >= 3 && (p.soldOut?.length ?? 0) > 0)
    ).toBe(true));
  it('facts with ≤ 2 on card', () => {
    expect(QAMAR_PRODUCTS.some(p => (p.facts?.length ?? 0) > 0)).toBe(true);
    for (const p of QAMAR_PRODUCTS)
      expect((p.facts ?? []).filter(f => f.onCard).length).toBeLessThanOrEqual(2);
  });
  it('lead time', () => expect(QAMAR_PRODUCTS.some(p => (p.leadTimeDays ?? 0) > 0)).toBe(true));
  it('personalisation', () => expect(QAMAR_PRODUCTS.some(p => p.personalisation)).toBe(true));
  it('size chart linked by category', () =>
    expect(QAMAR_CATEGORIES.some(c => c.sizeChart)).toBe(true));
  it('sale, backorder, no-image, long names', () => {
    expect(QAMAR_PRODUCTS.some(p => p.compareAtPrice && p.compareAtPrice > p.price)).toBe(true);
    expect(QAMAR_PRODUCTS.some(p => p.backorder)).toBe(true);
    expect(QAMAR_PRODUCTS.some(p => p.images.length === 0)).toBe(true);
    expect(QAMAR_PRODUCTS.some(p => p.nameAr.length >= 60)).toBe(true);
  });
  it('every product is bilingual and priced in piastres', () => {
    for (const p of QAMAR_PRODUCTS) {
      expect(p.name && p.nameAr && p.description && p.descriptionAr, p.slug).toBeTruthy();
      expect(Number.isInteger(p.price) && p.price >= 10000, p.slug).toBe(true);
    }
  });
});

describe('qamar demo assets', () => {
  it('every referenced file exists, is webp/mp4/webm and within budget', () => {
    let total = 0;
    for (const f of ASSET_FILES) {
      const p = path.join(assets, f);
      expect(existsSync(p), f).toBe(true);
      const size = statSync(p).size;
      total += size;
      if (f.endsWith('.webp')) expect(size, f).toBeLessThanOrEqual(140 * 1024);
      if (f.endsWith('.mp4')) expect(size, f).toBeLessThanOrEqual(1.5 * 1024 * 1024);
    }
    expect(total).toBeLessThanOrEqual(6 * 1024 * 1024);
  });
  it('no unreferenced file is committed', () => {
    const onDisk = readdirSync(assets).filter(f => !f.startsWith('.'));
    expect(onDisk.sort()).toEqual([...new Set(ASSET_FILES)].sort());
  });
});
```

Extend `tests/unit/storedemo-seed-guard.test.ts`:

```ts
import { assetBase } from '../../scripts/storedemo/seed.mjs';
it('production run refuses any asset base but media.ebda.app/demo/qamar (Ruling B1-16)', () => {
  expect(
    assetBase(['--yes-production'], { QAMAR_DEMO_ASSET_BASE: 'http://localhost:9000' }).ok
  ).toBe(false);
  expect(assetBase(['--yes-production'], {}).ok).toBe(true); // default
  expect(assetBase(['--yes-production'], {}).base).toBe('https://media.ebda.app/demo/qamar');
  expect(assetBase([], { QAMAR_DEMO_ASSET_BASE: 'http://localhost:9000' }).base).toBe(
    'http://localhost:9000'
  );
});
it('describePlan names the Qamar catalogue and the archived placeholder families', () => {
  const plan = describePlan('postgresql://u@localhost/x');
  expect(plan).toMatch(/qamar: \d+ products/);
  expect(plan).toContain('archived: electronics, beauty, home-kitchen, jewellery');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/qamar-demo-catalogue.test.ts tests/unit/storedemo-seed-guard.test.ts; echo "exit=$?"` → FAIL (module not found / `assetBase` not exported).

- [ ] **Step 3: Generate and encode assets (offline, local)**

1. Write `scripts/qamar-demo/prompts.py` with the TPL-3 negative clause (`NEG = "no text, no letters, no logo, no watermark, no signage"`) and one prompt per file, in each look's palette (Atelier: noon atelier, true white, ink + oxblood; Lookbook: Cairo rooftop golden hour, indigo + saffron; Vitrine: Heliopolis boutique window, teal + rose + champagne). Garments are Egyptian boutique stock: abayas, kaftans, chiffon/modal scarves, satin evening dresses; models are adult women in modest styling.
2. Run: `python3 scripts/qamar-demo/gen.py; echo "exit=$?"` (needs the local wrangler OAuth token, same as `apps/marketing/scripts/looks/gen.py`; it is an offline step on Ahmad's machine and touches no production data). On `AUTH EXPIRED` (exit 2): stop and report — that needs `npx wrangler login` by Ahmad.
3. Run: `bash scripts/qamar-demo/encode.sh; echo "exit=$?"` — for each `img-src/*.jpg`: `sips -Z 1200` (product 3:4 crops `-c 1600 1200` before resize), `cwebp -q 72 -m 6`, then if > 140 KB re-encode at `-q 64`; fail if still over.
4. **Read back every WebP with the Read tool** (all ≈50). Any lettering, logo, watermark, malformed hand/face or a garment that is not what the product name says → delete it from `img-src/`, re-run `gen.py` (it skips existing files) and `encode.sh`. Record in the report: "read back N/N images, regenerated M (names)". The marketing `apps/marketing/public/looks/img/qc__window.webp` (the Vitrine hero that carried "ZAS") was read back on 2026-10-15 and shows no lettering; if the demo reuses its composition, it is regenerated here anyway.
5. Video: `bash scripts/qamar-demo/make-video.sh; echo "exit=$?"`:

```bash
#!/usr/bin/env bash
# Ruling B1-10: a 6 s slow push-in over the Atelier hero still; no audio; poster = the still.
set -euo pipefail
cd "$(dirname "$0")/assets"
ffmpeg -y -loop 1 -i hero-atelier.webp -t 6 -r 30 \
  -vf "scale=2560:-2,zoompan=z='min(zoom+0.0006,1.08)':d=180:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x720,format=yuv420p" \
  -an -c:v libx264 -preset slow -crf 28 -movflags +faststart hero.mp4
ffmpeg -y -i hero.mp4 -an -c:v libvpx-vp9 -b:v 0 -crf 40 hero.webm
ls -l hero.mp4 hero.webm
```

Check `hero.mp4` ≤ 1.5 MB. Watch it (`/watch-video scripts/qamar-demo/assets/hero.mp4`) and confirm no artefacts. 6. `scripts/qamar-demo/CREDITS.md`: "All images and the hero clip in this folder are AI-generated illustrative samples (FLUX.1 schnell on Cloudflare Workers AI, 2026-10-1x; clip: ffmpeg zoompan over hero-atelier.webp). They are not a real merchant's products (Ruling TPL-3). Prompts: prompts.py."

- [ ] **Step 4: Write the catalogue and seed**

`catalogue.mjs` exports exactly the shapes in Interfaces with the content above. `seed.mjs` changes (keep the existing guard/`hostOf`/`isLocalUrl`/`describePlan` exports; add):

```js
export const PROD_ASSET_BASE = 'https://media.ebda.app/demo/qamar';
export function assetBase(argv, env) {
  const base = (env.QAMAR_DEMO_ASSET_BASE || PROD_ASSET_BASE).replace(/\/$/, '');
  if (argv.includes('--yes-production') && base !== PROD_ASSET_BASE)
    return {
      ok: false,
      why: `--yes-production needs the asset base ${PROD_ASSET_BASE}, got ${base}`,
    };
  return { ok: true, base };
}
```

Inside `run()`, after the store upsert (all writes through the owner client inside `runInStoreScope(store.id, …)` so the tenant guard sees a store scope; every `where` carries `storeId`):

1. Archive the Phase S placeholder families: `tx.product.updateMany({ where: { storeId: store.id, slug: { in: PLACEHOLDER_SLUGS } }, data: { status: 'archived' } })` (B1-15). Keep `CATALOGUE` exported for the guard test but rename it `PHASE_S_PLACEHOLDERS`.
2. Size charts: upsert by `(storeId, name)` via `findFirst` + update/create: `عباية (مقاس x طول)` (columns المقاس/Size, الطول/Length, الصدر/Chest; rows S–XL × 52–58) and `ملابس (S-XXL)`; link `categories.sizeChartId` per `QAMAR_CATEGORIES[].sizeChart`.
3. Categories upsert on `storeId_slug`.
4. Products upsert on `storeId_slug` with `facts`, `leadTimeDays`, `personalisation`, `compareAtPrice`, `status: 'active'`; `inventory: p.options ? 0 : (p.stock ?? 25)` (inventory model: a variant product's own inventory stays 0); images: `deleteMany` + `createMany` for that product (no FK points at `product_images`), URLs `${base}/${file}`.
5. Options/values/variants WITHOUT deleting (cart lines may point at variants): `productOption.upsert({ where: { productId_name } })`, `productOptionValue.upsert({ where: { optionId_value } , update: { valueAr, swatchHex, swatchImageUrl }})`, variants found by `{ productId, sku }` (`sku = <SLUG>-<initials>`) then update/create with `inventory: soldOut ? 0 : 8`, `allowBackorder: p.backorder === true`, `productVariantOption.createMany({ data, skipDuplicates: true })`.
6. Shipping zone "القاهرة الكبرى" upsert (`estimatedDaysMin 1`, `Max 3`, fee 6000) and `settings.deliveryDays = { min: 2, max: 4 }` merged into `store.settings` (read, spread, write; the store row is the seed's own), `settings.defaultLanguage = 'ar'`, announcement bar text "متجر تجريبي · الصور توضيحية / Demo store · illustrative photos".
7. Home: `const state = await getPageState(store.id, 'home'); const doc = buildQamarHome(state.definition, { img, productIdBySlug }); saveDraft → publishDraft` (copy the dahab seed block at `scripts/dahab-demo/seed-dahab.mjs:569-586`). `buildQamarHome` (in `scripts/storedemo/qamar-home.mjs`) builds the **superset**: hero (2 slides: Atelier still with `video`/`videoMobile` = `${base}/hero.mp4`, and the Lookbook collage slides 3 images), category-grid, featured-collection (newest), image-text (full-bleed break), product-carousel (abayas), shop-the-look (Task 7 adds the section type; until then it is left out), collection-list (occasion bands, Task 8), testimonials, brand-story. Each node via `sectionFromPreset` + content settings only (design keys come from the look mix at render, B1-8).
8. `--local-look-stores` (refused with `--yes-production`): additionally creates three NON-demo stores `qamar-atelier`, `qamar-lookbook`, `qamar-vitrine` with the same catalogue, each with its look applied through `StoreService.applyLook(storeId, lookId, { design: 'reset' })` (the real merchant path).
9. `describePlan` prints the Qamar counts and `archived: electronics, beauty, home-kitchen, jewellery`.
10. Finally `invalidateStoreProductCaches(store.id)` (import as the dahab seed does).

- [ ] **Step 5: Run tests, then seed locally**

Run: `npx vitest run tests/unit/qamar-demo-catalogue.test.ts tests/unit/storedemo-seed-guard.test.ts; echo "exit=$?"` → exit=0.

Local stack (`.superpowers/shared/local-stack/README.md`): start API/web/admin/proxy; extend the gitignored `dev-proxy.mjs` to also forward a well-formed `?look=` as `x-demo-look` (mirror of middleware; not committed). Serve assets: `(cd scripts/qamar-demo/assets && python3 -m http.server 9000) &`. Seed twice (idempotency):

```bash
DATABASE_URL=postgresql://ahmadsharaf@localhost:5432/ebda_b0_test QAMAR_DEMO_ASSET_BASE=http://localhost:9000 \
  npx tsx scripts/storedemo/seed.mjs --local-look-stores; echo "exit=$?"
DATABASE_URL=postgresql://ahmadsharaf@localhost:5432/ebda_b0_test QAMAR_DEMO_ASSET_BASE=http://localhost:9000 \
  npx tsx scripts/storedemo/seed.mjs --local-look-stores; echo "exit=$?"
psql postgresql://ahmadsharaf@localhost:5432/ebda_b0_test -c "select count(*) from products p join stores s on s.id=p.store_id where s.slug='storedemo' and p.status='active';"
```

Expected: both exit=0; the active count equals `QAMAR_PRODUCTS.length` both times (no duplicates).

- [ ] **Step 6: Commit**

```bash
git add scripts/qamar-demo/catalogue.mjs scripts/qamar-demo/prompts.py scripts/qamar-demo/gen.py scripts/qamar-demo/encode.sh scripts/qamar-demo/make-video.sh scripts/qamar-demo/CREDITS.md scripts/qamar-demo/assets scripts/storedemo/seed.mjs scripts/storedemo/qamar-home.mjs .gitignore tests/unit/qamar-demo-catalogue.test.ts tests/unit/storedemo-seed-guard.test.ts docs/RULINGS.md
git commit -m "$(cat <<'EOF'
feat(storedemo): qamar demo catalogue, illustrative assets and showroom seed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

(Rulings B1-9, B1-10, B1-15, B1-16 appended here.)

- [ ] **Step 7: Atelier screenshots + taste gate — STOP 1**

On `http://qamar-atelier.localhost:3100` (the real merchant path) shoot home, PLP (`/products?category=abayas`), PDP (`/products/linen-abaya`), cart with one personalised line, checkout, and `/size-guide`, at 390×844, 820×1180, 1280×800 × ar (Arabic-Indic numerals on via the store setting) and en: `node .superpowers/shared/local-stack/shots.mjs qamar-atelier <path> .superpowers/sdd/2026-10-15-phase-b1-qamar/atelier/<name>` (extend `shots.mjs` with an 820 size; gitignored). Run the impeccable `critique` skill on the home and PDP shots; fix every P0/P1 inside Tasks 3–5's files and re-shoot; record any P2 left as a Ruling. Compare against research (`docs/ebda/templates/research/qamar.md`: Mamzi/Everlane restraint, COD + delivery always visible; anti-bar Alamal).

**STOP 1 — do not start Task 7.** Send Ahmad: the 18 Atelier screenshots (as an artifact gallery page if allowed by the session, else the folder path), the three-line taste note, the critique's remaining P2s, and the question "Atelier approved, or what changes?". Apply his round (2–4 rounds budgeted, CLAUDE.md rule 10) as fix commits on this branch (`fix(qamar): atelier review round N`) before continuing.

---

### Task 7: Lookbook — collage hero + `shop-the-look` section + mix

**Files:**

- Modify: `packages/shared/src/builder/layout-schema.ts:182`, `packages/shared/src/types/store-layout.ts:209` (`presentation` += `'collage'`), `packages/shared/src/builder/registry.ts` (hero presentation option; new `shop-the-look` entry + `look` block)
- Modify: `packages/shared/src/builder/sections-document-only.ts` (`shopTheLookSchema`, `shopTheLookBlockSchema`)
- Modify: `packages/shared/src/builder/validate.ts` (cross-store product refs for `shop-the-look` blocks — reuse the existing product-ref check used by `product-spotlight`)
- Create: `apps/web/src/templates/shared/HeroCollage.tsx`, `apps/web/src/builder/sections/ShopTheLookSection.tsx`
- Modify: `apps/web/src/builder/render/PageRenderer.tsx` (hero collage branch; `shop-the-look` dispatch), `apps/web/src/app/HomePageBody.tsx:85-110` (`documentSectionRefs` collects `shop-the-look` block product ids)
- Modify: `apps/web/src/styles/globals.css` (collage settle motion, reduced motion)
- Modify: `packages/shared/src/looks/registry.ts` (Lookbook `sections` + `chrome`)
- Modify: `scripts/storedemo/qamar-home.mjs` (shop-the-look node with 3 looks from `QAMAR_LOOKS_STORY`)
- Modify: `apps/web/src/contexts/LanguageContext.tsx` ("Shop the look" / "تسوّقي اللوك", "items in this look" / "قطع اللوك")
- Test: `tests/unit/qamar-lookbook-render.test.tsx`

**Interfaces:**

- Consumes: `resolveSectionProducts`, `toTemplateProduct`, `formatPrice` (whatever the shared card uses; grep `formatPrice\|formatMoney` in `templates/shared/StorefrontProductCard.tsx` and use the same), `HeroSlide` type.
- Produces:

  ```ts
  export const shopTheLookSchema: z.ZodObject<{ heading, headingAr, bgColor, … }>;
  export const shopTheLookBlockSchema: z.ZodObject<{ image, imageAr, alt, altAr, title, titleAr, productIds: string[] (1..4) }>;
  export function HeroCollage(props: { slides: HeroSlide[]; isRtl: boolean; urlPrefix: string; headingZone?: ResolvedZone }): JSX.Element | null;
  export function ShopTheLookSection(props: { settings: ShopTheLookSettings; blocks: SectionBlock[]; products: Product[]; editorMode?: boolean }): JSX.Element | null;
  ```

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/qamar-lookbook-render.test.tsx  (harness as in Task 3)
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  shopTheLookSchema,
  shopTheLookBlockSchema,
  storeLayoutSchema,
  getLook,
  getSectionDefinition,
} from '@ebda/shared';
import { HeroCollage } from '../../apps/web/src/templates/shared/HeroCollage';
import { ShopTheLookSection } from '../../apps/web/src/builder/sections/ShopTheLookSection';
import { PRODUCTS } from '../fixtures/builder/homepage-data';

const slides = [1, 2, 3].map(i => ({
  image: `https://x/${i}.webp`,
  alt: `look ${i}`,
  headlineAr: 'لوك الأسبوع',
  headline: 'Look of the week',
  ctaHref: '/products',
}));

describe('hero collage', () => {
  it('schema accepts presentation collage', () => {
    const hero = storeLayoutSchema.shape.hero.unwrap();
    expect(
      hero.safeParse({ enabled: true, mode: 'single', presentation: 'collage', slides: [] }).success
    ).toBe(true);
  });
  it('renders three overlapping photos and one headline; first image is eager (LCP)', () => {
    const html = renderToStaticMarkup(<HeroCollage slides={slides} isRtl urlPrefix="" />);
    expect(html.match(/<img /g)?.length).toBe(3);
    expect(html.match(/<h1/g)?.length).toBe(1);
    expect(html).toMatch(
      /loading="eager"[^>]*fetchpriority="high"|fetchpriority="high"[^>]*loading="eager"/
    );
    expect(html).toContain('data-collage-settle');
  });
  it('fewer than 3 images returns null (the caller falls back to the banner)', () => {
    expect(
      renderToStaticMarkup(<HeroCollage slides={slides.slice(0, 2)} isRtl urlPrefix="" />)
    ).toBe('');
  });
});

describe('shop-the-look', () => {
  it('is a registered document-only template section with ≤ 6 look blocks of ≤ 4 products', () => {
    const d = getSectionDefinition('shop-the-look')!;
    expect(d.legacyKey).toBeNull();
    expect(d.blocks[0].type).toBe('look');
    expect(d.blocks[0].maxCount).toBe(6);
    expect(
      shopTheLookBlockSchema.safeParse({ productIds: ['a', 'b', 'c', 'd', 'e'] }).success
    ).toBe(false);
    expect(shopTheLookSchema.safeParse({ heading: 'x', unknown: 1 }).success).toBe(false); // strict
  });
  it('renders each look with its items as links + prices, no add-to-cart (Ruling B1-6)', () => {
    const blocks = [
      {
        id: 'l1',
        type: 'look',
        settings: {
          image: 'https://x/l.webp',
          titleAr: 'لوك الكتان',
          productIds: [PRODUCTS[0].id, PRODUCTS[1].id],
        },
      },
    ];
    const html = renderToStaticMarkup(
      <ShopTheLookSection
        settings={{ headingAr: 'تسوّقي اللوك' }}
        blocks={blocks as any}
        products={PRODUCTS as any}
      />
    );
    expect(html).toContain('snap-x');
    expect(html).toContain(`/products/${PRODUCTS[0].slug}`);
    expect(html).not.toMatch(/add-to-cart|data-cta|<button/i);
  });
  it('a look whose products are all missing renders nothing (no empty card)', () => {
    const blocks = [
      { id: 'l1', type: 'look', settings: { image: 'https://x/l.webp', productIds: ['gone'] } },
    ];
    expect(
      renderToStaticMarkup(
        <ShopTheLookSection settings={{}} blocks={blocks as any} products={[]} />
      )
    ).toBe('');
  });
  it('Lookbook mix uses the collage hero and shop-the-look', () => {
    const mix = getLook('qamar.lookbook')!.sections!.map(s => s.type);
    expect(mix.slice(0, 2)).toEqual(['hero', 'shop-the-look']);
    expect(getLook('qamar.lookbook')!.sections![0].design).toMatchObject({
      presentation: 'collage',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/qamar-lookbook-render.test.tsx; echo "exit=$?"` → FAIL.

- [ ] **Step 3: Write minimal implementation**

Schemas (`sections-document-only.ts`, same helpers `frame`, `text` already in that file):

```ts
export const shopTheLookSchema = z
  .object({ ...frame, heading: text(200), headingAr: text(200) })
  .strict();

export const shopTheLookBlockSchema = z
  .object({
    image: z.string().max(2048).optional(),
    imageAr: z.string().max(2048).optional(),
    alt: text(300),
    altAr: text(300),
    title: text(80),
    titleAr: text(80),
    productIds: z.array(z.string().max(64)).min(1).max(4).optional(),
  })
  .strict();
```

Registry entry (after `product-spotlight`):

```ts
  def({
    type: 'shop-the-look',
    labelEn: 'Shop the look',
    labelAr: 'تسوّقي اللوك',
    legacyKey: null,
    rendererKey: 'section.shopTheLook',
    group: 'template',
    propsSchema: shopTheLookSchema,
    maxCount: 2,
    blocks: [
      {
        type: 'look',
        labelEn: 'Look',
        labelAr: 'لوك',
        maxCount: 6,
        propsSchema: shopTheLookBlockSchema,
        settings: [
          s.image('image', 'Photo', 'الصورة', { localized: true }),
          s.text('alt', 'Photo description', 'وصف الصورة', { localized: true }),
          s.text('title', 'Look name', 'اسم اللوك', { localized: true }),
          { id: 'productIds', type: 'product_list', labelEn: 'Pieces', labelAr: 'القطع', group: 'content', max: 4 },
        ],
      },
    ],
    presets: [{ nameEn: 'Shop the look', nameAr: 'تسوّقي اللوك', settings: { heading: 'Shop the look', headingAr: 'تسوّقي اللوك' }, blocks: [] }],
    settings: [
      s.text('heading', 'Heading', 'العنوان', { localized: true }),
      s.color('bgColor', 'Background', 'الخلفية'),
      ...spacingSettings(),
    ],
  }),
```

`validate.ts`: in the block-reference check that already validates `product-spotlight`'s product ids belong to the store, add `shop-the-look` blocks' `productIds` (find that function with `grep -n "product-spotlight" packages/shared/src/builder/validate.ts apps/api/src/services/page-builder.service.ts` and extend the same switch; the API's cross-store ref check must refuse another store's product id with the same error code it uses for spotlight).

`HeroCollage.tsx`:

```tsx
'use client';
import type { HeroSlide } from '@ebda/shared';
import { HeroBannerLink } from './HeroBannerLink';

/**
 * Collage hero (Ruling B1-2, Qamar Lookbook): three photos overlap, one headline, one CTA.
 * The first photo is the LCP element (eager, high priority); the settle motion is CSS
 * (`[data-collage-settle]`, Ruling B1-7) and off under reduced motion. < 3 images → null,
 * and the renderer falls back to the single banner.
 */
export function HeroCollage({
  slides,
  isRtl,
  urlPrefix,
}: {
  slides: HeroSlide[];
  isRtl: boolean;
  urlPrefix: string;
}) {
  const imgs = slides.filter(s => s.image).slice(0, 3);
  if (imgs.length < 3) return null;
  const lead = imgs[0];
  const headline =
    (isRtl ? lead.headlineAr || lead.headline : lead.headline || lead.headlineAr) ?? '';
  const cta = (isRtl ? lead.ctaTextAr || lead.ctaText : lead.ctaText || lead.ctaTextAr) ?? '';
  return (
    <section
      data-section="hero"
      data-presentation="collage"
      className="relative overflow-hidden bg-background"
    >
      <div
        className="mx-auto grid max-w-7xl grid-cols-6 items-end gap-0 px-4 pt-6 sm:px-6 lg:px-8"
        data-collage-settle
      >
        <img
          src={lead.image}
          alt={lead.alt ?? ''}
          loading="eager"
          fetchPriority="high"
          className="col-span-4 col-start-1 row-start-1 aspect-[4/5] w-full object-cover"
        />
        <img
          src={imgs[1].image}
          alt={imgs[1].alt ?? ''}
          loading="lazy"
          className="col-span-3 col-start-4 row-start-1 mb-16 aspect-[3/4] w-full object-cover ring-4 ring-background"
        />
        <img
          src={imgs[2].image}
          alt={imgs[2].alt ?? ''}
          loading="lazy"
          className="col-span-2 col-start-5 row-start-1 -mb-6 aspect-square w-full object-cover ring-4 ring-background"
        />
      </div>
      <div className="mx-auto max-w-7xl px-4 pb-10 pt-6 sm:px-6 lg:px-8">
        {headline && (
          <h1 className="font-display text-4xl leading-[1.2] text-foreground sm:text-6xl">
            {headline}
          </h1>
        )}
        {cta && (
          <HeroBannerLink
            href={lead.ctaHref ?? '/products'}
            urlPrefix={urlPrefix}
            className="mt-5 inline-flex min-h-[44px] items-center rounded-[var(--radius)] bg-primary px-6 text-sm font-medium text-primary-foreground"
          >
            {cta}
          </HeroBannerLink>
        )}
      </div>
    </section>
  );
}
```

(Use `HeroBannerLink`'s real props; grep its export. `col-start-*` with `grid` and `dir=rtl` mirrors automatically.)

CSS (`globals.css`):

```css
@media (prefers-reduced-motion: no-preference) {
  [data-collage-settle] > img {
    animation: collage-settle 280ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  [data-collage-settle] > img:nth-child(2) {
    animation-delay: 60ms;
  }
  [data-collage-settle] > img:nth-child(3) {
    animation-delay: 120ms;
  }
}
@keyframes collage-settle {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
```

The first image starts at opacity 0 for 280 ms: confirm in the Task 10 Lighthouse/LCP probe that LCP still reports this image and LCP ≤ 2.5 s on the throttled run; if LCP regresses, drop the animation on the first image only (`:nth-child(1) { animation: none }`) and note it in the ruling.

`PageRenderer.tsx` hero: before the slider/banner branches,

```tsx
            {layout.hero.enabled && layout.hero.presentation === 'collage' && heroSlidesWithImage(layout.hero.slides).length >= 3 ? (
              <HeroCollage slides={heroSlidesWithImage(layout.hero.slides)} isRtl={isRtl} urlPrefix={storeUrl('')} />
            ) : ( /* existing slider / banner / legacy branches unchanged */ )}
```

and a `shop-the-look` arm in the document-only dispatch:

```tsx
              ) : def.type === 'shop-the-look' ? (
                <ShopTheLookSection
                  settings={settings as ShopTheLookSettings}
                  blocks={section.blocks ?? []}
                  products={[...pools.newArrivals, ...pools.bestSellers, ...pools.featured, ...pools.extra]}
                  editorMode={editorMode}
                />
```

`HomePageBody.tsx` `documentSectionRefs`: for `n.type === 'shop-the-look'`, push every block's `settings.productIds` strings into `productIds` (the existing manual-id fetch then loads them into `extraProducts`).

`ShopTheLookSection.tsx`: a horizontal `snap-x snap-mandatory overflow-x-auto` row of look panels (`w-[85%] sm:w-[45%] lg:w-[32%] shrink-0 snap-start`); each panel = 4:5 photo, title, then a list of its found products (`<a href={storeUrl('/products/'+p.slug)}>` with a 56px 3:4 thumbnail, localized name, price via the shared money formatter, Western digits unless the store opted in), and a muted total line "مجموع اللوك 4,280 ج.م / Look total EGP 4,280". A panel with zero found products is skipped; a section with no panel returns null (unless `editorMode`, which shows a dashed placeholder like `ImageTextSection`).

Lookbook registry entry:

```ts
    chrome: { header: { logoPlacement: 'start' } },
    sections: [
      { type: 'hero', design: { presentation: 'collage', mode: 'single' } },
      { type: 'shop-the-look', design: { bgColor: 'token:card' } },
      { type: 'category-grid', design: { layout: 'horizontal', layoutMobile: 'horizontal', captionPosition: 'below' } },
      { type: 'featured-collection', design: { columns: 4, mobileColumns: 2, bgColor: 'token:card' },
        preset: { productSource: 'newest', limit: 8, heading: 'New in', headingAr: 'وصل حديثًا' } },
      { type: 'testimonials' },
    ],
```

`qamar-home.mjs`: add the `shop-the-look` node with three `look` blocks from `QAMAR_LOOKS_STORY` (product ids from `productIdBySlug`).

- [ ] **Step 4: Run tests + cross-skin**

Run: `npx vitest run tests/unit/qamar-lookbook-render.test.tsx tests/unit/layout-schema-parity.test.ts tests/unit/dahab-template-render.test.tsx tests/unit/looks-section-mix.test.ts; echo "exit=$?"` → exit=0. Add to `qamar-lookbook-render.test.tsx` a loop rendering `HeroCollage` and `ShopTheLookSection` under `ctx.store.template` = `minimal`, `dahab`, `qamar` asserting non-empty markup (Review Focus 5).
Run the API ref check: `npm run test:integration -- tests/integration/page-builder*.test.ts; echo "exit=$?"` plus a new case in the existing cross-store-ref integration test: a `shop-the-look` block naming another store's product id → the same refusal code as `product-spotlight`.

- [ ] **Step 5: Re-seed, screenshots, taste gate, commit**

Re-seed locally (Task 6 Step 5 commands), shoot `qamar-lookbook` (390/820/1280 × ar/en: home, PLP, PDP, cart), impeccable `critique`, fix P0/P1.

```bash
git add packages/shared/src/builder/layout-schema.ts packages/shared/src/types/store-layout.ts packages/shared/src/builder/registry.ts packages/shared/src/builder/sections-document-only.ts packages/shared/src/builder/validate.ts apps/web/src/templates/shared/HeroCollage.tsx apps/web/src/builder/sections/ShopTheLookSection.tsx apps/web/src/builder/render/PageRenderer.tsx apps/web/src/app/HomePageBody.tsx apps/web/src/styles/globals.css apps/web/src/contexts/LanguageContext.tsx packages/shared/src/looks/registry.ts scripts/storedemo/qamar-home.mjs tests/unit/qamar-lookbook-render.test.tsx docs/RULINGS.md
git commit -m "$(cat <<'EOF'
feat(qamar): lookbook look with collage hero and shop-the-look section

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

(Add the integration test file path you changed. Rulings B1-6, B1-7, B1-21 appended.)

---

### Task 8: Vitrine — occasion bands, framed hairline hero, single customer line, champagne line token

**Files:**

- Modify: `packages/shared/src/builder/sections-document-only.ts:116-134` (`tileShape` += `'band'`; block `tone`)
- Modify: `packages/shared/src/builder/registry.ts` (collection-list tile shape option + block `tone` select; testimonials `layout` select)
- Modify: `packages/shared/src/builder/layout-schema.ts:370` + `packages/shared/src/types/store-layout.ts` (testimonials `layout?: 'row' | 'single'`)
- Modify: `apps/web/src/builder/sections/CollectionListSection.tsx` (band branch)
- Modify: `apps/web/src/templates/shared/TestimonialRow.tsx` (single layout) and the `T.TestimonialRow` call in `PageRenderer.tsx` (pass `layout`)
- Modify: `apps/web/src/templates/shared/HeroBanner.tsx` (framed → `data-frame-draw` hairline using `--border`)
- Modify: `apps/web/src/styles/globals.css` (frame draw motion)
- Modify: `packages/shared/src/looks/registry.ts` (Vitrine `line: '#D8B96A'`, `sections`, `chrome: centre`)
- Modify: `scripts/storedemo/qamar-home.mjs` (occasion band collection-list from `QAMAR_OCCASIONS`)
- Modify: `apps/admin/public/looks/qamar.vitrine.webp` (regenerated thumbnail)
- Test: `tests/unit/qamar-vitrine-render.test.tsx`, extend `tests/unit/qamar-looks-contrast.test.ts`

**Interfaces:**

- Consumes: `resolveColor`, `getLook`.
- Produces: `CollectionBlockSettings.tone?: 'primary' | 'accent' | 'line'`; `TestimonialRowProps.layout?: 'row' | 'single'`.

- [ ] **Step 1: Write the failing tests**

```tsx
// tests/unit/qamar-vitrine-render.test.tsx (harness as in Task 3)
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  collectionListSchema,
  collectionBlockSchema,
  getLook,
  getTemplateTheme,
} from '@ebda/shared';
import { CollectionListSection } from '../../apps/web/src/builder/sections/CollectionListSection';
import { TestimonialRow } from '../../apps/web/src/templates/shared/TestimonialRow';
import { CATEGORIES, TESTIMONIALS } from '../fixtures/builder/homepage-data';

const blocks = [
  {
    id: 'o1',
    type: 'collection',
    settings: {
      categorySlug: CATEGORIES[0].slug,
      label: 'Wedding',
      labelAr: 'فرح',
      tone: 'primary',
    },
  },
  {
    id: 'o2',
    type: 'collection',
    settings: {
      categorySlug: CATEGORIES[1].slug,
      label: 'Engagement',
      labelAr: 'خطوبة',
      tone: 'accent',
    },
  },
  {
    id: 'o3',
    type: 'collection',
    settings: { categorySlug: CATEGORIES[0].slug, label: 'Evening', labelAr: 'سهرة', tone: 'line' },
  },
];

describe('occasion bands', () => {
  it('schema: band shape + tone', () => {
    expect(collectionListSchema.safeParse({ tileShape: 'band' }).success).toBe(true);
    expect(collectionBlockSchema.safeParse({ tone: 'line' }).success).toBe(true);
    expect(collectionBlockSchema.safeParse({ tone: 'pink' }).success).toBe(false);
  });
  for (const skin of ['minimal', 'dahab', 'qamar'] as const)
    it(`each block is a full-width band on its tone, text on the matching foreground (${skin})`, () => {
      ctx.store = { ...ctx.store, template: skin, theme: getTemplateTheme(skin) };
      const html = renderToStaticMarkup(
        <CollectionListSection
          settings={{ tileShape: 'band', headingAr: 'تسوّقي حسب المناسبة' }}
          blocks={blocks as any}
          categories={CATEGORIES as any}
        />
      );
      expect(html).toContain('data-tile-shape="band"');
      expect(html).toContain('bg-primary text-primary-foreground');
      expect(html).toContain('bg-accent text-accent-foreground');
      expect(html).toContain('bg-border text-foreground');
    });
});

describe('single customer line', () => {
  it('renders exactly one quote, no cards', () => {
    const html = renderToStaticMarkup(
      <TestimonialRow testimonials={TESTIMONIALS as any} isRtl layout="single" />
    );
    expect(html.match(/<blockquote/g)?.length).toBe(1);
  });
  it('row layout unchanged when layout is absent', () => {
    const a = renderToStaticMarkup(<TestimonialRow testimonials={TESTIMONIALS as any} isRtl />);
    expect(a).not.toContain('data-layout="single"');
  });
});

describe('vitrine look data', () => {
  it('champagne line, centred wordmark, occasion-first mix (Rulings B1-5, B1-4)', () => {
    const v = getLook('qamar.vitrine')!;
    expect(v.tokens.line).toBe('#D8B96A');
    expect(v.chrome?.header.logoPlacement).toBe('centre');
    expect(v.sections!.map(s => s.type).slice(0, 2)).toEqual(['hero', 'collection-list']);
    expect(v.sections![0].design).toMatchObject({ presentation: 'framed' });
    expect(v.sections![1].design).toMatchObject({ tileShape: 'band' });
  });
});
```

Extend `qamar-looks-contrast.test.ts`:

```ts
describe('vitrine band text', () => {
  const t = LOOKS.find(l => l.id === 'qamar.vitrine')!.tokens;
  it('onPrimary on primary band', () =>
    expect(contrastRatio(t.primary, t.onPrimary)).toBeGreaterThanOrEqual(4.5));
  it('onPrimary on accent band', () =>
    expect(contrastRatio(t.accent, t.onPrimary)).toBeGreaterThanOrEqual(4.5));
  it('ink on champagne line band', () =>
    expect(contrastRatio(t.line, t.ink)).toBeGreaterThanOrEqual(4.5));
  it('champagne hairline ≥ the old line against the page (1.4.11 direction)', () =>
    expect(contrastRatio(t.page, t.line)).toBeGreaterThan(contrastRatio('#F5F5F6', '#E0E0E5')));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/qamar-vitrine-render.test.tsx tests/unit/qamar-looks-contrast.test.ts; echo "exit=$?"` → FAIL.

- [ ] **Step 3: Write minimal implementation**

`collectionListSchema.tileShape: z.enum(['arch', 'rectangle', 'circle', 'band']).optional()`; `collectionBlockSchema` gains `tone: z.enum(['primary', 'accent', 'line']).optional()`. Registry: tile shape option `opt('band', 'Full-width bands', 'شرائط بعرض الشاشة')`; block setting `s.select('tone', 'Band colour', 'لون الشريط', [opt('primary', 'Main colour', 'اللون الأساسي'), opt('accent', 'Accent', 'لون مميز'), opt('line', 'Hairline colour', 'لون الخطوط')])`.

`CollectionListSection.tsx`, before the tile grid:

```tsx
if (settings.tileShape === 'band') {
  const TONE = {
    primary: 'bg-primary text-primary-foreground',
    accent: 'bg-accent text-accent-foreground',
    line: 'bg-border text-foreground',
  } as const;
  const rows = blocks
    .map(b => ({ b, cat: categories.find(c => c.slug === b.settings.categorySlug) }))
    .filter(r => r.cat || editorMode);
  if (rows.length === 0) return null;
  return (
    <section data-section="collection-list" data-tile-shape="band">
      {heading && (
        <h2 className="mx-auto max-w-7xl px-4 py-8 font-display text-3xl sm:px-6 lg:px-8">
          {heading}
        </h2>
      )}
      {rows.map(({ b, cat }, i) => {
        const tone =
          TONE[
            (b.settings.tone as keyof typeof TONE) ??
              (['primary', 'accent', 'line'] as const)[i % 3]
          ];
        const label = pick(b.settings.label, b.settings.labelAr) || pick(cat?.name, cat?.nameAr);
        const img = pick(b.settings.image, b.settings.imageAr) || cat?.image;
        return (
          <a
            key={b.id}
            href={storeUrl(`/products?category=${encodeURIComponent(cat?.slug ?? '')}`)}
            className={`${tone} block`}
          >
            <div className="mx-auto grid max-w-7xl grid-cols-[1fr_auto] items-center gap-4 px-4 py-6 sm:px-6 lg:px-8">
              <span className="font-display text-3xl sm:text-4xl">{label}</span>
              {img && (
                <img
                  src={img}
                  alt=""
                  loading="lazy"
                  className="h-28 w-20 object-cover sm:h-40 sm:w-28"
                />
              )}
            </div>
          </a>
        );
      })}
    </section>
  );
}
```

(`pick`, `heading`, `storeUrl` follow the helpers already in that file; match their real names.) The tone classes rely on `--accent-foreground` = `onPrimary` (`lookTheme`) and `--border` = `line`; legacy skins define both vars in `globals.css`, so the band renders everywhere.

`TestimonialRow.tsx`: `layout?: 'row' | 'single'`; when `'single'`, render only the first testimonial as `<figure data-layout="single" className="mx-auto max-w-3xl px-4 py-12 text-center"><blockquote className="font-display text-2xl leading-relaxed sm:text-3xl">“…”</blockquote><figcaption className="mt-4 text-sm text-muted-foreground">— name</figcaption></figure>`. Thread `layout.testimonials.layout` through `PageRenderer` and Dahab's `DahabTestimonialRow` (accept and honour the same prop, platform parity). Add `layout: z.enum(['row', 'single']).optional()` to the testimonials layout schema and the registry select.

`HeroBanner.tsx` framed branch: add `data-frame-draw` and an absolutely positioned inner `<span aria-hidden className="pointer-events-none absolute inset-3 border border-border" />` only when `isFramed`.

CSS:

```css
@media (prefers-reduced-motion: no-preference) {
  [data-frame-draw] > span[aria-hidden] {
    animation: frame-draw 600ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }
}
@keyframes frame-draw {
  from {
    clip-path: inset(50% 50% 50% 50%);
  }
  to {
    clip-path: inset(0 0 0 0);
  }
}
```

Vitrine registry: `line: '#D8B96A'`;

```ts
    chrome: { header: { logoPlacement: 'centre' } },
    sections: [
      { type: 'hero', design: { presentation: 'framed', mode: 'single' } },
      { type: 'collection-list', design: { tileShape: 'band' },
        preset: { heading: 'Shop by occasion', headingAr: 'تسوّقي حسب المناسبة' } },
      { type: 'featured-collection', design: { columns: 4, mobileColumns: 2 },
        preset: { productSource: 'newest', limit: 8, heading: 'In the window', headingAr: 'في الفاترينة' } },
      { type: 'testimonials', design: { layout: 'single' } },
    ],
```

`qamar-home.mjs`: the collection-list node with `QAMAR_OCCASIONS` blocks (`tone` from the data). Regenerate the admin thumbnail: `node apps/admin/scripts/look-thumbs.mjs qamar.vitrine; echo "exit=$?"` (macOS Chrome + sips + cwebp) and read it back.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/qamar-vitrine-render.test.tsx tests/unit/qamar-looks-contrast.test.ts tests/unit/looks-contrast.test.ts tests/unit/looks-registry.test.ts tests/unit/layout-schema-parity.test.ts tests/unit/dahab-template-render.test.tsx; echo "exit=$?"` → exit=0.

- [ ] **Step 5: Re-seed, screenshots, taste gate, commit**

Shoot `qamar-vitrine` (as Task 7), critique, fix P0/P1.

```bash
git add packages/shared/src/builder/sections-document-only.ts packages/shared/src/builder/registry.ts packages/shared/src/builder/layout-schema.ts packages/shared/src/types/store-layout.ts apps/web/src/builder/sections/CollectionListSection.tsx apps/web/src/templates/shared/TestimonialRow.tsx apps/web/src/templates/dahab/TestimonialRow.tsx apps/web/src/builder/render/PageRenderer.tsx apps/web/src/templates/shared/HeroBanner.tsx apps/web/src/styles/globals.css packages/shared/src/looks/registry.ts scripts/storedemo/qamar-home.mjs apps/admin/public/looks/qamar.vitrine.webp tests/unit/qamar-vitrine-render.test.tsx tests/unit/qamar-looks-contrast.test.ts docs/RULINGS.md
git commit -m "$(cat <<'EOF'
feat(qamar): vitrine look with occasion bands, framed hero and one customer line

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

(Ruling B1-5 appended.)

---

### Task 9: Demo surface — look mix at render, two-step bar, look kept across links, noindex, PII refusals

**Files:**

- Create: `apps/web/src/lib/demo-home.ts`
- Modify: `apps/web/src/app/HomePageBody.tsx` (apply `demoHomeDefinition` when `store.isDemo`)
- Modify: `apps/web/src/components/demo/DemoLookBar.tsx`, `DemoLookBar.test.tsx`
- Modify: `apps/web/src/app/robots.ts`, `apps/web/src/app/sitemap.ts`, `apps/web/src/lib/storefront-metadata.ts` (noindex for `isDemo`)
- Modify: `apps/api/src/services/plan-limit.service.ts` (`assertNotDemoStore`), `apps/api/src/routes/auth.routes.ts:209` (register), `apps/api/src/routes/public.routes.ts` (`/newsletter/subscribe` at ~1917, `/contact` at ~2165)
- Test: `tests/unit/web-demo-home.test.ts`, `tests/unit/demo-order-guard-coverage.test.ts`, `tests/integration/demo-store.test.ts` (extend)

**Interfaces:**

- Consumes: `applyTemplateFamily`, `getLook`, `parseDefinition`; `assertOrderAllowed`.
- Produces:

  ```ts
  export function demoHomeDefinition(
    store: Pick<ResolvedStore, 'isDemo' | 'look'>,
    def: PageDefinition | undefined
  ): PageDefinition | undefined;
  export async function assertNotDemoStore(storeId: string): Promise<void>; // 403 DEMO_STORE
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/web-demo-home.test.ts
import { describe, it, expect } from 'vitest';
import { sectionFromPreset, type PageDefinition } from '@ebda/shared';
import { demoHomeDefinition } from '../../apps/web/src/lib/demo-home';

const superset = (): PageDefinition =>
  ({
    version: 1,
    header: [],
    footer: [],
    sections: [
      'hero',
      'category-grid',
      'shop-the-look',
      'collection-list',
      'featured-collection',
      'image-text',
      'testimonials',
    ].map(t => sectionFromPreset(t, 0, t)),
  }) as unknown as PageDefinition;

describe('demo home renders the superset through the look mix (Ruling B1-8)', () => {
  it('Lookbook: collage hero then shop-the-look; no occasion bands', () => {
    const d = demoHomeDefinition({ isDemo: true, look: 'qamar.lookbook' }, superset())!;
    expect(d.sections.map(s => s.type).slice(0, 2)).toEqual(['hero', 'shop-the-look']);
    expect(d.sections.some(s => s.type === 'collection-list')).toBe(false);
    expect(d.sections[0].settings.presentation).toBe('collage');
  });
  it('a non-demo store is returned untouched (same object)', () => {
    const def = superset();
    expect(demoHomeDefinition({ isDemo: false, look: 'qamar.lookbook' }, def)).toBe(def);
  });
  it('a demo store with no look / unknown look / a look with no mix is untouched', () => {
    const def = superset();
    expect(demoHomeDefinition({ isDemo: true, look: null }, def)).toBe(def);
    expect(demoHomeDefinition({ isDemo: true, look: 'qamar.gone' }, def)).toBe(def);
    expect(demoHomeDefinition({ isDemo: true, look: 'souq.catalogue' }, def)).toBe(def);
  });
  it('undefined definition stays undefined', () =>
    expect(demoHomeDefinition({ isDemo: true, look: 'qamar.atelier' }, undefined)).toBeUndefined());
});
```

```ts
// tests/unit/demo-order-guard-coverage.test.ts  (Ruling B1-13)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
// Every function body that creates an order row must call assertOrderAllowed first.
describe('every order-creating path calls assertOrderAllowed', () => {
  const files = globSync('apps/api/src/**/*.ts', { cwd: root }).filter(f => !f.includes('.test.'));
  const hits = files.flatMap(f => {
    const src = readFileSync(path.join(root, f), 'utf8');
    return [...src.matchAll(/\.order\.create\(/g)].map(m => ({ f, at: m.index!, src }));
  });
  it('found the known sites (guards the regex itself)', () =>
    expect(hits.length).toBeGreaterThan(0));
  for (const h of hits)
    it(`${h.f}@${h.at}`, () => {
      // nearest enclosing function start: last 'async ' or 'function ' before the hit
      const before = h.src.slice(0, h.at);
      const fnStart = Math.max(before.lastIndexOf('async '), before.lastIndexOf('function '));
      const body = h.src.slice(fnStart, h.at);
      const allowlisted = /DEMO-GUARD-EXEMPT: [^\n]+/.test(body);
      expect(
        allowlisted || /assertOrderAllowed\(/.test(body) || /\bcreateOrderGuarded\b/.test(body)
      ).toBe(true);
    });
});
```

(Run it first against `main`'s code: if a legitimate site fails because `assertOrderAllowed` is called by its caller (e.g. `OrderService.create` calls it, and a private helper does the insert), annotate that helper with a one-line `// DEMO-GUARD-EXEMPT: only reached from OrderService.create after assertOrderAllowed` and say so in the report. Use `fs.globSync` (Node ≥ 22); if the repo's Node is older, use the `glob` package already in the tree — check `ls node_modules/glob`.)

Integration (extend `tests/integration/demo-store.test.ts`): on the seeded demo fixture store, `POST /api/v1/auth/register { …, storeId: demo.id }` → 403 `DEMO_STORE` and no `users` row with that email; `POST /api/v1/public/newsletter/subscribe` with `X-Store-ID: demo.id` → 403 and no subscriber row; `POST /api/v1/public/contact` → 403 and `inngest.send` not called (spy); the same three on the non-demo fixture store → not 403. Mount the routers the way the file already mounts `paymentLinksRoutes`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/web-demo-home.test.ts tests/unit/demo-order-guard-coverage.test.ts; echo "exit=$?"` → FAIL (module missing).
Run: `npm run test:integration -- tests/integration/demo-store.test.ts; echo "exit=$?"` → FAIL on the three new cases.

- [ ] **Step 3: Write minimal implementation**

`apps/web/src/lib/demo-home.ts`:

```ts
import { applyTemplateFamily, getLook, type PageDefinition } from '@ebda/shared';
import type { ResolvedStore } from './store-resolver';

/**
 * The showroom keeps ONE superset home document; a demo store renders it through the current
 * look's section mix (Ruling B1-8). Any non-demo store, or a look without a mix, gets the SAME
 * object back, so merchant stores never take this path.
 */
export function demoHomeDefinition(
  store: Pick<ResolvedStore, 'isDemo' | 'look'>,
  def: PageDefinition | undefined
): PageDefinition | undefined {
  if (!def || !store.isDemo) return def;
  const look = getLook(store.look);
  if (!look?.sections?.length) return def;
  return applyTemplateFamily(def, look.template, look);
}
```

`HomePageBody.tsx`: right after `fetchLayoutSettings` resolves (non-builder path only), `const demoDef = builderDefinition ? undefined : demoHomeDefinition(store, draftBundle.definition);` and, when `demoDef !== draftBundle.definition`, use `definitionToLayout(demoDef)` as `layout` and `demoDef` for `documentSectionRefs` and for the `definition` passed down to `HomePageContent`/`PageRenderer` (follow how `draftBundle.definition` is threaded today).

`assertNotDemoStore` (`plan-limit.service.ts`, beside `assertOrderAllowed`, same `withStore` read):

```ts
/** Ruling B1-13: the showroom collects no visitor PII (register, newsletter, contact). */
export async function assertNotDemoStore(storeId: string): Promise<void> {
  const row = await withStore(storeId, tx =>
    tx.store.findUnique({ where: { id: storeId }, select: { isDemo: true } })
  );
  if (row?.isDemo) {
    throw new AppError(403, 'DEMO_STORE', 'This is a demo store; this action is disabled', {
      messageEn: 'This is a demo store: this is turned off here',
      messageAr: 'ده متجر تجريبي — الخاصية دي مقفولة هنا',
    });
  }
}
```

Call sites: `auth.routes.ts` register — `if (data.storeId) await assertNotDemoStore(data.storeId);` before `AuthService.register`; `/newsletter/subscribe` and `/contact` — `await assertNotDemoStore(await getStoreIdFromRequest(req));` as the first statement after schema parse (if `/contact` does not resolve a store today, resolve it the same way `/reviews/submit` does; a request with no resolvable store keeps today's behaviour).

Web side: the newsletter form and contact page show the API's Arabic/English message on 403 (they already surface API errors; verify by reading `NewsletterSection.tsx` and `app/contact`). Register page likewise.

`DemoLookBar.tsx` (B1-11, B1-12): two `<select>`s — template (only templates with ≥ 1 built look), then that template's built looks; changing the template selects its first built look. Add:

```tsx
useEffect(() => {
  if (!activeLook) return;
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    const url = new URL(a.href, window.location.href);
    if (url.origin !== window.location.origin || url.searchParams.get('look') === activeLook)
      return;
    url.searchParams.set('look', activeLook);
    e.preventDefault();
    window.location.assign(url.pathname + url.search + url.hash);
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}, [activeLook]);
```

Update `DemoLookBar.test.tsx`: the two-select behaviour; "a same-origin link click carries ?look"; "an external link / new-tab / modified click is untouched"; and replace "with the real registry (all designed in this phase) it renders nothing" with "with the real registry it lists exactly the built looks" (that case turns green in Task 10 when the flip lands; mark it `it.todo` here is NOT allowed — instead inject `isBuilt` for the three Qamar ids in this task and add the real-registry assertion in Task 10).

Noindex (B1-14): `robots.ts` — when the resolved store `isDemo`, return `{ rules: [{ userAgent: '*', disallow: '/' }] }` with no sitemap; `sitemap.ts` — return `[]` for `isDemo`; `storefront-metadata.ts` root `generateMetadata` — `robots: { index: false, follow: false }` for `isDemo`. Tests: add cases to the existing robots/sitemap/metadata unit tests (grep `robots.ts` in `tests/unit`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/web-demo-home.test.ts tests/unit/demo-order-guard-coverage.test.ts apps/web/src/components/demo/DemoLookBar.test.tsx tests/unit/web-demo-look.test.ts; echo "exit=$?"` → exit=0.
Run: `npm run test:integration -- tests/integration/demo-store.test.ts; echo "exit=$?"` → exit=0.
Run: `npm run test:defence-mutations; echo "exit=$?"` → exit=0 (if `assertOrderAllowed` is in the mutation record, add `assertNotDemoStore` to it per `docs/security/defence-mutation-record.md` and regenerate with the integration tier).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/demo-home.ts apps/web/src/app/HomePageBody.tsx apps/web/src/components/demo/DemoLookBar.tsx apps/web/src/components/demo/DemoLookBar.test.tsx apps/web/src/app/robots.ts apps/web/src/app/sitemap.ts apps/web/src/lib/storefront-metadata.ts apps/api/src/services/plan-limit.service.ts apps/api/src/routes/auth.routes.ts apps/api/src/routes/public.routes.ts tests/unit/web-demo-home.test.ts tests/unit/demo-order-guard-coverage.test.ts tests/integration/demo-store.test.ts docs/RULINGS.md
git commit -m "$(cat <<'EOF'
feat(storedemo): look mix at render, two-step bar, look kept across links, noindex, no pii

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

(Add any robots/sitemap/metadata test files and the mutation record if touched. Rulings B1-8, B1-11..14 appended.)

---

### Task 10: Scenario matrix, flip the three looks to `built`, picker, docs

**Files:**

- Create: `scripts/storedemo/scenario-stores.mjs` (local only)
- Create: `playwright.qamar.config.ts`, `tests/qamar/qamar-matrix.spec.ts`, `tests/qamar/qamar-demo.spec.ts`
- Modify: `packages/shared/src/looks/registry.ts` (3 × `status: 'built'`)
- Modify: `apps/admin/src/components/looks/LookPicker.tsx` (B1-19)
- Modify: `apps/web/src/components/demo/DemoLookBar.test.tsx` (real-registry case)
- Create: `docs/ebda/templates/qamar.md`; Modify: `docs/ebda/templates/looks.md`, `docs/ebda/templates/demo-store.md`, `docs/RULINGS.md`, `docs/ENVIRONMENT.md` (`QAMAR_DEMO_ASSET_BASE`), `CLAUDE.md` only if a rule changed (it does not: no new card path)
- Test: `tests/unit/looks-built-qamar.test.ts`, `tests/unit/payment-step-card.test.tsx` (B1-20)

**Interfaces:**

- Consumes: everything above.
- Produces: `getLook('qamar.*').status === 'built'` (the showroom bar and `?look=` preview become live for Qamar).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/looks-built-qamar.test.ts
import { describe, it, expect } from 'vitest';
import { LOOKS } from '@ebda/shared';
describe('B1 flips exactly the three Qamar looks to built', () => {
  it('qamar built, everything else designed', () => {
    for (const l of LOOKS)
      expect(l.status, l.id).toBe(l.template === 'qamar' ? 'built' : 'designed');
  });
  it('every built look has a skin of its own template and a section mix', () => {
    for (const l of LOOKS.filter(l => l.status === 'built')) {
      expect(l.skin).toBe(l.template);
      expect(l.sections?.length).toBeGreaterThan(0);
      expect(l.chrome).toBeDefined();
    }
  });
});
```

`DemoLookBar.test.tsx`: `it('with the real registry it lists exactly the three Qamar looks')`.
`LookPicker` test (create `apps/admin/src/components/looks/LookPicker.test.tsx` if none exists): `value={null}` → the active tab is `qamar`.
`tests/unit/payment-step-card.test.tsx` (follow the harness of the existing `apps/web/src/app/checkout/PaymentStep.demo.test.tsx`): render `PaymentStep` with a mocked config that enables card + COD on a store whose `look = 'qamar.lookbook'`; assert both methods render, the card label is the Arabic one in `ar`, and nothing under 12px (`/text-\[\d+px\]/` absent).

`tests/qamar/qamar-matrix.spec.ts` (Playwright; copy the `open()` helper and axe injection from `tests/dahab/dahab-storefront.spec.ts`):

```ts
const LOOK_STORES = ['qamar-atelier', 'qamar-lookbook', 'qamar-vitrine'];
const PAGES = [
  '/',
  '/products',
  '/products?category=abayas',
  '/products/linen-abaya',
  '/products/modal-scarf-no-image',
  '/cart',
  '/checkout',
  '/search?q=عباية',
  '/account',
  '/account/orders',
  '/size-guide',
  '/this-page-does-not-exist',
];
// scenario stores from scripts/storedemo/scenario-stores.mjs: qamar-empty (0 products), qamar-one (1),
// qamar-500 (500 products, generated names/prices, every 5th without image), qamar-edge (wide logo,
// tall logo, no logo variants as qamar-edge-wide/-tall/-nologo; Arabic-Indic numerals ON; merchant
// primaryColor override to the extreme '0 0% 98%' and '60 100% 50%'; COD only).
for (const store of [
  ...LOOK_STORES,
  'qamar-empty',
  'qamar-one',
  'qamar-500',
  'qamar-edge-wide',
  'qamar-edge-tall',
  'qamar-edge-nologo',
])
  for (const lang of ['ar', 'en'] as const)
    for (const p of PAGES)
      test(`${store} ${lang} ${p}`, async ({ page }) => {
        const res = await open(page, store, lang, p);
        expect(res.status(), p).toBe(p.includes('does-not-exist') ? 404 : 200);
        await expect(page.locator('html')).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
        ).toBeLessThanOrEqual(0);
        await expect(page.locator('header')).toHaveCount(1);
        await expect(page.locator('main')).toHaveCount(1);
        await expect(page.locator('footer')).toHaveCount(1);
        const tiny = await page.evaluate(
          () =>
            [...document.querySelectorAll('body *')].filter(
              e =>
                e.childNodes.length &&
                [...e.childNodes].some(n => n.nodeType === 3 && n.textContent!.trim()) &&
                parseFloat(getComputedStyle(e).fontSize) < 12
            ).length
        );
        expect(tiny, 'text under 12px').toBe(0);
        const axe = await runAxe(page);
        expect(axe.filter(v => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
      });

test('reduced motion: nothing animates', async ({ page }) => {
  /* emulateMedia({ reducedMotion: 'reduce' }) on each look home; after 400 ms, document.getAnimations().filter(a => a.playState === 'running') is [] */
});
test('zoom 200%: 640px CSS width has no horizontal scroll on every look home + PDP', async ({
  page,
}) => {
  /* setViewportSize 640x900 */
});
test('keyboard only: Tab reaches the skip link, the header nav, the first product and add-to-cart with a visible focus ring', async ({
  page,
}) => {
  /* press Tab, read document.activeElement + outline */
});
test('slow 3G: each look home loads and its LCP element is the hero image', async ({ page }) => {
  /* CDP Network.emulateNetworkConditions { latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 };
     PerformanceObserver('largest-contentful-paint') → element is an <img> inside [data-section="hero"]; CLS < 0.1 */
});
test('variants, OOS, backorder, sale, personalisation, size chart, delivery chip, video', async ({
  page,
}) => {
  /* on /products/linen-abaya: struck Rose/M/56; size-guide dialog opens; delivery chip text matches /يوصلك|Arrives/;
     /products/evening-gown-rose shows backorder CTA; sale product shows crossed price; home hero <video> present
     without reduced motion and absent with it */
});
```

The four `test(...)` bodies above must be written out in full by the implementer with the exact calls named in their comments — they are specified, not optional.

`tests/qamar/qamar-demo.spec.ts`: on `storedemo`: the bar shows "متجر تجريبي · Demo store", template select = قمر, look select has 3 options; choose Lookbook → URL has `?look=qamar.lookbook`, `[data-presentation="collage"]` visible; click the first product link → URL keeps `look=qamar.lookbook`; `body[data-look="qamar.lookbook"]`; response `cache-control` contains `no-store`; go to checkout → `[data-demo-checkout-notice]` visible and the API `POST /public/orders` (call it from the page with fetch) returns 403 `DEMO_STORE`; `/robots.txt` contains `Disallow: /`; `<meta name="robots" content="noindex, nofollow">` present.

`playwright.qamar.config.ts`: copy `playwright.dahab.config.ts`; `testDir: './tests/qamar'`; base from `QAMAR_BASE_URL` (default `http://localhost:3100`), projects `phone-390` (390×844), `tablet-820` (820×1180), `desktop-1280` (1280×800); the spec builds hosts as `http://<store>.localhost:3100`.

- [ ] **Step 2: Run unit tests to verify they fail**

Run: `npx vitest run tests/unit/looks-built-qamar.test.ts apps/web/src/components/demo/DemoLookBar.test.tsx; echo "exit=$?"` → FAIL (status still `designed`).

- [ ] **Step 3: Implement**

- `scenario-stores.mjs` (refuses non-loopback unconditionally; no `--yes-production` path): creates the scenario stores listed in the spec comment, each with look applied via `StoreService.applyLook(…, { design: 'reset' })`; `qamar-500` generates 500 products named `منتج تجريبي رقم N` / `Sample product N` in one `createMany` per 100; the edge stores set `stores.theme.primaryColor` to the extreme values (merchant override path) and `settings.arabicNumerals = true` (use the real setting key; grep `NUMERALS-1` in `docs/RULINGS.md`).
- Registry: `status: 'built'` on the three Qamar entries.
- `LookPicker.tsx`: initial tab `getLook(value)?.template ?? LOOK_TEMPLATES.find(t => looksForTemplate(t).some(l => l.status === 'built')) ?? LOOK_TEMPLATES[0]!`.
- Docs:
  - `docs/ebda/templates/qamar.md` — per look: scene sentence, colour strategy, token table with measured contrast ratios (from Task 4/8 tests), type pair AR + Latin, the bold idea, section mix (from the registry), chrome, motion (B1-7), what was left out and why (B1-6, B1-21, B1-22); the skin's files; the demo catalogue and assets (B1-9, B1-10); tests and how to run the matrix; the review-round log (Ahmad's STOP 1 notes).
  - `looks.md` — Qamar rows `built`; replace "All 15 are `status: 'designed'` today" with the current counts; document `sections`, `chrome`, `LOOK_DESIGN_KEYS`, the `applyTemplateFamily(…, look)` contract, and that "Adding or changing a look" step 4 now also requires a section mix + chrome.
  - `demo-store.md` — the superset home + render-time mix (B1-8), two-step bar + link persistence (B1-11/12), PII refusals (B1-13), noindex (B1-14), assets + `QAMAR_DEMO_ASSET_BASE`, the production run procedure (Task 11) and that Phase S placeholder families are archived (B1-15).
  - `docs/ENVIRONMENT.md` — `QAMAR_DEMO_ASSET_BASE` (seed-time only, default `https://media.ebda.app/demo/qamar`, production run refuses anything else).
  - `docs/RULINGS.md` — verify B1-1..B1-23 are all present, in the form `Ruling B1-N — <decision>. <evidence>. Cost if wrong: <one sentence>.`, plus any P2 rulings from the critiques.

- [ ] **Step 4: Run everything**

```bash
npx vitest run tests/unit/looks-built-qamar.test.ts apps/web/src/components/demo/DemoLookBar.test.tsx tests/unit/payment-step-card.test.tsx; echo "exit=$?"
npm run typecheck; echo "exit=$?"
npm run lint; echo "exit=$?"
npm run test:unit; echo "exit=$?"
npm run test:integration; echo "exit=$?"
npm run format:check; echo "exit=$?"
DATABASE_URL=postgresql://ahmadsharaf@localhost:5432/ebda_b0_test node scripts/storedemo/scenario-stores.mjs; echo "exit=$?"
npx playwright test -c playwright.qamar.config.ts; echo "exit=$?"
```

All exit=0. Record pass counts per project (390/820/1280). Any failure is fixed in the owning task's files, not skipped.

Final taste pass: screenshots of all three looks × home/PLP/PDP/cart × 390 ar + 1280 en; impeccable `critique` + `audit` per look; `accessibility-review` on one look's PDP; fix P0/P1.

- [ ] **Step 5: Blast-radius sweep**

```bash
git diff --name-only main...HEAD
grep -rn "'qamar'" apps packages scripts --include='*.ts' --include='*.tsx' --include='*.mjs' | grep -v node_modules | wc -l
grep -rn "Record<TemplateId" apps packages --include='*.ts' --include='*.tsx' | grep -v node_modules
grep -rn "presentation\b" packages/shared/src apps/web/src apps/admin/src --include='*.ts' --include='*.tsx' | grep -n "full-bleed\|framed" | grep -v collage
grep -rn "tileShape\|'chips'\|shop-the-look\|logoPlacement\|assertNotDemoStore\|QAMAR_DEMO_ASSET_BASE" apps packages scripts docs .github --include='*' -l | grep -v node_modules
```

For every hit of the `presentation` enum and `layout`/`tileShape`/testimonials enums, confirm the admin editor (`apps/admin/src/app/stores/[id]/builder/**`) renders the new options from the registry (the settings panel is registry-driven; any hand-written select over these values must gain the new option). State the result in the report: `blast-radius: swept <ids> across code, admin, scripts, docs, CI → clean | found + fixed N`.

- [ ] **Step 6: Commit**

```bash
git add scripts/storedemo/scenario-stores.mjs playwright.qamar.config.ts tests/qamar/qamar-matrix.spec.ts tests/qamar/qamar-demo.spec.ts packages/shared/src/looks/registry.ts apps/admin/src/components/looks/LookPicker.tsx apps/web/src/components/demo/DemoLookBar.test.tsx tests/unit/looks-built-qamar.test.ts tests/unit/payment-step-card.test.tsx docs/ebda/templates/qamar.md docs/ebda/templates/looks.md docs/ebda/templates/demo-store.md docs/ENVIRONMENT.md docs/RULINGS.md
git commit -m "$(cat <<'EOF'
feat(looks): qamar atelier, lookbook and vitrine are built; scenario matrix and docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

(Add the LookPicker test file if created.) Then run the memory pipeline: `nohup ~/.claude/scripts/update-memory-pipeline.sh all > /dev/null 2>&1 & disown` and `graphify update .`.

---

### Task 11: PR, deploy, production seed — **STOP 2 and STOP 3** — and production verification

**Files:**

- Modify: `docs/ebda/templates/demo-store.md` (deploy log: date, commit, what was verified / not verified)
- Modify: `docs/ebda/templates/qamar.md` (same)

**Interfaces:**

- Consumes: the merged branch.
- Produces: `storedemo.ebda.app` live with the Qamar showroom; the evidence Task 12 depends on.

- [ ] **Step 1: Open the PR (no merge)**

`git push -u origin feat/b1-qamar` (the pre-push hook runs; never `--no-verify`), then `gh pr create` with a body listing: the finish line from the spec, the 23 rulings by id, the migration (`20261023000100_store_template_qamar`, additive), the gates with counts, the screenshots folder, and "Production steps after merge need Ahmad: API deploy (runs the migration), R2 upload, `--yes-production` seed". PR body ends with the Claude Code footer.

- [ ] **Step 2: STOP 2 — Ahmad approves the merge.** CI green is necessary, not sufficient.

- [ ] **Step 3: Deploy (after merge)**

`gh workflow run cf-api-deploy.yml` (runs `prisma migrate deploy`, applies the enum value). The web/admin/marketing workflows run on push to `main`. Wait for all of them:

```bash
gh run list --workflow cf-api-deploy.yml --limit 1
gh run list --workflow cf-web-deploy.yml --limit 1
gh run list --workflow cf-admin-deploy.yml --limit 1
```

Every run must be `completed success`; a `cancelled` run is a deploy that did not happen (re-dispatch it).

- [ ] **Step 4: STOP 3 — Ahmad runs (or explicitly approves running) the two production writes**

```bash
# 1) assets to production R2 (immutable, under demo/qamar/)
for f in scripts/qamar-demo/assets/*; do
  npx wrangler r2 object put "ebda-media/demo/qamar/$(basename "$f")" --file "$f" --remote \
    --cache-control "public, max-age=31536000, immutable"
done
# 2) the showroom seed (owner-role direct URL from the keychain; prints the plan first)
DATABASE_URL="$(security find-generic-password -a whisky11 -s ebda-OWNER_DATABASE_URL -w)" \
  npx tsx scripts/storedemo/seed.mjs --yes-production
```

(Confirm the exact keychain item name with Ahmad; the agent never reads it.)

- [ ] **Step 5: Verify against production (read-only) and report both halves**

```bash
curl -s https://api.ebda.app/health | jq '{commit, deploymentId}'          # commit == git rev-parse origin/main
curl -sI https://storedemo.ebda.app/ | grep -i 'x-robots-tag\|cache-control\|server'
curl -s https://storedemo.ebda.app/robots.txt                              # Disallow: /
curl -s -H 'Cookie: force-language=ar' https://storedemo.ebda.app/ | grep -o 'data-look="[^"]*"\|data-pack="[^"]*"\|noindex'
for l in qamar.atelier qamar.lookbook qamar.vitrine; do
  curl -s -D - -o /tmp/sd-$l.html "https://storedemo.ebda.app/?look=$l" | grep -i cache-control
  grep -o 'data-look="[^"]*"\|data-presentation="[^"]*"\|data-tile-shape="[^"]*"' /tmp/sd-$l.html | sort -u
done
curl -s -o /dev/null -w '%{http_code}\n' https://media.ebda.app/demo/qamar/hero.mp4   # 200
curl -s -X POST https://api.ebda.app/api/v1/public/orders -H 'Content-Type: application/json' \
  -H "X-Store-ID: <storedemo id from the seed output>" -d '{}' | jq '.error.code'      # "DEMO_STORE"
```

Then in a real browser at 390×844, Arabic (Chrome via the claude-in-chrome tools, or Playwright against production with `QAMAR_BASE_URL=https://storedemo.ebda.app npx playwright test -c playwright.qamar.config.ts tests/qamar/qamar-demo.spec.ts`): the bar, switching all three looks, clicking into a PDP keeps the look, the swatch crossfade, the size guide, the sticky bar, the checkout notice. Neon read-only SQL (`neonctl connection-string … | psql`, SELECT only): `select count(*) from orders o join stores s on s.id = o.store_id where s.slug = 'storedemo';` → 0; `select enum_range(null::"StoreTemplate");` contains `qamar`.

Report two lists in the PR and in `demo-store.md`'s deploy log: **VERIFIED** (each item with its evidence line) and **NOT VERIFIED** with why (expected: real iPhone Safari low-power hero video, the Cloudflare zone cache rule bypass for `look=` (dashboard only, `demo-store.md` "Edge cache caveat"), real Android mid-range scroll performance). Run the memory pipeline.

- [ ] **Step 6: Commit the deploy log** (on a docs follow-up branch from `main` via `~/.claude/scripts/new-task-worktree.sh ebda-store docs/b1-deploy-log`, since `feat/b1-qamar` is merged)

```bash
git add docs/ebda/templates/demo-store.md docs/ebda/templates/qamar.md
git commit -m "$(cat <<'EOF'
docs(storedemo): b1 production verification log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

---

### Task 12: MKT-15 marketing section + `SHOW_DEMO_STORE_LINK` on — second PR, **STOP 4**

Starts only when Task 11 Step 5's VERIFIED list includes "storedemo home renders in Arabic at 390 with all three looks switchable" and "order refused". Worktree: `~/.claude/scripts/new-task-worktree.sh ebda-store feat/b1-mkt15-demo-link`.

**Files:**

- Modify: `apps/marketing/src/lib/site.ts` (`SECTION_ORDER` gains `'demo'` after `'looks'`; `DEMO_STORE_URL`)
- Modify: `apps/marketing/src/lib/content.ts` (ar + en `demo` copy)
- Modify: `apps/marketing/src/components/Home.tsx` (`demo` renderer)
- Modify: `apps/marketing/src/app/**/llms.txt` source if it lists sections (grep `SECTION_ORDER` and `llms`)
- Modify: `.github/workflows/cf-web-deploy.yml:81` (`--var SHOW_DEMO_STORE_LINK:…`)
- Modify: `docs/ENVIRONMENT.md:152`, `docs/DEPLOYMENT.md:174`, `docs/plans/done/2026-10-14-marketing-levelup.md` (MKT-15 as built), `docs/RULINGS.md` (B1-18 evidence: link went live on <date>)
- Test: `tests/unit/marketing-site.test.tsx`, `tests/unit/cf-web-deploy-vars.test.ts`

**Interfaces:**

- Consumes: `BRAND.domains.storeSuffix`, `unknownHostLinks()` (unchanged).
- Produces: section `#demo` on ebda.app (ar + en) linking to `https://storedemo.ebda.app/?look=qamar.atelier`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/marketing-site.test.tsx`, update the MKT-14 order expectation to `['story', 'looks', 'demo', 'model3d', 'payments', 'features', 'pricing', 'faq', 'start']` and add:

```tsx
it('MKT-15: a demo section after the looks links to the live demo store, in both languages', () => {
  for (const [locale, title] of [
    ['ar', 'جرّب المتجر التجريبي بنفسك'],
    ['en', 'Try the demo store yourself'],
  ] as const) {
    const html = renderHome(locale); // the file's existing helper
    const s = html.match(/<section id="demo".*?<\/section>/s)![0];
    expect(s).toContain(title);
    expect(s).toContain('href="https://storedemo.ebda.app/?look=qamar.atelier"');
    expect(s).not.toContain('target="_blank"');
  }
});
```

```ts
// tests/unit/cf-web-deploy-vars.test.ts
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
it('web deploy passes SHOW_DEMO_STORE_LINK from the repo variable, default false (Ruling B1-18)', () => {
  const y = readFileSync('.github/workflows/cf-web-deploy.yml', 'utf8');
  expect(y).toContain(`--var "SHOW_DEMO_STORE_LINK:\${{ vars.SHOW_DEMO_STORE_LINK || 'false' }}"`);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/marketing-site.test.tsx tests/unit/cf-web-deploy-vars.test.ts; echo "exit=$?"` → FAIL.

- [ ] **Step 3: Implement**

`site.ts`: `'demo'` after `'looks'` in `SECTION_ORDER`; `export const DEMO_STORE_URL = \`https://storedemo${BRAND.domains.storeSuffix}/?look=qamar.atelier\`;` (`NAV_ANCHORS` unchanged).

`content.ts` ar:

```ts
    demo: {
      title: 'جرّب المتجر التجريبي بنفسك',
      lead: 'متجر حقيقي على إبدأ بكتالوج أزياء توضيحي. غيّر القالب والشكل من الشريط اللي فوق، وافتح أي منتج، وجرّب السلة. الطلب مقفول، فمحدش هيتحاسب.',
      cta: 'افتح المتجر التجريبي',
    },
```

en:

```ts
    demo: {
      title: 'Try the demo store yourself',
      lead: 'A real Ebda store with an illustrative fashion catalogue. Switch the template and look from the bar at the top, open any product, try the cart. Ordering is closed, so nobody gets charged.',
      cta: 'Open the demo store',
    },
```

`Home.tsx` renderer:

```tsx
    demo: () => (
      <Section id="demo" title={c.demo.title} className="demo">
        <p className="lead">{c.demo.lead}</p>
        <p className="actions">
          <a href={DEMO_STORE_URL} className="btn btn-primary btn-lg">{c.demo.cta}</a>
        </p>
      </Section>
    ),
```

`cf-web-deploy.yml:81`:

```yaml
if [ -n "$SENTRY_DSN" ]; then npx wrangler deploy --var "SENTRY_DSN:$SENTRY_DSN" --var "SHOW_DEMO_STORE_LINK:${{ vars.SHOW_DEMO_STORE_LINK || 'false' }}"; else npx wrangler deploy --var "SHOW_DEMO_STORE_LINK:${{ vars.SHOW_DEMO_STORE_LINK || 'false' }}"; fi
```

Docs: `ENVIRONMENT.md` — the flag is now a repo variable threaded by `cf-web-deploy.yml` (dashboard vars are wiped by the regenerated `wrangler.jsonc`); `DEPLOYMENT.md` same; marketing plan — "MKT-15 as built"; RULINGS — B1-18 evidence.

- [ ] **Step 4: Gates, then commit and PR**

```bash
npx vitest run tests/unit/marketing-site.test.tsx tests/unit/cf-web-deploy-vars.test.ts tests/unit/marketing-seo.test.ts tests/unit/unknown-store-not-found.test.tsx; echo "exit=$?"
npm run typecheck; echo "exit=$?"
node apps/marketing/scripts/check-links.mjs; echo "exit=$?"
git add apps/marketing/src/lib/site.ts apps/marketing/src/lib/content.ts apps/marketing/src/components/Home.tsx .github/workflows/cf-web-deploy.yml docs/ENVIRONMENT.md docs/DEPLOYMENT.md docs/plans/done/2026-10-14-marketing-levelup.md docs/RULINGS.md tests/unit/marketing-site.test.tsx tests/unit/cf-web-deploy-vars.test.ts
git commit -m "$(cat <<'EOF'
feat(marketing): mkt-15 demo store section and the 404 demo link flag via repo variable

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GeHFETcBQ3jaGrN6Q6L6W5
EOF
)"
```

(Add the llms source file if it changed.) Push, open the PR, Ahmad approves the merge.

- [ ] **Step 5: STOP 4 — Ahmad sets the repo variable and redeploys web**

`gh variable set SHOW_DEMO_STORE_LINK --body true --repo <owner>/ebda-store` then `gh workflow run cf-web-deploy.yml` (or the merge's own push run, if the variable was set before it).

- [ ] **Step 6: Verify in production**

```bash
curl -s https://ebda.app/ | grep -o 'id="demo"\|جرّب المتجر التجريبي بنفسك\|storedemo.ebda.app/?look=qamar.atelier'
curl -s https://ebda.app/en | grep -o 'Try the demo store yourself'
curl -s -o /tmp/nf.html -w '%{http_code}\n' https://this-store-does-not-exist-b1.ebda.app/   # 404
grep -o 'https://storedemo.ebda.app' /tmp/nf.html                                          # present
curl -s -o /dev/null -w '%{http_code}\n' https://storedemo.ebda.app/                        # 200
```

Report VERIFIED / NOT VERIFIED (e.g. the 404 link only proven on one unknown host; the marketing section seen at 390 in Arabic only if a browser was driven). Update `demo-store.md`'s deploy log, run the memory pipeline.

---

## Self-review (done while writing)

- **Spec coverage:** scope 1 → Tasks 1–5, 7, 8, 10 (tokens, type pairs already in the registry and loaded by `lookFontsHref`; motion B1-7; signature sections; contrast Tasks 4/8; taste gates Tasks 6–8, 10; matrix + 390/820/1280 × ar/en Task 10; flip Task 10). Scope 2 → Task 6 (catalogue, every B0 feature asserted, idempotent seed under `scripts/`, assets + R2 decision B1-9, video B1-10). Scope 3 → Tasks 9 + 11 (bar, non-persisting, checkout refused server-side by `assertOrderAllowed` + coverage test, noindex, abuse limits, reset = seed, `--yes-production` + STOP 3). Scope 4 → Task 12 (after verification, B1-18). Scope 5 → docs in Tasks 1, 6, 9, 10, 11, 12; rulings B1-1..23. Scope 6 → Task 11 Step 5 and Task 12 Step 6, both halves.
- **Program finish-line items not in B1 by design:** deleting the the old skins (program "Then"), Dahab's three looks (TPL-2), Phase E editor — untouched.
- **Type consistency:** `LookSectionSpec`, `LookChrome`, `LOOK_DESIGN_KEYS`, `applyTemplateFamily(current, family, look?)`, `demoHomeDefinition`, `assertNotDemoStore`, `assetBase`, `buildQamarHome` are defined once and used with the same names in later tasks.
