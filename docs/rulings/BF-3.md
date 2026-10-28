# BF-3

> Section: Backlog batch final (2026-10-01, branch `fix/backlog-final`)

**Ruling BF-3 — the nightly analytics rollup fans out one run per store (issue 2348).** The cron
now lists stores and sends one `insights/rollup-requested` per store in batches of 500; the
per-store function (the same one the super-admin "run now" uses) does the three rollup steps, with
`concurrency: [{ limit: 3 }, { key: storeId, limit: 1 }]` and `retries: 2`. Total steps are the
same 3 per store (recorded in the cost forecast); what changed is that no single run grows with
the store count. Cost if wrong: a store's nightly rollup and a "run now" for it queue behind each
other instead of running together.

**Owner questions left open in this batch (not guessed):**

- Issues 2345 / 2346 — what an old-shape variant-less PO line on a variant product means for a
  merchant. `sent` lines cannot be received (VARIANT_REQUIRED) and count as on order for no
  variant, so the reorder scan can over-suggest; `partial` lines already put units on the parent
  column, which no stock surface counts, and cancelling re-orders the full quantity. Landed here:
  the refusal in en/ar, `scripts/list-variantless-po-lines.ts` (count per store and PO status) and
  a warn log per scan when any exist. Not decided: whether such lines count toward a variant's
  on-order (all of it, apportioned, or none until re-targeted), and how stranded `partial` units
  (and their AP/journal) are settled.
- Issue 2349's storefront half — `apps/web` cart/checkout/auth banners pair a role tint with the
  bare role colour (1.98–3.30:1). Those pages render on demo-store, whose look must not change, so
  re-colouring needs an owner OK or a default-off theme flag with demo-store pinned by data.
