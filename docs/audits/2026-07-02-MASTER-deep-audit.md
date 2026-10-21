# Ebda Store Deep Audit — MASTER Consolidated Report (2026-07-02)

**Scope:** Full-layer production-readiness audit of Ebda Store against `origin/main` HEAD `2332c4d5`.
**Method:** Gap Audit Fleet (playbook §15) — 10 read-only lenses dispatched as parallel Sonnet sub-agents, each adversarially verifying findings (CONFIRMED = read the code; PLAUSIBLE = needs runtime check). Per-lens reports live alongside this file as `2026-07-02-<lens>.md`.
**Stack note:** `apps/api` is **Express 4** + Prisma + Postgres/Neon + Redis + Socket.io; storefront `apps/web` (5 themes, custom `LanguageContext`), admin `apps/admin` (next-intl), fulfilment `apps/orders` (PWA). Deploys: Railway (api) + Vercel + Cloudflare Workers.

## Headline

Ebda Store is in **solid** production shape — money is integer-fils end-to-end, prod `npm audit` is 0/0/0/0, all apps typecheck clean, security fundamentals (SQLi/CSV-injection/CSRF/auth/GDPR) verified closed, and most classic reliability hazards are already handled. The audit found **no evidence of an active production-down or active-leak bug**, but it surfaced **5 Critical** and **23 High** issues — dominated by three structural themes:

1. **Guards read outside the transaction they protect** → money/state effects double-apply under concurrency (refund double-refund; non-idempotent inventory restore).
2. **Enforcement gated in the UI only** → paid features invokable via direct API call (push broadcast, invoicing, affiliate signup) = billing leaks.
3. **A documented safety-net that isn't actually there** → RLS is _inert in prod_ (app connects as the `BYPASSRLS` owner role), so tenant isolation rests entirely on the app layer, and the planned RLS cutover carries a latent platform-wide checkout outage (`addresses` FORCE-RLS with no policy).

A recurring meta-pattern worth calling out: several of the worst findings are **defect-class-sweep misses** — a fix was applied to one site but not its siblings (the N+1-in-`withRlsBypass` fix landed on the stock scans but not `bank-reconcile`; the stale-cart `orderBy` fix landed on the primary path but not the P2002 fallback; the Supabase→Neon migration left a `*.supabase.co` CSP entry behind).

## Tally across all 10 lenses

| Lens                           | Crit  | High   | Med    | Low    | Report                                |
| ------------------------------ | ----- | ------ | ------ | ------ | ------------------------------------- |
| A · Tenancy / RLS / auth       | 0     | 3      | 2      | 4      | `2026-07-02-tenancy-rls-auth.md`      |
| B · Money integrity            | 1     | 2      | 2      | 2      | `2026-07-02-money-integrity.md`       |
| C · Scaling & perf             | 1     | 3      | 2      | 1      | `2026-07-02-scaling-perf.md`          |
| D · Reliability                | 0     | 1      | 3      | 2      | `2026-07-02-reliability.md`           |
| E · Security surface           | 0     | 0      | 4      | 1      | `2026-07-02-security-surface.md`      |
| F · Observability / DR / CI-CD | 0     | 3      | 6      | 4      | `2026-07-02-observability-dr-cicd.md` |
| G · Deps / types / quality     | 0     | 1      | 4      | 5      | `2026-07-02-deps-types-quality.md`    |
| H · Product completeness       | 2     | 5      | 3      | 6      | `2026-07-02-product-completeness.md`  |
| Feature-flag enforcement       | 1     | 3      | 3      | 0      | `2026-07-02-feature-flags.md`         |
| i18n / RTL parity              | 0     | 3      | 2      | 1      | `2026-07-02-i18n-rtl.md`              |
| **TOTAL**                      | **5** | **24** | **31** | **26** | 86 findings                           |

## The 5 Criticals (ranked by user-facing risk × business impact)

