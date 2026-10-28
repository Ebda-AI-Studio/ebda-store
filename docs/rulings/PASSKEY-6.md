# PASSKEY-6

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling PASSKEY-6 — every sign-in failure is the same `401 PASSKEY_AUTH_FAILED`; `/authenticate/begin` takes no account input, so there is nothing to enumerate; the internal reason (and the account once identified) goes only to the audit log. Evidence: `passkey.routes.test.ts` byte-identical bodies for malformed / unknown credential / bad signature, `passkey.service.test.ts` enumeration case. Cost if wrong: none.
