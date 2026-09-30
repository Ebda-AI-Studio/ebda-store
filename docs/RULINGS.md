# Rulings ledger — force-website-builder

Decisions that override a plan, reject a finding, or accept a residual, written
at decision time. Form: `Ruling <id> — <decision>. <evidence>. Cost if wrong: <one sentence>.`

A declined finding gets the same rigour as a fix. A finding that stops being
mentioned reads as fixed, so it is recorded here instead.

---

## 2026-09-25 — OTHER-O2

Context: OTHER-O2 batch (storefront/orders lower-severity issues + Sentry source maps), branch
`fix/p2-other-o2-storefront`.

**Ruling O2-1 — #1271: the `/public/products` field projection is not added; the sitemap budget is
re-derived instead.** Verified against Cloudflare's limits page (2026-09-25): binding calls (R2, DO)
count as subrequests, but the Workers Paid ceiling is 10,000 per invocation since 2026-02-11, not
1,000. Worst case is 851 fetches ≈ 3,400 subrequests with cache ops; memory is bounded by the new
per-product projection in `sitemap.ts` (#1290), and a store whose fan-out throws is now logged. A
`fields=` projection would change the `public:products:*` cache key contract that ProductsClient /
SearchClient read, for a cost only reachable at ~200 stores (3 live today, each ≤ 3 product pages).
Cost if wrong: at ~200 stores a cold master-sitemap render issues ~600 full-payload product queries
against the API; Redis (120s) and the fetch cache (1h) absorb repeats.

**Ruling O2-2 — #1842: no server-side negative cache for transient store-resolve failures.** The
client fix (Try Again disabled while pending + 2s cooldown) removes the click amplifier. A 5-15s
in-process "store unavailable" sentinel would extend every single blip to that window for every
shopper on the isolate, including after the API has recovered. Cost if wrong: N shoppers on the
retry page still produce up to N resolve calls per 2s during an outage, bounded by
`storeResolveLimiter`.

**Ruling O2-3 — amends SR-7 (#1843).** SR-7 said "Try Again" was the only non-retry control on the
transient page; that held for the root boundary only — ShopChrome / MinimalChrome around the
segment boundaries emitted the same prefix-less links. The segment boundaries now render the
fallback without chrome when the error is the transient AND the client holds the unresolved
sentinel (`useBareErrorFallback`). When the store did resolve, the chrome stays: its links are
correct. Cost if wrong: during a transient the PLP/PDP/cart/checkout retry page shows no header,
matching the root boundary. **Amended 2026-10-01 (EWO-G2, #2223):** the bare fallback is scoped
to a PLATFORM host (`&& isPlatform`). On a custom domain `useStoreUrl` never prefixes, so the
chrome's links there were always the merchant's own and it now stays — the same host distinction
the "Go Home" gate already drew (#1841).

**Ruling O2-4 — #1201: `www.google.com` is added to `connect-src` only, not `script-src`.** The Ads
conversion runtime loads from `www.googleadservices.com` / `googleads.g.doubleclick.net` (both
added to script-src and connect-src); www.google.com hosts JSONP endpoints that are a known CSP
bypass gadget, and no documented Ads script is served from it. Not verified against a live store
with Google Ads enabled — none of the three live stores has it on. Cost if wrong: a remarketing
sub-request from www.google.com is CSP-blocked and shows up as a console violation.

**Ruling O2-5 — #1563: the cart empty state is not gated on `cartIsReady`.** Bundles now pre-paint
from localStorage exactly like loose items, which closes the reported gap. Gating the empty state
would replace the instant "Your cart is empty" that every genuinely empty cart on the 3 live stores
shows today with a blank wait for GET /public/cart (seconds on a cold API). Cost if wrong: a device
with no cached cart (cleared storage, first visit on a new device) still flashes "empty" before a
server-only cart arrives — the same as loose items always have.

**Ruling O2-6 — #1614: a merchant-picked custom-badge colour keeps white text.** Only the primary
fallback now uses `--primary-foreground`. A contrast-computed foreground would flip pecannbee's live
red "عرض" chip (the only live custom badge) from white to black text. Cost if wrong: a merchant who
picks a pale hex still gets low-contrast white text until the ColorField warns about contrast.

---

## 2026-09-25 — P2 batch M4 + D1 (inventory, accounting, tax)

Branch `fix/p2-m4-d1-inventory-accounting`.

**Ruling M4-1 — #1705 (invoice/email `/1000` + `toFixed(3)`) is not changed.**
It is the non-KWD currency case, and Ruling PC-2 keeps FWB KWD-only: the
write path still stores `price * 1000` for every currency, so a
currency-aware invoice formatter would print a correctly-formatted wrong
number. The fix belongs to Ebda's money layer. Cost if wrong: an invoice for
a non-KWD order prints a 3-decimal KWD-shaped amount, which cannot happen
until a non-KWD store exists.

**Ruling M4-2 — #193 (VAT taxable base) needs the owner.** Checkout levies
tax on the PRE-discount subtotal (`order.service.ts`: `Math.round(subtotal *
taxRate)`), the GL credits revenue net of discount, and `docs/uat/tax-reports.md`
E6 expects tax on the DISCOUNTED amount. Which base is intended decides
whether the report or checkout is wrong, and changing checkout changes what
shoppers pay. Left unchanged; E6 now carries the open note. Cost if wrong:
a store with an active tax rate and coupons sees an inflated effective rate
and fragmented by-rate buckets until it is decided.

**Ruling M4-3 — #1103 (variant `isActive` in the stock helpers) needs the
owner.** "Stock" means two things here: SELLABLE stock (a disabled variant
cannot be bought) and ON-HAND stock (a disabled variant's units still exist
and are valued on the balance sheet). The admin list counts active variants
only; `effectiveInventory`/`ON_HAND_SQL` count all. Picking one rule changes
either availability flags or the inventory valuation. Left unchanged. Cost if
wrong: admin list and detail keep disagreeing for products with a disabled
variant that holds stock.

_Superseded 2026-09-27, on merging main:_ the owner decided #1103 in batch M5
(Ruling M5-6 — the shared helpers count ACTIVE variants only). The reorder scan
this batch moved onto `effectiveInventory` (#1100) now selects `isActive` so it
follows that rule; `tests/unit/effective-inventory.test.ts` flagged it.

**Ruling M4-4 — #1049 (receipt downscale to 2000px before OCR) is left for
the owner.** Proving OCR accuracy needs real merchant receipts; a synthetic
receipt would pass for the wrong reason. Cost if wrong: small receipt totals
extract less reliably than they could, and a merchant corrects them by hand.

**Ruling M4-5 — the 5,000-row CSV post (#225) stays ONE transaction.**
Chunking the post would let an import half-apply, which is worse than a
timeout on a stock ledger. The resolve step went from up to ~10,000 queries
to 4, the snapshot to 2, and history rows to one INSERT; the per-line stock
UPDATEs remain. Residual: a full 5,000-line post is still bounded by the
30s tenant transaction and is not measured here. Cost if wrong: a very large
import times out and must be split by the merchant.

**Ruling M4-6 — `WarehouseService.syncAggregateInventory` writing
`products.inventory = SUM(variants)` is recorded, not fixed.** It breaks the
inventory-model invariant (a variant product's parent stays 0), but two
integration tests (`stock-race`, `reconcile`) assert that rollup on purpose,
so removing it is a contract change for multi-warehouse stores, not a
sibling fix. Readers go through `effectiveInventory`/`ON_HAND_SQL`, which
ignore the parent for variant products. Cost if wrong: a variant-blind
reader added later reads a warehouse store's parent column as stock.

---

## 2026-09-25 (fix/p2-r2-o2 batch)

Context: scoped-audit issue #1828 — the GSC runbook understated what the
50k-URL sitemap clamp drops.

**Ruling — the runbook formula is fixed; the tiered-leading-pass CODE change
is declined for this batch.** The issue's fix has two parts: (1) correct the
runbook's claim that the clamp "degrades catalog depth" to state the actual
formula (product URLs emitted = `max(0, 50,000 - apex - 11 x storeCount)`,
reaching zero at ~4,545 stores, before any static page drops) — done, doc
only. (2) Tier `STORE_STATIC_PAGES` so the 3 high-priority pages lead, then
catalog, then the 8 low-priority pages — marked "optional but strictly
better" by the issue itself. Declined here: it changes
`storesFullyDropped`'s meaning in `sitemap.ts` (currently "a store's 11
static pages didn't fit"; tiered, that becomes "a store's 3 static pages
didn't fit", a much higher threshold), and `tests/unit/sitemap-fanout.test.ts`
"reports how many stores were fully dropped" (line 225) asserts
`storesFullyDropped > 0` for a 5,000-store/no-products fixture that would
compute to exactly 0 under the tiered formula — the test's SCENARIO, not
just its assertion, would need to change to keep proving anything. That is a
bigger, more failure-prone change than this batch's scope, for a threshold
(~4,500+ stores) three live stores are nowhere near. Cost if wrong: catalog
coverage keeps collapsing to zero before ~4,545 stores instead of a higher
tiered threshold — unchanged from today's behavior, and now correctly
documented so an operator approaching that count knows to schedule the
tiering (or sharding) work rather than being surprised by the runbook's old
understatement.

Context: 5 more scoped-audit issues in the same batch, each asking for a
render/runtime verification the audit itself could not perform. All 5
verified against the LIVE production hosts or a real local render — not
reasoned about — so each is closed as not a defect rather than left open.

**Ruling — #734 (`.well-known/security.txt` dot-directory asset serving) —
NOT A DEFECT, verified live.** `curl -sI` against all three production
hosts, 2026-09-25:
`https://store.force-ai.co/.well-known/security.txt` → `200`,
`strict-transport-security` + `x-content-type-options: nosniff` present;
same for `admin.force-ai.co` and `orders.force-ai.co`. The dot-prefixed
asset directory is served correctly by OpenNext's Cloudflare Workers Assets
layer. Cost if wrong: none — this is a direct production measurement, not
an inference.

**Ruling — #748 (`public/_headers` HSTS/nosniff on the Workers asset layer)
— NOT A DEFECT, verified live.** Same curl pass as #734, extended to a
static asset with no dedicated route (`favicon.ico`, `security.txt`) on all
three hosts: `strict-transport-security` and `x-content-type-options` are
present on every response measured, including the admin/orders 404 pages
(those headers are also set by Next middleware independently, so they'd
survive even if `_headers` weren't honored — but `_headers`-specific
coverage was confirmed via the security.txt 200s above, which have no
middleware in front of them). Cost if wrong: none — direct measurement.

**Ruling — #1731 (dot-directory App Router routes: `.well-known/acp.json`,
`.well-known/ucp`) — NOT A DEFECT, verified live AND via local build.**
`curl -sI https://store.force-ai.co/.well-known/acp.json` and `/ucp` both
return `404` with `content-type: application/json` — the route's OWN
`notFound()` JSON response (`acp.json/route.ts`'s fail-closed 404 for an
unresolved/non-agent-enabled store on the platform host), not Next's HTML
"page not found" shell. That is only possible if Next registered and
invoked the handler. Independently, `bash scripts/cf-build.sh web` (run
locally this session) lists both routes in the build's route manifest:
`ƒ /.well-known/acp.json` and `ƒ /.well-known/ucp`. Next's App Router DOES
register dot-prefixed directories as routes. Cost if wrong: none — both a
live probe and a local build manifest agree.

**Ruling — #906 (sharp 0.34→0.35 render pipeline) — NOT A DEFECT, verified
by render smoke test.** Ran `resizeToAspect`/`enforceMaxDimensions` (the
exact functions on the upload path) against generated JPEG/PNG/WEBP samples
and a hand-written SVG through the installed `sharp@0.35.4` (vips 8.18.6)
this session: `resizeToAspect(…, '1:1')` correctly crops to 1000×1000 for
all three raster formats with sane byte-size reduction (e.g. JPEG
35,519→3,303 bytes), `enforceMaxDimensions` correctly constrains the
longest side to 2000px, and an under-target SVG is correctly left
untouched (`input already <= target, skipping resize`). No output was
corrupt, oversized, or mis-cropped. Not run: `GET /og` end-to-end against a
live SVG-logo store (needs the running API + DB), so the OG-card
rasterization half of the issue's fix idea is unverified — the shared
sharp binary and code path are identical, so this is a small residual, not
a reason to reopen. Cost if wrong: an SVG store logo fails to rasterize on
`/og` specifically — would show as a broken OG card image on social shares,
not on the storefront itself.

**Ruling — #1194 (forced `qs@6.16.0` vs express/body-parser's declared
range) — NOT A DEFECT requiring a code change, tracked as accepted
drift.** Confirmed still present: `express@4.22.2` still declares
`qs: ~6.15.1` (excludes 6.16.0) while the root `overrides` forces 6.16.0;
`body-parser` has since bumped to 1.20.8, whose own declared range
(`~6.16.0`) already includes it, so half the original mismatch resolved
upstream. The remaining half's actual risk is lower than the issue frames:
`grep -rn "req\.query\[" apps/api/src` and a search for
`Array.isArray(req.query...)` / `as string[]` return NO matches anywhere in
this codebase — no route reads a bracket-array query key (`?key[]=`), which
is the exact parsing-semantics surface GHSA-x5fp-wj9c-mxmx changed
(array-limit enforcement). The PLP facet contract (`ProductService`'s
`categories`/`tags`) uses comma-joined strings
(`(categories as string).split(',')`), never `qs` array syntax. Declining a
code change here, consistent with the team's prior acceptance of the same
declared-range-mismatch shape for protobufjs. Cost if wrong: a future route
that DOES start reading bracket-array query keys inherits qs 6.16.0's
changed array-limit behavior without a dedicated test — mitigated by this
ruling naming the exact grep to re-run before adding one.

**Ruling — #715 (Durable Object class renamed under migration tag `v1`) —
NOT A DEFECT, verified against the live Cloudflare account.** Read-only
`GET /accounts/{id}/workers/durable_objects/namespaces` (Cloudflare API,
2026-09-25) shows `force-web-cf-preview` and `force-web-canary-preview` each
bound to a `DOQueueHandler` namespace (SQLite-backed, `use_sqlite: true|True`)
and a `DOShardedTagCache` namespace — the CURRENT, correct class names from
`scripts/cf-setup-local.sh`. No `DurableObjectQueueHandler` namespace exists
on either worker. Whatever happened during the 2026-07-12 deploy the
issue's inline comment describes, the live account state today is
consistent with the code: the rename under tag `v1` did not leave an
orphaned or stuck old-class binding. Cost if wrong: none — this is a direct
read of the account CF actually runs, not an inference from the migration
script.

Context: 3 findings in the same batch declined as out-of-scope for a
surgical bug-fix batch (no live defect; the fix itself is a project, not a
patch).

**Ruling — #709 (Track-A flag-flip would double-fire pixels/JSON-LD/theme)
— NEEDS OWNER, not fixed this batch.** Confirmed still true on
`origin/main` and still fully inert: `STOREFRONT_TENANT_ROUTING` defaults
off and nothing in this batch or recent history flips it in any
environment. The fix is a root-layout decomposition (Next route groups) so
the Track-A tree stops inheriting the legacy `app/layout.tsx`'s
providers — a multi-file architectural change, not a surgical patch, and
risky to rush inside a batch whose hard rule is "production must not
break." Question for the owner: schedule the route-group decomposition as
its own task before `STOREFRONT_TENANT_ROUTING` is ever flipped on
anywhere (including a preview environment), or accept the double-fire as a
known gap until Track-A actually ships. Cost if wrong: no change today
either way — the flag is off. The cost lands entirely on whoever flips it
next without doing the decomposition first.

**Ruling — #1549 / #1810 (dream-proposal: `sitemap()` and
`buildPerStoreBody()` exceed complexity thresholds) — declined, not
fixed.** Both are Whisky AI OS `dream-act.sh` auto-generated findings,
explicitly marked by the tool itself as "not autofixable or outside the
safe tier — human review required." Neither names a behavioral defect,
only line count / branch count. `sitemap.ts`'s `sitemap()` and
`llms.txt/route.ts`'s `buildPerStoreBody()` are both bot-facing (SEO/agent
discovery), not shopper-facing, so a decomposition refactor carries pure
regression risk (reordering/dropping a branch in a 150+/90+ line function
during extraction) for a purely cosmetic maintainability gain, in a batch
whose brief is minimal surgical bug fixes. Declining both; a dedicated
refactor task with its own test-coverage-first pass is the right vehicle.
Cost if wrong: these two functions stay harder to review than they should
be — unchanged from before this batch, no regression introduced.

## 2026-09-25 — batch M5 (misc money surfaces)

Context: branch `fix/p2-m5`, fourteen audit issues plus the owner's #1103
decision. Owner's rule for the batch: production must not break, and nothing
changes how buying or paying works unless an issue explicitly requires it.

**Ruling M5-1 — #1809 (`allocateBundlePrice` is 106 lines) is not refactored.**
The length is the documented closed-form residual distribution that replaced a
per-unit loop, and it is equivalence-tested against that loop on every run
(`tests/unit/bundle-allocation-equivalence.test.ts`) plus exhaustive and
property checks of both invariants, the zero-price case and odd remainders
(`tests/unit/bundle-pricing.test.ts`) — every test the issue asked for already
exists. Splitting a money allocator to satisfy a line-count metric adds risk of
exactly the off-by-one-fil error the tests guard against, for no behaviour.
Cost if wrong: the function stays harder to read than it could be; a future
edit to it must still pass the equivalence suite, which is the real guard.

**Ruling M5-2 — #1602: the customers router keeps its bare `/stores/:storeId`
mount; the double transaction is closed in `tenantContext` instead.** Moving
the mount (the issue's first fix) was built and then reverted: that mount has
wrapped every later `/stores/<uuid>/*` request since 2026-04-27, so the
"context-less" phase-2 routers (`insights`, `finance`, `inventory`,
`notification`, `newsletter`, `recommendation`, the accounting routers…) have
run inside its tenant transaction in production ever since, whatever
`rls-router-context-invariant.test.ts` documents. Removing it would silently
change their atomicity and GUCs in one deploy. `tenantContext` now joins an
open transaction of the SAME store and user instead of nesting a second one,
so every request is one transaction again and no router loses the one it has.
Cost if wrong: the phase-2 routers stay wrapped by accident rather than by
design — the documented "context-less" set is not what runs, and that
mismatch needs its own audit before anyone relies on either description.

**Ruling M5-3 — #1787: the COD mark-paid batch stays on its own transaction.**
Measured against Postgres 16: a `prisma.$transaction([...])` batch built from
proxied accessors inside the tenant context runs on its own connection and
commits even if the request then rolls back (it has carried the request's GUCs
since Ruling RLS-S1's `transactionWithGucs`; the separate commit is unchanged). For
mark-paid that commit is load-bearing today: the handler enqueues
`order/created` BEFORE the request commits, and the accounting journal and WBS
notification read the order as paid. Moving the flip into the request
transaction first needs that send behind `deferAfterTenantCommit`, which is a
money-path change no issue in this batch requires. Recorded in
`REVIEWED_OWN_TRANSACTION` with this reason. Cost if wrong: a mark-paid
request that fails AFTER the flip leaves the order paid without its payment
event row; the merchant sees paid, the audit trail has a gap.

**Ruling M5-4 — #1826: the checkout does not reuse the order id to retry the
payment.** The issue's premise that "try again" always duplicates the order is
half true: every payment failure thrown after the order is found runs
`rollbackForPaymentFailure` server-side (order cancelled, stock and coupon
returned), so re-creating the order is the designed recovery. Reusing the id
after such a failure would mint an invoice for a CANCELLED order —
`/payments/create` does not check order status. Only three codes leave the
order pending: `ORDER_ALREADY_PAID` (now answered by opening the order's
confirmation, never a retry), and `NOT_FOUND` / `PAYMENT_FAILED`, recorded in
the gate's `DELIBERATELY_GENERIC` with why a retry is honest. Cost if wrong: a
shopper who retries after those two strands one pending order that holds its
stock until `order-auto-cancel-unpaid` releases it (2 days) and sends the
customer a cancellation notice.

**Ruling M5-5 — #1220: order-driven storefront purges are coalesced for up to
10 seconds per store; the residual is display-only.** Redis is still cleared
on every order, immediately; the storefront purge is leading-edge, so an order
in a quiet period purges at once and only a burst shares one trailing purge.
Mid-burst the storefront's own data cache may show stock up to 10s behind.
Checkout re-reads stock from the database on every order, so it cannot
oversell. Content edits (product, variant, bulk AI) keep the immediate purge.
Cost if wrong: during a flash sale a shopper can see "in stock" for up to 10s
after the last unit sold and be refused at checkout.

**Ruling M5-6 — #1103: a query that pre-filters to ACTIVE variants falls back
to the parent column when every variant is disabled.** The shared helpers,
`ON_HAND_SQL` and `enrichStockFlags` see all variants with their flag and give 0. The PDP and the WhatsApp bridge's display selects keep `where: { isActive:
true }` (they list variants to the shopper), so for an all-disabled product
they read the parent column instead — which the inventory-model invariant
holds at 0, and which is ≤ 0 on every product the 2026-08-30 drift touched.
Cost if wrong: a variant product whose parent column is somehow positive AND
whose variants are all disabled shows that number on the PDP and to the bot. _(Superseded by Ruling BS-7, issue 2147 — issue 2077 fixed the same WhatsApp-bridge selects in parallel.)_

**Ruling M5-7 — #1547: `payment-abandonments.routes.ts` has no recovery or
charge endpoint to test.** The issue's fix idea named "abandonment recovery
charge"; the router exposes only `GET /` and `GET /stats` (retargeting is the
`payment-abandonment-sweep` Inngest push). Its test covers what exists: masking,
shapes, validation and the fail-closed feature gate. Cost if wrong: none for
this router; a future action endpoint needs its own test.

**Ruling M5-8 — #1462's defence mutation targets the migration SQL, not the
database.** `money-loyalty-reversal-index` weakens `CREATE UNIQUE INDEX` to
`CREATE INDEX` in the migration file; the integration test derives its list
from the migrations, so the derivation loses the index and goes red. It proves
the index cannot be quietly removed from the migration history; the same test's
`pg_indexes` assertion is what catches a database that lost it (a `db:push`, an
old restore) — shown red by dropping the index on a local Postgres 16. Cost if
wrong: none known; both halves were watched fail.

---

## 2026-09-25 — RLS strict policies (cutover attempt #1 rollback)

Context: `docs/plans/2026-07-02-rls-cutover.md` § "2026-09-25 — first Phase 3 attempt". Branch
`fix/rls-strict-policy-contextless-reads`.

**Ruling RLS-S1 — the 24 STRICT policies stay strict; the readers get a context.** Weakening
`store_faqs`/`store_howtos` (or any of the 24) to allow-contextless would make the public-route bug
disappear by removing the database backstop the cutover exists to add, and no migration or doc
records allow-contextless as the intended shape for them. Every contextless reader found was given
the store it had already resolved. No policy migration ships. Cost if wrong: a contextless reader
the audit and the parity gate both missed returns empty after the next flip — bounded by the
parity gate, the staging soak list, and a one-env-var rollback.

**Ruling RLS-S2 — `prisma.$transaction` opened inside a context inherits that context's GUCs.**
Measured under a real `force_app` login: inside `runInTenantContext`, a strict-table count was 2
directly and 0 through `withMoneyTx` or a batch `$transaction([...])`. Fixing it in the proxy covers
all 23 `withMoneyTx` and ~20 batch call sites at once. The transaction still opens separately (no
nesting, callers keep their isolation/timeout options). Inert on the owner role. Cost if wrong: a
caller that deliberately used a second transaction to escape its store's scope now sees only its
store — none was found, and such a caller would itself be a tenancy bug.

**Ruling RLS-S3 — long jobs use `runInStoreScope` (one short tenant tx per query), not
`runInTenantContext`.** #461 removed the bulk-AI wrapper because a 30s interactive transaction
cannot span Gemini calls; its premise ("products + bulk_ai_jobs are not RLS-protected") was false.
Cost if wrong: one extra BEGIN/SET/COMMIT round-trip per query in bulk jobs — negligible next to a
2.5s AI throttle.

**Ruling RLS-S4 — the R2 orphan check runs under `withRlsBypass`.** "Is this URL referenced
anywhere" is cross-store by definition (cloned stores share image URLs); inside a store context
every other store's rows are invisible and the object would be deleted while still in use. Cost if
wrong: none on correctness — the check only ever reads, and bypass only widens what it can see.

**Ruling RLS-S5 — accepted residual: the parity gate covers public/storefront endpoints only.**
Admin routes, Inngest jobs and crons are covered by the force_app integration suite and the new
registry/inheritance tests, not by an owner-vs-force_app payload diff. Cost if wrong: an admin or
background path that returns fewer rows (not an error) under force_app is found in the staging soak
or in production instead of CI.

---

## 2026-09-25 — returns/refunds money batch (M1)

Context: branch `fix/p2-m1-returns-refunds`, 19 issues in the return-completion
and provider-refund path. Measured against Postgres 17 before any change: every
gateway refund made inside a request hung 30,006 ms and ended in P2028, because
the post-provider write was a client-level array transaction that waited on the
row lock its own request held. That finding shapes the rulings below.

**Ruling M1-1 — the refund's records commit on their own transaction, not the
request's.** The claim, the release or indeterminate mark, and the confirmation
each run in `runInTenantContext` of their own. The request transaction rolls
back on any 5xx, and the provider call cannot be rolled back with it: before
this, a failure after the money left erased every record of it and the retry
paid again (`tests/integration/refund-transaction-boundaries.test.ts`, red on
main). Cost if wrong: a claim committed before a process dies inflates the
payment's refunded total until someone reconciles it — which is why it is
written as a `refund_initiated` event the stuck-claim check raises (M1-6).

**Ruling M1-2 — the per-order returns lock is a transaction-scoped ADVISORY
lock, not `SELECT … FOR UPDATE` on the order row.** The brief asked for the
row lock. `complete()` holds the lock across the provider call, and
PaymentService now commits the order's `refunded` flip on its own transaction;
a row lock held by the request would make that commit wait on the request
while the request waits on it (the same shape as the 30 s hang above). The
advisory key serialises every return create/complete on one order and locks no
row. Proven on Postgres by `tests/integration/return-order-lock.test.ts` (red
with the lock removed). Cost if wrong: none for money — anything else that
needs to serialise with return completion must take the same key, not the row.
_Amended 2026-10-01 (issues 2004 / 2030):_ the HOLD DURATION matters too —
`complete()` keeps the key across the provider round-trip (~16s worst case for
MyFatoorah), so the customer-facing `create()` no longer blocks on it: it polls
`pg_try_advisory_xact_lock` for 3s, then answers 409 `RETURN_ORDER_BUSY`
(localized on the storefront returns page). `complete()` still waits — it is
the merchant's own action and must serialise. Cost if wrong: a shopper who
submits a return while the merchant is refunding another return on the same
order is asked to retry.

**Ruling M1-3 — a provider failure releases the claim only when it proves
nothing was sent.** A 4xx (except 408) or a 2xx whose body says failure is a
rejection; a timeout, network error, 5xx or unparseable body keeps the claim
and returns `PROVIDER_REFUND_INDETERMINATE`. A MyFatoorah failure before
`MakeRefund` is sent counts as not sent. Cost if wrong: a refund that did not
execute blocks further gateway refunds on that payment until reconciled; the
opposite error pays the customer twice.

**Ruling M1-4 — a provider's `success: false` refund response is NOT treated
as a rejection.** Tap's mapping marks anything but `PENDING`/`CAPTURED` as
unsuccessful, and whether its completed-refund status is one of those is not
verified here. Releasing on it could free a refund that went through. Cost if
wrong: a genuinely declined refund is recorded as sent until the settle webhook
or a refresh says otherwise.

**Ruling M1-5 — #1349 and #1361 are closed by the refund key, not by a
release endpoint or a stale-claim window.** The Return's `refundedAt` claim
lives in the request transaction, so a crash or any 5xx rolls it back — it
cannot strand a return (verified on Postgres: the return is `received` again
after a rolled-back completion). The real hazard behind both issues was the
retry after the money left; `PaymentService.refund` now refuses a second
refund under `return:<id>` while an earlier one is unreleased, and the admin
offers "Already refunded — record only" (`refundMethod: 'manual'`). Cost if
wrong: none known; a claim can only persist if a caller runs `complete()`
outside a transaction.

**Ruling M1-6 — #1317's automatic rollback of an unconfirmed claim needs the
owner.** The claim is now recorded and raised (P1 alert on the
refund-reversal sweep's tick, visible on the order's payment timeline), but
without a provider refund id nothing can be asked of the provider, so undoing
the balance needs a human. Question for the owner: may a store admin, or only
a super admin, reduce a payment's refunded total, and on what evidence?

**Ruling M1-7 — no GL entry is posted for partial refunds made outside a
return (#1209, #1455); they are raised instead.** Both need an amount-only
journal (DR sales returns + tax pro-rata by amount, or DR a refunds contra
account, CR the sale's cash account) and the account choice changes the books
of live stores. Until the owner picks one, each such refund fires a P1
`payment.refund.partial_no_gl` alert naming the order. Cost if wrong: the
ledger keeps understating refunds for these until booked by hand.
_Amended 2026-10-01 (issues 2001/2025/2026/2032):_ the claim "each such refund
fires a P1" was not true as built — `sendAlert` throttles per title for 5 min
and the title was constant, so a second refund on the same store inside that
window was dropped. `alertUnbookedRefund` (payment-providers/unbooked-refund-alert.ts)
now puts the order in the title (one throttle key per order), always writes an
error log line with order/payment/refund ids first (the record when Telegram
throttles or is down; the payment_event rows remain the durable trail), and on
the request path sends after COMMIT instead of inside the open transaction.
Still no durable "unbooked refunds" UI — the ledger fix itself awaits this ruling.
A third kind, `held_provenance_unknown` (PR 2279 audit P1), pages when a
payment that predates the per-refund ledger receives a refund WITH a usable
amount: it is held rather than added, and the system cannot tell a settle
notice for the counted refund from a genuinely new one, so a human checks.
Cost if wrong: an extra P1 per benign settle notice on a pre-ledger payment.
The post-COMMIT send is queued with `deferAfterTenantCommit(..., { runOnRollback:
true })`: the provider refund already left, so a rolled-back request must not
drop the only page for it (PR 2279 audit). `runOnRollback` is reserved for
work that records an irreversible external event.

**RESOLVED 2026-10-01 (branch `fix/owner-money-decisions-1001`) — owner decision
(Ahmad): a partial refund made outside a return is booked as a revenue refund
for that amount, with no stock movement, idempotent per provider refund id.**
All three producers — the refund webhook (#1455), the refund-status refresh
(#1390) and the order page's refund-via-provider with an amount (#1209) — call
`OrderService.recordRefundOutsideReturn`, which sends `order/refunded` with an
amount-only partial payload (`items: []`, `amountOnly: true`, refundKey
`refund:<providerRefundId>`, `restoreInventory: false`, `notify: false`). The GL
consumer posts `postAmountOnlyRefundJournal`: DR 4090 Sales Returns / CR the
sale's cash account, sourceId `${orderId}:partial:refund:<id>` (so a later full
refund backs it out, and the tax report still resolves the order). The fanout
treats the empty-item payload as PARTIAL — never whole-order. #1390's second
point (a zero or unreported refund amount read as partial) was already closed
on main: `resolveRefundSettlement` reads an unknown amount as FULL. The
`payment.refund.partial_no_gl` P1 now fires only when the order page's event
cannot be queued. See OMD-3 and OMD-4 below.

**Ruling M1-8 — the partial-return cash credit keeps its current account and
amount for every refund method (#1207, #1351).** Crediting a store-credit
liability for `store_credit`, cash-on-hand for `cash`, and the actual refunded
amount with a variance line all change what is posted, and PR #1943 (customer
wallet) is about to give `store_credit` a real liability. Owner decision:
which account each method credits, and where a pro-rata-vs-actual difference
goes. Cost if wrong: store-credit and bank-transfer partial returns keep
crediting the provider cash account.

**RESOLVED 2026-10-01 (branch `fix/owner-money-decisions-1001`) — owner decision
(Ahmad): on a partial-return refund, credit the account that matches the refund
method, for the amount ACTUALLY refunded:** card/gateway → the sale's
cash/gateway clearing account; wallet → 2150 Customer Wallet Liability; store
credit → 2160 Store Credit Liability (both new COA template codes; existing
stores get them on first use through `getSystemAccountIdByCode`'s self-heal).
`resolveReturnRefundLegs` (partial-return-posting.ts) reads the committed Return
row (`refundMethod`, `refundAmount`) and the wallet ledger rows carrying the
return id — never the event payload. `bank_transfer`, `cash` and `manual`, and
every FULL return, are not covered by the decision and keep the old treatment
(OMD-2). Where a pro-rata-vs-actual difference goes: OMD-1.

**Ruling M1-9 — a FULL return on a manual method keeps its recorded figure.**
#1340 is about partial returns; for a whole order settled off-platform nothing
in the system knows what the merchant hands back (shipping, fees), so the
creation-time figure is left alone. Cost if wrong: the admin shows the gross
line total for such returns.

**Ruling M1-10 — merging main's customer wallet (#1943): with the wallet on,
the refund preview and confirm step show what the WALLET receives, not
`recordedAmount`.** The two differ on a full return (`computeStoreCreditAmount`
adds shipping and nets out `order.walletAmount`, which the `order/refunded`
fanout returns separately), so the merged confirm step would otherwise have
asked the merchant to confirm a figure `complete()` does not credit. The
preview now carries `storeCreditToWallet` from the same helper `complete()`
credits with (null when the wallet is off). Both sides' guards are kept
unchanged: this branch's order lock, claim, refund key and zero-partial
refusal, and main's exchange exclusion and idempotent `creditForReturn`.
Cost if wrong: none for money moved — only the figure displayed before
confirming would be wrong.

## 2026-09-25 — buy-flow parity harness (`scripts/buy-flow-parity/`)

**Ruling BFP-1: background Inngest functions are EXECUTED by a local executor.
They are not only recorded.** Restock and coupon reversal on cancel
(`order/refunded`) and webhook processing (`payment/webhook.received`) run as
Inngest functions. A harness that only recorded events reported a cancelled COD
order as `vase=2, coupon usage 1` (nothing returned), while the executed run
shows `vase=4, usage 0`. The executor gives each step one attempt and has no
concurrency or idempotency windows, and it applies these limits identically to
both refs. Cost if wrong: a defect that only appears on an Inngest RETRY is not
compared.

**Ruling BFP-2: `walletAmount` absent is compared as `0`, in the order row AND in
order-shaped API responses.** The owner specified this for the row. Without it
every scenario diffs on `walletAmount: 0` added by b1b5bbd1. Other wallet
additions (the `reverseWallet` event flag, the `reverse-wallet-payment` step) are
NOT normalised and show as diffs. Cost if wrong: a response consumer that breaks
on a new key is not flagged by this harness.

**Ruling BFP-3: a 5xx body is compared by the LAST line of its message, with
digits masked.** The full dev-mode message holds a Prisma code frame and elapsed
milliseconds, so two runs of the same code differ. Replacing the whole message
hid a real difference: base "Cannot transition from cancelled to refunded" vs
head "Transaction already closed". Cost if wrong: two different failures whose
last lines are identical compare equal.

**Ruling BFP-4: the admin "refund via provider" 30-second self-lock is reported,
not fixed, in the harness PR.** On base 96814545 and on main b1b5bbd1 alike,
`POST /stores/:id/orders/:id/refund-via-provider` for a paid MyFatoorah order
waits 30s and returns 502 `REFUND_FAILED` (Transaction already closed). Two
things lock each other. `PaymentService.refund` takes its claim `updateMany` in
the request transaction, and then its `prisma.$transaction([...])` batch, which
is not proxied to the tenant transaction (packages/database/src/index.ts), waits
on that row lock on a second connection until the request transaction times out.
MakeRefund has already been sent to the gateway by then. The result is order +
payment `refunded`, `payments.refunded_amount = 0`, and no `order/refunded`
event, so stock is not returned. Unit tests mock Prisma, so no test drives this
over HTTP. It is identical on both refs, so it is not a parity difference. It
belongs in its own fix PR. Cost if wrong: merchants who refund from the admin
see an error for a refund that did go through, and the stock is not restored.

## 2026-09-25 — Sentry open-issues sweep (branch `fix/sentry-open-issues`)

**Ruling SN-1 — FORCE-WEB-K/M/Q (`RangeError: Maximum call stack size exceeded`) and FORCE-WEB-N/P
(`Error: La`) are Chrome for iOS's own injected script, not FWB code; they are filtered at the Sentry
boundary, not "fixed".** All 63 events (100%) are `Chrome Mobile iOS`, zero from Mobile Safari on the
same WebKit engine. Every frame is attributed to the DOCUMENT URL (`app:///`, `app:///products`) at
lines 190-464, while the served HTML is 11-12 lines and the largest `/_next/static/chunks/*.js` the
storefront loads is 51 lines (Playwright WebKit + Chromium, iPhone profile, the breadcrumb sequence
home → category tile → logo/back, x6: no pageerror, 23 JS responses, none ≥190 lines, none defining
`Ok`/`Qk`/`Nk`/`Pk`). The line:col positions are identical across FWB releases two weeks apart
(2214be88 → ad17d6e4) while the Closure-style names change with the Chrome version (152 `Nk`/`Pk`,
154 `Ok`/`Qk`). `isHostInjectedScriptEvent` (`@force/shared`) drops an event only when the UA is
Chrome/Firefox/Edge for iOS (`CriOS`/`FxiOS`/`EdgiOS` — NOT the Facebook/Instagram in-app
browsers, which no event evidenced; narrowed in issue 2008), AND no frame comes from a script file,
AND every frame sits past line 100 (the served HTML is ~12 lines, the injected frames 190-464).
Cost if wrong: a genuine recursion in an inline script of ours that happens to sit past line 100
of the document, seen only by Chrome/Firefox/Edge-for-iOS users, would go unreported — every other
browser still reports it, and any frame in a shipped chunk or at a document-sized line keeps it.

**Ruling SN-2 — FORCE-API-28 (cart P2003 `cart_items_cart_id_fkey`) needs no new change.** All 3
events are 2026-08-31 16:15-16:53 UTC; #1108 (2dd34917, 19:56 UTC the same day) moved addItem onto
the ambient tenant transaction, and the issue has no event since. Cost if wrong: a first add-to-cart
500 would reappear and re-open the issue on its own.

**Ruling SN-3 — FORCE-API-29 (MyFatoorah `TimeoutError`) needs no code change.** The 8s
`AbortSignal.timeout` fired on `/v2/InitiatePayment`, i.e. before any invoice existed; the
`/payments/create` catch runs `rollbackForPaymentFailure` (order cancelled, inventory + cart restored,
idempotent), and the storefront shows its generic "try again" copy. 8s per call (16s worst case for
Initiate + Execute) is inside the checkout's patience. Cost if wrong: a timeout on
`ExecutePayment` after MyFatoorah minted the invoice leaves a payable invoice for a cancelled
order — the same window every provider timeout has, closed by the webhook/reconciler, not by a
shorter timeout. Observed, not changed: `CheckoutClient` clears the saved checkout form from
sessionStorage before it checks the payment result, so a reload after a failed payment loses the
typed form (in-page state survives, so an immediate retry does not).

**Ruling SN-4 — FeatureService retries a connection-level DB failure once and otherwise fails
closed; no stale-map fallback.** The map gates paid features; serving a remembered map could say ON
for a feature a super-admin just turned off. Cost if wrong: two consecutive Neon connection failures
still 500 `/public/store/resolve` for that request.

## 2026-09-25

Context: batch M2/D2 (order lifecycle + refund data integrity), branch
`fix/p2-m2-d2`. Owner rule: production must not break; nothing changes how
buying or paying works unless an issue requires it.

**Ruling M2-1 — #1487's metadata backfill is NOT run; the in-band writer now
seeds the per-refund status map and a held total logs at warn.** The proposed
backfill seeds `refundEventIds = [metadata.refundId]` for every payment with
`refundedAmount > 0`. `metadata.refundId` is only the LAST refund's id: a
payment refunded twice in-band before the ledger shipped would be seeded with
one of its two ids, and the provider's settle webhook for the other would then
read as a brand-new refund and be ADDED to the total — overstating refunds and
understating the refundable balance, the unrecoverable direction.
`resolveRefundSettlement` deliberately holds the total when provenance is
unknown ("understating a refund is recoverable, paying one twice is not"); the
backfill would remove that hold on exactly the rows it cannot vouch for. Now
observable instead: `[refund-settlement] refund amount held` at warn. Cost if
wrong: a pre-ledger payment later refunded out-of-band keeps a short
`refundedAmount` until reconciled by hand from that log line.

**Ruling M2-2 — #762 is fixed with a confirm step, not by removing "Refunded"
from the status dropdown.** The manual status is the only way to record an
off-platform refund (cash, bank transfer) and to close out a COD order, so
removing it would strand those. The dialog (en + ar) states that it moves no
money and names the "Refund via provider" button. `VALID_TRANSITIONS` is
unchanged (the gateway path needs confirmed→refunded). Cost if wrong: a merchant
who clicks through the dialog still sends a "Refund issued" message for money
that did not move.

**Ruling M2-3 — #1603: no idempotency key on order creation.** Evidence: both
order writers commit in their own `withMoneyTx` (not the request transaction),
and the cart checkout clears the cart in that same transaction, so a retry after
an ambiguous 500 fails `EMPTY_CART` — it cannot double-order. The manual-order
route (`/orders/admin`) carries its items in the payload, so a human retry there
can create a second order, but it is `pending`/`unpaid`, charges nothing and
reserves no stock (admin orders do not decrement inventory at creation).
Adding a key means a migration + unique index on `orders` and a client contract
for the admin form, to remove a duplicate unpaid draft a merchant can cancel.
The residual is now documented in `request-transaction.ts` and ADR 0001. Cost
if wrong: a merchant occasionally sees and cancels a duplicate manual order.

**Ruling M2-4 — #839/#855/#858 are fixed together by a request stamp, not by a
status gate on the claim.** Gating `claim-reversed` on cancelled/refunded
(#858's option b) would leave a manual-method FULL return — which restores stock
on an order that stays `delivered` — permanently unclaimed, and a status-agnostic
sweep (#839) would then re-send it every tick. Instead `applyRefundEffects`
stamps `refundReversalRequestedAt` and re-nulls `refundReversedAt` at every
whole-order stock-restoring enqueue (option a); the sweep keys on that stamp
(immutable, #855; status-agnostic, #839); `restoreInventory:false` backorder
events are not armed, so the sweep never invents stock. Pre-column orders keep
the old status + `updatedAt` predicate. Cost if wrong: one extra `UPDATE orders`
per cancel/refund enqueue. _Amended 2026-10-01 (issue 2132):_ an unarmed
`restoreInventory:false` event's `claim-reversed` now matches only rows whose
`refundReversalRequestedAt` is null, so it can no longer close a claim a
dropped stock-restoring event armed (#858 had re-opened through that path).

**Ruling M2-5 — #1552 keeps each BackorderLine's quantity equal to the whole
force-decremented LINE, not the shortfall.** That is what every existing
BackorderLine records (`qty: newItem.quantity`), and the receiving path clears
by it; changing the unit of the column is a separate decision. The fix only
makes the pairing consuming, so N bundle boxes of one product record one line
per decremented box instead of N per box. Cost if wrong: backlog still counts
whole lines, as it always has.

Context: `docs/plans/2026-09-25-customer-wallet.md` — D1, the customer wallet
(store credit). Owner's hard rule for the release: production must not break,
and the three live stores see no change after deploy.

**Ruling W-1 — stale `customer_wallet` overrides are reset to OFF by the
migration, and the API feature cache moves to a new namespace.** A read-only
production query (2026-09-25) found `store_features(palora, customer_wallet,
enabled=true)`, set 2026-03-23 by an enable-everything sweep while the key was a
hidden no-op (20 other keys were enabled with it, incl. the still-hidden
`email_campaigns`). Feature resolution is baseline-then-override and the key is
in no plan baseline (now pinned by `plan-baselines.test.ts`), so that one row
would have switched the wallet ON for a live store at deploy. The migration
runs `UPDATE store_features SET enabled = false …` (kept as an explicit off row
so it also holds if the key ever joins a baseline; verified locally on a seeded
row), and `features:store:` → `features:store:v3:` (v3 so it cannot collide with the email-campaigns release, #1939, which takes v2) so no cached `true` outlives
it. rollback.sql does not restore it; re-enabling is a manual super-admin
toggle. Cost if wrong: palora's merchant had in fact been relying on a wallet
that never existed — nothing to lose, the toggle did nothing.

**Ruling W-2 — spending the wallet at checkout ships behind a SECOND per-store
key, `customer_wallet_checkout`.** It is the only part of D1 that changes what
an order charges (gateway amount, COD collection, payment link, retry), so it is
switched on separately from the credit/admin/customer-view half. Both keys are
in no plan baseline. Every charging path reads `total − walletAmount`, which is
byte-identical to `total` for every order that did not use the wallet (the
column default, and every existing order). Cost if wrong: one more super-admin
toggle than strictly necessary.

**Ruling W-3 — wallet checkout is REFUSED while the store has accounting
enabled; the GL does not model store credit yet.** The chart of accounts has no
store-credit liability account, so `postOrderPaymentJournal` would book the
wallet portion as cash that never arrived. `WalletService.getCheckoutAvailability`
returns `accounting_enabled`, the admin Wallet page says so, and
`postOrderPaymentJournal` refuses (warn log) a wallet-paid order that reached it
anyway (accounting switched on between checkout and payment) — note that the WHOLE order then goes unjournaled, the cash actually collected included, not just its wallet portion; the warn log is the only trace until the GL follow-up. Store-credit
RETURNS keep today's GL treatment (reversed as if cash left — the same
pre-existing treatment `bank_transfer`/`cash` returns get). Measured: all three
live stores have `accounting_enabled = true`, and it is the column default — so
until a follow-up models account 2150 "Customer store credit" on issuance
(returns, admin credits), redemption (checkout), reversal and write-off
(erasure), and decides which account a goodwill credit hits, wallet checkout is
unusable on those stores even with both keys on. That follow-up needs a product
decision (where goodwill credits and forfeits land in the P&L), which is why it
is not guessed here. Cost if wrong: the checkout half of D1 is built, tested
and dark in practice until that follow-up lands.

_Amended 2026-10-01 (branch `fix/owner-money-decisions-1001`):_ account 2150
now exists (as "Customer Wallet Liability") and is credited by one path only —
a partial return whose refund lands in the wallet (M1-8 resolved). Everything
else this ruling lists — redemption, admin credits, reversal, erasure
write-off — is still not journaled, and wallet checkout is still refused while
accounting is on. See OMD-5.

**Ruling W-4 — erasure keeps the wallet ledger, nulls its notes and forfeits the
balance.** The ledger is a financial record of money the merchant owed and paid
out; once `note` (the only free-text field) is nulled it holds no PII. A
positive balance is written off with an `expire` entry because the anonymized
account can never sign in to spend it, and leaving it would overstate the
merchant's outstanding liability forever. The erase card warns the merchant when
a balance exists. Re-running an erasure stays safe (the forfeit key is tied to
the ledger position it zeroes). Cost if wrong: a customer who wanted the credit
paid out in cash loses it unless the merchant pays it out before erasing.

**Ruling W-5 — store credit for a return uses the gateway branch's allocator.**
Partial return: `cashCredit` (goods net of the discount share, plus tax; no
shipping), same as the provider refund. Full return: `cashCredit + shipping −
walletAmount`, because the whole-order fanout puts the checkout wallet spend
back separately. Exchanges never credit. With `customer_wallet` OFF,
`store_credit` keeps its old off-platform meaning. Cost if wrong: a merchant
who expected shipping back on a partial store-credit return adjusts it by hand.

**Ruling W-6 — pre-existing defects found while building D1 are REPORTED, not
fixed here.** Each fix changes behaviour on the live stores, which this
release's owner rule forbids; each gets its own change:
(a) the storefront's loyalty page and checkout redemption call
`/api/v1/public/:storeId/loyalty/*`, which 404s in production (measured
2026-09-25; the real path is `/api/v1/stores/public/…`), so both silently treat
loyalty as disabled — the wallet uses the correct path and a contract test pins
it; (b) by reading, the backorder single-line cancel fires the WHOLE-order `order/refunded`
event, reversing the coupon, affiliate commission and loyalty for the entire
order (the wallet reversal alone is opted out via `reverseWallet: false`);
(c) by reading, `rollbackForPaymentFailure` does not re-credit redeemed loyalty points and
stamps `refundReversedAt`, so the fanout never does either (the wallet spend IS
reversed there); (d) by reading, a manual-method refund (off-platform
store credit, bank transfer, cash) is not netted against a later full gateway
refund of the same order; (e) the storefront account menu labels and "Sign Out"
are English-only (the new Wallet entry is bilingual). Cost if wrong: each stays
live until its own PR.

**Ruling W-7 — erasure scope: a store deletes ONLY its own data (owner decision,
Ahmad, 2026-09-26).** A MERCHANT-initiated customer erasure
(`POST /stores/:storeId/customers/:customerId/erase`) passes `scopeStoreId` to
`AuthService.eraseAccount`: the account must be that store's own customer
(`user.storeId === scopeStoreId`, else 404), and the wallet note scrub + forfeit
run only on that store's rows, with no RLS bypass. The shopper's OWN account
erasure (`POST /auth/me/erase`) and the `soft-deleted-user-anonymize` retention
cron pass no scope and may span every store: the wallet statements run inside
`withScopedRlsBypass` (restores the prior GUC in a `finally`, #2037), and each
store whose balance that run forfeited OR whose ledger notes it scrubbed (not
every store holding a wallet, and nothing on a re-run — issues 2122/2125, PR
2279 audit) gets its own `audit_logs` row (`customer.wallet.erased`, that
store's `storeId`, `details.actor` = the acting user id or `'system'`) so a
store whose liability changed without any action of its own can see why.
CORRECTED 2026-10-01 (issue 2126): "can see why" is not true today — the only
audit-log viewer is the super-admin `/audit-logs` page, and an erased
customer's wallet drops off the store's wallet list at a 0 balance, so no
store_admin surface shows the write-off. Giving merchants a store-scoped audit
view (which would also expose staff IPs / user agents and platform actions on
their store) is an owner decision, left open on issue 2126. Every
`expire` ledger entry carries the actor in `actorId`. Supersedes the #1957
design (bypass on every path) in PR #2015. The other erasure statements
(orders, reviews, carts, loyalty, push) keep their existing shape: after this
ruling the merchant path can only reach a store-scoped customer, whose rows are
that store's. Cost if wrong: a legacy `store_id = NULL` shopper who asks a
MERCHANT to erase them keeps their wallet in other stores until they erase
their own account (the merchant route cannot reach such an account at all).

---

Context: `docs/plans/2026-09-25-email-campaigns.md` — D2 email campaigns, shipped behind the
per-store `email_campaigns` feature key (in no plan baseline, so OFF for every store).

**Ruling EC-1 — the audience is newsletter subscribers only; customers are not a source.** The spec
allowed "customers with a marketing-consent flag if one exists". None exists: `Customer` has no
consent column and `Order.smsOptIn` is SMS-only and per order (`schema.prisma`, grep "consent" /
"marketing"). Having bought once is not consent to marketing email. A recipient's `customer_id` is
linked for display only and never widens the audience. Cost if wrong: merchants reach fewer people
than they expect until a checkout email-consent checkbox exists — a reach cost, never a consent
breach.

**Ruling EC-2 — "confirmed subscriber" means `is_active = true AND unsubscribed_at IS NULL`; there is
no double opt-in.** `newsletter_subscribers` has no confirmation field and the storefront signup
(`public.routes.ts /newsletter/subscribe`) activates on submit. Adding double opt-in would change a
live signup flow on 3 stores. Cost if wrong: an address someone else typed into a store's footer
can receive that store's campaigns until it clicks unsubscribe — mitigated by the one-click
unsubscribe and the per-store 24h cap.

**Ruling EC-3 — on an enqueue failure the campaign returns to `draft`, not `failed`.** The spec says
"if the Inngest send throws, mark the campaign failed". The send route answers 503, and a 5xx rolls
back the whole request transaction (`middleware/request-transaction.ts`), so the `draft → scheduled`
flip is undone and a `failed` write would be undone with it. The outcome the rule exists for — no
campaign left `scheduled` with no job behind it — holds, and the merchant can simply press send
again. The job-side failure path (`onFailure`) does mark the campaign and every still-queued
recipient `failed`. Cost if wrong: an enqueue failure leaves no persistent trace on the campaign
itself — it is in the API error log and the merchant saw the 503.

**Ruling EC-4 — the request sends the Inngest event inside its own transaction, and the job treats
`draft` as "not committed yet" and retries.** `deferAfterTenantCommit` would remove the race but
turns an enqueue failure into a post-response event with nothing to retry it, i.e. a campaign
stuck `scheduled`. `scheduledAt` travels in the event as a per-request nonce: the claim and
`onFailure` only act when `campaigns.scheduled_at` still equals it, so an event from a rolled-back
or superseded request can neither send nor fail a newer one. Cost if wrong: a send whose COMMIT
fails after the event went out burns up to 5 job attempts on a campaign that stays `draft`.

**Ruling EC-5 — the storefront unsubscribe link lands on a confirm page; the GET never
unsubscribes.** Link scanners (Outlook Safe Links, corporate gateways) and mail-client previews
fetch GET URLs automatically; an unsubscribe-on-GET would silently withdraw consent for people who
never clicked. True one-click is the RFC 8058 `List-Unsubscribe-Post` header, which the mailbox
provider POSTs. Cost if wrong: a subscriber clicking the body link needs one more tap.

**Ruling EC-6 — the legacy newsletter broadcast was fixed for the address leak but NOT migrated
onto campaigns.** It sent each 50-address chunk as one email with all 50 in `to:`, disclosing every
subscriber to every other; it now sends 50 separate emails per Resend batch call (same call count).
It still sends inline, has no unsubscribe link and no cap. Retiring it changes a live merchant
surface on 3 stores and is outside this change. Cost if wrong: until it is retired or gated behind
campaigns, a broadcast is an unsubscribable, uncapped bulk send through the platform sender —
recommended follow-up: hide the broadcast button once `email_campaigns` is on for a store.

**Ruling EC-7 — `CampaignRecipientStatus.bounced` exists but nothing sets it.** There is no Resend
webhook handler in the API (`grep -rn "email.bounced\|svix" apps/api/src` → none). The value is
reserved so a later webhook needs no enum migration, and the admin renders it. Cost if wrong: a
hard-bouncing address stays `sent` and keeps being mailed by later campaigns, which slowly costs
sender reputation — the next piece of work for this feature.

**Ruling EC-8 — the test send and the AI draft run inline in the request.** _(Test-send half
SUPERSEDED by Ruling R3-2, #1954 — the AI-draft half stands.)_ Both are one external
call made by a merchant who is waiting for the result (one Resend send to their own address; one
Gemini call, quota-capped, the same shape as every other `/stores/:id/ai/*` suggestion route).
Neither fans out. Cost if wrong: a slow Gemini response holds one tenant transaction open for its
duration (bounded by the 30s transaction timeout).

**Ruling EC-10 — the migration resets every `email_campaigns` override to OFF, and the feature
cache moves to a new Redis prefix.** Production had one stale row (palora, `enabled = true`, read-only
check 2026-09-25) from when the flag was hidden and did nothing; without the reset, palora would have
live campaign sending the moment this merged. `UPDATE store_features SET enabled = false WHERE
feature_key = 'email_campaigns'` is the migration's only data write. It only ever sets false, and
`tests/unit/campaign-migration.test.ts` fails if it is changed to true or removed (mutation-checked).
`rollback.sql` deliberately does not restore `true`: re-enabling is a manual super-admin toggle.
`feature.service.ts` `CACHE_PREFIX` moved to `features:store:v2:` so a map cached before the UPDATE
(TTL 300s) is never read by the new release. Cost if wrong: palora loses an "enabled" flag that never
did anything, and every store's feature map misses the cache once after deploy (single-flight
protected).

**Ruling EC-9 — super-admin still bypasses the feature gate.** `requireFeature` lets `super_admin`
through on every feature by design (`middleware/feature-gate.ts`). A super-admin can therefore
create and send a campaign for a store whose feature is off — but only by explicitly creating and
sending one. Cost if wrong: platform staff can send on a merchant's behalf without the merchant
having enabled the feature.

---

Context: the pre-clone finish program (Ahmad, 2026-09-25): every unfinished
FWB item is finished before the repo is cloned into Ebda (Whisky 11, Egypt).
Branch `fix/pre-clone-batch-a`.

**Ruling PC-1 — the Force Media (`forcemediakw.com`) allowlist entries stay.**
The 2026-06-27 rebrand sweep never landed on main, and ~70 references remain.
Almost all of them are CORS/CSP/platform-host allowlists and comments, and the
legacy hosts are still live: on 2026-09-25 `store.forcemediakw.com` 301'd to
`store.force-ai.co`, `app.forcemediakw.com` 301'd to `admin.force-ai.co`, and
`store-api.forcemediakw.com` still CNAMEs to the Railway API. Removing them
would break every old link and bookmark that still reaches the platform. Only
the user-facing stale values changed: the Swagger contact/terms/server URLs,
the `INNGEST_SERVE_HOST` example in `apps/api/.env.example` and
`docs/ENVIRONMENT.md`, and the boot warning's example. Cost if wrong: the old
hosts stay reachable as an attack surface; revisit when their DNS is retired.

**Ruling PC-2 — non-KWD money (closed PR #1689) is built in Ebda, not FWB.**
FWB stays KWD-only, which is why #1689 was closed, and its fix was incomplete
(the write path still stores `price * 1000` for every currency). Ebda prices
in EGP (2 decimals), so the currency-aware money layer is Ebda's first task
after the clone. Cost if wrong: FWB becomes 10× wrong the day it takes a
non-KWD store; the currency default is KWD everywhere, so that needs a code
change first, not an accident.

**Ruling PC-3 — the storefront shimmer/stagger (design batch item 3) stays removed.**
The audit flagged `.shimmer` and the empty stagger class as unfinished work.
They are not: Ahmad had them reverted as a P0 on 2026-07-13 (PR #726) after
the always-on shimmer made every image slot on wadyaljuz flicker and sweep
rightward, even in RTL. PR #726 kept the keyframes on purpose for a future
skeleton wired to real image-load state. Cost if wrong: none today; building
that skeleton is new work, not unfinished work.

Context: issue #1841 — a scoped audit found the SR-7 "Go Home" suppression
(below) over-broad.

**SECOND CORRECTION to SR-7 — the suppression is platform-host-scoped, not
global.** The first correction (2026-09-16, below) fixed a real defect — the
link walking a platform-host shopper onto `force-ai.co` — but then suppressed
"Go Home" on EVERY host during a transient, including custom domains, where
its own text already said "Custom-domain stores were never affected." On a
custom domain (`wadyaljuz.com` etc. — the majority production configuration)
`useStoreUrl`'s prefix is `''` regardless of whether the store resolved for
THIS request, so `storeUrl('/')` is `/`, which on that host already IS the
merchant's storefront home — there is no platform pitch to redirect to.
Suppressing it there took away a working escape route for no reason, and
combined with Ruling SR-5 (8 of 11 store-resolving routes have no chrome) left
a custom-domain shopper on a page with zero links. `RouteErrorFallback.tsx` now
gates the suppression on `useIsPlatform()` (new hook, `StoreContext.tsx`) as
well as `isTemporarilyUnavailable`: hidden only when both are true. Same defect
shape as the first correction — a narrow rebuttal ("the link resolves to `/`")
that stopped one line short of asking what `/` means on THAT host. Cost if
wrong: a platform-host shopper could again see "Go Home" during a transient if
`isPlatform` is ever miscomputed — mitigated by seeding it server-side from
`middleware.ts`'s `x-is-platform` header (Ruling below, same commit) rather
than trusting only the client re-detection.

**Ruling — `StoreContext`'s `isPlatform` is now seeded server-side, not
discovered only in a `useEffect`.** `useStoreUrl`'s `isPlatform` used to start
`false` on every render and correct itself after mount via
`isPlatformHost(window.location.hostname)`, so the server-rendered HTML on a
platform host shipped a bare `/` home href before hydration — reachable by a
pre-hydration click or a crawler following the raw href (issue #1544).
`middleware.ts` already computes this exact answer and sets `x-is-platform`;
`layout.tsx` now reads it and passes `initialIsPlatform` into `StoreProvider`,
which seeds `isPlatform` state from it (falling back to the old client-only
detection when the header is absent, so no caller can fail to compile or lose
behaviour). `useStoreUrl()` and the new `useIsPlatform()` hook both read this
one context value instead of each re-deriving it. Cost if wrong: a route that
somehow bypasses `middleware.ts` (none known) would see the pre-existing
client-only behaviour, unchanged from before this fix.
Context: branch `fix/p2-r2-money` — money batch R2 (18 issues: refunds, returns,
order lifecycle, VAT report, checkout). Owner rule for the batch: nothing changes
how buying or paying works unless an issue requires it. PRs #1969 (returns and
refunds) and #2007 (order lifecycle) were open, unmerged, on the same files.

**Ruling R2-1 — #1207, #1351, #1209 and #1455 are left for the owner, under the
questions #1969 already asks (its Rulings M1-7 and M1-8).** All four are "which
GL account and which amount" decisions: the partial-return cash credit uses the
pro-rata figure and the provider cash account for every refund method, and a
partial refund made outside a return (order-page refund-via-provider, or the
provider dashboard) posts no journal at all. Re-verified on main 2026-09-25.
Answering them here would pick an account, or an amount-only journal shape, that
#1969 asks the owner to pick, and would collide with its rewrite of
`return.service.ts complete()`. Cost if wrong: those refunds keep posting to the
provider cash account at the pro-rata amount, or not posting, until the owner
answers; #1969 makes the no-journal case raise a P1.

**Ruling R2-2 — #1361, #1474 and #1479 are fixed by #1969, not re-fixed here.**
#1969 moves the return completion claim into the request transaction (a crash
rolls it back, so it cannot strand a return: #1361) and rewrites the refund
method dialog so it preselects nothing and disables "Original payment method",
with the reason, for a COD order and for an exchange (#1474, #1479). Doing either
again on main would conflict with every hunk of that PR. Cost if wrong: if #1969
is abandoned, the three stay open and need their own change.

**Ruling R2-3 — #1956 (partial gateway refund on a wallet-paid order) is left
until #1969 merges.** The fix lives in the partial-gateway branch of
`ReturnService.complete()`, the body #1969 restructures, and splitting a refund
between the gateway and the wallet is a customer-visible choice. It cannot bite
today: `customer_wallet` is off for every store (Ruling W-1), and wallet checkout
is refused while accounting is on, which it is on all three live stores (Ruling
W-3), so no live order has `walletAmount > 0`. Cost if wrong: the first store to
enable wallet checkout with accounting off gets a 409 on a partial return of a
wallet-paid order, and has to pick store credit.

**RESOLVED 2026-10-01 (branch `fix/owner-money-decisions-1001`) — owner decision
(Ahmad): the partial refund is split pro-rata to the original payment mix;
rounding to fils is deterministic and any remainder goes to the card.**
`splitByPaymentMix` (partial-return-allocation.ts) is cumulative like the
discount/tax allocation: the wallet is owed `floor(cash × walletAmount / total)`
of everything refunded so far, so the card's cumulative share is at most
`ceil(…)` ≤ what the card paid and the last piece never overshoots the payment
(a per-refund floor did: 2.701 against 2.700 left, measured by mutation). The
gateway gets only its share; the wallet share is credited with key
`return-wallet-share:<returnId>`, and `WalletService.reverseOrderPayment` nets
those shares out of a later whole-order reversal. The preview and the admin
confirm step show both amounts. See OMD-5 and OMD-6.

**Ruling R2-4 — #1705 (non-KWD formatting in invoices and emails) is declined
under Ruling PC-2.** FWB is KWD-only; the `/1000`, three-decimal, `KWD` output is
correct for every order it can hold, and the currency-aware money layer is built
in Ebda. Cost if wrong: the same as PC-2's.

**Ruling R2-5 — #1948 (the refund notice is claimed at CANCEL, before money
moves) needs the owner.** Cancelling a paid order fires the `order/refunded`
fanout with notify, which emails "Refund issued" for `order.total` and claims the
once-per-order notice, so the real settlement later sends nothing. Every fix
changes what customers of the live stores are told: send nothing at cancel (a
paid order refunded off-platform would then never produce a notice), or add a
"cancelled, refund pending" message (new EN and AR copy, and a new dispatcher key
that merchants' WhatsApp templates would need), or re-notify when a different
amount settles. Question for the owner: at the cancel of a paid order, before any
money moves, what should the customer receive? Cost if wrong: until answered, a
merchant who refunds a different amount than the total leaves the customer with
the wrong figure.

**Ruling R2-6 — #1049 (receipt photos downscaled to 2000 px before OCR) needs
evidence, not a guess.** Raising the ceiling costs memory and Gemini tokens on
every receipt; keeping it may cost OCR accuracy. Neither can be settled by
reading the code, and no representative receipt set exists in the repo. What
would settle it: the owner's real receipts, OCR'd at native size and at 2000 px,
compared field by field. Cost if wrong: small-print receipts keep extracting
worse than they could.

**Ruling R2-7 — #1946: pre-marker rollbacks are recognised in code, not
backfilled.** The fanout now treats the exact row the old rollback wrote
(`inventory_history.type='adjustment'`, reason `Order rollback — payment step
failed`, reference = the order) as both its stock marker and its coupon marker.
No production row is written, and the match is on a server-written reason, never
on `orders.notes` (shopper input at checkout). Residual: an order rolled back
before 2026-09-25 whose every line had `trackInventory=false` wrote no stock row,
so if it also had a coupon, refunding it would release that coupon once more.
Production could not be queried from this session (neonctl was not
authenticated), so the size of that set is unmeasured; `SELECT count(*) FROM
orders WHERE notes LIKE '%[auto-cancelled: payment step failed before
completion]%' AND coupon_code IS NOT NULL` against the rows with no matching
`inventory_history` would settle it. Cost if wrong: one coupon redemption handed
back to that coupon's limit, per such order refunded.

**Ruling R2-8 — #1935: the refund email goes on the durable queue, and a failure
that still happens fails the run instead of adding a re-send sweep.** A Resend
outage is now retried by `email-queue` (3 attempts) like every other
order-lifecycle email. A failure to render or enqueue it releases the
`refund_notified` claim after every reversal has committed and throws a
NonRetriableError, so `alerts-failure-watch` raises a P1 and replaying the event
notifies the customer. A notify-capable sweep was not added: it would be a new
cron and a second producer of the customer notice, which the claim exists to
prevent. Residual: an email that exhausts the queue's retries lands in
`email:failed`, which no UI shows — true of every queued email today. Cost if
wrong: a customer is told late, after an operator replays the event.

**Ruling R2-9 — marking an order Refunded from the order page or the orders PWA
asks for confirmation.** #1936 and #1947 make "Refunded" the primary action on a
paid, cancelled order. It records a refund without moving money, which is the
confusion #762 is about, so both pages confirm first, reusing #2007's list-page
copy (same keys and text in the admin, so the two merge as one). Cost if wrong:
one extra tap for the merchant.
AMENDED 2026-10-01: the confirm covers EVERY state that offers `refunded`, not
just `cancelled` — a paid `delivered` order now shows it too, because the
footers derive finality from the shared transition map (issue 2144). The
admin copy is status-aware (issue 2140): a cancelled order gets
`manualRefundDescriptionCancelled`, which does not promise the stock, coupon,
loyalty and customer-notice effects that already ran (or were claimed) at
cancellation.

---

Context: branch `fix/inngest-webhook-rate-limit-exempt` — the global 200
mutations/15min per-IP limiter (`apps/api/src/index.ts`) sits in front of
`/api/v1/inngest` and `/api/v1/webhooks`. Inngest Cloud executes every
function STEP as its own POST from a small, fixed pool of IPs (an order
fanout is ~12 steps; cron sweeps run many functions back to back), so a busy
period can push one Inngest IP past 200/15min and get 429'd — a local harness
reproduced exactly this, delaying/retrying order emails, refunds and stock
restore.

**Ruling RL-1 — `POST /api/v1/inngest` is exempted from the global limiter on
`x-inngest-signature` HEADER PRESENCE, not on verifying it in the skip
predicate.** `skipGlobalRateLimit` (`middleware/global-rate-limit-skip.ts`)
only checks the header exists; the actual HMAC check is `inngestServe`'s
(mounted in `index.ts`), which runs on every POST regardless of whether the
global limiter counted the request. Verified against the installed
inngest@4.2.6 source (`srcof inngest@4.2.6`): `InngestCommHandler
.validateSignature` (`src/components/InngestCommHandler.ts:2623-2652`) throws
when `sig` is falsy and `client.mode === 'cloud'`, and otherwise verifies the
HMAC via `RequestSignature.verifySignature` against `signingKey` (+
`signingKeyFallback`); `handleAction` (same file, ~1594-1609) awaits that
result for every POST and returns `{ status: 401 }` **before** touching
`this.fns` or running any step when it did not succeed. `lib/inngest/
client.ts` sets `isDev: config.nodeEnv !== 'production'`, so production is
always `cloud` mode — an unsigned or forged-signature POST is rejected before
any function code runs, so skipping the RATE-LIMIT COUNTER on header
presence alone costs nothing an attacker without `INNGEST_SIGNING_KEY` can
use. Only `POST` on the exact path `/api/v1/inngest` matches (mutation-tested
against a stripped signature check, a lookalike path, a `..`-traversal path,
and a non-POST method — all KILLED, `defence-mutations.json` id
`inngest-bypass-requires-signature-header`). Cost if wrong: if
`INNGEST_SIGNING_KEY` were ever unset in production, `validateSignature`
throws its OWN error ("No signing key found…") before ever reaching the `sig`
check — so a missing key fails the Inngest platform integration outright,
loudly, rather than opening a quiet hole; it does not silently degrade this
bypass into an open one.

**Ruling RL-2 — the payment-provider webhook routes (`/api/v1/webhooks/
payment/:provider`, `/api/v1/webhooks/payment`) are NOT exempted from the
global limiter.** Read `webhook.routes.ts`: `verifyWebhookSignature` only
checks that a signature HEADER is non-empty — any string satisfies it. The
real HMAC check (`PaymentService.handleWebhook` → `p.verifyWebhook`,
`payment.factory.ts:964-1005`) runs only AFTER `enqueueOrProcessWebhook` has
already durably persisted the raw payload to the `webhook_events` inbox and
called `inngest.send()` — on the common path (Inngest reachable) that HMAC
check happens later still, asynchronously, inside the Inngest consumer, well
after this route already answered 200. So the route "acts" (a DB write +
queue send, both attacker-reachable resource costs) before verifying
anything — it does not satisfy "verifies before acting", the bar the
Inngest exemption above clears. These routes keep riding the global 200/
15min bucket as their only bound today. The shipping-carrier routes under
the same mount (`/shipping/icarry`, `/shipping/aramex`) DO verify
(`verifyCarrierWebhookSecret`, timing-safe, fail-closed) synchronously
BEFORE calling `shippingCarrierService.processWebhook` — but they are out of
this PR's scope (the reported incident and the task were payment webhooks +
Inngest) and are left untouched. Cost if wrong: unauthenticated garbage POSTs
to the payment webhook routes still cost a `webhook_events` row + an Inngest
enqueue before being rejected, and remain capped only by the shared 200/
15min-per-IP bucket alongside every other mutation from that IP — a
follow-up that reorders verification before persistence (or adds a
dedicated, still-bounded bucket per the pattern used for `/auth/refresh`)
is the natural next step if this is ever measured as a real flood vector.

## 2026-09-16

Context: `docs/plans/2026-09-16-store-resolve-transient-not-404.md` — a transient
store-resolve failure (429/5xx/network) was rendered to shoppers as a branded
404 "store not found". Implements **F2** of the 2026-09-15 investigation, whose
Ruling S1 deferred the decision rather than rejecting it; Ahmad approved this
fix, and only this one, on 2026-09-16.

**Ruling SR-1 — `getStoreById()` keeps its `null`-on-any-failure contract.**
Its siblings `fetchStoreByDomain`/`fetchStoreBySlug` now split 404 (miss) from
everything else (transient); `getStoreById` does not. All 5 of its references
are the definition, its import in a test, and 3 test assertions — it has zero
production callers and sits on no shopper's 404 path, and its existing
`503 → null` assertion in `store-resolve-logging.test.ts` is a deliberate
regression gate. Cost if wrong: a future admin surface that adopts it inherits
the transient-as-miss bug — mitigated by a doc comment at its definition
telling the next caller to split it first.

**Ruling SR-2 — the retry page ships as HTTP 500, not 503 + `Retry-After`.**
Next 16.2.11 permits only 404/403/401 as deliberate statuses from a page render
(`http-access-fallback.js`: `HTTPAccessErrorStatus = {NOT_FOUND:404,
FORBIDDEN:403, UNAUTHORIZED:401}`; `forbidden()`/`unauthorized()` additionally
require `experimental.authInterrupts`). Only Route Handlers can set an arbitrary
status, and none is on this path. Rewriting 500→503 in the OpenNext Worker entry
was rejected because `scripts/cf-setup-local.sh` GENERATES that entry at build
time, so the edit would be silently discarded on the next deploy. The defect
being fixed is "404 tells the shopper the shop is gone and tells Google to
deindex it"; 500 already fixes both, and Google retains a URL across 5xx.
Cost if wrong: uptime/DAST tooling keeps counting these as server faults rather
than backpressure — the F1 complaint, inherited rather than introduced.

**Ruling SR-3 — the same defect class in `agent-store-resolver.ts` and
`sitemap.ts` is reported, not fixed.** Both still do `if (!res.ok) return null`
(or `break`), so during a 429 burst `/llms.txt` and `/.well-known/*` serve the
PLATFORM document instead of the merchant's, and the sitemap silently truncates.
Both are bot-facing, not shopper-facing, and today's approved scope is this fix
only. `ProductDetailBody.tsx:139` (F1) is excluded for the same reason.
Cost if wrong: crawlers see a platform document or a short sitemap during a
burst — an SEO cost with no customer impact, and one small PR to close later.

**Ruling SR-4 — the retry page carries NO `noindex`; the HTTP 500 is the
indexing guard.** A draft rendered `<meta name="robots" content="noindex,nofollow">`
inside the fallback body and the plan presented it as delivered protection. It
was inert, and measured rather than assumed: `<meta>` hoisting into `<head>` is
a React 19 feature, `require('react/package.json').version` is **18.3.1**, and
the root `package.json` `overrides` hard-pins `"react":"18.3.1"` — so the tag
rendered in `<body>`, where Google ignores robots directives. Removed rather
than left as protection-shaped dead weight. A server-component throw returns
500, which crawlers treat as temporary and which does not deindex, unlike the
404 this work removes. Cost if wrong: during a long 429 burst a crawler could
index a retry page it fetched at 500 — contradicting its own status — and the
fix is a `head`-level tag or a React 19 upgrade, not a body tag.
NOTE: `components/StoreMaintenance.tsx:63` has the IDENTICAL inert in-body
`robots` meta for the suspended-store page. Pre-existing and outside this
fix's approved scope — reported, not changed.

**Ruling SR-5 — 8 of the 11 store-resolving pages keep the chrome-less root
boundary.** Only `/products`, `/products/[slug]` and `/bundles/[slug]` have a
segment boundary that wraps the fallback in `ShopChrome`; the homepage,
`/categories`, `/bundles`, `/blog/[slug]`, `/about`, `/contact`, `/faq`,
`/how-to-guides` and `/locations` fall through to the root boundary and render
without header/nav/footer. The retry COPY — the deliverable of this work — is
correct on all 11; only the chrome differs, and that gap predates this change.
Adding 8 boundaries is a presentation change outside today's approved scope.
Cost if wrong: a shopper who hits a transient on the homepage sees a bare
centered retry card instead of the branded storefront chrome, which reads as
more broken than it is.

**Ruling SR-7 — the transient fallback is flagged, so the retry page is no
longer TITLED "Page not found".** Review found that during the exact scenario
this work serves, the layout's lenient `getStore()` returns `DEFAULT_STORE`
(`id:'demo'`) and `generateMetadata` hits that sentinel, emitting
`title: 'Page not found — Force AI'` around the new retry body — the removed
claim, relocated from the body to the `<title>`, where it reaches the tab,
bookmarks and link previews. `lenientResolve` now reports WHICH `null` it
produced, `getStore()` returns a `transientResolveFailure`-flagged fallback,
and the layout emits store-neutral "Temporarily unavailable" metadata with
`robots: noindex` for it. Two residuals are accepted, not fixed: the retry page
still paints with `DEFAULT_THEME` and the "Force" name, because during a
transient the merchant's brand is genuinely unknown and inventing one is worse;
and SR-4's "no noindex" refers to the BODY — the layout's metadata does emit a
head-level `robots: noindex` on this path, which is the correct place for it.
Cost if wrong: a crawler that fetched the retry page at 500 sees a neutral
title instead of the merchant's, which is the intended trade.

**CORRECTION to SR-7 (same day, next review pass).** An earlier version of this
ruling rebutted a reported dead `/demo` "Go Home" link by concluding "the link
is `/`" — technically right and materially wrong, because `/` is not the
merchant's home on the platform host. Measured: `curl -sI
https://store.force-ai.co/` returns `307 → https://force-ai.co`. So on a
path-based store the retry page's only non-retry control walked a merchant's
shopper onto the Force platform pitch — the HARD multi-tenant rule in
`app/not-found.tsx`. The link is now suppressed on the transient branch
entirely: during a transient there is no known home to offer, and "Try Again"
is the correct action. Custom-domain stores were never affected. This is the
second time a narrow rebuttal hid a wider defect — rebut the MECHANISM, not the
sentence.

**Scope correction to SR-7 — which routes the new title actually reaches.** In
Next's metadata merge a page's own export wins over the layout's, and nearly
every store-resolving route defines a title: `products/page.tsx` exports static
`title: 'Products'`, `products/[slug]` and `bundles/[slug]` return
`{title:'Product'}`/`{title:'Bundle'}` from their own demo-sentinel branch, and
categories/about/contact/locations/bundles/faq/how-to-guides all export static
metadata. So the layout's "Temporarily unavailable" title is visible chiefly on
the HOMEPAGE — which is also the only route where the old "Page not found —
Force AI" title was ever visible, so the bug and the fix have the same reach.
The `robots: noindex` half DOES inherit on every route. Extending the title to
the PLP/PDP means touching each page's own metadata export and is deliberately
not done here.

**Ruling SR-8 — "Try Again" now refreshes the route; two related findings are
declined with reasons.** Review found the retry button called the BARE `reset`.
Confirmed in Next's own `client/components/error-boundary.js`: the boundary
defines `reset = () => setState({error:null})` AND
`retry = () => startTransition(() => { context?.refresh(); reset(); })`, and
passes `reset` to the component — so bare `reset` re-renders the same failed
server payload. Because the transient branch suppresses "Go Home", that button
is the page's ONLY control, and a retry that cannot recover makes the page a
dead end during exactly the outage it exists to survive. Now mirrors Next's
`retry`. A headless-Chromium render of a forced transient confirms the page
itself is sound — retry body present, "Try Again" present, "Go Home" absent,
zero uncaught page errors, so the added `useRouter` hook is safe inside a
boundary. The CLICK is still not verified: proving recovery needs a browser
that flips the API back to healthy mid-session. The wiring is gated by a source
assertion in the meantime.

Declined, with reasons:

- **`global-error.tsx` keeps bare `reset`.** It renders only when the ROOT
  LAYOUT itself failed, which is the one case where the App Router context a
  `useRouter()` refresh depends on may not be mounted — Next's own boundary
  guards that call with `?.` for the same reason. Adding a hook that can throw
  to the last-resort surface trades a certain catastrophic failure for an
  uncertain recovery. Cost if wrong: a shopper on a root-layout failure must
  reload the tab manually, which is today's behaviour.
- **"Go Home" stays suppressed on custom domains too**, not just the platform
  host where the `307 → force-ai.co` leak was measured. During a transient the
  API is unreachable for every route, so the merchant's home page would render
  the same retry body — the link would lead from one retry page to another
  while implying escape. "Try Again" is the honest single action on both host
  types. Cost if wrong: a custom-domain shopper loses a home link they could
  have used had the outage been route-specific rather than API-wide.
- **`StoreMaintenance.tsx:63`'s inert in-body robots meta is still only
  REPORTED** (SR-4). It is a real SEO hole — the suspended-store page returns
  HTTP 200, so unlike the retry page it has no status-code guard behind it —
  but it predates this work, belongs to the suspended-store path, and today's
  approved scope is this fix. Cost if wrong: a suspended merchant's maintenance
  page stays indexable until a one-line follow-up lands.

**Ruling SR-6 — the `role="status"` live region is withdrawn, not restated.**
It was added to announce the boundary swap after a client-side navigation. A
live region inserted TOGETHER with its content is generally not announced by
NVDA/JAWS/VoiceOver, and wrapping the `<h2>` in one can make the heading read
as flat live-region text — so the comment claimed a benefit that probably does
not exist while carrying a real cost. The pattern that works is moving focus to
the container, which requires a real screen-reader verification this session
could not run. `aria-hidden` on the state-carrying icon is kept (that one is
unambiguous). Cost if wrong: a screen-reader user gets no announcement when the
retry page replaces a page after client-side navigation — the same behaviour as
before this work, not a regression.

---

## 2026-09-11

**Ruling SSRF-1 — the ESLint SSRF selector stays scoped to `routes/**`; the
carrier class is enforced by a registry test instead.\*\*

`docs/plans/2026-09-02-adversarial-audit-remediation.md` Task 5 Step 4 called
for widening the selector to `services/**`. Measured before deciding: widening
produces **36 errors across 17 files**. All but iCarry's four are a URL built
from deployment config, not request input —

- all four payment providers (`hesabe`, `myfatoorah`, `tap`, `upayments`) set
  `baseUrl` from a hardcoded constant chosen by an `isTestMode` boolean, so
  **the money path was never exposed**;
- `aramex.carrier.ts` uses a module-level `ARAMEX_BASE_URL`;
- `sms.service.ts` (`UNIFONIC_API`), `onesignal.service.ts` (`ENDPOINT`),
  `wbs-bridge`, `gsc-client`, `cloudflare-domain`, `meta-provisioner`,
  `pixels-capi`, `privacy-propagation`, `alerts`, and the two answer-engine
  providers all build from `process.env` / `config`.

A 17-entry allowlist is exactly the rule the original scoping note predicted
people would learn to silence, and an `eslint-disable` comment silences it for
free. The class is instead enforced by a registry gate in
`tests/unit/carrier-ssrf.test.ts`, which reads every `*.carrier.ts` source and
fails when one declares a merchant-supplied `baseUrl`, calls `fetch()`, and
does not route it through `lib/safe-fetch` (extended by Ruling SSRF-2 to also
fail on a _bare_ `fetch(` in such a carrier). Mutation-verified: adding an
unguarded carrier reddens it; removing the guard from iCarry reddens 22 of the
28 tests the file had at the time of this ruling.

Cost if wrong: a future service outside `services/carriers/**` that accepts a
URL from request input escapes both the ESLint rule and this gate, and would
need the same review that missed iCarry for a year.

---

**Ruling SSRF-2 — a pre-flight `assertPublicHttpUrl` is only half the guard;
the carrier calls go out through `safeFetch`, and DNS rebinding stays a
documented residual.**

Review of the SSRF-1 fix found it still exploitable. `assertPublicHttpUrl`
validates the FIRST URL only, and `fetch` defaults to `redirect: 'follow'`, so
a merchant sets `baseUrl` to a host they own that resolves publicly — the
assert passes — and that host answers `302 Location:
http://169.254.169.254/latest/meta-data/…`. undici follows it and
`testConnection` hands the status and `body.message` back: the same oracle the
fix claimed to close, one hop later, reachable from all four methods. The unit
tests missed it because every URL they fed in was a literal private address,
which the assert catches on the first pass.

So the fix is the transport, not the assert. All four call sites use
`safeFetch` (`lib/safe-fetch.ts`), which follows redirects manually and
re-validates every hop; the pre-flight assert stays as the fail-fast that
answers the merchant with `SSRF_BLOCKED` before any request goes out. Following
redirects by hand means re-implementing two things the `follow` path did for
us, both now in `initForHop`: credentials (`authorization`, `cookie`,
`proxy-authorization`) are dropped on a cross-origin hop, so a merchant's
carrier API key is not handed to a host their redirect chose, and 301/302/303
downgrade the method to GET without a body, so a shipment payload is never
re-POSTed to a redirect target.

**Residual accepted: classic DNS rebinding.** The address is resolved at check
time and again by `fetch` at connect time, so a low-TTL record can answer
public then private. Closing it needs a lookup-pinning dispatcher, which is a
change to every `safe-fetch` caller (the image/logo path included) and is
documented in that file's header as disproportionate for the merchant-URL
threat model. The redirect hole was a one-request exploit from the admin UI;
rebinding needs attacker-controlled authoritative DNS and a race, and the
blocklist still refuses the answer whenever the private address is the one
returned at check time.

Cost if wrong: a merchant who can run their own low-TTL authoritative DNS still
gets one request against the API host's network, with the response body
described back to them by `testConnection`.

---

**Ruling SSRF-3 — the carrier registry gate was weaker than SSRF-1 claimed.**

SSRF-1 declined the ESLint widening in favour of a registry gate in
`tests/unit/carrier-ssrf.test.ts`. The scoped audit then showed that gate had
three evasions **inside the directory it covers**, which SSRF-1's "cost if
wrong" paragraph understated as "a future service outside
`services/carriers/**`":

2. **The gate was weaker than claimed.** Keying on the literal name `baseUrl`
   and on import presence left three evasions inside the very directory it
   covers: a field named `apiUrl`/`endpoint`/`host`, a credentials interface
   declared in the sibling `types.ts`, and an import used on three of four
   fetch paths. It now strips comments (its first run failed on iCarry's own
   docstring — the defect already filed as #1678 against another gate), scans
   every `.ts` in the directory, matches any URL-shaped field name, and asserts
   **zero bare `fetch(`** rather than import presence. `aramex.carrier.ts`
   adopted the helper rather than being excepted.

Cost if wrong: the gate is still a text scan. A carrier that builds its URL in
a helper the regex cannot follow, or one added outside
`services/carriers/**`, passes it — and SSRF-1 declined the ESLint rule that
would have been the second, independent net.

---

**Ruling IMP-1 — the impersonation guard's registry is router-qualified, not
file-scoped.**

The first rollout mounted `rejectImpersonated` on the destructive routes in
`auth.routes.ts` and wrote a mount-assertion registry that walked that
router's layer stack. The registry was therefore structurally blind to
`mfa.routes.ts`, mounted separately at `/auth/mfa` — and
`POST /auth/mfa/enroll/begin` skips its re-auth branch entirely for a user who
has no MFA yet. An impersonation session could write a fresh `mfaSecret` onto
the victim's row, verify it with a code from the impersonator's own
authenticator, and lock the legitimate owner out **permanently**: strictly
worse than the soft-delete the same PR guarded, which an admin can reverse.

The commit that shipped the first half claimed `DELETE /auth/me` was "the last
destructive route impersonation could still reach". That was wrong, and the
shape of the error is the point: a registry that enumerates routes within ONE
file reads as exhaustive while being scoped to the author's attention.
`DESTRUCTIVE_ROUTES` entries are now `[router, method, path]`, with the routers
listed in a `ROUTERS` map that a new router must be added to.

Cost if wrong: a third router owning an account-level mutation is still
invisible until someone adds it to `ROUTERS` — the registry bounds what it
enumerates, it does not discover. `GET /auth/me/export` (an impersonating admin
downloading the victim's full PII bundle) is read-only and deliberately left
unguarded pending a separate decision; it is recorded here so it does not read
as fixed.

**Ruling MCP-1 — `store_usage_snapshots` is left without RLS, in this PR.**

The scoped audit's RLS finding on `merchant_api_keys` named
`20260809030000_store_usage_snapshots` as carrying the same omission and
suggested sweeping both. `merchant_api_keys` is fixed here — it is this PR's
own table, it has no production rows, and its policy was verified with a real
non-superuser probe (contextless read 1, wrong-store 0, right-store 1,
bypass 1; the superuser run that preceded it proved nothing and was discarded).

`store_usage_snapshots` is not. Enabling RLS on a table that already holds
production rows is a production action with its own blast radius, and doing it
inside a PR about an MCP surface is how an unrelated table goes dark on a
Friday. It needs its own change, its own probe, and its own rollback.

Cost if wrong: `store_usage_snapshots` stays outside the RLS cutover's coverage
until someone sweeps it, and the cutover's own inventory
(`docs/plans/2026-07-02-rls-cutover.md`) is the thing that has to catch it. It
is recorded here so it does not read as fixed.

**Ruling P2-B1-1 — the rotation-race grace budget is counted in
`revokedReason`, not in a column of its own.**

Bounding how many times one rotated row may be forgiven needs a counter. The
obvious home is a `graceUses Int @default(0)` column on `refresh_tokens`; the
counter instead lives in the existing `revokedReason` string, as
`rotated_grace_1` … `rotated_grace_5`, read and written through
`endedByRotation()` / `graceUsesSpent()` / `claimGraceUse()`.

The reason is blast radius, not taste. `refresh_tokens` is touched by every
authenticated request on the platform, and this work landed under a standing
constraint that no order or payment path may break. A sweep of `revokedReason`
across `apps/`, `scripts/`, `tests/` and `prisma/` found every reader inside
`auth.service.ts` and its two test files — nothing outside this module can
observe the encoding, so it cannot leak into an API response, a report, or a
client. A migration on that table buys legibility and costs a deploy step on
the hottest table in the schema, in a batch whose findings are all P2.

All four defences here are registered in `docs/security/defence-mutations.json`
(`session-rotation-grace-budget`, `session-rotation-backlink-cas`,
`session-revocation-midflight`, `session-rotation-grace-no-clock-renew`) and
each was confirmed KILLED — removing it reddens a named test.

Cost if wrong: a future reader of `revokedReason` outside this module (an
analytics query, an admin session list, a support tool) sees five spellings of
"rotated" where it expected one, and filters on `= 'rotated'` under-count. The
mitigation is that `endedByRotation()` is the only correct way to ask that
question and is exported nowhere else — a new reader has to go through it or
write the comparison itself, which is the moment to promote this to a column.

**Ruling P2-B1-2 — token-family lineage (#1671) and the absolute lifetime
half of #1691 are deferred; they need a schema column and this batch has none.**

Six findings were opened against the rotation-race grace path. Four are fixed
and mutation-proven here: the use budget (#1684), the conditional back-link
write (#1687), the single-query chain walk (#1688), and the mid-flight
revocation check (#1683). #1691 is fixed in the half that is reachable without
a migration — a forgiven hop no longer renews the refresh row's clock, so
replaying a nine-month-old token yields what was left of it rather than a fresh
year.

What is NOT fixed: the forgiven token is still a new family root with no link
back to the family it came from, because `replacedById` already points at the
first successor and a row cannot carry two. Real lineage needs a `familyId`
column carried across every rotation, which also turns reuse detection from
user-wide into family-wide. That is a schema change with its own migration,
its own backfill of live rows, and its own rollback, and it does not belong in
a batch of P2s.

The containment argument for deferring: every revocation path in this service
(`logout`, `password_changed`, `password_reset`, `revoke_all`,
`reuse_detected`) is a `updateMany({ where: { userId, revokedAt: null } })`.
They are user-scoped, not family-scoped, so an orphaned chain is killed by all
of them. The lineage gap therefore costs forensics and precision, not
containment.

Cost if wrong: a client that legitimately rotates more than five times inside
one 30-second window is logged out of everything — the budget is a cap on a
security hole, and if the real multi-tab shape is wider than five the fix is a
larger `ROTATION_RACE_MAX_GRACE_USES`, visible in the
`Refresh-token rotation race` warn line which now carries `graceUsesSpent` and
`graceUsesAllowed` on every forgiveness.

**Ruling P2-B3-1 — `lastActivityAt` stays on the synchronous cart path; only
the retry budget is fixed here.**

Finding #1584 has two halves. The first — `retryOnWriteConflict`'s exponential
backoff sleeping INSIDE the request's interactive transaction — is fixed:
ambient-path writes now use `AMBIENT_TX_RETRY` (`retries: 1, baseDelayMs: 5`)
instead of the default four retries from a 20ms base. On the standalone path
those sleeps happen between transactions and cost only latency; on the ambient
path they hold a Neon pooler connection and every row lock the request has
taken, for up to about a third of a second, on the losing side of a hot-cart
race. One immediate re-run is the correct budget because the only recoverable
case there is a same-cart P2002 whose winner has by definition already
committed — backoff buys nothing against an opponent that has finished.

The second half is the finding's own "longer term" suggestion: move
`lastActivityAt` off the synchronous path, so cart mutations stop serializing
on the `carts` row for a full request. That is NOT done here, deliberately.
It is a whole-service sweep — the same write appears at seven call sites in
`cart.service.ts` — it changes when abandonment telemetry becomes visible, and
`apps/admin/.../abandoned-carts` depends on that freshness. Doing it inside a
PR about transaction scoping would put an unrelated behavioural change on the
money path, which the P2 plan's own Global Constraints forbid.

Cost if wrong: concurrent mutations of one hot cart keep queueing behind the
`carts` row lock for the duration of a request. That is the behaviour as it
stands today — this PR does not worsen it, and the tightened retry budget
strictly reduces how long the losing side holds its own locks. It is recorded
here so the remaining half does not read as fixed.

**Ruling P2-B3-2 — #1766 (soft-deleted cart lines) is split into its own PR
because its durable half moves an amount expression.** _(SUPERSEDED by Ruling R3-4 — #1766 is
fixed in `fix/p2-r3-residuals`.)_

The finding is real and verified: `STOREFRONT_PRODUCT_SELECT` carries no
`deletedAt`, so a soft-deleted line renders exactly like a live one on `/cart`,
and it is still counted into `itemsSubtotal` and `itemCount`. Since
`PRODUCT_NO_LONGER_AVAILABLE` became a routine checkout refusal, a customer
with a five-item basket can be bounced to checkout step 1, return to a cart
where all five lines look normal, and have to guess — up to five times.

It is not in this PR for one reason: the durable fix changes `itemsSubtotal`.
The P2 plan's Global Constraints say that "changing an amount/rounding/currency
expression requires its own PR with nothing else in it", and this PR is
transaction scoping on the same file. Shipping only the additive half — a
`deletedAt`/`unavailable` flag with no renderer — would be a field with no call
site, which is the defect this session already removed once in batch 2.

Cost if wrong: the conversion-loss loop stays until that PR lands. It is bounded
by how often a merchant soft-deletes a product that is sitting in live carts,
and the checkout refusal does still name the product ids in `details`, so no
order can be placed against a deleted product — this is a usability defect, not
a correctness one.

**Ruling P2-B1b-1 — the mid-flight guard shipped resting on a premise that was
false on two of the three paths it named.**

Ruling P2-B1-2 recorded the guard in `refreshTokens` as closing the window
where a revocation lands between the liveness check and the row write. Its
comment named three paths — sign-out-everywhere, password change, password
reset — and asserted that "every one of those paths increments `tokenVersion`
first". That was true of exactly one of them.

`resetPassword` never called `revokeAllSessions` at all: it revoked rows with a
bare `updateMany` and left `tokenVersion` untouched. So the guard, which
arbitrates entirely on `tokenVersion`, was a no-op on that path. And
independently of any race, every access token already issued survived a reset
for the rest of its lifetime — a password CHANGE killed them immediately, a
password RESET did not, and a reset is the one a compromised user performs
precisely because they believe someone else is holding their credentials. That
second consequence is the serious one, and it had nothing to do with the race.

`changePassword` did call `revokeAllSessions`, but only after its own
`updateMany` — revoke first, bump second, which is the ordering the guard
cannot see. Both now route through `revokeAllSessions`, which bumps first and
revokes second, so the ordering is guaranteed by construction rather than by
convention.

`revokeAllSessions` grew a `reason` parameter rather than flattening everything
to `revoke_all`. `revokedReason` is the only forensic record of WHY a session
died — `docs/audits/2026-05-28-auth-access-audit.md` reads `password_reset` off
these rows to tell a redeemed reset from a sign-out — so correct ordering had
to be bought without paying for it in audit trail.

The `why` text on the `session-revocation-midflight` defence entry has been
corrected: it described coverage the guard did not have.

Cost if wrong: `changePassword`'s ordering fix is structural — one call in
place of two in the wrong order — so its consequence (a millisecond-wide race)
is not observable from outside and is NOT mutation-gated. What is gated is
every consequence that can be observed: `tokenVersion` moves on both paths,
live rows are revoked, and the reason survives. Recorded here so the ordering
does not read as tested.

**Ruling P2-B1b-2 — the chain-walk "optimisation" was a pessimisation, and the
test I wrote for it locked the pessimisation in.**

Finding #1688 asked for the successor walk to stop costing one round-trip per
hop. I replaced every hop with a single
`findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 500 })`.
`RefreshToken` has `@@index([userId])` and no `(userId, createdAt)` composite,
so Postgres fetches every row for that user and sorts before applying `take` —
and `cleanupRefreshTokens` keeps revoked rows for 30 days and live rows until
they expire, so an active merchant accumulates on the order of a thousand.
Meanwhile the chain is almost always ONE hop, which the original code did as a
single primary-key read. I traded an index-unique lookup for a full per-user
scan plus sort, per replaying request, at the moment concurrency is highest —
on the thundering-herd path the change was justified by.

The test made it worse: it asserted `findMany` was called exactly once AND that
no by-id lookups happened at all. That is a ban on the cheap read, not a bound
on cost. It is now expressed as what was actually wanted — one point lookup for
the common one-hop shape, and for a deep chain one lookup plus one slice read
rather than a round-trip per hop.

No index was added, so Ruling P2-B1-1's "no migration on the hottest table in
the schema" still holds. Worst case is two queries instead of the original ten;
the common case is one, as it was before either change.

Cost if wrong: a chain deeper than one hop still pays the unindexed slice read.
That is bounded by `take: 500` and by how rare a multi-rotation chain inside a
30-second window is. If it ever shows up in slow-query logs the fix is the
`(userId, createdAt)` composite, which reopens the migration trade-off and
should be decided once rather than twice.

**Ruling P2-B2-1 — #1240's security half does not reproduce; only its dead
code did.**

#1240 said `/stores/:id/products` was left off `PLATFORM_ONLY_ORIGIN_PATHS` on
the strength of two `lib/api.ts` methods that nothing calls, and asked for
`products` to be added to the enumerated deny segments. The enumeration it was
filed against no longer exists: that list was inverted in the same PR series
into a deny-prefix (`/^\/api\/v1\/stores(\/|$)/`) plus nine allowed storefront
shapes. `products` is not one of the nine, so it is already denied — and so is
`/reviews/admin`, the other half of the finding. Verified by executing the
middleware, not by reading it: `tests/unit/platform-only-origins.test.ts`
drives `restrictPlatformOnlyOrigins` and its re-derivation case re-enumerates
every storefront call in `apps/web` against the allow-list.

The dead code was real. `getStoreProducts` and `getStoreProduct` had zero
callers in `apps/web/src` — the finding's own check, re-run and confirmed —
and are removed, so the next enumeration cannot cite a method definition as a
call site again.

Cost if wrong: if some caller reaches those two endpoints from a browser on a
merchant custom domain, it now gets a 403 instead of data. That is the
fail-closed direction, it is loud, and the re-derivation test scans for exactly
that case — a storefront call the allow-list does not permit fails the suite
rather than the storefront.

**Ruling P2-B2-2 — one line of the refresh-throttle fix is proven by reading,
not by mutation, and it is named here so it does not read as covered.**

The chain is: `refreshAccessToken` throws `RefreshThrottledError` on 429 →
`refreshSession()` turns that into the outcome `'throttled'` → `checkAuth`
calls `clearStoredSession()` only for `'rejected'`. The first two links are
executed and mutation-proven (`tests/unit/refresh-throttle-not-logout.test.ts`;
removing the 429 detection, re-swallowing the throw, or renaming `'throttled'`
to `'rejected'` each reddens a named test). The third —
`else if (outcome === 'rejected') clearStoredSession()` inside the
`AuthProvider` component — is not, because rendering it needs a DOM and this
repo has no jsdom: it is not a dependency, no test uses it, and adding the
per-file environment pragma makes vitest try to resolve it mid-run and hang
(hit while writing this suite).

The mitigation is that the decision was moved OUT of the component precisely so
the untested part is one readable line rather than a branch. `refreshSession()`
and `clearStoredSession()` are exported and directly tested, including that a
throttle never produces the outcome that calls the destructive one.

Cost if wrong: if that line is later edited to clear on any non-`'refreshed'`
outcome, the iOS PWA is back to deleting its only copy of the refresh token in
answer to a 429, and no test fails. What would settle it: adding jsdom +
Testing Library and rendering `AuthProvider` against a 429, which is a test
-infrastructure change and does not belong in a P2 batch.

**Ruling P2-B2-3 — `/mfa/verify` and the password-reset confirm routes keep
sharing authLimiter's `<ip>-unknown` bucket.**

> AMENDED 2026-09-13 after the scoped audit. The first version of this ruling
> enumerated one bucket and concluded the knock-on was gone. It missed a
> second: the GLOBAL limiter in `apps/api/src/index.ts` is mounted app-level,
> counts every mutation at 200 per 15 minutes with the DEFAULT (per-IP) key,
> and `POST /auth/refresh` is a mutation. So refresh was still inside an
> IP-wide counter shared with every order creation, cart write and admin save
> — the same "every user behind a NAT shares one bucket" failure the dedicated
> limiter exists to end, one layer up, and binding FIRST because 200 is below
> the per-user 120 times the number of users on that IP. Refresh now skips
> the global limiter (`skipGlobalRateLimit`, its own module so a test can
> execute it) and `refreshLimiter` is the sole gate on that route. The
> enumeration below is the authLimiter half only, and is otherwise unchanged.

#1690 notes that every emailless auth route collapses into the same key.
`/auth/refresh` is the one this batch splits out, because it is the one the
production incident was measured on (46 sessions for one user in a single
second after a deploy) and the only one a client calls unprompted, tens of
times an hour, with a teardown on failure. Moving refresh out also removes the
knock-on the finding describes — a user exhausting the bucket with open tabs
and then being unable to finish MFA — because the tabs are no longer in that
bucket.

The remaining routes stay together deliberately: they are user-initiated, low
volume, and a shared per-IP ceiling is the right posture for a
credential-guessing surface.

Cost if wrong: several people behind one NAT doing MFA or password resets at
the same moment can still rate-limit each other at 15 per 15 minutes. That is
visible as a 429 with a `Retry-After` on a screen the user is actively looking
at, not a silent session teardown, and the fix is the same split if it is ever
measured.

**Ruling P2-B2-4 — `Retry-After` is not surfaced to the clients, and the field
that claimed to carry it is deleted rather than made to work.**

`RefreshThrottledError` originally carried `retryAfterSeconds`, parsed from the
429's `Retry-After` header, and a test asserted it came back as 12. That
assertion could never hold in production. The API and all three frontends are
on different hosts, so every refresh is a cross-origin fetch, and `Retry-After`
is not a CORS-safelisted response header — `apps/api/src/index.ts` exposes only
`X-Request-Id` and `X-CSRF-Token`, so the browser returns null for it whatever
the server sent. The test passed because it stubbed `headers.get` itself: green
against a value the real client path cannot produce.

The header is NOT being added to `exposedHeaders`. Two reasons. It would be an
export nothing consumes, and the value itself is the wrong shape for the job:
`express-rate-limit` reports seconds until the WINDOW resets, so on a 15-minute
window a throttled client would be told to wait up to 900 seconds — useless for
an interactive retry and actively worse than a short fixed backoff. The retry
that replaced it (`THROTTLE_RETRY_DELAYS_MS`, 1.5s then 4s) is bounded, fixed,
and tested on fake timers.

Cost if wrong: if a future caller genuinely needs the server's own backoff
hint, it has to add `Retry-After` to `exposedHeaders` AND verify it by
executing a real cross-origin 429 rather than a stubbed `Response` — the
stubbed version is what hid this. Recorded here so the field's absence reads as
a decision rather than an oversight.

**Ruling P2-B2-5 — the refresh-throttle fix belongs on all THREE frontends, and
the first version shipped it on two.**

> AMENDED 2026-09-25 after #1789. This ruling's claim about `apps/web` below —
> "it never clears stored credentials except on an explicit logout, and its
> `setUser(null)` is UI state that the next check recovers" — was wrong: there
> is no next check. `refreshUser` is a `useCallback(..., [])` invoked once
> from a mount effect, and `request()`'s `!endpoint.startsWith('/auth/')`
> refresh-retry gate excluded `/auth/me` along with every other `/auth/`
> route, so `getProfile()` could never take the refresh path at all. A signed-
> in customer returning after the 30-minute access-token window was rendered
> a guest — losing saved addresses/loyalty state and checking out as one —
> with nothing that ever re-checked. Fixed by exempting `/auth/me` specifically
> from the skip (`/auth/refresh` itself stays excluded — its own throttle/401
> handling is a raw `fetch` in `refreshAccessToken()`, not a recursive call
> through `request()`, so there was never a loop risk in exempting more than
> that one route) and by having `AuthContext.refreshUser` leave `user` as-is
> on a `RATE_LIMITED` result instead of clearing it, matching admin/orders'
> "a throttle is not a sign-out" rule at the UI-state layer. Cost if wrong:
> reintroducing the blanket `/auth/` skip silently brings this back, with no
> test failing until one is written against a real 401→refresh→200 sequence
> on `/auth/me` specifically — which is why `tests/unit/refresh-throttle-not-
logout.test.ts` now includes one.

`apps/orders` was left byte-identical to the bug: the same
`if (!res.ok) return null`, the same blanket catch, the same
`localStorage.removeItem('accessToken'/'refreshToken')` pair in its
`checkAuth`. It is a deployed frontend (orders.force-ai.co) and an installed
iOS PWA that requests persistent storage precisely to keep that one copy of the
credential alive. And because `refreshLimiter` is keyed per USER, the orders
PWA, the admin PWA and every browser tab for one merchant share a single
budget — so the app most likely to meet a throttle was the one still answering
it destructively.

The cause was not judgement, it was reach: `apps/orders` had no `@orders`
vitest alias, so no test could import it, so it had no tests, so a client-side
auth fix could land on two of three surfaces and look complete. The alias is
added, the orders copy is covered by the same suite as admin and web, and both
orders defences are registered in `docs/security/defence-mutations.json`.

> AMENDED 2026-10-01 (issues 2158 / 2098 / 2097 — Ruling EWO-A11, EWO-A10):
> the paragraph below is superseded. After #1789 `/auth/me` DOES refresh, so
> the "no caller" premise no longer held, and the RATE_LIMITED branch was a
> no-op on mount. `apps/web` now runs `getProfileWithMountRetries` (the same
> 3 × 5s ladder), and the refresh skip is the credential-less-route list
> `endpointMayRefresh`, not an `/auth/me` special case.

`apps/web` deliberately does NOT get the retry loop, and that is not a
third miss. Its `AuthContext.refreshUser` calls `/auth/me`, and the storefront
client skips the refresh-retry path entirely for `/auth/` endpoints — so the
loop would have no caller there. It also never clears stored credentials except
on an explicit logout, and its `setUser(null)` is UI state that the next check
recovers. Web gets the 429 detection (so a throttled write reports
`RATE_LIMITED` rather than a bare 401) and nothing more, because nothing more
is reachable. A branch with no call site is the same defect inverted.

Cost if wrong: a fourth frontend, or a later divergence in one of the three,
re-opens the same hole. The mutation entries are the guard — `apps/orders/src`
and `apps/admin/src/lib` are both in `mutation-testing.yml`'s `paths`, so a PR
touching either runs the gate.

**Ruling P2-B2-6 — "a bucket is not a capability" was the wrong argument, and
it was mine.**

`refreshLimiterKey` originally read the presented token's `sub` with
`jwt.decode`, unverified. I registered that in the `jwt.decode` lens with the
justification that a forged `sub` only moves the caller to a different counter,
because a bucket is not a capability. The premise is true and the conclusion
does not follow: for a rate limiter, the attacker choosing the PARTITION is the
whole attack. A loop posting `jwt.sign({}, 'anything', { subject: randomUUID() })`
mints a fresh 120-per-15-minute bucket on every request and is never throttled.

It was worse in combination with the change one file over. `skipGlobalRateLimit`
bypass 3 exempts `/auth/refresh` from the global 200/15min per-IP mutation cap,
on the correct reasoning that the route now has its own bucket. Together those
two edits left the route with NO constant per-IP ceiling at all — and
`AuthService.refreshTokens` sha256s the presented token and queries Neon before
any signature is checked, so each unthrottled request is an unauthenticated
database round trip. I introduced that; the scoped audit did not catch it; the
AI reviewer did.

The fix, which is the reviewer's and is better than what I wrote: verify the
token instead of decoding it, so bucket cardinality is bounded by genuinely
issued sessions; refuse to run the HMAC at all over anything longer than
`MAX_REFRESH_TOKEN_CHARS`, because JSON bodies are accepted up to 10mb and
hashing one per request is itself the amplifier; and stack an IP-wide
`refreshIpLimiter` in front at 600/15min — deliberately far above real use
(an access token lives 30 minutes, so a tab refreshes once or twice a window)
and above the 200/15min this route used to ride, so no office NAT that worked
yesterday starts 429-ing today.

Both are registered as defence mutations (`refresh-bucket-subject-is-verified`,
`refresh-bucket-size-ceiling`) and both KILLED. The size ceiling SURVIVED its
first mutation — the assertion that mattered was not "an oversized token lands
in the anon bucket", which passes with the guard removed, but "`jwt.verify` is
never reached", which is what the guard actually does.

Cost if wrong: `refreshIpLimiter`'s 600 is a judgement, not a measurement. If a
genuinely large shared-IP deployment exceeds it, the symptom is a 429 on
refresh — which the clients now treat as back-pressure rather than a sign-out,
so it degrades instead of signing people out. That is the order those two fixes
had to land in.

> AMENDED (#1801): this ruling named the unauthenticated Neon round trip as the
> reason the KEY must verify, then left the ROUTE hashing and querying before
> any signature check. `POST /auth/refresh` now calls the same
> `verifyRefreshJwt` helper first and 401s `TOKEN_INVALID` without touching the
> database. It verifies the signature only (`ignoreExpiration`): the DB row's
> `expiresAt` stays the authority on lifetime, because the JWT `exp` follows
> `REFRESH_TOKEN_EXPIRES_IN`, which can be shorter than the row, and gating on
> it would sign out sessions that refresh today.

**Ruling P2-B2-7 — the throttle retry is one attempt, and it is not a recovery
from a real throttle. Saying so is the point.**

`refreshSessionWaitingOutThrottle` shipped with a ladder of 1.5s then 4s. The
audit is right that it cannot do what its own doc comment claimed. Both buckets
it waits on are FIXED 15-minute windows backed by a rate-limit-redis counter,
so once a caller is over the cap, every request for the remainder of the window
429s. A 5.5-second ladder ends on exactly the login screen it would have
reached with no ladder at all — 5.5 seconds later and two requests deeper into
the IP-wide cap. It was a spinner described as a recovery.

Three options were available and two were rejected:

Shortening the refresh windows so a ladder CAN cross a boundary (e.g. 8/minute
instead of 120/15min — the same average rate) is the obvious server-side fix
and it is wrong here. The whole reason this bucket is burst-tolerant is the
measured incident: 46 sessions for one user refreshing in a single second after
a deploy. 8 per minute refuses exactly that, so it would reintroduce the
failure the work exists to remove, in exchange for a faster recovery from a
throttle that would then happen far more often.

Exposing `Retry-After` so the client could wait the real duration is refused by
Ruling P2-B2-4, and would in any case be a wait of up to 900 seconds — not
something to hold a mounting app on.

So the ladder is cut to ONE 1.5s retry, which buys the case it can actually
win: a request landing on the wrong side of a window boundary, or losing a
moment of Redis contention. The comment now says that rather than claiming
more.

The recovery from a genuine throttle is that the CREDENTIAL SURVIVES —
`clearStoredSession` is never called on this outcome — so a reload once the
window turns over signs the user back in with no password. Making that
automatic, by re-checking on focus or `visibilitychange` rather than only on
mount, is the durable fix.

Cost if wrong: a user who genuinely exhausts 120 refreshes in 15 minutes sees a
login screen and has to reload rather than being signed back in on their own.
That is a strictly better outcome than the behaviour this PR set out to fix,
where the same event DELETED the only copy of their refresh token on the iOS
PWA, and it is not on the order or payment path. The event-driven re-check is
deferred because it is a behavioural change to the auth provider in two apps,
with no jsdom in this repo to render it against — the same constraint recorded
in Ruling P2-B2-2.

> AMENDED 2026-09-25 after #1782 and #1814. Two of the three gaps this ruling
> named as remaining were closed without the deferred event-driven re-check,
> and are recorded separately from it so this ruling does not read as
> superseded wholesale:
>
> 1. #1782 — "sees a login screen" was reached even when the throttle cleared
>    within seconds, because `checkAuth`'s ONE 1.5s retry (this ruling) was
>    the only retry at ANY layer; once it was exhausted, `isLoading` went
>    false and the redirect fired immediately. `checkSessionWithMountRetries`
>    (`api.ts`) now wraps this retry in a further bounded ladder
>    (`MOUNT_RETRY_DELAYS_MS`, three more attempts 5s apart) at the
>    whole-session-check level, so a mount-time throttle gets ~15 more seconds
>    to clear before the caller gives up. This is still bounded and still
>    cannot cross a full 15-minute window — the reasoning above for why a
>    longer ladder is the wrong fix stands unchanged — it only narrows the
>    "wrong side of a window boundary" case this ruling already scoped the
>    original retry to.
> 2. #1814 — "has to reload" was not even true: the mount effect skipped
>    `checkAuth` entirely whenever it mounted with `pathname === '/login'`,
>    so reloading /login (the one action this ruling names as the recovery)
>    never re-checked anything. That skip is removed in both
>    `apps/admin/src/lib/auth.tsx` and `apps/orders/src/lib/auth.tsx`, and the
>    admin login page gained the "already signed in → redirect" effect
>    `apps/orders`'s login page already had, so a reload (or, for orders, any
>    navigation to /login) that recovers the session now actually carries the
>    user onward instead of leaving them on the form.
>    CORRECTED 2026-10-01 (issues 2095, 2159, 2163): the removal was described
>    as costing "two extra fetches" per anonymous /login load — true only when
>    untrottled. Throttled, the ladder made it 4 × /auth/me + 8 ×
>    /auth/refresh into the shared anon + IP-wide refresh buckets, and the
>    admin login page hid its form behind a ~21s spinner. Now `checkSession`
>    (admin + orders) posts /auth/refresh only with session evidence (the
>    `hadSession` marker, a stored token, the `force-session` cookie) or one
>    evidence-free probe per tab, an evidence-free throttle is `signed-out`
>    (no ladder), and the admin form renders during the check.
>
> The event-driven re-check (focus/`visibilitychange`) is still deferred for
> the reason stated above — it remains a behavioural change to the auth
> provider with no jsdom in this repo to render it against.

**Ruling P2-B5-1 — #1408 does not reproduce, and #1765 is answered by naming
the products rather than by changing the cart contract.**

#1408 asked for a `PRODUCT_NO_LONGER_AVAILABLE` case in the checkout switch.
That case already exists, with the `setStep(1)` the finding asked for — it
landed earlier in this same session, in the change that made the refusal
routine. Verified by executing the coverage gate, not by reading the diff.

#1765 asked for the offending product ids to be carried to `/cart` so the cart
page can mark those lines. That is the same contract change Ruling P2-B3-2
deferred: it needs a per-item `unavailable` flag on the cart read, which is a
public-boundary change whose durable half also moves `itemsSubtotal`.

The customer's actual problem — "I cannot tell which line to remove" — is
answered without any of that. The ids arrive in `details.productIds`, and the
cart the checkout is already holding has the matching lines, so the message
names the products. A six-item cart stops being guess-and-check.

Two things make that safe to say in copy. Names are APPENDED as a trailing
clause rather than interpolated mid-sentence, because a product name is not
translated and splicing one into Arabic copy reads as a mixed-direction
fragment. And when only some ids resolve, the label is "Including:" rather than
"Remove:" — claiming a complete list when it is partial is worse than not
listing at all, because the customer removes what is named, retries, and meets
the identical refusal.

Cost if wrong: the cart page still renders a dead line like any other, so a
customer who navigates there without reading the checkout message has no
marker. That is the state before this change, and P2-B3-2 still owns it.

**Ruling P2-B5-2 — the checkout error switch gets an enumeration gate, because
it has now missed an API error code three times.**

`PRODUCT_NO_LONGER_AVAILABLE` (#1408), `COUPON_NOT_ELIGIBLE` (#1369), and the
opaque Prisma error the first of those replaced: three reports, one mechanism.
The API gains a code, the switch does not, and the shopper is told to retry a
refusal that is deterministic. Each fix mapped its own code and left the next
one to be found by a customer.

`tests/unit/checkout-error-code-coverage.test.ts` derives the codes
`OrderService.create` can throw from the source and requires each to be either
answered or named as deliberately generic. Writing it immediately found two
more nobody had reported — `AREA_NOT_DELIVERABLE` and
`BUNDLE_PRICE_NOT_ALLOCATABLE`, both deterministic, both landing on "please try
again". `BUNDLE_PRICE_NOT_ALLOCATABLE` is the sharper one: the SERVER's own
message ends "Please try again", so the shopper was told the same useless thing
twice.

The gate's first version also produced a FALSE POSITIVE — it reported
`BUNDLE_NOT_PURCHASABLE` as unanswered because that code is handled by
`checkoutBundleErrorCopy`, which runs before the switch and returns early. A
gate that fails good work gets deleted rather than fixed, so it now reads both
handlers.

It asserts on source text and says so in its own header. It proves the case
EXISTS, not that it renders; what the copy says is asserted in the two copy
suites, and that the message survives the step change is asserted in
`checkout-error-alert-renders.test.tsx`.

_Update 2026-09-25 (#1826, Ruling M5-4): the gate now also reads the
`/payments/create` handler, the checkout's second call._

Cost if wrong: the gate is scoped to `OrderService.create`, bounded at the next
`static async`. A code thrown by a helper that method calls — rather than in
its own body — is invisible to it. `DELIBERATELY_GENERIC` is empty today, and
an entry added there without a real reason would silence the gate for that code
permanently.
**Ruling P2-B8-1 — the other nine files answering with a bare-string error are
registered, not swept.**

`admin.routes.ts` is cleaned up: its six responses now use the platform
envelope, which is what made the webhook force-replay escape hatch work again
after four reports of it being dead (#553, #557, #582, #617).

The other route files that answer `{ error: '<code>' }` are NOT changed, and
the difference matters:

`wa-bridge.routes.ts` answers an EXTERNAL consumer. The WhatsApp bridge's
parser is not in this repository, so changing the shape breaks a client this
repo cannot deploy alongside. That is recorded as deliberate.

Nine more — `alert-webhooks`, `backorders`, `expenses`, `finance`, `insights`,
`purchase-orders`, `smart-layer`, `stock-adjustments`, `suppliers` — share a
DIFFERENT convention: a flat lower-case discriminant (`{ error: 'not_found' }`,
`{ error: 'validation_failed', details }`). It IS a second error envelope on
one platform, and nobody has decided whether the two should converge — so it
goes on the unreviewed list rather than being swept. Changing a shape a page
already reads correctly would be the mirror failure: a gate breaking working
code.

**CORRECTION (#1800) — "their own admin pages read as a string rather than
through `data.error.code`" was checked for one page and asserted for the
group.** It holds for the one raw-`apiFetch` import page
(`finance/bank-reconciliation/import/page.tsx:93`, `json?.message ?? json?.error`).
Every other checked finance page consumes through `apiGet`/`apiPost`
(`apps/admin/src/lib/api.ts`), which reads `data.error?.code` /
`data.error?.message` off the response body — on a string `error` field those
are both `undefined`, so `apiRequest` (api.ts:378-379) collapses the response
to `{ code: 'SERVER_ERROR', message: 'Request failed with status 422' }`
regardless of what the route actually said, and drops `details` entirely.
`fx-rates/page.tsx:106-112` and `bank-reconciliation/page.tsx:57-61` both hit
this: a merchant sees a generic "request failed" with no field-level reason.
So "self-consistent" does not hold for the group — most of these pages DO lose
code/message/details, they just fail quietly (a generic message) rather than
loudly (`[object Object]`), which is why nobody had reported it. The deferral
itself stands: converging the two envelope shapes is still a product decision
nobody has made, not something to guess at here. What was wrong is the reason
given for deferring, which is corrected above; the test comment at
`tests/unit/api-error-envelope-registry.test.ts` mirrors this text and must
change with it.

The gate's first version made exactly that mistake twice. It reported
`bundle.routes.ts`, whose only match is inside a COMMENT documenting its
deliberate flat body — a file already doing the right thing and explaining why.
It now strips comments before matching.

Cost if wrong: two envelopes remain on the platform, and a new client written
against the object shape will read `undefined` from any of those nine routes.
The registry is what makes that a decision someone takes rather than a surprise
someone debugs — but it does not force the convergence, and until it happens
the answer to "what shape does this API return?" is "it depends which router".

_Update 2026-09-25 (#1829): the "self-consistent" premise above was false —
those pages read errors through the same normaliser as the webhook page. The
nine routes now answer the platform envelope, keeping their lower-case
discriminants as `code` and moving `issues`/`details` under `error.details`._

**Ruling P2-B8-2 — four of this batch's findings are one defect, and the gate
is the actual deliverable.**

#553, #557, #582 and #617 are four separate audit reports of one mechanism:
`error` as a string where the client reads `.code`. Each named one route. The
feature they killed — a super-admin deliberately re-firing an already-processed
payment webhook — was dead from the day it shipped, and it failed SAFE (it
blocked re-processing rather than double-applying), which is why it survived
four reports without anyone looking at the shape rather than the symptom.

Fixing six lines would close four issues and leave the class exactly as
findable as before, which is to say not at all. The registry is what changes
that: a new route answering with a bare string now fails a test until someone
writes down which convention it belongs to.

Cost if wrong: the registry matches on source text, so a response built through
a helper or spread from a variable is invisible to it. It catches the shape
that has actually recurred four times, not every shape that could.

**Ruling CRED-1 — a masked-credential save that cannot resolve its merge base
now FAILS instead of succeeding, and the cache key carries a version.**

The 2026-09-22 carrier-cache fix changed the cached VALUE (decrypted object →
encrypted string) while leaving the KEY unchanged. Redis outlives a deploy, so
for the full 300s TTL — longer under a rolling restart, where old instances keep
writing the old shape — `decryptCredentials` was handed an object, threw, was
caught, and returned `{}`. Nothing distinguishes that from "this merchant has no
credentials configured". `preserveMaskedCredentials` then found no stored
counterpart for every masked field the merchant resubmitted unchanged, DROPPED
it, and `upsertCarrierConfig` encrypted and persisted the truncated set. A
merchant toggling `enabled` without retyping their Aramex password inside that
window destroyed the password, saw a successful save, and the subsequent cache
invalidation made the corruption the new truth.

Three decisions, not one:

1. `CARRIER_CONFIG_CACHE_PREFIX` gains `:v2:`. A cached value's shape is part of
   its key's contract; changing one without the other is an unversioned schema
   migration against a store that survives the deploy.
2. Both masked-resubmit merges read their base **straight from Prisma**, never
   through their own 300s cache. A base for a secret we are about to overwrite
   has to be current truth — a cached base silently reverts a credential changed
   moments ago on another replica even when the shape is right.
3. An unresolvable masked field **refuses the save** (`400
CARRIER_CREDENTIALS_UNRESOLVED` / `NOTIFICATION_CREDENTIALS_UNRESOLVED`)
   rather than dropping the field. This is the posture change: previously the
   save always succeeded. Failing a write is recoverable in one retype; erasing
   a merchant's carrier password is not.

`notification-config.service.ts` carried the identical shape against provider
secrets (Unifonic appSid) and is fixed in the same pass — the defect was found
once and is a sample of its class. All five guards are in
`docs/security/defence-mutations.json` and were verified KILLED, so removing any
one of them reddens a named test.

Cost if wrong: a merchant whose stored credentials genuinely cannot be decrypted
— a rotated or lost `ENCRYPTION_KEY` — can no longer save that carrier at all
until they retype every masked field, where before the save succeeded and quietly
dropped them. That is the intended trade: a blocked save is visible, and the
error names the field to retype. It does mean a key-rotation incident surfaces
here as failed saves rather than as silent credential loss discovered later.

---

## 2026-09-25 — P2 batch S1 (auth/session core)

**Ruling S1-1 — #1863 is not changed: `/verify-email` keeps sharing
authLimiter's `<ip>-unknown` bucket, per Ruling P2-B2-3.** That ruling split
out `/auth/refresh` (the only route a client calls unprompted) and kept every
other emailless auth route together deliberately, as user-initiated, low-volume
routes where one per-IP ceiling is the right posture. `/verify-email` is the same
shape. Cost if wrong: a Kuwait carrier CGNAT egress with 15+ verification or
reset clicks in 15 minutes 429s the 16th, with authLimiter's "Too many login
attempts" copy — the fix, if it is ever measured, is the same split P2-B2-3
names.

**Ruling S1-2 — #1649 is left for the owner, not changed.** Deduplicating
denied-write audit rows (one row per store/ip/tool/minute) changes what
`classifyAgentDenials` counts: `integrationBroken` and
`integrationNeverCredentialed` fire at 3 rows per 16-minute window and
`anonymousFlood` at 50, so a per-minute sample would delay the first and make
the second unreachable from one IP unless every row also carries an attempts
count and the thresholds are re-expressed in attempts. That re-calibrates five
registered detection defences. Cost if wrong: an anonymous flood keeps opening
one short interactive transaction per refused write, bounded by publicLimiter
at 300/min/IP.

**Ruling S1-3 — #1801: `/auth/refresh` verifies the signature, not the
lifetime.** The JWT `exp` follows `REFRESH_TOKEN_EXPIRES_IN` (`.env.example`
ships `30d`), while the DB row is written for 365 days, so gating the route on
`exp` could sign out sessions that refresh today. The DB row's `expiresAt`
stays the lifetime authority. Cost if wrong: a refresh token signed with a
since-rotated `JWT_SECRET`, or before the `force-api`/`force-app` claims existed,
now fails at refresh instead of silently rotating, so a session idle since such
a change has to log in again.

**Ruling S1-4 — #1862: a limiter with no connected Redis counts in process
memory, never waits.** The store resolves Redis per request and uses it only
when `redis.isAvailable()`, so a request at boot or during an outage is served
at once and still limited per process. The merchant MCP and WBS bridge limiters,
which had no shared store at all, now use the same store with
`passOnStoreError: true`, and the WBS key is hashed before it becomes a Redis
key. Cost if wrong: if production runs more than one replica, each limit that
used to be N×replicas becomes N, the numbers every limiter's docstring
already claims; replica count was not verifiable from this session.

**Ruling S1-5 — #1214 is narrowed, not closed: there is no persisted domain
verification to filter on.** The Store model has no hostname/SSL status column,
so the CORS lookup can require a live store (active or suspended, not deleted)
but not a verified domain. Persisting Cloudflare's custom-hostname status needs
a migration plus a writer, which is outside this batch. Cost if wrong: a merchant
can still point any hostname it controls at its store and have it trusted for
credentialed CORS; the platform-only origin gate and CSRF tokens stay the real
boundary, as the code comment says.

**Ruling S1-6 — #1880: a CRM zero-match is recorded, not flagged.** CRM rows
exist only for shoppers a merchant has grouped, so most erasures legitimately
match nothing. `crmReviewNeeded` is true only for an ambiguous match, which is
known to have left a record behind; a zero-match is written as
`crmRowsScrubbed: 0` and shown as a note in the success toast. Cost if wrong: a
real CRM copy that the scrub missed because the phone was normalised
differently gets a note, not a warning.

**Ruling S1-7 — #1527 is closed by falling back to the cookie, not by
skipping the clear; `/auth/logout`'s sibling is not changed.** The first
version cleared cookies only when no body token was sent. The scoped audit
(P1) showed that reinstated the permanent checkout 403 for the iOS WebKit
clients (web, admin, orders), which always post their localStorage refresh
token in the body alongside the cookies: when that session died, the dead
cookies were never cleared. Now a failed body token with a different cookie
token present retries rotation with the cookie as an ambient-cookie caller
(Set-Cookie only, nothing in the body). A live cookie rotates, so garbage in
the body cannot wipe it. Cookies are cleared only when the cookie token also
fails on authentication, or when there was no separate cookie token. Both
halves are mutation entries (`refresh-failed-body-token-keeps-cookie-session`,
`refresh-dead-cookie-cleared-despite-body-token`). Logout also runs a
destructive session effect on a simple cross-site POST, but signing out is its
purpose, and CORS already rejects a form POST from any origin that is not a
platform origin or a registered store domain before it reaches the route.
Cost if wrong: a cross-site form can make a victim's live cookie session
rotate (it cannot read the result, and the session stays valid), and a
merchant-controlled custom domain can sign a visiting user out.

Amended (issues 1962, 2170, 2217 — backlog batch d-routes-mcp, 2026-10-01).
The "rotate but harmless" residual above was wrong for the body-token client
class, so it is no longer accepted: (a) the cookie fallback is SUBJECT-BOUND —
it rotates the cookie only when both tokens verify and share a `sub`; a body
token that does not verify (the cross-site `refreshToken=garbage` form) or a
cookie of a different user neither rotates nor clears the cookie, while a
cookie that does not verify is still cleared (#1531's heal); (b) the fallback
answers `staleRefreshToken: true` and all three clients drop their stored pair,
so a stale localStorage token is never re-presented into reuse detection; (c) a
BODY-lane rotation writes Set-Cookie only when the body token is this browser's
own cookie token or the origin is a platform origin, so a merchant-origin page
can no longer install an attacker-chosen session into the victim's browser.
Mutation entries: `refresh-cookie-fallback-same-subject`,
`refresh-body-token-does-not-install-cookies`.

Residual restated per client class (PR 2301 audit P1 — the first wording, "heals
by one extra 401 round", was false for the storefront). admin and orders run on
platform origins, so their cookies are always rotated. The storefront on a
merchant custom domain is the one class the cookie refusal touches, and before
this fix it had no Bearer path: a body-lane refresh that installed no cookie
left the expired `token` cookie in place, and the shopper looped 401 → refresh
→ 401. Chosen fix, option (a): on iOS/iPadOS WebKit (the only clients that post a
body token) `apps/web` now persists the rotated access token and sends it as a
Bearer from `buildHeaders`, exactly as admin and orders do. It drops the stored
Bearer whenever a refresh answers on the cookie lane, on the stale-token
fallback, on login, and on session end, and never sends it from a non-iOS
browser. This was preferred over (b), a `cookiesWithheld` flag, because (b) needs
the same Bearer lane in the client and adds a second signal. The gate itself is
unchanged: relaxing it for "no cookie present" would reopen 2217 for a fresh
browser. Mutation entry: `storefront-ios-body-lane-sends-bearer`.
Cost if wrong: the storefront's iOS localStorage now holds a 30-minute access
token next to the 365-day refresh token it already held, so an XSS on a
storefront gains nothing it could not already mint.

**Ruling S1-8 — #1861: the same-account availability tradeoff stays.** The
per-tenant key stops a flood on one store from locking the same email
elsewhere; it cannot give the targeted account a fresh bucket without giving
the flood one. The flood itself mails the owner working reset links (15-minute
links, not invalidated by later requests). Cost if wrong: an attacker who knows
an address can keep that account's own reset requests at 429, so the owner has
to use a link already in their inbox.

**Ruling S1-9 — #1864's sibling in super_admin impersonation is left for the
owner.** `POST /admin/impersonate` signs its own one-hour access token and
checks `deletedAt` but not `status`, so a super_admin can impersonate a
suspended account. That may be intended for support investigations. Cost if
wrong: an impersonation session acts as a suspended account for up to an hour.

**Ruling S1-10 — the `origin-public-prefix-rejects-traversal` mutation entry is
retired.** Once #1820's `hasDotSegment` check refuses a `.`/`..` segment
anywhere in the path, removing the `[^./]` anchor on the `/stores/public/`
pattern changes nothing observable: every traversal the anchor stopped is
stopped first by the whole-path check, and the entry scored SURVIVED. The
anchor stays in the code as belt and braces; the property is tracked by
`origin-gate-rejects-any-dot-segment`, which KILLS (the check now runs at the
top of `restrictPlatformOnlyOrigins`, covering the deny side too). Cost if wrong: if the
whole-path check is ever removed, the anchor is back to being the only guard
for the first segment, and no mutation entry would say so.

---

Context: P2 batch M3 (checkout, coupons, loyalty, VAT), 2026-09-25 — issues #181, #193, #1368,
#1379, #1426, #1427, #1444, #1526, #1528, #1569, #1807.

**Ruling M3-1 — at the public coupon validate route, an unknown identity does not veto a
customer-group coupon.** With `cartItems` now sent by the storefront (#1368/#1379), the route
evaluates targeting for real. The cart page has no phone or email to send, and
`resolveCustomerContext` answers "no group" for that, which would refuse a group code to the very
members it was made for, on the page where most codes are typed. So with no identity the route
substitutes the coupon's own group (first-order already resolves permissively with no identity).
Checkout sends the typed phone and email, and `OrderService.create` re-evaluates against the real
identity, which stays the authority. Cost if wrong: a shopper outside the group sees the code
accepted on the cart page and refused at checkout. That is the behaviour every targeted code had
before this batch, now confined to the one criterion the cart page cannot know. Issue 2066
widened "unknown" to include a typed identity that resolves to NO `Customer` row
(`custCtx.customerGroupId ?? coupon.customerGroupId`): the quote cannot see the signed-in account
that `OrderService.create` keys the group from, so a VIP typing a recipient's phone was refused a
code checkout would honour. **Revised after the PR 2301 audit:** substituting on every unmatched
identity quoted VIP codes as valid to GUESTS, whom order-create then hard-400s. The route now runs
`optionalAuthenticate` and resolves the group from the verified signed-in account
(`customerUserId`) — the same identity `OrderService.create` uses — while a guest whose typed
contact matches no Customer row is still refused at the quote, as checkout would refuse them.
Cost if wrong: a guest who IS a group member but typed a contact formatted differently from their
Customer row is refused a code they would have been refused at checkout anyway.

**Ruling M3-2 — `tests/` is not added to `npm run typecheck` in this batch (#1444).** The swapped
arguments are fixed and the test now asserts the credited amount. Type-checking `tests/unit` as one
project was measured at 257 errors (most from resolving app sources under a config that is not
theirs: `apps/web/src/lib/api.ts` alone 37, `apps/admin/src/lib/api.ts` 32). Closing that is a
per-app test-project change across all four apps, not a P2 loyalty fix. Cost if wrong: another
test can pass wrongly typed arguments to a service and CI will not notice. What would settle it: a
`tsconfig.tests.json` per app that includes only the tests importing that app.

**Ruling M3-3 — the storefront checkout shows no tax line and its total excludes tax. Reported,
not fixed (#193).** VAT is now levied after discount everywhere the tax is persisted and read
(charge, invoice, confirmation email, 2100 posting, report). But the checkout summary never
displayed tax: `total = subtotal − discount + shipping`, and the public store payload carries
`taxEnabled`/`taxIncludedInPrice` but not a rate. On a store with tax-exclusive VAT the customer is
shown a total lower than the charge. Adding the line means exposing a rate publicly and changing
every store's checkout render, which the owner rule for this batch does not cover. Cost if wrong:
the first store to enable exclusive VAT has a display-versus-charge gap at checkout until a
follow-up lands; no live store has tax on (per the owner, 2026-09-25; not re-measured here).

**Ruling M3-4 — #1807's component wiring is pinned by source, not by render.** The ordering
(free shipping off at once, submit gate closed until the recomputed fee lands) lives in
`repriceAfterCouponRemoval` and is driven with fakes. The three lines that connect it to
`CheckoutClient` (the awaited removal in the refusal handler, `setStep(1)`, and the PaymentStep
gate) are asserted on the source, for the reason recorded in P2-B2-2: no DOM environment exists in
this repo. Each assertion was mutation-checked against the pre-fix file. Cost if wrong: a refactor
that keeps the strings but breaks the behaviour passes. _(Amended by EWO-D1 — the "fee lands"
premise was false on the failure branch; the gate now closes on an unconfirmed fee, #2067.)_

**Ruling M3-5 — the loyalty reversals lock inside a separate `withMoneyTx`, as the array batch they
replace already ran.** Inside the Inngest step's `runInTenantContext`, `$transaction` is not proxied
to the ambient tenant transaction, so the old `prisma.$transaction([...])` already ran on its own
connection, and so does the new interactive one. Moving onto the ambient transaction would turn the
P2002 backstop into a 25P02 abort of the whole step, so it was not done. The RLS policies on
`loyalty_points`/`loyalty_transactions` admit a connection with no store GUC, which is why both the
old and the new form see the row. Cost if wrong: none beyond the pre-existing posture, which this
change neither widens nor narrows.

**Ruling M3-6 — the checkout VAT line deferred by M3-3 is now shipped (owner decision, 2026-09-26).**
`computeOrderTax` moved from `apps/api/src/lib/order-tax.ts` into `@force/shared` (the API re-exports
it) so the checkout/cart summary and order creation share one formula rather than two that could
drift. The public store payload (`/stores/:slugOrId`, `/store/resolve`) now carries
`taxRatePercent`, read via the same active `TaxRate` row order creation charges against
(`resolveActiveTaxRatePercent`, a new single resolver `order.service.ts`'s two call sites now use
too, replacing their own duplicate queries). The checkout `OrderSummary` and all 5 themed cart
summaries render "VAT (R%)" when tax is exclusive (added to `total`) and "Incl. VAT (R%)" when the
listed price already includes it (informational only, never added to `total`). Disabled or a 0%
rate — all 3 live stores today — renders nothing, byte-identical to before this line existed. Cost
if wrong: verified by a wide subtotal/discount/rate parity sweep (incl. rounding edges) and
mutation-checked render tests for the disabled/exclusive/inclusive states across every theme, plus
the buy-flow parity harness against `origin/main` — but not against a live store with tax actually
enabled, since none exists to test against (per the owner, 2026-09-25, not re-measured here).

**Ruling M3-7 — the scoped audit blocked M3-6 on P1=1, P2=4; this closes the P1 and three of the
four P2s (2026-09-26).** P1: M3-6's "informational only, never added to `total`" line was true of the
STOREFRONT and false of the CHARGE — `order.service.ts` never read `taxIncludedInPrice` and always
added tax on top, so an inclusive-VAT store would be shown "Incl. VAT" and charged as if it were
exclusive, the exact display-versus-charge gap M3-3 was about. `computeOrderTax` gained a 4th
argument, `includedInPrice`, that EXTRACTS tax from an already-tax-inclusive base
(`base − base / (1 + rate)`) instead of adding it; both `order.service.ts` call sites and the
storefront now derive `tax` and `total` from the identical flag, so M3-6's claim is true on both
sides as of this ruling. No live store has inclusive VAT with an active rate, so nothing charged
today changes — proven by the buy-flow-parity harness against `origin/main`.

P2 (fixed): `taxRatePercent` ignored `Store.taxEnabled` and the `tax` feature, so a merchant who
flips "Enable tax" off (which only PATCHes `taxEnabled` — existing `TaxRate` rows keep
`isActive: true`) still saw a VAT line on their own storefront. `resolveDisplayTaxRatePercent` now
gates on both, matching `TaxService.calculateTax`'s existing gate. The CHARGE resolver
(`resolveActiveTaxRate`) deliberately stays UNGATED — order creation charging a disabled-but-still-
active rate is a pre-existing gap this ruling does not close, because (a) changing what a merchant
is paid needs its own owner ruling, and (b) the buy-flow-parity fixture's VAT store has `taxEnabled`
defaulting to `false` with an active rate, so gating the charge would itself change a charged amount
against `origin/main` — the one thing this whole batch promised not to do. Cost if wrong: a merchant
with tax disabled but an old active rate row is still charged VAT server-side while their storefront
correctly shows none — a display-matches-merchant-intent gap, not a display-versus-charge gap.

P2 (fixed): the cart's non-themed fallback summary (rendered before the theme chunk loads, or
permanently if it fails to) had no VAT row despite `total` already including tax — the 6th cart path
of the "every render path" claim, missed the first time. It now renders the same row/caption the
other 6 paths do.

P2 (fixed): the inclusive-VAT row printed its amount in the same summed column as
Subtotal/Shipping/Total, so a `total` that correctly excluded it read as an on-screen arithmetic
error. All 7 render paths now show the inclusive case as a muted caption after Total
("Incl. VAT (5%) — KWD 1.000"), never a row in the amount column.

P2 (not filed, fixed anyway): `resolveActiveTaxRate`/`resolveDisplayTaxRatePercent`'s rate query had
no `ORDER BY`, so a store with more than one active rate could show a different rate than it
charged. Both now order `priority desc, createdAt asc, id asc` and `take: 1` — free to add while
already rewriting the resolver, no live-store or fixture behaviour change (every fixture has exactly
one active rate).

**Ruling M3-8 — the ACCOUNTING consumers learn the inclusive convention too (PR review, 2026-09-26).**
M3-7 taught order creation and all 7 storefront render paths that an inclusive `tax` is already
inside `subtotal`/`total`; it did not tell the two places that read `order.tax` afterwards, and
half of that convention is worse than none. `postOrderPaymentJournal` posted DR Cash = `total`
against CR revenue (`subtotal − discount`) + CR tax + CR shipping, so the credits exceeded the
debits by exactly `order.tax` and `postEntry` threw `Journal lines unbalanced` — inside an Inngest
function, so every paid order of an inclusive-VAT store with accounting on would retry, dead-letter
and never reach the books. `allocatePartialReturn` computed `cashCredit = revenueDebit + taxThis`,
refunding VAT on top of a gross line price the VAT was already inside.

The convention is now **frozen onto the order** as `Order.taxIncludedInPrice`
(`20260927130000_order_tax_included_in_price`, `false` for every existing row = the exclusive
convention they were charged under), not re-read from `Store.taxIncludedInPrice`: a merchant can
flip that switch at any time, and a refund allocated months later must read the money the way it
was charged. Revenue is now booked net of VAT under either convention, and an inclusive partial
return credits the line value and no more. Cost if wrong: unchanged for every order today — no live
store has inclusive VAT with an active rate (M3-7) and the column defaults to the old behaviour —
verified by a balanced-entry integration test on an inclusive order and inclusive allocation tests
(single return and a full telescoping sweep).

Known residual, NOT fixed here: the invoice PDF (`invoice.service.ts`) still prints `tax` as a
summed row between Subtotal and Total, so an inclusive order's invoice reads as an arithmetic
error — the same P2 the storefront closed by moving the inclusive case to a caption after Total.
Display-only; no money moves wrong.

_Amended 2026-10-01 (issue 2210, Ruling EWO-C1):_ the residual was wider than the invoice — the
storefront order detail (`OrderDetailClient.tsx`), the admin `SummaryCard` and the orders-PWA
`SummaryCard` printed the same summed row. All four now take the placement from
`orderTaxPlacement` (`@force/shared`); see EWO-C1/EWO-C2 for what is fixed and what remains.

**Ruling M3-9 — overrides M3-7's accepted residual: the CHARGE now uses the SAME gate as the
DISPLAY (owner decision, 2026-09-26, on a production read-only check: 0 rows in `tax_rates` and
`taxEnabled: false` on all 3 live stores).** M3-7 left the charge resolver (`resolveActiveTaxRate`,
used by order creation) deliberately ungated, reasoning that a merchant with tax disabled but an old
active `TaxRate` row would still be charged VAT server-side while their storefront correctly showed
none — accepted as a residual because gating the charge would have changed a charged amount against
the buy-flow-parity fixture's VAT-store scenario (whose `taxEnabled` defaulted to `false`). The
production check makes the trade-off unnecessary: no live store is in the state the old reasoning
protected, so there is nothing left to protect by leaving the gap open, and leaving it open is
strictly worse (it is the exact display-versus-charge gap this whole PR exists to close, just
inverted — the storefront now UNDER-promises what the customer is charged instead of over-promising
it, when a merchant's stale rate row and disabled toggle disagree).

`resolveActiveTaxRate` (`apps/api/src/lib/order-tax.ts`) is now the ONE resolver both
`order.service.ts` (both call sites) and `public.routes.ts` (both call sites) use — there is no
longer a second, differently-gated function for either side to call by mistake. It gates on BOTH
`Store.taxEnabled` and the `tax` feature, matching `TaxService.calculateTax`'s existing gate, and
keeps M3-7's deterministic `ORDER BY`. The buy-flow-parity fixture's `vat` store (
`scripts/buy-flow-parity/lib/fixture.mjs`) now sets `tax_enabled: true` explicitly — its `tax_rates`
row alone was never sufficient once the charge is gated, and without the fixture update the
`vat-store-mf-pct-coupon` scenario would have started charging (and showing) 0% VAT on `origin/main`
comparison runs, silently losing VAT coverage rather than proving it. The `tax` feature itself needed
no fixture change — `PLAN_BASELINE.starter` already includes `'tax'`, and the fixture's stores take
the schema's `starter` plan default with no override row.

Cost if wrong: none identified — every live store's `taxRatePercent` is already 0 under the OLD
ungated charge (no active rate exists to charge in the first place), so gating it changes nothing
observable in production; the only behaviour this changes is the buy-flow-parity fixture's synthetic
VAT store, which is deliberately re-enabled by the same commit. Verified: `tests/unit/order-tax-
resolver-gating.test.ts` (mutation-checked: taxEnabled=false + active rate → 0 both charged and
displayed; taxEnabled=true + feature on + active rate → the real rate both charged and displayed;
plus a source-assertion that no second resolver exists and both files' call sites read from this
one), and the buy-flow-parity harness against `origin/main` post-fixture-update: 16 scenarios ran,
1 clean `PASS` (`area-not-deliverable`, which never reaches order creation), 15 `DIFF` — every one
of the 30 diffs across those 15 scenarios is the SAME added field, `db.orders[0].tax_included_in_price`
/ `taxIncludedInPrice` in the order-shaped HTTP responses, `∅ (absent)` on `origin/main` → `false` on
this head. That field is M3-8's `Order.taxIncludedInPrice` column, not this ruling's own change —
`origin/main` predates that migration entirely, so its schema has no such column to compare against,
and every order (on any store, taxed or not) now carries it. Confirmed by scanning
`result.json` directly rather than trusting the harness's own exit code (piped through `tail`, which
reports `tail`'s exit status, not `run.mjs`'s — the harness's own convention is exit 1 on any DIFF):
zero of the 30 diffs touch `tax`, `total`, `subtotal`, `discount`, `shipping`, `status`, or any other
field, on the VAT-store scenario or any other. Nothing charged changed; the field itself was already
proven correct by M3-8's own tests.

---

**Ruling MCP-2 — denied-write audits coalesce to one row per (store, ip, tool,
credential) per minute, and the count is kept, not dropped (#1644 / #1649, owner
decision 2026-09-25; key wording corrected in issue 2149).**

Every refused MCP write (`add_to_cart` / `place_order` with no or a wrong
`x-agent-key`) opened its OWN interactive `runInTenantContext` transaction —
reachable by a fully unauthenticated caller, bounded only by `publicLimiter`'s
300/min/IP. A distributed prober could hold up to 5 interactive transactions
per second per IP on the small Neon pool the human checkout path shares, and
grow `audit_logs` (90 days hot, 7-year R2 archive) at the same rate: the
security control's own telemetry becoming the DoS surface (#1644, #1649).

A FIRST attempt at this fix, the same day, coalesced denials to one row per
(store, ip, tool) per 10s window via a Redis sentinel — and was reverted
within the hour (commit `af8df622`) because it dropped the repeat count
entirely: a sustained flood would have logged roughly one row per 10 seconds
with no record of how many attempts each row stood for, which could push
`classifyAgentDenials`'s volume thresholds (`anonymousFlood`, etc.) below the
real attack rate and silently mute the alert the thresholds exist to fire.
Ahmad ruled the same day that the fix ships only WITH the count preserved.

This version: the FIRST denial in a (store, ip, tool, credential) 60s window
(`DENIAL_COALESCE_WINDOW_SECONDS`; key built by `denialCoalesceKey`,
`apps/api/src/mcp/agent-auth.ts`) still writes a durable row through
`runInTenantContext`, exactly as before, and remembers the row's id in Redis.
Every REPEAT in that window costs one plain, non-transactional
`prisma.auditLog.update()` bumping that row's `details.count` — never a new
row, never a new transaction. `rls_audit_logs_tenant`'s policy admits the
unscoped update the same way it already admits an unscoped insert
(`current_store_id() IS NULL` outside any tenant transaction). If the cached
row id cannot be found (a Redis restart mid-window, a TTL race, or the update
itself failing), the code falls through and writes a fresh row rather than
dropping the attempt — self-healing at the cost of starting a new window.
Redis unavailable (`incrementRateLimit` returning 0, its documented fail-open
value) degrades to exactly today's per-attempt behaviour: one row per denial,
same as before this change. `agent.write.failed` (an AUTHORISED write that
then threw) was originally never coalesced on the claim that it requires
credential possession — corrected in the addendum below (issue 2151): only a
VALID-key caller's `failed` is per-attempt.

`credential` is part of the key on purpose: `classifyAgentDenials` PARTITIONS on
`details.credential` (`none` / `invalid` / …), so the coalescing key must be at
least as fine-grained as that partition — a coarser (store, ip, tool) key sums
attempts from different classifier buckets under whichever credential arrived
last (49 `invalid` + 1 `none` would become `credential: 'none', count: 50`, an
`info` anonymous flood instead of the p1 `integration_broken`), which
`tests/unit/agent-denial-coalesce.test.ts` pins. The bound is therefore at most
one row per (store, ip, tool, credential) per 60s — up to five per (store, ip,
tool), since `AgentCredentialOutcome` has five values; size the per-IP
transaction and `audit_logs` growth ceilings from that. Cost if wrong: a change
written against the old three-part wording would drop `credential` from the key
and bring back exactly the misclassification the test pins.

`classifyAgentDenials` (`agent-denial-alerts.ts`) and the watcher
(`agent-write-denied-watch.ts`) were updated to weigh a row by its
`details.count` (defaulting to 1 for an uncoalesced row) rather than by row
count — otherwise the classifier itself would reproduce the reverted attempt's
bug one layer up, by counting coalesced rows as single attempts.

Mutation-proven: `agent-denial-write-coalesced-with-count`
(`docs/security/defence-mutations.json`, domain `agent identity`) removes the
coalescing gate and asserts `tests/unit/agent-denial-coalesce.test.ts` goes
red; all 80 registered defences are KILLED after this change
(`docs/security/defence-mutation-record.md`).

Cost if wrong: if the Redis row-id cache and the counter ever drift (an
extremely narrow race between the `incrementRateLimit` call and the
`rememberDenialRow` write, both best-effort), a repeat in that window falls
back to writing its OWN fresh row instead of updating the existing one — one
extra row and a fresh coalescing window, never a lost attempt and never a
reintroduced interactive transaction per repeat, since the update path itself
never opens one.

Addendum (issues 2150, 2151, 2141, 2054 — backlog batch d-routes-mcp,
2026-10-01). (a) The `failed` exemption is now gated on the GRANT, not the
outcome: only `grant === 'credential'` gets a per-attempt `agent.write.failed`
row; an `open_writes` (escape hatch on, `credential: 'none'`) `failed` is
coalesced under its own `agent:failed:` key, because "requires credential
possession" is false on exactly the rollback lever most likely to be on during
an incident. (b) Concurrent repeats: the first writer `SET <key>:row pending NX
EX 45` before inserting; a repeat that reads `pending` writes nothing (its INCR
already happened, and the writer re-reads the counter after publishing the row
id, so it is carried); a failed insert releases the reservation. (c) The key's
ip is `ipKeyGenerator(ip)` (express-rate-limit's /56 IPv6 prefix, identical to
`publicLimiter`'s default bucketing). (d) A rejected `incrementRateLimit` reads
as 0 (per-attempt fallback) instead of dropping the row. Accepted residuals:
concurrent flushes to one row are last-writer-wins, so a count can briefly
read lower than the counter until the next flush; and a process that dies
holding a `pending` reservation suppresses that window's rows for up to 45s
(its attempts stay in the counter and the next row's `base` skips them). A
reserving insert that FAILS (pool timeout / P2028) no longer loses the burst:
it releases the slot and writes one plain, non-transactional row carrying the
counter's attempts (PR 2301 audit). Cost
if wrong: an under-count of at most one window's in-flight attempts on a
single row — never a per-attempt transaction for an anonymous caller.

**Ruling S1-11 — merge of main (#2088): the merchant-MCP limiters keep main's
`mmcp` / `mmcp-ip` prefixes but resolve Redis per request through
`rateLimitRedisClient`.** Main added `makeRateLimitStore(redis.getClient(), …)`
to both merchant-MCP limiters while this branch added its own
`'merchant-mcp'` store to one of them; a union would be a duplicate `store`
key. `redis.getClient()` evaluated at module load is null (routes are imported
before `redis.connect()`), which is exactly the #1862 per-process MemoryStore
defect this batch fixes, so main's two stores were switched to the lazy
resolver and this branch's duplicate dropped. A sweep of `apps/api/src` found
no other eager `makeRateLimitStore` call. Cost if wrong: the `mmcp` budget
keys differ from the `merchant-mcp` name this branch first used, which only
matters if something outside the code reads those Redis keys by name; grep
finds nothing that does.

## 2026-09-26 — Answer-engine Gemini grounding (issue #929)

Context: audit-followup P2 `apps/api/src/services/answer-engine/gemini.provider.ts:47` — the
adapter's only grounding tool shape (`googleSearchRetrieval`, from `@google/generative-ai@0.24.1`)
was live-measured against the production key and found to be REJECTED (HTTP 400) by every 2.x
model, so the "ChatGPT/Gemini cites your store" signal had never fired. Branch
`fix/answer-engine-free-grounding`.

**Ruling GEM-1 — call the Gemini REST endpoint with plain `fetch`, not the `@google/genai` SDK.**
Both fix the tool-shape bug (the maintained SDK exposes `googleSearch: {}`; the REST API takes
`google_search`). A new SDK dependency means a lockfile regen and a fresh dependency-discipline
pass (registry/license/audit/leaf-override) for a single call site, when the sibling
`perplexity.provider.ts` / `openai.provider.ts` adapters in the same directory already call their
providers' REST APIs directly with `fetch` — no SDK — for exactly this reason ("per the task
constraint", their own file headers). Matching that pattern is the smaller, safer, more consistent
change: zero new dependencies, zero lockfile/audit surface, one fewer SDK version to track for
drift. Cost if wrong: a future Gemini REST response-shape change breaks this adapter without an SDK
maintainer's typed layer to catch it at compile time — mitigated by the defensive, untrusted-input
parsing already required of every other provider adapter in this file (`detectCitation` in
`provider.ts` is explicit about this contract).

**Ruling GEM-2 — default model is `gemini-2.5-flash-lite` (free), not a `-latest` alias.** Live
probes against the production key (2026-09-26): `gemini-2.5-flash-lite` + `google_search` → HTTP
200, `groundingChunks` populated, free. `gemini-flash-lite-latest` / `gemini-flash-latest` /
`gemini-3.5-flash-lite` + the same tool → HTTP 429 ("exceeded your current quota") — grounding is
paid-only on those aliases. `gemini-2.5-flash` → HTTP 404 (retired for new users). Per owner
decision (Ahmad, free option), the default points at the verified-free model; a merchant/operator
who wants a paid, higher-quality model can still override via `ANSWER_ENGINE_GEMINI_MODEL`. Cost if
wrong: if `gemini-2.5-flash-lite` is later retired or rationed the same way, every scan silently
falls back to ungrounded (by design — see GEM-3) until an operator notices the dashboard's new
"grounding unavailable" caveat and re-probes for a new free model.

**Ruling GEM-3 — a persisted `groundingUnavailableReason` column, not a log-only signal.** The
brief's fallback contract ("record the answer as not-grounded with a reason so the dashboard shows
'search grounding unavailable'") needs a signal the merchant-facing dashboard can read, and
`AnswerEngineCheck` had no column carrying the in-memory `EngineAnswer.grounded` flag at all (see
the pre-existing `GROUNDED-CAVEAT PROXY` note in `dashboard.service.ts` — the existing
`groundedCaveat` is already a proxy off `citedUrls` emptiness because of this gap). Reusing that
proxy for the new "grounding could not run" case would conflate it with "grounding ran fine, cited
nothing" — a merchant told "no live citations found" when the real cause is a rationed model reads
as their store's real citation performance. Added one nullable, additive `TEXT` column
(`grounding_unavailable_reason`) instead — no RLS policy change needed, the tenant policy on
`answer_engine_checks` is table-level. Cost if wrong: a schema change for what could have been a
log-line; the residual is a single small migration against an append-only table, reversible by
dropping the column.
Context: branch `fix/p2-r3-residuals` — four items previously parked as needs-owner or accepted
residuals, decided by the owner rule "fix everything" (Ahmad, 2026-09-25): #1955, #1608, #1766,
#1954.

**Ruling R3-1 — #1955: campaign concurrency is per store, and the platform-wide bound is a
Redis-coordinated send pacer, not an Inngest `throttle`.** The decision asked for a per-store
concurrency key plus "a platform-wide Inngest `throttle` (or equivalent)". Inngest's `throttle`
limits how often a function RUN starts; one `campaign-send` run sends up to
`CAMPAIGN_DAILY_SEND_CAP` emails, so a run-start throttle cannot bound the per-email rate at all.
The equivalent that does is `lib/campaign-send-pacer.ts`: every send reserves the next slot on one
Redis key (atomic Lua, Redis clock), `CAMPAIGN_PLATFORM_SEND_INTERVAL_MS` apart. The default is 1000ms (≤1 campaign email/s across all
stores), not the 1.5/s the decision allowed: 1/s is exactly the ceiling today's platform-wide limit
gives, so transactional mail keeps the ≥1 req/s of Resend's 2 req/s it has now — and transactional
sends outside the order-email queue are not retried on a 429. Stores now interleave on that budget
instead of queueing behind each other's whole campaign. Without Redis it falls back to an in-process slot, which is still global on one replica and
never blocks sending. Cost if wrong: with Redis down AND more than one API replica, the combined
campaign rate could reach 1/s × replicas and Resend would 429 — which the job already treats as
transient (the step retries, nothing is lost or double-sent).

**Ruling R3-2 — #1954: the test send runs its reads in a short tenant transaction and calls Resend
after that commits, on a router mounted without `tenantContext`. Supersedes the test-send half of
EC-8.** `deferAfterTenantCommit` was rejected because it runs after the response, so the route
could no longer report what Resend accepted; the decision required an honest result. The route
keeps the full chain (authenticate → authorize → requireStoreAccess → requireFeature) on itself and
is mounted before the tenant-scoped campaign router; `tests/unit/campaign-routes.test.ts` asserts
both the mount order and that no transaction is open at either send (mutation-checked). The
AI-draft half of EC-8 is NOT changed: every `/stores/:storeId/ai/*` route makes its Gemini call
inside the tenant transaction the same way, so moving one of them alone fixes nothing class-wide.
Cost if wrong: a slow Gemini response still holds one tenant transaction open (bounded by the 30s
transaction timeout) until the AI routes are moved as a class.

**Ruling R3-3 — #1608: the COMMIT wait is bounded at 10s by default, and on expiry a would-be 2xx
becomes a 503 `COMMIT_TIMEOUT`, not a 500 and not the 2xx.** The issue suggested "a few seconds";
10s was chosen because a false timeout on checkout is worse than a slow one: it tells a shopper an
order failed that may have committed, and that request then commits anyway. A healthy COMMIT is
milliseconds, so 10s only fires on a genuinely stalled connection (failover, lost pooler slot),
which previously held the socket until Cloudflare's 100s edge timeout answered 524. 503 (not 500)
because the outcome is UNKNOWN rather than failed, and the message tells the client to check before
retrying; a late COMMIT/ROLLBACK is logged so the outcome can be resolved. The deadline is not
`server.requestTimeout`, which bounds request receipt and never fires on a response wait. Measurement
is the `Server-Timing: request-tx` header on every buffered response plus a warn log over 1s; no
p99 load-test assertion was added (the existing `loadtests/` are run by hand, not in CI). Cost if
wrong: a COMMIT that takes 10-100s now yields a 503 over a write that may have landed — the same
unknown outcome the 524 already gave, now alerted and logged instead of silent.

**Ruling R3-4 — #1766: a deleted-product cart line is flagged `unavailable`, priced OUT of the cart
subtotal, marked on /cart in all five themes and the default list, and left in the cart for the
shopper to remove. Supersedes P2-B3-2.** "Unavailable" means exactly what the checkout refusal
tests — `products.deleted_at IS NOT NULL` — so the cart and `OrderService.create` cannot disagree
about which lines block an order. The amount expression that moved is the cart's DISPLAY subtotal
(`CartService.computeTotals`, CartContext `total`/`itemCount`, the coupon quote basis, the checkout
summary). No order total moved: `OrderService.create` still refuses the whole order while any such
line remains, so every order that is placed has no unavailable line and its subtotal is
byte-identical to before. Checkout therefore still never charges a deleted line; it refuses, now
naming the product and refetching the cart so /cart shows the mark. A line whose product is merely
`draft`/`archived` is NOT flagged — checkout does not refuse those either, and changing that is a
separate product decision. Cost if wrong: a cart whose every loose line is deleted shows checkout's
"Your cart is empty" screen rather than the refusal copy, because the summary no longer lists
unorderable lines. _(Residual closed by EWO-D2 — #2116/#2117.)_

## 2026-09-30 — Analytics batch 1 (branch `fix/analytics-batch-1`, PR #2220)

Context: `force-website-builder-audit-analytics-2026-09-30.md` findings 1, 2, 5, 6, 8, 9, plus the
owner decision of 2026-09-30 (no guest contact capture at checkout; payment abandonments stays off
on pecannbee).

**Ruling AN-1 — on a store that takes guest orders, a 0 from an `abandoned_carts`-derived metric
renders "not tracked for guest checkout"; a non-zero count renders as a number labelled
"registered customers only".** Abandoned carts are recorded only with a customer contact, so a 0 on
such a store says nothing about shoppers (pecannbee: 0 checkouts started vs 55 completed in 30d).
"Takes guest orders" = at least one order with `customer_id IS NULL` in the surface's window (90d
for abandoned-cart stats). Paid or not: every surface reads it through `storeTakesGuestOrders`
(`lib/guest-checkout.ts`) — the insights dashboard used to derive it from its PAID orders and read
`false` on a store whose guest orders are unpaid COD (issue 2257). A non-zero count is real, just
partial, so it is kept rather than hidden.
Cost if wrong: a mixed store (e.g. wady-aljuz, 5/41 orders registered) shows a registered-only
undercount next to all-customer figures; the label is the only guard against reading it as total.

**Ruling AN-2 — dead-stock flags for products with no cost price store `stock_value_fils = NULL`
and are flagged on the 90-day rule alone.** The value threshold (KWD 50) cannot be applied to an
unknown value; skipping them made the scan blind on stores that never entered costs, and storing 0
would be a false value. Cost if wrong: a store with many cheap, slow products and no costs sees more
flags than the value threshold would allow once costs are entered.

**Ruling AN-3 — duplicate open scan rows are cleaned by marking older duplicates `expired`
(script, not run), never by deleting.** Reversible, and uses the status the scans' own 30-day
expiry already writes. Cost if wrong: expired history carries ~4.9k extra rows until any retention
job removes them.

**Ruling AN-4 — accepted residual: the Chromium bar-height layer of
`tests/unit/analytics-bar-charts-render.test.tsx` SKIPS in the CI unit job (no browser installed).**
The static layer (bar column carries `h-full justify-end`) still runs in CI; the pixel layer runs
locally with `CHROMIUM_PATH` and was mutation-proven there (measured 0px without `h-full`). Cost if
wrong: a future layout change that keeps both classes but still collapses the bars would pass CI.

**Ruling AN-5 — `conversionRate` means ONE thing: orders per product view (the /analytics KPI,
ruling AP-8). The insights dashboard's orders÷carts figure is renamed `cartToOrderRate` and
labelled "Cart → order".** Merging main put two different rates under the same field name: the
analytics `conversionRate` (orders / product views, `conversionRateBasis:
'orders_per_product_view'`) and this branch's `yesterdayFunnel.conversionRate` (orders / carts
created). Both are useful and both come from `funnel_snapshots`, so neither was dropped; the
cart-based one takes the name `funnel-report.service.ts` already uses for it (`rates.cartToOrder`),
and the admin card label changes from "Conversion" to "Cart → order" / «من السلة إلى الطلب». The
analytics field keeps its name because the MCP `admin_get_dashboard` tool and swagger already
publish it. Asserted in `tests/unit/insights-routes-contract.test.ts` (the dashboard payload has
`cartToOrderRate` and no `conversionRate`). Cost if wrong: a merchant compares "Cart → order" on
Insights with "Conversion rate" from the API/MCP and still expects them to match — they measure
different denominators by design.

**Ruling AN-6 — insights repeat-purchase groups buyers with `customerKeyOf`; this branch's
`guestKey` (`GUEST:sha256("<email>:<phone>")`) import is removed.** Main deleted `guestKey` from
the RFM rollup in favour of `customerKeyOf` + `rfmKeyFor` (ruling AP-12). The repeat-purchase rate
now groups exactly as the Customers page and RFM do: user id, else lowercased (untrimmed) email,
else phone. Behaviour change: a guest who reuses an email with a new phone is ONE buyer (was two);
an email differing only by surrounding whitespace is now TWO (was one) — the Customers-page rule,
kept for URL stability. Cost if wrong: a store whose guests type emails with stray spaces sees a
slightly lower repeat rate than the old key gave.

**Ruling AN-7 — one unknown-state pattern across the analytics surfaces: never a 0 for a figure we
cannot compute. A KPI card shows the word "Unknown" plus a one-line reason (and a fix link where one
exists); a dense table cell or a rate shows "—" with the reason next to it.** Main's profit card
(`AnalyticsStatsGrid`: "Unknown" + "cost price missing on N items" + "Add cost prices") is the card
form; this branch's insights rates/products "—" and dead-stock "Unknown (no cost price)" are the
table form. The GL Gross-profit card (`GlKpiCards`, AP-11's open residual) joins the card form: when
the period has GL revenue but zero COGS it shows "Unknown" with "no cost of goods was booked" instead
of repeating revenue. Residual: GL Net income is still shown when COGS is 0 (other expenses make it a
real, if COGS-less, figure). Cost if wrong: a store that genuinely sells zero-cost goods (services,
digital) sees "Unknown" gross profit where revenue would have been correct.

**Ruling AN-8 — dead-stock value is variant-aware (closes AP-10's left sibling).** Main's
`STOCK_VALUE_SQL` values each active variant at its own cost, falling back to the parent's; this
branch's scan multiplied the variant sum by the parent cost. `deadStockValueFils` is its JS twin,
differing only where AN-2 requires: an on-hand unit with no cost anywhere makes the value `null`,
not 0. The open-row dedupe (one open flag per product) is unchanged. Asserted in
`tests/integration/accounting/deadstock-scan.test.ts` (variant costs 3000/4000 × 10 → 70000; the
disabled variant excluded). Cost if wrong: none beyond AP-10's — the two valuation paths can drift
if one is edited without the other.

GL cards + cashflow after the merge: `glRevenueWindow` reads main's corrected `profitAndLoss`
(period-filtered) with this branch's `startDate`/`endDate` window; `cashflowTrend` keeps main's
`status IN ('posted','reversed')` refund dedupe and receives this branch's picker range.

## 2026-09-30 — accounting + profit batch (branch `fix/accounting-profit-batch`)

Audit: `force-website-builder-audit-accounting-mcp-2026-09-30.md` findings 1–6.

**Ruling AP-1 — the balance sheet's retained + current earnings row is COMPUTED,
not posted.** The ledger has no period-closing entries, so cumulative revenue −
expenses up to `asOf` still sits in P&L accounts; `balanceSheet()` adds it as one
equity row (`kind: 'current_earnings'`) from the same `asOf` totals. Nothing is
written to the ledger. A future period-close entry moves those balances into
equity and the computed row shrinks by exactly that amount, so the two cannot
double count. Cost if wrong: an accountant expecting a posted retained-earnings
account sees a computed row instead, with no ledger lines behind it.

**Ruling AP-2 — `order/refunded` is sent after the request transaction commits
(`deferAfterTenantCommit`).** Evidence: wady-aljuz ORD-1781512189610-9972A710 —
a delivered→refunded change rolled back (30 s request-tx timeout, 2026-07-09)
while its reversal had committed and the event had been sent; the GL reversed a
refund that never happened. Outside a request the send stays inline and a failed
enqueue still throws. Accepted residual: inside a request, a post-commit enqueue
failure can no longer roll the request back — it is alerted by
`deferAfterTenantCommit`, and a WHOLE-order reversal is re-sent by
refund-reversal-stuck-sweep (its `refundReversalRequestedAt` stamp commits with
the request). A PARTIAL-return event has no sweep. Cost if wrong: a partial
return whose post-commit enqueue fails keeps its returned lines' stock and GL
unadjusted until someone replays it from the alert. _Residual closed
2026-10-01 (issues 2246 / 2267):_ `applyRefundEffects` now stamps
`Return.reversalRequestedAt` in the completing transaction, the fanout's
partial arm stamps `reversalAppliedAt`, and refund-reversal-stuck-sweep
re-sends the item-level event (notify:false) for a return requested but not
applied (`handlePartialReturnReversalSweep`; migration
`20261001090000_return_partial_reversal_stamps`). No 12h recency floor on this
branch: the column is new, so there is no back-catalog, and a floor would
abandon a return armed before a long Inngest outage. A request that rolls back
after a gateway refund is still the refund-key path (REFUND_ALREADY_ISSUED →
record-only completion), not this sweep.

**Ruling AP-3 — `postOrderPaymentJournal` books no sale for an order that is
already `cancelled` or `refunded`.** Evidence: ORD-1778670342233-50212B65
(refunded by status in May, `paymentStatus` left `paid`) had its sale posted on
2026-07-09 by the order-created stuck sweep's fanout, with nothing left to
reverse it. A paid order cancelled later is reversed by the refund path, so
"no sale" is the same end state. Cost if wrong: a paid order whose status is
cancelled but whose money was knowingly kept books no revenue.

**Ruling AP-4 — the ledger correction for ORD-1781512189610-9972A710 reverses the
erroneous reversal (JE-2026-000020) with the standard `reverseEntry`.** No row is
edited or deleted. The re-booked sale carries source id `…:reversal:reversal`,
which `postRefundJournal` does not look for. Cost if wrong: if that one order is
ever genuinely refunded, its 9.500 KWD sale stays booked until reversed by hand.
Script: `scripts/fix-ledger-order-mismatch-2026-09-30.ts` — NOT RUN, awaits Ahmad. Its optional
`--fix-stock` step refuses (dry run included) if any of the three products has a variant, and re-checks
that under the row lock: `products.inventory` is not a variant product's stock (issue 2273). It busts the
storefront product caches after commit rather than waiting out the TTL.

**Ruling AP-5 — backorder line cancel still fires a WHOLE-order `order/refunded`
(not changed here).** `cancelBackorder` passes `restoreInventory: false` but no
`partial`, so the GL poster reverses the entire sale of a still-live order. It is
not the cause of either production row (0 backorder lines in prod) and the right
ledger shape for a single cancelled line (a pro-rata adjustment via
`postPartialReturnJournal`?) is a semantics decision. Needs the owner. Cost if
wrong: the first merchant to cancel a backorder line on a paid order gets the
whole sale reversed in the ledger.

**RESOLVED 2026-09-30 (branch `fix/backorder-line-cancel-ledger`) — owner decision
(Ahmad): cancelling ONE backorder line reverses only THAT line's amount.**
`cancelBackorder` now fires the item-level event (`partial`, refundKey
`backorder:<lineId>`, units = `qty − qtyFulfilled`), so the GL posts through the
partial-return path: that line's revenue net of its discount share, its VAT
share, its COGS — with the partial-return allocation, not a new one. Whole-order
cancel/refund is unchanged and backs these adjustments out. Idempotency follows
returns: the cancel is claimed by a conditional update in the same `withMoneyTx`
that writes a `backorder_line_cancelled` orderEvent (the backorder twin of a
completed Return row); the GL keys on `${orderId}:partial:backorder:<lineId>`, and
the event is sent after commit (`deferAfterTenantCommit`). Proven in
`tests/integration/accounting/backorder-line-cancel-ledger.test.ts` (7 tests, 5
mutations each turned a test red).

**Ruling AP-5a — the backorder cancel marker counts as a PRIOR reversal
everywhere the partial allocation runs.** `loadPriorReversedQty` sums completed
Return rows AND `backorder_line_cancelled` markers for the GL posting,
`ReturnService.allocateThisReturn` and `computeStoreCreditAmount`, and
`ReturnService.create` counts the cancelled units as not returnable. Without it
the cumulative discount/tax allocation stops telescoping (measured: cancelling
all three lines of a 1000-discount / 777-tax order one by one left fils on
revenue, tax and cash) and a later return could re-claim units that never
shipped. `allocateThisReturn`'s `allLinesNowReturned` therefore also treats a cancelled
backorder unit as gone: a return that takes back the rest of such an order is sent to the
provider as NOT item-level, and if it exhausts the payment the whole-order reversal runs —
which backs the line adjustments out, so the GL still nets to zero. Backorder lines cancelled by the refund FANOUT get no marker — their
units are already the Return row's, or the sale was reversed whole. Cost if
wrong: none known; the marker is written only by `cancelBackorder`.

**Ruling AP-5b — accepted residuals of the line cancel.** (1) Shipping income is
never reversed by line cancels, as with partial returns: cancelling every line
one by one leaves exactly the shipping charge booked against cash (pinned by a
test); a whole-order cancel is the path that reverses it. (2) The adjustment
credits the sale's cash account, as a partial return does, but `cancelBackorder`
does not itself refund the provider — the merchant refunds the line off-platform
(or via the order's refund action). (3) The fanout's "Refund issued" notification
now fires only when `paymentStatus === 'paid'`, and states the line's allocated
amount instead of the order total. (4) As with returns, two cancels whose events
are processed out of order can each count the other as prior; the rounding
remainder can then land 1 fil off. Cost if wrong: a merchant with shipping on a
fully-cancelled backorder order sees shipping income remain until they cancel
the order; a line cancelled but never refunded at the provider shows cash lower
than the gateway balance.
AMENDED 2026-10-01 (issue 2275): the admin no longer says otherwise. The cancel
button reads "Cancel line & reverse the sale" (was "Cancel & Refund"), the modal
states up front that no money is sent, the reason label no longer claims it is
"sent to customer" (it lands only in the order event and the journal memo), and
`cancelBackorder` returns `owedToCustomer` (the allocated `cashCredit` when the
order was paid, else 0) so the modal names the sum the merchant must still refund
at the provider. (3) is unchanged: the customer's "Refund issued" email still
fires at cancel, before the merchant's off-platform refund. Cost if wrong: a
customer is told a refund was issued a little before the merchant actually sends
it — the admin now tells the merchant to.

**Ruling AP-6 — margin_drop is not evaluated unless BOTH windows booked COGS.**
With no cost of goods the margin is 100% by construction; the week cost prices
first appear it would "drop" and page. Cost if wrong: a store whose COGS stops
posting entirely (cost data outage) no longer gets a margin alert for it —
cost_spike and revenue_drop still run.

**Ruling AP-7 — partial profit is shown WITH a note, unknown profit as null.**
`totalProfit` is `null` only when sold lines exist and none has a cost; when some
do, the figure covers the costed lines and `profitItemsMissingCost` /
`profitRevenueMissingCost` travel with it (the UI says what is excluded);
`profitChange` is `null` unless both periods are complete. Cost if wrong: a
merchant who ignores the note reads a partial profit as the whole.

**Ruling AP-8 — `conversionRate` is orders per PRODUCT VIEW (%), from the nightly
`funnel_snapshots`, labelled `conversionRateBasis: 'orders_per_product_view'`.**
There is no session tracking, and `checkouts_started` is 0 everywhere (it counts
abandoned-cart rows, which guests never create — audit finding 6b/6c, not in this
batch). No views → `null`. Cost if wrong: a consumer compares it with a
session-based rate from another platform and reads it as low.

**Ruling AP-9 — COGS posting is fed, not changed.** `order-posting.ts` already
books DR 5000 / CR 1200 per line with a cost; it was never fed because
`order_items.cost_price` was null (348/349 in prod). Variant cost is now
snapshotted, so COGS posts for NEW orders only. Historical orders are not
backfilled (that is a production write + a posting-date decision). Cost if
wrong: P&L before this deploy keeps 0 COGS until a backfill is ruled.

**Ruling AP-10 — valuation siblings fixed here vs left.** Fixed: finance
dashboard stock value, analytics inventory snapshot (+ backorder demand value),
inventory page stats/list/low-stock rows — all via `STOCK_VALUE_SQL`. Left:
`deadstock-scan.service.ts` (product-level cost) — the open `fix/analytics-batch-1`
branch rewrites its stock-value column; fixing it here would collide. Cost if
wrong: dead-stock flags keep valuing variant products at the parent cost until
that branch or a follow-up lands.

**Ruling AP-11 — surfaces that also show profit but were not edited here:**
the analytics GL KPI cards (`GlKpiCards.tsx`) and `insights/products` are being
rewritten on the open `fix/analytics-batch-1` branch. The "Add cost prices to
see profit" explanation ships on the analytics profit card, which sits directly
above the GL cards. Cost if wrong: the GL "Gross profit" card still equals
revenue with no explanation until those branches reconcile.

**Ruling AP-12 — ONE customer key: main's `customerKeyOf` (`lib/customer-key.ts`) is canonical;
this branch's `customerKeyForOrder` is removed.** Merging main (MCP read tools + RFM key
unification) brought a second helper under the same path. Compared line by line, the semantics are
identical: registered user id → shipping email lowercased (not trimmed) → shipping phone verbatim →
nothing. The only difference was the contact-less case, which `customerKeyOf` returns as `null`
(RFM skips it) and the Customers list maps to `guest:<orderId>`; `customerKeyForOrder` baked that
fallback in. Analytics `totalCustomers`/`allTimeCustomers` use the SQL twin `CUSTOMER_KEY_SQL`
(`lib/customer-key-sql.ts`), which now documents itself as `customerKeyOf(o) ?? 'guest:' || o.id` and
is asserted equal to it in `tests/integration/analytics-customer-key.test.ts`. The list, export,
customer detail, MCP customer tools, RFM and cohorts all group through `customerKeyOf`. Residual:
the JS side lowercases with `toLowerCase()` and the SQL side with Postgres `LOWER()`; they agree for
ASCII and ordinary Unicode but may differ for locale-special code points (e.g. Turkish dotted I).
Cost if wrong: a guest whose email contains such a character is counted once by the page and twice
(or vice versa) by analytics — an off-by-one in a KPI, not a money figure.

**Ruling AP-13 — analytics customer counts and the Customers-page KPI strip measure different
things, on purpose.** Analytics counts distinct keyed customers with an order of ANY status (as the
list's order-derived rows do) — so `allTimeCustomers` equals the list's `summary.customers` whenever
the store has no zero-order registered customers and the scan was not truncated. The page's
`summary.customers` additionally includes registered customers who have never ordered (#1882 union),
and `summary.buyers` excludes customers whose only orders are cancelled/refunded (PR 2218). Revenue and
order counts in analytics exclude cancelled/refunded while its customer count does not — kept, because
the card answers "who has ordered", matching the list the merchant drills into. Both relations are
asserted in `tests/integration/analytics-customer-key.test.ts` (page == analytics on the shared
fixture; +1 page row for a zero-order signup; `buyers` one lower for a cancelled-only customer).
Cost if wrong: a merchant reads "Customers 6" on analytics next to "Buyers 5" on the Customers page
and must hover the labels to see why.

## 2026-09-28 — PR 1978 scoped-audit remediation (branch `fix/p2-other-o1`)

**Ruling O1-1 — the drift check alerts on a stall at 90 minutes or 10 waiting deploy-path
commits, measured from the oldest undeployed FIRST-PARENT commit on the deploy job's own
trigger paths.** The deploy job's timeout is 30 min, so 90 leaves a full retry window; the
path filter mirrors `railway-deploy.yml` (test-enforced) because a web-only commit never
triggers a deploy and would otherwise read as permanently undeployed; first-parent because a
merged branch's commits carry their authoring dates, not their merge time. Verified against
the real `main` and live `/health` on 2026-09-28: up to date, exit 0. Cost if wrong: a
Railway auto-deploy (pre-cutover) that routinely takes over 90 min raises a false stall alert
every 30 min until the bound is raised.

**Ruling O1-2 — the drift check now runs unconditionally and only flags a truthy-looking
`RAILWAY_ACTIONS_DEPLOY` (`True`/`TRUE`/`1`/`yes`/`on`) as misconfigured; unset and `false`
are treated as deliberate.** `/health` reports the live commit today (`51e7372f`, Railway's own
auto-deploy stamps `RAILWAY_GIT_COMMIT_SHA`), so the comparison is meaningful pre-cutover too.
Cost if wrong: a post-cutover variable DELETED outright is not flagged by rule 1 — it is
caught only by the stall rule, up to 90 minutes after the first undeployed API merge.

**Ruling O1-3 — accepted residual: legacy `audit-cmt:` location comments keyed on the old
`dimension|file|line` fingerprint are not normalised.** `extractFingerprint` now normalises
legacy ISSUE markers (195 of 200 open followups carried one), which was the duplicate-issue
defect. A location comment's marker is matched exactly, so the first run per (issue, PR) after
the change posts one new comment instead of editing the old one, and edits the new one after
that. Cost if wrong: at most one extra comment per (issue, PR) pair, once.

**Ruling O1-4 — the Security Audit job budget test allows 120s for checkout + setup + jq +
trufflehog.** Measured 3–22s across 30 recent runs; one earlier main run showed trufflehog at
589s, which no budget short of a larger one covers and which is outside the audit-retry
change. Cost if wrong: a slow trufflehog download on a cold-install, slow-registry run can
still cancel the 18-minute job.

**Ruling O1-5 — `docs/security/defence-mutation-record.md` is not regenerated.** The only
recorded defence in a touched file is `tenant-product-faq-ownership` (product.routes.ts, where
this change only added `export` to `updateProductSchema`); its mutation is text-anchored and
re-ran KILLED with `--tier=all --only=tenant-product-faq-ownership`. The record is derived from
spec + verdicts, so a regeneration would be byte-identical. Cost if wrong: none beyond a stale
line count the next full `--write` corrects. (2026-09-30: the 2026-09-30 merge of `origin/main`
into this branch conflicted on the record, so it WAS regenerated there — `--tier=all --write`
against a scratch local DB, not hand-merged.)

## 2026-09-30 — P2 batch OTHER-O3: merge of main (#2073, #2088)

**Ruling O3-M1 — the public bundle list keeps this branch's dedicated
`bundlesCacheKey`, not main's `public:products:<id>:bundles:list`.** Both sides
cached the same #1565 N+1 under different keys. The dedicated key is cleared by
`clearProductsRedis` (so every product/stock write — the inputs a bundle's price
and availability derive from — busts it, exactly as main's prefix placement
intended) AND by `invalidateStoreBundlesCache` on every bundle write, and keeps
the `take: 200` fan-out cap. Main's integration test (direct DB deactivation,
then `invalidateStoreProductCaches`) passes against it unchanged. Cost if
wrong: none beyond the key name; nothing else reads `bundles:list`.

**Ruling O3-M2 — the bulk-AI store busts use main's `bustStoreCachesById`, and
store-only sweeps no longer bust product caches.** This branch had added
`bustStoreCaches(storeId, null)`, which skips the `public:store:<slug>` and
`public:store:resolve:<domain>` keys; main's by-id helper is a strict superset.
The two remaining null-slug sites main never touched (geo citation, seo) were
converted too, and `bulk-ai-sweeps-bust-store-cache.test.ts` now pins "every
sweep busts the store by id" (mutation-checked: restoring the null-slug call in
seo reddens it) while main's `bulk-ai-store-cache-bust.test.ts` pins which
sweeps also bust products. Cost if wrong: one extra `store.findUnique` per
sweep completion.

**Ruling O3-M3 — `resolveReturnTo` (this branch) is dropped for main's
behaviour-identical `sanitizeReturnTo`.** Both fixed #670 the same way; this
branch's two extra regression cases (`50%25+off`, a stray `%`) were ported onto
main's test. Cost if wrong: none — same function body.

## 2026-09-30 — PR #1977 scoped-audit P1 + follow-ups

Branch `fix/p2-other-o3`.

**Ruling O3-R1 — the three R2 reference collectors are replaced by ONE registry,
and it over-registers.** `apps/api/src/lib/r2-references.ts` `R2_REFERENCE_COLUMNS`
now drives `scripts/r2-orphan-audit.ts`, the weekly `r2-orphan-sweep` and
`r2-cleanup.service` `isStillReferenced()`. Columns that may only rarely hold an
upload (`Store.socialLinks`, `marketingPixels`, `heroCtaLink`,
`StockAdjustment.evidenceUrl`, `SystemSetting.value`, blog/campaign HTML) are
registered, not allowlisted: an extra column costs one query, a missing one
deletes live files. `tests/unit/r2-reference-registry.test.ts` fails when a Json
or URL-shaped String column is neither registered nor allowlisted with a reason
(mutation-checked: dropping `pwaSettings` reddens 4 unit tests and the
integration test; adding a `Bundle.promoVideo` column reddens the gate). Cost if
wrong: an orphan in an over-registered column is never swept — storage cost only.

**Ruling O3-R2 — `json`/`text` columns match the R2 KEY as a substring, not the
exact URL.** Catches both URL forms (public vs endpoint) and URLs inside HTML.
A substring false positive keeps a file alive, never deletes one. Cost if wrong:
a handful of orphaned objects whose key happens to appear inside another value.

**Ruling O3-R3 — the DataTable `ariaLabel` P2 (0 of 54 call sites pass it) is
not fixed on this branch.** It is 54 call sites plus EN+AR i18n keys for each,
unrelated to the P1, and the prop is already optional-and-harmless. Unblock:
a follow-up PR that makes `ariaLabel` required so tsc enumerates every call
site. Cost if wrong: admin tables stay unnamed to screen readers until then.

**Ruling O3-R4 — low-stock duplicate digests are closed with a short SET NX
`pending` claim (1 h), not an Inngest concurrency key.** Inngest concurrency
limits concurrent steps, not whole runs, and the cron and on-demand functions
share no key — so neither would stop cron + "Scan now" overlapping. The claim
is atomic across both. Cost if wrong: a digest whose send fails permanently
re-alerts after 1 h instead of on the next scan.

**Ruling O3-R5 — `invalidateStoreBundlesCache` keeps its own revalidate POST.**
The storefront bundle fetches now carry `bundles:<storeId>`, so the tag is real
and the doc comment true; bundle writes still send two POSTs (this one plus
`invalidateStoreProductCaches`'). Cost if wrong: one redundant revalidate
request per bundle write.

## 2026-09-30 — Admin UI: coupons chrome, feature-flag staleness, Customers page (branch `fix/admin-ui-coupons-features-customers`)

Source: `force-website-builder-audit-accounting-mcp-2026-09-30.md` §8, §9, §10.

**Ruling AUI-1 — the Customers KPI "Total spent" / "Avg order value" / "Repeat rate" count orders
with `status NOT IN ('cancelled','refunded')`; the table's per-row "Total spent" keeps its existing
all-status sum.** The KPI population is the same one the dashboard's revenue uses
(`analytics.service.ts` `getPeriodStats`), so the two pages cannot disagree about what "spent"
means; the KPI card says "All orders except cancelled and refunded — paid or not" (issue 2235: the
earlier "Excludes cancelled and refunded orders" implied collected money, but a `pending` or
`failed`-payment order is counted; whether the population should exclude unpaid/failed payments,
here AND in `getPeriodStats`, is an open owner question on issue 2235). The row column was not changed
because it also feeds the detail page and the export, and changing its meaning is a separate
decision. Cost if wrong: on a store with cancelled orders the KPI total is lower than the sum of the
row column, which the card label explains but a merchant may still question.

**Ruling AUI-2 — `GET /customers?segment=<rfm>` is refused (403) for `staff`.** `staff` can read the
list, but RFM segments are served by `rfm-batch` to store_admin/super_admin only; filtering by a
segment would let staff enumerate segment membership. `segment=guest` and the plain list stay open to
staff. Unknown segment values are ignored (unfiltered list), not a 400, so a stale link still loads.
Cost if wrong: staff who legitimately need segment views must ask an admin.

**Ruling AUI-3 — #2046, #2049, #2051 (duplicate / phantom / zero-spend rows in the aggregation) are
NOT fixed in this branch.** The KPI "Customers" count inherits them because it counts the same rows
the list shows; on a truncated store (>20k orders) every KPI is marked "Recent orders only" rather
than presented as complete. Those issues change the aggregation's keying, which is a separate,
larger change. Cost if wrong: a store with guest-then-registered shoppers shows a customer count a
few rows high until those issues land.

**Ruling AUI-4 — feature-flag freshness uses `refresh()` after every admin write path plus
focus/visibility revalidation; the optional socket push (`store.feature_toggled`) is not built.**
Every write path in the admin (FeatureMatrix toggle, reset, plan change; Settings plan change) now
refreshes the store-wide context, and a merchant in another tab or device picks the change up on the
next focus. Cost if wrong: a merchant who keeps the admin tab focused while a super-admin toggles a
feature elsewhere sees it only after switching tabs, navigating a full reload, or refocusing.

**Ruling AUI-5 — the customers aggregation cache key moves to `customers-agg:v2:<storeId>`.** The
cached value gained `summary`; a v1 entry read after deploy would render an unknown KPI strip for up
to the 300s TTL. The version bump turns it into a clean miss. Cost if wrong: one extra aggregation
per store right after deploy.

## 2026-09-30 — Merchant MCP read tools + RFM segment drill-down (branch `feat/mcp-read-tools-rfm-drilldown`)

Source: `force-website-builder-audit-accounting-mcp-2026-09-30.md` §7 and
`force-website-builder-audit-analytics-2026-09-30.md` §4. Builds on the Customers-page segment
filter merged in PR 2218.

**Ruling MCP-R1 — the funnel follows owner ruling AUD-2: a stage the platform cannot capture for
guest shoppers is `null` with a reason, never 0.** `checkoutsStarted` and `ordersAbandoned` come from
`abandoned_carts`, which guest carts never produce. The AUD-2 text itself was not found in this repo
or the two audit documents; it is applied as the brief stated it. Cost if wrong: an agent that
expected a number gets `null` and must read `unavailable`, which the tool description tells it to.

**Ruling MCP-R2 — contact details are always masked on the MCP surface; there is no `includeContact`
opt-in.** The audit suggested an opt-in flag; every key today carries only `merchant:read`, so a
flag would unmask for every key and the masking would be decorative. Applied to the existing
`admin_get_order` / `admin_list_orders` as well — they previously returned full addresses and
emails, the same PII the customer tools mask. Cost if wrong: an agent drafting a courier hand-off
cannot read the street address or phone and the merchant copies it from the dashboard. Issue 2244
extends it to shopper free text: `admin_get_order` is an allowlist and its `notes`/`customerNotes`
pass through `redactFreeText` (phone-shaped 8+ digit runs — not ISO dates or order references — and emails replaced). Cost if wrong: a
note whose meaning IS a free-standing number of 8+ digits (a gift-card code typed into the note)
reads as `[phone]`, and the merchant reads it on the dashboard.

**Ruling MCP-R3 — no payouts/settlements tool, and no `admin_list_payments` in this batch.** No
settlement model exists. Exposing `payments` as "collections" is cheap to build but has no dashboard
surface to be a façade over, so it would be the one tool with its own query and its own definition
of a collection; it waits for a settlement import to give it a real shape. Cost if wrong: a merchant
asking "what did MyFatoorah pay me" gets "not available" rather than a per-order payments list.

**Ruling MCP-R4 — delivery `slot` is always `null`, `method` is the booked-shipment carrier or `null`,
and the zone is reported as the address's area/governorate.** Checkout captures no slot and no
delivery method, and the matched `ShippingZone` is not stored on the order; resolving it after the
fact would be a guess once zones are edited. Cost if wrong: an agent sees `method: null` on most
orders (0 shipments exist in prod per the audit) and must read `deliveryNote`.

**Ruling MCP-R5 — guest customers are referenced by `GUEST:<sha256(key)>`, never by their email or
phone; a contact-less guest row (`guest:<orderId>`) is listable but has no profile.** Resolved only
against the calling store's aggregation, so a foreign or invented ref is a tool error. Cost if
wrong: an agent holding a contact-less guest's ref gets a summary and must use `admin_get_order`.

**Ruling RFM-K1 — guest RFM snapshots are re-keyed from `GUEST:sha256("<email>:<phone>")` to
`rfmKeyFor(customerKeyOf(order))` (`lib/customer-key.ts`), the Customers-page grouping with the
contact hashed; no data migration is written.** The nightly `runRfmRollup` recomputes every
snapshot, and a new stale-row sweep at the end of each run deletes rows whose key no paid order
produces — which removes every old-format guest row on the first run after deploy. Until that run,
guest drill-downs match nothing (the old keys cannot be joined — that is the bug) and segment counts
on the Segments page are unchanged. `previousSegment` history for guests resets once. The cohort
rollup uses the same key, so a guest who reused an email with a new phone is one cohort member, not
two. Cost if wrong: for up to a day after deploy a guest-only store's drill-down lists are empty,
and one night's "segment movers" narration is blind to guest moves.

**Ruling RFM-K2 — the stale-row sweep does not run when a store has zero paid orders.** The early
return is unchanged, so a store whose every paid order was later refunded keeps its last snapshots.
Cost if wrong: such a store's Segments page shows customers who no longer qualify, until it has a
paid order again.

**Ruling RFM-K3 — issue 2051 is fixed here (superseding AUI-3 for 2051 only).** The zero-order union
now excludes by real user ids, skips a user whose email/phone already keys a guest row, and is
skipped entirely on a truncated scan. 2046 and 2049 remain open. Cost if wrong: a registered
shopper with no orders and a contact matching an unrelated guest row is hidden from the list.

**Ruling RFM-K4 — the customer detail route resolves a guest key the way the list groups it.** A
guest key now matches guest checkouts (no `customer_id`) whose LOWERCASED email is the key, or — for
an order with no email — whose phone is the key. The old exact-case JSON match 404'd any guest who
typed a capital letter, and pulled signed-in orders sharing the email into a guest profile. Cost if
wrong: a merchant who relied on a guest profile also showing that person's signed-in orders now
sees them only on the registered row.

**Ruling SQL-1 — `::uuid` casts against TEXT id columns removed in three raw queries, with a static
gate.** Every id/FK column here is TEXT, so `store_id = ${x}::uuid` is `text = uuid` and errors on
every call: the guest half of `GET /customers/search` and the barcode "order fully picked" check
were failing at runtime (reproduced on a migrated scratch Postgres; production not queried).
`tests/unit/raw-sql-no-uuid-cast-on-text-ids.test.ts` fails on the pattern. Cost if wrong: none
known — the casts could never have succeeded on this schema.

**Ruling MUT-1 — the `storeId` filter on the batched shipments read in `admin_list_orders` survives
mutation and is kept.** Its `orderId IN (...)` comes from an already store-scoped page and order ids
are globally unique, so removing `storeId` changes no observable result (an equivalent mutant). It
stays as defence in depth. Cost if wrong: none; it is one indexed predicate.

## 2026-10-01 — backlog batch e-web-orders (branch `fix/backlog-e-web-orders`)

Context: 49 `audit-followup` P2 findings on the storefront (`apps/web`) and the orders PWA
(`apps/orders`). Ruling ids are `EWO-<cluster><n>`.

### Cluster A — auth/session (orders, admin, storefront)

**Ruling EWO-A1 — issues 2096 / 2161 / 2165: the admin + orders session check reports five outcomes, and
only `signed-out` changes state.** _(Amended by Ruling YWA-2: an API-bodied 404 on `/auth/me` is `signed-out`.)_ `checkSession` now returns `unavailable` for a non-401, non-429
answer on `/auth/me` (5xx during a deploy, a mis-routed 404) and `throttled` for a 429 there (so the
mount ladder retries it); `checkAuth` leaves `user` untouched on both. A module-level session
generation, bumped by every `storeSession` (login/MFA) and every logout, is re-checked before each
destructive step, and a check whose generation moved — or whose caller says a newer check started —
returns `superseded` and applies nothing. The orders provider keeps re-checking on every navigation
(#1814) but tags each run; an older ladder stops at its next sleep and only the newest run clears
`isLoading`. The session-check block stays byte-identical between `apps/admin/src/lib/api.ts` and
`apps/orders/src/lib/api.ts` (Ruling P2-B2-5). Evidence: `tests/unit/orders-auth-session-races.test.ts`,
7 mutations × 2 clients all red. Cost if wrong: a staff user whose `/auth/me` keeps 5xx-ing on a cold
mount (user already null) still lands on /login, where the next check recovers them — the same as before.

**Ruling EWO-A2 — issue 2160: logout is authoritative through a pending-logout marker, not a UI
toast.** `performLogout` writes `pendingLogout` (the iOS refresh token to revoke, empty on the cookie
path) BEFORE `POST /auth/logout` and removes it only on a 2xx. While it exists, every session check
(admin and orders, a reload of /login included) re-sends the logout instead of reading `/auth/me`
and reports `signed-out`; only an explicit login lifts it. The finding's second suggestion — surface
the failure and retry in the UI — is not built: the marker already retries on every check and the
user is shown signed out, which is the true client state. Residual: until connectivity returns the
server-side refresh token stays live (it was never revoked), so a stolen copy remains usable for that
window exactly as before. Cost if wrong: a staff member on a device that never regains connectivity
to the API keeps an un-revoked session server-side with no on-screen warning.

**Ruling EWO-A10 — issues 2164 / 2157: the storefront spends ONE evidence-free `/auth/me` refresh per
tab.** #2157 (anonymous page loads posting `/auth/refresh` into the shared `<ip>-refresh-anon`
bucket) was already closed on main by `hasSessionEvidence()`; #2164 shows that gate locked out the
Safari-ITP cohort (localStorage evicted, refresh cookie alive) it exists for. `claimSessionProbe`
(`apps/web/src/lib/api.ts`) lets exactly one `GET /auth/me` per tab session (`sessionStorage`
`authProbe`) refresh without evidence; no sessionStorage → no probe. Anonymous cost goes from 0 to at
most 1 refresh per tab (vs 1 per page load before #2157's gate). Evidence:
`tests/unit/storefront-session-refresh-gates.test.ts` (5 loads → 1 refresh; iOS cohort recovers;
removing the probe reddens 2 tests). Cost if wrong: on a heavily shared CGNAT IP the anon bucket
absorbs one extra POST per new tab, which could still tip a borderline IP into 429 for its signed-in
customers.

**Ruling EWO-A11 — issues 2158 / 2098: the storefront gets the mount ladder; a transient `/auth/me`
answer is unknown, never signed out.** `getProfileWithMountRetries` (3 × 5s, same budget as
admin/orders) runs on mount with `isLoading` held true; RATE_LIMITED, TIMEOUT, NETWORK_ERROR,
INVALID_RESPONSE and server 5xx codes (`isTransientSessionAnswer`) are retried and, if they outlast
the ladder, leave `user` untouched — as does a later `refreshUser()` (the Ruling P2-B2-5 amendment's
"the next refreshUser() call gets another chance" was unreachable on mount; the AuthContext comment
now says what actually happens). Residual: under a sustained throttle every `isLoading`-gated
storefront surface (account pages, checkout's signed-in affordances) waits up to ~15s before
settling as a guest. Cost if wrong: a customer on a throttled IP sees a spinner for 15s and still
ends up a guest, exactly the pre-fix outcome but slower.

**Ruling EWO-A12 — issue 2148: the refresh route's 400 is read as SESSION_ENDED on the storefront.**
Client-only fix: `/auth/refresh`'s only 400 is the "no refresh token presented" branch, which now
clears dead session cookies, so it is the same fact as the 401 — the CSRF-403'd write is retried
once on the SAME request and stale localStorage evidence is dropped. No server discriminator code
was added (keeps the defence-mutation `refresh-no-token-clears-dead-cookies` find-string intact). A
genuinely cookieless 400 costs at most one extra retry of a request that already failed. Admin and
orders keep `!res.ok → null`: an admin session is never the guest-CSRF victim (platform origins).
Cost if wrong: if the route ever grows a second 400 (e.g. body validation), a storefront CSRF-403
would be retried once needlessly and local session evidence cleared, costing one mount refresh.

### Cluster C — order summaries + tax display

**Ruling EWO-C1 — issue 2210: inclusive VAT renders as a caption after Total on every post-purchase
order summary.** `orderTaxPlacement(order)` (`packages/shared/src/order-tax-display.ts`) reads the
frozen `Order.taxIncludedInPrice` (M3-8) and returns either a summed-row amount (exclusive, the
default and every existing order) or an "Incl. VAT" caption amount (inclusive). Wired into the
storefront order detail, the admin SummaryCard, the orders-PWA SummaryCard (a fourth surface the
issue did not name) and the invoice HTML. No payload change was needed: all three order-detail
reads (`OrderService.getById`, `InvoiceService.generateInvoice`) use `include`, which already
returns every scalar column. Display only — no amount, total, charge or persisted value changes.
Tests: `tests/unit/order-tax-display-post-purchase.test.ts` + both SummaryCard render tests;
breaking the helper's inclusive branch turns 6 tests red. Cost if wrong: an inclusive order's
summary omits the tax row it previously (wrongly) summed — nothing is live today (0 active
inclusive-VAT rates, M3-9).

**Ruling EWO-C2 — the order e-mails follow the same placement (closed in the same batch).**
`order-confirmation.ts` (order-created + payment-success e-mails, en + ar) now takes its tax row and
an "Incl. VAT / شامل ضريبة القيمة المضافة" caption after Total from `orderTaxPlacement`;
`OrderEmailData` carries `taxIncludedInPrice`, passed by `order-created.ts` and
`order-status-changed.ts` (both load the full order row via `include`). Pinned by
`tests/unit/order-confirmation-email-tax.test.ts` (2 red with the placement input dropped).
Exclusive-tax e-mails are byte-for-byte unchanged. Cost if wrong: none for existing orders — every
row has `taxIncludedInPrice=false` and 0 inclusive rates are active.

**Ruling EWO-C3 — issues 2207 and 2052 are closed as already fixed on main.** 2207: the orders-PWA
SummaryCard already splits `loyaltyDiscount` out of `otherDiscount`. 2052: the orders PWA takes
both the map and the payment-capture gate from `@force/shared` (`orderStatusOptions`), and
`ActionFooter` derives its transitions from that gate. Evidence is in the close comments.
Cost if wrong: none; both are reads of current code.

### Cluster D — checkout + cart

**Ruling EWO-D1 — #2067: the checkout submit gates on "is the delivery fee confirmed", not on "is
a reprice in flight". Amends M3-4.** `calculateShipping` never throws — a non-2xx and a network
error both resolve after `setShippingError(true)` — so `repriceAfterCouponRemoval`'s `finally`
reopened Place Order over the coupon's stale 0 fee. `calculateShipping` now resolves `true` only
when a quote landed, tracks `shippingQuotePending`, and drops superseded answers (a slower
response for a previous area can no longer overwrite the current fee). `isShippingSettled`
(`shippingError`, pending, repricing) gates both step-1 Continue buttons, the Pay button's busy
state, and `handleSubmit` itself — a failed quote sends the customer back to step 1, where the
delivery panel's Retry lives. No amount expression changed: the server prices shipping at order
creation; this only stops a submit on a fee the summary never confirmed. Still source-pinned
(P2-B2-2), each pin mutation-checked. Cost if wrong: a customer on a flapping shipping endpoint
cannot continue until a quote lands, instead of ordering on an unconfirmed fee.

**Ruling EWO-D2 — #2116/#2117: an unavailable (deleted-product) line is announced on /checkout and
enforced on /cart; closes R3-4's residual.** /cart's two checkout CTAs (theme `CartSummary` via the
existing `ctaDisabled`/`ctaBlockedMessage` props, which all five themes already honour, and the
default list) now gate on `belowMinimumOrder || hasUnavailableLines`. /checkout derives the notice
from the UNFILTERED cart lines: a banner with a link to /cart above the form, a `handleSubmit`
guard that shows the same copy instead of advancing, and — when every loose line is unavailable
and there are no bundles — a dedicated "Nothing in your cart can be ordered" state checked BEFORE
the generic "Your cart is empty" screen, which was false for that cart. The summary still excludes
the lines from its arithmetic (R3-4). Cost if wrong: a shopper who ignores both notices is stopped
client-side one step earlier than the server would have stopped them — the same outcome, sooner.

**Ruling EWO-D3 — #2053: the bundle stock note keeps its quantity-aware trigger; its copy now
names the case, and no client-side submit block is added.** The finding's premise — that the
server gate is only the boolean `isPurchasable` — is incomplete: `OrderService.create`'s atomic
per-component decrement (Ruling T5-c) refuses `INSUFFICIENT_INVENTORY` whenever stock is below the
requested quantity, so `available < quantity` IS the server's semantic, and the checkout already
maps that refusal to copy (`checkout-bundle-errors.ts`). What was wrong was the label: "Out of
stock" for a box with 2 of 5 left. It now reads "Only N available" (`available > 0`) or "Out of
stock" (`0`), en + ar, pinned by a jsdom render test over both layouts. The Pay button is NOT
disabled client-side because backorder eligibility (the feature flag + per-product
`allowBackorder`) is not in the cart payload, and the decrement accepts a backordered component —
blocking there would refuse orders the server takes. Cost if wrong: a shopper who ignores the note
submits and meets the server's INSUFFICIENT_INVENTORY copy one round-trip later.

**Ruling EWO-D4 — #2047/#2050: the delivery-window picker and submit read the same clock.**
`nowMinutes` is state refreshed every 30s and on `visibilitychange`; a picked window whose cutoff
passes is dropped with a specific "no longer available — pick another" message (both while the
page is open and at submit, which also writes its clock reading back so the picker renders the
lapse). `findStillBookableWindow` treats a today→tomorrow rollover as a lapse (ids are reused for
tomorrow, so an id match used to move a "today" booking to tomorrow silently) and a
tomorrow→today midnight crossing as the same slot. Cost if wrong: a customer idling across a
cutoff sees their slot cleared with an explanation and re-picks — never an order without the slot
they believe they booked.

### Cluster E — middleware, headers, static assets

**Ruling EWO-E1 — #2153: middleware strips every header it asserts before deriving them; the
two matcher-excluded routes that read them are an accepted residual.** `MIDDLEWARE_ASSERTED_HEADERS`
(`x-is-platform`, `x-store-slug`, `x-store-slug-source`, `x-store-domain`, `x-store-identifier`,
`x-preview-draft`, `x-original-host`) is deleted from the copied request headers first, so only the
Host / URL / cookie / preview params can set them. The class was wider than the issue named: a
spoofed `x-store-domain` on a platform URL made `/llms.txt` and `/feeds/products.json` answer as
another store under `public, s-maxage`. Pinned by the `#2153` block in
`tests/unit/web-middleware-characterization.test.ts` (3 cases red with the strip removed). Residual:
`/api/store-favicon` is outside the matcher and still reads a raw `x-store-domain` on a DIRECT hit
(its only intended caller is the middleware rewrite); the worst outcome is a 302 to another store's
public favicon for the requester, and the path has no extension Cloudflare caches by default. Cost if
wrong: a shared cache configured to cache `/api/*` would serve that redirect to other visitors of the
same host for up to an hour.

**Ruling EWO-E2 — #2091: `x-is-platform` is a tri-state; custom domains now assert `false`.**
`layout.tsx` reads it through `isPlatformFromHeader` (absent → `undefined`), and `handleCustomDomain`
sets `'false'` explicitly, so ABSENT means only "middleware did not run", which is when
StoreProvider's client-side `isPlatformHost()` fallback must run. SSR output is unchanged for both
host classes. This makes the 2026-09-25 "falls back when the header is absent" ruling true.
Cost if wrong: none for rendered HTML — both host classes seed the same value as before.

**Ruling EWO-E3 — `/manifest.webmanifest` runs through middleware again (found while sweeping
#2153 / #1731's matcher class).** Excluded since 2026-03-16 "so it is not treated as a store slug";
`extractStoreSlug` has skipped dotted segments since, and the exclusion meant `app/manifest.ts` never
saw `x-store-domain`: `curl https://pecannbee.com.kw/manifest.webmanifest` on 2026-10-01 returned
`{"name":"Force",…,"theme_color":"#ff6e00"}` — every custom-domain merchant's install prompt showed
the platform identity. Cost if wrong: the manifest now does one extra middleware pass per install
check; no rewrite applies to it (pinned by tests).

**Ruling EWO-E4 — #709 and #1980 stay open: both are findings on the tenant-routing canary work,
and the fix belongs in open PR #1979 (`feat/tenant-routing-canary`), not this batch.** #1980's code
(`STOREFRONT_TENANT_ROUTING_ROUTES`) does not exist on `main` @ 726f4231. #709's duplicate
pixels/JSON-LD in `tenant-store/[tenant]/[locale]/layout.tsx` is real on `main` but inert
(`STOREFRONT_TENANT_ROUTING` unset everywhere) and PR #1979 item 2 removes it. Fixing either here
would conflict with that branch. Cost if wrong: if #1979 is abandoned, #709 must be picked up before
anyone sets the flag — the docs/ENVIRONMENT.md entry already says "do not set it anywhere yet".

### Cluster F — agent discovery, llms.txt, SEO, i18n

**Ruling EWO-F1 — #2174: the `viaCookie → private` branches in llms.txt / acp.json / ucp are
KEPT as an unreachable second line of defence, with their comments rewritten; they are not
deleted.** middleware.ts's `URL_KEYED_PUBLIC_PATHS` guard (#1959) never reads the sticky cookie on
these four paths, and the middleware now also strips a client-supplied `x-store-slug-source`, so
`resolvedViaCookie()` is false for every real request. Deleting the branches would leave the
middleware's `x-store-slug-source` assertion with no reader. The comments now name the middleware
guard as load-bearing, and `tests/unit/agent-discovery-real-path.test.ts` drives `middleware()` and
feeds the route only what it forwarded (mutating the guard to `false` turns 6/7 red). Cost if wrong:
dead code that a reader could still mistake for the real control — mitigated by the comments and
the real-path test.

**Ruling EWO-F2 — #2224: a per-store llms.txt AUTO-BUILD answers 503 (`Retry-After: 60`,
`no-store`) when categories OR products could not be asked; `fetchProducts` now returns `null` for
"could not ask" (any page failing, including a later one).** A body that enumerates "0 categories"
/ "0 products" / a silently short list is a false statement to every crawler; a 503 is retried and
caches nothing. The stored-override branch has no enumerations of its own and keeps serving (short
`s-maxage=60` when categories were not fetched). The same collapse was fixed in
`/feeds/products.json` (every upstream failure used to answer a cacheable `404 Not found`; now
404 only on the API's own 404, else 503 no-store). acp.json/ucp enumerate nothing. Cost if wrong:
during an API blip an auto-built llms.txt is unavailable for ~60s rather than served degraded.

**Ruling EWO-F3 — #2127: the sitemap THROWS (route 5xx) when its source could not be asked —
store-list page 1, a thrown store-list fetch, a non-404 custom-domain host resolve, and a
custom-domain products page 1.** A 200 empty `<urlset/>` overwrote GSC's last-good state; the host
resolve failure used to fall through to the PLATFORM sitemap on a merchant's own domain. A
master-sitemap store whose own fan-out fails still degrades to static pages (logged, existing
behaviour, O2-1). Cost if wrong: a persistent API outage leaves GSC on a stale-but-valid sitemap
instead of an empty one — the intended trade.

**Ruling EWO-F4 — #2194/#2195: Arabic PWA identity ships as EXTRA manifest members (`name_ar`,
`short_name_ar`, `description_ar`) on the one API manifest, not as a `?lang=` variant.** One
`pwa:<storeId>`-tagged fetch then serves both locales, so `PWAService.updateSettings`' single tag
bust refreshes both and no cache-key contract changes; browsers ignore unknown manifest members.
`name_ar` falls back to `store.nameAr`; `description_ar` to `تسوق في <name>`. Under `ar` the
storefront never falls back to the English API description. Residual: the live custom-domain
manifest only reflects this once the middleware matcher change (a sibling fix in this batch that
stops excluding `manifest.webmanifest`) is deployed — until then custom domains serve the platform
manifest regardless. `apps/admin/src/app/manifest.ts` is admin chrome, English by design, and out
of scope. Cost if wrong: a consumer that reads the raw API manifest sees three non-standard keys.

**Ruling EWO-F5 — #2196: JSON-LD names follow the page locale on the PDP (both trees), the bundle
detail page and the Organization block; listing-page breadcrumbs/ItemLists are NOT changed in this
batch.** `localizedField` + `BREADCRUMB_LABELS` in `lib/structured-data.ts` are the shared helpers;
under `ar` a Product/Bundle `description` is the Arabic one or omitted (the metadata's own rule),
never English. The Home / PLP / Categories / About / Contact / FAQ / Bundles-index pages still emit
English breadcrumb labels and `name: p.name` in their ItemLists — those pages' own `<title>`s were
not localized by #1987, so there is no same-page contradiction to fix there yet. Cost if wrong: an
Arabic listing page's breadcrumb rich result reads "Home › Products" — follow-up is to thread the
same locale through those bodies with these helpers.

**Ruling EWO-F6 — #2193: in Arabic, a meaningful English axis name that the option-name map can
translate outranks value detection, mirroring the English branch.** `Size` + `185 Gram` now reads
"Size" / "الحجم" (was "Size" / "الوزن"). An English name the map cannot translate (e.g. "Pack
size") still falls to value detection in Arabic. Pinned as EN/AR pairs in
`tests/unit/option-localization.test.ts`. Cost if wrong: an OSOSS weight axis stored as "Size"
reads "الحجم" rather than "الوزن" on Arabic storefronts — the merchant's own word, translated, over
an inference.

**Note — #1958 closed as already fixed:** acp.json (`authentication.write: 'api_key'`
unconditionally) and ucp (`auth.write: 'api_key'` unconditionally) no longer branch on
`agent_checkout_open_writes`, and `tests/unit/well-known-agent-discovery.test.ts` asserts
non-disclosure with the hatch on — all three surfaces agree (fixed in #1942).

### Cluster G — product cards, error fallback, UI

**Ruling EWO-G1 — #1998 is left to the owner; the desktop badge tier is not changed.** On desktop
(`lg:`) the theme cards' CTA band and modern/elegant's heart are hidden at rest and slide in on
hover, so the reserved tiers float the chip ~96px up with nothing under it at rest. Scoping them to
`lg:bottom-3` would instead put the chip UNDER the band while hovered. Which of the two states wins
is a look decision on every store's desktop grid (Ahmad's #1994 call was "overlays stay put, the
chip moves"), not a defect with one right answer. Cost if wrong: desktop shoppers keep seeing the
sale chip lifted off the image corner at rest until the owner picks.

**Ruling EWO-G2 — amends O2-3 (#2223).** See the O2-3 amendment above: bare fallback only on a
platform host. Cost if wrong: a custom-domain transient shows the chrome, whose links are the
merchant's own — no off-store walk is possible there.

**Ruling EWO-G3 — #1996: lifted badge tiers are clamped to the image box; the compound short-box
case is an accepted residual.** `bottom-[min(6rem,calc(100%-2.25rem))]` (9rem when stacked; the
chip below a stacked one reserves 4.5rem) keeps every tall-box placement byte-identical and stops
a 16:9 / short square image from clipping the chip away. On a box shorter than the CTA band plus a
chip there is no pixel that is both inside the image and clear of the band, so the chip may sit
over the band there. Cost if wrong: on a 16:9 `sm` card on mobile the chip overlaps the Add-to-Cart
band instead of disappearing — visible, not lost.

**Ruling EWO-G4 — #2129: only `token:primary|secondary|accent|card|muted` get a paired foreground;
a raw hex keeps white.** The paired var is a contrast decision the platform already made
(`deriveBrandRoles`); for an arbitrary hex it would be a new design decision that flips live cards.
Cost if wrong: a merchant who picks a pale RAW hex still gets white text on it.

**Ruling EWO-G5 — #2130: the retry button re-enables after 8s (`RETRY_MAX_BUSY_MS`) and the next
click hard-reloads the current url.** A second soft refresh would queue behind the hung one; a
reload stays on the merchant's host, so SR-7 is untouched. Cost if wrong: a refresh that was merely
slow (>8s) gets superseded by a full reload — one extra page load.

**Ruling EWO-G6 — #2110's blank-string fallback is applied to product and category NAMES only, not
to page-builder section copy.** `pickLocalizedName` now covers every product/category name display
path: a product with a blank name is never intentional, and the API accepts `nameAr: ''`. The same
`xAr ?? x` idiom remains in merchant-authored section copy (`FormCard` ×5, `HeroBanner`,
`SectionHeading`, `BrandStoryBlock`, `useRtlText`, `BottomTabBar`, `MinimalChrome`,
`FloatingWidget`, `useOrderSummaryBase`, the footer copyright override). There, a blank Arabic field
can be a deliberate "show nothing in Arabic", and changing it would change what live Arabic
storefronts render. That is a look change, not a bug fix, under the batch's standing rule. Cost if
wrong: a merchant who cleared an Arabic section field by accident sees an empty heading in Arabic
instead of the English one until they fill it in.

## Backlog batch g-ci-scripts-other (2026-10-01)

**Ruling CI-PROBE-1 — the hourly guest-checkout probe stays on the repo's runner expression, not
`ubuntu-latest` (issue 2191).** Cloud Actions minutes are billing-blocked for this org
(`runner-health-check.yml` header: a hosted job fails in ~3s with 0 steps), so pinning the probe to
`ubuntu-latest` would turn it into an hourly red that alerts nobody. A run that never starts because
the self-hosted runner is offline is detected outside GitHub Actions by `ci-runner-guard.sh`
(launchd, every 30 min, Telegram). The retry half of 2191 is fixed: both probe copies are now one
script. Cost if wrong: if `ci-runner-guard.sh` itself stops, a dead runner silences this probe and
every other scheduled job until someone opens the Actions tab.

**Ruling ZAP-10044 — the global `10044 IGNORE` (Big Redirect) stays, with no deterministic gate behind
it (issue 2100).** It is accepted for one known redirect — the `store.force-ai.co` apex 307, whose body is
the public 404 markup Next.js serialises from the not-found boundary. What a redirect body contains is a
runtime property of Next's rendering, not something a unit test can read from config, and narrowing the
suppression needs URL scoping `rules.tsv` does not have. The 10063 half of the same issue IS gated
(`csp-directive-floor.test.ts` pins Permissions-Policy on all three configs). Cost if wrong: a future
redirect that serialises session or PII data into its body is not reported by the nightly scan until the
row's review-by date (2027-03-31) forces it to be re-examined.

**Ruling DEP-1 — next-intl 4.14.2 and its four new transitive packages stay (issue 1631); provenance
recorded here, not assumed.** The bump (#1629) added `@eloqnt/config`, `@eloqnt/format-json`,
`@eloqnt/format-po` (all 0.1.0, first published 2026-08-26) and `po-parser@2.2.0` to the production
tree. Checked 2026-10-01 (`npm view`): all four are published by the SAME sole maintainer as
next-intl itself (`amann <jan@amann.me>`); `po-parser` carries an SLSA provenance attestation and
links `github.com/amannn/po-parser`, the `@eloqnt/*` packages carry neither; none has an install
script (`hasInstallScript` absent in package-lock.json); all MIT. They are imported only by
next-intl's `extractor/` module (message extraction), which `apps/admin/next.config.js` does not
enable — `createNextIntlPlugin('./src/i18n/request.ts')` only — so they are shipped-but-unexecuted
by the admin build. Holding next-intl at 4.13.3 would re-open the advisories #1629 cleared.
Cost if wrong: a compromise of the next-intl author's npm account could ship through any of the
five packages; the `@eloqnt/*` three have no attestation to detect a registry-side substitution.

**Ruling I18N-G1 — the widened admin-i18n shapes ship as a RATCHET over 66 recorded strings, not as a
hard fail (issue 2182).** Widening the guard (text with digits/→/—, `title={'…'}`, capitalised ternary
literals, `header:`/`label:` props) surfaced 66 hardcoded English strings across 15 of the 81 covered
files. They are recorded in `tests/unit/admin-i18n-known-debt.json`; any NEW string in those shapes
fails, and the debt can only shrink. Translating them here would collide on
`apps/admin/src/i18n/messages/{en,ar}.json` with the parallel admin lane already fixing issues 2180,
2181 and 2183 (bank-reconciliation, purchase-order headers, stock adjustments/inventory — about half
the debt). The guard's docstring now states exactly which shapes are enforced and which are not
(template literals, text between two interpolations, lower-case ternary literals, files outside the
list). Cost if wrong: the 66 strings keep rendering in English on an Arabic admin until someone
translates them and deletes their debt entries.
RESOLVED 2026-10-01: the debt is cleared (`admin-i18n-known-debt.json` is `{}`) — see Ruling I18N-G2.

---

## 2026-10-01 — backlog batch c-api-lib (branch `fix/backlog-c-api-lib`)

Context: 53 `audit-followup` P2 issues filed against `apps/api/src/lib`,
`apps/api/src/middleware` and `apps/api/src/index.ts`.

**Ruling CL-1 — a CORS lookup failure serves the last resolved answer for up to
15 minutes (issue 2109, issue 2169).** The first failed custom-domain lookup no
longer poisons the hostname: the next request re-queries, and only the second
consecutive failure short-circuits to 503 for 5s. A domain resolved within
`CORS_STALE_SERVE_MAX_MS` keeps its last answer through the outage (stale-allow
or stale-reject). Cost if wrong: a domain the merchant DEACTIVATED (store status
change, not a domain edit) during an outage on another replica keeps passing
CORS on this replica for up to 15 minutes — bounded, and harmless on its own
because CSRF tokens and `restrictPlatformOnlyOrigins` are the real boundary; a
domain removal on this replica busts the entry and is never served stale.

**Ruling CL-2 — cross-store aggregates reached from inside a store scope run
under `withRlsBypass`, and are gated in the force_app suite (issue 2040,
issue 2043).** `assertAiQuota`'s daily/monthly counts protect ONE Google project
ceiling; the per-store slice stays ambient. The mirror of RLS-S1: the strict
list names readers that NEED a context, and `rls-force-app.test.ts` now carries
a "must NOT be scoped" block for readers that must not have one. Proven red on
the pre-fix code under a real non-BYPASSRLS login (a role that is a member of
`force_app`). Cost if wrong: none on isolation — the two counts only read
`count(*)`, never row contents.

**Ruling CL-3 — RLS helpers assert their precondition instead of documenting it
(issue 2123, issue 2041).** `withScopedRlsBypass` reads `app.bypass_rls` back
after its `SET LOCAL` and throws if it did not persist (a non-transactional
client), so the Ruling W-7 wallet/erasure statements can no longer "succeed"
with RLS still on. `readInStoreContext` reuses an ambient tenant transaction
only when `currentTenantGucs().storeId` matches the requested store; a
store-less (`userContext`) or other-store transaction gets a fresh short
`runInTenantContext` — correct for a read, which is all the helper does.
Both are registered defence mutations (unit tier) and the second is also
proven under a real non-BYPASSRLS login in `rls-force-app.test.ts`. Cost if
wrong: one extra short read transaction when a same-store caller arrives
without its GUC recorded — none found.

**Ruling CL-4 — the R2 orphan check keeps scanning every registered JSON/HTML
column; its cost is bounded rather than removed (issue 2249, issue 2250).**
Measured on Postgres 16 with 200k synthetic `abandoned_carts` rows (3 image
URLs each): the combined statement took ~475 ms for a key that is NOT
referenced (the common case — it is what triggers the delete); the exact-URL
half alone took ~20 ms. Changes: the exact half runs first and short-circuits
a still-referenced (cloned) image; the substring half runs under
`SET LOCAL statement_timeout = 5000` and a timeout KEEPS the object; the
deferred task declares `connections: 2` so the global deferred cap counts the
nested `withRlsBypass` connection (at most 2 concurrent checks per process at
the default pool of 15). NOT done: dropping `abandoned_carts` from the scan
(its snapshot images appear in recovery emails already sitting in inboxes, so
deleting them breaks sent mail — a product call, and the table is bounded by
the 30-day `abandoned-cart-purge`), and a `pg_trgm` expression index (write
amplification on every cart-step update, unjustified at today's volume). Cost
if wrong: an image delete costs ~0.5 s of one pooled connection per 200k
abandoned carts; past ~2M rows the 5 s timeout starts keeping orphaned files
(a storage leak the weekly sweep already reports), which is the signal to add
the trigram index.

**Ruling CL-5 — Prisma P2002/P2025/P2003 are captured by Sentry again; the
response mapping is unchanged (issue 2005).** `clientErrorStatus` still decides
the 4xx the client gets; the Sentry gate now uses the narrower
`isExpectedClientError` (ZodError, body-parser SyntaxError, AppError 4xx, or a
Prisma error the throw site passed through `markExpected`). This restores the
safety net Ruling SN-2 relies on: a FORCE-API-28 recurrence (P2003) reaches
Sentry instead of answering a silent 400, and a P2002 on a ledger row is no
longer an invisible 409. Cost if wrong: FORCE-API-2A-style events (a merchant
saving a duplicate SKU) come back as Sentry events — noise, not an outage; the
fix for any such site that turns out to be loud is `markExpected` at that
throw site, never widening the global gate again.

**Ruling CL-5a — merge with Ruling BS-5 (issue 1988, main).** Both batches
reopened Prisma errors to Sentry. The merged gate: P2002/P2003/P2025 with no
status of their own are captured at WARNING level; skipped are Zod/body-parser
errors, AppError 4xx, a Prisma error passed through `markExpected`, and — BS-5's
case — a P2002 whose unique target is a merchant-typed field (`sku`/`slug`).
Any other P2002 (a journal/ledger row, an idempotency key) is captured, which is
issue 2005's double-post case. Cost if wrong: a merchant-facing unique field not
named `sku`/`slug` produces warning-level Sentry noise until it is added to
`MERCHANT_TYPED_UNIQUE_FIELDS` or its throw site uses `markExpected`.

**Ruling CL-6 — the shared rate-limit budgets are measured and switchable, not
re-sized (issue 2216, issue 2230, issue 2171, issue 1963, issue 2228).**
Every limiter counts its 429s per prefix and logs a per-minute summary; a
prefix over `RATE_LIMIT_429_ALERT_PER_MIN` pages P1; a fall back to
per-process counting after a Redis-backed period is logged and alerted once;
`RATE_LIMIT_SHARED=0` restores per-process counting without a deploy of code;
and the Redis `isConnected` latch is re-armed on `ready` (an `error` only
clears it when the client is really not ready). The per-IP maxes were NOT
raised: the only replica evidence in the repo is `railway.json`, which sets no
`numReplicas` (Railway's default is one instance) and docs/SCALING.md, which
describes replicas as not yet enabled — if that holds, #1862 tightened nothing
and only made budgets survive a deploy. Amends Ruling S1-4: the live replica
count is still NOT verified against the Railway dashboard from this session;
the first post-deploy 429 summary lines settle it. The checkout limiters stay
IP-keyed: an IP+session key would let a caller mint a fresh bucket per
request by rotating `X-Session-ID`. Amends Ruling S1-8: a new address-wide
`authEmailAddressLimiter` (6/hour, no IP, no store component) sits in front of
`/forgot-password` and `/resend-verification`, so spraying public store ids no
longer multiplies the mails one inbox receives; the cost is that a flood can
now spend that ceiling for every store at once (the flooded mails still carry
working links). Cost if wrong: if production does run several replicas, CGNAT
shoppers may already be seeing 429s — now visible within a minute and
reversible with one variable.

**Ruling CL-7 — the Inngest global-limiter bypass is conditioned on the SDK
actually verifying, and the path gets its own failure-counted bucket (issue
2063, issue 2064).** Amends Ruling RL-1: its "costs nothing" held only in
cloud mode with a key; the bypass now also requires `NODE_ENV=production` and a
non-empty `INNGEST_SIGNING_KEY`, boot pages P1 when the key is missing, and the
SDK behaviour is pinned by driving the real `inngest/express` handler (a
dev-mode positive control answers 200 and runs the function, so the test has
teeth). `inngestLimiter` (300/15min/IP, `skipSuccessfulRequests`) sits before
the body parser. NOT changed: the 10 MB JSON limit on this path — Inngest's
step-state payload ceiling was not measured, and a too-small parser limit
would break real jobs; the failure-counted bucket bounds a forged-body flood
to 300 parses per IP per 15 minutes instead. Cost if wrong: a caller rotating
IPs can still force 300 × 10 MB parses per IP per window — the same exposure
every JSON route has under the global cap.

**Ruling CL-8 — a provider-PAID answer on an order that already left `pending`
is its own outcome with its own P1, not a skip (issue 2134, issue 2136,
issue 2137, issue 2143).** Only `INVALID_STATUS_TRANSITION` is terminal in the
auto-cancel reconcile; every other error, 4xx included, rethrows (a skipped
4xx would leave the order `pending` and re-skip it nightly). The stale confirm
is counted as `staleConfirmed`, pages `order.auto_cancel.captured_on_terminal_order`
naming order/payment/transaction ids, and writes a `reconciliation` payment
event so the order page shows it. NOT done: automatically refunding or
re-opening the order — whether captured money on a staff-cancelled order is
refunded or the order revived is a merchant decision (Ruling R2-5 already
defers the adjacent #1948 question). `payment-webhook-process` keeps its
4xx-class terminal rule: there a 4xx means the inbound bytes are bad, and it
already persists a `rejected` webhook row with a replay UI. Cost if wrong:
none silent — the worst case is a P1 per affected order per nightly run until
a human acts; the order is no longer `pending`, so it is reported once.

**Ruling CL-9 — the once-per-order refund notice claim is released per channel
(issue 2138, issue 2135); #1948 stays with the owner.** Amends Ruling R2-8: an
email-only failure now records `metadata.released: ['email']` on the single
`refund_notified` claim row instead of deleting it, so a replay sends the
email alone — not a second billed WhatsApp/SMS template and a second admin
push — and a later independent `order/refunded` for the order still finds the
claim. A claim row with no `released` list (every row written before this
change) means all channels were sent. Runs that started before the change
replay the claim step's memoized boolean, which is mapped to "all channels" /
"none". Issue 1948 (the notice is claimed at CANCEL, before money moves) is
NOT changed here: Ruling R2-5 already records it as an owner question about
what a customer is told at the cancel of a paid order. Cost if wrong: none new
— a replay after a release sends exactly the channel that failed.

**Ruling CL-10 — a stuck status fanout is re-sent only for the transition it
was about; a failed-after-claim fanout is reported, not re-sent (issue 2070,
issue 2071, issue 2133).** New additive columns `status_fanout_requested_status`
and `status_fanout_completed_at`. The sweep re-sends the requested status while
the order is still at it; a request a direct writer superseded is reported P1
and disarmed. The four direct `Order.status` writers were deliberately NOT
changed to clear the arming: that would hide the lost transition the sweep now
reports. A claimed fanout that never completes is reported once (Redis
sentinel) and NOT re-sent: re-running it would repeat the steps that did
succeed — customer emails and WhatsApp — the double-send #558 exists to stop.
Cost if wrong: the operator replays or hand-applies the missing effect for each
reported order; nothing is silently lost any more.

**Ruling CL-11 — the second tax resolver is deleted; multi-rate and the plan
gate stay with the owner (issue 2167, issue 2211; open: issue 2114, issue
2166).** `POST /stores/public/:storeId/tax/calculate` and
`TaxService.calculateTax` had no caller in any app and disagreed with the
charge on every axis (no `taxEnabled` gate, pre-discount base, no inclusive
extraction, summed/compound/country rates, `defaultTaxRate` fallback), so they
are removed and `order-tax-resolver-gating.test.ts` now sweeps all of
`apps/api/src` for another resolver. The admin "Default tax rate" help text
now says what is true — it is not applied at checkout — in EN and AR. Amends
Ruling M3-9's wording ("the same two gates TaxService.calculateTax applies"),
which was never true. NOT decided here: whether a store with several active
rates should be charged their sum (issue 2114 — changes the amount charged),
and whether the billing-plan `tax` feature may switch off statutory VAT
collection for a lapsed `free` store (issue 2166). Production has 0 `tax_rates`
rows and `taxEnabled: false` on all 3 live stores (M3-9), so neither is live
today. Cost if wrong: an integrator calling the removed endpoint gets a 404 —
none exists in the repo.

**Ruling CL-12 — a client disconnect rolls the request back (issue 1604);
#1603 stays closed by Ruling M2-3.** The `close`-before-`finish` branch now
rejects with `AbandonedRequest`, so a half-executed handler is never committed
and its deferred work is dropped. Both request-transaction tests that asserted
commit-on-abort as intended are inverted. Order creation is unaffected either
way (both order writers commit in their own `withMoneyTx`, M2-3). Cost if
wrong: a merchant who closes the tab while a slow admin save is still running
loses that save and has to redo it — instead of silently keeping part of it.

**Ruling CL-13 — campaign batch steps are wall-clock bounded; the per-store
concurrency stays (issue 2115).** Each `batch-i` step stops inside
`CAMPAIGN_BATCH_WALL_BUDGET_MS` (60s) and asks the pacer only for a slot it can
afford (`awaitCampaignSendSlot(maxWaitMs)` returns false instead of sleeping
past the budget), and leftover passes send what a step deferred. Amends Ruling
R3-1's cost-if-wrong: it named only the Redis-down replica case, not step
duration. NOT changed: `concurrency: { limit: 1, key: storeId }` — returning to
platform-wide one-at-a-time would undo #1955. Cost if wrong: a skipped pacer
slot is a one-interval gap in the platform cadence, never a burst, and a very
large campaign takes more (short) steps.

**Ruling CL-14 — disabling a stocked variant is recorded and its value shown,
but no journal entry is posted (issue 2146).** The flip writes a zero-quantity
`inventory_history` marker and the finance dashboard shows "held on disabled
variants" beside Stock Value (EN + AR, hidden when zero or unknown), so the
dashboard figure no longer drops with no trace. NOT done: an inventory
write-off/reclass journal entry. A disabled variant's units still physically
exist and can be re-enabled; posting and reversing ledger entries on a
visibility toggle is an accounting-policy call for the owner, and until it is
made the ledger's Inventory account and the computed stock value differ by
exactly the new "held on disabled variants" figure. Cost if wrong: the
merchant's balance-sheet Inventory and the dashboard's Stock Value disagree by
that visible amount.

**Ruling CL-15 — the guest RFM key / MCP `customerRef` is an HMAC under a
secret derived from `ENCRYPTION_KEY`, not a new env var (issue 2242).** A plain
sha256 of a guest's contact was reversible (8-digit mobile, masked forms leak
most of it), so the "contact details are masked" contract (MCP-R2) did not hold.
`rfmKeyFor` now uses HMAC-SHA256 keyed by `HMAC(ENCRYPTION_KEY, "fwb:customer-
rfm-key:v1")`. A derived key was chosen over a new `CUSTOMER_REF_SECRET` because
production already refuses to boot without `ENCRYPTION_KEY`, so there is no
deploy-ordering step and no silent unkeyed fallback. Re-keying repeats Ruling
RFM-K1's residual once: until the first nightly `runRfmRollup` after deploy
rewrites the snapshots (its stale-row sweep deletes the old keys), guest
segment drill-downs and MCP refs from before the deploy match nothing. Cost if
wrong: rotating `ENCRYPTION_KEY` re-keys every guest snapshot the same way
(one night of empty guest drill-downs) — a rotation already has to re-encrypt
every stored provider secret, so it is never silent.

## 2026-10-01 — backlog batch b-services (branch `fix/backlog-b-services`)

**Ruling BS-1 — issues 2247 / 2269: the all-time customer count keeps its full scan, but on its
own 900s cache key; no expression index or persisted `customer_key` column is added.** The count
has no UI consumer today (`allTimeCustomers` is read by the MCP `admin_get_analytics` payload and
the integration parity test only), and it was the one unbounded scan. It now runs at most once per
store per 15 minutes instead of once per distinct date range per 120s, and the default window's
cache key is quantised to the minute so a range-less caller finally hits the 120s cache. An
expression index cannot give an index-only scan for `COUNT(DISTINCT <expr>)`, and a persisted key
column would have to be maintained on every order write path (create, guest claim, address edit).
The windowed counts keep using `@@index([storeId, createdAt])`. Cost if wrong: on a store with tens
of thousands of orders one dashboard request per 15 minutes pays a full orders scan, and the MCP
all-time figure lags a new customer by up to 15 minutes.

**Ruling BS-2 — issue 1705: the currency sweep covers every order-money surface a customer or the
merchant's accountant receives (invoice, confirmation / payment / refund emails, the two admin
alert emails); the remaining `/1000 + toFixed(3)` sites are left KWD-only on purpose.** Those are:
the XLSX exports (`order.routes.ts`, `customers.routes.ts` — their headers say "(KWD)"), the bank
reconciliation narrations (the GL's base currency is KWD by design), the coupon / minimum-order
error strings, the loyalty ledger description, the abandoned-cart and payment-link WhatsApp copy,
`shipping.routes.ts`, `product-feed.ts` and `onesignal.service.ts`. KWD emails render
byte-identically (`emailMoney` keeps the old "X.XXX KWD" / "X.XXX د.ك" form for KWD). Cost if
wrong: a store selling in a non-KWD currency sees 3-decimal "/1000" figures in its spreadsheet
exports and a few merchant-facing messages until they get the same treatment.

**Ruling BS-3 — issue 2142 amends R2-8: the refund fanout's in-band gate still covers only a render
or enqueue failure; a delivery failure is surfaced by the queue itself.** `enqueue` resolves once
the email is on the Redis list, so no `{ queue: true }` caller can see a later Resend failure. The
queue now raises a P1 alert (`email.queue.permanent_failure`, no recipient address in it) when an
email exhausts its attempts or cannot be re-queued, and the dead-letter list `email:failed` is shown
and replayable at the super-admin page `/email-queue` (R2-8's "no UI" residual is closed). With
Redis down, the inline send now rejects to its caller, so the #1935 gate and Inngest step retries
see that failure. The `refund_notified` claim is NOT released on a delivery failure — replaying the
dead-lettered email from `/email-queue` is the recovery, and it cannot double-notify. Cost if wrong:
the customer is told late — after the P1 alert and an operator's replay.

**Ruling BS-4 — issues 1989 / 1991 amend SN-4: the one retry now matches the error Prisma really
throws, and it is suspended for 5s after a read whose retry also failed; there is still no
fail-fast sentinel.** P1001/P1002 arrive as `PrismaClientInitializationError`, whose code is on
`errorCode` (verified against `@prisma/client`'s own class: `code` is undefined), so
`extractRetryCodes` reads it — SN-4's retry had been matching only a hand-built test shape. During a
sustained outage each read still makes ONE attempt (recovery is seen at once — the concern that kept
O2-2 from adding a negative cache), it just stops paying for a second. Cost if wrong: in the 5s after
an outage, one isolated connection blip that a retry would have absorbed still 500s that request.

**Ruling BS-5 — issue 1988: Prisma P2003 / P2025 reach Sentry again, at warning level; P2002 and
input-validation errors stay suppressed.** SN-2's safety net ("a first add-to-cart 500 would reappear
and re-open the issue on its own") had silently stopped existing: FORCE-API-28's class is answered 400
since the 2026-09-02 mapping, and #1982 then kept every 4xx out of Sentry. Warning level keeps them
trackable (and able to reopen a resolved issue) without paging like a crash. P2002 is the merchant's
duplicate SKU, a genuine client error. Cost if wrong: a merchant repeatedly deleting an already-deleted
row adds warning-level P2025 noise to Sentry.

**Ruling BS-6 — issues 1960 / 2173: Meta CAPI posts form-encoded (`data` JSON string +
`access_token` field) and every Meta / TikTok failure raises a P1; the live endpoint was NOT
exercised from this branch.** Form-encoding is the transport Meta's CAPI documentation shows and the
one `meta-provisioner.service.ts` already uses against Graph successfully; a token inside a JSON body
is undocumented. No merchant pixel token is available to a batch agent (and prod is off-limits), so
the proof is the outcome measurement instead: a non-2xx, an `events_received` other than 1, or a
TikTok `code` other than 0 now alerts (`pixels-capi.meta` / `pixels-capi.tiktok`) on the first real
order. What would settle it before that: send one Purchase with a `test_event_code` from a pixel's
Events Manager → Test Events. Cost if wrong: if Graph also rejects the form shape, server-side
conversions stay broken until the first alert — now minutes, not months.

**Ruling BS-7 — issue 2147 reverses M5-6: a stock-computing query no longer pre-filters variants to
`isActive`.** M5-6 accepted the fallback because the parent column "is held at 0 by the invariant",
but `VariantService.createOption` converts a stocked simple product to variants without zeroing it,
so the PDP and the WhatsApp bridge advertised the old parent stock for a product whose variants were
all disabled. They now select every variant with `isActive` and drop the disabled ones for display
after the stock is computed; a unit gate fails on the pre-filtered shape in any stock-computing file.
The conversion path itself is NOT changed to zero the parent column — that is a stock write whose
correct target (discard the units, or move them onto a variant) is a merchant decision. Cost if
wrong: none on reads; the stale parent value stays on the row, unread.

**Ruling BS-8 — issues 2274 / 2276 / 2277 amend AP-5.** (a) 2276: the claim + `backorder_line_cancelled`
marker now run on the request's transaction when there is one (`hasTenantContext()`), so they commit
or roll back with the deferred `order/refunded` send; a rolled-back request leaves the line open
(integration-tested), which removes the need for a recovery sweep. (b) 2274: a zero allocation is
posted but never notifies, and the consumer reads a partial's `refundAmount` with `??`, so 0 can no
longer become the order total. (c) 2277 is NOT fixed: the "none was reserved" claim was false for
non-variant lines and is corrected in code and `inventory-model.md`; whether the cancel should heal
the negative backorder debt (restore all unfulfilled units, only the negative portion, or nothing)
is a stock semantics decision left to the owner on the issue. Cost if wrong: until decided, a
non-variant product whose backorder line is cancelled keeps a negative on-hand that reads out of
stock and disagrees with account 1200.

**Ruling BS-9 — issue 2215's class sweep: a best-effort DB write whose failure is swallowed is
savepointed wherever it can run inside a tenant transaction.** A heuristic scan of
`apps/api/src/{services,routes,middleware}` found 23 `try { await prisma.X.<write> } catch { log }`
sites; each was traced to its mounts. Savepointed (reachable inside a request or an explicit
`runInTenantContext`): `auditLog` (security.ts), `recordUsage` (ai.service), `recordPaymentEvent`,
the order-status `orderEvent`, `pages.remove` (now also swallows ONLY P2025), variant
`bulkUpdateInventory` (now sequential — savepoints on one connection cannot interleave), the
autofill category `createMany`, every analytics-rollup snapshot write, the citation-scan check
write, and the bulk-AI enqueue-failure mark. Left as they are, not reachable inside a tenant
transaction: account-lockout (`/auth`), abandoned-cart and SMS queue (process timers), expense OCR
(Inngest, no context), `payment.factory` `releaseClaim` (its own deliberate transaction),
wbs-integration (context-less router). Cost if wrong: a site the scan's pattern missed (a write
wrapped in a helper, or a `.catch(() => …)` chain) still poisons its request.

## 2026-10-01 — backlog batch a-money-services (branch `fix/backlog-a-money-services`)

**Ruling AMS-1 — revenue_drop needs 50.000 KWD of weekly revenue in either
window, and every anomaly baseline is the 3 weeks BEFORE the current one
(issues 2245 / 2268; extends AP-6).** revenue_drop was dead until the P&L fix
and was the only metric with no thin-data floor; its 28d/4 baseline also
contained the week it was compared against (so were margin_drop's and
refund_spike's). Pinned by `tests/integration/accounting/profit-anomaly-revenue-floor.test.ts`.
The stored column is still named `baseline28d`; it now holds the prior-21d
per-week figure, and the merchant-facing label (`finance.anomalies.baseline28d`,
key unchanged) now reads "Weekly baseline (prior 3 weeks)" in en/ar. Cost if wrong: a store whose weekly revenue is below
50.000 KWD in both windows gets no revenue alert even when it falls to zero.

**Ruling AMS-2 — no `@@unique` on `payments.transaction_id` / `invoice_id` in
this batch; ambiguity is refused in code instead (issue 769).** A unique index
would fail the deploy's `migrate deploy` if production already holds a
duplicate, and this lane may not read production. `handleWebhook` and
`PaymentService.refund` now read up to two rows and refuse more than one
(409 `AMBIGUOUS_PAYMENT`, logged with both payment ids) rather than binding an
arbitrary — possibly another tenant's — row. The constraint can ship after a
read-only check returns zero rows for
`SELECT transaction_id FROM payments WHERE transaction_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1`
(and the same for `invoice_id`). Cost if wrong: a genuine collision now stops
that payment's webhook/refund for a human instead of processing it. _Amended
(PR 2279 audit P1):_ on the webhook path that human is actually paged —
`handleWebhook` sends a P0 (`payment.webhook.ambiguous_payment`, provider +
transaction/invoice ids + every matching payment id in the context) before
refusing, and `isTerminalWebhookClientError` exempts `AMBIGUOUS_PAYMENT` from
the silent `rejected` lane, so the inbox row retries, lands `failed`, and
dead-letters into alerts-failure-watch's P0 like any other stuck money event.

**Ruling I18N-G2 — the admin-i18n known debt is cleared; three hits stay as
per-file allowlist entries, not translations (issues 2180, 2181, 2183, 2281).**
Every string in `tests/unit/admin-i18n-known-debt.json` is translated en + ar
except eight `[prop]` hits that are not admin chrome: the nav/footer PRESET
items in `components/NavMenuEditor.tsx` and `FooterLinksEditor.tsx` are
bilingual content data (each English `label` sits beside its `labelAr` and is
saved into the store theme for the storefront), and `app/layout.tsx`'s
"Force AI Store Admin" is the installed-app product name, which must equal
`app/manifest.ts` `name` — a manifest the browser fetches without the locale
cookie, so it cannot be localized. They live in `WIDENED_FILE_ALLOWLIST`
(scoped to their file, so a real `header: 'Products'` elsewhere still fails),
and a new check fails on any debt or allowlist entry whose string no longer
exists, so the ratchet cannot silently re-admit a translated string. Cost if
wrong: an Arabic-locale merchant installing the admin PWA sees the English
product name, and a preset nav/footer item added in English-only form would
not be caught by this guard.

## 2026-10-01 — owner money decisions (branch `fix/owner-money-decisions-1001`)

Owner (Ahmad) decided four open money questions on 2026-10-01: #2078, #1207 +
#1351, #1209 + #1455, #1956. M1-7, M1-8 and R2-3 are marked RESOLVED above; W-3
is amended. Every decision is pinned by
`tests/integration/accounting/owner-money-decisions.test.ts` (9 tests, amounts
that do not divide evenly) plus the producer unit tests; each change was
mutation-proved (the code broken, a named test turned red, the file restored
byte-identical).

**Ruling OMD-0 — #2078: a disabled variant that still holds units is excluded
from stock value, and disabling it posts no journal entry (owner decision).**
Every reader already applied the exclusion on main (M5-6, AP-10, AN-8); this
change makes the finance dashboard and the analytics snapshot ONE query
(`storeStockValueFils`) instead of two copies (merged with #2294's CL-14: the
dashboard also shows the disabled-variant value on its own line and the flip
writes a zero-quantity `inventory_history` row — still no journal entry), pins all four readers and the
no-ledger rule in one test, and states the consequence in inventory-model.md
and the merchant docs: the dashboard's stock value and balance-sheet Inventory
(1200) differ by the cost of the units on disabled variants. Not changed, and
NOT covered by the decision: the readers still disagree on WHICH products they
value — the finance dashboard and analytics snapshot value every non-deleted
product, including `track_inventory = false` and archived ones; the inventory
page values only `track_inventory = true`; the opening-balance entry excludes
archived and untracked products; dead stock values only active, tracked ones.
A store with an untracked product whose `inventory` column is non-zero sees two
different stock values. Which products carry value is a separate decision.
Cost if wrong: that store's finance dashboard and inventory page keep showing
different totals until it is decided.

**Ruling OMD-1 — a difference between the refund recorded on the return and the
allocation re-computed by the GL moves the sales-return debit, never cash or
tax.** The credit is the amount actually refunded; the tax share stays the
pro-rata share the sale booked for those lines, so the revenue line absorbs the
difference (warn-logged). On the code as it stands the two can differ only
when two returns' events are processed out of order (AP-5b(4)), by a fils or
so; no path lets a merchant type a partial refund amount. Cost if wrong: an
accountant who wants such differences in a separate fee/other-income account
reclasses them by hand.

**Ruling OMD-2 — refund methods and return shapes the decision does not cover
keep the previous treatment and are reported, not guessed.** (a) A partial
return completed as `bank_transfer`, `cash` or `manual` still credits the sale's
cash account at the pro-rata figure. `manual` ("Already refunded — record only")
follows an indeterminate gateway refund, so the gateway account is probably
right for it; `bank_transfer` and `cash` arguably belong in 1030 Bank Main or a
cash-on-hand account. (b) A FULL return is still reversed by mirroring the sale
entry (`postRefundJournal`), so a full return settled as store credit or into
the wallet still credits the sale's cash account, not 2150/2160 (#1207 asked for
the same treatment there). (c) A partial return on an order paid partly from
the wallet and partly by CASH ON DELIVERY has no gateway leg (COD has no
provider transaction), so "split to the payment mix" cannot apply; the merchant
picks store credit or bank transfer as before. Each needs the owner. Cost if
wrong: those refunds keep landing in the sale's cash account.

**Ruling OMD-3 — a refund outside a return books to 4090 Sales Returns, with no
tax line and no customer notification.** "A revenue refund" left the revenue
account open; 4090 is the seeded contra-revenue account and was otherwise
unused, so these refunds stay separable from item-level returns (which debit
4000). No tax line because nothing says which lines — and so which tax — the
money was for. `notify: false` because a refund made in the provider's
dashboard has never notified the customer. Cost if wrong: a reclass between two
revenue accounts (P&L total unchanged), or VAT over-declared by the refunded
amount's tax share on a store that charges tax.

**Ruling OMD-4 — the order page's partial refund sends its ledger event
immediately, not after the request commits.** PaymentService commits the refund
record on its own transaction before returning; deferring the event to the
request's commit (AP-2) would drop the ledger entry of a refund that stands
whenever the request then fails. The webhook path (no request) sends inline
before its idempotency write, so a failed send is retried; the refresh route
writes the payment row in the request, so its event rides the request commit.
A failed send on the order-page path raises the `partial_no_gl` P1 instead of
failing a refund that already happened; no sweep re-sends it. Cost if wrong:
that one refund's GL entry is booked by hand from the alert.

**Ruling OMD-5 — 2150 Customer Wallet Liability only ever grows.** It is
credited by partial returns into the wallet (store credit with the wallet on,
and the wallet share of a split gateway refund on an order whose sale was
journaled). Nothing debits it: wallet checkout is refused while accounting is
on (W-3), and admin credits/debits, whole-order wallet reversals and erasure
forfeits are not journaled. No live store has the wallet on (W-1), so the
account stays at 0 in production until one does. Cost if wrong: once a store
turns the wallet on, 2150 overstates what it owes by every credit spent,
adjusted or forfeited, until the W-3 follow-up models the rest.

**Ruling OMD-6 — #1956 ships at the money level; the GL books nothing for a
wallet-paid order.** W-3 still refuses to journal the sale of any order with
`walletAmount > 0`, so its partial returns find no sale entry and post nothing
(pinned). The poster's wallet leg (CR 2150 for the `return-wallet-share` rows)
is in place for when W-3 is lifted. Residuals: the wallet share is credited
after the provider refund, on the request transaction — if that credit fails,
the request 5xx's with the card refund already sent, the return stays
`received`, and "Already refunded — record only" then records it WITHOUT the
wallet share, which the merchant must add from the Wallet page. When a split
leaves the gateway nothing to send (an order paid entirely from the wallet, or
a rounding fils) no provider call is made. Cost if wrong: that customer's wallet
share is added by hand.

**Ruling OMD-7 — merchant-created accounts can collide with the new system
codes.** `getSystemAccountIdByCode` finds an account by code without checking
`isSystem`, so a store where a merchant already created a custom 2150 or 2160
(one level under a system parent) would have these refunds posted to that
account. Pre-existing shape of the healer (it applied to 1020 too); not
measured — production was not queried from this session. What would settle it:
`SELECT store_id, code, is_system FROM accounts WHERE code IN ('2150','2160')`.
Cost if wrong: that store's refund credits land in its own custom account
instead of the liability.

**Ruling OMD-8 — merged over #2279 (`fix/backlog-a-money-services`, merged to
main during this branch): its `alertUnbookedRefund` helper is kept, and two of
its three `partial_no_gl` call sites are removed because those refunds are now
booked.** The webhook and refresh-route sites book instead; the order-page site
keeps `alertUnbookedRefund({ kind: 'partial_no_gl' })` only for an event that
could not be queued. #2279's `held_unaccounted` and `held_provenance_unknown`
alerts are unchanged. Its new partial-return stuck sweep never arms an
amount-only event (`restoreInventory: false`, and no Return row has a
`refund:<id>` key), so a refund outside a return has no sweep behind it (OMD-4).
Cost if wrong: none known beyond OMD-4's.

## 2026-10-01 — owner decisions #2277 + #1370 (branch `fix/owner-decisions-2277-1370`)

**Ruling AP-5c — cancelling a backorder line heals its stock debt up to 0, never above (owner
decision, Ahmad 2026-10-01, #2277).** Settles the question BS-8(c) left open. AP-5 left `restoreInventory: false` on the grounds that no stock
was reserved for a backordered unit. That is true for variant lines only: checkout FORCE-decrements a
NON-variant product unfloored, so the shortfall sits on `products.inventory` as a negative debt that no
cancel ever cleared — the product read out of stock and stayed on reorder reports for units that will
never ship, while the GL adjustment debited Inventory 1200 for them. Of the three options put to the
owner (restore all the units / restore only the negative part / leave it), the decision was the middle
one. `cancelBackorder` now restores `min(qty − qtyFulfilled, −inventory)` inside the same `withMoneyTx`
and under the same `cancelledAt: null` claim, so it happens exactly once per line; writes a
`return_stock` InventoryHistory row (`reference` = `backorder:<lineId>`, NOT the orderId, which the
whole-order restore reads as "already restored"; `createdBy` = the cancelling user); records the healed
units as `stockRestored` on the existing `backorder_line_cancelled` marker; and busts the storefront
product caches after the write. A product that is not negative, or does not track inventory, gets
nothing — a line that left no debt cannot add phantom units. The whole-order inventory restore
(`order-refunded` `restore-inventory`) subtracts `stockRestored` per item, or a later full cancel would
put the healed units back a second time (measured: 2 on hand, 5 backordered → −3 → line cancel → 0 →
full cancel → 2, not 5). **Variant path checked: no heal.** Checkout floors variant rows at 0
(`forceDecrementVariantInventory`), so a variant backorder never drives stock negative and has no debt
of its own to heal; the heal returns 0 for a variant line rather than touch a row checkout never pushed
below zero. Proven in `tests/integration/accounting/backorder-cancel-stock-heal.test.ts` (8 tests,
through the real checkout); 5 mutations (no heal, unbounded heal, no track-inventory guard, no
whole-order subtraction, no cache bust) each turned a test red. Cost if wrong: the units that were
really on hand when the line was backordered (2 in the example) are not returned to stock by the line
cancel — the owner chose that over ever inflating stock; a stock count corrects it.

**Ruling AP-5d — the other two backorder stock paths, fixed in the same PR (issue 2299, coordinator
direction 2026-10-01).** (1) PO receive FIFO-clears a backorder line without adding the received units
to on-hand (they go to the customer), so a NON-variant debt from a FULFILLED backorder never healed. It
now heals `min(fulfilled units, −inventory)` per cleared line with the AP-5c rule and helper
(`healBackorderStockDebt`, `accounting/backorder-stock-heal.ts`; `return_stock` row referenced
`po-backorder:<lineId>`); the rest of the receipt goes on the shelf as before. No marker is written for
a PO heal and the whole-order restore does not subtract it: after a PO fulfils the line, a cancel's
restore is units coming back from the customer, which are real. (2) A whole-order cancel of a VARIANT
backorder restored the full line quantity onto a row checkout only floored to 0 (2 on hand, 5 ordered
→ 0 → cancel → 5). New nullable column `backorder_lines.stock_taken` (migration
`20261001120000_backorder_line_stock_taken`) records what checkout actually took — full qty for a
non-variant line, `min(qty, on-hand)` for a variant — and the restore subtracts `qty − stock_taken`
per line. `forceDecrementVariantInventory` now reads the real previous stock under the row lock (it
reconstructed it as `newStock + qty`), so the variant sale's ledger row reads 2 → 0, not 5 → 0 (its
`quantity` stays the units sold, −5). NULL `stock_taken` (pre-migration lines) means "fully taken",
the old behaviour, so no existing row changes meaning. Proven in
`tests/integration/accounting/backorder-cancel-stock-heal.test.ts` (4 more tests, 12 total); 5
mutations (no PO heal, no never-taken subtraction, `stock_taken` not recorded, reconstructed previous
stock, unbounded heal in the shared helper) each turned a test red. Cost if wrong: with the heal-to-0
rule a PO-fulfilled non-variant backorder, like a cancelled one, does not return the units that were
really on hand when it was backordered — stock can read low by up to that amount, never high; and a
pre-migration variant backorder cancelled whole still over-restores, as before.

**Ruling M-OVR-1 — admin/manual orders ENFORCE a coupon's rules by default; a store admin may override
them, recorded (owner decision, Ahmad 2026-09-25, #1370).** `createAdminOrder` used to check only the
coupon's dates, store-wide limit and minimum, never its targeting, and discounted the WHOLE subtotal —
so a scoped, customer-group or first-order coupon applied to anything typed into the phone-order form.
It now runs the checkout rules: dates, store-wide usage limit, minimum order, customer group, first
order, minimum quantity, product/category scope (`CouponService.adminOrderCouponViolations`, the
customer context from `resolveCustomerContext`), the per-customer limit inside the order transaction,
and a scoped coupon discounts only its in-scope lines. A broken rule is a 400 with the checkout's error
code. The override (`overrideCouponRules: true` + `couponOverrideReason`, 3–500 chars, Zod-validated at
the route) is honoured only for `store_admin`/`super_admin` — the role comes from the verified token and
the service answers staff with 403 `COUPON_OVERRIDE_FORBIDDEN`. It bypasses every eligibility rule but
never the merchant's own on/off switch (an inactive coupon stays a 404). Under override a scoped coupon
still discounts only its in-scope lines when the order has any; when it has none, it applies to the
whole order — that is the scope rule being overridden. The override is written as a `coupon_override`
orderEvent IN the order transaction (actor, role, reason, the rules actually broken, the discount) and
as an `order.coupon_override` audit-log row the merchant sees on the order timeline (hidden from the
customer's view of it). Admin orders now also RESERVE the redemption (`usageCount` +1, atomically, with
the `< usageLimit` guard unless overridden): they never counted, yet cancelling one ran the fanout's
reverse-coupon step and decremented the count — handing another customer's redemption back. Proven in
`tests/integration/admin-order-coupon-rules.test.ts` (10 tests) and
`tests/unit/admin-order-coupon-override-route.test.ts` (8); 8 mutations each turned a test red. Those
were one-off manual runs; the three that matter most are now committed defences re-run on every
relevant PR by `npm run test:defence-mutations` (issues 2304/2317): `money-admin-coupon-rules-enforced`
(the enforcement throw), `money-admin-coupon-override-role-gate` (the 403 for non-admin roles) and
`money-admin-coupon-atomic-reservation` (the `usageCount < usageLimit` reservation guard, proven by a
test that stubs the pre-check to simulate the losing side of a last-use race). One
mutation survived by design: dropping `isActive` from the coupon lookup leaves the reservation's own
`isActive: true` guard to refuse an inactive coupon (404), so the belt holds without the braces. Cost if
wrong: a store admin can still give any coupon to any order — but never silently, and never as staff.

## Backlog batch d-routes-mcp (2026-10-01)

**Ruling DRM-1 — the AI product feed keeps its 600s cache and 24h edge SWR across a bundle's
sale-window boundary; the two storefront bundle routes do not (issue 2111).** The public bundle
list and detail routes now cache the window-independent state (`sellableIgnoringWindow` + the
window) and apply `withinSaleWindow` on every request, so an expiry or a start takes effect on the
next request with no invalidation. The feed (`public:products:<id>:feed:v1`) is an advertising
artifact served from the Cloudflare edge with `s-maxage=600, stale-while-revalidate=86400`: an
origin-side window check cannot reach the edge copy, and the edge window dominates any Redis TTL
change. Every selling path (cart add, order-create) re-resolves the bundle live and refuses an
expired one. The WhatsApp catalogue calls `listPurchasableBundles` uncached, so it is exact.
Cost if wrong: an AI shopping agent can recommend a promotional bundle for up to ~10 minutes (edge
SWR aside) after it expired, and the shopper is refused at add-to-cart.

**Ruling DRM-2 — receipt uploads keep the shared 2000px ceiling (issue 1049, declined with a
measurement).** The finding was reasoning-only ("may degrade OCR"), so it was measured on
2026-10-01: a synthetic 3024x4032 phone-style receipt photo (receipt ~36% of the frame width, 22
line items with 3-decimal KWD amounts in ~22px type, then blurred σ1.6, rotated 3°, JPEG q70) and
its `fit: inside` 2000px downscale were each sent 3 times through the exact production OCR prompt
and model (`gemini-flash-lite-latest`, JSON mode). All 6 runs returned the exact total (154.875)
and 22/22 exact line totals. A separate higher OCR ceiling would store ~2.5x the bytes for no
measured gain. Cost if wrong: a real receipt with smaller or fainter print than the fixture (a
long thermal till roll photographed whole) reads worse at 2000px, which would show as more
null/incorrect `total` values in expense drafts — re-measure with such a photo before raising the
ceiling.

**Ruling DRM-3 — `admin_get_order` keeps `transactionId`/`invoiceId`, drops `paymentUrl`
(PR 2301 audit).** An unpaid order's `paymentUrl` is a live hosted-checkout link, a bearer capability
that has no place in a third-party LLM transcript. It is removed from the allowlist, and the
integration test asserts that no payment carries it. The gateway transaction and invoice ids are
kept: they are what a merchant quotes to the gateway's support to reconcile an order, and they
authorise nothing on their own. Cost if wrong: a gateway that accepts a bare invoice id as a lookup
key would let a transcript reader see that invoice's status at the gateway.

**Ruling DRM-4 — a change to a cached payload's SHAPE bumps its cache key in the same commit (PR 2301
audit).** The public bundle list (`public:bundles:v2:`), the bundle detail
(`public:products:<id>:bundles:v2:<slug>`, still under the product prefix every invalidator
clears) and the customers aggregation (`customers-agg:v3:`) all changed shape in this batch, and an
old-shape entry read by the new reader would blank the bundles page or drop the export's
truncation notices until the TTL ran out. `withinSaleWindow` also treats an absent bound as
unbounded (`== null`). The Next data cache and the CF edge hold API RESPONSES, whose shape is
unchanged, so they need no bump. Cost if wrong: one cache miss per store at deploy.

## 2026-10-01 — backlog batch z-ci-other (branch `fix/backlog-z-ci-other`)

**Ruling MIG-ORD-1 — a new migration folder must sort strictly after main's newest, and no two
folders may share a 14-digit timestamp; enforced in CI, with the two existing production collisions
grandfathered by exact folder set.** Prisma orders migrations by folder name and production has
already applied main's newest, so a back-dated or same-stamp folder runs in a different order on a
fresh database (CI, restore, new branch) than it did in production. The live case: open PR #2311
adds `20261001120000_payment_config_key_fingerprint` while main has
`20261001120000_backorder_line_stock_taken` — `scripts/check-migration-order.mjs` reports it (exit 1)
when run in that PR's worktree. The gate runs as the first step of CI's required `Lint` job (no
`needs`, runs on every PR) against a freshly fetched `origin/main`, and fails closed (exit 2) when it
cannot read main. `20260615000000_*` (5 folders) and `20260925160000_*` (2) are already applied in
production and cannot be renamed — the folder name is the key in `_prisma_migrations` — so they are
allow-listed by exact set; a new folder joining either timestamp still fails, and a unit test fails
if the list and the on-disk collisions ever disagree. **The fetch never goes shallow outside GitHub Actions (2026-09-30, twice).** The first version of the
CI step ran a bare `git fetch --depth=1 origin +refs/heads/main:...`. Run by hand or by an agent in
the shared developer repo — all worktrees share one `.git` — it wrote `.git/shallow` at origin/main's
current tip (no reflog entry, because the ref did not move), and every worktree's merge then failed
with "unrelated histories" (17:30 at 0e59048b, 19:10 at 925b9f76). The fetch now lives inside the
script (`--fetch`); `fetchArgs` adds `--depth=1` only when `CI=true` and `GITHUB_ACTIONS=true`, and
`migration-order-gate.test.ts` proves a local run leaves a full clone full (with a positive control
that the Actions env does go shallow) and forbids a bare shallow `git fetch` in any workflow, script
or hook. Residual: a PR that passed and then sat while
main gained a newer migration is only re-checked on its next push or re-run. Cost if wrong: one PR a
month renames a folder it did not need to.

**Ruling ZAP-F-1 — "no scan ran" is detected OUTSIDE the scan's run; the in-run `cancelled()`
branch stays but is no longer described as covering a queued cancel (issue 2289).**
`notify-failure` inside `zap-baseline.yml` only runs if it is dispatched and gets a runner. The
run history shows it IS evaluated after a zap-job timeout (runs 35967069299, 35829519117: notify
`skipped` under the old `failure()`-only condition, not dropped), but nothing in the run can report
a run cancelled before dispatch or a runner that never comes. `zap-freshness-check.yml` asks the
Actions API once a day whether any `zap-baseline` run on `main` concluded `success`/`failure` in
26h and alerts on Telegram when none did; it exits 2 (fails) when the API is unreadable and 0 when
`ZAP_TARGET` is unset (the scan is dormant by design). Verified live against the API on
2026-10-01 (fresh: run 36685419137 concluded failure). Its own concurrency group is keyed on the event (a dispatch cannot cancel the cron), and
its alert fires on `cancelled()` too, worded as UNKNOWN — as it is when the API is unreadable
(exit 2 → `state=unknown`), so a token failure never pages as "no scan ran" (PR 2333 audit). Residual: it rides the same self-hosted
runner (cloud minutes are billing-blocked), so a DOWN runner silences both — that is
`ci-runner-guard.sh` on the Mac. `railway-deploy.yml`'s `failure()`-only `notify-failure` is left as
is: a cancelled or never-run deploy there is already caught out-of-run by
`railway-deploy-drift-check.yml` (stalled-pipeline alert after 90 min). The claim that the in-run
branch fires for a concurrency-cancelled QUEUED run was not exercised (it would mean cancelling a
real nightly scan); the out-of-run check makes the answer not matter. Cost if wrong: one extra
Telegram message on a night the scan really did run late.

**Ruling R2-VIS-1 — the RLS-visibility guard is required before any BULK R2 delete and any orphan
REPORT, not before the per-URL `deleteR2ObjectIfOrphan` check (issue 2288).**
`assertStrictTablesVisible` moved to `apps/api/src/lib/r2-references.ts`; it now ANALYZEs a STRICT
table that reads 0 rows before trusting the catalog, treats `reltuples = -1` (never analyzed — a
fresh branch/restore, or a small table below autovacuum's threshold) as UNKNOWN and refuses, and
also counts `n_live_tup`. Measured on Postgres 16: a new table with 3 rows reads `reltuples -1,
n_live_tup 0` — the old `GREATEST(reltuples, 0)` passed it — and `3` after `ANALYZE`. Both bulk
collectors run it: `scripts/r2-orphan-audit.ts` before the report is printed (dry run too), and the
`r2-orphan-sweep` Inngest cron, which refuses to delete and marks its Telegram report "NOT
TRUSTWORTHY" (P1) on failure. The per-URL check in `r2-cleanup.service.ts` runs one indexed probe
per deleted file under `withRlsBypass` (pinned by defence `r2-cleanup-isstillreferenced-rls-bypass`);
adding four `count(*)` + possible `ANALYZE`s to every single-file delete is disproportionate, and a
wrong bypass there is already a mutation-gated defect. Not verified: the guard end-to-end under a
role actually subject to RLS (the scratch DB connects as a superuser). Cost if wrong: one
still-referenced file deleted by a per-URL cleanup if the bypass itself is ever broken.

**Issue ownership after #2309 merged mid-batch.** Issue 2010 (masked payment key is a ciphertext
fragment) is fixed by open PR #2311 (`Fixes #2010`), which must first rename its
`20261001120000_payment_config_key_fingerprint` migration under MIG-ORD-1. Issue 2281 was closed
by #2309 (its own ruling I18N-G2 keeps the PWA name unlocalized), so this batch's overlapping i18n
commit was dropped on rebase. Issue 2312 became fixable on main once #2309 landed. This batch fixed it, and batch y-web-admin
(#2334) fixed the same class in parallel (issues 2313/2322/2323, Ruling YWA-1) with a per-theme
resolver that also bans the malformed `/30/30` and off-scale `/8` spellings. On merging main, #2334's
gate and `design.md` wording were kept and this batch's detector was dropped — one gate, not two; the
pill sweeps agree (every dark half on `-ink`).

**Ruling CI-SPARSE-1 — no workflow uses sparse-checkout, and every self-hosted checkout job
disables an inherited sparse config before it checks out (production deploy failure,
2026-09-30).** The orders PWA deploy failed twice on `fwb-ci6-force-website-builder-2` with
`npm ci: no package-lock.json`: `railway-deploy.yml`'s hourly `guest-checkout-probe` checked out
sparse, the persistent self-hosted workspace kept `core.sparseCheckout` in `.git/config`, and the
next job's plain `actions/checkout` reused it — a tree of only `.git` + `scripts/`. Fixed in two
layers: (1) the probe and the new `zap-freshness-check.yml` (which had copied the same pattern
earlier in this batch) now do a full shallow checkout; (2) the shared pre-checkout guard step,
already required before checkout in every self-hosted job by `ci-trufflehog-scratch-guard.test.ts`,
now runs `git sparse-checkout disable` and clears the sparse config when a prior job left one — all
35 copies across 16 workflows. `tests/unit/ci-no-sparse-checkout-leak.test.ts` forbids
`sparse-checkout` in any checkout step, requires the reset in every guard, and runs the guard's own
script against a real repo that reproduces the leak (package-lock.json absent → present).
Mutation-proved: removing the reset reddens 3 tests; re-adding sparse to the probe reddens 1. The same PR's audit caught the class next door: the migration gate ran `node` BEFORE
`setup-node` in the Lint job (exit 127 on the self-hosted runner). `workflow-node-available.test.ts`
now asserts ORDER, not just presence, in every job of every workflow (mutation-proved against the
audited commit). Other
persistent-workspace state found by the sweep: `ai-review.yml` writes a local `git config
user.name/user.email` into the workspace — left as is, since no other job commits from that
workspace and `actions/checkout` does not read identity. Cost if wrong: one extra full-tree write
per job on a workspace that was actually sparse on purpose (none are).

## 2026-09-30 — single-variant products (branch `fix/single-variant-products`)

Context: owner report (pecannbee) — a product whose ONLY variant is e.g. "Size: 380 Gram" shows a
one-option picker and a disabled "اختر الخيارات" button until the shopper taps it. Part A is a
one-off data script (`scripts/flatten-single-variant-products-2026-09-30.ts`, NOT applied — the
owner reviews the dry run); Part B is the PDP auto-select.

**Ruling SVF-1 — flattening DELETES the variant row; it does not disable it.** Every stock reader
keys "variant product" on the existence of ANY variant row, disabled ones included
(`effectiveInventory`, `ON_HAND_SQL`, `STOCK_VALUE_SQL`, #2147): a product whose only variant is
disabled has stock 0 and cannot be ordered. Soft-disabling would therefore make these products
unsellable. Deleting is what the platform's own "delete option" action already does
(`VariantService.deleteOption`). Cost if wrong: order lines lose the FK link to a variant row that no
longer exists; their snapshot (`variant_name`, `sku`, `price`, `cost_price`) is untouched.

**Ruling SVF-2 — order lines are unlinked only with `--unlink-order-lines`; without it the product
is blocked.** The brief said "do not hard-delete a variant an order references"; SVF-1 makes that
incompatible with flattening, so the default honours the brief and lists the product (29 of 58 on
pecannbee, 2026-09-30). With the flag, `order_items.variant_id` is set to NULL (what the FK's
`ON DELETE SET NULL` does anyway) and every id is kept in the backup for `--restore`. NULL is also
what the stock writers need afterwards: a cancel/return of that order restores onto
`products.inventory`, the row that now holds the stock. Cost if wrong: a report joining order lines
to variants shows those historical lines without a variant row.

**Ruling SVF-3 — the PDP pre-selects a single variant only when its pill is tappable, and the
pre-selection never swaps the gallery.** Owner instruction 2026-09-30: nothing may look different
except the selected pill and the enabled button. Rule = exactly one variant listed, every picker
axis has a value, and the same availability test the pill uses for `disabled` (untracked or
inventory > 0) — so the pre-selected state is byte-for-byte what a tap produces. 14 live
single-variant products have a variant image that is NOT in the product gallery; a tap swaps the
main image to it, so the swap is tied to `onShopperSelect` (a real tap), not to the pre-selection.
Proved by before/after screenshots (en/ar × desktop/mobile, two products): page heights identical,
the only pixels that change are the option row and the button. Cost if wrong: a sold-out single
variant still shows "Select Options"/disabled, exactly as today.

**Ruling SVF-4 — product cards, the carousel quick-add and "Frequently Bought Together" are NOT
changed.** A variant product's card CTA is the "View"/"عرض" button and quick-add is hidden for it;
turning either into Add to Cart changes the card's copy and layout, which the owner's no-visual-change
instruction forbids. FBT's recommendation payload carries only `{id, price}` per variant (no
`isActive`, no stock), so it cannot apply SVF-3's tappable rule without an API change. After the
Part A flatten these products are simple products and every card path adds them directly. Cost if
wrong: until Part A is applied, a single-variant product still needs a PDP visit to be added.

## Backlog batch y-web-admin (2026-10-01)

**Ruling YWA-1: the tinted-pill gate measures resolved pairs per theme. Bare role text on a plain
surface and `hover:` tints stay outside it (issues 2313 / 2322 / 2323, follow-up issue 2332).**
`tests/unit/admin-tint-ink-contrast.test.ts` now works out, for each class string, which tint
alpha (up to 40%) and which text class apply in light and in `dark:`. It then measures that pair
from globals.css. It also bans two spellings that the check could not see or that Tailwind 3
silently drops: arbitrary-value role colours (`bg-[hsl(var(--success))]/10`) and off-scale or
double opacity modifiers (`/30/30`, `/8`). The compiled probe emitted no rule for either
`bg-destructive/30/30` or `bg-primary/8`. As a result, the sidebar's active item
(`bg-primary/8 text-primary`) had no tint at all, and it now renders `bg-primary/10
text-primary-ink`. The gate does not measure two shapes:

- `text-<role>` on a plain surface: 243 uses, measured on white at success 3.05, warning 1.80,
  info 3.81 and destructive 4.38 to 1.
- `hover:bg-<role>/N` under bare text: 66 strings.

Converting those changes the resting look of most admin screens, not just the pills. Issue 2332
tracks them. The storefront has the same shapes and is excluded, because storefront visual changes
need owner sign-off. Cost if wrong: warning-coloured admin text stays at 1.8:1 until issue 2332
lands.

**Ruling YWA-2: amends EWO-A1. A 404 from `/auth/me` carrying the API's own
`{ error: { code: 'NOT_FOUND' } }` body is `signed-out` (issue 2283).**
`authenticate` lets a validly-signed token through when its user row is gone (tokenVersion
falls back to 0 and `blocked` to false), so `AuthService.getProfile` is what answers, with 404. Admin and orders now clear the stored session on that answer, on the first read and on the
post-refresh retry. A 404 without the API envelope, such as an edge or platform page, is still
`unavailable`. That preserves EWO-A1's "mis-routed 404" case, and a test pins it. Cost if wrong:
if the API ever loses the `/auth/me` route itself, its catch-all also answers `NOT_FOUND`, and
every admin/orders session would sign out instead of waiting. That is a deploy that has already
broken login.

**Ruling YWA-3: the iOS "no stored refresh token" bail-out yields to session evidence (issue
2320).** The `staleRefreshToken` heal drops the stored pair and continues on the rotated cookie.
The bail-out then returned `null` on the next expiry and signed a live session out. Admin and
orders now bail only when there is no stored token AND no `hasSessionEvidence()`, and the heal
records evidence. A signed-out iOS client still skips the call, because `clearStoredSession()`
removes the evidence. Cost if wrong: an iOS client whose cookie also died spends one `/auth/refresh`
(400), then signs out as before.

## 2026-10-01 — owner decisions 6 / 7 / 9 (branch `fix/owner-decisions-6-7-9`)

**Ruling OD-6a — receive refuses an old-shape variant-less PO line on a variant product; no
auto-repair.** A line drafted before the per-variant rule names no variant, so there is no correct
row to write: the parent column must stay 0 (inventory-model.md) and picking a variant would be a
guess. `receivePurchaseOrder` throws 400 `VARIANT_REQUIRED` and the merchant cancels + redrafts.
Cost if wrong: a merchant holding an already-sent old-shape PO must redraft it before receiving, and
the receive screen shows an error until they do.

**Ruling OD-6b — a variant with no rule of its own falls back to the product's rule, then to the
product's `lowStockThreshold`, applied per variant.** There is no per-variant threshold column; the
product-level rule/threshold is the only merchant input that exists. Cost if wrong: a product with
many variants gets its product-level minimum applied to EACH variant, so reorder suggestions fire
per variant at that threshold (a merchant who meant it as a product total sees more suggestions).

**Ruling OD-7a — the fingerprint covers `merchantId` as well as `apiKey` (two nullable columns, one
migration).** #2010 names both: `maskCredentials` masked both from ciphertext. Fixing one would
leave the second half of the same helper showing ciphertext fragments. The fingerprint is the last 4
characters of the plaintext as specified; it is not length-gated. Cost if wrong: a merchant id of 4
characters or fewer is shown in full (merchant ids are identifiers the provider also prints on
receipts, not secrets).

**Ruling OD-7b — answer-engine and wbs-integration keep their current mask in this PR.** The issue's
owner-question comment asked for one rule across `payment-settings`, `answer-engine/config.service.ts`
(also masks ciphertext) and `wbs-integration.routes.ts` (decrypts on read, shows first+last 4).
This PR's brief is the payment key display; the other two are different tables (and a store column)
with their own admin surfaces. Recorded here so they do not read as fixed. Cost if wrong: the
answer-engine key display still shows a ciphertext fragment, and the WBS GET still decrypts on every
read, until a follow-up applies the same save-time fingerprint.

**Ruling OD-9a — only the UNSET sale badge moves; a merchant-chosen corner is honoured as before.**
An explicit `discountBadge.position` is physical and keeps its collision avoidance and its lifted
tier over the mobile add-to-cart band. Overriding a setting the merchant made would remove a
customisation dial (pillar 1). Cost if wrong: a store that explicitly picked a bottom corner still
sees the chip lifted ~96px on a desktop grid at rest.

**Ruling OD-9b — the custom (merchant-text) badge's default stays bottom-right and still lifts.**
The owner decision covers the sale badge. The custom chip only renders when the merchant typed a
label, and moving it is a separate look change. Cost if wrong: on desktop at rest a custom label
chip still floats ~96px up the image on the five theme cards (the same shape #1998 described for
the sale chip).

**Ruling OD-9c — "not orderable" reserves the reading-start top corner for the pinned sale chip on
every surface.** Every card path renders `OutOfStockRibbon` there by default (88px diagonal box); the
chip moves to the end corner, or below the shallower occupant. A merchant who hid the OOS label, or
moved its pill elsewhere, gets the chip on the end side anyway. Cost if wrong: for those stores an
out-of-stock sale chip sits on the reading-end side even though the start corner is empty; on the
narrow (~134px) PLP card the chip can touch the diagonal ribbon's tail (visible in the AFTER shots).

**Ruling OD-9d — the new position is the platform default; pecannbee keeps the legacy corner through
per-store DATA (`StoreTheme.saleBadgeLegacyCorner = true`), set by a one-off script BEFORE deploy.**
Owner, 2026-09-30: every store except pecannbee gets the top corner; pecannbee must look exactly as
now. The code never branches on a slug; it reads the flag. `scripts/set-sale-badge-legacy-corner.mjs`
writes it through the live theme PUT, which shallow-merges an unknown key and busts the store caches,
so it can run before the code that reads it ships. Proven: every surface with the flag set is
pixel-identical to origin/main (screenshot diff = 0). Cost if wrong: if the script is not run (or its
edge-cache check not waited for) before deploy, pecannbee shows the top-corner badge until the flag
lands — the run order in the PR body is the control.
