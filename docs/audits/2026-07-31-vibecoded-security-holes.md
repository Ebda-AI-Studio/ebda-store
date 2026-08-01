# FWB audit — "10 security holes in almost every vibecoded app"

**Date:** 2026-07-31
**Lens source:** r/SaaS Instagram carousel, "Security holes I find in almost every vibecoded app" (10 items)
**Target:** `force-website-builder` @ `7638f50b` (main)
**Method:** static read of `apps/api` + `apps/web` route/middleware/service layers, live probe of the R2 bucket, empirical test of the serialization claim.

## Tally

| Severity | Count                               |
| -------- | ----------------------------------- |
| Critical | 0                                   |
| **High** | **1**                               |
| Medium   | 0                                   |
| Low      | 2 (noted, not fixed — see Residual) |

**9 of 10 lenses passed.** One real, exploitable finding (lens 10-adjacent / stored XSS). This is a markedly better result than the lens is designed to catch — the codebase has explicit, commented defences at nearly every point the carousel names, several of them recording IDORs that were already found and closed.

---

## FINDING H-1 (High) — JSON-LD `</script>` break-out → stored XSS

**Files:** `apps/web/src/components/JsonLd.tsx:21`, `apps/web/src/app/layout.tsx:440`, `apps/web/src/app/blog/[slug]/BlogPostBody.tsx:121`

All three emitted `<script type="application/ld+json">` via bare `JSON.stringify`. `JsonLd.tsx` carried this comment:

> dangerouslySetInnerHTML is safe here because JSON.stringify escapes every special HTML character that could constitute a script injection vector.

**That claim is false**, and was verified false rather than assumed:

```
$ node -e 'console.log(JSON.stringify({name:"a</script><img src=x onerror=alert(1)>"}))'
{"name":"a</script><img src=x onerror=alert(1)>"}
```

`JSON.stringify` escapes quotes and backslashes but emits `<` and `>` verbatim. The HTML tokenizer terminates a `<script>` element at the first `</script` sequence irrespective of JSON string quoting, so everything after it is parsed as markup.

**Why it executes:** `apps/web/next.config.js:125` sets `script-src 'self' 'unsafe-inline' …`, so an injected inline event handler runs.

**Attacker-reachable inputs that reach these payloads** (via `productJsonLd` / `breadcrumbJsonLd` / `faqPageJsonLd` in `lib/structured-data.ts`, assembled in `ProductDetailBody.tsx`):

| Field                          | Source                                | Input validation                                                      |
| ------------------------------ | ------------------------------------- | --------------------------------------------------------------------- |
| `review[].reviewBody`          | customer-submitted review             | `z.string().min(20).max(5000)` — **no HTML stripping**                |
| `review[].author`              | customer `firstName`/`lastName`       | `z.string().min(1)` — **no HTML stripping**, set at self-registration |
| product `name` / `description` | merchant admin + bulk supplier import | none                                                                  |
| FAQ `question` / `answer`      | merchant admin                        | none                                                                  |
| blog title / excerpt           | merchant admin                        | none                                                                  |

**Impact.** Two distinct paths:

1. **Customer → every visitor of a product page.** Register, purchase, submit a review whose body carries the break-out. Requires the review to reach `status='published' + verifiedPurchase=true`, so a moderation step stands in the way — but moderators are reviewing _rendered text_, and the payload is invisible in a normal review UI.
2. **Malicious merchant → cross-tenant, no moderation.** Platform-path stores share the origin `store.force-ai.co`. A merchant who sets a product name containing the payload executes script on that shared origin for anyone who visits their store — including staff/admins. This is the more serious path because it needs no approval from anyone.

**Fix.** New `apps/web/src/lib/json-ld-script.ts` exporting `jsonLdScriptContent()`, which escapes `<`, `>`, `&` and U+2028/U+2029 as `\uXXXX`. Those escapes are valid JSON and decode back to the original characters, so Google/Bing consumers are unaffected — verified by a round-trip test. All three emit sites now use it. Six regression tests in `apps/web/src/lib/__tests__/json-ld-script.test.ts`, one of which asserts the old behaviour was unsafe so the disproven claim cannot quietly return.

