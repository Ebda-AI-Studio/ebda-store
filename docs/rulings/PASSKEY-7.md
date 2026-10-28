# PASSKEY-7

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling PASSKEY-7 — adding, renaming and removing a passkey need a step-up: password (plus a current TOTP code when TOTP is on), or a passkey sign-in, held server-side in Redis for 300 s; a bare session cannot add a backdoor passkey nor delete the owner's. Wrong guesses feed the SAME lockout counter as login. Evidence: the "step-up" describe in `passkey.service.test.ts` (refused on a bare session for register / rename / remove, wrong password, TOTP, expiry between begin and finish, TTL window, lockout) and `passkey.routes.test.ts`; mutants without the check in `remove` turn it red. Cost if wrong: one extra password prompt every 5 minutes of passkey management.
