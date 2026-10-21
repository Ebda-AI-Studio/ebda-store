# Adversarial audit — ebda-store, 2026-09-02

Baseline: `main` @ `4f202f22`, clean. Read-only; no code was modified for this audit.

**Method.** Six parallel Fable-5 agents, each assigned an _attacker role_ rather than a checklist:
hostile merchant, hostile customer, unauthenticated attacker, injector, resource abuser, and one
auditing the audit record itself. Standing brief: grep counts are not findings; every finding must
carry a concrete exploit path and file:line evidence; kill your own false positives before
reporting. Each agent was also required to name what it attacked and could **not** break.

**Why adversarial and not another checklist.** Ebda Store carries 20 prior audit reports and most say PASS.
The premise here was that the next real defect is behind a PASS verdict, not in an unaudited corner.
That premise held: **5 prior PASS verdicts were falsified, and the two highest-severity findings sit
directly behind one of them.**

---

## Verdict

**4 P0 · 7 P1 · 12 P2 · 17 P3 originally found; residual after remediation below: P0-1, P0-2, P0-3,
P0-4, and P1-1 open.** Three of the four P0s are exploitable today by any paying merchant or, in one
case, by an anonymous request loop.

The single most important structural fact: **the two cross-tenant P0s have no second line of
defense.** Production connects as `neondb_owner`, a BYPASSRLS role — RLS is provisioned (233 policy
statements) but inert. That is Ahmad's deliberate, documented parking decision and is not itself a
finding. The finding was that `docs/audits/2026-08-31-reel-derived-lenses.md` L16 recorded it as
**PASS** — ~~that line~~ has since been corrected (see remediation status below) — so the record told
the next reader a backstop exists. Two agents independently made risk assessments against that false
premise before checking the role.

---

## Remediation status (2026-09-02, added post-merge — see #1166)

