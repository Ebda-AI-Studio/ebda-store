# Adversarial audit — dimension: injection-render (untrusted input → dangerous sink)

Attacker model: a hostile but authenticated **merchant/store_admin** (semi-trusted; can author
theme config, page/CMS content, shipping-carrier credentials, and marketing pixels), plus a hostile
**customer** (review bodies, guest checkout names) whose payload lands in another party's browser.
Signature risk for a website builder = stored XSS + server-side SSRF from merchant-authored config.

> **Status note (2026-09-02, #1166):** see the "Remediation status" table in
> `docs/audits/2026-09-02-adversarial-audit.md` for the authoritative per-finding fixed/open state.

---

### [P1] Merchant-controlled `credentials.baseUrl` on the iCarry carrier → server-side SSRF (blind + semi-reflected)

- **Where:** `apps/api/src/services/carriers/icarry.carrier.ts:53-54` (`resolveBaseUrl`), reached from `:61 createShipment`, `:151 trackShipment`, `:254 testConnection`. Write path: `apps/api/src/routes/shipping-carrier.routes.ts:15-20` (`carrierConfigSchema.credentials = z.record(z.string(), z.string())` — NO URL/scheme validation) → `apps/api/src/services/shipping-carrier.service.ts:96` upsert. Trigger route: `POST /:storeId/shipping-carriers/test/:carrier` → `shipping-carrier.service.ts:210 testConnection` → `carrierImpl.testConnection(config.credentials)`.
- **Attack — SUMMARY, reproduction trimmed 2026-09-02 (P1, still open; see `docs/audits/2026-09-02-adversarial-audit.md` P1-1 for current fix status):** any store_admin can set an internal/link-local target as their iCarry carrier's `baseUrl` (the UI never exposes this field, but the underlying config schema accepts any key) and trigger a test/shipment/tracking call, causing the API to fetch that attacker-chosen host from Railway's egress with a status/body oracle in the response. The exact request bodies and target are recoverable from the fix commit once P1-1 lands (routing `resolveBaseUrl`'s result through `assertPublicHttpUrl()`).
- **Damage:** Server-side request forgery from inside Railway's network to any host/port the API can reach — cloud metadata (`169.254.169.254`), `*.railway.internal` service discovery, the internal Redis (`config.redisUrl`), the Neon endpoint, or an external attacker collaborator to confirm egress. Semi-reflected: `testConnection` returns `HTTP <status>: <json.message>` (`icarry.carrier.ts:268`) and `{success:true}` on any 2xx, giving status/body oracle + timing for a blind sweep. `createShipment`/`trackShipment` fire the same fetch on real order events, so it also runs unattended.
- **Evidence:** `icarry.carrier.ts:53` `function resolveBaseUrl(credentials){ return credentials.baseUrl?.replace(/\/$/, '') || ICARRY_BASE_URL; }` — the merchant string is used **verbatim** as the fetch base, never routed through `lib/safe-fetch.ts` (which blocks RFC1918/CGNAT/loopback/link-local). `shipping-carrier.routes.ts:18` `credentials: z.record(z.string(), z.string())`.
- **Why prior audits missed it:** `docs/audits/2026-07-31-vibecoded-security-holes.md` §09 "SSRF — PASS": _"Remaining outbound calls use server-controlled URLs."_ False — the carrier baseUrl is merchant input. `docs/audits/2026-08-31-reel-derived-lenses.md` GAP-1 calls SSRF a _latent_ gap: _"the other ~43 fetch() calls target provider endpoints from config, not user input… nothing stops the NEXT fetch(userSuppliedUrl)."_ This is that next one, and it was already live (carrier added 2026-03-18, before the guard). The `apps/api/eslint.config.mjs` SSRF rule is scoped to `routes/**` **on purpose**, so a fetch in `services/carriers/**` is invisible to it.
- **Blast radius:** Only iCarry has an override (`aramex.carrier.ts:16` uses a hardcoded const — clean). Same defect class = any service that fetches a value pulled from `credentials`/`settings` JSON without `assertPublicHttpUrl`. The ESLint SSRF selector does not cover `services/**`, so this class is structurally unguarded.
- **Fix:** Drop `baseUrl` from `ICarryCredentials` (or gate it behind super_admin only), OR run `resolveBaseUrl`'s result through `assertPublicHttpUrl()` before every carrier fetch, and extend the ESLint non-literal-`fetch` rule to `services/carriers/**` (and services generally).

---

### [P3] Storefront CSP is decorative for XSS — `script-src 'unsafe-inline' 'unsafe-eval'`

- **Where:** `apps/web/next.config.js:125` (web storefront), `apps/admin/next.config.js:144`, `apps/orders/next.config.js:81`.
- **Attack/Damage:** No injection sink currently reaches the storefront DOM (see UPHELD), so this is not directly exploitable. But every storefront defense against stored XSS rests **entirely** on output-escaping correctness: the CSP would not stop an inline-handler/`<script>` breakout if any one escaper regressed. `'unsafe-eval'` is present too. The product is a builder that renders merchant + customer text into `<script type=ld+json>`, `<style>`, and many `<a href>` — a single missed escape is full stored XSS with no CSP backstop.
- **Why prior audits missed it:** the security-surface audits treat "CSP present" as PASS without grading the directive values. `'unsafe-inline'` makes script-src a no-op for injected inline script.
- **Blast radius:** all three Next apps. `apps/api/src/index.ts:154` also carries `styleSrc 'unsafe-inline'` (API serves JSON, lower impact).
- **Fix:** Move the inline theme/JSON-LD scripts to nonces and drop `'unsafe-inline'` from script-src on the storefront; `'unsafe-eval'` is only needed by the OpenNext page SDK — pin it to the exact chunk or remove if the runtime allows.

---

### [P3] Newsletter HTML sanitizer is a hand-rolled regex allowlist (bypass-prone)

- **Where:** `apps/api/src/lib/email-html-sanitizer.ts:133 sanitizeNewsletterHtml`, consumed at `apps/api/src/routes/newsletter.routes.ts:270`.
- **Attack/Damage:** Regex element-stripping (`<script>…</script>` non-recursive, single pass) is defeatable by nesting/mutation (`<scr<script>ipt>`), and the output is broadcast to every subscriber. BUT the sanitized HTML is only ever sent to **email** via Resend (`newsletter.routes.ts:283`) — it is not rendered in any admin/storefront DOM (admin newsletter page has no `dangerouslySetInnerHTML`). Mail clients strip active content, so real-world impact is sender-reputation / phishing-relay, which the file's own comment already accepts as the tradeoff. Kept as P3, not a browser-XSS finding.
- **Fix:** If a runtime DOM sanitizer is ever added (or this HTML is ever shown in-app), replace with `isomorphic-dompurify`. Until then, document the residual at the call site.

---

### FALSIFIED

- **`2026-07-31-vibecoded-security-holes.md` §09 "SSRF via user-supplied URL — PASS"** and **`2026-08-31-reel-derived-lenses.md` GAP-1 "latent, not a live hole."** Counter-evidence: `icarry.carrier.ts:53-54` fetches a **merchant-supplied** `credentials.baseUrl` from three call sites, none via `safe-fetch`. Live SSRF, authenticated-merchant precondition only. GAP-1's own reassessment note ("verify whether still open… given what the fetcher can reach") resolves to: open, and higher than Medium because the fetcher sits on Railway's internal network.

### UPHELD (attacked hardest, could not break)

1. **JSON-LD stored-XSS breakout** (`apps/web/src/lib/json-ld-script.ts`). Product names, FAQ, and customer review bodies flow into `<script type=ld+json>`, and CSP has `'unsafe-inline'`. Tried `</script>`-breakout via a review body — killed: `jsonLdScriptContent` escapes `<`,`>`,`&`,U+2028,U+2029 to `\uXXXX` after `JSON.stringify`. Every JSON-LD emitter (`JsonLd.tsx`, `layout.tsx:441`, `blog/[slug]/BlogPostBody.tsx:123`) routes through it. This was H-1 in the 2026-07-31 audit and is correctly fixed.
2. **CMS page + theme/typography CSS injection.** CMS pages are never stored as HTML — `pages.service.ts` re-renders `contentBlocks` through `renderBlocksToHtml` (escapes `&<>"'`, `safeUrl` allowlists scheme) on every fetch; the storefront's `CmsPageContent.tsx:181` only ever receives that server-rendered string. Theme/font values (`emit-zone-css.ts:39`, `theme-css.ts:21`) are interpolated into `<style>` but `sanitizeFontValue`/`sanitizeThemeColor` block `{`,`}`,`<`,`>`,`url(`,`@import`,`expression(`,`javascript:` — cannot break out of the rule block or the `<style>` tag, and `url()`-based CSS exfil is blocked. `token:` keys are `^[a-zA-Z][a-zA-Z0-9-]{0,32}$`.
3. **Merchant `<a href>` surfaces + R2 uploads.** Every merchant-authored link (nav/footer/utility bar in `ShopChrome.tsx`, hero/announcement CTA across all 5 themes, floating widget, social links via `store.routes.ts safeOptionalUrl`) passes `sanitizeUrl`/`isSafeUrl` (`packages/shared/src/utils/safe-url.ts`) which rejects `javascript:`/`data:`. R2 uploads are content-type-allowlisted to images (SVG excluded), keys are `stores/<id>/<folder>/<uuid>-<safeName>` with folder/name sanitized, and public assets are served from `*.r2.dev` — a separate origin that cannot script the storefront. AI has no tool/function-calling surface; AI output lands in escaped JSON-LD or plain-text fields.

### BLIND SPOTS (need a live probe to settle)

- **P1 SSRF reach:** static analysis proves the outbound fetch fires to an attacker-chosen host; it cannot prove what Railway's internal network exposes. Settle with: from a test store, `PUT` an icarry `baseUrl` of a burn URL (confirm egress via request log), then `http://<redis-internal-host>:6379/` and `169.254.169.254` and read `testConnection`'s returned status/message + latency.
- Whether Railway's platform blocks link-local `169.254.169.254` at the network layer (would downgrade metadata theft but not internal-service SSRF). A `curl` from a Railway shell settles it.
- CSP is authored in `next.config.js`; the value actually emitted by the OpenNext/Workers layer at the edge should be confirmed with `curl -sI https://<storefront>` in case a Worker rewrites it.
