# Dahab (jewellery, handmade & premium gifts) - reference research 2026-10-14

Limits: Egyptian handmade-silver / gift shops that load a real web shop were hard to find (many guessed domains dead). Okhtein and Azza Fahmy are Egyptian but sell bags/high jewellery at luxury scale; Tiffany and Aesop-style sites block bots. Okhtein and Azza showed newsletter popups (not interacted with). Catbird returned HTML but no usable product URL, so no Catbird screenshots beyond HTML text.

## Stores studied (screenshots: research folder outside git, `dahab/`)

- **Azza Fahmy** (azzafahmy.com, Shopify, Egyptian heritage jeweller): bilingual Latin + Arabic calligraphy logo in a navy header, storytelling collections ("Tales of the Nile", Soraya), catwalk/film band, "a gift that says much more - wrapped in our signature box", fixed bottom nav (menu/search/account). PDP: technical description ("18kt Gold and Sterling Silver"), material row, SKU, ring size guide link, accordions (Customer care, Shipping), serif tracking-wide type. Verdict: Egyptian luxury tone reference for Worn/Workshop.
- **Okhtein** (okhtein.com, Shopify, Egyptian designer bags/jewellery): full-bleed editorial video-style hero, minimal chrome, WhatsApp contact in HTML, wishlist, newsletter popup with date of birth. Verdict: proof Egyptian brands use full-bleed editorial, not catalogues.
- **Mejuri** (mejuri.com, Shopify; global ref): top bar "free shipping every Monday", hero with traceable-gold story ("Salmon Gold"), "Essentials" macro-on-skin tiles, "Lab grown sapphires", **stores & services** (piercing studio appointments, events), engraving/monogram personalisation, gift cards, 18k gold, wishlist, "stack" (build a stack). Verdict: the Worn reference - macro on skin, scale, personalisation.
- **Catbird** (catbirdnyc.com, Magento; HTML only): "personalized/engraved/engravable", ring size chart, Klarna, lifetime warranty, gift cards.

## They have, Ebda lacks

1. Ring size guide + size picker (Azza, Mejuri, Catbird) - MISSING (grep size.?guide = 0; options exist but no chart).
2. Engraving / personalisation field with preview and price (Mejuri, Catbird) - MISSING (only order-level `customerNotes`).
3. Material / karat / weight / dimensions as structured facts ("عيار 21 · 4 مم · 3.2 جم") - PARTIAL (`weight Float`, `dimensions Json` on Product; no karat/material field and no PDP/card rendering of them; Worn look promises "size line in mm under each name").
4. Gift wrap + card message toggle, packaging showcase (Azza signature box, Mejuri/Catbird gift) - MISSING (grep giftWrap/giftMessage = 0).
5. Gift finder by occasion x budget (Gift box look) - MISSING (Tag + price filter exist; no occasion facet or budget chips on home).
6. Made-to-order lead time chip + delivery-date promise ("تتعمل في 3 أيام") - MISSING (grep leadTime/preorder = 0; `allowBackorder` only).
7. Appointment / consultation booking (Mejuri studios, Azza boutiques) - MISSING (no booking model; StoreLocation has addresses only).
8. Storytelling / maker pages and "journey of a piece" sequence - PARTIAL (brand-story, image-text, collection-list sections cover it; no step sequence section).
9. Warranty / lifetime care / certificate info row - MISSING (no warranty field; trust-badges is store-wide).
10. BNPL (Klarna at Catbird; valU/Tabby equivalents) - MISSING.
11. Wishlist, newsletter, bundles/stacks - HAVE (WishlistItem, NewsletterSubscriber, Bundle/FBT).
12. Macro-on-skin media + per-product video - MISSING (images only; no video).
13. Gold-price-linked pricing (price = grams x daily rate + making charge) - MISSING; this is inferred from Egyptian market practice, not seen on these sites.
14. Stock "only 1 left" for one-off handmade pieces - PARTIAL (inventory + lowStockThreshold; no PDP rendering found).

## Ebda already ahead

Arabic-first micro-typography (Reem Kufi / Markazi designs), COD and InstaPay for gifting, bundles and loyalty, merchant-editable looks. Azza's site is bilingual only in the logo and shows English UI; Okhtein is English-only; both push a newsletter popup over the first screen, which Ebda's brief rejects.

## Phase B platform features (ranked)

1. **Product facts**: material, karat, weight, dimension fields (ar/en) rendered as a size line on cards and a facts table on PDP (shared with Souq specs, Jasmine ingredients - one generic "facts" model).
2. **Personalisation field** per product (label, max chars, price add-on, optional script preview) carried to OrderItem and admin.
3. **Size guide** (ring/bracelet/chain, table + how-to-measure, per category).
4. **Gift options at checkout**: wrap toggle (price), card message, hide-price slip; plus send-date.
5. **Lead time + delivery-date chip**; made-to-order flag.
6. **Gift finder section**: occasion tags x budget chips, links into filtered PLP.
7. **Appointment / WhatsApp consult CTA** (start with a WhatsApp deep link with product context).
8. **Warranty/care accordion** per product or store default.
9. **Product video / macro media** in gallery.

## Look-specific ideas

- Worn: facts size line, size guide, engraving band, macro-on-skin gallery and video.
- Workshop: lead-time chips, "journey of a piece" 3-step section, maker strip, made-to-order flag, WhatsApp consult.
- Gift box: gift finder (occasion x budget), wrap + message toggle, delivery-date chip, packaging band, gift-card product.
