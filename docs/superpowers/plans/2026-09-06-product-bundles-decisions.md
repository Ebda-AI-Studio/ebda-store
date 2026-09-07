# Product bundles — decisions, residuals and follow-ups

> Companion to `2026-09-06-product-bundles-design.md` (spec) and
> `2026-09-06-product-bundles.md` (plan). Written at merge time from the execution ledger.
> Every call taken on Ahmad's behalf during the build is here with what it costs if wrong —
> per the standing rule that a ruling recorded only in chat is a decision made in secret.

## Rulings

Ruling C1 — `packages/shared` exports `BundlePricingType` as a string union and does NOT import from
@force/database; the API passes the Prisma enum value through, the two being structurally identical
strings. Keeps @force/shared free of a DB dependency, which its other modules already rely on.
Cost if wrong: a future enum value added in Prisma and not in the union type-errors at the call
site — a loud failure, not a silent one.

Ruling C2 — `nearestAllocatablePrice` moves to `packages/shared/src/bundle-pricing.ts` beside
`isAllocatable`; it is pure and has no business in a route module. T4's test imports it from
'@force/shared'. Cost if wrong: none material — one extra export in an already-exported module.

Ruling C3 — T10 is split. The FWB-side work (catalogue bridge payload + /feeds/products.json) stays
in this branch. The whatsapp-bulk-sender change is a SEPARATE PR in that repo and is out of scope
here; a bundle simply will not appear in DM ordering until it lands. Cost if wrong: bundles sell on
web before DMs for one release — visible, reversible, and better than a cross-repo branch nobody
can merge atomically.

Ruling C4 — integration/E2E helpers are real deliverables, not incidental. T5's implementer creates
`tests/helpers/bundle-fixtures.ts` exporting the helpers its own tests use, and T6/T7/T8 extend that
one file rather than inventing parallel helpers. Cost if wrong: helper drift across test files —
caught by review, cheap to consolidate.

Ruling C5 — T9/T10/T11 carry prose rather than complete code because they are UI/docs work that must
follow existing in-repo patterns (the promotions admin page, the existing feed route). Their
implementers get the pattern file path in the dispatch instead of invented code. Cost if wrong: a UI
that does not match house style — caught by task review, cosmetic to fix.

Ruling C6 (SAFETY, pre-Task-1) — NO subagent may run a Prisma command that connects to a database.
`prisma migrate dev` (even `--create-only`) opens a connection and can reset a dev database, and
DATABASE_URL on this machine may point at a real Neon branch. The migration SQL is hand-written and
verified with the two OFFLINE commands only: `prisma validate` and `prisma generate`. Cost if wrong:
a wiped developer database — which is exactly the class of thing Ahmad said must not happen.
Task 1: dispatched (sonnet) — BASE 485ff44f — additive schema + migration guard test
Task 1: DONE_WITH_CONCERNS (commit 50fcaa94) — 5/5 guard tests, typecheck 0, no DB command run

Ruling T1-a — the guard test's "does not touch cart_items" assertion is too weak and MUST be
strengthened. It greps only for `ALTER TABLE cart_items`, so a bare
`DROP INDEX "cart_items_cart_id_product_id_key";` slips past it; the suite reddened only via the
separate "drops nothing" assertion. This is my plan's defect, found by the implementer's mutation
test — exactly the gate-that-cannot-fail class. Fix: assert no statement mentions cart_items at all.
Cost if wrong: a future migration silently drops a cart_items index and the guard named to prevent
it stays green.

Ruling T1-b — `bundles` MUST get RLS, mirroring `promotions` (ENABLE + FORCE + per-operation
policies using current_store_id() / app.bypass_rls). The implementer's premise was half wrong:
`carts` DOES have RLS; only `cart_items` lacks it. Verified: promotions, coupons, warehouses, carts
and order_items all have RLS; cart_items does not. `bundles` carries store_id and is directly
queryable, so it is a promotions-shaped table, not a cart_items-shaped one.
Cost if wrong: a cross-tenant read of another merchant's bundle definitions and pricing — the exact
class the RLS cutover programme exists to close.

Ruling T1-c — `bundle_items` and `cart_bundles` get NO RLS, following the `cart_items` precedent:
neither carries store*id, and both are reachable only through an RLS-protected parent.
Cost if wrong: a direct query on bundle_items could read another tenant's bundle contents. Accepted
because it is consistent with the existing cart_items decision; flagged for the final review.
Task 1: fix round 1/5 (2 addressed, 0 open — guard strengthened to reject ANY cart_items statement; bundles RLS added mirroring promotions, 4 policies + FORCE; commits 50fcaa94..6509bb93)
Task 1: controller verified independently — 6/6 guard tests, 4 bundles_app*\* policies, ENABLE+FORCE present, all 4 cart_items mentions are comments correctly filtered
Task 1: review dispatched (sonnet), package review-485ff44f..6509bb93.diff
Task 1: review 1 — spec ✅ / quality Needs work. Critical: FK guard matched the migration's own
header COMMENT, not the DDL (mutation-proven: real FK flipped to CASCADE still passed).
Important: report stale vs diff. Minors deferred: NOT-NULL guard gap (ADD COLUMN w/o default);
OrderItem.bundleId has no FK to Bundle (intentional — snapshot semantics).
Task 1: fix round 2/5 dispatched (Critical FK guard + report accuracy)
Task 1: fix round 2/5 (2 addressed, 0 open — FK guard now reads comment-stripped DDL; report rewritten; commits 6509bb93..5a920ae0)
Task 1: controller independently mutation-tested the fixed guard — flipping the real FK to CASCADE fails it BY NAME, byte-identical restore returns 6/6
Task 1: minor (deferred): "never NOT NULL" guard misses a NOT-NULL-without-default ADD COLUMN
Task 1: minor (deferred): OrderItem.bundleId has no FK to Bundle — intentional (snapshot semantics)
Task 1: minor (deferred): report does not label 5a920ae0 as "Fix Round 2"
Task 1: complete (commits 485ff44f..5a920ae0, review clean)

Ruling T2-a — the brief's invariant-1 tests are SELF-ORACLING and must not be relied on. The
property sweep gates on `isAllocatable`, which calls the same `allocateBundlePrice` it is meant to
check, so under the residual mutation it skips precisely the 8,500/14,501 prices that break. The
implementer's added unfiltered exhaustive sweep is the real guard and STAYS. My own earlier
"independent" mutation only reddened because that added test already existed — the brief alone
would have shipped a money invariant with no working guard. Same class as Task 1's Critical.
Cost if wrong: none — the stronger test is strictly additive.

Ruling T2-b — `allocateBundlePrice` infinite-loops when a line quantity is negative (timeout-
confirmed by the implementer). Reachable from a cart read, so it would hang a Cloudflare Worker,
not just fail. Fix in THREE places, defence in depth:

1. the function itself throws on quantity < 1 rather than looping (a hang is the worst failure
   mode available — it consumes the request and tells nobody why);
