# EC-5

> Section: 2026-09-25

**Ruling EC-5 — the storefront unsubscribe link lands on a confirm page; the GET never
unsubscribes.** Link scanners (Outlook Safe Links, corporate gateways) and mail-client previews
fetch GET URLs automatically; an unsubscribe-on-GET would silently withdraw consent for people who
never clicked. True one-click is the RFC 8058 `List-Unsubscribe-Post` header, which the mailbox
provider POSTs. Cost if wrong: a subscriber clicking the body link needs one more tap.