1. **Concurrent "refund via provider" double-refunds real money.** The `status==='completed'` guard is read _outside_ the transaction that later flips it, and the provider `MakeRefund` call fires before the write — two overlapping clicks both pass and both refund at the gateway. — `apps/api/src/services/payment-providers/payment.factory.ts:626-701` _(B, CONFIRMED)_
2. **Billing leak: admin push broadcast has no feature gate.** `POST /stores/:storeId/push/broadcast` sends real OneSignal notifications with only a hidden UI button as the gate — any tier can broadcast. (Cluster: invoicing + public affiliate signup are also ungated — see Highs.) — `apps/api/src/routes/onesignal.routes.ts:155-198` _(Feature-flags, CONFIRMED)_
3. **`bank-reconcile` N+1 inside one unchunked `withRlsBypass` interactive tx** — up to 3 sequential Prisma calls per bank-transaction row, one redundantly re-fetched each iteration. This is the **same defect class as the 2026-06-30 30s-timeout P1** (fixed on the stock scans, never swept here); a ~500-row statement reproduces that incident. — `apps/api/src/services/accounting/bank-reconcile.service.ts:215-300` _(C, CONFIRMED)_
4. **Page Builder product-name hydration calls a nonexistent route → 404**, so the picker shows raw product IDs instead of names. Real route is `/stores/:id/products`. — `apps/admin/src/app/stores/[id]/page-builder/page.tsx:4221` _(H, CONFIRMED)_
5. **Sales/pricing docs contradict the code**: 3 business docs call WhatsApp an "always add-on, not baseline-included," but it's been default-open in code since PR #94 — a live proposal/contract risk. — `docs/business/04-pricing-tiers.md:135-141` _(H, CONFIRMED)_

> **Strategic near-critical (structural, not an active leak):** RLS is **inert in prod** — the API connects as `neondb_owner` with `ALLOW_BYPASSRLS_ROLE=true`, so all policies/FORCE/`runInTenantContext` are no-ops; tenant isolation is **app-layer-only**, one forgotten `WHERE` from a leak (`apps/api/src/index.ts:438-480`). And the planned RLS cutover is a **landmine**: `addresses` is FORCE-RLS'd with **no policy** (deny-all for the earlier app role) → checkout + saved addresses break platform-wide the moment it ships (`packages/database/prisma/migrations/…`). Treat "turn on RLS" as a Critical-gated project, not a flip.

## The 24 Highs, grouped

**Money & state correctness (concurrency / idempotency)**

- `applyRefundEffects` inventory restore is a bare unconditional `increment` with no per-order guard → phantom stock/oversell when refund fires twice (refunded→cancelled transition, or manual refund + out-of-band webhook). — `order.service.ts:1109-1162`
- No paid-amount reconciliation: order flips to paid on the provider status string alone; `paidAmount` stored but never compared to `order.total` → underpayment ships goods. — `payment.factory.ts:963-1024`
- Coupon `usageLimitPerUser` is collected and stored but **never enforced** — a "once per customer" coupon is reusable unlimited times (global limit _is_ race-safe). — `order.service.ts:460-473`, `coupon.service.ts:80-107`

**Billing leaks (UI-only gating)**

- Egypt invoice generation (`accounting.invoicing`, Professional) — zero enforcement at any layer. — `order.routes.ts:529-590`, `public.routes.ts:782`
- `staff_accounts` is a **dead flag** — declared + implemented + visible in admin, but in no `PLAN_BASELINE` and checked nowhere → every tier gets staff accounts. — `features.ts:268`, `staff.routes.ts`
- Public affiliate signup accepts applications on any tier (`getConfig()` defaults `publicSignupEnabled: true`, no `isFeatureEnabled('affiliate')`). — `affiliate.routes.ts:444-455`

**Tenant isolation (RLS backstop absent)**

