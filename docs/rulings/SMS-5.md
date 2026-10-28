# SMS-5

> Section: 2026-10-02 — SMS consent follow-ups (branch `fix/backlog-followups10`, issues 2423–2426)

**Ruling SMS-5 — every consent surface reads the same rows the gate and the withdrawal act on
(issue 2423; refines SMS-1 and SMS-3).** The account page, the admin profile (and the merchant MCP
profile through it) and the admin list now read the customer's own key row PLUS every row of the store
for the phone the surface already knows (profile phone, order phone). A granted row wins, newest grant
first; otherwise the most recently changed row decides revoked/none (`SmsConsentService.getForCustomerKey`
/ `statusForKeys`, `pickConsentRow`). Before, they read the key row alone while the gate matched the
phone, so a guest who opted in at checkout and then registered (a different `customerKeyOf` key) kept
receiving offers with no consent shown and no "Stop SMS offers" button. Evidence: integration tests
"a guest opt-in shows on the account the same phone registers later…" and "a later grant on another key
… outranks the account's own withdrawn row"; mutants dropping the phone from the profile read (2 red)
and from the list read (1 red), restored byte-identical; both pinned in the defence-mutation record.
Accepted residual: two people sharing one number see each other's consent state on their account pages
(grant time and source, never another contact detail; the phone shown is their own). That is the same
sharing SMS-3 already accepts for withdrawal. Cost if wrong: a shopper sees "subscribed" for a consent
someone else gave on the same number, and withdrawing stops it for both, which fails closed.
