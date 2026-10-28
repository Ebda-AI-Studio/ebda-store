# LEDGER-2026-09-25-fix-p2-r2-o2-batch

> Section: 2026-09-25 (fix/p2-r2-o2 batch)

Ruling LEDGER-2026-09-25-fix-p2-r2-o2-batch — unlabelled notes from the legacy ledger section "2026-09-25 (fix/p2-r2-o2 batch)":

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
`https://store.ebda.app/.well-known/security.txt` → `200`,
`strict-transport-security` + `x-content-type-options: nosniff` present;
same for `store.ebda.app` and `orders.ebda.app`. The dot-prefixed
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
`curl -sI https://store.ebda.app/.well-known/acp.json` and `/ucp` both
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
