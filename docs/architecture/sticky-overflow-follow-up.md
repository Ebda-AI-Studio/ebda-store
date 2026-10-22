# Follow-up: `position: sticky` is inert storefront-wide

Found in Phase B4 (Ruling B4-18), measured in Chrome 156 on a production build.

`<html>` carries `overflow-x: hidden` (`globals.css`) and `<body>` carries `overflow-x-hidden` (`layout.tsx`). A non-visible overflow on one axis computes the other to `auto`, so `<body>` becomes a scroll container that never scrolls; every `position: sticky` descendant sticks to it instead of the viewport and scrolls away with the page. Affected by design intent: the template headers (`sticky top-0`), the merchant "Sticky header" wrapper, the PDP gallery, the cart summary, the checkout order summary, the filter rail.

Contained today: pages of the Lamma skin that mount the menu tab strip get `overflow-x: clip` (it clips without creating a scroll container); nothing else changed.

The fix is `overflow-x: clip` on html and body everywhere (plus checking `ScrollToTop`, which resets body/html scroll for the old behaviour). It starts every sticky element on every template at once, so it needs its own PR with a pass over each template's header, PDP, cart and checkout at phone and desktop widths, and a re-run of the focus-not-obscured walk (`tests/souq/souq-focus-visible.spec.ts`, `tests/lamma/lamma-fixwave1.spec.ts`).
