# Audit: untested-flow financial-failure lens (payment paths + mobile)

**Date:** 2026-07-17
**Trigger:** Instagram reel (Da3CmFEDSpG) — thesis: _"The AI built the checkout. It worked for the path you tested [cards]. Nobody tested the OTHER paths. A customer pays with [another provider], the payment processes, but the confirmation never fires — blank screen. They retry → two charges, zero confirmation → chargeback, lost customer. And 40% are on mobile, where the desktop-built UI breaks. Testing is a financial decision."_
**Lens applied to FWB:** multi-provider Kuwait stack (Tap / MyFatoorah / Hesabe / UPayments / COD) + mobile-first GCC merchants and shoppers.
**Method:** 3 parallel deep-audit agents (payment parity, mobile/responsive, test coverage) reading `graphify-out` then source; refund path cross-checked against the **official MyFatoorah MakeRefund spec** (docs.myfatoorah.com); prod DB forensics on refund rows.

---

## Headline

- Payment **capture** parity is solid — webhook handling, verify-on-return, and the post-purchase fanout are provider-generic and complete for all four gateways; no stubbed provider. (Matches merchant ground truth: MyFatoorah payments + push work.)
- The reel's thesis is nonetheless **real here** in two exact shapes: a **Critical double-charge on retry**, and a **whole class of untested revenue paths** (3 of 4 gateways have ~zero provider tests; no mobile checkout test runs in CI).
- **MyFatoorah refund** ("not working" per merchant) is **NOT a code bug** — the code is correct end-to-end vs the official spec. The failure is external: the MakeRefund/Refund API permission on the merchant's MyFatoorah account. See Refund section.

## Findings (by severity)

### CRITICAL

- **C1 — Double-charge on retry.** `apps/web/src/app/checkout/error/ErrorClient.tsx` renders "Payment could not be processed" + a "Retry Payment" button **without ever verifying the payment first** (unlike `success/SuccessClient.tsx`, which calls `verifyOrderPayment` on mount). Retry calls `api.createOrder` + `POST /payments/create` fresh — a brand-new order + charge, unrelated to the original (the "resume the same order" comment is aspirational; `CheckoutClient`/`page.tsx` never read an incoming `orderId`). A 3DS timeout / mobile blip / slow-settling capture that lands on `errorUrl` despite a real capture → customer retries → **two charges, one order → chargeback**. Affects all 4 online providers equally. Files: `error/ErrorClient.tsx:11-38`, `CheckoutClient.tsx:950-1010`, `payment.routes.ts:389-393`.

### HIGH

