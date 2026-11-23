# QA98-ALIAS-1

> Section: 2026-11-23, Customers list guest dedupe (STORE-QA-98), supersedes the grouping half of AP-12

**Ruling QA98-ALIAS-1 - ONE alias-set grouping for every customer surface; stored keys never change.**
Guest orders keep their stored key (`customerKeyOf`: lowercased email, else the phone verbatim), because consent rows, RFM hashes and
bookmarked links all hold it. Guests who are provably one person are grouped at READ time by `CustomerGroups`
(`lib/customer-groups.ts`): two identities are linked when they share a lowercased email OR a canonical phone (last 10 digits),
transitively. The group is addressed by its smallest member key, so grouping is deterministic and independent of the order orders
arrive in. Registered customers are their own group; a contact-less guest stays `guest:<orderId>`.
Every surface resolves through that one class (no copies): the Customers list and export, customer detail (any member key opens the
group), RFM and cohort rollups (`rfmKeyFor(group key)`), the dashboard distinct-customer and repeat-buyer counts (both backends return
identity rows, grouped once in `lib/buyer-counts.ts`; the SQL twin `customer-key-sql.ts` is removed) and SMS consent CHECK/withdrawal.
A Postgres store reads the groups and counts through the store client in bounded pages (no raw SQL on public.orders).
Consent fails toward NOT texting: if ANY member key or phone of the group has opted out the group is not texted whatever another member
granted; an opt-out through any member withdraws every granted row of the group; the surfaces show the group as withdrawn.
Security boundary: groups are built from UNVERIFIED order data (anyone can place a guest order with someone else's phone and their own
email). Group membership therefore never grants access or destructive power. Shopper-initiated export and erasure (GDPR, consent erase,
the Durable Object `eraseShopper`) are scoped ONLY to identifiers proven to belong to the account (user id, the account's own email,
its own phone, `provenBuyerKey`); they never load or expand a group (`tests/unit/auth-erase-no-group-expansion.test.ts`). An opt-out
record is never deleted through grouping; only its proven owner's erasure removes it. The group may only SUPPRESS messages (the
consent check and a withdrawal), and drives merchant-side DISPLAY (list, detail, RFM, segments, counts).
Residual: (1) a shopper who opted out and later opts in again through a NEW key stays blocked while the old withdrawn row exists in
the group (same-key re-grant still works); a merchant-visible re-opt-in flow is a follow-up. (2) Two different people who share a phone
(a family number) are one customer. (3) Groups come from the newest 20,000 guest orders (the list's own cap); older ones fall out of the grouping, never into a wrong group. (4) Postgres-store counts read at most 200,000
orders per count.
Cost if wrong: a guest shown as two rows (cosmetic) or two people merged into one row (display and consent: the merge can only stop
texting, never start it).
