# PASSKEY-4

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling PASSKEY-4 — a passkey sign-in satisfies MFA (user verification is REQUIRED on both ceremonies, the credential is phishing-resistant), so it mints the session through `issueSessionFor` and skips the TOTP challenge; the session carries the CURRENT `tokenVersion`, so every existing revocation (password change, suspension, sign-out-everywhere) kills it. Evidence: `passkey.routes.test.ts` (full session + csrf), service tests (UV required, tokenVersion). Cost if wrong: a stolen unlocked device with a passkey signs in without a code; the device lock is the second factor.
