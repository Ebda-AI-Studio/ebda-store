# Product feeds for Google, Meta and TikTok — خلاصات المنتجات للإعلانات

Run Google Shopping and free listings, Facebook and Instagram catalogue ads, and TikTok catalogue ads from the products you already have. Available on every paid plan.

## Where — فين

Admin → Marketing → **Product feeds**. You get one link per platform and per language (Arabic, English).

## What is sent — إيه اللي بيتبعت

- Every active product, **one item per size/colour combination**, grouped under the product. Drafts, archived products, wholesale-only products and switched-off variants are left out.
- Title and description in the feed language, price, sale price (from the compare-at price), availability, images, brand, barcode (only a real GTIN passes), category, size, colour, a link to your own store address.
- The same item id is used by the Meta and TikTok pixels and by Ebda Chat, so retargeting ads match your catalogue.

## Set up — الإعداد

1. **Google Merchant Center**: Products → Data sources → add a product source → from a file → scheduled fetch → paste the Google link.
2. **Meta Commerce Manager**: your catalogue → Data sources → Add items → Data feed → scheduled feed → paste the Meta link.
3. **TikTok Catalog Manager**: Assets → Catalog → add products → data feed → scheduled fetch → paste the TikTok (CSV) link.

Each platform re-reads the link on its own schedule, so prices and stock follow your store. A change you save is live in the feed within moments; a platform's own copy can lag by up to five minutes (one minute for gold-priced stores) plus its fetch interval.

## Health — الصحة

The page lists every item that is left out (no image, zero price, switched-off variant) and what to improve (no description, a barcode that is not a valid GTIN, no brand, clothing without colour, size, gender and age group). Fix and press Refresh.

Large stores are split into files of 5000 items: add each as its own source (`&part=2`, `&part=3`).

## Limits — حدود

- Images should be at least 500 x 500 pixels; Ebda cannot measure that for you.
- Ads link to the product page, not to a pre-selected size or colour.
- Shipping is included only when your delivery fee is the same everywhere; otherwise set shipping inside each platform.