2. a CHECK constraint `quantity >= 1` on bundle_items, amended into the Task 1 migration —
   that migration is UNRELEASED (RULING C6 means it has never touched a database), so amending
   it is strictly better than shipping a second migration to fix a constraint we never released;
3. Zod `.int().min(1)` at the admin write boundary in Task 4.
   Cost if wrong: a merchant could store quantity 0 and see a confusing validation error instead of a
   silent hang — strictly the better failure.
   Task 2: fix round 1/5 (2 addressed, 0 open — throw-on-invalid-quantity guard + CHECK(quantity>=1) amended into the unreleased Task 1 migration + 3 guard tests; commits 2d877e87..cfddcb63)
   Task 2: controller independently verified the hang is closed — negative quantity throws in 23ms, 34/34 tests across both files in 439ms
   Task 2: review dispatched (sonnet)
   Task 2: review 1 — spec ✅ / quality Needs work. Two Important:
   (a) residual distribution is unit-by-unit, so a large-but-valid quantity costs 142.8M iterations
   (~1.1s CPU) — a Cloudflare Worker CPU cliff reachable from a cart read;
   (b) the 2000ms per-test timeouts do NOT terminate a real synchronous loop under this repo's
   pool:'forks', so the tests' "safety net" framing overstates what protects CI.

Ruling T2-c — fix (a) properly AND bound it. The distribution must be arithmetic (compute how many
increments each line takes with integer division, O(lines)) rather than stepping one unit at a time;
and `bundle_items.quantity` gets an upper bound in the same CHECK constraint plus Zod in Task 4.
Real kits hold 1-20 of a thing; 1000 is already absurd. Cost if wrong: a merchant who genuinely
needs >1000 of one item in a bundle hits a validation error and has to ask — visible and cheap,
versus a Worker burning CPU on every cart read.

