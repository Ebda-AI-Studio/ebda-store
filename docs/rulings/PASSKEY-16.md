# PASSKEY-16

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling PASSKEY-16 (review M8) — a shopper's passkey notices are sent from the sender identity of the store they shop at (`EmailService.sendPasskeyNotice` via `sendForStore`), not from Ebda; a merchant's come from the platform. A shopper who has never heard of Ebda would read an Ebda security mail as phishing. Evidence: `passkey.service.test.ts` (merchant -> platform, shopper -> store with its store id). Cost if wrong: the notice carries the store's branding and reply-to.
