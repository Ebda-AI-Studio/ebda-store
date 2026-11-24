# QA98-ALIAS-1 / QA98-ALIAS-2

> Section: 2026-11-23, Customers list guest dedupe (STORE-QA-98), supersedes the grouping half of AP-12

**Ruling QA98-ALIAS-1 - ONE alias-set grouping for every merchant-side customer surface; stored keys never change.**
Guest orders keep their stored key (`customerKeyOf`: lowercased email, else the phone verbatim), because consent rows, RFM hashes and
bookmarked links all hold it. Guests who are provably one person are grouped at READ time by `CustomerGroups`
(`lib/customer-groups.ts`): two identities are linked when they share a lowercased email OR a normalised full phone number,
transitively. The group is addressed by its smallest member key, so grouping is deterministic and independent of arrival order.
Registered customers are their own group; a contact-less guest stays `guest:<orderId>`.
Grouping drives merchant DISPLAY and ANALYTICS only: the Customers list and export, customer detail (any member key opens the
group), RFM and cohort rollups, the dashboard distinct-customer and repeat-buyer counts (both backends return identity rows, grouped
once in `lib/buyer-counts.ts`; the SQL twin `customer-key-sql.ts` and the DO `analyticsRepeatBuyers` op are removed).

**Ruling QA98-ALIAS-2 (controller review) - consent is NOT group-based; the phone key is the full number.**

1. SMS consent (the send-time check, the withdrawal, every consent surface) keys on the recipient's normalised FULL phone number
   (`smsConsentPhoneKey`: country code included, an Egyptian mobile in any spelling is one key): same number = same consent. The guest
   grouping never reads or changes consent (it runs from unverified order data: anyone can place a guest order with a victim's phone
   and their own email). `tests/unit/sms-consent-no-group.test.ts` makes the group loader throw if consent touches it.
2. The grouping links on the same full number, never the last 10 digits (+965 12345678 and +91 6512345678 stay apart). Placeholder
   phones do not link: under 8 digits, or the last 8 digits all the same (a manual order typed 01000000000). Ebda has no per-store
   placeholder-phone setting today, so none is read.
3. Bounds: the group loader pages by KEYSET (cursor on the id, newest first, never skip/offset; a concurrent insert cannot make it skip a
   member), reads at most 20,000 guest orders and logs a warning when it hits that cap. The dashboard counts on a Postgres store are
   an exact SQL GROUP BY of identity buckets (never a scan, so nothing is silently truncated). The group result is shared per store for
   10 s (BOUNDED-stale, display only, documented at the cache site): one dashboard load scans once.
   Security boundary: group membership never grants access or destructive power. Shopper export and erasure (PG and DO) are scoped only to
   identifiers proven to belong to the account and never load a group (`tests/unit/auth-erase-no-group-expansion.test.ts`).
   Residual: two different people who share a phone (a family number) are one customer in the merchant's display; grouping of guest
   orders older than the newest 20,000 is skipped on a very large store (logged).
   Cost if wrong: a guest shown as two rows (cosmetic) or two people merged into one display row; consent is unaffected either way.
