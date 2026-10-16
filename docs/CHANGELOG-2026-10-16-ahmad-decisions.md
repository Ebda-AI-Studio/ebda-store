# Changelog — Ahmad's 2026-10-16 decisions (branch `fix/ahmad-decisions-1016`)

User-visible changes, by who sees them. Rulings: `docs/RULINGS.md` § "2026-10-16 — Ahmad's product decisions".

## Shoppers (storefront)

- **Egyptian Arabic sentences** (FU46-Y02a): the receipt ("طلبك اتسجل، الدفع عند الاستلام"), the delivery chip ("يوصلك بين …"), made-to-order ("بيتجهز خصيصًا لك في يومين"), InstaPay receipt upload, contact form, 3D viewer, unknown-store page, demo notices, Dahab bag and product page, return-policy / terms / FAQ return sentences and the size-needed checkout error speak Egyptian again. Buttons and labels keep a neutral form ("أرسل الإيصال", "موعد الوصول"). Counted nouns use Egyptian forms ("قطعتين", "يومين", "١٤ يوم"). Nothing a merchant typed changes.
- **"New" badge is off unless the store turns it on** (D1016-NEW-1): no card shows "جديد / New" by default.
- **Default store colours are Ebda's** (D1016-ORANGE-1): a store with no colours of its own is night with white buttons and a gold focus ring; the error page, link previews (OG image), invoices and app icons' default colour follow. Colours a merchant picked are unchanged.

## Merchants (admin)

- **Page Builder → Product card defaults → "New" badge on cards** (ar + en): turns the "New" chip on for products you mark as new or added in the last 14 days. Off by default (D1016-NEW-1).
- **No orange chrome** (D1016-ORANGE-1): the upgrade prompt, staff badge, AI FAQ review box, AI usage chart and WhatsApp settings use the Ebda gold of the rest of the dashboard; the orders app moves from orange to the same gold; a new PWA starts on Ebda night instead of orange.