This report was written against `main @ 4f202f22`. It was then merged into this branch on top of
two remediation PRs that had already landed as siblings — #1133 ("audit record and CI gates") and
#1134 ("money + availability correctness") — plus a later #1135 ("close the p3 tail"). Findings
below were re-verified against the current merged tree; nothing in the findings above was rewritten,
only this status block was added. **Trim note:** exploit reproduction detail for findings still
marked OPEN was trimmed from this report and its per-agent slices on 2026-09-02 (#1168) — the
finding, its file:line evidence, and its damage/fix are kept; step-by-step request bodies are not,
since they were live exploit recipes for unfixed cross-tenant/SSRF holes in a repo that may not stay
private forever. The full detail is recoverable from each fix commit once it lands.

| Finding                                                                   | Status   | Where fixed                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 — stock-adjustment cross-tenant write                                | **OPEN** | —                                                                                                                                                                                                                                                                                     |
| P0-2 — purchase-order cross-tenant write                                  | **OPEN** | —                                                                                                                                                                                                                                                                                     |
| P0-3 — CORS/CSRF → impersonate takeover                                   | **OPEN** | —                                                                                                                                                                                                                                                                                     |
| P0-4 — refund double-reversal                                             | **OPEN** | —                                                                                                                                                                                                                                                                                     |
| P1-1 — iCarry SSRF                                                        | **OPEN** | —                                                                                                                                                                                                                                                                                     |
| P1-2 — partial return reverses everything/nothing                         | FIXED    | #1134 — item-level `applyRefundEffects`                                                                                                                                                                                                                                               |
| P1-3 — unbounded public search                                            | FIXED    | #1134 — length floor + cap (`public.routes.ts`)                                                                                                                                                                                                                                       |
| P1-4 — zombie `preview-env-isolation.yml` gate                            | FIXED    | #1133 — workflow deleted                                                                                                                                                                                                                                                              |
| P1-5 — 4 orphaned web tests                                               | FIXED    | #1133 — `orphan-tests` CI job                                                                                                                                                                                                                                                         |
| P1-6 — testing record ~60% real                                           | PARTIAL  | #1133 — lighthouse notify-failure + Chrome install fixed, Stryker re-baselined with a real `break` floor. Load-test schedule remains intentionally `workflow_dispatch`-only (pre-launch/infra-change tool, not nightly — a deliberate choice, not a gap); no UAT artifact exists yet. |
| P1-7 — store suspension doesn't stop trading                              | FIXED    | #1134 — `StoreService.setStatus` owns the write + cache bust                                                                                                                                                                                                                          |
| P2 — `/payments/create` replayable                                        | FIXED    | #1134 — existing-payment guard                                                                                                                                                                                                                                                        |
| P2 — rate limiter fail-closed while cache fail-open                       | FIXED    | #1134 — `passOnStoreError: true` on every limiter                                                                                                                                                                                                                                     |
| P2 — refund-webhook idempotency key committed before reversal dispatch    | FIXED    | #1134 — effects-dispatch now runs before the durable idempotency write                                                                                                                                                                                                                |
| P2 — payment status written before order-transition assert                | FIXED    | #1134 — transition assert now runs before the payment write                                                                                                                                                                                                                           |
| P2 — global (not per-tenant) Gemini request cap                           | FIXED    | #1134 — per-store daily slice (`DEFAULT_STORE_DAILY_REQUEST_CAP`) added beneath the global cap                                                                                                                                                                                        |
| P2 — gitleaks blind to the whole test tree                                | FIXED    | #1133 — blanket `*.test.ts`/`__tests__/**` allowlist removed                                                                                                                                                                                                                          |
| P2 — AI review gates fail open / not required checks                      | PARTIAL  | #1133 added `E2E Tests` + `Client secret scan` as required checks (verified live via branch protection); the AI review gates themselves and `scoped-audit` are still not required checks                                                                                              |
| P2 — admin manual-order unvalidated `customerId`                          | **OPEN** | —                                                                                                                                                                                                                                                                                     |
| P2 — review AI tools read cross-tenant                                    | **OPEN** | —                                                                                                                                                                                                                                                                                     |
| P2 — Stryker `auth.service.ts` 0% mutants killed                          | PARTIAL  | #1133 re-baselined Stryker with a real `break` floor (was `null`); `auth.service.ts`'s own mutation score not independently re-verified here                                                                                                                                          |
| Falsified L16 (RLS) / L20 (SLO) verdicts                                  | FIXED    | #1133 — corrected in place in `docs/audits/2026-08-31-reel-derived-lenses.md`                                                                                                                                                                                                         |
| Falsified CSRF / oversell-safe / SSRF-PASS verdicts (07-02, 07-15, 07-31) | FIXED    | this PR (#1156) — correction banners added in place                                                                                                                                                                                                                                   |
| Docs-parity: dead Railway host in CLAUDE.md/ENVIRONMENT.md                | FIXED    | #1133                                                                                                                                                                                                                                                                                 |

---

## The unifying defect class

Every one of the five falsified PASS verdicts has the same shape:

> **The audit checked the layer where the guard is _declared_, not the layer where the write
> actually happens.**

| Falsified claim                                          | What was checked                      | Where the defect lives                                |
| -------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------- |
| 07-02: "CSRF skip is platform-origins only"              | the code's _comment_                  | the condition below it, which ORs in merchant origins |
| 07-15: "checkout is oversell-safe"                       | one writer                            | the sibling writer (prod hit inventory −16)           |
| 07-31 §09 + 08-31 GAP-1: "SSRF — server-controlled URLs" | `routes/**` (the ESLint rule's scope) | `services/carriers/**`, structurally uncovered        |
| 07-15 IDOR sweep: surface "swept"                        | route handlers                        | accounting **service internals**                      |
| 08-31 L16: "RLS — PASS"                                  | policy count                          | `pg_roles.rolbypassrls`                               |

This is the report-level form of Ahmad's own standing rule: _a reported bug is a sample of a defect
class._ A PASS on a system invariant must enumerate **every** writer/caller, and must cite the
runtime fact (a role, a header, a response) rather than the declaration that intends it.

**Recommended lens-pack amendment:** a PASS verdict must name the enumeration it performed. "Checked
N of N writers" or "PASS scoped to <cited lines>" — never a bare system claim from one path.

---

## P0 — exploitable now

### P0-1 · Cross-tenant absolute inventory write via stock-adjustment

`apps/api/src/services/accounting/stock-adjustment.service.ts:56,136` ·
2nd entry point `apps/api/src/services/barcode-scan.service.ts:393,513`

A `store_admin` harvests a competitor's `productId`/`variantId` from the public storefront, then
posts a stock adjustment for their **own** store carrying the foreign ids. Every middleware passes —
they do own store A. The variant snapshot is
`productVariant.findFirst({ where: { id, productId } })` with **no `storeId`**, and the post-write is
`productVariant.update({ where: { id } })` on a bare attacker-supplied id.

Sets the **absolute** inventory of any variant in any other store to any value: zero a competitor's
stock or inflate it. The asymmetry proves it is a bug, not a design — the product-only branch two
lines below (`:64`) _does_ scope by `storeId`.

**Fix:** scope the snapshot `where: { id, product: { storeId } }`, reject any item that doesn't
resolve inside the store before creating the adjustment, and add `product: { storeId }` to the writes.

### P0-2 · Cross-tenant inventory + cost write, foreign backorder/order-item tampering, supplier PII

`apps/api/src/services/accounting/purchase-order.service.ts:40-46` (create), `:124-231` (receive)

Same class. `createPurchaseOrder` writes body-supplied product/variant/**supplier** ids with zero
ownership checks; `receivePurchaseOrder` guards only that the PO belongs to store A — which it does —
then updates foreign rows by bare id. Beyond inventory, this writes a competitor's `costPrice`
(weighted-average cost), falsely marks **another store's real customer backorder** as fulfilled, and
reads back an arbitrary foreign supplier row (name, phone, email, address, payment terms).

`backorder.service.ts` already scopes this correctly — the pattern exists in-repo and wasn't applied.

### P0-3 · Merchant custom domain → CSRF-exempt credentialed cross-origin → platform takeover

`apps/api/src/middleware/security.ts:155` · `apps/api/src/lib/cors-cache.ts:95-118` ·
`apps/api/src/index.ts:214-306` · `apps/api/src/routes/auth.routes.ts:22-27` ·
sink `apps/api/src/routes/admin.routes.ts:1704`

**Two agents reached this independently from opposite directions; scored P1 each, escalated to P0
here because the chain they jointly describe is full platform compromise.**

CORS allowlists any hostname present as a `Store.domain` with `credentials: true` and **no
verification filter** — Cloudflare `addDomain` creates a pending custom hostname without ownership
proof, so the DB row exists regardless of DNS. The CSRF JSON/XHR skip then ORs in
`isAllowlistedMerchantOrigin`. The auth cookie is `SameSite=None` with no `domain`.

Chain: sign up as a merchant → set your store domain to a host you control → lure a logged-in
super_admin there → your JS makes credentialed, CSRF-exempt calls **and reads the responses** →
`POST /admin/impersonate` returns a 1h full-privilege token for any user you name.

The amplifier: `/admin/impersonate` is correctly gated (super_admin + MFA + audited), but its
`impersonatedBy` claim is documented as "allows future guards to detect impersonation" and **no
guard reads it** — an impersonated session is indistinguishable from a real one.

**Falsifies** `docs/audits/2026-07-02-security-surface.md:268-275`, which states the skip is scoped
to platform origins "not 'any CORS-allowed origin'". The audit read the middleware's comment; the
condition immediately below contradicts it. Traced to commit `619c43e7`, 2026-05-14 — **the claim
has been false for the entire life of that audit.**

**Fix:** drop `|| isAllowlistedMerchantOrigin(origin)` from the CSRF skip; require `ssl.status ===
'active'` before a custom hostname enters the CORS cache; reject `impersonatedBy` tokens on
destructive self-service routes. The socket.io CORS config (`services/socket.service.ts:53-86`) is
platform-only — it is the correct pattern the HTTP path should copy.

### P0-4 · Refund double-reversal invents inventory and erases coupon redemptions

`apps/api/src/services/order.service.ts:1009-1122` ·
`apps/api/src/lib/inngest/functions/refund-reversal-stuck-sweep.ts:84-98` ·
`apps/api/src/lib/inngest/functions/order-refunded.ts:109-114,165-210`

`rollbackForPaymentFailure` reverses inline and writes `InventoryHistory.type: 'adjustment'`, never
stamping `refundReversedAt`. The stuck-sweep selects on `refundReversedAt IS NULL` and re-fires
`order/refunded`; the fanout's idempotency marker is `'return_stock'`, which does not match — so
inventory is restored a **second** time and coupon `usageCount` decremented again.

Anonymous, no auth: place a guest order, `POST /payments/create` naming a provider the store hasn't
configured (the factory throws, the catch runs the rollback), wait one 15-minute cron cycle, repeat.
The rollback even rebuilds the attacker's cart, making it one request per cycle.

It also **fires organically on every legitimate failed payment-create** since PR #822 — silent
upward stock drift with no alert, since the sweep logs a routine "re-sent" warning.

**Falsifies** PR #822's "Re-firing is safe — verified, not assumed." That PR's own design doc warns
a marker-based sweep "would invent stock that never existed", enumerates two legitimate
marker-absence cases, and never considers the third: _a cancel path that already reversed inline
under a different marker type._

**Fix (one line, closes both entry points including `mcp/tools/order.tools.ts:242`):** stamp
`refundReversedAt` inside the rollback transaction — it _is_ the reversal.

**Settling query** (read-only; counts orders already double-restored in prod):

```sql
SELECT count(*) FROM inventory_history a
JOIN inventory_history b ON a.reference = b.reference AND a.product_id = b.product_id
WHERE a.type = 'adjustment' AND a.reason = 'Order rollback — payment step failed'
  AND b.type = 'return_stock';
```

---

## P1

| #    | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Where                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| P1-1 | **Live SSRF** — merchant-supplied iCarry `credentials.baseUrl` used verbatim as a fetch base, never through `lib/safe-fetch`. `z.record(z.string(), z.string())` accepts any key; `shipping_carriers` is a **core/baseline** feature every store has. Reaches cloud metadata, `*.railway.internal`, internal Redis, Neon — from Railway's egress, with a status/body oracle in `testConnection`'s response. **Falsifies** 07-31 §09 "SSRF — PASS" and upgrades 08-31 GAP-1 from latent to live. The ESLint SSRF rule is scoped to `routes/**`, so `services/**` is structurally unguarded. | `services/carriers/icarry.carrier.ts:53-54,61,151,254` · `routes/shipping-carrier.routes.ts:18` |
| P1-2 | **Partial return reverses everything, or nothing.** `applyRefundEffects(orderId)` has no item granularity: a manual partial refund restores inventory for _all_ items, reverses the coupon, claws back the whole affiliate commission, revokes all loyalty points and reverses the full GL journal; the gateway-partial path skips local effects entirely, so returned goods are never restocked. The comment at `:425-430` ("doubling up is safe") is wrong for the partial case.                                                                                                         | `services/return.service.ts:367-437` · `order.service.ts:1319-1355`                             |
| P1-3 | **Unbounded public search burns Neon.** Leading-wildcard `ILIKE` across 4 TEXT columns, no min-length, **no `pg_trgm`/GIN/FTS index in any migration** — and `search` is in the cache key, so unique terms miss Redis, the in-memory map _and_ single-flight at once. A 30-byte anonymous GET = a full seq-scan; sustained traffic pins compute against autosuspend. The sibling `/search/suggest` route enforces a length floor; this one doesn't.                                                                                                                                        | `routes/public.routes.ts:143,200-206` · `product.service.ts` `buildProductSearchAnd`            |
| P1-4 | **Zombie CI gate.** `preview-env-isolation.yml` queries **Vercel** projects that no longer exist; `VERCEL_API_TOKEN` and both project-ID vars are absent, so it `exit 0`s and reports `success` on every PR. No Cloudflare-era replacement exists. A gate that cannot fail must not report success.                                                                                                                                                                                                                                                                                        | `.github/workflows/preview-env-isolation.yml`                                                   |
| P1-5 | **Four web tests execute nowhere** — including checkout delivery-window logic and company-host routing. Verified by running `vitest list` against CI's exact invocation: 167 files, none of these. The unit job's own comment predicts this bug ("a colocated test outside these paths = a test that does not run") — it is now the epitaph, not the fix.                                                                                                                                                                                                                                  | `apps/web/src/app/checkout/_lib/deliveryWindows.test.ts` + 3 others                             |
| P1-6 | **The five-layer testing record is ~60% real.** k6 load layer: schedule disabled 2026-05-27, last runs failed 2026-06-04, `loadtests/results/` empty — no green run has ever existed. Lighthouse: **red every night since 2026-07-13** (`Chrome installation not found`), unnoticed for 7 weeks because it is the one scheduled workflow with no notify-failure job. UAT: no artifact anywhere.                                                                                                                                                                                            | `load-test-nightly.yml` · `lighthouse-nightly.yml`                                              |
| P1-7 | **Store suspension doesn't stop trading.** `PATCH /stores/:id/status` busts only the feature cache, leaving `public:store:resolve:<domain>` (which carries `status`) live for 120s plus the web layer's own in-memory and Next-tag windows. A store suspended for fraud keeps serving and **taking checkouts**. Account status is a NEVER-stale value on a TTL-only cache. The correct helper `invalidateStoreCaches` exists and is called on domain change — just not here.                                                                                                               | `routes/store.routes.ts:609-618`                                                                |

---

## P2 — selected

- **`POST /payments/create` is replayable.** No existing-payment guard: each COD replay re-adds the
  COD fee to `order.total`; online replays mint multiple live gateway invoices for one order, and a
  second `completed` webhook is a same-status no-op — **undetected customer double-charge, no
  duplicate-payment alert anywhere.** A plain double-click does the COD version to real customers.
  `routes/payment.routes.ts:196-330`
- **Rate limiter is fail-CLOSED while the cache is fail-open.** `passOnStoreError` left at default
  across all 12 limiters plus the global one, and `getClient()` never returns null once constructed.
  A Redis blip 500s auth, cart, payments, uploads and AI simultaneously. The asymmetry with the
  deliberately fail-open cache shows the intent was fail-open. `middleware/security.ts:223`
- **Refund-webhook idempotency key still commits before the reversal dispatch** (07-15 F3 narrowed,
  not fixed). If the `inngest.send` throws, the retry hits the no-op and the webhook is marked
  processed with **no reversal ever enqueued and no dead-letter** — and because the order status flip
  also never ran, the new sweep can't rescue it. `payment.factory.ts:920-955,1005-1015`
- **Payment status written before the order-transition assert** — leaves `Payment.status='completed'`
  on a `cancelled` order, money captured, no reconciler targeting that pair. `payment.factory.ts:1141,1184`
- **Global (not per-tenant) Gemini request cap.** 450/day counted with no `storeId` predicate: one
  merchant's bulk sweep of a >450-product catalog 429s AI for **every other tenant** until 00:00 UTC.
  The per-store token budget runs _after_ this gate and doesn't protect anyone. `lib/ai-quota.ts:64`
- **Both AI review gates fail open** on any infra error, and neither — nor E2E, nor client-secret-scan
  — is a required check (verified against branch protection). The blocking scoped-audit still runs
  the author's model. Live corroboration: open issues #1115, #1116.
- **gitleaks is blind to the whole test tree** (blanket `*.test.ts` + `__tests__/**` allowlist), and
  edits to `.gitleaks.toml` itself count as "docs-only" in the CI changes filter — the scanner can be
  weakened through a path that skips Build, Unit, Integration, E2E and the RLS proof.
- **Admin manual-order writes an unvalidated `customerId`** → attach any platform user to a
  fabricated order and read their name+email. UUID-gated, hence P2. `order.service.ts:1631`
- **Review AI tools read reviews cross-tenant** — competitive-intelligence summaries and exact
  verified-purchase counts for any competitor product. `lib/ai/review-tools.ts:164,217`
- **Stryker: `auth.service.ts` scored 0% mutants killed** — "unit tests mock the service layer and
  never import the real modules." `break: null`, not wired into any workflow, unrun for 3 months.

---

## Corrected during synthesis

Two agent findings were revised by the orchestrator against live evidence rather than accepted:

1. **`X-Forwarded-For` spoof via the naked Railway origin: P2 → P3.** The finding assumed
   `api-production-c058.up.railway.app` stays directly reachable. It does not:
   ```
   GET https://api-production-c058.up.railway.app/{/,/health,/api/health,/public/stores}
   → 404 · server: railway-hikari · x-railway-fallback: true
     {"status":"error","code":404,"message":"Application not found"}
   ```
   `x-railway-fallback: true` = no service bound to that hostname (the same `/health` returns 200
   through Cloudflare). Residual: Railway may still route the service on a different generated
   domain — proven for the documented host only, not universally.
2. **`api.ebda.app` IS Cloudflare-proxied** (`server: cloudflare`, `cf-ray`,
   `cf-cache-status: DYNAMIC`) — settles a blind spot in two reports and keeps the P3 edge-cache
   `Vary` bug dormant (nothing is edge-cached today).

**Docs-parity fallout:** `CLAUDE.md` and several audits name
`api-production-c058.up.railway.app` as the live API host. That is now false. ~~Neither CLAUDE.md
nor ENVIRONMENT.md corrected~~ — **corrected in #1133**, now merged into this branch; see the
remediation status block above.

---

## Upheld under attack

Worth as much as the findings — each was attacked hard and held:

- **Price authority is airtight.** Cart lines carry no price column; every amount is recomputed
  server-side; `/payments/create` charges `order.total`. Variant-price confusion, cross-store
  product injection, negative quantities and zero-area shipping were all tried and blocked.
- **The payment webhook boundary.** HMAC over the **raw** body, all four providers fail closed on a
  missing secret with timing-safe compare, per-store secret from the Payment row, three-layer replay
  idempotency, amount reconciliation with a P0 alert, and the PSP redirect is never trusted —
  `/verify-payment` pulls provider status by the stored transaction id.
- **Oversell and double-refund races.** Atomic conditional `UPDATE … WHERE inventory >= qty` inside
  the money transaction; atomic coupon reserve; atomic payment claim with release-on-error.
- **Tenant resolution.** `getStoreIdFromRequest` throws on unresolved input — the old default-to-first
  bug is genuinely dead. Host-only resolution, no `X-Forwarded-Host` trust anywhere, `/tenant-store/*`
  hard-404, R2 keys `storeId`-scoped with re-verification.
- **Stored XSS.** The JSON-LD `</script>` breakout (H-1 in the 07-31 audit) is correctly fixed; CMS
  content is re-rendered server-side and escaped on every fetch; theme/font values can't break out of
  the `<style>` block; every merchant `<a href>` passes `sanitizeUrl`. Storefront CSP carries
  `'unsafe-inline'` so there is **no backstop if any escaper ever regresses** — logged P3.
- **The `33dc6003` db-guard rewrite, the npm-audit gate, and the 9 required deterministic checks.**
  All real, fail-closed, pinned, green. The audit-followup issue mill (#1110-#1126) turns gaps into
  tracked issues rather than fossils.
- **Two prior findings confirmed fixed:** the cache-stampede H1 inner cache is gone;
  `invalidateCustomersCache` now has real call sites.

---

## The uninstrumented dark, ranked by time-to-notice

1. **Latency of everything** — no load tests, no Lighthouse, no SLO or burn-rate alerting. Sentry
   sees errors, not p95. A 3× regression is invisible until a merchant complains.
2. **`apps/orders`** — zero test files in the entire app, no smoke project, no perf target.
3. **Preview/test writes to prod data** — owned by the zombie gate (P1-4).
4. **Secrets in test files** — carved out of gitleaks; trufflehog runs `--only-verified`.
5. **Live payment-gateway behavior** — no sandbox exercise in CI; the MCP agent online-payment path
   remains flagged UNEXERCISED and has never been smoke-tested.

## Blind spots — what would settle them

| Question                                                                             | Settles it                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How many orders has P0-4 already double-restored?                                    | the SQL above, read-only                                                                                                                                                                                                          |
| Prod role state                                                                      | `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('neondb_owner','the earlier app role');`                                                                                                                                       |
| What the P1-1 SSRF actually reaches inside Railway                                   | set an iCarry `baseUrl` to a burn URL from a test store, read `testConnection`                                                                                                                                                    |
| Live `TRUST_PROXY_HOPS`, and whether any Railway domain still accepts direct traffic | `railway variables`; Railway dashboard                                                                                                                                                                                            |
| Does the CORS preflight really echo a merchant origin with `Allow-Credentials`?      | a preflight probe against a non-destructive endpoint with a configured merchant `Origin` header settles it (trimmed 2026-09-02 — P0-3 is still open; the fix commit for `security.ts:155` is the reproducible record once landed) |

---

## Suggested fix order

**Updated 2026-09-02 — trimmed to the still-open residual.** The record-keeping tier this list
originally ranked last (P1-4/5/6) is fixed; see the remediation status block above. What remains:

1. **P0-4** — one line (`refundReversedAt` in the rollback tx), stops active production drift.
2. **P0-3** — delete one `||`, add the `ssl.status` gate.
3. **P0-1 + P0-2** — same defect class, one pass over `services/accounting/**`; `upload.routes.ts`
   and `backorder.service.ts` are the in-repo templates.
4. **P1-1** — route `resolveBaseUrl` through `assertPublicHttpUrl` **and** widen the ESLint SSRF
   selector to `services/**`, or the class recurs.

Per-agent source reports (attack narratives, full evidence, per-finding blast radius) were produced
for: `tenant-isolation`, `money`, `auth-session`, `injection-render`, `availability-cost`,
`falsification`.
