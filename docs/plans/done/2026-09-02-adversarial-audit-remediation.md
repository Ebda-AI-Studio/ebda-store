# Adversarial Audit Remediation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` or
> `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix every finding from the 2026-09-02 adversarial audit (4 P0, 7 P1, 12 P2, 17 P3),
sweeping each defect _class_ rather than each instance, and bring the repo's own record back into
agreement with reality.

**Architecture:** Three PRs by defect class so the exploitable-now work merges without waiting on
the hygiene tier. Every task ends with a blast-radius grep whose result is stated in the PR body.

**Tech Stack:** Express+TS API (`apps/api`), Next.js 16 on Cloudflare Workers (`apps/{web,admin,orders}`),
Prisma + Neon, Redis, Inngest, vitest, GitHub Actions on self-hosted runners.

**Spec:** `docs/audits/2026-09-02-adversarial-audit.md` (+ per-agent slices in
`docs/audits/_slices/2026-09-02-adversarial/`).

## Global Constraints

- **Every finding is a sample of a class.** Fix the class, then grep for siblings. A task is not
  done until its blast-radius grep is run and its result recorded.
- **Verify before assert.** Confirm each cited line still says what the audit says before changing it.
- Money is integer minor units. Never introduce float arithmetic on money.
- `git add` specific paths, never `-A` or `.`.
- Tenant scoping is app-layer only — production is BYPASSRLS, so there is no DB backstop. Every
  `where` on a tenant-owned row must carry `storeId` (directly or via a relation filter).
- Migrations are expand/contract, with the rollback written alongside. `CREATE INDEX CONCURRENTLY`
  for any index on a live table.
- No `continue-on-error` or `|| true` on a security gate.

---

# PR 1 — P0 security (branch `fix/audit-p0-security`)

## Task 1: Stamp the reversal marker in the payment-failure rollback (P0-4)

Stops active production inventory drift. One line; highest value per unit of risk.

**Files:**

- Modify: `apps/api/src/services/order.service.ts` (`rollbackForPaymentFailure`, ~1009-1122)
- Test: `tests/integration/refund-reversal-idempotency.test.ts` (create)

**Interfaces:**

- Produces: `rollbackForPaymentFailure` leaves `orders.refundReversedAt` non-null, which
  `refund-reversal-stuck-sweep` uses as its "already reversed" predicate.

- [ ] **Step 1: Write the failing test** — an order rolled back by `rollbackForPaymentFailure`
      must not be selected by the sweep's predicate.

```ts
it('marks a payment-failure rollback as already-reversed so the sweep skips it', async () => {
  const order = await seedPendingOrder({ storeId, items: [{ productId, quantity: 3 }] });
  const before = await prisma.product.findUniqueOrThrow({ where: { id: productId } });

  await rollbackForPaymentFailure(storeId, order.id, sessionId);

  const rolled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(rolled.status).toBe('cancelled');
  // The reversal already happened inline — the sweep must not see it as pending.
  expect(rolled.refundReversedAt).not.toBeNull();

  const sweepCandidates = await prisma.order.findMany({
    where: { status: { in: ['cancelled', 'refunded'] }, refundReversedAt: null, storeId },
  });
  expect(sweepCandidates.map(o => o.id)).not.toContain(order.id);

  const after = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  expect(after.inventory).toBe(before.inventory + 3); // restored exactly once
});
```

- [ ] **Step 2: Run it and watch it fail**

`npx vitest run tests/integration/refund-reversal-idempotency.test.ts`
Expected: FAIL — `refundReversedAt` is `null`.

- [ ] **Step 3: Stamp the marker inside the same transaction as the reversal**

In `rollbackForPaymentFailure`, in the `tx` block that already sets `status: 'cancelled'`, add
`refundReversedAt: new Date()` to the same `tx.order.update` data. It must be the _same_
transaction — a separate write reintroduces the window.

- [ ] **Step 4: Run the test — expect PASS**

- [ ] **Step 5: Blast-radius sweep — every path that reverses inline then cancels**

```bash
grep -rn "refundReversedAt" apps/api/src | sort
grep -rn "rollbackForPaymentFailure" apps/api/src
grep -rn "type: 'adjustment'" apps/api/src/services apps/api/src/lib
```

Known second entry point: `apps/api/src/mcp/tools/order.tools.ts:242`. Confirm it routes through
the same function (it should — then it is fixed by this change; record that).
Record the result in the PR body as `blast-radius: … → clean` or `→ found + fixed N`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/order.service.ts tests/integration/refund-reversal-idempotency.test.ts
git commit -m "fix(orders): stamp refundReversedAt in the payment-failure rollback

The rollback reverses inventory and coupon usage inline under
InventoryHistory.type='adjustment' and never stamped refundReversedAt, so
refund-reversal-stuck-sweep re-sent order/refunded and the fanout — whose
marker is type='return_stock' — restored stock a second time and decremented
the coupon again. Fired organically on every failed payment-create."
```

