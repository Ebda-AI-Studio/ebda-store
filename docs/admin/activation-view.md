# Activation view (super admin)

Where: the admin sidebar, platform section, **Merchant activation** (`/activation`). Super admins only (the API is `authenticate`, MFA, `authorize('super_admin')`; a store admin or staff gets 403). Ruling: `docs/rulings/ACT-1.md`.

## What it answers

Is a store stuck on setup (friction), has nobody ordered yet (demand), or did orders stop after payment (fulfilment)?

## The funnel

Pick a signup date range. Per step (store created, payment methods, went live, first order, first delivered order) you see how many of the stores that signed up in the range reached it, the median time from signup, and how many needed help. The numbers update once a day (the daily CI aggregation). Over 600 stores the page says it read only the first ones: narrow the range.

## The store list

One row per store, newest first by id, 25 at a time ("Show more stores"). Each step shows the time from signup, or a dash if not reached. "Help needed" under a step means the merchant used the Ebda AI Studio assistant, or support changed the store before it went live, while that step was the open one. The last column says where the store's first order stopped (payment failed, not shipped, not picked up, returned, and so on); it is empty once an order was delivered.

## What counts

- First order: paid, or cash on delivery that was confirmed. A demo store never counts, and neither does an order placed from the admin by staff or a super admin (the owner keying in their own order counts, channel "Merchant admin").
- First delivered order: the earliest real order that was delivered (or marked delivered for pickup and digital).
- Help from a support message is not recorded yet: there is no merchant support-message path to hook.

## Reading it correctly

Before the first daily run after launch, and for events older than the days that run folded, a store shows dashes. That is "not recorded", not "not reached". Nothing here is shown to merchants, and no shopper data is in it (ids and times only).
