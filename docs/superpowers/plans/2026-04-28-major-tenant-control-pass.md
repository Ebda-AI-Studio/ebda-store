# Major tenant-control + UX pass — 2026-04-28

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** lift Wady Aljuz storefront + admin to "real boutique e-commerce" by making every visible string + structural block tenant-editable, fixing 5 active bugs, wiring real social/whatsapp icons, and reorganizing R2 storage per-store.

**Tech Stack:** Express API (Railway, Prisma+Neon), Next.js admin (Vercel), Next.js storefront (Vercel), R2 storage (Cloudflare).

---

## Group A — Footer overhaul

Files: `apps/web/src/templates/{modern,classic,minimal,bold,elegant}/Footer.tsx`, `apps/web/src/templates/shared/icons.ts`, plus admin pages settings.

**A1.** Footer logo too small — bump from `h-9 max-h-9` → `h-14` (Modern) and similar per pack.

**A2.** Redundant Contact info — Contact column duplicates info that's also in the Contact section directly under brand. Pick one source per pack and ensure no duplication.

**A3.** Title weight — column headings (Shop / Company / Support / Contact / Follow) bold; link content normal weight.

**A4.** Real social media icons + WhatsApp icon. Replace inline SVG paths in `apps/web/src/templates/shared/icons.ts` with brand-correct paths from Simple Icons (free, attribution-free for public companies). Add WhatsApp icon and wire it to a `https://wa.me/<number>` link when `contact.whatsapp` is set.

**A5.** Address as Google Maps hyperlink — admin toggle: `store.settings.contact.addressLink = 'maps' | 'none'`. When `maps`, the address text wraps in `<a href="https://www.google.com/maps/search/?api=1&query=<encoded address>">`.

**A6.** Bottom bar editable — `© YEAR <store name>. All rights reserved.` + `Privacy / Terms / Shipping` links. Each link tenant-toggleable. Custom copyright text override.

---

## Group B — Pages CMS (About + Privacy + Terms + Shipping + custom)

Currently About is hardcoded fallback. Privacy/Terms/Shipping are not editable.

**B1.** New table: `store_pages` (id, store_id, slug, title, titleAr, contentMd, contentMdAr, isPublished, position, createdAt, updatedAt). Migration.

**B2.** Admin UI: `/stores/:id/pages` lists all pages, with built-in About/Privacy/Terms/Shipping shell rows. Each row → editor (textarea or simple markdown editor — no rich-text dep) for content + contentAr.

**B3.** Storefront: `/about`, `/privacy`, `/terms`, `/shipping` render `store_pages` content. Falls back to old hardcoded fallback only if the row is missing entirely (not just empty contentMd).

**B4.** "Blog-like" About — content is rendered through a tiny markdown renderer (`marked` or hand-written for headings, paragraphs, lists, links — no XSS, sanitize via `dompurify`). Header image from a single hero field.

---

## Group C — Pre-header utility bar editable

Currently Elegant + Classic packs render a top bar with "Contact / Wishlist" or similar. The merchant wants this admin-editable + toggleable.

**C1.** Add `store.settings.utilityBar` JSON: `{ enabled: boolean, links: [{ label, labelAr, href }] }`.

**C2.** Admin UI: section card under Layout admin or Settings → "Top utility bar" with on/off toggle + link editor.

**C3.** Storefront: each pack's Header reads `store.settings.utilityBar` and renders or hides accordingly.

---

## Group D — Search

**D1.** Admin product list search: `apps/api/src/services/product.service.ts::list` already does `OR: [name contains, description contains, sku contains]` — add `nameAr contains` and `descriptionAr contains`.

**D2.** Storefront search route + autocomplete:

- `apps/api/src/routes/public.routes.ts` search endpoint must match name + nameAr.
- New endpoint `/public/:storeId/search/suggest?q=...` returning top 8 products with name/nameAr/slug/image — debounced from the storefront header.
- `apps/web/src/components/SearchAutocomplete.tsx` already exists — wire it to the new suggest endpoint and fix locale-aware display.

---

## Group E — Add-to-cart toast

**E1.** Globalize toast in storefront: when `addItem` is called from anywhere (PLP card, product detail, etc.), show a toast with product name + "View cart" CTA.

