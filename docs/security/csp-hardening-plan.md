# CSP hardening: removing `script-src 'unsafe-inline'`

Status: **admin and orders DONE 2026-10-26 (SEC-4, `docs/architecture/admin-csp.md`); storefront DONE 2026-10-29 (Ruling CSP-WEB-1, `docs/architecture/storefront-csp.md`)**. The text below is the original scoping (2026-07-11), kept for the reasoning. `'unsafe-inline'` and

Original status line (2026-07-11): `'unsafe-inline'` and
`'unsafe-eval'` remain in `script-src` on all three frontends (2026-10-14: `script-src-attr 'none'` now blocks inline event-handler attributes on `apps/web` and `apps/orders`, Ruling S10-1)
(`apps/web`, `apps/admin`, `apps/orders`) for now. This doc scopes what a
nonce-based migration requires so it can be picked up as its own tracked
piece of work, reviewed and shipped behind a preview deploy — not rushed
into the same pass that pruned the dead Vercel CSP entries.

## Why this wasn't done in the same pass

`'unsafe-inline'` in `script-src` neutralizes CSP's core XSS protection (an
injected `<script>` tag runs exactly like a legitimate one). The correct fix
is nonce- or hash-based CSP with `'strict-dynamic'`. But a naive removal here
would very likely break the storefront in ways that don't show up until
production traffic hits it:

1. **Per-request nonce forces dynamic rendering.** The standard Next.js
   pattern (official docs) is: `middleware.ts` generates a nonce, sets an
   `x-nonce` request header + a per-request `Content-Security-Policy`
   response header via `NextResponse.next({ headers })`, and pages read the
   nonce via `headers()` in a Server Component to pass to `<Script nonce=...>`.
   Calling `headers()` opts a route out of static rendering. `apps/web` is an
   ecommerce storefront where PLP/PDP/homepage pages are exactly the routes
   that most benefit from static/ISR rendering for SEO and TTFB — forcing
   them fully dynamic to thread a nonce is a real regression, not a free
   security win. This needs a `generateStaticParams` + revalidate strategy
   review, not just "add the nonce plumbing."

2. **`next.config.js`'s `headers()` is static, not per-request.** The CSP is
   currently emitted from `async headers()` in each `next.config.js`, which
   Next.js applies as static response headers (baked at build/route level).
   A nonce needs a _fresh value every request_, so the CSP header itself has
   to move from `next.config.js` into `middleware.ts` (or be merged there),
   which changes where the canonical CSP definition lives and needs the
   `next.config.js` header entry removed/reconciled so the two don't
   conflict or double-emit.

