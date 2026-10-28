# PASSKEY-9

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling PASSKEY-9 — adding or removing a passkey emails the account (best-effort; sender identity per PASSKEY-16: an outage is logged and never undoes the change); removing a passkey calls `revokeAllSessions` (token-version bump + every refresh token revoked). Sessions are not tagged with the credential that opened them, so the whole account signs out: a superset of "sessions issued via that passkey". Evidence: `passkey.service.test.ts` "notices and revocation" (mail on add and remove, outage tolerated, revoke on remove, nothing on a failed removal, an assertion begun before the delete is refused). Cost if wrong: removing a passkey signs the owner out on their other devices too.
