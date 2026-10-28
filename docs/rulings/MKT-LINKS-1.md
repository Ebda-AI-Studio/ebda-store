# MKT-LINKS-1

> Section: 2026-10-22 — Phase B4 Lamma (B4-\*)

Ruling MKT-LINKS-1 — every marketing link that leaves ebda.app (store.ebda.app, demo stores, orders, wa.me, third parties) goes through `SiteLink` (`apps/marketing/src/components/SiteLink.tsx`), which decides by host and renders `target="_blank" rel="noopener noreferrer"` plus a hidden "(opens in a new tab)" note; ebda.app paths and anchors stay same-tab; mailto/tel are not tabs. `tests/unit/marketing-home-flow-and-links.test.tsx` scans the rendered home, /features and /compare pages and the source for a raw external `<a>`. Cost if wrong: a new external link added as a raw `<a>` fails that test; fix it by using `SiteLink`.