- `tenantContext` never sets RLS context for ~32 routers mounted at bare `/stores`, `/`, `/admin` (Express doesn't populate `:storeId` at a param-less mount) → zero backstop there even after cutover. — `routes/index.ts:111-197`, `middleware/tenant-context.ts:37-53`
- `addresses` FORCE-RLS no-policy landmine (see strategic note above).

**Scaling / perf**

- `aggregateCustomers()` re-scans the entire order table (≤20k rows w/ items+payments+customer) with **no caching** on every `GET /customers` and `/customers/export.xlsx`. — `customers.routes.ts:129-285`
- `GET /customers/:customerKey` has no `take` cap (unlike every sibling). — `customers.routes.ts:850`

**Observability / delivery**

- **Orders PWA ships with zero Sentry** (client + server) — fulfilment-UI crashes are invisible. — `apps/orders/`
- Sentry source maps never uploaded (neither `next.config.js` wrapped in `withSentryConfig`) → every issue arrives minified, no release. — `apps/web/next.config.js:165`, `apps/admin/next.config.js:152`
- **242 git branches** incl. orphan `auto-fix/*` — violates branch hygiene, widens the gitleaks/secret scan surface.

**Product completeness (dead buttons / missing UI)**

- Affiliate "Referrals & Payouts →" link points at the events log; itemized referral/payout viewers orphaned despite live routes. — `affiliates/[affiliateId]/audit-trail/page.tsx:229`
- `WebhookEvent` payment inbox has **no admin UI or read route**, yet the P0 stuck-webhook runbook depends on manual replay from it. — `schema.prisma` (model WebhookEvent)
- `ReorderRule` config has no route or UI (only AI suggestions shown). — `stores/[id]/stock/reorder/page.tsx`

**Dependency hygiene**

- Duplicate React instances: root `react@19.2.7` (via `@dnd-kit`/`@sentry/react`/`next-intl`/`next`) coexists with each app's `react@18.3.1` — classic dual-copy hooks/context hazard; no app wants 19. Fix: root `overrides` pin to 18.3.1. — `package.json`

**i18n / RTL (Arabic is a locality pillar)**

- `formatPrice()` defaults to `en-US` and **0 of 86 call-sites override it** → every price on the Arabic storefront renders Western digits/"EGP" prefix, while a newer sibling helper uses `ar-KW` Arabic-Indic digits → mixed-locale currency on the same page. — `packages/shared/src/utils/index.ts:51-65`
- Admin AI-recommendations panel is 100% hardcoded English (bypasses next-intl). — `AiSuggestionsPanel.tsx:218-238`
- Page Builder has ~130 hardcoded English `<option>` labels with no translation keys. — `page-builder/page.tsx`

## Suggested fix batches (each = one isolated-worktree PR)

**Batch 1 — Money correctness (Critical + 3 High, one root cause).** Make each money action single-execution: atomic conditional `UPDATE … WHERE status='completed'` for refund, per-order restore marker in `applyRefundEffects`, paid-amount reconciliation vs `order.total`, order-create idempotency key, and enforce coupon `usageLimitPerUser`. Closes B-Crit + B-H1/H2 + D-High together.

**Batch 2 — Billing leaks (Critical + 3 High).** Add `requireFeature()` at the route layer for push broadcast, invoicing, affiliate signup; add `staff_accounts` to `PLAN_BASELINE` (or delete the flag). Fixes the entire UI-only-gating class.

**Batch 3 — Scaling Critical.** Chunk `bank-reconcile.runAutoMatch` out of the interactive tx (mirror the low-stock-scan fix); cache + `take`-cap + rate-limit the `customers.routes.ts` aggregation/export.

**Batch 4 — Product-completeness Criticals + dead buttons.** Fix the Page Builder 404 route; correct the WhatsApp add-on/baseline docs (+ contract checklist); wire the affiliate/`WebhookEvent`/`ReorderRule` viewers.

**Batch 5 — RLS strategy (do NOT flip casually).** Decide app-layer-only-forever vs real RLS cutover; if cutover, first add the `addresses` policy + fix the bare-mount `tenantContext` gap, then stage behind a rollback plan.

**Quick wins (≤1 day each, low blast radius):** root React override pin; `uuid` override → `~9`; `@lhci/cli > typed-rest-client > qs` nested override; delete leftover `*.supabase.co` CSP entry; wrap web/admin `next.config` in `withSentryConfig`; add Sentry to `apps/orders`; prune `auto-fix/*` branches; refresh `DEPLOYMENT.md` (CF Workers path, drop "Hobby"); `formatPrice` locale threading.

## Candidate new standing rules (for CLAUDE.md review)

- **"Guard inside the transaction."** Any money/state guard (`status==='X'` check gating an effect) must be an atomic conditional write, not a read-then-act — TOCTOU under concurrency is the single most common defect class this audit found.
- **"Every paid feature is enforced at the API layer, not just the UI."** A hidden button is not a gate. Every flag in `plan-baselines.ts` needs a route-level `requireFeature()` proof; dead flags (declared, never checked) are billing leaks.
- **"A documented backstop must be verified live, not assumed."** RLS was documented as the isolation backstop but is inert in prod — audits must confirm the safety net is actually engaged, not just present in code/migrations.

---

_Audit-only. No source modified. Per-lens detail + confirmed-good sections in the sibling `2026-07-02-_.md` reports.\*
