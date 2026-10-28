# ID-3

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling ID-3 (2026-10-24) - the shared identity service owns merchants, staff and super admins (`users.store_id IS NULL`); store customers stay Store-owned (HS256, store-scoped) and move into the StoreDO. Evidence: production has 6 admin users and 0 customers; the token contract carries only `stores[]` for operators. Cost if wrong: customers would need a second extraction later; nil at 0 customers today.