- `apps/web/src/contexts/CartContext.tsx::addItem` should fire a toast via `useToast` from `@force/ui`.
- Verify `<ToastProvider>` is mounted at the root of the storefront (it's at admin already; check web).

---

## Group F — Variants by type (weight / package) + per-variant images

Current schema: `ProductVariant.options Json` — flexible. We need a clearer admin UX:

**F1.** Add `ProductVariant.unit: enum('weight', 'package', 'count', 'volume', 'other')` and `ProductVariant.unitValue: string?` (e.g. "500g", "1kg", "12 pieces"). Migration.

**F2.** Admin variant editor: type dropdown + unit value text. When `unit = 'weight'`, hint "e.g. 500g, 1kg".

**F3.** Per-variant image: `ProductVariant.imageUrl: string?` (already supported as part of options? confirm). Storefront product detail switches main image when a variant is selected.

---

## Group G — Active bugs

**G1.** 404 on `/api/v1/stores/<id>/products/e6663db5-...` — investigate. Likely a deleted product the admin still references. Check admin's product list ↔ admin's product detail page for stale links.

**G2.** Order placement error with random characters in address — check `apps/api/src/routes/order.routes.ts` and `apps/api/src/services/order.service.ts`. The shipping address Zod schema may be too strict. Validate that legitimate Arabic addresses with diacritics + special chars don't get rejected.

---

## Group H — OneSignal push notifications

**H1.** Verify `ONESIGNAL_APP_ID` + `ONESIGNAL_REST_API_KEY` env vars on Railway.

**H2.** End-to-end test: from a logged-in browser admin tab (after PWA install on mobile or with browser permission granted), trigger a test push.

**H3.** Wire the order-placed event to `OneSignalService.notifyAdminsOfOrder` (already wired but verify).

---

## Group I — Remove dashboard onboarding flow

User said "remove the flow thing we created from the last commits". Delete the `OnboardingChecklist` component import + render from `apps/admin/src/app/stores/[id]/page.tsx`. Keep the file in repo for future use but unmounted.

---

## Group J — R2 storage cleanup + per-store reorganization

**J1.** Inventory: list every object in `force-uploads` bucket, group by prefix.

**J2.** Identify orphans: any object whose URL is not referenced from `product_images.url`, `stores.logo`, `stores.favicon`, `stores.heroImage`, `stores.layoutSettings->slides[].image`, etc. Delete them.

**J3.** Reorganize: copy each surviving object from its current key (often `products/<uuid>` or `branding/<uuid>`) to `stores/<storeId>/<surface>/<uuid>` and update the DB row's URL. Source store-id by joining the object → product → product.store_id (or store directly for branding).

**J4.** Don't break live storefront during migration. Strategy: copy first, update DB, then delete old object only after a brief observation window.

This is a one-shot Node script (similar to the `apply.mjs` we already used). Don't run blindly — produce a plan + dry-run output first.

---

## Group K — Memory + commit traces

**K1.** Auto-memory updated with two new feedback files (FWB-CMS-control + rapid-multi-bug-rounds) — already done.

**K2.** Each group above ships as its own commit with a clear message. CI must stay green.

**K3.** Compaction-safety: this plan doc is the canonical reference. If the chat is compacted, the next session reads this file and continues from the unchecked items.

---

## Execution order

1. **I (remove onboarding)** — delete-only, ship synchronously, ~5 min.
2. **A (footer)** — agent in parallel.
3. **C (utility bar)** — agent in parallel.
4. **E (cart toast)** — agent in parallel.
5. **D (search)** — agent in parallel.
6. **G (bugs)** — agent in parallel.
7. After 1–6 land: **B (pages CMS)** — biggest, runs alone.
8. **F (variants by type)** — needs migration; runs after B clears.
9. **H (OneSignal)** — verify only; run end-of-pass.
10. **J (R2 cleanup)** — last, scripted, one-shot.

---

## Done criteria per group

Each group is "done" when:

- Type-check + lint clean across all touched workspaces.
- Vercel + Railway deployed.
- Manual verify (the merchant or me) that the stated bug or feature works.
- Committed with a message that names the group letter.
- CI green.

---

## Out of scope for this pass

- Multi-store customer auth (already shipped).
- Admin role redesign (already shipped).
- Storefront PWA (already shipped).
- Fonts swap (different ask, not raised here).