## Task 2: Remove the merchant-origin CSRF exemption + gate the CORS allowlist on an active cert (P0-3)

**Files:**

- Modify: `apps/api/src/middleware/security.ts:149-157`
- Modify: `apps/api/src/index.ts:214-306` (CORS origin resolver)
- Modify: `apps/api/src/lib/cors-cache.ts` (cache population — require `ssl.status === 'active'`)
- Modify: `apps/api/src/routes/auth.routes.ts` (re-issue `csrfToken` on session refresh — see Step 4)
- Test: `tests/integration/csrf-merchant-origin.test.ts` (create)

**Interfaces:**

- Consumes: `isPlatformOrigin(origin, {webUrl, adminUrl, nodeEnv})` — unchanged.
- Produces: `isAllowlistedMerchantOrigin` remains exported for CORS use only; it must no longer be
  referenced anywhere in `csrfProtection`.

**Pre-verified safety (do not re-litigate, but do re-confirm the two greps):** `csrfProtection`
already returns early for `req.path.includes('/public/')` and for `Bearer` requests _before_
reaching this condition, so guest cart/checkout is unaffected. `apps/web/src/lib/api.ts:365-386`
already sends `X-Session-ID` on every request and `X-CSRF-Token` on every state-changing one.

- [ ] **Step 1: Write the failing test**

```ts
it('requires a CSRF token for a cookie-authed write from a merchant custom origin', async () => {
  await seedStoreDomain('evil.example'); // merchant-registered custom domain
  const res = await request(app)
    .post('/api/v1/stores/' + storeId + '/products')
    .set('Origin', 'https://evil.example')
    .set('Content-Type', 'application/json')
    .set('Cookie', victimAdminCookie) // no X-CSRF-Token
    .send({ name: 'x' });
  expect(res.status).toBe(403);
  expect(res.body.error.code).toMatch(/CSRF_/);
});

it('still lets a guest checkout through from a merchant custom origin', async () => {
  const res = await request(app)
    .post('/api/v1/public/orders')
    .set('Origin', 'https://evil.example')
    .set('Content-Type', 'application/json')
    .set('X-Session-ID', 'sess-1')
    .send(validGuestOrderBody);
  expect(res.status).not.toBe(403); // /public/ is exempt earlier in the chain
});
```

- [ ] **Step 2: Run it — the first test fails (currently 2xx), the second passes**

- [ ] **Step 3: Delete the exemption**

In `security.ts`, the condition becomes platform-origin only:

```ts
if (
  isJsonOrXhr &&
  isPlatformOrigin(origin, {
    webUrl: config.webUrl,
    adminUrl: config.adminUrl,
    nodeEnv: config.nodeEnv,
  })
) {
  return next();
}
```

Delete the now-unused `isAllowlistedMerchantOrigin` import from `security.ts` only. Update the
block comment: it already describes this exact attack — change "The CSRF-token verifier below
catches that case" to state that merchant origins now fall through to it, so the comment and the
code agree. **The comment was right and the code was wrong; keep the comment's reasoning.**

- [ ] **Step 4: Close the migration gap — re-issue `csrfToken` on session refresh**

