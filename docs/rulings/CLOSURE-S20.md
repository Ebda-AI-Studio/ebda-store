# CLOSURE-S20

> Section: Admin audit closure 2026-11-09, phase 2 (branch `fix/admin-audit-closure`)

Ruling CLOSURE-S20 - BE:S-20, the staff-invite flow (201 vs 202 split, 409 ROLE_CONFLICT/ALREADY_MEMBER, returned existing user id) still discloses whether an address has an account. The route is owner-only (store_admin of that store) and the owner needs the 409s to act (an invite cannot go to someone already on the team); the response already echoes the owner-typed names, not the existing account's. Collapsing the statuses would remove the owner's only signal. Cost if wrong: a store owner can learn whether an email already has an Ebda account.
