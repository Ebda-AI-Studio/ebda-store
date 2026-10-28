# SMS-6

> Section: 2026-10-02 — SMS consent follow-ups (branch `fix/backlog-followups10`, issues 2423–2426)

**Ruling SMS-6 — opt-out links are keyed on a purpose-bound key derived from ENCRYPTION_KEY, with no
new env var, and the two sibling link MACs move with them (issue 2424).** `lib/derived-secret.ts`
derives an HKDF-SHA256 key per labelled purpose from `ENCRYPTION_KEY`. Production refuses to boot
without that variable, so the Railway env does not change and no deploy step exists. Outside production
an empty key throws instead of signing with a reproducible value. `JWT_SECRET` signs sessions, and
rotating it is a routine way to sign everyone out. It must not also void the only login-free way a guest
has to stop marketing SMS. `ENCRYPTION_KEY` is never rotated casually, because rotating it means
re-encrypting stored TOTP secrets, payment configs and agent keys. Doing that now also voids the
links, and docs/ENVIRONMENT.md says so. Class sweep: the campaign unsubscribe link
(`CAMPAIGN_UNSUBSCRIBE_SECRET` → derived) and the review link (`REVIEW_TOKEN_SECRET` → derived) had
the same `JWT_SECRET` fallback. They sign with the derived key now. When no dedicated secret is set,
they still VERIFY against `JWT_SECRET`, so links already in inboxes keep working until the next rotation.
SMS v1 tokens (`<uuid>.<mac>` on `JWT_SECRET`) are NOT accepted: per the owner, promotional SMS sending
is gated off today, so none should exist. I did not verify that against production (no prod access in
this batch). Settle it with a read-only `SELECT count(*) FROM sms_marketing_consents WHERE granted` and
the SMS provider's send log for promotional events since PR 2421. Evidence: unit tests for all three
links (survives a `JWT_SECRET` rotation, a different `ENCRYPTION_KEY` cannot verify, legacy links still
verify, a dedicated secret excludes the fallback); four mutants KILLED and recorded. Cost if wrong: if a
promotional SMS did go out between PR 2421 and this change, its opt-out link now answers INVALID_TOKEN,
and that shopper must reply STOP or ask the merchant.
