# FWB Storefront + Ops Sprint — Plan

**Date:** 2026-06-22 · **Goal:** clear Ahmad's 19-item list, platform-wide, end-to-end, blast-radius-checked, with the AI OS (`os-watch`/dream) watching for regressions. Every change lands platform-wide (all 5 themes + 3 product render paths + EN/AR) per the project's platform-level rule. Each batch = its own PR.

This is a multi-session program. Batches are ordered by value × boundedness.

---

## Batch 1 — Storefront bugs (bounded, highest user-impact)

1. **Search suggestions broken on pecannbee (works on wadyaljuz)** — diagnose why store-specific (likely a per-store data/config/index gap, not code). Fix platform-wide.
2. **Cart: duplicate identical lines → merge into one line with quantity; show the variant/size on each cart line** (screenshot: same product twice, no size, should be 1×qty 2). Root cause: cart line-key probably uses a unique id instead of (productId+variantId); the merge + the variant-label render are the fix.
3. **Shipping page (mobile): "Continue to payment" button must be at the END** — currently after the address, before discount + summary. Reorder so it's last on mobile.
4. **Cart "Continue shopping" → return to the last category/section** the shopper was in (store last-visited listing in session/localStorage, namespaced per store).
5. **New supplier saved but doesn't show up** (admin) — diagnose the create→list gap (RLS/refetch/filter).

## Batch 2 — Storefront card + image controls (the big customization features)

6. **Product card: hide price when the product has variants; show price for a single no-variant product** — plus make it a per-store toggle ("show price on cards").
7. **Category card unit label** "4 قطعة" — make "قطعة" a configurable per-store label (count-unit string, EN/AR).
8. **Per-surface image aspect-ratio + corner-radius control** (PDP, Categories, Product cards everywhere) — admin controls for aspect (1:1, 4:5, 3:4, 16:9…) + edges (sharp↔curved). Wire into layout settings.
9. **Per-card label visibility controls** — show/hide name, price, etc. per surface (composes with #6).
10. **Image-normalization template (toggleable + revertible)** — a per-store option that renders every product image to one consistent box (object-fit cover + fixed aspect + optional bg-fill) so a section looks "one photographer". Pure CSS/render-layer; revert = flag off. No image mutation.

## Batch 3 — Admin / accounting / inventory

11. **Shipping "Apply to all areas" button** — set one flat fee/free-over threshold across every area in one click.
12. **Bank reconciliation mismatch report** — when statement ≠ ledger: show WHERE the mismatch is, the TOTAL mismatch amount, and the missing figure vs the trial balance, plus the action the system will take.
13. **Supplier "net lead time (days)" field** + verify the reorder suggestion truly uses velocity + lead time + open backorders with REAL numbers (not a stub).
14. **Inventory overview cards → clickable** (each KPI card navigates to the data it summarizes).
15. **Dead-stock — verify it actually works** end-to-end (cron + UI + real data) or fix.

## Batch 4 — Order page + analytics pipeline

16. **Order page: show customer name on the OUTSIDE (list) row; shrink the order number outside, show it in full inside.**
17. **Per-session view tracking (storefront SDK)** — emit page/product views so the checkout funnel + product-velocity analytics get real input.
18. **Nightly rollup actually populates** segment / cohort / product-velocity (02:00 KW). Verify the cron runs + writes; fix if the "no data yet" is permanent.

## Batch 5 — Pecannbee catalog match (separate, large)

19. **Scrape `pecannbee.com.kw`** (categories, products, prices, variants, per-category ordering, new-arrivals, best-sellers) → reconcile our `pecannbee` store to match prices/variants/ordering. (Owner says we have MORE products/variants — match theirs as the baseline, keep extras.) Read-only scrape → diff report → reviewed import. Its own plan doc.

---

## Cross-cutting guardrails (every batch)

- **Platform-wide:** card changes hit all 7 render paths; header/cart changes hit all 5 themes; copy in `LanguageContext`. Never tenant-scoped code (per-store CONFIG only).
- **Blast radius before each PR:** grep all call-sites of any shared component touched; bring them all to the same standard.
- **OS watches regression:** `os-watch` already pushes green→red CI to the Zero inbox; each PR runs full CI.
- **Verify-before-fix:** items 1, 13, 15, 18 are "is this real?" — confirm against running code/DB before changing (triangulate).
