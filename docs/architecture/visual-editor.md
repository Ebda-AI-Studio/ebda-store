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
design keys, and the form page builder's write surface read from its source
(`classic-manifest.ts`). A control is `wired` only when two independent sources
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
fixed; accepting a new gap is a deliberate edit with a reason.
`tests/unit/visual-editor-parity.test.ts` is the gate for deleting `/page-builder`
(Ruling VE-6): every classic capability P-01 to P-14 is accounted for, wired fields
round-trip through the builder reducer to the same layout the form writes, and the
lists of live theme/typography writes and of files that still mention the classic
builder (`parity-baseline.json`) can only shrink. Task 12 requires them empty.

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
