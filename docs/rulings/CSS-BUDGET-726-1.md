# Ruling CSS-BUDGET-726-1 - marketing CSS split per route

**Date:** 2026-11-20

**Decision:** the 16 KB gzip CSS budget stays. `apps/marketing/src/app/globals.css` and `motifs.css` are split so a route loads only its own CSS: `route-home.css` (/), `route-store.css` (/store), `route-whatsapp.css` (/whatsapp), `route-store-wa.css` (plans, FAQ and teasers shared by /store, /whatsapp, /features), `route-devices.css` (phone art, 404 and /store), `route-notfound.css` (404). `about.css` and `contact.css` are imported by the components that use them, no longer by `RootShell`. The shared base stays in `globals.css`, `chrome.css`, `motifs.css`. Each route file keeps the original relative order of its blocks.

**Evidence:** #726 (design-system wave 3b) measured 16.26 KB on every page against the 16 KB budget (main 15.8 KB); gzip makes deduplication worthless and the token ratchet forbids undoing the token substitution. After the split the heaviest page, /store, is 14.9 KB and every other page is at most 9.8 KB. Computed style of every element on 16 pages at 390 and 1280 px is identical before and after the split (headless check, custom properties and dynamic counts excluded). `scripts/ci/marketing-css-route-coverage.mjs` (CI step next to the budget step) fails when a page's markup uses a class the source CSS defines but no stylesheet that page loads carries it.

**Rule going forward:** a new section of CSS that only one route uses goes in that route's `route-*.css`, imported by the route's component; the coverage script is the gate.

**Cost if wrong:** a route that renders a class from a state the static export never shows (script-toggled) could miss a rule that moved to another route file; the rule would then be unstyled on that route until the class is claimed. Styling only.
