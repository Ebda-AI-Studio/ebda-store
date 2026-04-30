# Force Website Builder — Hardening Plan

Synthesis of five parallel audits run on 2026-04-30. Findings deduplicated and prioritized by exploitability × tenant-isolation impact × time-to-fix.

| Audit                        | Critical | High    | Medium  | Total   |
| ---------------------------- | -------- | ------- | ------- | ------- |
| Multi-tenant isolation       | 13       | 22      | 19      | 54      |
| Security (OWASP / auth)      | 4        | 12      | 18      | 45      |
| Database (drift / RLS / N+1) | 6        | 16      | 18      | 46      |
| Runtime bugs                 | 15 (S0)  | 16 (S1) | 20 (S2) | 72      |
| Dependencies                 | 0        | 0       | 5       | 50      |
| **Total**                    | **38**   | **66**  | **80**  | **267** |

---

## Tier 0 — Apply now (real exploits or active data loss)

### T0-1 — RLS is bypassed in production

Production `DATABASE_URL` connects as `neondb_owner` which has `rolbypassrls = TRUE`. **Every RLS policy is silently ignored.** The 4-layer defense (route guard → tenantContext → Prisma WHERE → RLS) is effectively 3 layers; the route-guard gaps in T0-2 are exploitable today.

**Fix:** Create `force_app` role on Neon, set `DATABASE_URL` to use it, run `GRANT USAGE / SELECT / INSERT / UPDATE / DELETE` on schema. Verify with `SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user;`.

### T0-2 — Admin routes missing `requireStoreAccess`

Any authenticated store_admin can read/mutate other tenants' data by changing `:storeId` in the URL. Confirmed exploitable.

| File:Line                        | Route                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `order.routes.ts:70`             | `GET /stores/:storeId/orders`                                                         |
| `order.routes.ts:95`             | `GET /stores/:storeId/orders/:id`                                                     |
| `order.routes.ts:151`            | `PUT /stores/:storeId/orders/:id/status`                                              |
| `order.routes.ts:189`            | `GET /stores/:storeId/orders/:id/invoice` (admin)                                     |
| `order.routes.ts:209`            | `POST /stores/:storeId/orders/:id/invoice/email`                                      |
| `order.routes.ts:121`            | `POST /stores/:storeId/orders` (admin checkout)                                       |
| `category.routes.ts:40`          | `GET /stores/:storeId/categories`                                                     |
| `product.routes.ts:111,135,222`  | `GET /stores/:storeId/products[/search][/:id]` (also unauthenticated, returns drafts) |
| `upload.routes.ts:74-340`        | `POST/DELETE /uploads/*` (storeId from header, never verified)                        |
| `shipping-carrier.routes.ts:386` | `GET /public/:storeId/orders/:orderId/tracking` (admin role bypass)                   |
| `return.routes.ts:110`           | `GET /returns/:id` (ownership only checked when role==='customer')                    |

### T0-3 — Live secrets in `.env` on disk

`/Users/ahmadsharaf/Desktop/projects/force-website-builder/.env` contains real-looking Resend SMTP key, Vercel API token, Neon password, MinIO admin password. Gitignored, not in history, but readable to anyone with FS access. **Rotate now.**

### T0-4 — `app.set('trust proxy')` not configured

On Railway, `req.ip` resolves to the proxy IP. Every IP-keyed rate limiter (authLimiter, paymentLimiter, writeLimiter) is either a global counter or X-Forwarded-For-spoofable. Auth brute force protection effectively off.

**Fix:** `app.set('trust proxy', 1)` before rate-limiter registration in `apps/api/src/index.ts`.

### T0-5 — Shipping carrier webhooks accept arbitrary input

`webhook.routes.ts:481-509` — iCarry / Aramex POST handlers have no HMAC, no auth. Anyone can forge shipment status updates on any tracking number.

### T0-6 — `Cart.lastActivityAt` schema/DB drift

Schema declares the column + index, no migration creates it. Same drift class as the recent `Order.customerId` bug. Fresh CI DB crashes; abandoned-cart cron is silently broken (filters on a nonexistent column on Neon, but Prisma client expects it).

### T0-7 — `OrderService.create` hardcodes `shipping = 0`

Line 168: `const shipping = 0; // Free shipping (simplified)`. Ignores entire ShippingZone model. Storefront cart shows shipping cost; Order persists 0. **Revenue loss every order with non-zero shipping.**

### T0-8 — `OrderItem.variantId` never persisted

`order.service.ts:286-298` maps cart items to OrderItems without copying `variantId`. Refund / cancel / return paths read OrderItem.variantId to restore variant inventory — always null → variant stock drifts every refund.

### T0-9 — `LoyaltyService.earnPointsFromPurchase` defined but never called

Method exists, UI advertises loyalty, no code path invokes it. Customers never accrue points.

### T0-10 — `redeemPoints` double-spend race

`loyalty.service.ts:393-444` reads balance then decrements in a transaction; concurrent calls both pass the check. Customer can drain points twice.

### T0-11 — CSRF bypass via custom-domain allowlist

`security.ts:138-142` skips CSRF on JSON content-type, relying on CORS preflight. But custom store domains are added to CORS allowlist via DB lookup. A merchant who configures `attacker.com` as their domain gets that origin allowlisted and can mount JSON CSRF against any other store's API.

**Fix:** Gate the JSON skip behind the platform-only origin set; keep CSRF token verification for cross-origin JSON.