---

## Lens-by-lens results

### 01 — IDOR — PASS

Every `:storeId` router is mounted with `tenantContext` and guarded by either the `requireStoreAccess` middleware or an inline `checkStoreAccess()` where the route is mixed-audience (admin _or_ customer, so the middleware would wrongly reject customers). A sweep for routes carrying `authenticate` but neither guard returned only customer-self-scoped routes, and every one of those resolves identity through `customerUserId(req)` — a helper that explicitly **rejects admin tokens**, with a comment explaining that passing an admin `userId` to a customer lookup would leak the existence of a matching user record.

`order.routes.ts:403` and `:448` carry comments recording the exact cross-tenant IDOR the lens describes ("ANY store_admin token used to be able to read any other tenant's orders by changing :storeId") — already found and closed.

Guest order access (`GET /public/orders/:id`) uses possession of a v4 UUID as the credential for guest orders and requires `customerId` match for customer-owned ones. Standard, documented, and store-scoped via `getById(storeId, id)`.

### 02 — RLS left open / public DB — VERIFIED LIVE 2026-08-01 (caveat resolved, and it matters)

The original caveat ("could not verify the live policy state") is now settled. Connected read-only to
the production Neon branch (`fwb-eu` / `crimson-king-40424588`, branch `main`) via `neonctl` and
queried the catalog directly. The earlier failure was a stale local `.env` pointing at
`ap-southeast-1`; production is `eu-central-1`.

**Provisioned state — good:**

| Metric                                | Value                                                      |
| ------------------------------------- | ---------------------------------------------------------- |
| Tables in `public`                    | 103                                                        |
| RLS enabled                           | 94                                                         |
| RLS **forced**                        | 93                                                         |
| RLS off                               | 9                                                          |
| Tables with RLS but **zero** policies | 0                                                          |
| Policies with `USING (true)`          | 1 (`system_settings`, a global non-tenant table — correct) |

**But RLS is INERT in production today, by tracked design.** Production connects as `neondb_owner`,
which has `rolbypassrls = t`. Every tenant policy is written `TO force_app`, and `force_app` has
`rolcanlogin = f` — it cannot connect at all. So none of the 94 policies apply to the live
application connection.

This is **not** an undiscovered hole. `apps/api/src/index.ts` carries a boot guard that logs
`[SECURITY FATAL]` and `process.exit(1)` when the DB role has BYPASSRLS, deliberately escaped via
`ALLOW_BYPASSRLS_ROLE=true` because the guard crash-looped production on 2026-06-27.
`middleware/tenant-context.ts` states plainly that app-layer scoping is "the ONLY isolation mechanism
until the force_app cutover". Lens 01 above independently verified that app-layer control is in fact
present on every route — which is what makes the current posture defensible rather than dangerous.

**What actually blocks the Phase-3 cutover:** `force_app` already holds SELECT on all 103 tables, so
grants are done. The single blocker is that the role **cannot log in** — it needs LOGIN plus a
password before `DATABASE_URL` can point at it.

**Two things to fix before/with the cutover** (harmless today, because RLS is inert):

1. `users` and `webhook_events` both carry `store_id` and have **RLS off**. Post-cutover these would
   be the only tenant tables without database-level isolation.
2. `product_daily_views` has RLS enabled but **not forced** — the table owner bypasses it.

`users` needs care rather than a reflexive `ENABLE`: admin accounts deliberately have
`storeId = NULL`, so a naive `store_id = current_store_id()` policy would hide every admin row and
break authentication — which is exactly the failure recorded in
`feedback-rls-force-cutover-breaks-preauth-and-self-service-auth`. Treat it as part of the cutover
program, not a drive-by migration.

**Verification queries** (read-only, safe to re-run):

```sql
-- provisioned state
SELECT count(*) FILTER (WHERE relrowsecurity) AS enabled,
       count(*) FILTER (WHERE relforcerowsecurity) AS forced, count(*) AS total
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r';

-- is RLS actually in force for the app's role?
SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles
WHERE rolname IN ('neondb_owner','force_app');
```

