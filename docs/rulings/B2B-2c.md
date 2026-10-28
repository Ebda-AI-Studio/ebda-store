# B2B-2c

> Section: B2B wholesale pricing (feat/b2b-wholesale, 2026-10-21)

Ruling B2B-2c - A wholesale price is granted only through `customers.user_id` (the link between the CRM row and the registered shopper), never through an email or phone match. `assignByIdentity` matches phone first and overwrites email, and `User.phone` is self-editable and unverified, so a match on either can be steered by typed input. The link is set only by (a) Task 5 approval, from `wholesale_applications.user_id` (which came from the session), or (b) the merchant's group dropdown on a REGISTERED shopper's profile (upsert by `user_id`). Guest / CRM rows written by `assignByIdentity` never confer a price. The composite FK `(store_id, user_id) -> users(store_id, id) ON DELETE SET NULL (user_id)` makes a cross-store link impossible. Cost if wrong: one merchant click moves a wholesaler's group to an attacker's account and the real wholesaler silently drops to retail.
