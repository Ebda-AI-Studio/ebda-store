# NUMERALS-3

> Section: 2026-10-07 — Builder publish reaches the storefront + Western digits by default (branch `fix/builder-publish-and-digits`)

Ruling NUMERALS-3 — accepted residuals: (a) emails and invoices are Western always, including for an opted-in store — the opt-in covers the storefront web pages (the invoice/email senders would need the store theme threaded through every template; follow-up); (b) the WhatsApp bot copy defaults in `BotCopyTab.tsx` keep `١` / `٢` because they mirror the external WBS service's `botCopyDefaults.js` — changing only the mirror would make the admin lie about what the bot sends; change it in WBS first; (c) admin bare `toLocale*()` calls (97 in 53 files, admin + orders) were pinned with `withNumerals()` keeping the runtime locale, so an Arabic-phone merchant now sees Arabic month names with Western digits. Cost if wrong: (a) an opted-in store's emails show 123 — cosmetic.
