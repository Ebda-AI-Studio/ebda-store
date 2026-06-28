# Cloudflare Everything Migration + `force-ai.co` Rebrand — Master Plan

> Cross-repo plan. Primary home is the FWB repo but it covers **FWB, WBS, CRM, om-hassan-menu, marketing, personal projects**. Reviewed before any DNS/code change (plan-before-code).

**Date:** 2026-06-25
**Owner:** Ahmad Sharaf
**Status:** DRAFT — awaiting review. Not started.

**Goal:** Move every Force AI frontend off **Vercel** onto **Cloudflare** (Workers for the Next.js apps via OpenNext, Pages for static/light projects), rebrand all platform subdomains `forcemediakw.com → force-ai.co`, keep merchant custom domains on Cloudflare-for-SaaS, then **cancel Vercel Pro ($0 Vercel)**. APIs stay on **Railway** (only their custom-domain hostnames move).

**Why:** (1) at-scale Worker serving is cheaper than Vercel functions/bandwidth for the multi-tenant apps; (2) Vercel **Hobby is non-commercial-only** (ToS: commercial = "any deployment for the financial gain of anyone involved, incl. the paid consultant writing the code" + payment processing/ads → suspension-without-notice), so the light client projects can't legally sit on Vercel free — **Cloudflare Pages free explicitly allows commercial use**, so all-CF achieves $0 hosting _without_ the ToS risk and drops the Pro bill.

---

## 1. Final-state architecture

| Project           | App                        | New host                                      | Domain                                                                                        |
| ----------------- | -------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| FWB               | storefront (`apps/web`)    | **CF Workers** (OpenNext)                     | `store.force-ai.co` + merchant domains via **CF-for-SaaS** (`cf.force-ai.co` fallback origin) |
| FWB               | admin (`apps/admin`)       | **CF Workers** (OpenNext)                     | `admin.force-ai.co`                                                                           |
| FWB               | orders PWA (`apps/orders`) | **CF Workers** (OpenNext)                     | `orders.force-ai.co`                                                                          |
| FWB               | API (`apps/api`)           | **Railway** (unchanged)                       | `api.force-ai.co` (new custom domain)                                                         |
| WBS               | frontend                   | **CF** (Workers if Next/OpenNext, else Pages) | `whatsapp.force-ai.co`                                                                        |
| WBS               | API                        | **Railway** (unchanged)                       | `whatsapp-api.force-ai.co`                                                                    |
| Force Media CRM   | app                        | **CF Pages**                                  | `crm.forcemediakw.com` (domain **STAYS** — client-owned; only hosting moves)                  |
| om-hassan-menu    | app                        | **CF Pages**                                  | (its current domain)                                                                          |
| marketing         | site                       | **CF Pages**                                  | `forcemediakw.com` / `www` **OR** `force-ai.co` — **OPEN**                                    |
| personal projects | —                          | **CF Pages**                                  | —                                                                                             |

**Subdomain scheme on `force-ai.co`:** `admin` / `store` / `orders` / `api` (FWB) · `whatsapp` / `whatsapp-api` (WBS) · `cf` (CF-for-SaaS fallback origin). CRM excluded (stays on forcemediakw.com).

---

## 2. Principles (apply to every phase)

1. **Zero-downtime.** Stand the new CF deployment up and verify it on a `*.pages.dev` / `*.workers.dev` URL (or a temp subdomain) **before** flipping the real DNS. Old Vercel deploy stays live until the new one is proven.
2. **One app at a time.** Verify fully, then move the next. Never cut two critical apps in the same window.
3. **Reversible per app.** Rollback = repoint the DNS record back to the Vercel target. Keep the Vercel project + domain alias until the soak period ends.
4. **Cancel Vercel LAST.** Only after every frontend is on CF and a 1–2 week soak with 301s in place.
5. **Verify CF specifics against current docs** (they change): OpenNext Next 16 support, CF Pages custom-domain-on-external-DNS cert issuance, wrangler compatibility flags. Flagged inline as `[VERIFY]`.

---

## 3. Cross-cutting blast radius — handle for EVERY app that moves

A domain/host move on these apps is **not just DNS**. Each phase's checklist references this list.

