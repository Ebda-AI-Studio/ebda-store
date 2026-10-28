# ID-8

> Section: Lifecycle emails and referral attribution (2026-10-22, branch `feat/lifecycle-emails`)

Ruling ID-8 (2026-10-24) - a password reset keeps a VERIFIED account's passkeys and MFA (it only ends every session); it strips them only for an account that was never verified. A coordinator instruction asked for a purge on every reset; Opus review (H2) showed that turns a mailbox compromise into an MFA bypass, and pre-hijacking is already closed by refusing login, passkey registration and MFA enrolment until the email is verified, plus a purge on the first verification, on a signup that overwrites an unverified account, and on the reset of an unverified account. Cost if wrong: an owner who lost both password and second factor must be recovered by support instead of self-service.