3. **OpenNext + Cloudflare Workers target.** `apps/web` deploys via a
   _custom_ Worker entry (`apps/web/sentry-worker-entry.ts`, wired through
   `apps/web/wrangler.jsonc`'s `main`) that wraps the OpenNext-generated
   fetch handler with `@sentry/cloudflare`. Next.js middleware itself runs
   fine under OpenNext-on-Workers, but the nonce has to survive: Worker
   fetch → OpenNext's Next request handling → middleware → RSC render →
   HTML streamed to the client, all on the Workers runtime (no Node
   `crypto.randomBytes`; must use Web Crypto `crypto.getRandomValues`, which
   is fine on Workers but is a real code-path check, not an assumption).
   Any nonce middleware change needs a build + a Cloudflare preview deploy
   to verify end-to-end, not just a local `next build`.

4. **Third-party marketing pixels self-inject non-nonce'd scripts.**
   `apps/web/src/components/MarketingPixels.tsx` loads Meta Pixel, TikTok
   Pixel, Snapchat, Twitter/X, and Pinterest via `next/script`. Every one of
   these vendor snippets, once loaded, injects _additional_ `<script>` tags
   at runtime (their own loader creates more script elements dynamically to
   pull SDK chunks) — those injected scripts do **not** carry our nonce and
   are not hash-precomputable (their content includes timestamps / dynamic
   IDs). `'strict-dynamic'` is designed for exactly this ("a nonce'd script
   can load further scripts"), but each vendor's specific injection pattern
   needs to be verified against `'strict-dynamic'` semantics one at a time —
   assuming it "just works" is how a nonce migration silently breaks pixel
   tracking (a revenue-attribution regression, not just a console error).

5. **OneSignal SDK genuinely needs `'unsafe-eval'`.** The `next.config.js`
   comment (`apps/web/next.config.js` line ~114) cites OneSignal's own docs
   (https://documentation.onesignal.com/docs/web-push-csp) as requiring
   `'unsafe-eval'` for the v16 page SDK's runtime checks. This is **not**
   something to remove — any nonce migration keeps `'unsafe-eval'` in
   `script-src` regardless (nonces address `'unsafe-inline'`, not
   `'unsafe-eval'`). Confirmed still accurate as of this pass; re-verify
   against OneSignal's current docs before shipping in case the SDK dropped
   the requirement in a later version.

6. **7 call sites use `next/script` or `dangerouslySetInnerHTML`** across
   `apps/web`, each needing individual nonce-threading or a hash allowlist:
   `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/blog/[slug]/page.tsx`,
   `src/app/blog/[slug]/BlogPostClient.tsx`, `src/components/CmsPageContent.tsx`,
   `src/components/JsonLd.tsx`, `src/components/MarketingPixels.tsx`.
   `JsonLd.tsx` is the simplest case (server-rendered JSON.stringify output,
   no user input, could plausibly move to a `<script type="application/json">`
   - client hydration pattern instead of needing a nonce at all). The
     `CmsPageContent.tsx` renderer needs a closer look — if it renders any
     merchant-authored HTML/CSS, that's a second, unrelated XSS surface that
     should be checked before this migration and not conflated with it.

## What a staged rollout would look like

1. **Spike branch, not `main`.** Implement nonce middleware + `<Script
nonce>` threading on `apps/web` only (highest-traffic, most SEO-sensitive
   app) behind a Cloudflare Workers _preview_ deploy (`ebda-web`
   already exists for this) — never against the production custom domain
   first.
2. **Static rendering audit first.** Before touching CSP, map which
   `apps/web` routes are currently static/ISR vs already dynamic
   (`export const dynamic = 'force-dynamic'` etc.). Nonce-reading routes
   that were previously static need a deliberate ISR/ppr strategy decision,
   not an accidental full-dynamic regression. Next.js 16's Partial
   Prerendering (PPR) may let static shell + dynamic nonce-bearing scripts
   coexist — worth evaluating given this repo is already on Next 16.
3. **Nonce plumbing**: `middleware.ts` generates a per-request nonce via Web
   Crypto (`crypto.randomUUID()` or `getRandomValues`), sets `x-nonce`
   request header, and emits the CSP response header with
   `script-src 'self' 'nonce-<value>' 'strict-dynamic' 'unsafe-eval' ...`
   (drop `'unsafe-inline'` — modern browsers ignore it once a nonce is
   present, older ones fall back to it, so it's actually safe/recommended to
   leave `'unsafe-inline'` in the string as a legacy-browser fallback per the
   CSP2 spec's own "nonce/hash makes browsers that understand them ignore
   `unsafe-inline`" behavior — confirm this nuance before removing it
   outright, since leaving it changes nothing for CSP-nonce-aware browsers
   but keeps ancient UA support).
4. **Remove the static CSP header entry from `apps/web/next.config.js`**
   once the middleware emits it, so there's a single source of truth (two
   competing CSP headers on the same response is undefined-behavior-prone —
   browsers use the most restrictive, which can mask bugs during rollout).
5. **Thread the nonce** through every `next/script` call site listed above
   (`nonce={nonce}` prop — Next.js's `<Script>` component supports this
   natively) and through any raw `<script>` (`JsonLd.tsx`).
6. **Verify each pixel individually** on the preview deploy: open real
   dev-tools CSP violation reports (`report-to`/`report-uri` directive is
   worth adding during the spike specifically to catch violations without
   guessing) for Meta, TikTok, Snapchat, Twitter, Pinterest, GTM, PostHog,
   Sentry, OneSignal, Cloudflare Insights beacon — confirm zero
   `Refused to execute inline script` / `Refused to load script` console
   errors and confirm pixels actually fire (network tab hit to the vendor's
   collect endpoint) before promoting.
7. **Repeat for `apps/admin` and `apps/orders`** once `apps/web`'s pattern
   is proven — they have fewer third-party scripts (no marketing pixels) so
   should be lower-risk follow-ups, not done first (less signal on whether
   the pattern generalizes to the OpenNext/CF target).
8. **Ship behind Ahmad's live review**, per this repo's standing "2-4
   refinement rounds" UI/infra-change norm — a CSP regression that silently
   kills pixel tracking or SSR rendering on a live merchant storefront is a
   revenue-impacting incident, not a cosmetic bug.

## What NOT to change

- `'unsafe-eval'` stays in `script-src` for `apps/web` and `apps/admin`
  (OneSignal SDK requirement, documented in `next.config.js`) regardless of
  nonce work — nonces don't address `eval`-based execution.
- `apps/orders` currently has no `vercel.live`/`unsafe-eval`-requiring
  script beyond OneSignal + Cloudflare Insights; it's the simplest target
  but still needs its own preview-verified pass, not a copy-paste of the
  `apps/web` middleware without checking its script inventory.

## Reference

- CSP directives live in `apps/web/next.config.js`, `apps/admin/next.config.js`,
  `apps/orders/next.config.js` (`headers()` → `Content-Security-Policy`).
- API-side CSP (`apps/api/src/middleware/security.ts` `securityHeaders()` +
  `apps/api/src/index.ts` helmet config) is unrelated to this doc — the API
  serves JSON only, its CSP is already `default-src 'none'` with no inline
  script surface, and needs no nonce work.