A customer logged in before this change has no `csrfToken` in `localStorage` and would start
getting 403s on writes. Find the session-refresh / `/auth/me` response builder in
`apps/api/src/routes/auth.routes.ts` and include `csrfToken` in its payload exactly as the login
response does, then mirror `apps/web/src/lib/api.ts:517` so the client stores it on refresh.
Verify by grepping every `csrfToken` producer/consumer pair:

```bash
grep -rn "csrfToken" apps/api/src apps/web/src apps/admin/src apps/orders/src
```

- [ ] **Step 5: Require an active certificate before a domain enters the CORS allowlist**

In the CORS origin resolver (`index.ts`) the lookup is
`prisma.store.findFirst({ where: { domain: hostname } })` with no verification filter. Add the
store's domain-verification/SSL status to the `where` (the field written by
`CloudflareDomainService`; read the model before choosing the predicate) so a merely _pending_
custom hostname — which Cloudflare creates with no ownership proof — is not a trusted origin.

- [ ] **Step 6: Run the tests — both PASS**

- [ ] **Step 7: Blast-radius sweep**

```bash
grep -rn "isAllowlistedMerchantOrigin" apps/api/src        # expect: cors only, never csrf
grep -rn "corsDomainCache\|allowed: *true" apps/api/src/lib/cors-cache.ts
grep -rn "sameSite" apps/api/src/routes/auth.routes.ts
grep -rn "cors(" apps/api/src                              # every CORS surface incl. socket.io
```

`services/socket.service.ts:53-86` is already platform-only — confirm it stays that way.

- [ ] **Step 8: Commit** (message: the comment contradicted the condition since `619c43e7`, and
      `docs/audits/2026-07-02-security-surface.md:268-275` audited the comment)

## Task 3: Reject impersonation tokens on destructive self-service routes (P0-3 amplifier)

**Files:**

- Modify: `apps/api/src/middleware/auth.ts` (add `rejectImpersonated` guard)
- Modify: `apps/api/src/routes/auth.routes.ts` (`/auth/me/erase`, password change, email change)
- Test: `tests/unit/reject-impersonated.test.ts` (create)

- [ ] **Step 1: Write the failing test** — a token carrying `impersonatedBy` is rejected by the
      guard with 403, and a normal token passes.
- [ ] **Step 2: Run it — fails (guard does not exist)**
- [ ] **Step 3: Implement `rejectImpersonated`** — 403 `IMPERSONATION_FORBIDDEN` when
      `req.user?.impersonatedBy` is present. `admin.routes.ts:1704-1780` already sets the claim; this
      is the first reader of it.
- [ ] **Step 4: Apply it to account-destructive routes** — erase, password change, email change,
      `logout-all`.
- [ ] **Step 5: Run tests — PASS**
- [ ] **Step 6: Blast-radius sweep**

```bash
grep -rn "impersonatedBy" apps/api/src apps/admin/src
```

- [ ] **Step 7: Commit**

## Task 4: Scope every accounting write to the store (P0-1, P0-2, and the class)

This is one class with two P0 instances and several P2/P3 siblings. Fix it once, at the boundary.

**Files:**

- Create: `apps/api/src/services/accounting/assert-store-owns.ts`
- Modify: `apps/api/src/services/accounting/stock-adjustment.service.ts:56,136,143`
- Modify: `apps/api/src/services/accounting/purchase-order.service.ts:27-49,124-231`
- Modify: `apps/api/src/services/accounting/expense.service.ts:128-129`
- Modify: `apps/api/src/services/accounting/bank-reconcile.service.ts:145-152`
- Modify: `apps/api/src/services/barcode-scan.service.ts:393,513`
- Modify: `apps/api/src/lib/ai/review-tools.ts:164,217`
- Modify: `apps/api/src/services/order.service.ts:1631` (admin-order `customerId`)
- Modify: `apps/api/src/services/product.service.ts:684-690,819-825` (category linkage)
- Test: `tests/integration/accounting-cross-tenant.test.ts` (create)

**Interfaces:**

- Produces: `assertStoreOwns(tx, storeId, { productIds, variantIds, supplierIds, accountIds })`
  → resolves, or throws `AppError(404, 'NOT_FOUND')`. Must 404, never 403 — a 403 confirms the
  foreign id exists. Per the tenant-resolver rule: **throw, never default.**

