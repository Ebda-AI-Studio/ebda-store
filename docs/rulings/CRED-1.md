# CRED-1

> Section: 2026-09-11

**Ruling CRED-1 — a masked-credential save that cannot resolve its merge base
now FAILS instead of succeeding, and the cache key carries a version.**

The 2026-09-22 carrier-cache fix changed the cached VALUE (decrypted object →
encrypted string) while leaving the KEY unchanged. Redis outlives a deploy, so
for the full 300s TTL — longer under a rolling restart, where old instances keep
writing the old shape — `decryptCredentials` was handed an object, threw, was
caught, and returned `{}`. Nothing distinguishes that from "this merchant has no
credentials configured". `preserveMaskedCredentials` then found no stored
counterpart for every masked field the merchant resubmitted unchanged, DROPPED
it, and `upsertCarrierConfig` encrypted and persisted the truncated set. A
merchant toggling `enabled` without retyping their Aramex password inside that
window destroyed the password, saw a successful save, and the subsequent cache
invalidation made the corruption the new truth.

Three decisions, not one:

1. `CARRIER_CONFIG_CACHE_PREFIX` gains `:v2:`. A cached value's shape is part of
   its key's contract; changing one without the other is an unversioned schema
   migration against a store that survives the deploy.
2. Both masked-resubmit merges read their base **straight from Prisma**, never
   through their own 300s cache. A base for a secret we are about to overwrite
   has to be current truth — a cached base silently reverts a credential changed
   moments ago on another replica even when the shape is right.
3. An unresolvable masked field **refuses the save** (`400
CARRIER_CREDENTIALS_UNRESOLVED` / `NOTIFICATION_CREDENTIALS_UNRESOLVED`)
   rather than dropping the field. This is the posture change: previously the
   save always succeeded. Failing a write is recoverable in one retype; erasing
   a merchant's carrier password is not.

`notification-config.service.ts` carried the identical shape against provider
secrets (Unifonic appSid) and is fixed in the same pass — the defect was found
once and is a sample of its class. All five guards are in
`docs/security/defence-mutations.json` and were verified KILLED, so removing any
one of them reddens a named test.

Cost if wrong: a merchant whose stored credentials genuinely cannot be decrypted
— a rotated or lost `ENCRYPTION_KEY` — can no longer save that carrier at all
until they retype every masked field, where before the save succeeded and quietly
dropped them. That is the intended trade: a blocked save is visible, and the
error names the field to retype. It does mean a key-rotation incident surfaces
here as failed saves rather than as silent credential loss discovered later.