- **H1 — /payments/create has no duplicate-charge guard.** `payment.factory.ts:543-590` always `payment.create()`s + calls the provider with no check for an existing pending/paid Payment on the order. Compounds C1. (Was Medium in the parity report; promoted — it's the backend half of the money bug.)
- **H2 — 3 of 4 gateways have ~zero provider test coverage.** Tap has a unit test; **MyFatoorah** (577 lines, prior P0) is tested only for `resolveMyFatoorahEmail`; **Hesabe** and **UPayments** have _no_ test file at all. No test drives a real webhook payload → paid → confirmation email for ANY provider (the one webhook test only exercises Tap's idempotent short-circuit). This is exactly the reel's "only the tested path works."
- **H3 — No idempotency mechanism on `POST /orders` and no double-submit test.** Zero `idempotenc`/`duplicate` guard on order creation; nothing prevents two `POST /orders` from a double-submit creating two orders/charges. (Product-code gap + test gap.)
- **H4 — Product image reorder/remove controls are hover-only → unusable on touch.** `image-upload/MultiImageGrid.tsx:35` + `UploadPreview.tsx:34` gate the move/remove buttons behind `opacity-0 group-hover:opacity-100` with no touch fallback (11 admin consumers of ImageUpload/MultiImageUpload). A merchant managing catalog from a phone can't delete/reorder photos; targets are also sub-44px.
- **H5 — No mobile-viewport checkout test, and the one Playwright mobile suite never runs in CI.** `playwright.config.ts` defines an iPhone-14 project, but its only spec is the read-only prod smoke (home/PDP/cart-shell, "no checkout"). `ci.yml`'s `test-e2e` runs Vitest+supertest (no browser, no viewport). So no rendered checkout is tested at any viewport, and even the limited mobile smoke is manual-only.

### MEDIUM

- **M1 — Hesabe + UPayments `verifyWebhook` can throw `RangeError` on a malformed/rotated signature** (`hesabe.provider.ts:222-232`, `upayments.provider.ts:216-226`) — `timingSafeEqual` with no length guard, unlike Tap (length check) / MyFatoorah (try/catch). Loud (500 / retry+P0 alert), not silent, but avoidable noise + inconsistent hardening.
- **M2 — iPhone/Android HEIC/HEIF photos are hard-rejected, not converted.** Client `accept` (`ImageUpload.tsx:132`) + 3 server whitelists (`upload.routes.ts:34-41,302-311`, `storage.service.ts:43`) omit `image/heic`/`image/heif`. iOS Safari usually auto-converts, but Files-app / non-Safari / HEIF-default Android uploads get `Invalid file type`. Fix needs a `sharp`/libheif decode step (dependency decision), not just an accept-list change (raw HEIC isn't web-displayable).
- **M3 — Checkout step-2 Pay button has no sticky affordance; the delivery section adds scroll.** `PaymentStep.tsx:216-239` renders `DeliverySection` + Pay inline; reachability isn't broken (no fixed-bar overlap on checkout), but on iPhone-SE-height viewports Pay now costs an extra scroll. Consider a sticky step-2 Pay bar or capping the delivery card footprint (horizontal-scroll window chips).
- **M4 — Upload XHR has no timeout** (`useImageUpload.ts:138-176`) — a stalled mobile upload shows "Uploading X%…" forever with no cancel/retry. Add `xhr.timeout` + `ontimeout`.

### LOW

- **L1 — Dead `GET /webhooks/payment/callback` route** (`webhook.routes.ts:726-773`) redirects to `/checkout/pending`, a page that doesn't exist → genuine blank/404 if any provider portal still points at it. Delete, or add the page / redirect to success.
- **L2/L3 — Hover-only cosmetic hints** (`StoresGrid.tsx:90`, secondary-image swaps) — degrade gracefully on touch, no functional loss.

## Refund (merchant-reported "MyFatoorah refund not working") — VERDICT: external, not a code bug

Traced against the **official MyFatoorah MakeRefund spec** (`POST /v2/MakeRefund`; required `KeyType`∈{InvoiceId,PaymentId}, `Key`, `Amount`, `ServiceChargeOnCustomer`; success returns `Data.RefundId` + `RefundReference`; refunds are queued for finance-team execution, not instant):

- `myfatoorah.provider.refund()` builds a spec-correct request and reads `Data.RefundId` — **matches**.
- The MF client (`request()`) validates `IsSuccess` and throws MyFatoorah's real `Message` + `ValidationErrors` — so failures surface with the true reason.
- `PaymentService.refund` atomically claims the payment (TOCTOU-safe), calls the provider, and on success **persists** `refundId` + `refundedAmount` + flips the order; on failure releases the claim and throws.
- The `refund-via-provider` route surfaces any failure as a 502 **with a MyFatoorah hint**: _"verify Refund permission is enabled … Settings → API Permissions → MakeRefund."_

Prod DB forensics: every MyFatoorah refund row has **empty `refund_id`, `refunded_amount = 0`** — all dated **before** the 2026-07-16 money-integrity redesign (#758). No successful provider refund has ever recorded a reference.

**Root cause (most probable): the MakeRefund/Refund API permission is not enabled on the merchant's MyFatoorah account** (or a test/live key-mode mismatch). This is a 3rd-party account-config blocker only the merchant can resolve. **Unblock:** MyFatoorah portal → Settings → API Permissions → enable `MakeRefund` (or contact MF support). Confirm by triggering a refund and reading the exact 502 message (it carries MyFatoorah's real error).

## Fix plan

**This PR (surgical, no product decision / no new deps):**

- C1 — `ErrorClient` verifies payment on mount (like `SuccessClient`); if now paid → route to success instead of offering retry.
- M1 — length-guard `verifyWebhook` in Hesabe + UPayments (parity with Tap).
- M4 — upload XHR timeout + `ontimeout`.
- H4 — make image reorder/remove controls touch-visible (drop hover-only gating on touch).
- L1 — remove the dead callback route (or redirect to success).

**Tracked follow-ups (need a decision / larger effort — NOT silently dropped):**

- H1/H3 — order + payment idempotency mechanism (design: idempotency key vs. reuse-existing-pending-Payment) + double-submit tests.
- H2 — per-provider webhook→paid→email integration tests (MyFatoorah, Hesabe, UPayments, Tap first-time success).
- H5 — a real Playwright checkout spec at iPhone-14 viewport, wired into CI.
- M2 — HEIC/HEIF ingest via `sharp`/libheif decode (dependency decision).
- M3 — sticky step-2 Pay bar / cap delivery-card height (UX).

## Lens registration

Registered in the Builder Reality Audit fleet as the **untested-flow financial-failure** lens (payment-path parity + double-charge-on-retry + mobile-touch + per-provider test coverage) — reruns against other Force AI storefront/commerce projects.