- [ ] **Step 1: Write the failing tests** — one per entry point. Store A admin submits store B's
      `productId`/`variantId`/`supplierId`/`accountId`/`customerId`; every call must 404 and store B's
      rows must be byte-identical afterward.

```ts
it('refuses a stock adjustment naming another store’s variant', async () => {
  const before = await prisma.productVariant.findUniqueOrThrow({ where: { id: storeBVariantId } });
  await expect(
    createAdjustment({
      storeId: storeA,
      createdBy: adminA,
      type: 'recount',
      items: [{ productId: storeBProductId, variantId: storeBVariantId, newQty: 0 }],
    })
  ).rejects.toMatchObject({ statusCode: 404 });
  const after = await prisma.productVariant.findUniqueOrThrow({ where: { id: storeBVariantId } });
  expect(after.inventory).toBe(before.inventory);
});
```

- [ ] **Step 2: Run them — every one fails (the writes currently succeed)**
- [ ] **Step 3: Write `assertStoreOwns`** — one batched query per entity type
      (`findMany({ where: { id: { in: ids }, storeId }, select: { id: true } })`), compare the returned
      count to the requested set, throw 404 naming no foreign id.
- [ ] **Step 4: Call it at the top of every entry point above, before any write.** Additionally
      add the relation filter to the writes themselves as belt-and-braces:
      `where: { id: item.variantId, product: { storeId } }`. Templates already in-repo:
      `upload.routes.ts:105-151` and `backorder.service.ts`.
- [ ] **Step 5: Run tests — all PASS**
- [ ] **Step 6: Blast-radius sweep — the whole class, not the two reported instances**

```bash
# unscoped writes keyed on a bare body id
grep -rnE "tx\.(product|productVariant|backorderLine|orderItem|supplier|account)\.update\(\{\s*where:\s*\{\s*id:" apps/api/src
# service-layer finders with no storeId in the where
grep -rnE "(findFirst|findUnique|findMany)\(\{\s*where:\s*\{\s*id:" apps/api/src/services apps/api/src/lib/ai
# body ids trusted straight into a create
grep -rn "productId: i\.\|variantId: i\.\|supplierId: input\.\|customerId: data\." apps/api/src/services
```

Read every hit before recording it — most will be correctly scoped one frame up. State the count
examined vs. count fixed.

- [ ] **Step 7: Commit**

## Task 5: Route carrier base URLs through the SSRF guard and widen the lint rule (P1-1)

**Files:**

- Modify: `apps/api/src/services/carriers/icarry.carrier.ts:53-54`
- Modify: `apps/api/src/routes/shipping-carrier.routes.ts:18` (schema)
- Modify: `apps/api/eslint.config.mjs` (widen the SSRF selector beyond `routes/**`)
- Test: `tests/unit/carrier-ssrf.test.ts` (create)

- [ ] **Step 1: Write the failing test** — `resolveBaseUrl` must reject `169.254.169.254`,
      `127.0.0.1`, `*.railway.internal`, RFC1918 and any non-http(s) scheme; and accept the default.
- [ ] **Step 2: Run it — fails (the merchant string is returned verbatim)**
- [ ] **Step 3: Guard it** — pass `resolveBaseUrl`'s result through `assertPublicHttpUrl()` from
      `apps/api/src/lib/safe-fetch.ts` before every use. Tighten the write-side schema so `baseUrl` is
      a validated `z.string().url()` (or drop it from `ICarryCredentials` entirely — the carrier ships
      a hardcoded default and `aramex.carrier.ts:16` proves the pattern works without an override).
- [ ] **Step 4: Widen the ESLint SSRF selector to `services/**`** — the rule was correct and
correctly scoped; the class was invisible because the fetch lives outside `routes/\*\*`. Without
      this step the class recurs on the next carrier.
- [ ] **Step 5: Run the test + `npx eslint apps/api/src --max-warnings=0`**
- [ ] **Step 6: Blast-radius sweep**