1. **OneSignal = ONE app per ORIGIN.** New origins (`admin`/`store`/`orders`/`whatsapp`.force-ai.co) are NOT the origins the existing OneSignal apps are bound to → push **silently dies**. Per moved frontend: create/reconfigure the OneSignal app for the new origin, update `NEXT_PUBLIC_ONESIGNAL_*` env, and the SW `serviceWorkerPath`/scope. (Orders PWA especially — `NEXT_PUBLIC_ONESIGNAL_ORDERS_APP_ID`.)
2. **Cross-origin auth cookies + CORS.** Auth is cookie-based `SameSite=None; Secure` cross-origin (FWB rotating refresh tokens). Add every new `*.force-ai.co` frontend origin to the API CORS allowlist (FWB API + WBS API), keep the old origins during transition, and verify the refresh/retry flow end-to-end after each cutover.
3. **Payment gateway URLs.** MyFatoorah / Tap / Hesabe / UPayments return + webhook URLs configured with `forcemediakw.com` must move to the new domains. **Test a real payment in test mode after the storefront + API cutover.**
4. **Meta / WhatsApp (WBS).** Webhook callback URL + OAuth redirect URIs → `whatsapp-api.force-ai.co`. Update in the Meta app config; re-verify the webhook.
5. **Email (Resend).** Set up **SPF / DKIM / DMARC for `force-ai.co`** in CF DNS so per-store branded senders + the platform fallback can send from the new domain. Verify deliverability.
6. **Hardcoded URLs.** `grep -rn "forcemediakw.com"` across FWB + WBS (+ the 4 bilingual client HTML templates at `~/Desktop/work/Force AI/assets/`); replace the **platform** ones (NOT `crm`).
7. **Env vars.** `NEXT_PUBLIC_API_URL`, `ORDERS_URL`, any base-URL env on every deploy (CF Workers/Pages env + Railway).
8. **SEO.** 301 old→new; resubmit to Google Search Console; update sitemaps, canonicals, hreflang. `store.forcemediakw.com` is indexed.
9. **PWA.** Manifest `start_url` / `scope`, service-worker scope, OneSignal `serviceWorkerPath`.
10. **OpenNext/Workers feature parity `[VERIFY]`.** Per Next.js app: middleware (FWB web's multi-tenant slug routing is critical), ISR/`revalidate`, `next/image` optimization, any Node-only API, edge vs node runtime. Storefront proved the pattern in #392; admin + orders are net-new.

---

## 4. Auth — unaffected by the move (+ a same-site cookie simplification)

**The existing FWB + WBS auth is production-grade and is NOT being replaced.** Custom JWT with short-lived access tokens (30 min) + **rotating refresh tokens with reuse-detection** (a replayed rotated token revokes the whole family — theft detection), per-token revocation (`jti` denylist) + per-user bulk revocation (`tv`), **TOTP 2FA**, single-flight refresh on both frontends, wired into **RLS tenant isolation**. No Neon Auth, no Cloudflare Access.

- **Why not Neon Auth:** it's a managed auth for _greenfield_ apps that don't want to build auth; switching means ripping out the MFA + refresh-rotation + RLS-integrated model for a strictly worse, third-party-owned lifecycle.
- **Why not Cloudflare auth:** CF has no end-user auth product for customer-facing SaaS. **Cloudflare Access (Zero Trust)** gates _internal_ apps behind _employee_ SSO — wrong tool for storefront customers + merchants.

**The migration doesn't touch auth.** Auth lives in the **API on Railway** (not moving). Cloudflare only changes where the frontend HTML/JS is served from; the frontends still `fetch()` the API with `credentials:'include'` exactly as today. Per project rule #4, FWB does **no auth in Next.js middleware**, so nothing auth-related runs on the Worker. The only auth-adjacent migration task is already in the blast radius: **add the new `*.force-ai.co` origins to the API CORS allowlist (#2).**

### Upside the rebrand unlocks (optional, after Phase 4)

Today the frontends (`forcemediakw.com`) and the API (`*.railway.app`) are **cross-site** → requires `SameSite=None` + the iOS-WebKit/ITP `localStorage` token fallback (`isIosWebkit`). After the rebrand, the API (`api.force-ai.co`) and all frontends (`{admin,store,orders,whatsapp}.force-ai.co`) share the registrable domain **`force-ai.co`** = **same-site**. So you _can_ switch to **`Domain=.force-ai.co` cookies with `SameSite=Lax`**, which Safari/ITP treats far more reliably, and **retire the localStorage-token hack**. Not required for the migration; it's a reliability win the move hands you for free — sequenced as an optional hardening step once `api.force-ai.co` + the frontends are all live + verified (post-Phase 4, see Phase 6).

## 5. Phases

### Phase 0 — Prereqs (no user-facing change)

- [x] `force-ai.co` zone live on Cloudflare (bought via CF Registrar, born-on-CF).
- [ ] Add **SPF/DKIM/DMARC for `force-ai.co`** to CF DNS for Resend `[VERIFY]` Resend domain setup.
- [ ] **Inventory** every Vercel project + its custom domains + env vars: `vercel project ls`, `vercel domains ls`, `vercel env ls` per project. Capture so nothing is missed at cancel time.
- [ ] **Decide marketing apex** (OPEN) — `forcemediakw.com` stays as marketing, or marketing moves to `force-ai.co`? Blocks only Phase 1's marketing item.

### Phase 1 — Easy CF Pages migrations (de-risk + quick wins)

Targets: **om-hassan-menu, marketing, personal projects, CRM**. Static-ish → CF Pages is near-trivial and nothing business-critical is at risk; this proves the Pages path before touching FWB/WBS.

Per project:

- [ ] Connect the GitHub repo to a **CF Pages** project (or `wrangler pages deploy`); set build command + output dir + env vars.
- [ ] Verify on the `*.pages.dev` URL.
- [ ] Add the custom domain in CF Pages; flip DNS (or 301).
- [ ] **CRM specific:** domain `crm.forcemediakw.com` STAYS on GoDaddy DNS (client-owned). Hosting CF Pages on a subdomain whose zone is NOT on Cloudflare needs a `CNAME crm.forcemediakw.com → <project>.pages.dev` + CF cert issuance for that custom hostname `[VERIFY]` — if CF can't auto-issue for a non-CF zone, options are Cloudflare-for-SaaS for that hostname OR leave CRM on Vercel as the lone exception. Decide during this phase.

Outcome: CF Pages path proven; Vercel still serving everything important.

### Phase 2 — FWB storefront (`apps/web`) → CF Workers

Already prepped in **#392** (OpenNext build files git-ignored + env-gated; `DOMAIN_PROVIDER`/`Store.domainProvider` dual switch; `CloudflareDomainService` no-ops until `CF_*` set).

- [ ] `bash scripts/cf-setup-local.sh web && bash scripts/cf-build.sh web && (cd apps/web && npx wrangler login && npx wrangler deploy)`.
- [ ] Verify on `*.workers.dev`: SSR, ISR, `next/image`, **multi-tenant middleware slug routing**, checkout, a test-mode payment.
- [ ] Enable **CF-for-SaaS**: SSL/TLS → Custom Hostnames → enable SSL for SaaS on `force-ai.co`; add custom domain `cf.force-ai.co` → the worker (= fallback origin). Set `CF_API_TOKEN` / `CF_ZONE_ID` / `CF_FALLBACK_ORIGIN=cf.force-ai.co` in Railway (leave `DOMAIN_PROVIDER` unset).
- [ ] Point `store.force-ai.co` at the worker.
- [ ] **Canary one demo store custom domain** via `scripts/cf-migrate-store.sh <demo-slug>` → watch it go `verified`.
- [ ] Keep `store.forcemediakw.com` on Vercel until verified, then 301.
- Blast radius: #1 (storefront OneSignal broadcast origin), #2 CORS, #3 payments, #8 SEO.

### Phase 3 — FWB admin + orders → CF Workers (OpenNext, net-new)

Replicate the storefront's OpenNext setup for `apps/admin` + `apps/orders` (own `wrangler.jsonc`, `open-next.config.ts`, build scripts — keep git-ignored like web).

- [ ] Admin is heavy (page-builder, dnd-kit, charts) — `[VERIFY]` bundle size + runtime on Workers; check any Node-only usage.
- [ ] Orders is a PWA — verify SW + manifest scope under the new origin.
- [ ] **OneSignal**: new origins `admin.force-ai.co` + `orders.force-ai.co` → reconfigure/recreate OneSignal apps; update `NEXT_PUBLIC_ONESIGNAL_*` (admin) + `NEXT_PUBLIC_ONESIGNAL_ORDERS_APP_ID` (orders).
- [ ] Deploy → `admin.force-ai.co` / `orders.force-ai.co`.
- [ ] Verify auth end-to-end (cross-origin cookies to the API — see Phase 4) → 301 old subdomains.
- Blast radius: #1, #2, #9.

### Phase 4 — FWB API custom domain (`api.force-ai.co`)

- [ ] Add `api.force-ai.co` as a custom domain on the Railway FWB API service (`api-production-c058.up.railway.app`).
- [ ] Update `NEXT_PUBLIC_API_URL` on all FWB frontends (web/admin/orders) → `https://api.force-ai.co`.
- [ ] **CORS allowlist**: add `https://{store,admin,orders}.force-ai.co` (keep the old `*.forcemediakw.com` origins during transition).
- [ ] Verify auth refresh + CORS + `SameSite=None` cookies end-to-end.
- Note: can run in parallel with Phase 3's verification since the frontends point at whichever API URL is set.

### Phase 5 — WBS (frontend + API)

- [ ] WBS frontend → CF (Workers if Next/OpenNext, else Pages) → `whatsapp.force-ai.co`.
- [ ] WBS API custom domain `whatsapp-api.force-ai.co` on Railway (`5g5q16lq.up.railway.app`).
- [ ] **Meta/WhatsApp** webhook + OAuth redirect URIs → `whatsapp-api.force-ai.co`; re-verify webhook.
- [ ] CORS + cookies + OneSignal (if any) for the new origin.
- [ ] 301 `ws.forcemediakw.com` + `backend.forcemediakw.com`.
- Blast radius: #2, #4, #6, #7.

### Phase 6 — Rebrand cutover finalize

- [ ] All new domains live + verified.
- [ ] **301** every old platform subdomain → new (`app→admin`, `store`, `orders`, `ws→whatsapp`, `backend→whatsapp-api`). **Keep `crm`.**
- [ ] Update **GSC** (add force-ai.co properties, submit sitemaps, change-of-address where applicable), canonicals, hreflang.
- [ ] Update client docs + the 4 bilingual HTML templates (`~/Desktop/work/Force AI/assets/`), email signatures, any printed/marketing references.
- [ ] Final `grep -rn forcemediakw.com` across FWB + WBS → replace remaining platform refs.
- [ ] **(Optional hardening — see §4)** Now that `api.force-ai.co` + all frontends share `force-ai.co`, switch auth cookies to `Domain=.force-ai.co` + `SameSite=Lax` and **retire the iOS-WebKit `localStorage` token fallback** (`isIosWebkit`). Do this as its own small PR with the 5-layer auth tests green; verify Safari/iOS-PWA login + refresh before removing the localStorage path.

### Phase 7 — Decommission Vercel

- [ ] Soak **1–2 weeks** with old domains 301'ing and CF stable.
- [ ] Remove Vercel custom domains → delete Vercel projects → **cancel Vercel Pro**.
- [ ] Confirm $0 Vercel. (If CRM had to stay on Vercel per Phase 1's `[VERIFY]`, that's the one exception — re-evaluate.)

---

## 6. Rollback (per app, per phase)

Each app's cutover is a single DNS record change. Rollback = repoint that record back to its Vercel target (Vercel project + domain alias kept live until Phase 7 soak ends). Storefront merchant domains: `scripts/cf-migrate-store.sh <slug> --rollback` (deletes the CF custom hostname + sets `domain_provider='vercel'`). No data migration anywhere — APIs/DB unchanged — so every rollback is instant + lossless.

## 7. Open decisions (resolve before the blocked phase)

- **Marketing apex**: `forcemediakw.com` stays as marketing, or → `force-ai.co`? (blocks Phase 1 marketing only)
- **CRM custom-domain cert** on non-CF (GoDaddy) zone `[VERIFY]` — CNAME-to-pages.dev cert path, or CF-for-SaaS, or leave CRM on Vercel as the lone exception. (Phase 1)
- **WBS frontend** runtime: Workers (OpenNext, if Next.js) vs Pages. (Phase 5)

## 8. `[VERIFY]`-against-current-CF-docs checklist

- `@opennextjs/cloudflare` Next.js **16** support + ISR/`next/image` behavior on Workers.
- CF **Pages custom domain on an external-DNS (GoDaddy) subdomain** — automatic cert issuance.
- Wrangler deploy flow + required `compatibility_date`/flags for each app.
- CF-for-SaaS apex handling for merchant **apex** domains (GoDaddy can't CNAME apex — `www`+redirect, move that domain to CF, or CF apex A/AAAA target).

---

_Sources for the Vercel-Hobby commercial restriction: Vercel [Hobby plan](https://vercel.com/docs/plans/hobby), [Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines), [Terms of Service](https://vercel.com/legal/terms)._
