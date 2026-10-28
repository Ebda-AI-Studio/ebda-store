# PASSKEY-3

> Section: 2026-10-15 — Phase B1 Qamar (B1-\*)

Ruling PASSKEY-3 — RP ID = the request HOST, read from the browser `Origin`, never from the body. Admin: host of `ADMIN_URL`. Storefront: the Origin must resolve to a store (slug host, or a VERIFIED custom domain) or the call is 404 (no default-to-first); the credential stores `rp_id` and is refused on any other host. A custom-domain switch therefore invalidates shopper passkeys by design: they are listed as "needs re-enrol" and can be added again; password and email-reset sign-in are unaffected. Evidence: `resolvePasskeyContext` cases, cross-store, same-store-other-host and custom-domain re-enrol tests. Cost if wrong: shoppers re-enrol once after a domain change; a registrable-domain RP ID would avoid that but would let every subdomain of a merchant's domain mint credentials.
