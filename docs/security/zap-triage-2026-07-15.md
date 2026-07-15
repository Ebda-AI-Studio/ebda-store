# ZAP Baseline Triage — first activated run (2026-07-15)

Run 29426193025 vs `https://store.force-ai.co`: **0 FAIL / 15 WARN-NEW / 54 PASS.**
Every warning triaged below — fixed in this PR or accepted with reasoning. Companion to `docs/security/security-overview.md`
(evidence log) and `docs/security/csp-hardening-plan.md` (the standing
`unsafe-inline`/`unsafe-eval` debt — NOT re-triaged here).

## Fixed in this PR

| ZAP id | Warning                                           | Fix                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10037  | `X-Powered-By: Next.js` leak (×5)                 | `poweredByHeader: false` in web + admin + orders next.config.js                                                                                                                                                       |
| 10055  | CSP directives with no default-src fallback (×10) | `base-uri 'self'; object-src 'none'; form-action 'self'` added to all 3 apps' CSP (checkout reaches gateways via `window.location` redirects, never form POSTs — `form-action 'self'` verified safe)                  |
| 10011  | Cookie without Secure flag (×5)                   | All 4 client-side `document.cookie` writers (language, consent, affiliate ×2) now append `Secure` on https (conditional so Safari localhost dev keeps working); API auth cookies were already `Secure; SameSite=None` |

## Fixed via Workers asset-layer `_headers` (also this PR)

| ZAP id                | Warning                                                                | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10035 / 10021 / 10063 | HSTS / X-Content-Type-Options / Permissions-Policy "missing" (×5 each) | Only on **Workers-asset-layer responses** (favicon, security.txt, static files) — HTML routes have sent all of these all along via next.config `headers()`, which the asset layer bypasses. Fixed in-repo: `public/_headers` (Workers Static Assets convention) adds HSTS + `X-Content-Type-Options: nosniff` to asset responses in all 3 apps. Permissions-Policy is meaningless on static assets — not added. A zone-level Transform Rule would be belt-and-suspenders but the CF API token lacks rulesets scope (see below). |

## Accepted (documented, no action)

| ZAP id | Warning                                               | Reasoning                                                                                                                                                                                                                                                                                  |
| ------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10031  | User-controllable HTML attribute — potential XSS (×1) | PLAUSIBLE-only: React escapes attribute interpolation and every API edge is Zod-validated; the flagged case is a reflected query param in a React-rendered attribute. Standing browser-attack-surface audit (2026-06-21) covers this class. Re-check if a future scan upgrades it to FAIL. |
| 10110  | Dangerous JS functions (×1)                           | `eval` inside a bundled third-party SDK — the same dependency behind the CSP `unsafe-eval` debt tracked in `csp-hardening-plan.md`. Fixing the plan fixes this.                                                                                                                            |
| 90003  | Subresource Integrity missing (×5)                    | The external scripts are marketing-pixel/OneSignal SDK loaders that self-update — pinning SRI hashes would break them on every vendor release. Risk bounded by the fixed CSP script-src allowlist.                                                                                         |
| 90004  | COEP missing (×9)                                     | Enabling `require-corp` breaks cross-origin images/pixels storefront-wide; no SharedArrayBuffer use → no benefit.                                                                                                                                                                          |
| 90005  | Sec-Fetch-Dest missing (×8)                           | Request-side header set by browsers, not servers — ZAP noise on non-browser requests.                                                                                                                                                                                                      |
| 10015  | Re-examine Cache-Control (×3)                         | Advisory on intentionally-cached public pages; caching policy is deliberate (edge-cache + tag invalidation, Lens N).                                                                                                                                                                       |
| 10049  | Non-storable content (×9)                             | Advisory (responses marked non-cacheable are auth-adjacent — correct).                                                                                                                                                                                                                     |
| 10094  | Base64 disclosure (×12)                               | Next.js inline RSC/flight payloads — not secrets; gitleaks + client-secret-scan gate real leakage.                                                                                                                                                                                         |
| 10112  | Session-management response identified (×7)           | Informational fingerprint of the auth flow, not a defect.                                                                                                                                                                                                                                  |

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
