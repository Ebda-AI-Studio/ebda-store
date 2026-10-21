# Adversarial audit — Cross-tenant isolation (slug: `tenant-isolation`)

Attacker model: a paying Ebda Store tenant, fully authenticated as `store_admin` of their OWN store, trying to read or write another merchant's data. Production runs the DB as a **BYPASSRLS** role (`neondb_owner`), so RLS is inert — tenant isolation rests ENTIRELY on app-layer `where: { storeId }` scoping + `requireStoreAccess`. Every finding below was confirmed by reading the actual `where` clause / middleware chain end to end, not from grep counts.

Severity counts: **P0 ×2, P1 ×1, P2 ×3, P3 ×6.**

> **Status note (2026-09-02, #1166):** see the "Remediation status" table in
> `docs/audits/2026-09-02-adversarial-audit.md` for the authoritative per-finding fixed/open state
> — this branch merged in ahead of two remediation PRs, so several P2s below (the global AI quota
> in particular) may already be closed.

---

### [P0] Cross-tenant absolute inventory write via stock-adjustment (variant + product), no storeId on the write

- **Where:** `apps/api/src/services/accounting/stock-adjustment.service.ts:55-58` (snapshot) and `:136-139` (post-write). Second entry point (same root cause): `apps/api/src/services/barcode-scan.service.ts:393-398` + `:513-527` (barcode cycle-count reconcile calls the same `createAdjustment`/`postAdjustment`).
- **Attack — SUMMARY, reproduction trimmed 2026-09-02 (P0, still open; see `docs/audits/2026-09-02-adversarial-audit.md` P0-1 for current fix status):** an authenticated `store_admin` of store A harvests a competitor's `productId`/`variantId` from the public storefront, then submits and posts a stock adjustment naming those foreign ids inside their own store's authorized flow — every middleware gate passes because it correctly checks A owns the _adjustment_, not that the _item lines_ resolve inside A. Exact request bodies are recoverable from the fix commit once P0-1 lands (the diff shows the before/after `where` clause and is a stable, less abusable record than a standing exploit recipe).
- **Damage:** Sets the **absolute** inventory of ANY variant (or product) in ANY other store to any value — zero out a competitor's stock (denies their sales / triggers OOS) or inflate it (breaks their fulfillment). Also drops `InventoryHistory` rows + a GL journal in the attacker's store referencing foreign products.
- **Evidence:** Snapshot query omits storeId — `prisma.productVariant.findFirst({ where: { id: item.variantId, productId: item.productId } })` (`stock-adjustment.service.ts:56`). The variant branch never checks storeId (the product-only branch at `:64-66` DOES: `where: { id, storeId }` — asymmetry proves the omission is a bug, not design). Post-write: `tx.productVariant.update({ where: { id: item.variantId }, data: { inventory: item.newQty } })` (`:136-139`) and `tx.product.update({ where: { id: item.productId }, data: { inventory: item.newQty } })` (`:143-146`) — both key on a bare, attacker-supplied id. The post guard `stockAdjustment.findFirst({ where: { id, storeId } })` (`:127`) only confirms the _adjustment_ belongs to store A (it does — A created it); it does nothing about the foreign product/variant ids on the item lines.
- **Why prior audits missed it:** `docs/audits/2026-07-15-api-tenant-scoping-idor-audit.md` swept the older route surface; the Batch-2 accounting routers (stock-adjustments, purchase-orders, expenses) are contextless Phase-2 routers whose _service internals_ were never traced for bare-id writes. The audit's "Verified safe" list does not cover `services/accounting/*`.
- **Blast radius:** Same class — service functions in `services/accounting/*` and `barcode-scan.service.ts` that take body `productId`/`variantId` and write by bare id. See the PO-receive P0 below. `upload.routes.ts` already fixed this exact class with `checkStoreAccess` — use it as the template.
- **Fix:** In `createAdjustment`, scope the variant snapshot `where: { id: item.variantId, product: { storeId: input.storeId } }` (and keep the product branch's storeId); reject any item whose product/variant doesn't resolve within the store BEFORE creating the adjustment. Add `product: { storeId }` to the post-write updates as belt-and-braces.

---

### [P0] Cross-tenant inventory + WAC-cost write and foreign backorder/order-item tampering via purchase-order receive

- **Where:** `apps/api/src/services/accounting/purchase-order.service.ts` — `createPurchaseOrder` `:40-46` (writes body `productId`/`variantId`/`supplierId` unscoped) and `receivePurchaseOrder` `:124-133` (foreign backorder read), `:142-148` (foreign backorderLine update), `:172-177` (foreign orderItem update), `:200-206` (foreign variant increment), `:224-231` (foreign product inventory + costPrice write). Foreign-supplier read-back via `getPurchaseOrder` `include: { supplier: true }` (`:309-322`).
- **Attack — SUMMARY, reproduction trimmed 2026-09-02 (P0, still open; see `docs/audits/2026-09-02-adversarial-audit.md` P0-2 for current fix status):** same shape as the stock-adjustment P0 above — a store A admin creates a purchase order naming a competitor's product/variant/supplier ids, then receives it; every gate checks the PO belongs to A, none check the item lines resolve inside A. Exact request bodies are recoverable from the fix commit once P0-2 lands.
- **Damage:** Writes a competitor's product `inventory` and `costPrice` (WAC), increments foreign variant inventory, and falsely marks a **different store's real customer backorder** as fulfilled (`backorderLine.update`) + flips that customer's `orderItem.costPriceDeferred`. Plus a full read of an arbitrary foreign `Supplier` row (name, phone, email, address, payment terms) once its id is planted on the PO.
- **Evidence:** `createPurchaseOrder` does `prisma.purchaseOrder.create({ data: { storeId: input.storeId, supplierId: input.supplierId, items: { create: input.items.map(i => ({ productId: i.productId, variantId: i.variantId, ... })) } } })` (`:27-49`) with zero ownership checks on supplier/product/variant. `receivePurchaseOrder`'s only guard is `if (!po || po.storeId !== input.storeId) throw 404` (`:97-98`) — the PO is store A's, so it passes; the item loop then updates foreign rows by bare id (`tx.product.update({ where: { id: item.productId }, ... })`, `:224`). The backorder query `tx.backorderLine.findMany({ where: { productId: item.productId, variantId: item.variantId ?? null, fulfilledAt: null } })` (`:124-133`) has no storeId — contrast `backorder.service.ts` which scopes `{ id, storeId }` correctly.
- **Why prior audits missed it:** same as above — accounting service internals unaudited by the 2026-07-15 IDOR sweep.
- **Blast radius:** identical defect class to the stock-adjustment P0.
- **Fix:** In `createPurchaseOrder`, validate every `productId`/`variantId`/`supplierId` resolves within `input.storeId` before create; in `receivePurchaseOrder`, constrain every product/variant/backorder/orderItem query to `storeId` (backorders already have the correct pattern in `backorder.service.ts`).

---

### [P1] CSRF JSON-skip trusts merchant custom-domain origins → credentialed cross-origin API access (incl. as super_admin)

- **Where:** `apps/api/src/middleware/security.ts:149-156` — the JSON/XHR CSRF skip condition is `isJsonOrXhr && (isPlatformOrigin(origin,…) || isAllowlistedMerchantOrigin(origin))`. Helper: `apps/api/src/lib/cors-cache.ts:95-116`. CORS allows the same origins with `credentials: true` (`apps/api/src/index.ts:239-288`). Auth token is read from the `token` cookie (`middleware/auth.ts:43-45`), which is `sameSite:'none'; secure` in prod (`routes/auth.routes.ts:25`).
- **Attack — SUMMARY, reproduction trimmed 2026-09-02 (P0, still open; see `docs/audits/2026-09-02-adversarial-audit.md` P0-3 for current fix status):** a paying merchant self-registers a custom domain they control (Cloudflare's `addDomain` accepts it with no ownership proof, so the DB row exists regardless of DNS), points its DNS at their own attacker-controlled page, and lures a logged-in victim (ideally a super_admin) there. The victim's browser then makes a credentialed, CSRF-exempt, cross-origin call the attacker's JS can also read the response of — because the merchant origin is both CORS-allowlisted with credentials and exempted from the CSRF token check. The full request/response mechanics and the destructive sink this reaches are recoverable from the fix commit once P0-3 lands (dropping the `isAllowlistedMerchantOrigin` OR from the CSRF skip).
- **Damage:** Full authenticated API access as the victim from an attacker-controlled page — CSRF _and_ response exfiltration. Against a super_admin this is cross-tenant read/write of every store; against another store_admin it rides their session.
- **Evidence:** The middleware's own load-bearing comment (`security.ts:133-145`) says the skip "MUST gate on the request's Origin being a PLATFORM origin, not 'any allowed origin' … The CSRF-token verifier below catches that case." But the actual condition ORs in `isAllowlistedMerchantOrigin`, so the verifier is never reached for merchant origins. `cors-cache.ts:95-116` confirms `isAllowlistedMerchantOrigin` returns true for any DB-registered custom domain in the CORS cache.
- **Why prior audits missed it:** **FALSIFIES** `docs/audits/2026-07-02-security-surface.md:268-275`, which claims: _"CSRF — `csrfProtection` correctly scopes its JSON/XHR skip to platform-controlled origins only (not 'any CORS-allowed origin' — the code's own comment explains why that distinction matters against a malicious merchant setting attacker.com as their store domain)."_ The audit read the comment, not the condition — the condition contradicts the comment.
- **Blast radius:** every state-changing non-`/auth` non-`/public` non-Bearer route behind `csrfProtection` (mounted globally at `index.ts:412`). The socket.io CORS (`services/socket.service.ts:53-86`) does NOT include merchant origins (platform-only) — so that surface is safe, which is the correct pattern the HTTP CSRF path should copy.
- **Fix:** Drop `|| isAllowlistedMerchantOrigin(origin)` from the CSRF skip (`security.ts:155`). Guest-checkout/cart/review POSTs from real merchant storefronts are already served by the platform storefront origin OR use no session cookie, so requiring a CSRF token (or gating on a same-origin custom header) for merchant origins does not break them. Separately, do not treat an unvalidated CF custom hostname as a trusted CORS origin — require `ssl.status==='active'` before caching the domain as allowed.

---

### [P2] Admin manual-order creation writes an unvalidated `customerId` → cross-tenant PII read + false attribution

- **Where:** `apps/api/src/services/order.service.ts:1631` (`customerId: data.customerId ?? null` in `tx.order.create`). Schema: `routes/order.routes.ts:1380` (`customerId: z.string().uuid().optional()`).
- **Attack:** `POST /stores/<A>/orders/admin` with `customerId:<any-user-uuid>`. Product/variant/coupon are all validated against store A (`order.service.ts:1436-1464`), but `customerId` is never validated (not against storeId, not even that the id is a `customer` role). Read it back via `GET /stores/<A>/orders/<id>` whose include selects `customer:{ id,email,firstName,lastName }`.
- **Damage:** Attach any platform user to a fabricated order in the attacker's own store → read that user's name+email (cross-tenant PII), plus false purchase attribution and downstream loyalty/notification side effects fired at a stranger.
- **Evidence:** confirmed no `customerId` ownership/role check anywhere in `createAdminOrder` (`order.service.ts:1401-1640`).
- **Blast radius:** any admin write path that accepts a body `customerId`/`userId` without validating it (grep `customerId: data.` in services).
- **Fix:** validate `customerId` resolves to a `customer`-role user linked to this store (e.g. has a prior order or membership) before writing it. Downgraded from P1 only because exploiting the _read_ requires knowing/guessing a 128-bit foreign user UUID (not publicly enumerable), unlike product/variant ids.

---

### [P2] Review AI tools read reviews cross-tenant (`summarizeProductReviews` / `draftOwnerResponse`)

- **Where:** `apps/api/src/lib/ai/review-tools.ts:164-166` (`review.findMany({ where: { productId, status:'published', verifiedPurchase:true } })`, no storeId) and `:217-225` (`review.findUnique({ where: { id: reviewId } })`, no storeId). Routes: `routes/review.routes.ts:388-396` (`POST /reviews/admin/products/:productId/summary`) and `:367-376` (`POST /reviews/admin/:id/draft-response`) — both pass `req.params.productId`/`:id` straight through.
- **Attack:** `POST /stores/<A>/reviews/admin/products/<B-product>/summary`. `requireStoreAccess` only checks the caller owns store A; the productId belongs to store B (public, harvestable). Returns an AI competitive-intelligence summary (top positives/negatives, sentiment, exact `reviewCount` of verified purchases) for any competitor product. `draft-response` similarly drafts a reply grounded in a foreign review's body/rating/title + foreign store name.
- **Damage:** cross-tenant read of derived review data + exact verified-purchase counts. Low data sensitivity (reviews are public on the storefront) but it is genuine unauthorized cross-store compute + a private-count leak, and it burns the global AI quota (see below).
- **Evidence:** ReviewService's own CRUD (`approve/reject/update/delete/create`) is correctly storeId-scoped (`review.routes.ts:236,260,311,347`); only these two AI helpers bypass it.
- **Blast radius:** any `lib/ai/*` helper that keys on a bare `productId`/`reviewId`/`orderId` from a route param.
- **Fix:** thread `storeId` into both helpers and add it to the `where` clauses.

---

### [P2] Platform-wide (non-per-tenant) AI request quota → cross-tenant griefing / feature DoS

- **Where:** `apps/api/src/lib/ai-quota.ts:93-115` — `assertAiQuota()`'s global-scope leg counts `prisma.aiUsage.count({ where: { createdAt: { gte: startOfDay }, cachedHit: false } })` with **no storeId filter** — a single global counter. Caps `DEFAULT_DAILY_REQUEST_CAP=450`, `DEFAULT_MONTHLY_REQUEST_CAP=20000` (`:67-68`). Called before the (correctly per-store) `checkBudget` in every AI feature (`services/ai.service.ts:328,394,483,679`). _(Line numbers corrected 2026-09-02, per #1158, against the file as merged in PR #1134, which also added a per-store daily slice layer above the global cap not reflected in this finding's original framing — see the function's own doc comment for the current layer order.)_
- **Attack:** authenticated `store_admin` of their own store posts unique, never-cached text to `POST /stores/<A>/ai/translate` at the `writeLimiter` ceiling (30/min/IP, not store-keyed — `middleware/security.ts:282-291`). ~15 min exhausts the 450/day global cap; sustained traffic burns the 20,000/month cap.
- **Damage:** denies AI translate / SEO / section / categorize to **every other tenant** for the rest of the day/month, entirely from actions on the attacker's own store.
- **Evidence:** the global count is intentional per the code comment (`ai-quota.ts:55-58`) but intentional-or-not it is exactly a shared resource one tenant can exhaust for all others. Per-store token budget (`checkBudget`, `ai.service.ts:137-141`) IS correctly scoped and is not the hole. **Status (2026-09-02):** PR #1134 added a per-store daily slice (`DEFAULT_STORE_DAILY_REQUEST_CAP`, `ai-quota.ts:69-74`, comment cites this finding by name) beneath the global cap — re-verify whether this closes the finding before treating it as still open.
- **Blast radius:** every AI feature gated by `assertAiQuota`.
- **Fix:** make the request cap per-store (or per-plan) like `checkBudget` already is; keep a global cap only as a platform circuit-breaker with alerting, not as the first-hit limit.

---

### [P3] Edge-cache `Vary` omits the real cache-key input on `GET /public/store/resolve` (dormant)

- **Where:** `apps/api/src/lib/edge-cache.ts:44` hardcodes `Vary: x-store-id`; every `setEdgeCache` call site omits `varyOn` (`public.routes.ts:225,263,312,327,1134,1285,1324,1485`). `/store/resolve` keys only on `x-store-domain` (`public.routes.ts:1340`) and never reads `x-store-id`.
- **Damage (latent):** if a CDN cache rule ever caches this `Cache-Control: public, s-maxage=120` response, it would key on an always-absent header and serve the first domain's store payload to every other domain for ~120–720s.
- **Evidence / blind spot:** live-verified read-only — `api.ebda.app` is Cloudflare-proxied but returns `cf-cache-status: DYNAMIC` (not currently edge-cached), so **no live leak today**. Settled by a CDN config check.
- **Fix:** pass `varyOn:['x-store-domain']` for domain-keyed responses, or fold the domain into the cache-relevant response identity.

### [P3] AI `translate` Redis cache key omits storeId

- **Where:** `apps/api/src/services/ai.service.ts:283-286` — `cacheKey('translate', { text, from, to, kind })`, no storeId (siblings `suggestSeo`/`suggestSectionContent` hash the storeId-bearing `input`; `suggestCategories` hashes store-owned UUIDs). 7-day TTL.
- **Damage:** marginal — a reader only benefits by submitting byte-identical text they already possess (a free/uncounted translation), not another tenant's private data; a prompt-poisoning angle needs the victim to submit the attacker's exact string.
- **Fix:** add storeId to the translate cache payload for consistency.

### [P3] Product create/update links categories without storeId check

- **Where:** `apps/api/src/services/product.service.ts:684-690` (create) and `:819-825` (update) link body `categories[]` via `productCategory.create` with no per-category storeId check. The same file's `bulkUpdate.addCategoryId` (`:1030-1040`) explicitly guards this exact bug — guard never applied to plain create/update.
- **Damage:** low — links a foreign categoryId into the product↔category graph; category name/image are already public via `/public/:storeId/categories`, so no data a competitor couldn't already see.
- **Fix:** validate each categoryId belongs to `storeId` (reuse the `bulkUpdate` guard).

### [P3] Expense / bank-statement accounting refs unscoped (name/code leak, UUID-gated)

- **Where:** `services/accounting/expense.service.ts:128-129` (`supplierId`, `expenseAccountId` unchecked; `paidFromAccountId` IS checked at `:63-66`). `services/accounting/bank-reconcile.service.ts:145-152` (`glAccountId` from `routes/finance.routes.ts:1077`, unchecked). Read-back includes select foreign `code/nameEn/nameAr`.
- **Damage:** low — leaks a foreign account/supplier name+code; gated by guessing a 128-bit Account UUID (no public endpoint exposes them).
- **Fix:** scope `expenseAccountId`/`supplierId`/`glAccountId` to `storeId` before write; harden `journal.service.ts:postEntry` (`:107-112`) to reject unscoped `accountId` at the primitive level.

### [P3] `DEFAULT_STORE` fallback renders a demo store instead of 404 on 3 pages

- **Where:** `apps/web/src/app/faq/page.tsx:10`, `how-to-guides/page.tsx:11`, `blog/[slug]/page.tsx:14,28` use lenient `getStore()` (`lib/store-resolver.ts:524-543` → `DEFAULT_STORE`) instead of `getStoreOrNotFound()`.
- **Damage:** UX/consistency only — an unresolvable domain/slug renders the neutral "Force" demo stub, not another tenant's data (`DEFAULT_STORE` is a static stub, not a `findFirst` on real stores).
- **Fix:** use `getStoreOrNotFound()` on these three pages like every sibling route.

### [P3] Public layout draft token uses `Math.random()`

- **Where:** `apps/api/src/routes/store-layout.routes.ts:869` — token `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}` (~41 bits, 1h TTL). Read path `public-store-layout.routes.ts:16` is unauthenticated.
- **Damage:** low — brute-forcing another store's live token yields only their _unsaved layout draft_ (no PII/secrets); the Redis key is storeId-scoped (`layout-preview:${storeId}:${token}`) so a pasted token can't cross tenants.
- **Fix:** use `crypto.randomBytes` for the token.

---

## FALSIFIED (prior-audit PASS disproved)

- **`docs/audits/2026-07-02-security-surface.md:268-275`** — claim: CSRF JSON/XHR skip is scoped to platform origins only, "not any CORS-allowed origin." **Counter-evidence:** `security.ts:149-156` ORs in `isAllowlistedMerchantOrigin`, so any DB-registered merchant custom domain skips the CSRF token check. See the P1.
- **`docs/audits/2026-07-15-api-tenant-scoping-idor-audit.md`** — implicitly presents the IDOR surface as swept and remediated. **Counter-evidence:** the Batch-2 accounting service internals (`services/accounting/stock-adjustment.service.ts`, `purchase-order.service.ts`, `expense.service.ts`, `barcode-scan.service.ts`) and the review AI helpers (`lib/ai/review-tools.ts`) contain live cross-tenant IDOR writes/reads that the audit's "Verified safe" list never covered.

## UPHELD (attacked hardest, could NOT break)

- **Payment-webhook cross-tenant forgery.** `POST /webhooks/payment/:provider` resolves storeId from the matching Payment row (`webhook.routes.ts:393-435`) then verifies the HMAC with THAT store's secret (`payment.factory.ts:794-846`) AND re-asserts `payment.order.storeId === resolvedStoreId` (`:895-905`). To forge a cross-tenant confirmation an attacker needs the victim store's webhook secret — not obtainable. Solid.
- **`requireStoreAccess` + store-resolution default-to-first.** `getStoreIdFromRequest` (`utils/store-helpers.ts:29-54`) throws 400 on unresolved input — the old "demo-boutique catalogue leaked into every storefront" default-to-first bug is genuinely fixed; the global-memory "never default to first store" rule holds here. `requireStoreAccess` param precedence (`middleware/store-access.ts:24-40`) prefers `:storeId` over `:id`, blocking the nested-param confusion.
- **Host/domain resolution.** `apps/web/middleware.ts` reads the tenant from the `Host` header only — no `X-Forwarded-Host`/spoofable header is trusted anywhere (grep-empty). `/tenant-store/*` direct external hits are hard-404'd (`middleware.ts:390-392`). `apps/orders` re-derives access via `checkStoreAccess` against the authenticated user's real membership, ignoring the client-supplied `?store=`. Prior C2 (smart-layer accept/clearance — `purchase-order.service.ts:348` now `findFirst({ where:{ id, storeId } })`) and C3 (wa-bridge meta-catalog now rejects body-storeId mismatch, `wa-bridge.routes.ts:1129-1133`) are confirmed fixed. R2 upload keys are `stores/<storeId>/…` with `checkStoreAccess` re-verification (`upload.routes.ts:105-151,394-471`).

## BLIND SPOTS

- Whether Cloudflare ever applies a "cache everything" rule to `api.ebda.app/public/*` — would flip the P3 `Vary` bug live. Settle with a CDN config read or repeated `curl -sI` watching `cf-cache-status`.
- The accounting IDORs are backstopped at the DB level ONLY after the RLS the earlier app role cutover; prod is BYPASSRLS today, so there is no second line. Settle by confirming `DATABASE_URL` role (`SELECT current_user, rolbypassrls`).
- Variant/product-id harvestability assumed from `/public/:storeId/products` shape (static read); a live `curl` against a real storefront would confirm the exact fields returned.
