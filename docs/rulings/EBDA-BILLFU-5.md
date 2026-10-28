# EBDA-BILLFU-5

> Section: 2026-10-07 — Legal pages v1.0 (branch `docs/legal-pages`)

Ruling EBDA-BILLFU-5 — `BRAND.supportEmail` is now `hello@ebda.app` (was `support@ebda.app`). Evidence (coordinator, 2026-10-07): only `hello@` and `security@ebda.app` receive mail (Cloudflare Email Routing), so every surface reading `BRAND.supportEmail` (marketing/storefront footer, admin public shell, upgrade-request mailto, Swagger contact, VAPID subject default) pointed at a dead mailbox. `EBDA_SUPPORT_EMAIL` defaults to it; `.env.example` VAPID_SUBJECT updated. NOT changed here, on purpose: hardcoded `support@ebda.app` in `apps/marketing/src/lib/content.ts` (5 strings, ar + en legal/footer copy) and `apps/marketing/public/llms.txt` — the marketing copy work stream (copy/egyptian-arabic) owns those files right now. Cost if wrong: until that stream switches them, the marketing legal pages still print an address that does not receive mail.
