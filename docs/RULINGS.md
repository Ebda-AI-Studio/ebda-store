# Rulings ledger — force-website-builder

Decisions that override a plan, reject a finding, or accept a residual, written
at decision time. Form: `Ruling <id> — <decision>. <evidence>. Cost if wrong: <one sentence>.`

A declined finding gets the same rigour as a fix. A finding that stops being
mentioned reads as fixed, so it is recorded here instead.

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
