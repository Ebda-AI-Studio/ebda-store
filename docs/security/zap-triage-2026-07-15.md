# ZAP Baseline Triage — first activated run (2026-07-15)

Run 29426193025 vs `https://store.force-ai.co`: **0 FAIL / 15 WARN-NEW / 54 PASS.**
Every warning triaged below — fixed in this PR or accepted with reasoning. Companion to `docs/security/security-overview.md`
(evidence log) and `docs/security/csp-hardening-plan.md` (the standing
`unsafe-inline`/`unsafe-eval` debt — NOT re-triaged here).

## Fixed in this PR

| ZAP id | Warning                                           | Fix                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10037  | `X-Powered-By: Next.js` leak (×5)                 | `poweredByHeader: false` in web + admin + orders next.config.js                                                                                                                                                                                                                                                                                                                         |
| 10055  | CSP directives with no default-src fallback (×10) | `base-uri 'self'; object-src 'none'; form-action 'self'` added to all 3 apps' CSP (checkout reaches gateways via `window.location` redirects, never form POSTs — `form-action 'self'` verified safe). **This fixed variant is pinned by `tests/unit/csp-directive-floor.test.ts`; a SEPARATE 10055 variant (`unsafe-inline`/`unsafe-eval`) was suppressed later — see Accepted below.** |
| 10011  | Cookie without Secure flag (×5)                   | All 4 client-side `document.cookie` writers (language, consent, affiliate ×2) now append `Secure` on https (conditional so Safari localhost dev keeps working); API auth cookies were already `Secure; SameSite=None`                                                                                                                                                                   |

## Fixed via Workers asset-layer `_headers` (also this PR)

| ZAP id                | Warning                                                                | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10035 / 10021 / 10063 | HSTS / X-Content-Type-Options / Permissions-Policy "missing" (×5 each) | Only on **Workers-asset-layer responses** (favicon, security.txt, static files) — HTML routes have sent all of these all along via next.config `headers()`, which the asset layer bypasses. Fixed in-repo: `public/_headers` (Workers Static Assets convention) adds HSTS + `X-Content-Type-Options: nosniff` to asset responses in all 3 apps. Permissions-Policy is meaningless on static assets — not added. A zone-level Transform Rule would be belt-and-suspenders but the CF API token lacks rulesets scope (see below). |

## Accepted (documented, no action)

> **Updated 2026-09-11.** "No action" used to mean "still fires every night".
> `cmd_options` dropped `-I` ("do not return failure on warning") on that date,
> so an unsuppressed WARN now FAILS the nightly job — which would have made
> every one of the nine rows below a nightly red build and a Telegram alert.
> All nine are therefore now suppressed in **`.zap/rules.tsv`**, which is the
> live accepted-set: this table is the reasoning, that file is the mechanism.
> Each carries a `review-by:` date, and `scripts/check-zap-review-dates.mjs`
> fails the nightly job once one lapses.
>
> **Updated 2026-09-25.** Five more rows were added to `.zap/rules.tsv` over
> time but never carried over to this table: 10096 and 10027 (suppressed
> before 2026-09-11), and 10055 (a SEPARATE variant from the one fixed above),
> 10038 and 10202 (added 2026-09-11 alongside the nine above). Added below so
> this table stays the reasoning half of every id `.zap/rules.tsv` IGNOREs,
> not just the original nine.

| ZAP id | Warning                                               | Reasoning                                                                                                                                                                                                                                                                                                                       |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10031  | User-controllable HTML attribute — potential XSS (×1) | PLAUSIBLE-only: React escapes attribute interpolation and every API edge is Zod-validated; the flagged case is a reflected query param in a React-rendered attribute. Standing browser-attack-surface audit (2026-06-21) covers this class. Re-check if a future scan upgrades it to FAIL.                                      |
| 10110  | Dangerous JS functions (×1)                           | `eval` inside a bundled third-party SDK — the same dependency behind the CSP `unsafe-eval` debt tracked in `csp-hardening-plan.md`. Fixing the plan fixes this.                                                                                                                                                                 |
| 90003  | Subresource Integrity missing (×5)                    | The external scripts are marketing-pixel/OneSignal SDK loaders that self-update — pinning SRI hashes would break them on every vendor release. Risk bounded by the fixed CSP script-src allowlist.                                                                                                                              |
| 90004  | COEP missing (×9)                                     | Enabling `require-corp` breaks cross-origin images/pixels storefront-wide; no SharedArrayBuffer use → no benefit.                                                                                                                                                                                                               |
| 90005  | Sec-Fetch-Dest missing (×8)                           | Request-side header set by browsers, not servers — ZAP noise on non-browser requests.                                                                                                                                                                                                                                           |
| 10015  | Re-examine Cache-Control (×3)                         | Advisory on intentionally-cached public pages; caching policy is deliberate (edge-cache + tag invalidation, Lens N).                                                                                                                                                                                                            |
| 10049  | Non-storable content (×9)                             | Advisory (responses marked non-cacheable are auth-adjacent — correct).                                                                                                                                                                                                                                                          |
| 10094  | Base64 disclosure (×12)                               | Next.js inline RSC/flight payloads — not secrets; gitleaks + client-secret-scan gate real leakage.                                                                                                                                                                                                                              |
| 10112  | Session-management response identified (×7)           | Informational fingerprint of the auth flow, not a defect.                                                                                                                                                                                                                                                                       |
| 10055  | CSP `unsafe-inline`/`unsafe-eval` (×varies)           | Next.js App Router requires them today; needs the nonce work in `csp-hardening-plan.md`. Distinct from the default-src-fallback 10055 fixed above — `tests/unit/csp-directive-floor.test.ts` guards that fix so this suppression cannot silently mask a regression of it. Comes off `.zap/rules.tsv` when the nonce work lands. |
| 10038  | CSP header not set                                    | Fires on the apex `307` redirect, which carries no body to apply a CSP to; every `200` response carries a CSP (verified against production 2026-09-11).                                                                                                                                                                         |
| 10202  | Anti-CSRF tokens                                      | ZAP looks for a hidden form-field token; the app uses a double-submit cookie + `X-CSRF-Token` header instead (see the CSRF middleware tests). Hides any future form-post surface that genuinely lacks a token — see `.zap/rules.tsv`'s own note on the cost of a global IGNORE.                                                 |
| 10096  | Timestamp disclosure                                  | Noisy, not a real risk here (suppressed before 2026-09-11).                                                                                                                                                                                                                                                                     |
| 10027  | Information disclosure — suspicious comments          | False positives in minified JS (suppressed before 2026-09-11).                                                                                                                                                                                                                                                                  |

## Cloudflare zone transform (NOT applied — token scope)

A zone-level response-header Transform Rule (HSTS + nosniff on every
force-ai.co response) would also cover tenant custom domains' asset responses,
but the stored CF API token (`~/.config/forceai/cf-api-token`) returns
`Authentication error` on `/rulesets` and `/managed_headers` — it lacks the
Transform Rules permission. Unblock: add `Zone → Transform Rules → Edit` to the
token (or apply the rule once in the dashboard). The in-repo `_headers` fix
above covers the platform hosts regardless.

## Cadence

Nightly ZAP runs continue (self-hosted, action v0.15.0 — the v0.12 artifact-API
failure is fixed). Append material changes in warning counts to the evidence log
in `security-overview.md`.
