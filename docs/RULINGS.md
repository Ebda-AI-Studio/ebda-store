# Rulings ledger — force-website-builder

Decisions that override a plan, reject a finding, or accept a residual, written
at decision time. Form: `Ruling <id> — <decision>. <evidence>. Cost if wrong: <one sentence>.`

A declined finding gets the same rigour as a fix. A finding that stops being
mentioned reads as fixed, so it is recorded here instead.

---

## 2026-09-25

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

**Ruling EC-8 — the test send and the AI draft run inline in the request.** Both are one external
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
because its durable half moves an amount expression.**

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
`{ error: 'validation_failed', details }`) that their own admin pages read as a
string rather than through `data.error.code`. That is self-consistent, so it is
not the defect this batch is about. It IS a second error envelope on one
platform, and nobody has decided whether the two should converge — so it goes
on the unreviewed list rather than being swept. Changing a shape a page already
reads correctly would be the mirror failure: a gate breaking working code.

The gate's first version made exactly that mistake twice. It reported
`bundle.routes.ts`, whose only match is inside a COMMENT documenting its
deliberate flat body — a file already doing the right thing and explaining why.
It now strips comments before matching.

Cost if wrong: two envelopes remain on the platform, and a new client written
against the object shape will read `undefined` from any of those nine routes.
The registry is what makes that a decision someone takes rather than a surprise
someone debugs — but it does not force the convergence, and until it happens
the answer to "what shape does this API return?" is "it depends which router".

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
