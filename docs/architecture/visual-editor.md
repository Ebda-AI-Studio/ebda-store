# Visual editor (canvas-first)

Plan: `docs/plans/2026-10-22-visual-editor.md`. Rulings: `docs/RULINGS.md` § VE-*.
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

| Direction | Type | Payload | Since |
| --- | --- | --- | --- |
| parent to child | `render` | `definition` | v1 |
| parent to child | `select` | `sectionId \| null`, `blockId?` | v1 |
| child to parent | `ready` | none | v1 |
| child to parent | `select` | `sectionId`, `blockId?` | v1 |
| child to parent | `hover` | `sectionId \| null`, `blockId?` | v1 |
| child to parent | `patch-text` | `sectionId`, `blockId?`, `key`, `value` (max 2048) | v1 |

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

Not yet marked (listed for the editor matrix): skin-owned text under
`apps/web/src/templates/<skin>/` and the legacy `trustStrip` items.