### T0-12 — `store_pages` table missing RLS coverage

Added in `20260428100000_add_store_pages` after the RLS migration; never amended. CMS About/Privacy/Terms not tenant-isolated at the DB layer (irrelevant while T0-1 has RLS bypassed, but a regression once RLS becomes load-bearing).

---

## Tier 1 — This week (defense-in-depth, real-but-narrower bugs)

### T1-1 — Customer-leak guard missing on 9 customer-facing endpoints

Mirror the `req.user?.role === 'customer'` guard from `/public/orders` and `/payments/create` to:

- `wishlist.routes.ts:13,97,209,261,316`
- `cart.routes.ts:31,49,74,99,117`
- `return.routes.ts:36,62,99`
- `loyalty.routes.ts:241,262,287`
- `review.routes.ts:91,135,156`

**Fix:** Extract a `customerOnly(req)` helper in middleware/auth, use everywhere.

### T1-2 — `/payments`, `/payment-settings`, `/uploads` not under `tenantContext`

`index.ts:48,51,54` — RLS transaction wrapping skipped on every payment / upload write. Once T0-1 lands, this becomes load-bearing.

### T1-3 — Refresh-token reuse detection

`auth.service.ts:344-380` — A stolen refresh token works silently until the legit user's next call. With 1-year refresh lifetime, that's a long impersonation window. Add `tokenFamily` + family-revocation on reuse.

### T1-4 — Email enumeration via register

Register returns 409 ALREADY_EXISTS while login/forgot-password/resend-verification mask existence. Plus timing oracle in `auth.service.ts:303` (bcrypt only runs when user exists).

### T1-5 — `bcryptjs@2.4.3` abandoned (last release 2017)

Used for password hashing. Upgrade to `bcryptjs@^3.0.3` or switch to native `bcrypt@^5`.

### T1-6 — `--legacy-peer-deps` in CI masks a real React version conflict

`.github/workflows/ci.yml` (4 sites). Root cause is `eslint-plugin-react-hooks@7` requiring React 19. Either pin to `^5.2` or upgrade React. Per `feedback-deps-lockfile`, the flag must not exist.

### T1-7 — Cache invalidation gaps

- `public:store:${slugOrId}` — never busted on store update (60s stale)
- `public:categories:${storeId}` — never busted on category writes (120s stale)
- `products:store:*` cache — invalidate function only deletes `categories:store:` (30s sale-price stale)
- Feature service `readFromDb` after write may hit a Neon read replica with the old row

**Fix:** Epoch-counter-based cache keys, or aggressive invalidation on every write path.

### T1-8 — Refund flow inconsistencies

- `payment.factory.ts:619-625` skips inventory restore that `order.service.ts:649-694` does
- Coupon `usageCount` not decremented on refund
- Affiliate commission not reversed on refund
- Returns marked "completed" without actually triggering provider refund (`return.service.ts:345-372`)

### T1-9 — Bulk import partial-failure leaks orphan rows

`bulk.service.ts:386-427` creates new categories/tags outside the per-batch transaction. Failed imports leave dangling category/tag rows with no products.

### T1-10 — N+1 query patterns

11 high-impact instances across cart-recommendations, abandoned-cart cron, inventory bulk-adjust, loyalty birthdays, shipping-carrier tracking. Most fixable with a single `findMany({ id: { in: ids } })` + bulk `createMany`.

---

## Tier 2 — This sprint (hardening / consistency)

- HTML-escape in transactional emails (`email.service.ts:411-753`) — phishing / brand-spoofing vector
- Cart hijack via sessionId OR customerId match (`cart.service.ts:18-22`)
- Affiliate `Decimal(12,3)` vs Order `Int` (fils) — two precision systems for the same currency
- `users_admin_email_key` partial unique not in Prisma schema → next `prisma migrate dev` will DROP it
- `is_best_seller` composite index drift (same class)
- Shipping zones / tax rate cache not busted on edit
- 21 occurrences of empty `} catch {}` blocks swallowing storefront write errors
- Soft-delete leaks across `OrderService.list`, `getByOrderNumber`, `getById`, analytics
- 18 admin price-input round-trip drifts (`Math.round(parseFloat * 1000)` vs `(value/1000).toFixed(3)`)
- ShippingCarrier tracking cron has no inner try/catch — one bad store cancels the rest
- AccountLockout INCR race (read-then-write)

---

## Tier 3 — Backlog

- 50 dependency upgrades (Express 5, Helmet 8, Prisma 7, Tailwind 4 commit, husky 9)
- `X-XSS-Protection` deprecated header
- Permissions-Policy completeness
- Webhook unknown-provider idempotency-key collision
- Documentation tickets (CSRF skip rationale, JWT lifetime contract, R2 prefix as only tenant boundary)

---

## Applied immediately in this session

This commit will land:

1. **T0-4** — `app.set('trust proxy', 1)` + verify rate limiters
2. **T0-2 partial** — add `requireStoreAccess` to admin order routes (the 5 highest-traffic ones)
3. **T0-6** — migration creating `Cart.lastActivityAt`
4. **T0-7** — wire `ShippingZone` lookup into `OrderService.create`
5. **T0-8** — copy `variantId` onto OrderItem at create time
6. **T0-12** — add `store_pages` to RLS allowlist
7. **T1-1 partial** — `customerOnly(req)` helper + apply to wishlist + cart + return + review routes

Everything else queued for follow-up commits per priority tier.
