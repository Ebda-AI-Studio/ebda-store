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

### 02 — RLS left open / public DB — PASS (with a caveat)

98 `ENABLE ROW LEVEL SECURITY` and 45 `FORCE ROW LEVEL SECURITY` statements across 10 dedicated RLS migrations. No public/anon database exposure — Neon sits behind the API only.

**Caveat, stated as a limitation not a finding:** I could not verify the _live_ policy state. The local `.env` credential is stale (`password authentication failed`) and Railway isn't linked in this checkout. Migrations describe intent; `pg_policies` is the truth. **Unblock:** run

```sql
SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables
  JOIN pg_class ON relname = tablename WHERE schemaname='public' AND NOT rowsecurity;
```

against production. CLAUDE.md already requires re-verifying policy state after any snapshot restore.

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

## Residual (accepted, not fixed in this PR)

**L-1 — `POST /stores/:storeId/orders` uses `getAuthUser(req).userId` rather than `customerUserId(req)`.** Every sibling customer route uses the admin-rejecting helper; this one doesn't, so an admin token checking out would create an order attributed to a non-customer user id. Not a security boundary (it's a create, not a cross-tenant read) — an inconsistency worth aligning. This route also relies on the global limiter alone, where the public checkout twin carries `writeLimiter`.

**L-2 — `JSON.parse(raw) as T` on AI SEO output** (`ai.service.ts:336`, `:449`, `:646`). Runtime shape is unvalidated. Now that the render sink is escaped this is a data-quality issue rather than an injection one, but the palette extractor shows the right pattern (a zod schema per field) and the SEO paths should follow it.

Both are logged rather than silently dropped, per Rule B.

## Lens registration

Registered as a reusable lens for the audit fleet so it reruns against the other projects rather than being spent once here — see `reference-builder-reality-audit.md` (extension point) and the memory entry written alongside this audit.
