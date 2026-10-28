# RF-5

> Section: 2026-10-01 — Report filters apply (`fix/report-filters-apply`)

**Ruling RF-5 — the orders-list `search` matches order number and a REGISTERED customer's name,
email, phone; a guest's contact (in `shippingAddress` JSON) is not searched server-side.** The old
client-side search matched the same fields, but only on the 25 fetched rows. Cost if wrong: a
guest order is found by its number but not by the guest's name.
