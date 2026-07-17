# Error-message UX audit (storefront) — 2026-07-17

**Lens source:** Instagram reel `DYr7cKLIQo6` ("What makes a good error message", part 5 of a build-with-good-UX series). Derived checkable failure modes:

- **Mode A — raw backend/DB error leaked to the user.** Bad UX _and_ a security leak (exposes backend internals).
- **Mode B — vague error on a critical/payment path.** "Something went wrong" on checkout leaves the user unable to tell whether their card was charged.
- **Mode C — silent failure.** A user action fails with no message, no state change. The reel notes AI-built tools produce this _by default_ — the highest-signal check for our codebase.

A good message states **what happened, why, and the next action.**

## Result

The hardened checkout **submit** path is clean: `CheckoutClient.handleSubmit` maps every backend error code to a specific bilingual what/why/action message, and `apps/api/.../error-handler.ts` strips Prisma/DB/stack detail server-side before any response leaves the API — so **Mode A is clean on the payment path**. The real gaps were **Mode C silent failures** in the supporting storefront flows.

### Fixed in this PR

| #   | Mode | Location                                      | Fix                                                                                                                                                                                                            |
| --- | ---- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | C    | `cart/CartClient.tsx` remove/update-quantity  | Fired a **success** toast unconditionally with no `await`/`catch` — item silently reappeared on reconcile. Now `await` + `catch` → specific error toast.                                                       |
| 2   | C    | `contexts/CartContext.addItem` + 9 call sites | `addItem` re-threw on failure; no call site caught it → unhandled rejection, no feedback. Now centralizes a failure toast and **returns `boolean`** instead of throwing, closing all call sites at the source. |
| 3   | C    | `products/[slug]/ProductDetailClient.tsx`     | AddToCart **conversion pixel** fired even on a failed add (false conversion). Now gated on a confirmed add via the boolean.                                                                                    |
| 4   | C/B  | `checkout/CheckoutClient` payment-config load | A failed `/payments/config` load fell through to "No payment methods are configured for this store" (wrong for a transient error). Now shows a distinct retryable "Couldn't load payment methods" error.       |
| 5   | C    | `checkout/CheckoutClient` shipping calc       | Silent `catch` left a stale/zero fee on screen. Now surfaces "Couldn't calculate shipping. Please retry." with a retry.                                                                                        |

### Documented residuals (not in this PR — flagged, not silently deferred)

- **Auth pages** (`login`/`register`/`forgot`/`reset`) render `err.message` verbatim (Mode A). Safe today (the API sanitizes server-side messages), but the same catch would surface a raw JS exception from an unexpected throw. Worth a separate **auth-focused** PR rather than mixing an auth-flow change into a UX PR.
- **Checkout Zod fallthrough** (`CheckoutClient` VALIDATION_ERROR): unrecognized Zod messages shown verbatim inline. Intentional per the existing comment ("better than a generic toast"); tighten the translation regex when convenient.
- **Admin `err.message` pattern** (~86 spots): low risk — internal staff, messages already server-sanitized, provider detail is useful diagnostics. Not worth remediation.
- **`RefundButton` empty toast body** when `error.message` is undefined: cosmetic.

### Fleet lens (follow-up)

A "silent-failure / raw-error-leak" detector for the OS fleet was considered but **not** built here: a precise version (empty/console-only `catch` in a user-action handler) is hard to keep false-positive-free, and the OS constraint is zero false positives. Captured as a lens in memory pending a precision design.
