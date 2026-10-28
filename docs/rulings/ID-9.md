# ID-9

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling ID-9 (2026-10-24) - the Store keeps its database ownership/membership check as the authority for store access and treats the token's `stores[]` as advisory (the contract says to reject a store not in the claim). A claim is up to 15 minutes old, so enforcing it would lock a merchant out of a store they just created and keep a removed staff member in for 15 minutes; the database check is at least as strict and immediate. Cost if wrong: none for the Store (the claim is derived from the same data); other products must enforce the claim themselves.