The second query is the one that matters. Counting policies tells you what was _provisioned_; only
the role's `rolbypassrls` tells you whether any of it _applies_.

### 03 — Price/permission enforced client-side — PASS

`OrderService.create` derives `subtotal` from the server-side cart, prices each line from the DB product/variant (`unitPrice = product.price`, overridden by the DB variant price), floors and clamps quantity to ≥1, computes tax, resolves shipping from the server shipping-zone table, and **re-validates the coupon at order time** with an explicit comment that the cart may have changed since `/coupons/validate`. Promotions and coupons compete "best-of" rather than stacking. No money value is accepted from the client.

`shippingOverride` exists but only on `createAdminOrder`, whose route is `authenticate → authorize('store_admin','super_admin','staff') → requireStoreAccess`.

### 04 — No rate limiting on expensive endpoints — PASS

Twelve purpose-built limiters (`authLimiter`, `writeLimiter`, `paymentLimiter`, `uploadLimiter`, `dailyUploadLimiter`, `publicLimiter`, `storeResolveLimiter`, `cartLimiter`, `newsletterLimiter`, `couponValidateLimiter`, `promotionPreviewLimiter`, `viewIngestLimiter`), all Redis-backed so limits hold across instances. The entire AI router sits behind `authenticate + authorize('store_admin','super_admin') + requireStoreAccess`, plus `writeLimiter`, plus daily/monthly spend caps in `lib/ai-quota.ts`. Bulk AI is throttled via `AI_BULK_THROTTLE_MS`.

### 05 — Hand-rolled / broken JWT — PASS

`jwt.verify(token, secret, { algorithms: ['HS256'] })` — algorithm pinned, so `alg:none` and RS→HS confusion are both closed. Boot refuses to start on a secret under 32 chars or containing `change-in-production`/`your-super-secret`/`changeme`/`placeholder`. 30-minute access tokens with a `jti` denylist and a `tv` counter for bulk revocation; rotating refresh tokens with reuse-detection that revokes the whole family. MFA challenge tokens are scoped by `audience` + `purpose` so they can't be replayed as session tokens.

### 06 — RLS on, but the policy has a hole — PASS (by design, documented)

Policies take the shape `current_store_id() IS NULL OR store_id = current_store_id()`, with matching `WITH CHECK` — so writes can't place rows in another tenant either. The GUC derives from the user-supplied `:storeId` path param, which sounds like the hole the lens describes, but `tenant-context.ts` states plainly that RLS is **defence-in-depth** and `requireStoreAccess` + explicit `where: { storeId }` are the primary controls. Lens 01 confirms that primary control is actually present everywhere. The `NULL` branch is the deliberate super-admin/background-job path.

The migration named `20260629120000_accounting_rls_explicit_with_check` shows a missing-`WITH_CHECK` gap of exactly this kind was already found and closed.

### 07 — Storage bucket listing enumerable — PASS (live-probed)

Against the live r2.dev bucket: root, `?list-type=2`, and `?prefix=stores/` all return **404**; a known object key returns **200**. No `ListBucketResult` markup in any response. Listing is off.

### 08 — Pre-auth expensive endpoints / unlimited signup — PASS