```bash
grep -rn "fetch(" apps/api/src/services | grep -v "safe-fetch" | grep -vE "https?://[a-z]"
grep -rn "baseUrl\|base_url\|endpoint" apps/api/src/services/carriers apps/api/src/services/payment-providers
grep -rn "z.record(z.string()" apps/api/src/routes
```

- [ ] **Step 7: Commit**

## Task 6: PR 1 verification gate

- [ ] `npx tsc --noEmit` clean across workspaces
- [ ] `npx vitest run tests/unit tests/integration` green
- [ ] `npx eslint apps/api/src --max-warnings=0`
- [ ] PR body states the blast-radius result for each of Tasks 1-5
- [ ] Open the PR; do **not** admin-merge past a red security gate

---

# PR 2 — money + availability correctness (branch `fix/audit-p1-correctness`)

## Task 7: Item-level refund effects (P1-2)

`return.service.ts:367-437`, `order.service.ts:1319-1355`, `order-refunded.ts`. Thread the returned
item list + quantities through the `order/refunded` event so a partial return restores only what
came back; make the gateway-partial path apply local effects too (it currently applies none). Fix
the wrong comment at `:425-430`. Add the cumulative previously-returned-quantity check in
`create` (`:159-167`) so the same item cannot be returned twice.
Blast radius: every `order/refunded` consumer — inventory, coupon, affiliate, loyalty, backorders,
`accounting-post-refund-journal`.

## Task 8: Idempotent payment creation (P2)

`payment.routes.ts:196-330`. If the order already has a non-failed Payment, return the existing
`paymentUrl` instead of minting a second invoice; make the COD fee conditional on there being no
prior COD payment row. Add a duplicate-capture alert for "second completed payment on one order".
Blast radius: `retryPayment` (`payment.factory.ts:1297+`), checkout order creation.

## Task 9: Order/payment state ordering + reconciliation (P2)

Assert the order transition _before_ writing `Payment.status` (`payment.factory.ts:1141` vs `:1184`)
— mirror `payment-confirm.service.ts:222-228`. Add `assertValidTransition` to the unguarded writer
at `order.routes.ts:1154-1158`. Add "completed payment on a cancelled order" to a reconciliation
sweep. Move the refund-webhook idempotency write to _after_ `applyRefundEffects` succeeds
(`payment.factory.ts:920-955,1005-1015`) so a failed dispatch is retryable rather than silently
swallowed.

## Task 10: Search floor + trigram index (P1-3)

