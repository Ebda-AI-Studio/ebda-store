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