Ruling T2-d — fix (b) by correcting the CLAIM, not by chasing a timeout mechanism that cannot work.
A synchronous infinite loop is not interruptible by a JS test timeout; pretending otherwise is the
same overstatement class as a gate that cannot fail. The tests keep their value (they assert the
throw) but their comments must not claim to catch a hang. Cost if wrong: none — this is accuracy.
Task 2: fix round 2/5 (2 addressed — closed-form round batching replaces per-unit stepping, bounded
by ~2x line count; CHECK upper bound 1000 added; hang-guard test comments corrected per T2-d;
commits cfddcb63..82b53194). Controller note: my own proposed perf test asserted an exact sum on
a price that is NOT allocatable for those quantities — the implementer caught it and substituted a
genuinely allocatable 1e9-quantity case. Verified isAllocatable(400000)=false and 0 invariant
violations across the allocatable prices nearby.
Task 2: controller independently verified equivalence — 120,000 randomized cases comparing the new
closed-form batching against a transcription of the original per-unit algorithm: 0 divergences.
Task 2: fix round 3/5 (1 addressed — committed tests/unit/bundle-allocation-equivalence.test.ts:
seeded mulberry32 oracle sweep + the [3,2,2]@6 adversarial case; counts reconciled to 920,370;
commits 82b53194..ea60c04a)
Task 2: re-review returned NOT ADDRESSED on report completeness — STALE READ (race with the
implementer's final write). Controller verified directly: report is 538 lines with all three
fix-round sections, the third at line 438. Not a real finding.
Task 2: controller mutation-proved the new equivalence suite — injecting the naive single-pass
distribution fails 4/6, byte-identical restore returns 6/6.
Task 2: minor (deferred): unitPrice half of the input guard is not itself mutation-tested
Task 2: complete (commits 5a920ae0..ea60c04a, review clean)

Ruling T3-a — resolveBundle must EXPOSE the lifecycle state, not filter on it. Admin has to load an
inactive or expired bundle in order to edit it; only the selling surfaces must refuse it. So
ResolvedBundle gains isActive/startsAt/expiresAt plus a derived `isPurchasable` (active AND inside
the window AND available >= 1), and Tasks 4/5/6 gate on isPurchasable. Filtering inside the resolver
would make the admin edit screen unable to load the very bundle a merchant is trying to fix.
Cost if wrong: an admin screen that cannot open an expired bundle — visible immediately, cheap.

Ruling T3-b — replace MAX_SAFE_INTEGER with a named, JSON-safe, arithmetic-safe cap
(UNTRACKED_AVAILABILITY_CAP = 1_000_000), far above any real stock and impossible to overflow when
multiplied by a bundle quantity bounded at 1000. A sentinel that is also an arithmetic operand is
the kind that reads fine and breaks three layers away.
Cost if wrong: a merchant with genuinely untracked components sees availability capped at 1,000,000
instead of "unlimited" — invisible in practice.

Ruling T3-c — the real-database tenant-isolation test is CARRIED FORWARD to Task 5, which is the
first task with DB integration fixtures. It is not Task 3's to fake with mocks. Recorded here so it
cannot be lost; Task 5's dispatch will require it explicitly.
Cost if wrong: the tenant guard's query scoping stays mock-verified for one more task.
Task 3: fix round 1/5 (2 Important + 2 Minor addressed — isPurchasable lifecycle gate exposed
(not filtered, so admin can still load an expired bundle to edit it); UNTRACKED_AVAILABILITY_CAP
replaces MAX_SAFE_INTEGER; DbClient alias; ResolvedBundle JSDoc. commits fe6208d8..e46af4ec)
Task 3: controller independently mutation-tested the expiry gate — reddens "is false for an expired
bundle" by name, byte-identical restore, 53/53 across four suites.
Task 3: re-review — all 4 findings ADDRESSED, resolver still resolves inactive/expired, no new breakage
Task 3: minor (deferred): cross-tenant guard is mock-verified only — real-DB test carried to Task 5 (T3-c)
Task 3: complete (commits ea60c04a..e46af4ec, review clean)

Ruling T5-a — change to 201 and update the test. My brief's literal test forced 200; the repo's
convention is 201 on create and a comment justifying the wrong code with a wrong reason is worse
than either code alone. Cost if wrong: a client keying on 200 breaks — but nothing consumes this
route yet (Task 8 is the first).

Ruling T5-b — mergeGuestCart must not silently drop bundles. Implement the bundle merge if it is
small and does not break existing mocks; otherwise add an explicit comment naming the gap. Silence
is the failure mode: the method is dead now, so whoever wires it later will not know bundles were
never considered. Cost if wrong: a few lines of merge logic that nothing calls yet.

Ruling T5-c — CARRIED TO TASK 6, where it belongs. The cart's per-bundle check is inherently
optimistic (stock moves between cart and checkout regardless), so tightening it in the cart buys
little. The binding guarantee is the transactional check at order creation, which must consider
ALL bundles and loose items in the cart TOGETHER against each component's stock. Task 6's dispatch
will require a test: two bundles sharing a component, each satisfiable alone, both in one cart ->
checkout must refuse rather than oversell.
Cost if wrong: a cart shows two bundles as addable and checkout rejects one — annoying but correct;
the alternative, overselling a merchant's stock, is the one that costs real money.
Task 5: fix round 1/5 (2 addressed — 201 on add with the wrong rationale DELETED not reworded;
mergeGuestCart now merges cart_bundles with a real-DB test covering the (cartId,bundleId) unique
index; 4 call sites needed the status update, not the 2 I estimated. commits b9c406e7..6c4063b9)
Task 5: controller verified with a DB configured — 12/12 integration pass WITH DATABASE_URL and
12/12 skip without (distinction explicitly on the record); unit baseline unchanged at 2030/2030.
Task 5: minor (deferred): mergeGuestCart's return value does not recompute bundle price/availability
via resolveBundle — matches its pre-existing behaviour for items; flagged inline in code.
Task 5: re-review — both findings ADDRESSED; unique-index case handled by increment-not-insert;
?? [] fallback judged sound (defends legacy mocks only, production always includes bundles);
no change to cart item behaviour.
Task 5: complete (commits 2424de4c..6c4063b9, review clean)

Ruling T7-a — split it. The ROUTE fix belongs here and lands now: `return.routes.ts` must accept and
validate `bundleGroupIds` and pass them through, otherwise Task 7's whole capability is unreachable
from outside the service. The customer-facing UI (offering the box as ONE selectable row) is carried
to Task 8, which owns storefront rendering. Shipping the service without the route would be a
capability that exists only in tests.
Cost if wrong: the route accepts a field the UI does not yet send — inert until Task 8.

Ruling T7-b — add the double-submit test. The guard is inherited from the loose-line path and
verified by inspection, but this is a refund: "verified by inspection" is what we say right before
money leaves twice. Cheap to cover, so cover it.
Task 7: fix round 1/5 (2 addressed — return.routes.ts accepts bundleGroupIds (uuid[], 1..50,
optional, with a refine so items-or-groups is still required); double-submit test added.
commits 2b7fb6e3..6f876dfc). 11/11 bundle-returns ran, 34/34 across the three bundle suites,
unit 2030/2030.
Task 7: root cause of the false "no returns UI" claim — the implementer ran
`grep -rn "returns" ... | head -20` over 46 matches; ReturnsClient.tsx was hit #21. An
"enumerate the first N" search used to answer an EXISTENCE question is unsound by construction.
This is the standing never-head-a-sweep rule reproducing itself inside this plan.
Task 7: re-review — both findings ADDRESSED; apps/web untouched; empty-request rejection intact;
no change to refund math, atomicity gate or restock. Double-submit refused with INVALID_QUANTITY.
Task 7: complete (commits ca1936d6..6f876dfc, review clean)
BACKEND COMPLETE: schema, pricing, service, admin API, cart, checkout expansion, atomic returns.

Ruling T8-a — revert the vitest.config.ts exclude and make the test actually run, following the
directory's existing convention (.test.ts under tests/e2e, run by vitest) rather than inventing a
Playwright spec the runner cannot see. If an assertion genuinely needs a browser it belongs in
tests/smoke with a name matching playwright's testMatch — but nothing ships as a test no runner
executes. Cost if wrong: the storefront assertions run in a jsdom-ish vitest environment rather than
a real browser — weaker than Playwright, infinitely stronger than not running.
Task 8: implementer ALSO found + fixed two bugs outside the brief that would have shipped a dead
feature: (1) Task 5's bundle-cart routes were unreachable from any real merchant storefront,
blocked by restrictPlatformOnlyOrigins; (2) a bundle-only cart rendered as "empty" and blocked
checkout entirely. Plus two extra leak surfaces fixed (orders-list preview, payment-success email)
and the invoice service + order-created/order-status-changed emails brought into the one-row rule.
Task 8: FOLLOW-UPS RECORDED, deliberately not fixed in this task:
(a) NO storefront discovery surface for bundles — a merchant can create one and it can be carted
via API, but a customer cannot find it. The bundle detail page (/bundles/<slug>) was skipped
because sitemap/OG generation is centralised with a hand-tuned subrequest budget, and the
listing-card fallback was skipped rather than bolted unreviewed into page-builder-owned
surfaces. This is a real product gap and Ahmad should decide it — he art-directs UI.
(b) abandoned-cart.service.ts ignores cart.bundles, so a bundle-only cart is invisible to
abandonment detection.
Task 8: fix round 1/5 dispatched — RULING T8-a (make the E2E test actually run)
Task 8: fix round 1/5 (Critical addressed — vitest exclude reverted, .spec.ts deleted, rewritten as
tests/e2e/bundle-checkout.test.ts. Controller independently confirmed `vitest list tests/e2e` now
MENTIONS bundle-checkout and the file passes 6/6. commits d0e8d33e..da467635)
Task 8: review — spec ✅ / quality Approved, no Critical. One Important: the new /public/cart/bundles
routes (the origin-bug fix) have ZERO HTTP-level coverage — every test hits the old route or the
service directly, so a regression on the route the storefront actually calls would ship silently.
Task 8: minor (deferred to Ahmad): BundleLine's card border/hover is a close-but-not-exact match of
.cart-item — UI judgement, his call.
Ruling T8-b — the GET /public/orders/:id payload exposing per-component prices is ACCEPTED as-is and
logged as backlog, not fixed. It is the customer's own paid order (no cross-party leak), the
brief's rule governs the rendered interface, and redacting it means splitting OrderService.getById's
field set by caller identity — a separate architectural change. Cost if wrong: a curious customer
reading their own order JSON sees the internal allocation of a purchase they already paid in full.
Task 8: fix round 2/5 dispatched (cover the public routes + mutation-test the origin fix)
Task 8: fix round 2/5 — the HTTP-level tests I required IMMEDIATELY found a production-breaking bug:
`DELETE /public/cart/bundles/:id` had a param named `id`, and requireFeature resolves storeId as
`req.params.storeId || req.params.id || ... || x-store-id`. On the public route (no :storeId param)
the CartBundle UUID was read AS the store id, so every real bundle removal would have 403'd
FEATURE_DISABLED. Renamed to :cartBundleId. No pre-existing test could have caught it — they all
called CartService directly or hit the /stores/:storeId sibling where :storeId wins first.
4 bundle suites 43/43 (was 40), unit 2037/176. commits da467635..d7a03d09
Task 8: re-review — both findings ADDRESSED; :cartBundleId rename consistent across route, handler
and client; the /stores/:storeId sibling correctly left alone (storeId wins there).
DEFECT-CLASS SWEEP: reviewer enumerated ~230 requireFeature call sites across ~35 files — the two
bundle public routes were the ONLY instances of "non-store resource under :id with no :storeId in
the chain". Both fixed. No new breakage.
Task 8: complete (commits 6f876dfc..d7a03d09, review clean)

Ruling T9-a — fix the 422 at the SOURCE, not per screen. The bespoke body is Task 4's, nothing else
consumes it, and the admin UI is its only caller, so changing it now is cheap. Move it onto this
repo's standard error envelope carrying `suggested` in the details payload, then delete the custom
parser so the screen uses apiPost/apiPut like every other admin screen. Cost if wrong: Task 4's
route tests need updating in the same commit — contained, and caught immediately by those tests.

Ruling T9-b — add variant titleAr to the GET /bundles/:id select and render by locale. One line of
API plus the render. An Arabic-first admin showing English variant names is exactly the bilingual
gap the standard exists to prevent.
Task 9: fix round 1/5 (Critical + 2 Important addressed — variant path extracted into a shared
bundlePricing helper used by both call sites (`data?.variants`); 422 moved onto the standard
envelope with ApiError/apiRequest forwarding `details`, bespoke parser deleted, screen now uses
apiPost/apiPut; variant titleAr selected and rendered by locale. commits 2de43510..029e6b62)
Task 9: controller verified — 5 test files / 61 tests pass, all three typechecks clean, the only
remaining apiFetch mention is a comment recording that the workaround was removed.
Task 9: recorded separately, NOT fixed here (out of branch scope): the same
`data?.product?.variants` path bug pre-exists at apps/admin/src/app/stores/[id]/orders/new/page.tsx:214.
Task 9: re-review dispatched (sonnet)
Task 9: re-review — all 3 ADDRESSED. Finding 1's test PROVEN to fail against the old path
(reverted → 2 of 3 reddened). Task 4's route tests updated to the new envelope, not left asserting
a dead shape. titleAr both selected and rendered via the existing displayName locale helper.
No new breakage: AppError.details widening verified inert by AST scan (2 of 341 call sites pass a
4th arg, both new); sibling cart 422s untouched behaviourally (comment-only edits).
Task 9: complete (commits d7a03d09..029e6b62, review clean)

Ruling C3 — AMENDED. My original cost-if-wrong ("a bundle simply will not appear in DM ordering
until the WBS PR lands") was WRONG. /wa-bridge/store-catalog is a LIVE read with no server-side TTL,
so enabling the `bundles` feature for a store before the whatsapp-bulk-sender PR ships will surface
isBundle:true entries to the WBS bot within its normal ~5-minute poll — not keep them invisible.
Corrected guard: DO NOT flip the bundles StoreFeature for any store until the WBS consumer PR has
shipped. This moves from "harmless lag" to "launch-sequencing requirement" and must appear in the
rollout section of the PR description.

Ruling C3 — CLOSED (2026-09-07). The separate whatsapp-bulk-sender consumer PR is no longer
required, and the launch-sequencing guard above is discharged. `POST /wa-bridge/cart/from-wa` now
resolves an id that fails to match a `Product` row as a bundle (via `resolveBundle`, gated on the
SAME `bundles` feature flag `/store-catalog` already checks) before returning `PRODUCTS_NOT_FOUND`
— so WBS needs zero code changes: it already echoes back whatever id `/store-catalog` handed it,
and that id now resolves on the FWB side regardless of which kind of catalogue entry it was. Cost
if wrong: none material if this is somehow insufficient — the WBS-side PR remains available as a
fallback path, and the flag stays off for every store today regardless (no plan baseline includes
`bundles`), so nothing ships to a live merchant on this alone.

Ruling F-1 — ONE fix wave covers C1, I1, I2, I3, I5, I6 and the I4 DOC correction. The storefront
purchase path itself (page + listing card + add-to-cart) is explicitly NOT in this wave: it is a
UI-design task Ahmad art-directs, and bolting it in unreviewed at the end of a 24-commit branch is
how the last mile gets ugly. This branch merges as a back-office capability with the feature off
everywhere. Cost if wrong: a second PR is needed before any customer can buy a bundle — which is
true regardless, since DM ordering also waits on the WBS PR.

## Residuals accepted (shipping with these)

| Item                                                                                               | Call                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 — "never NOT NULL" guard misses `ADD COLUMN … NOT NULL` without a default                       | **Ship.** The guard only ever reads this one migration, which is correct today.                                                                                                                                                                                                                                                                                                                          |
| T1 — `OrderItem.bundleId` has no FK to `Bundle`                                                    | **Ship.** Deliberate snapshot semantics, matching `productName`/`costPrice`. Correct.                                                                                                                                                                                                                                                                                                                    |
| T1 — report doesn't label `5a920ae0` as Fix Round 2                                                | **Ship.** Bookkeeping.                                                                                                                                                                                                                                                                                                                                                                                   |
| T2 — `unitPrice` half of the input guard not mutation-tested                                       | **Ship.** `assertValidLines` rejects it; a negative catalogue price is not reachable.                                                                                                                                                                                                                                                                                                                    |
| T3 — cross-tenant guard mock-verified only                                                         | **Closed**, discharged at Task 5 with real-DB tests. Remove from the open list.                                                                                                                                                                                                                                                                                                                          |
| T4 — no public single-bundle detail route                                                          | **Ship**, but it is a prerequisite for the storefront page; bundle it into that follow-up.                                                                                                                                                                                                                                                                                                               |
| T4 — `packages/shared` needs a rebuild after pulling                                               | **Ship.** Dev ergonomics; CI builds it.                                                                                                                                                                                                                                                                                                                                                                  |
| T4 — 422 body omits the standard wrapper                                                           | **Closed** by Ruling T9-a. Remove from the open list.                                                                                                                                                                                                                                                                                                                                                    |
| T5 — `mergeGuestCart`'s return doesn't reprice via `resolveBundle`                                 | **Ship.** Matches the pre-existing item behaviour; the next `getOrCreate` reprices.                                                                                                                                                                                                                                                                                                                      |
| T6 — coupon/promotion targeting doesn't see bundle components                                      | **Ship — this is Ruling B1 working**, verified at `order.service.ts:480` (the targeting snapshot is built from `cart.items` only). Not a gap; reclassify it in the ledger as _implemented_, because a finding that stays on a "deferred" list reads as unfixed.                                                                                                                                          |
| T6 — bundle error codes fall back to generic checkout copy                                         | **Ship today** (unreachable: no customer can reach checkout with a bundle). **Must ship with the storefront surface**, or the first real customer sees "checkout failed" for `BUNDLE_NOT_PURCHASABLE`. **Done (2026-09-07)** — see `apps/web/src/lib/checkout-bundle-errors.ts`; both `BUNDLE_NOT_PURCHASABLE` and a bundle-component `INSUFFICIENT_INVENTORY` now render bilingual, bundle-naming copy. |
| T8(b) — `abandoned-cart.service.ts` ignores `cart.bundles`                                         | **Ship for the single-merchant pilot; fix before offering it to a second merchant.** Verified: no bundle reference anywhere in that service. `abandoned_cart` is a Starter-baseline feature every paying store has, so a bundle-only cart silently never triggers recovery — a revenue hole that grows with adoption, not a bug. **Done (2026-09-07)** — see follow-up 4's correction below.             |
| T8 — `BundleLine` border/hover not an exact `.cart-item` match                                     | **Ship.** Ahmad's call; he art-directs.                                                                                                                                                                                                                                                                                                                                                                  |
| Ruling T8-b — `GET /public/orders/:id` JSON exposes per-component prices                           | **Ship as an accepted residual.** The reasoning holds: it is the customer's own paid order and the rendered page collapses it. Note that this is _not_ the same as I3 above — I3 is a **rendered** merchant-branded payment page, not a transport payload.                                                                                                                                               |
| T9 — the same `data?.product?.variants` bug pre-exists at `apps/admin/.../orders/new/page.tsx:214` | **Ship (out of branch scope) — but file it today.** It is a live defect on an existing admin screen: the variant picker on manual order creation never loads variants. Found knowingly; do not let it evaporate with this branch.                                                                                                                                                                        |
| T10 — `order-refunded.ts` never calls `invalidateStoreProductCaches`                               | **Ship.** Verified (no such call in that file). Pre-existing; direction is under-advertising, not oversell.                                                                                                                                                                                                                                                                                              |
| T10 — feed cache key doesn't vary by the `bundles` flag                                            | **Ship**, but fold it into the launch gate: flipping the StoreFeature will not bust the 600s feed cache, so bundles take up to ten minutes to appear or disappear. Say so in the rollout steps.                                                                                                                                                                                                          |
| Ruling T1-c — `bundle_items` / `cart_bundles` have no RLS                                          | **Ship.** I verified all three unfiltered read sites are preceded by a store-scoped resolve. Record it as an accepted residual in the ledger **with those three call sites named**, per the ruling-form rule — the protection is call-site discipline, and a future call site that skips the resolve reintroduces a cross-tenant read with nothing to stop it.                                           |

---

## Follow-ups that must not evaporate with this branch

1. ~~**No customer purchase path exists.** `addBundle` and `getPublicBundles` have zero callers;
   there is no `/bundles/<slug>` page, listing card, or add-to-cart control. This branch ships a
   back-office capability. A second PR is required before any customer can buy a bundle.~~
   **Correction (2026-09-07, part 1 of 2 shipped):** the public single-bundle detail route
   (`GET /public/:storeId/bundles/:slug`, by slug, mirroring `GET /public/products/:slugOrId`'s
   404-vs-unavailable split — a deactivated bundle 404s, an out-of-stock/expired one still 200s
   with `isPurchasable:false`), the `/bundles/[slug]` storefront page (metadata, JSON-LD, sitemap
   fan-out, bilingual AR/EN, add-to-cart wired to `addBundle`), and the SPECIFIC
   `bundle_not_purchasable`/`insufficient_stock` toast copy (T6's residual, above) are now built —
   `addBundle` has a real caller and a customer can find and buy a bundle. `getPublicBundles` (the
   PLP LIST endpoint, plural) still has zero callers: there is still no bundle discovery surface on
   the products listing / home page (a card, a "Bundles" section) — that remains part 2, deliberately
   out of this pass per Ruling F-1 (UI/art-direction Ahmad reviews separately). Rollout step 3 below
   is therefore PARTIALLY done; steps 1/2/4 are unchanged.
   **Correction (2026-09-07, part 2 of 2 shipped):** `getPublicBundles` now has a real caller — a
   dedicated `/bundles` index page (mirrors `categories`'/`products`' listing shape: single
   unpaginated fetch, no filter sidebar, loading/empty states, bilingual AR/EN + RTL,
   `generateMetadata` + sitemap fan-out) plus a top-level "Bundles" nav entry auto-appended in
   `ShopChrome` (same pattern as the existing "Locations" auto-append), shown only when the store
   has the `bundles` feature AND at least one currently purchasable bundle. Deliberately did NOT
   touch the page-builder-owned Products/Home pages (per this same Ruling F-1) — a dedicated route
   - nav entry is the safe, production-correct discovery surface instead. Rollout step 3 is now
     fully done. T6's checkout copy is ALSO now complete: `BUNDLE_NOT_PURCHASABLE` (previously
     unhandled — silent fallthrough to the fully generic "Something went wrong") and a
     bundle-component `INSUFFICIENT_INVENTORY` (previously generic, didn't name the bundle) both get
     bilingual, bundle-naming copy in `CheckoutClient`'s error switch — see
     `apps/web/src/lib/checkout-bundle-errors.ts`.
2. ~~**Launch gate — do NOT enable the `bundles` StoreFeature for any store** until the
   whatsapp-bulk-sender consumer PR ships. `/wa-bridge/store-catalog` is a live, uncached read,
   so flipping the flag early surfaces `isBundle:true` entries to a bot that will treat a bundle
   id as a product id, within its ~5-minute poll.~~
   **Correction (2026-09-07, closed) — see Ruling C3 (CLOSED).** `POST /wa-bridge/cart/from-wa`
   now resolves an id that isn't a product as a bundle server-side (same feature-flag gate as
   `/store-catalog`), so WBS buying a bundle it was shown works with zero changes/deploys in the
   whatsapp-bulk-sender repo. The consumer PR is no longer a prerequisite for flipping the flag.
3. **Flipping the flag will not bust the 600s feed cache** — bundles take up to ten minutes to
   appear or disappear from the AI feed after a toggle.
4. ~~**`abandoned-cart.service.ts` ignores `cart.bundles`** — a bundle-only cart never triggers
   recovery. Fine for a one-merchant pilot; fix before a second merchant.~~
   **Correction (2026-09-07, fixed):** `detectNewAbandonments`'s candidate query now matches
   `items OR bundles` (was `items` only), and each `CartBundle` row resolves via `resolveBundle`
   into ONE snapshot line at the bundle's sale price — never the per-component allocated sum —
   folded into `cartItemCount`/`cartTotal`/`cartItems`. No-op for a store without the `bundles`
   feature (it can never hold a `CartBundle` row). See
   `tests/integration/abandoned-cart-bundles.test.ts`.
5. **Pre-existing, found here, not fixed:** `apps/admin/src/app/stores/[id]/orders/new/page.tsx:214`
   reads `data?.product?.variants` where the endpoint returns `variants` as a sibling — the
   variant picker on manual order creation never loads variants. Live defect on an existing screen.
6. **Pre-existing, found here, not fixed:** `apps/api/src/lib/inngest/functions/order-refunded.ts`
   never calls `invalidateStoreProductCaches`, contradicting that function's own doc comment —
   a restocked component can read stale-"unavailable" in the AI feed for up to 600s.
   Under-advertising, not oversell.

## Rollout

1. Merge with `bundles` in no plan baseline — zero effect on every existing store.
2. ~~Ship the whatsapp-bulk-sender consumer PR.~~ **No longer required (2026-09-07) — see Ruling
   C3 (CLOSED).** The resolution moved server-side: `POST /wa-bridge/cart/from-wa` resolves a
   bundle id itself, so WBS needs no changes/deploys.
3. Build the storefront purchase path (separate PR, art-directed).
4. Only then enable `StoreFeature bundles` for ONE merchant; place one real order; complete one
   real return; and only then offer it to a second.

---

## Final-review fix wave (2026-09-07) — rulings

Fixes for the 13 findings of `bundles-final-review.md` (1 P0, 6 P1, 6 P2), implementing Ahmad's
rulings C8–C12. Every guard added below was mutation-checked: the guard was reverted, the reddening
test named, and the code restored byte-identical. Unit suite 207 files / 2395 tests before the wave
→ 213 / 2453 after, zero regressions.

**Ruling FW-1 — P1-6 reads `store.enabledFeatures`, it does not add a `bundlesEnabled` field.**
Ruling C12 said to fold a `bundlesEnabled` boolean into the store resolve payload, "the same shape
`store.locationsEnabled` already uses". Verified before implementing: `enabledFeatures` is ALREADY on
both storefront resolve paths (`public.routes.ts:1426, 1612`), already mapped through
`store-resolver.ts` into `StoreContext`, and already read by `ShopChrome` itself a few lines below
for `floating_widget`. Adding a second, redundant boolean carrying the same fact would be
duplication, so the fetch is replaced with `store.enabledFeatures?.includes('bundles') === true` —
no API change, no new payload field, and the per-page request is gone. The `useBundlesNavVisible`
hook's premise that `bundles` had "no client-visible boolean equivalent" was simply false.
_Accepted residual:_ the nav entry now appears for a store with the feature on and ZERO purchasable
bundles, pointing at the `/bundles` index, which renders its normal empty state (a feature-off store
still 404s there). The part-2 correction above therefore no longer reads "AND at least one currently
purchasable bundle" — it is feature-gated only. Cost if wrong: one merchant in the pilot sees a nav
entry for an empty page they themselves have not filled yet; the alternative was a request on every
page view for every store on the platform.

**Ruling FW-2 — P2-1 needs a canonical sort on BOTH sides, not just `orderBy`.** The report
prescribed `orderBy: { id: 'asc' }` on the checkout read plus "key the save-time lines the same way".
`orderBy` alone cannot close the divergence: `BundleItem` ids are random uuids, so id order is never
request order, and admin has no ids at all at save time (create mints them; update deletes and
recreates them). Both sides now sort by `compareBundleComponents` — `(productId, variantId)`, the one
key both have — and the read keeps `orderBy: { id: 'asc' }` so the DB order is deterministic too.
No money invariant moves: the allocation still sums to the bundle price; this only fixes WHICH
component absorbs a 1-fil remainder and stops the two surfaces disagreeing about whether a price is
representable. Cost if wrong: an existing bundle's per-component allocation can shift by 1 fil on a
line, changing nothing the customer or merchant is charged.

**Ruling FW-3 — P2-2 is enforced in `resolveBundleLines`, not as a Zod refine.** The report suggested
`createSchema`/`updateSchema`. Implemented there first, then reverted: `errorHandler` flattens every
`ZodError` to `message: 'Invalid request data'` and buries the real text in `details`, and the admin
bundle editor renders `saveError.message` alone (it special-cases only `PRICE_NOT_ALLOCATABLE`). A
refine would have rejected the duplicate correctly and told the merchant nothing actionable. It is a
`400 DUPLICATE_BUNDLE_COMPONENT` `AppError` alongside `VARIANT_REQUIRED` — one writer, covering every
path into the resolver. Cost if wrong: a caller that bypasses the resolver would not be checked;
there is no such caller today.

**Ruling FW-4 — P1-4 skips the affected parent's variant rows, it does not fail the batch.** The
brief required "unrelated rows in the batch are not lost", which a catch inside the batch transaction
cannot deliver (the transaction has already rolled back by then). A Phase-2.5 pre-flight reads the
pinning `bundle_items` in one query before any write and drops only that parent's variant rows; its
own product row and every other row still import. The delete site keeps a
`throwIfBundleFkViolation` catch for the residual race (a bundle created between that read and the
write). Cost if wrong: a merchant re-importing a bundled product's variants gets those rows skipped
with a message naming the bundles, instead of the variants being replaced.

**Ruling FW-5 — P1-1's restore is guarded against a dead bundle id.** `OrderItem.bundleId` carries no
FK to `Bundle` (deliberate snapshot semantics, confirmed in the review's "already ruled" list), so
writing a `cart_bundles` row against it could raise a FK violation and abort the whole compensating
transaction — inventory unrestored, coupon unreleased, order stuck `pending`. The restore resolves
which ids still exist, store-scoped, inside the same transaction; anything else falls back to loose
lines (the pre-fix behaviour). Cost if wrong: one extra indexed read per payment-failure rollback.

**NOT FIXED — `apps/orders` renders bundle orders as unlabelled component lines.** Found in the
blast-radius sweep, NOT one of the 13 findings and not raised by the review.
`apps/orders/src/app/orders/[orderId]/_components/ItemsCard.tsx` reads the SAME endpoint as the admin
screen (`GET /api/v1/stores/:storeId/orders/:orderId`, see that app's `[orderId]/page.tsx:49`) but
its `OrderLineItem` type (`apps/orders/src/lib/orders.ts:33`) has no `bundleGroupId`/`bundleName`
field and it does no grouping at all — zero occurrences of "bundle" in `apps/orders/src`. A fulfiller
using the standalone orders app therefore sees a box as N unrelated products at allocated prices that
match no shelf price, with no bundle label and no group total: the same defect I6 fixed for
`apps/admin`. It does NOT have P1-2's slice-before-group bug, because there is no grouping to slice
before. Deliberately not fixed here: it needs a type widening, a new grouped row component and new
bilingual i18n keys in a THIRD app the review never examined, which is a new UI surface under Ruling
F-1 (art direction Ahmad reviews), not a fix. Cost of leaving it: during the one-merchant pilot, a
bundle order picked from `orders.force-ai.co` rather than the admin shows unlabelled components —
wrong information to a fulfiller, though the physical items and quantities are all correct and
present. Recommend fixing it before the pilot merchant fulfils a bundle order from that app.

**FIXED (2026-09-07) — `apps/orders` now groups and labels bundle rows.** `OrderLineItem`
(`apps/orders/src/lib/orders.ts`) gained `bundleId`/`bundleGroupId`/`bundleName`/`bundleNameAr`,
matching admin's `OrderItemDetail` and the web `Order` item shape. `ItemsCard.tsx` reuses the
canonical `groupOrderLinesForDisplay` (`packages/shared/src/order-lines.ts`) — the same grouper the
storefront uses — for the grouping and the bundle's name/summed total, then additionally renders the
grouper's `lines` (the raw components) indented beneath the bundle row, exactly as admin's `ItemsCard`
does: this is a fulfilment surface, so the fulfiller must still see every physical item, just labelled
and totalled correctly. The preview cut (`previewRows`) groups first and slices by display rows, so
this app never inherits P1-2's slice-before-group bug either. New `bundleBadge` i18n key added to
`apps/orders/src/i18n/messages.ts` (EN "Bundle" / AR "باقة"), matching admin's copy. Additive: an
order with no bundle lines groups to one row per item, byte-identical to the pre-fix render (verified
by test + the `totalRows === items.length` identity). `apps/orders/package.json` now declares
`"@force/shared": "*"` (the app's `next.config.js` already had `@force/shared` in
`transpilePackages` and its `tsconfig.json` already had the `@force/shared` path mapping — both were
already wired for this dependency, just unused). Cost if wrong: none identified — the additive
contract is test-enforced and the grouping logic is reused, not reimplemented.

## Scoped re-review fix wave (2026-09-07) — rulings C13–C15

Fixes for `bundles-rereview.md`'s NEW-P1 plus P2-a, P2-b, P2-c, P2-d, P2-e, P2-g, P2-h, P2-i.
P2-f and the pre-existing targeted-coupon divergence are ruled residual/out-of-scope below, not
code changes.

**Ruling C13 — NEW-P1 fixed exactly as the report prescribed; Ruling C3 AMENDED.**
`wa-bridge.routes.ts`'s `customerHistory.lastOrder` emitted `productId: null` for a grouped bundle
row; WBS echoes that verbatim into `/cart/from-wa` on "repeat last order", and `cartFromWaSchema`
(`z.string().uuid().optional()`) rejects `null`, 400ing the ENTIRE repeat-order request — including
the loose lines that had nothing to do with the bundle — and the bot's retry message then loops
forever. Fix: `items` select on the customer-history order query now includes `bundleId: true`, and
the bundle row emits `productId: row.lines[0].bundleId` instead of `null` (`OrderItem.bundleId` is
always written alongside `bundleGroupId` at checkout — `order.service.ts:1113-1114` — so it is never
null for a grouped row). `isBundle: true` stays the discriminator. Round-trip proven in
`tests/unit/contract-wbs-bridge.test.ts` (mutation-checked: reverting to `productId: null` reddens
both the contract-schema assertion and the new `cartFromWaSchema.safeParse` round-trip test).
**This finding falsifies Ruling C3 — CLOSED's reasoning** ("WBS needs zero changes/deploys, since it
already echoes back whatever id `/store-catalog` handed it"): that was true for `/store-catalog`'s
`isBundle` entries (`id: b.id`, always the bundle's own id — verified again here) and false for
`customerHistory.lastOrder`, which handed back `null` where WBS reads an id. Ruling C3 stays CLOSED
— the launch gate stays deleted — but ONLY because this fix restores the property C3 assumed
("every id FWB hands WBS is one FWB can resolve"); had this fix not landed, C3 would need to be
RE-OPENED and the launch gate restored.
Grep swept for every other id-shaped field the wa-bridge routes hand to WBS that gets echoed back
(cross-checked against `whatsapp-bulk-sender/backend/src/services/wa-ordering.js`'s consumption of
`productId`/`categoryId`/`bundleId`/`addressId`): `/store-catalog` product entries (`id: p.id`),
bundle entries (`id: b.id`), category entries (`id: c.id`), and `frequentProducts`
(`productId: item.productId` — the real component product id, sourced straight off `OrderItem`, not
grouped) are all real, non-null, resolvable ids. `addressId` is echoed back but originates from
FWB's own address-creation response, not a nullable snapshot field. `grep -n "Id: null\|id: null"
apps/api/src/routes/wa-bridge.routes.ts` → no matches. NEW-P1's `lastOrder` bundle row was the only
id-shaped field WBS could receive un-resolvable. Cost if wrong: none identified by this sweep: if a
future field is added to this file that hands WBS a snapshot id without also guaranteeing it is a
FWB-resolvable id, it reintroduces this exact class.

**Ruling C14 — P2-f is an ACCEPTED RESIDUAL, not a code change.** `PUT
/stores/:storeId/bundles/:id` without `items` falls back to `existing.items` and re-validates them,
so a legacy bundle whose component product later gained variants 400s
(`VARIANT_REQUIRED`) on a partial update. The admin editor always posts the full body including
`items` (`bundles/page.tsx:340-355`), and `DELETE` (deactivate) never calls `resolveBundleLines` at
all — so this only bites a partial-update API client, none of which exist today. Ship as-is. Cost
if wrong: an API-only integrator cannot deactivate or rename such a bundle without also fixing its
items in the same request.

**Ruling C15 — the pre-existing targeted-coupon divergence is OUT OF SCOPE for this branch.** The
storefront never sends `cartItems` to `/coupons/validate`
(`CheckoutClient.tsx:696`, `CartClient.tsx:218,281`), so a **targeted** coupon (product/category
scope, customer group, `minQuantity`) is quoted against the whole loose subtotal
(`coupon.routes.ts` quote path) but charged against `matchingSubtotal`
(`promotion-targeting.ts:53`, `order.service.ts`) — the same display≠charge shape P0-1 fixed, but
for the untargeted case only. This predates `feat/product-bundles` (`f323d07a` changed only which
number is sent as `orderTotal`, not whether coupon targeting is evaluated at quote time at all) and
fixing it changes the coupon-quote path for every store, bundles or not — out of scope for a bundles
PR. **Tracked as a named follow-up, not a rumour:** file `apps/api/src/routes/coupon.routes.ts`
(quote path) vs. `apps/api/src/lib/promotion-targeting.ts:53` + `order.service.ts` (charge path);
triggering state: a merchant scopes any coupon to a product, category, or customer group. Cost if
wrong: the first merchant who scopes a coupon sees the same silent-overcharge-then-correct-charge
shape P0-1 fixed for the untargeted case.

**P2-a — `minOrderAmount` truthiness guard skipped a bundle-only cart's basis of 0.**
`coupon.routes.ts`: `orderTotal && orderTotal < coupon.minOrderAmount` → `orderTotal != null &&
orderTotal < coupon.minOrderAmount`. A bundle-only cart's `orderTotal` (loose-only basis) is
legitimately `0`, and `0` is falsy — the old guard skipped the `minOrderAmount` check entirely, so
the quote said "applied" and checkout then 400ed with `MIN_ORDER_NOT_MET` with no way to recover
short of clearing the code. Additive-safe: for every non-zero `orderTotal` (every pre-bundles cart,
and every bundle+loose mixed cart with a non-zero loose total), `x != null` and `x` (truthy) agree —
only the `orderTotal === 0` case changes behaviour, and only by now enforcing the same gate a mixed
cart already enforced. Mutation-checked (below).

**P2-b — save-time (`resolveBundleLines`'s comparator sort) had no test that would redden if
deleted.** Added a fractional-remainder-tie test: build a bundle whose components tie on `frac`
(the allocation-order tiebreak), run `POST /bundles` in request order and separately feed the same
components to `resolveBundle` in a reversed row order, and assert `isAllocatable` agrees between the
two surfaces. Mutation-checked: deleting the `orderedItems` sort at the `POST` route reddens it.

**P2-c — the P0-1 client-side coupon-quote-basis guard was a source-text grep, blind to an
arithmetic regression.** Extracted `couponQuoteBasis(items)` into
`apps/web/src/lib/coupon-quote-basis.ts` (pure function: sums `item.price * item.quantity` over
non-bundle items), imported from both `CheckoutClient.tsx` and `CartClient.tsx`, with a real unit
test exercising quantity > 1 and bundle exclusion. Kept one grep-based test asserting both call
sites actually call the shared helper (not a re-implementation). Same treatment applied to the three
`toContain` source-grep assertions in `bundles-nav.test.ts:74-82` — extracted the ShopChrome nav
predicate to a pure, unit-tested helper. Mutation-checked: dropping `* item.quantity` from the
extracted function reddens the arithmetic test; it did NOT redden the old grep.

**P2-d / P2-e — same reasoning as Ruling FW-3: the merchant must SEE the actionable message.**
`pricingValueInRange` moved from a Zod refine to a `422 PRICING_VALUE_OUT_OF_RANGE` `AppError`
beside `assertFixedPriceWithinComponentSum` (renamed `assertPriceWithinComponentSum` by P1-a below), so the range message (not "Invalid request data")
reaches the admin editor. `VARIANT_REQUIRED` and `DUPLICATE_BUNDLE_COMPONENT` now interpolate the
product's `name` (already loaded by `resolveBundleLines`) instead of its raw uuid. Mutation-checked:
reverting either to the old Zod-refine / uuid-interpolation shape reddens its named test.

**P2-g — `ItemsCard`'s header count stayed in component lines after P1-2 fixed the "+N more"
button.** `t('itemCount', { count: items.length })` → `t('itemCount', { count: totalRows })`, so the
header and the "View all (N)" button agree. Mutation-checked: reverting to `items.length` reddens
the header-count test added alongside P1-2's existing `previewRows` test.

**P2-h — documentation-parity, already resolved before this wave.** The ledger's "NOT FIXED —
`apps/orders` renders bundle orders as unlabelled component lines" entry (above) already carries its
"FIXED (2026-09-07)" correction, landed in `df495d92` before this re-review ran. No further ledger
change needed; confirmed by re-reading the entry and grepping the repo for any other place asserting
the stale "not fixed" claim (none found).

**P2-i — MCP `view_cart` bundle-shape note, confirmed intentional.** `cart.tools.ts` emitting
`bundles: []` for every store (including feature-off ones) is additive and harmless — it is an
AI-agent JSON surface with one caller, not a customer-facing byte-identity claim. Recorded here so
the PR description's "byte-identical for feature-off" language is read as approximate on this one
surface, not violated. No code change.

Unit suite before this wave: 218 files / 2484 tests, all green (per `bundles-rereview.md`).

---

## P1 (2026-09-07) — the `fixed` pricing type, and the zero price it could reach

**RULING P1-a — the third `BundlePricingType` member gets a save-time ceiling of its own, one fil
stricter than `fixed_price`'s.** `assertPricingValueInRange` guarded only `percentage` and
`assertFixedPriceWithinComponentSum` guarded only `fixed_price`; `fixed` (fils OFF the component
sum) was guarded by neither, so `POST { pricingType: 'fixed', pricingValue: 20000 }` against a
14.500 kit was accepted while the semantically identical `fixed_price: 15000` was correctly
rejected `422 PRICE_ABOVE_COMPONENT_SUM` — `computeBundlePrice`'s `Math.max(0, …)` clamp quietly
turned it into a free box. Both guards are now exhaustive switches over the enum with a `never`
default (a fourth member is a compile error, not another silent gap), and the renamed
`assertPriceWithinComponentSum` rejects `fixed` at `pricingValue >= componentSum`, not `>`: for
`fixed_price` the value IS the price, so `value === componentSum` is a real zero-discount price,
but for `fixed` the value is subtracted, so `value === componentSum` leaves nothing. Cost if
wrong: a merchant who genuinely wants a 100%-off amount-off discount must express it as a price
instead (`fixed_price: 0` over free components) — the save is refused with a message naming the
ceiling, never silently overridden.

**RULING P1-b — a 0 price with a non-zero componentSum stops the sale at READ time, for every
pricing type.** Save-time validation cannot cover the realistic case: `resolveBundle` recomputes
`componentSum` from CURRENT prices on every read, so a `fixed` discount that was legitimate when
saved becomes a 100%-off discount the moment a sale, bulk edit or CSV import drops the components
below it — no merchant error required. Nothing downstream catches it (`isPurchasable` never looked
at price; the money-invariant guard passes because `allocateBundlePrice(lines, 0)` is all zeros and
`0 === resolved.price`), so the box would ship, stock-decrementing, for nothing. The fix is one
clause — `price > 0 || componentSum === 0` — inside `isPurchasable`, the single predicate that
already governs the public list, `CartService.addBundle`, the checkout recheck and
`listPurchasableBundles` (AI feed + WBS bridge). `componentSum === 0` is the one honest zero: a kit
of free items really is worth 0. Cost if wrong: a bundle that resolves to 0 over paid components
stops selling everywhere at once and shows "(not purchasable)" in the admin list, instead of
selling for nothing.

**ACCEPTED RESIDUAL (P1-b) — `fixed_price: 0` and `percentage: 10000` over PAID components still
SAVE, and now never sell.** Both are legal values the save path deliberately still accepts (a price
equal to or below componentSum; basis points up to 10000), so refusing them at save time would
change behaviour for bundles that save cleanly today — which this task is explicitly not allowed to
do. Rather than leave the divergence silent, the admin editor now warns before submit
(`zeroPriceWillNotSell`, bilingual) whenever the previewed price is 0 while the components are not
free, and the bundle list already carries its "(not purchasable)" chip for one saved earlier. Cost
if wrong: a merchant who insists on giving away paid goods as a bundle has to price the components
at 0 to do it, and is told so in the editor rather than discovering it from an empty storefront.

**Bilingual copy.** No new API string is localised — every `AppError` message in `apps/api` is
English, and this task did not change that — but the admin editor now renders
`PRICE_ABOVE_COMPONENT_SUM` from EN+AR i18n keys (`discountAboveComponentSum` /
`priceAboveComponentSum`, chosen by the pricing type being edited, interpolating the SERVER's
`details.componentSum`), so the one merchant-facing save error this task can reach is no longer
English-only in the Arabic admin.

**CI — `apps/orders` was an orphan test directory.** `apps/orders/src/app/orders/[orderId]/
_components/ItemsCard.test.ts` (bundle-box grouping for fulfilment) was collected by vitest and run
by no CI job glob — the `orphan-tests` job's first real catch. Added to the Unit Tests glob AND to
that job's hand-copied covered-tests list. Verified locally by running the job's own diff: 308
discovered, 308 covered, 0 orphans (it was 307/306/1 before).

Unit suite after this wave: 220 files / 2516 tests.
