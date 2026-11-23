# Visual editor (canvas-first)

Plan: `docs/plans/2026-10-22-visual-editor.md`. Rulings: `docs/RULINGS.md` § VE-\*.
The editor at `/stores/[id]/builder` is a Shopify-style editor: the real
storefront in an iframe is the main surface, and the panes serve it.

## Protocol `ebda-builder:v1` (`packages/shared/src/builder/editor/protocol.ts`)

Both sides accept a message only when `event.origin` matches the expected peer,
`event.source` is the peer window, and the payload parses (Zod, `.strict()`).
The parent posts only to the storefront origin it framed; the child posts only
to an origin in `allowedParentOrigins()` (the same list as CSP
`frame-ancestors`). No `*` target. Child to parent messages are INTENTS (VE-2):
ids and keys only, never URLs, HTML or free data. The parent re-validates each
against the current document and the registry (`canvas-intents.ts`), then
dispatches one `DocumentAction`.

| Direction       | Type            | Payload                                                                     | Since |
| --------------- | --------------- | --------------------------------------------------------------------------- | ----- |
| parent to child | `render`        | `definition`                                                                | v1    |
| parent to child | `select`        | `sectionId \| null`, `blockId?`                                             | v1    |
| parent to child | `focus`         | `sectionId`, `blockId?` (keyboard focus onto the target's first element)    | v1    |
| child to parent | `focus-tree`    | none (Esc in the canvas: focus returns to the tree)                         | v1    |
| child to parent | `ready`         | none                                                                        | v1    |
| child to parent | `select`        | `sectionId`, `blockId?`                                                     | v1    |
| child to parent | `hover`         | `sectionId \| null`, `blockId?`                                             | v1    |
| child to parent | `patch-text`    | `sectionId`, `blockId?`, `key`, `value` (max 2048)                          | v1    |
| child to parent | `section-op`    | `sectionId`, `blockId?`, `op` in moveUp, moveDown, duplicate, hide, remove  | v1    |
| child to parent | `move`          | `sectionId`, `blockId?`, `toIndex` (0..50): the final index in its own list | v1    |
| child to parent | `request-add`   | `list` in header, template, footer; `index` (0..40)                         | v1    |
| child to parent | `request-media` | `sectionId`, `blockId?`, `key` (names a target; never a URL)                | v1    |

Rule: a new message type needs a strict schema here and a row in this table.

## Marker contract (editor mode only, public markup unchanged)

- `data-builder-id="<sectionId>"` on a `display: contents` wrapper around each
  template section (`PageRenderer` `mark()`).
- `data-builder-block="<blockId>"` on a block's element, inside its section:
  hero slides (`HeroSlider` / `HeroBanner` via the `builderBlockId` prop),
  steps, looks, trust badges, collection tiles. It counts only inside the
  section that owns it.
- `data-builder-setting="<key>"` on a merchant text node. The key must be a
  `text` / `textarea` setting of that very section or block
  (`canvas-targets.ts`, derived from the registry). A text with no marker
  falls back to an exact, unique value match, otherwise it is not editable.
  The shared heading row (`SectionHeading`, `DahabSectionHeading`) sits below
  nine skins' category grids, carousels and review rows and cannot be handed
  `editorMode`, so it reads it from `EditorModeContext`
  (`builder/render/editor-mode.tsx`, provided by `PageRenderer` only in
  editor mode) and marks `title`, `kicker` and `subtitle` (`…Ar` in Arabic).
  A picture's alt text is not marked: it is written through the picture's own
  alt prompt (`ImageTarget.alt`).
- Header, announcement bar and footer are found by the storefront's
  `data-zone` wrappers (`header`, `beforeHeader`, `footer`) and resolved to the
  document's section of that type, so no skin carries an editor attribute.

## Selecting and editing text

A click selects the block, section, header or footer under the pointer, with a
name chip (registry `labelAr` / `labelEn` by admin locale). A click on text
inside the already-selected target edits it in place (double-click always
does). The editable takes the FIELD's direction (`…Ar` is RTL) with
`unicode-bidi: plaintext`; Enter commits except during IME composition; Escape
cancels; Tab / Shift+Tab commit and move to the next / previous text; paste and
drop insert plain text. The value is read as the RAW characters
(`textContent`, with `<br>` and block wrappers turned back into newlines), never
`innerText`, which applies CSS `text-transform` and would store an uppercase
heading as `SUMMER SALE`; `text-transform` is switched off while editing and
restored after. Each field carries the save schema's own length limit (`max`,
read from the registry's Zod props: a step title is 80); typing and pasting stop
at it and the parent cuts the committed value there.

## Changing an image

`data-builder-image="<key>"` marks a picture (hero slide frame, image-text,
maker profile, look photo). The key is the setting ON SCREEN (`imageAr` in
Arabic when set, else `image`; `render/image-key.ts`). A selected target shows a
"change image" button on each of its pictures. The click sends `request-media`
with the target only. The parent re-checks that the key is an `image` setting
of that node (`mediaRequestFor`), opens `MediaPicker` (the store's own,
tenant-scoped media; recommended size from `IMAGE_STANDARDS` per template),
asks for the alt text (Arabic and English when the setting has an alt sibling),
and commits the picture and the description under one coalesce key, so undo
reverts both in one step.

## Toolbar, drag and "+"

A selected template section or block gets a toolbar on its top edge at the
inline-end (mirrors in Arabic): drag handle (sections only), move up, move down,
duplicate, hide, remove. All are real labelled buttons, so the toolbar is also
the keyboard path. Each posts one intent and the parent maps it to exactly one
reducer action (`canvas-intents.ts`: `section-op`, `move`); the reducer still
enforces group and cardinality and the editor toasts a refusal. Remove opens an
in-app `ConfirmDialog` first (never `window.confirm`) and is undoable. A drag
shows a ghost and a drop line at the nearest gap; the drop posts `move` with the
final index (`dropTargetFor`), or nothing when the section lands where it was.
Escape cancels. The "+" sits on every gap between visible template sections
(`insertionGaps`): the one near the pointer is revealed (150 ms, instant under
reduced motion), keyboard focus reveals its own, and touch devices always show
them. It posts `request-add`; the parent re-checks the list and index
(`addRequestFor`) and opens the section picker at that index. The header, the
announcement bar and the footer are chrome: no toolbar, edited in the panes.
`aiFill` (sections the AI supports only, see below) is the sixth op.

Not yet marked (listed for the editor matrix): skin-owned text under
`apps/web/src/templates/<skin>/` and the legacy `trustStrip` items.

## The editor control matrix and the parity ratchet

`npm run editor:matrix` regenerates `docs/ebda/templates/editor-matrix.{md,json}`
(`scripts/editor-audit/`). One row per skin and control: sections and blocks from
`SECTION_REGISTRY`, theme controls from `THEME_SETTINGS_SCHEMA`, the look mixes'
design keys, and the form page builder's write surface, frozen from its last source
(`classic-manifest.ts` + `classic-facts.json`). A control is `wired` only when two independent sources
agree: a reverse grep finds a reader on the skin, and the flip probe (`probe.tsx`)
renders the section through the real `PageRenderer` once per option value and sees
the HTML change. The probe seeds content a section needs (hero slides, collections,
looks), flips a control inside the context that shows it (`PROBE_CONTEXT`), and
checks that a merchant text or image carries an explicit canvas marker
(`marker-pending` when it does not). Theme, block and chrome controls cannot be
rendered alone, so they carry `static` evidence only. Statuses: `wired`, `no-op`,
`missing`, `marker-pending`, `classic-only`, `pending-template`.

`npm run editor:matrix:check` (CI) fails when the committed files are stale or a
not-wired row is not listed in `scripts/editor-audit/baseline.json` with a reason.
It is a ratchet: `npm run editor:matrix` only ever REMOVES baseline rows that were
fixed; accepting a new gap is a deliberate edit with a reason. Since Task 10 the
baseline is EMPTY and the matrix has no `no-op`, `missing` or `marker-pending` row
(`tests/unit/editor-matrix.test.ts` pins both).
`tests/unit/visual-editor-parity.test.ts` was the gate for deleting `/page-builder`
(Ruling VE-6) and now keeps the parity true: every classic capability P-01 to P-14 is
accounted for, wired fields round-trip through the builder reducer to the same layout the
form wrote, every theme key the form staged for `PUT /theme` is an editor theme setting
(item 6, the class Ruling VE-17 closed), no editor file writes the live theme, and nothing
under `apps/admin/src` names the classic builder (item 5, `parity-baseline.json` is empty).

## Retiring the form page builder (Task 12)

The 4,793-line `/stores/:id/page-builder` page (5,951 lines with its two components), `CategoryLayoutButtons`, `ModeButton`,
`lib/page-builder-save.ts` and `POST /admin/stores/:id/layout/preview` are deleted.
`/page-builder`, `/hero`, `/navigation` and `/pages` are server redirects to `/builder`
(`lib/builder-redirect.ts`) that keep the Ruling VE-16 deep link (`select`, `block`, `field`,
`page`) and drop any other param. `hubs.ts` lists ONE editor tab (`hubTabs.editor`) and keeps
`/page-builder` in `urlPrefixes` so a redirected visit still highlights the Catalog hub.
The admin CSP gives the preview frame-src to `/stores/:id/builder` only.

The classic form's write surface is frozen in `scripts/editor-audit/classic-facts.json`
(extracted by `extractClassicFacts` from the last source), so the manifest and matrix still
check it without the page. Its five product-card theme switches (`showBrandBadge`,
`showNewBadge`, `showQuickAdd`, `normalizeProductImages`, `saleBadgeLegacyCorner`) are the
`cards` group of `THEME_SETTINGS_SCHEMA`: draft-carried like every theme key, never look-owned
(a look switch, keep or reset, leaves them), never written by Smart Palette, strict booleans
at `PUT /theme`, searchable (`builder.card-*`).

## Section design controls (Task 6)

The registry's `typography` and `dividers` settings render the form page builder's own blocks, shared
from `apps/admin/src/components/section-design/`: `SectionTypographyField` (per-role overrides with the
store's global zones as the inherit hint; the roles a section offers are in `typographyRolesFor`) and
`DividersField` (five slots, one shared style). They write the same `typography` / `dividers` objects
the layout stores, so there is no migration, and every edit is a draft edit. Padding, max width, kicker,
subtitle and title were already registry settings. `aiFill` (toolbar and a settings-panel button) asks
`POST /stores/:id/ai/section-content` for category-grid, new-arrivals, best-sellers, featured-collection
and testimonials, then dispatches only the EMPTY kicker/subtitle fields as ordinary `setSectionSetting`
edits under one coalesce key (`aiFillActions`): undo takes the whole fill back and the merchant's own
words are never overwritten. Colour scheme, density and text scale are page-type settings (Ruling VE-7),
not section settings.

## The theme pane is draft-only (Task 7, Ruling VE-4)

Fonts (`FontsField`, the page builder's `FontsCard`), global typography zones (`TypographyZonesField`, one
`ZoneEditor` per zone), Smart Palette (`applySmartPalette`, one undo step) and "reset to the look default" are
edits to the page document: `PageDefinition.typography` and `PageDefinition.theme` (a `null` value is a reset).
Nothing in the builder calls `PUT /theme` or `PUT /typography`; `visual-editor-parity.test.ts` and the builder e2e
(`liveWrites` in the mock API) both fail if it does. Publish promotes the patches (see
`docs/architecture/store-theme-flags.md`), and the editor re-opens the page afterwards so a stale patch is never
re-sent. A custom font FILE is uploaded to the store's R2 area immediately (like an image), but belongs to no
store's typography until the draft that references it is published.

Font URLs are tenant-checked: a custom font must be a file under this store's `stores/<id>/fonts/` namespace and a
Google font a `fonts.googleapis.com` stylesheet (`font-url-guard.ts`, enforced on every document write and on the
typography PUT), and the R2 delete refuses any key outside the current store (Ruling VE-11).

## Product, collection and cart pages are section documents (Task 8, Rulings VE-3, VE-12)

- **Page kinds** (`packages/shared/src/builder/page-kinds.ts`): `home` plus `product`, `collection`, `cart`. Each of the three has one document per store in `store_page_revisions` (`page_key` = the kind), with the same draft / publish / revisions / rollback as home.
- **Default = today's render, no migration.** A store with no saved document gets `defaultPageDocument(kind)` (`page-defaults.ts`): product = main, FAQ, reviews, bundles, recommendations, related; collection = main; cart = main, recommendations.
- **One pinned main section per page** (`product-main`, `collection-main`, `cart-main`; `pinned: true` in the registry). It can move; the reducer and the validator refuse to remove, hide or duplicate it. A section type only goes on the pages its registry `pages` lists (`sectionAllowedOnPage`); image-text, newsletter, trust-badges and maker-profile are shared by all four.
- **A section page holds sections only.** No header/footer group, theme, chrome, typography or page settings in the document (the validator says `PAGE_MISMATCH`); those stay on the home document.
- **API.** `GET/PUT/POST /admin/stores/:id/builder/pages/:kind/...` accept the four kinds. Publishing or rolling back a non-home page writes nothing to `stores.layout_settings` (that projection is the home page's) and only purges the caches. The storefront reads `GET /public/stores/:storeId/pages/:kind` (published or default; fetched with the `layout:<storeId>` tag, so the existing purge covers it). The canvas keeps using `builder-preview?token=` (the token already carries the page key).

## Page-type settings (Task 8e, Rulings VE-13, VE-14)

- With nothing selected, the right pane shows the page's own settings (`PageSettingsPanel`), generated from `PAGE_SETTINGS` (`packages/shared/src/builder/page-settings.ts`) with the same field components as a section: page background, colour scheme, spacing and text size per page, the product photo shape, reviews, the filter panel, image shapes, the phone bottom bar and the product card defaults. "Page settings" at the top of the structure list brings the panel back after selecting a section.
- Every change is `setSiteSetting { key, path, value }` on the draft (one nesting level, `undefined` clears). The reducer refuses a setting the page does not have (`UNKNOWN_SETTING`); the validator refuses a key the page does not own and checks values with `storeLayoutSchema`. The canvas paints the draft (`withPageSettings`), a public page reads the live layout.
- Who writes which key is in VE-13. Publishing product / collection / cart writes only their keys into `layout_settings`; publishing home keeps the live value of theirs. `defaultPageDocument(kind, liveLayout)` and `getPageState` open a page on the live values.
- `filterSidebar` and `sizing` are all-or-nothing in the layout schema: `GROUP_FLOORS` starts a missing `filterSidebar` at the baseline so one toggle is a valid object.

## Template-aware controls (Task 10, Rulings EP-1, EP-5)

A control the active template's renderers ignore is a lie, so the panel offers it only where it is read.

- **`shownFor`** on a setting (`packages/shared/src/builder/settings-schema.ts`): `{ templates?, looks?, variants? }`, or a list of them (any rule shows it). `variants` names the section's own settings (`layout: ['horizontal']`); `isShown(setting, { template, look, variant })` (`shown-for.ts`) is the one function the settings panel, the theme pane, the audit matrix and the tests all call, and `sectionVariants` answers `variant` from the document (desktop value, viewport overrides, then the preset default). Absent = shown everywhere. An unknown template or a legacy store (no look) matches no `templates` / `looks` rule and still gets every universal control.
- **Narrowed today:** category-row card Aspect, Show name and Hover (the scrolling row, plus Modern's grid card), tile Colours (`lamma.market` tiles, the only look with aisle colours), Category tabs (`layout: menu`), and the theme pane's Header group (logo position on Qamar, Souq, Jasmine and Lamma, search placement on Souq). The matrix judges a narrowed control only where it is shown, and `hiddenButWired()` fails the build if a rule hides a control the flip probe shows working on that skin; `tests/unit/shown-for.test.ts` also proves no rule hides a design key a built look's own mix sets.
- **Removed, key kept (EP-5):** `SectionDefinition.retired` lists keys the save schema still accepts and stored documents may carry, with no control: Width on the new-arrivals, best-sellers, product-carousel and testimonials rows and the hero (their renderers lay themselves out inside their own container), and the hero's Top / Bottom spacing (the hero wrapper never applied them; see the comment in `PageRenderer`). Nothing is migrated or deleted. `builder-page-definition.test.ts` requires every stored key to have a control or be listed in `retired`.
- **Wired instead of removed:** the brand-story Background (`BrandStoryBlock` never painted it; a store that had stored one now shows it).
- **Not visible in static HTML:** a timer (slideshow autoplay) and what the home page asks the API for (product limits, the reviews filter) are judged by a named reader (`BEHAVIOUR_READERS` in `gen-matrix.ts`: file plus the exact expression), so deleting the reader turns the row red.
- **Storefront order:** `flowOrder(template, look)` (`apps/admin/src/lib/builder-flow-order.ts`) is the home's section types in the order the storefront draws them, from the look's mix or the skin's default layout. The add-section picker lists those first, then everything else under one "more" heading; the theme pane starts with the Header group. `tests/unit/builder-flow-order.test.ts` checks it against what a look switch actually lays out for every built look.
- **Header chrome overrides:** see `docs/architecture/store-theme-flags.md` (Ruling EP-4).

## Keyboard path and performance budget (Task 13)

**Keyboard.** The tree is the outline. Enter on a tree row (section or block) selects it and sends `focus`; the canvas overlay lands focus on the first editable text of that target (`keyboard-logic.ts`, `EditorOverlay.tsx`). Inside the canvas Tab / Shift+Tab cycle the selected target's texts, then its "change image" buttons, then its toolbar buttons, and wrap (focus never leaves the cycle until Esc). Enter on a focused text starts the inline edit. Esc posts `focus-tree` and the editor focuses the selected row (opening the Structure drawer below `lg`); Esc while editing only cancels the edit. Alt+ArrowUp / ArrowDown ask for `section-op moveUp / moveDown` on the selection (a disabled direction asks nothing); the tree has the same shortcut on its rows. Below `lg` each pane drawer traps Tab, closes on Esc and gives focus back to the button that opened it (`_lib/use-drawer-a11y.ts`); a row that hands focus to the canvas closes the drawer first and focus is not pulled back. Toolbar glyphs show their text label from 768px (`md`) up inside the canvas and stay glyph-only below; the accessible name is always the full label. Every move, however made, is announced in the `builder-live` region (`_lib/announce-move.ts`, `builder.live.*` in ar and en; Egyptian Arabic: "اتنقل القسم ... لفوق"); so are a section added, removed, hidden or shown, and what Undo / Redo do to them (`describeStructure`; the text alternates a trailing no-break space so the same sentence twice in a row is read again). Screen-reader structure (real-stack pass 2026-10-23): one sr-only `h1` ("Store editor: <store>"), the tree groups are `h2` like the settings pane, the pane tabs and the Content / Design tabs are a real tab pattern (`aria-controls` to a `tabpanel`, one Tab stop, arrows move + activate and follow the reading direction, `_lib/roving.ts`; the preview-size radios use the same helper), the page's "skip to main content" link now has a target (`<main id="admin-main-content">` is the preview) plus a "skip to settings" button, every settings field is named after the FIELD and its language ("<field> - Arabic"; plain text, colour dropdown, category and product pickers, image buttons, media thumbnails), and a dialog the parent un-mounts hands focus back to its opener (`_lib/use-restore-focus.ts`; it used to land on `<body>`, which also silenced the drawer's Esc). Gate: `tests/editor-live-e2e/editor-sr.e2e.ts` (real stack) and `SettingsPanel.names.test.tsx` (every field of every section, both modes).

**Performance.**

- `Canvas.tsx` posts `render` through `createFrameCoalescer`: any number of edits inside one animation frame cost one structured clone of the latest document.
- Canvas-only transient state (the hovered section) lives in `_lib/canvas-hover-store.ts`, not in `BuilderEditor` state. Each tree row subscribes to "am I hovered" through `useSyncExternalStore`, so a hover re-renders the two rows whose highlight flips and never the editor. (The hover chip itself is canvas-side state in `EditorOverlay`, which is a sibling of the page content, not its parent.)
- A parsed `render` message has no object identity, so `BuilderPreviewShell` passes it through `shareStructure(prev, next)` (`@ebda/shared`): every section that did not change gets its previous object back. The document-only sections (`DocumentSectionBody` in `PageRenderer.tsx`) are `React.memo`'d on that identity, with a stable add-to-cart handler and a JSON-stable `layout`, so a text edit re-renders one such section. The legacy sections (hero, category grid, the two carousels, testimonials) still draw inside `PageRenderer` and re-render with it; that is the residual.
- Budgets live in `tests/builder-e2e/perf.e2e.ts` and print `PERF <name> <value>`: keystroke to canvas paint p95 below 100 ms (laptop, 1280) and below 250 ms (CPU 4x at 390); admin JS heap after 200 edits below 150 MB; editor interactive below 2.5 s on throttled Fast 4G (runs only with `PERF_INTERACTIVE_PROD=1` against `next start`). The canvas in that spec is the contract fake, so the paint number covers the admin side plus one frame, not the real storefront render.
- Tests: `tests/unit/builder-perf-share-structure.test.tsx`, `tests/unit/builder-overlay-keyboard.test.tsx`, `tests/unit/builder-protocol.test.ts`, and next to the code `Canvas.coalesce`, `SectionTree.keyboard`, `canvas-hover-store`, `use-drawer-a11y`, `announce-move`, `frame-coalescer`; `tests/builder-e2e/keyboard.e2e.ts` (focus round trip, drawer trap, axe on the editor chrome).

**The canvas is inert (2026-10-23).** While the storefront runs inside the builder (the overlay is mounted), NO storefront action runs. One layer, `apps/web/src/builder/preview/editor-inert.ts`, installed by `EditorOverlay`: capture-phase `click` / `auxclick` / `submit` / `change` on `document` stop before React's root listener (add to cart, quick add, wishlist, compare, cart drawer, newsletter, search, coupon, checkout, `router.push`, sort selects) and lose their default (navigation, submit, toggle); `fetch` with any method but GET / HEAD / OPTIONS is refused in the one place every storefront call goes through (409 `EDITOR_MODE`), `sendBeacon` and `window.open` do nothing. Exempt: the overlay's own controls (`EDITOR_OWN`), text being edited, native `<details>`. Decision: the storefront's own selection UI (variant swatches, tabs) is inert too, because its `onClick` cannot be told apart from "add to cart" without per-component knowledge; a new component is inert without knowing about the editor. Gates: `tests/unit/builder-editor-inert.test.tsx`; `tests/editor-live-e2e/editor-inert.e2e.ts` (`INERT_E2E=1`: every distinct interactive element of home, collection, product and cart of dahab-preview and the five showrooms, ar 390 touch and en 1280 mouse: no non-GET request from the canvas frame, canvas URL unchanged, no dialog, no `window.open`, Enter in a field submits nothing, autoplay does not take focus); `touch-second-tap.e2e.ts` covers the second tap on all four pages.

## Ask AI (Phase 5, AIPATCH-1) and who published (PUBLISH-WHO-1)

- **Patch format.** `aiPatchSchema` / `applyAiPatch` (`packages/shared/src/builder/ai-patch.ts`): at most 12 ops from `setSectionSetting`, `setBlockSetting`, `setSectionHidden`, `moveSection`, `removeSection`, `addSection`, `setTheme`. Scalar values only. `applyAiPatch` runs each op through `reduceDocument`, checks the key is declared by the section/block definition (or `${id}Ar` for a localized one) and the value fits the control, and returns `changes` (before/after with Arabic and English labels) plus `rejected` (index + reason). Unknown input is rejected, not coerced. The result still goes through `validateDefinitionSync`.
- **v2 (Ruling AIPATCH-2).** Six more ops: `addBlock`, `moveBlock`, `removeBlock`, `setRef` (image, link, category or product list, only from the store's own catalogue allow-list), `setViewportSetting`, `setViewportHidden`. Text, image and link settings are fill-only (`OVERWRITE_PROTECTED`). The request also carries the editor viewport and admin language; the prompt gets the store's name, template, look, categories and a bounded product sample (`builder-ai-context.service.ts`).
- **Flow.** The editor settles its draft, `POST /api/v1/stores/:id/ai/builder-patch { pageKey, instruction }` (store scope like the other AI writes; quota via `assertAiQuota`) returns `{ baseRev, ops, changes, rejected, candidate }`. The candidate renders in the same canvas (read-only, like the look preview) and the "Ask AI" tab lists the diff. Apply is `replaceDocument(candidate)` (one undo step) plus the normal draft autosave, so a stale page answers the usual 409 and the preview is dropped as soon as the draft moves. Nothing here publishes.
- **Prompt hygiene.** `BUILDER_PATCH_INSTRUCTION` (`ai.service.ts`) declares `merchantRequest` to be data; the page context comes from `describeAiPatchContext` (ids, declared keys, current scalars clipped to 80 chars; no catalogue rows, no buyer data).
- **History.** `GET .../revisions` returns `publishedBy` (user id), `publishedByName` (resolved at read time from the store's owner/staff; null = removed user) and `publishedAt`; the History tab shows "by <name> - <when>" and "Restored from version N". Restore is `POST .../rollback` (a NEW published revision; nothing is rewritten).
- **Cloudflare move.** Both features go through `saveDraft` / the revision writes only, so they ride the repo layer unchanged; the new column must be in the StoreDO schema (`published_by`; erasure class merchant-pii, pseudonymise); names are read live from the identity/staff data, never stored.
