# AUI-2

> Section: 2026-09-30 — Admin UI: coupons chrome, feature-flag staleness, Customers page (branch `fix/admin-ui-coupons-features-customers`)

**Ruling AUI-2 — `GET /customers?segment=<rfm>` is refused (403) for `staff`.** `staff` can read the
list, but RFM segments are served by `rfm-batch` to store_admin/super_admin only; filtering by a
segment would let staff enumerate segment membership. `segment=guest` and the plain list stay open to
staff. Unknown segment values are ignored (unfiltered list), not a 400, so a stale link still loads.
Cost if wrong: staff who legitimately need segment views must ask an admin.
