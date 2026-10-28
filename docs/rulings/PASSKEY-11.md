# PASSKEY-11

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling PASSKEY-11 — removing staff from store A ends their access to store A and nothing else: it deletes the membership (access is re-checked per request) and revokes their store-A merchant keys. It does NOT revoke sessions and never touches passkeys: sessions and passkeys are per user, so doing so would let store A's owner sign the same person out of store B or of a store they own. Evidence: `tests/unit/staff-removal-scope.test.ts` (no `revokeAllSessions`, no passkey or refresh-token write, only the store-A membership deleted) — red before (the first version revoked the user's sessions everywhere). Cost if wrong: a removed staff member's existing access token stays valid for other surfaces they legitimately hold until it expires.
