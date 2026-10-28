# OMD-7

> Section: 2026-10-01 — owner money decisions (branch `fix/owner-money-decisions-1001`)

**Ruling OMD-7 — merchant-created accounts can collide with the new system
codes.** `getSystemAccountIdByCode` finds an account by code without checking
`isSystem`, so a store where a merchant already created a custom 2150 or 2160
(one level under a system parent) would have these refunds posted to that
account. Pre-existing shape of the healer (it applied to 1020 too); not
measured — production was not queried from this session. What would settle it:
`SELECT store_id, code, is_system FROM accounts WHERE code IN ('2150','2160')`.
Cost if wrong: that store's refund credits land in its own custom account
instead of the liability.
