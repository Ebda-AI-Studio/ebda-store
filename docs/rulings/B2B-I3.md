# B2B-I3

> Section: B2B wholesale pricing (feat/b2b-wholesale, 2026-10-21)

Ruling B2B-I3 (money review I-3) - `assignByIdentity` without a `userId` matches only UNLINKED rows (`user_id IS NULL`); when only a row linked to a registered shopper matches the typed phone / email it refuses with 409 `IDENTITY_LINKED_TO_ACCOUNT` (the merchant assigns the group from that shopper's profile). A linked row never receives a phone copied from the shopper's self-edited profile. Cost if wrong: a merchant assigning a guest key whose phone also belongs to a registered account sees a 409 and must use the profile.
