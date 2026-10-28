# MONEYB-1a

> Section: 2026-10-08 — Money fixes batch B: tax documents, VAT base, COD fee, retention, shipping lifecycle, CSV prices, Egypt addresses (branch `fix/money-b`, MONEYB-\*)

Ruling MONEYB-1a — Orders placed before this release have no fiscal document and are NOT retro-numbered (a lazily issued number would carry today's date and break date order). Their printable page is titled "Order summary" under the order number (a verified-TRN legacy order keeps "Tax invoice", as before). Cost if wrong: a merchant needing a numbered document for a pre-release order must ask support; volume is small (VAT gate verified stores only since 2026-10-07).