Every pre-auth money-costing route is limited. `/register`, `/login`, `/refresh` and `/resend-verification` carry `authLimiter` (15 per 15 min, keyed IP+email, IPv6 normalized to /64 so an attacker can't rotate the low bits for a fresh bucket).

Worth naming precisely: because the key is IP **+ email**, rotating the email yields a fresh per-email bucket from one IP. That is the right shape for brute-force defence, and the residual is bounded by the **global** limiter in `index.ts:212` — 200 mutations per IP per 15 min, Redis-backed, bypassed only for the test env and a load-test token that is unset in production. So email-send abuse is capped rather than unlimited. Registration also can't be used to enumerate accounts: `AuthService.register` returns an identical `{ emailVerificationSent: true }` for both new and existing addresses.

### 09 — SSRF via user-supplied URL — PASS

`apps/api/src/lib/safe-fetch.ts` blocks the cloud metadata endpoint (`169.254.0.0/16`), all RFC1918 ranges, loopback and CGNAT, and — the part usually missed — **re-validates after each redirect** by handling redirects manually instead of letting the fetch layer follow them. Used at both user-URL entry points (`product-alt-text-generator.ts:72`, `ai.service.ts:499`). Bulk import stores URL strings without dereferencing them. Remaining outbound calls use server-controlled URLs (`process.env.STOREFRONT_REVALIDATE_URL`, a hardcoded Telegram endpoint).

### 10 — Prompt injection with tool access — PASS (no tool access) → but see H-1

The AI layer has **no tool/function-calling surface**: it generates text and structured suggestions only. Nothing an LLM emits triggers a privileged action, so the carousel's headline risk doesn't apply. The palette extractor — the one AI output that drives a rendering decision — validates against `z.string().regex(/^#[0-9a-fA-F]{6}$/)` per channel.

The genuine adjacent risk is **where AI output lands**: SEO paths use `JSON.parse(raw) as SeoSuggestion`, a compile-time cast with no runtime validation (the `jsonparse-any-poisoning` pattern). Model output flowing into meta fields was, before H-1's fix, rendered into a JSON-LD `<script>` block that could be broken out of. The escaping fix closes the exploitable end of that chain. See Residual L-2 for the validation end.

---

## Residual — both CLOSED in PR #978 (same day)

**L-1 — `POST /stores/:storeId/orders` used `getAuthUser(req).userId`** rather than the
admin-rejecting `customerUserId(req)` every sibling customer route uses, so an admin token checking
out produced an order whose `customerId` pointed at a non-customer user row. Now uses
`customerUserId()` + 403, and gained the `writeLimiter` its public twin already carried. Admin-created
orders have their own route, `POST .../orders/admin` (`createAdminOrder`), with `authorize()` +
`requireStoreAccess`. No client broke — the storefront checks out via `/public/orders`.

Worth recording: this turned the order + checkout E2E suites red, because **both were checking out
with a `super_admin` token** — the tests encoded exactly the mis-attribution L-1 describes. They now
create a `role: 'customer'` User (store-scoped via `@@unique([storeId, email])`) and log in as that.

**L-2 — AI output validation.** The wording above ("runtime shape is unvalidated") **overstated the
gap**, and the correction matters for anyone reading this audit later: the hand-rolled
`typeof x !== 'string'` chains _did_ check every scalar field. The real gaps were narrower — array
ELEMENT types (`Array.isArray(keywords)` accepted `[{...}, 42]`, reaching a meta tag as
`[object Object]`), the `confidence` enum, `matches` not being array-checked (a non-array threw out of
`.filter`, surfacing as a 500 rather than a clean 502), and the absence of any length bound. All four
are now covered by zod schemas plus a shared `parseAiJson()` helper, with 10 unit tests pinning each.

The `JSON.parse(hit) as T` calls that remain in `ai.service.ts` are Redis **cache reads**, whose
values were validated before being written — not the same defect.

## Lens registration

Registered as a reusable lens for the audit fleet so it reruns against the other projects rather than being spent once here — see `reference-builder-reality-audit.md` (extension point) and the memory entry written alongside this audit.

## Lens W follow-up (2026-08-01)

The agentic-commerce lens (W) audit found FWB already strong — `llms.txt` serving live catalogue
data, AI crawlers allowed in `robots.ts`, an MCP server, and Product JSON-LD carrying
offers/availability/sku/aggregateRating/reviews. One gap: no `brand`, `shippingDetails` or
`hasMerchantReturnPolicy`, despite `shippingZones`, `freeShippingThreshold` and `aboutJson` brand
facts all existing in the schema — data present, agent surface missing.

Closed by `docs/superpowers/plans/2026-08-01-agent-readable-product-jsonld.md`. Brand and shipping
derive from existing data; return policy needed two new nullable `Store` columns plus their admin
control, because a return window is a merchant commitment that cannot be derived or defaulted.
