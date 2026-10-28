# PASSKEY-10

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling PASSKEY-10 — a password reset (account recovery) REMOVES every passkey of the account, in `AuthService.resetPassword`, in the SAME transaction as the new hash (review M5: if the delete fails the password does not change), with an audit row `passkey.purged` and a notice stating the count. Whoever can receive the reset mail may not be who registered those keys; the owner signs in with the new password and enrols again. Evidence: `passkey-credentials-rls.test.ts` (reset deletes the user's rows and only theirs, real database) and the parity test. Cost if wrong: a legitimate owner re-enrols their devices after a reset.
