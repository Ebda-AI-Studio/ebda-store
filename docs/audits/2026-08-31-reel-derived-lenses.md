# Reel-derived lens audit — 2026-08-31

Source: 21 Instagram reels (@-MM, `#vibecoding #aidirectedengineering`) on builder/SaaS
production failure modes. Each reel asserts one concrete failure and its fix; each was
turned into a checkable lens and run against `force-website-builder`.

Method: distilled each reel to its claim, expressed the claim as a grep-able / config
check, ran it, then **verified every hit by reading the code** before recording it.
Counts alone are not findings — two candidate findings below were discarded on
inspection, and that is the point of the second pass.

## Result

**17 of 21 lenses are code-auditable against FWB. 14 pass. 3 real gaps. 4 are OS/process
or business lenses that do not apply to a repo.**

FWB scoring well here is expected rather than surprising — most of these lenses cover
ground the existing audit fleet already walks. The value is in the 3 that were not
covered, and in registering all 21 so they re-run against the other repos.

| #   | Reel          | Lens                                              | Verdict                                                                                                                                                                                                                                        |
| --- | ------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | `Dct1A_WDsrP` | Third-party scripts run with your privileges; CSP | **PASS** — helmet CSP `apps/api/src/index.ts:151`, header at `middleware/security.ts:669`; zero external `<script src>` in app code                                                                                                            |
| L3  | `DcrQPBHG0_I` | Admin routes without auth / guessable path        | **PASS** — every route file lacking `authenticate` carries its own gate: `alert-webhooks` (token), `cart` (guest + CSRF), `mcp` (slug-resolve 404 + fail-closed feature gate), `public-store-layout` (public read), `webhook` (HMAC signature) |
| L4  | `DcqspRtHPGB` | Missing indexes / full table scans                | **PASS** — 269 `@@index`, 59 `@@unique`                                                                                                                                                                                                        |
| L5  | `DcoreqwDW0N` | Same AI builds and reviews its own work           | **GAP-2** (Medium)                                                                                                                                                                                                                             |
| L7  | `DcmGq_pDYk8` | Prompt injection → unscoped data access           | **PASS** — all 6 MCP tool files scope by `storeId`; agent surface is feature-gated fail-closed                                                                                                                                                 |
| L9  | `Dcg9G7PjY6E` | Malicious dependency exfiltrating env             | **PASS** — `npm ci` + `npm audit` gate, trufflehog + gitleaks in CI                                                                                                                                                                            |
| L10 | `DcgZbSGgZ9z` | CORS `*` with credentials                         | **PASS** — no wildcard origin; platform-origin allowlist gate in `middleware/security.ts`, custom merchant domains resolved per-request                                                                                                        |
| L11 | `DceYRVpCFKG` | SSRF via server-side fetch of user URLs           | **GAP-1** (Medium)                                                                                                                                                                                                                             |
| L13 | `DcbzcfyioD9` | Unverified webhook signatures / replay            | **PASS** — signature verification on payment providers, idempotency throughout, webhook inbox with replay                                                                                                                                      |
| L15 | `DcYrFHSAOhJ` | No API versioning / deprecation policy            | **GAP-3** (Low)                                                                                                                                                                                                                                |
| L16 | `DcWGRX2G2l8` | Per-client column degrades every tenant           | **PASS** — 324 `storeId` columns, 233 RLS policy statements                                                                                                                                                                                    |
| L18 | `DcRgRM2jjuv` | Rate limiting / WAF unconfigured                  | **PASS** — 67 limiter usages incl. a dedicated auth limiter (5/15min/IP+email)                                                                                                                                                                 |
| L19 | `DcQ8u02Cj1A` | Per-client repo forks                             | **PASS** — single codebase, tenant config in `StoreTheme`; CLAUDE.md forbids per-tenant code                                                                                                                                                   |
| L20 | `DcO7fDEj9eg` | No SLO / error budget / burn-rate alerting        | **PASS** — Sentry wired, alert-failure watch, log drain                                                                                                                                                                                        |
| L21 | `DcOX9AdERD2` | Read-after-write across replicas                  | **PASS** — `DIRECT_URL` split maintained                                                                                                                                                                                                       |
| L6  | `DcoH5avEj3J` | Mobile plaintext API / no cert pinning            | **N/A** — no native mobile app in this repo                                                                                                                                                                                                    |
| L14 | `DcZOrpQCcZW` | Capacitor secrets in localStorage                 | **N/A** — same                                                                                                                                                                                                                                 |

### Not repo lenses

| #   | Reel          | Belongs to                                                                                                           |
| --- | ------------- | -------------------------------------------------------------------------------------------------------------------- |
| L2  | `DctRagnk9uk` | Stale AI skills anchored to dead models → **Whisky AI OS** (see GAP-4)                                               |
| L8  | `Dci-Qq_j9EL` | VPS/SSH hardening → the Umbra CI host, not this repo                                                                 |
| L12 | `Dcd0uMTCHsl` | Market strategy (operator-owned apps vs 22% delivery fees) → business, not code                                      |
| L17 | `DcThgrwlaDD` | Customization debt / productization threshold → business, already encoded in CLAUDE.md's "platform-level fixes" rule |

## The gaps

### GAP-1 (Medium) — `safeFetchImage` exists but nothing enforces its use

`apps/api/src/lib/safe-fetch.ts` is a real SSRF guard: it blocks RFC1918, CGNAT,
loopback, and link-local — including `169.254.169.254`, the cloud metadata address the
reel describes. It is used by exactly **two** call sites (`ai.service.ts:564`,
`product-alt-text-generator.ts:72`), which are the two that currently fetch a
merchant-supplied URL.

Verified _not_ vulnerable today: bulk import stores `imageUrl` strings but never fetches
them server-side, and the schema has no merchant-configurable webhook/callback URL. The
other ~43 `fetch()` calls target provider endpoints from config, not user input.

So this is a **latent** gap, not a live hole: nothing stops the next
`fetch(userSuppliedUrl)` from bypassing the guard, and the failure would be silent.

**Fix:** an ESLint rule (or CI grep) that flags `fetch(` on a non-literal URL outside
`safe-fetch.ts`, with an allowlist for the known provider clients.

### GAP-2 (Medium) — the same vendor builds and reviews

CI runs "AI Review" (Claude PR review) and "Blast-radius scoped audit (Opus)". Both are
Claude. This session is a live example of the reel's claim: I wrote #1099 _and_ the
review that passed it — and the two defects CI caught (a prettier miss and a
`TRUNCATE` revival) were mine.

**Fix:** this is a process decision, not a code change — see "Needs your call".

### GAP-3 (Low) — no deprecation policy on a versioned API

`/api/v1` is used consistently, but there are only 4 incidental `sunset|deprecat`
references and no `Sunset` / `Deprecation` response headers. With merchant integrations
and the WBS bridge consuming this API, there is no mechanism to signal a retiring
endpoint.

**Fix:** a `deprecate()` route helper emitting `Sunset` + `Deprecation` headers, plus a
doc listing deprecated endpoints and their removal dates.

### GAP-4 (Medium, different repo) — stale skills

L2's claim applied to this machine: 19 Google/Gemini skills were installed 2026-08-16
and the install note records no review or disposal step. The reel's framing —
"prescriptions, not assets: apply, verify, dispose" — is the missing half.

**Fix:** belongs in `force-ai-foundation`, not here.

## Lens registration

All 21 lenses are registered in
`docs/audits/lenses/reel-lenses-2026-08.md` so the fleet re-runs them against the other
repos rather than this being a one-shot. A lens used once is a lost lens.
