# BF-2

> Section: Backlog batch final (2026-10-01, branch `fix/backlog-final`)

**Ruling BF-2 — the unreadable dead-letter lists get a bound, an owner and a drain; SMS gets the
alert but no page (issue 2353).** `email:failed:corrupt` / `sms:failed:corrupt` are LPUSH + LTRIM
200 + EXPIRE 30 days on every write (`lib/dead-letter.ts`). The email list's size shows on the
super-admin `/email-queue` page (size only — an unparseable entry cannot be masked, and that page
never returns a body) with an audited Discard. The SMS twin now raises the same P1 as email, but
has no page: there is no SMS queue UI at all and SMS is parked until a provider exists (#206).
Cost if wrong: a parked SMS entry is visible only through the alert and `railway connect Redis`
for its 30 days.
