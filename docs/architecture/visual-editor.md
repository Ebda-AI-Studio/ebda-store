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
drop insert plain text. The value is read from `innerText`.

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
`aiFill` joins the ops in Task 6.

Not yet marked (listed for the editor matrix): skin-owned text under
`apps/web/src/templates/<skin>/` and the legacy `trustStrip` items.
