# Changelog — Ahmad's 2026-10-16 decisions (branch `fix/ahmad-decisions-1016`)

User-visible changes, by who sees them. Rulings: `docs/RULINGS.md` § "2026-10-16 — Ahmad's product decisions".

## Shoppers (storefront)

- **Egyptian Arabic sentences** (FU46-Y02a): the receipt ("طلبك اتسجل، الدفع عند الاستلام"), the delivery chip ("يوصلك بين …"), made-to-order ("بيتجهز خصيصًا لك في يومين"), InstaPay receipt upload, contact form, 3D viewer, unknown-store page, demo notices, Dahab bag and product page, return-policy / terms / FAQ return sentences and the size-needed checkout error and the order-success page speak Egyptian again. Buttons and labels keep a neutral form ("أرسل الإيصال", "موعد الوصول"). Counted nouns use Egyptian forms ("قطعتين", "يومين", "١٤ يوم"). Nothing a merchant typed changes.
- **"New" badge is off unless the store turns it on** (D1016-NEW-1): no card shows "جديد / New" by default.
- **Default store colours are Ebda's** (D1016-ORANGE-1): a store with no colours of its own is night with white buttons and a gold focus ring (a store on the Modern template gets that template's gold primary with dark text instead); the error page, link previews (OG image), invoices and app icons' default colour follow. Colours a merchant picked are unchanged.

- **Every storefront sentence is Egyptian** (FU46-Y02b): cart, checkout and its errors, account, login and password screens, wallet, loyalty, reviews, wishlist, FAQ, shipping, the returns form, empty and loading states. Legal text stays formal: privacy, terms, the returns-policy body and the cookie notice.
- **AI-written Arabic is Egyptian** for new output (FU46-Y02d): product FAQs, excerpts, how-to guides, AI-answer descriptions, SEO meta, review replies and marketing emails. Nothing already saved is rewritten.

## Merchants (admin)

- **Page Builder → Product card defaults → "New" badge on cards** (ar + en): turns the "New" chip on for products you mark as new or added in the last 14 days. Off by default (D1016-NEW-1).
- **No orange chrome** (D1016-ORANGE-1): the upgrade prompt, staff badge, AI FAQ review box, AI usage chart and WhatsApp settings use the Ebda gold of the rest of the dashboard; the orders app moves from orange to the same gold; a new PWA starts on Ebda night instead of orange.
- **App icons are made for each size by Cloudflare Images** (D1016-ICONS-1), once the deploy switch is on (D1016-ICONS-2): a sharp 16/32 px favicon, the 180 px Apple icon, and an Android adaptive icon with the art inside the safe zone on your PWA background colour. Until then, icons are stored as uploaded, as before.

## Ops

- New optional repo variable `EBDA_IMAGES_BINDING=true` adds the Cloudflare Images binding to the API deploy (docs/ENVIRONMENT.md). Enable Images on the Whisky account first (steps in Ruling D1016-ICONS-2).

## Review fixes (2026-10-16)

- **The store 404 page, the 3 remaining MSA notices and the copy-review rows** (39) read in Egyptian: "معلش، الصفحة اللي بتدوّر عليها مش موجودة أو اتنقلت.", "شيلنا ‹المنتج› من السلة", "خليك أول واحد يقيّم المنتج ده." and the rest. The style guide is in the quality bar (§ 2).
- **Legal day counts are formal again** ("خلال ١٤ يومًا") on the returns policy and terms.
- **AI suggestions** made with the old prompt are no longer served from the 7-day cache.
- **Admin** buttons, chips and progress bars that were still orange (`#fc6b02`) are Ebda gold with dark text; every gold button in the admin now uses the dark ink (white on gold was 3.07:1).
- **App icons:** the Images resize gives up after 10s and falls back, and the deploy adds the binding to every wrangler environment.