Add a minimum search length (mirror `/search/suggest`'s `>= 2` at `public.routes.ts:922`) and a
`pg_trgm` GIN index on `name`/`nameAr`. **Migration safety:** `CREATE EXTENSION IF NOT EXISTS
pg_trgm` + `CREATE INDEX CONCURRENTLY`, expand-only, rollback written alongside. Verify with
`EXPLAIN (ANALYZE, BUFFERS)` before and after.

## Task 11: Store-status cache invalidation (P1-7)

`store.routes.ts:609-618` — call the existing `invalidateStoreCaches(id, slug, domain)` and fire the
`revalidateTag` purge, exactly as the domain-change path at `:1325` does.
Blast radius: **every** writer of `store.status` or store lifecycle, including Inngest jobs and any
soft-delete/archive path. This is the `feedback-cache-invalidate-every-write-path` rule: account
status is NEVER-stale.

## Task 12: Limiter failure posture + per-tenant AI budget (P2)

Set `passOnStoreError: true` on all 12 limiters and the global one, or have `makeRateLimitStore`
return `undefined` when `!isConnected` so express-rate-limit falls back to memory instead of 500ing
(`security.ts:223`, `redis.service.ts:71-73`). Add a per-store daily Gemini _request_ cap beneath
the global one (`ai-quota.ts:64`) and reserve headroom for interactive calls so a bulk sweep cannot
zero the platform. **Keep the global cap** — it protects the real Google project ceiling; the fix is
a per-tenant slice below it, not its removal. Add a per-tenant dimension to the expensive public
limiters.

---

# PR 3 — the record and the gates (branch `fix/audit-record-and-gates`)

## Task 13: Correct `CLAUDE.md` (explicitly requested)

The live API host is `api.ebda.app` (verified: 200 via Cloudflare). The documented
`api-production-c058.up.railway.app` returns `404 / x-railway-fallback: true /
"Application not found"` — no service is bound to it. Correct the "Tech stack + deployment" line,
and sweep every other doc repeating it:

```bash
grep -rn "api-production-c058" . --exclude-dir=node_modules --exclude-dir=.git
```

Also correct the pre-push hook comment claiming blast-radius/scoped-audit/ai-review "moved OUT of
CI" — all three still run in CI, so they now run twice.

## Task 14: Kill the zombie preview gate (P1-4)

`.github/workflows/preview-env-isolation.yml` checks retired Vercel projects and `exit 0`s green on
every PR. Either delete it or rewrite it against the real surface (compare the `NEXT_PUBLIC_API_URL`
bound into CF preview builds vs production — the value is already in repo variables). **A gate that
cannot fail must not report success.**

## Task 15: Make orphan tests impossible (P1-5)

Add the 4 orphans to the CI glob (`apps/web/src/app`, `apps/web` root — all four are pure/no-DB),
then add the gate that prevents recurrence: a CI step diffing `vitest list` (root config, minus
`tests/smoke`) against the union of files the unit+integration+e2e jobs execute, failing on any
orphan. Without the gate this recurs — it already did once.

## Task 16: Resurrect the perf layer, or stop claiming it (P1-6)

Add the standard Telegram notify-failure job to `lighthouse-nightly.yml` **and every other scheduled
workflow lacking one** (that absence is why a 7-week red went unnoticed). Fix the runner's Chrome
install. For k6: either wire one scenario to a real cadence or delete the load layer from the record
— do not leave `loadtests/` claiming a layer that has never produced a green run.

## Task 17: Close the gate loopholes (P2)

Replace gitleaks' blanket `*.test.ts` / `__tests__/**` path allowlist with literal-value entries
(the file already has 12 — the mechanism works). Remove `.gitleaks.toml`/`.gitleaksignore` from the
CI docs-only `paths-ignore` filter so weakening a security gate counts as a code change. Add
`E2E Tests` and `Client secret scan` to required checks. In `scoped-audit`, distinguish "model ran,
found nothing" from "model never ran" via a sentinel, and alert when it is absent (tracked: #1115,
#1116).

## Task 18: Retire or ratchet the fossils (P2/P3)

Replace `FIXES.md` with a 5-line pointer (it presents long-fixed items as open P0s while
understating the one still-true item, T0-1 RLS). Refresh the 6-week-stale `handoff.md`. Either
re-run Stryker and set `break` to the current per-file score so it can only ratchet up, or retire
`stryker.conf.json` so the record stops claiming mutation testing exists. Wire the Playwright smoke
suite into `cf-deploy.yml` as a post-deploy check and fix its legacy default URLs.

## Task 19: Correct the audit record itself

In `docs/audits/2026-08-31-reel-derived-lenses.md`, re-mark L16 as
**PASS-provisioned / INERT-in-prod (cutover parked)** and L20 as a FAIL (Sentry is error tracking,
not SLO/burn-rate). Add to the lens pack the rule this audit produced: _a PASS must name its
enumeration and cite the runtime fact, never the declaration that intends it_ — an RLS verdict cites
`pg_roles.rolbypassrls`, never a policy count.

---

## Out of scope — decisions, not defects

- **The RLS cutover stays parked.** Ahmad's explicit decision. Nothing here flips it. Task 19 only
  corrects the _record_ so no future reader assumes a backstop exists.
- **Storefront CSP `'unsafe-inline'`** (P3): removing it needs nonces for the inline theme/JSON-LD
  scripts and an OpenNext-compatibility check on `'unsafe-eval'`. Real work, own PR, and there is
  no live injection sink today. Logged, not bundled here.
- **Guest self-asserted identity for `firstOrderOnly` promos** (P3): the codebase documents
  accepting this for coupons. Bound it with a promotion-level usage cap if first-order promos carry
  real value — a product decision.
