# SMS-7

> Section: 2026-10-02 — SMS consent follow-ups (branch `fix/backlog-followups10`, issues 2423–2426)

**Ruling SMS-7 — the opt-out text has a fixed length budget; the dispatcher owns it, and every SMS
logs its billed segments (issue 2426).** The token is now 45 characters (consent uuid as 16 raw bytes
plus a 128-bit MAC, both canonical base64url; it was 59). The appended
` Stop offers: <base>/sms-unsubscribe?t=<token>` costs 78 characters plus the storefront base, and it
was 92. Measured with `smsSegments` (GSM-7 160/153, UCS-2 70/67): every promotional English template
with realistic links is one segment on its own and two with the opt-out. No length of link keeps it at
one, so a promotional SMS costs two segments. `tests/unit/sms-segments.test.ts` pins that it stays
within two. The opt-out link is not dropped or shortened past usefulness, because it is the consent
record's withdrawal path. `[NotificationDispatcher] SMS queued` now logs `segments` and `encoding` for
every SMS, so a longer template is visible in the logs before it shows up on a bill. The storefront base
is cached in memory per API instance (120s, BOUNDED-stale, documented at the cache site), so a fan-out
reads the store once, not once per recipient. Amended 2026-10-03 (issue 2434): that claim was FALSE as
first shipped, because the cache held the resolved value and the back-in-stock loop dispatches every
subscriber without awaiting, so all N recipients missed. The cache now holds the in-flight promise
(dropped on rejection or an unknown store); `tests/unit/sms-opt-out-base-dedupes-in-flight-reads.test.ts`
asserts ONE store read for 25 concurrent recipients and fails against the value cache. Residual: for up to 120s after a store changes its custom
domain, new opt-out links use the old domain. Cost if wrong: Arabic templates (UCS-2) would cost
3–4 segments if a locale switch is ever added. That PR must re-run this budget against the Arabic text.

**Amended 2026-11-09 (NEON-ZERO consent residue):** new links carry a v3 token of 68 characters (consent id, store id, MAC), so the
appended text costs 101 characters plus the base (was 78). Reason: the unsubscribe endpoint read the consent row through a
cross-store Postgres lookup (`getSmsConsentById`) that a Durable Object store does not have; the store id in the link, covered by
the MAC, lets it read that store's Durable Object. `tests/unit/sms-segments.test.ts` still pins two segments for every English
promotional template. Legacy 45-character v2 links still verify; they resolve through Postgres only, so on a Worker without
Postgres an old v2 link answers INVALID_TOKEN (Cost if wrong: a guest holding a pre-2026-11-09 link must reply STOP or use the
account page; no promotional SMS had been sent from a DO store before, so none is expected in an inbox).
