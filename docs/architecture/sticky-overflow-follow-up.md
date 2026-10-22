# Follow-up: `position: sticky` is inert storefront-wide

Found in Phase B4 (Ruling B4-18), measured in Chrome 156 on a production build.

`<html>` carries `overflow-x: hidden` (`globals.css`) and `<body>` carries `overflow-x-hidden` (`layout.tsx`). A non-visible overflow on one axis computes the other to `auto`, so `<body>` becomes a scroll container that never scrolls; every `position: sticky` descendant sticks to it instead of the viewport and scrolls away with the page. Affected by design intent: the template headers (`sticky top-0`), the merchant "Sticky header" wrapper, the PDP gallery, the cart summary, the checkout order summary, the filter rail.

Contained today: pages of the Lamma skin that mount the menu tab strip get `overflow-x: clip` (it clips without creating a scroll container); nothing else changed.

The fix is `overflow-x: clip` on html and body everywhere (plus checking `ScrollToTop`, which resets body/html scroll for the old behaviour). It starts every sticky element on every template at once, so it needs its own PR with a pass over each template's header, PDP, cart and checkout at phone and desktop widths, and a re-run of the focus-not-obscured walk (`tests/souq/souq-focus-visible.spec.ts`, `tests/lamma/lamma-fixwave1.spec.ts`).

## Resolved (2026-10-23, launch polish PR 0)

`html` and `body` now use `overflow-x: clip` where supported (`@supports (overflow: clip)` in `globals.css`; Safari < 16 keeps `hidden`), and the body class list no longer carries `overflow-x-hidden`. The Lamma-only `clip` rule is gone (redundant). The products filter rail's `sticky` moved from an inner div to the bordered `aside` (the aside's `overflow-hidden` had made the inner sticky a no-op) and the aside scrolls inside `100dvh` so a tall rail stays reachable. Measured on the live Qamar demo through a local dev server: with the fix the rail sits at `top: 16px` after a 700px scroll; with `hidden` forced back it scrolls away (`-425px`). `ScrollToTop` is kept (still resets the old scroller on Safari < 16).
