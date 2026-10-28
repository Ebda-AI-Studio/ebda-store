# EWO-D1

> Section: Cluster D — checkout + cart

**Ruling EWO-D1 — #2067: the checkout submit gates on "is the delivery fee confirmed", not on "is
a reprice in flight". Amends M3-4.** `calculateShipping` never throws — a non-2xx and a network
error both resolve after `setShippingError(true)` — so `repriceAfterCouponRemoval`'s `finally`
reopened Place Order over the coupon's stale 0 fee. `calculateShipping` now resolves `true` only
when a quote landed, tracks `shippingQuotePending`, and drops superseded answers (a slower
response for a previous area can no longer overwrite the current fee). `isShippingSettled`
(`shippingError`, pending, repricing) gates both step-1 Continue buttons, the Pay button's busy
state, and `handleSubmit` itself — a failed quote sends the customer back to step 1, where the
delivery panel's Retry lives. No amount expression changed: the server prices shipping at order
creation; this only stops a submit on a fee the summary never confirmed. Still source-pinned
(P2-B2-2), each pin mutation-checked. Cost if wrong: a customer on a flapping shipping endpoint
cannot continue until a quote lands, instead of ordering on an unconfirmed fee.
