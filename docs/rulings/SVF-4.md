# SVF-4

> Section: 2026-09-30 — single-variant products (branch `fix/single-variant-products`)

**Ruling SVF-4 — the restore snapshot is taken inside each product's apply transaction, and both
cache layers are purged by default (issues 2350, 2351).** The first version snapshotted every
product in its own read-only transaction before any apply, but the apply unlinks by predicate
(`variant_id = vId`), so an order/cart line written in between was unlinked and missing from the
backup — `--restore` could never re-link it. `applyProduct` now snapshots after taking the
product and variant `FOR UPDATE` locks (no new row can reference the locked variant: an FK write
needs `FOR KEY SHARE` on it), hands the snapshot to the caller, which writes it to the backup file
before the transaction's first write; a skipped or rolled-back product is dropped from the file.
The cache purge splits into its two independent layers: the storefront tag purge (HTTPS, no Redis)
is always attempted and awaited, the Redis layer only with a `REDIS_URL`; `--no-bust-caches` opts
out. Residual: the demo-store run of 2026-09-30 used the OLD flow — its backups
(`~/.claude/ebda-lane/flatten-single-variant-demo-store-*.json`) can miss a line that landed in its
window. Cost if wrong: one order line from that window stays detached from a restored variant; its
snapshot fields are intact.

---

> Section: 2026-09-30 — single-variant products (branch `fix/single-variant-products`)

**Ruling SVF-4 — product cards, the carousel quick-add and "Frequently Bought Together" are NOT
changed.** A variant product's card CTA is the "View"/"عرض" button and quick-add is hidden for it;
turning either into Add to Cart changes the card's copy and layout, which the owner's no-visual-change
instruction forbids. FBT's recommendation payload carries only `{id, price}` per variant (no
`isActive`, no stock), so it cannot apply SVF-3's tappable rule without an API change. After the
Part A flatten these products are simple products and every card path adds them directly. Cost if
wrong: until Part A is applied, a single-variant product still needs a PDP visit to be added.
