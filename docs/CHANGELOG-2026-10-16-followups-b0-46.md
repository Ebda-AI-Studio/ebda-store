# Changelog — B0-46 follow-up fixes (branch `fix/followups-b0-46`)

User-visible changes in this PR, by who sees them. Rulings: `docs/RULINGS.md` § "2026-10-15 — B0-46 follow-up fixes (FU46-\*)". Plan: `docs/plans/done/2026-10-15-followups-b0-46.md`.

Deploy order: web + admin first (they still accept the old API answers), then `gh workflow run cf-api-deploy.yml`.

## Shoppers (storefront)

- **Contact page messages reach the store** they were written on (store email, else the active owner; never Ebda's inbox, so a store with neither gets nothing), with a honeypot and Arabic feedback (FU46-1, help: create-your-store).
- **Arabic checkout header** shows the Arabic store name (FU46-3).
- **Product cards** wrap long names and never overflow at 390/360/320; add-to-cart turns icon-only where its label would not fit (FU46-T5).
- **Phone footer** shows the store name when there is no logo, on all 5 skins (FU46-4).
- **Share row** builds its link from the server, so it no longer flickers after load (Task 7).
- **Pre-order**: a sold-out size that takes backorders stays pickable, and the cart sells what the page offers (X-02, one server rule); no delivery date on a product that cannot be bought (X-03); sized products never one-tap add (C-01).
- **One fixed bar on a phone**: the buy bar replaces the tab bar and carries a cart link (C-04).
- **Every footer** links Privacy, Terms and Returns, plus the ©; WhatsApp sits under Contact (S-01).
- **Product page trust line** under add-to-cart: Cash on delivery (when the store accepts it) · Returns within N days (when declared) (S-02).
- **Receipt** shows the delivery window of the order's own zone, or none, and an "ask about this order" WhatsApp link (S-02, FU46-W1c-10).
- **Shipping zones** match the shopper's area or governorate by the whole name: an area no longer picks up another zone's fee because its name contains the zone's (FU46-13, help: shipping).
- **Cart** checkout is one filled 48px button with one label (C-03); counted nouns read in Modern Standard Arabic ("قطعتان") (Y-01) — superseded 2026-10-16: Egyptian forms ("قطعتين"), see `CHANGELOG-2026-10-16-ahmad-decisions.md`.
- **Arabic copy** (superseded 2026-10-16 by FU46-Y02a: full sentences are Egyptian again) across the storefront is Modern Standard Arabic: receipt status lines, delivery chip "يصلك", InstaPay receipt upload, contact form, 3D viewer, unknown-store page, demo notices, Dahab bag and product page (FU46-Y02, help: instapay, 3d-models).
- **Contrast**: default-orange buttons carry dark ink (any merchant primary is checked for 4.5:1), the sale badge and muted text read at AA (K-01..K-04, FU46-W1c-9).
- **"New" badge** shows on products from the last 14 days on every card (FU46-W1c-8).
- **Accessibility and RTL**: every accessible name is in the page's language, direction comes from `dir`, no text under 12px, all drawers and sheets share one primitive (R-01..R-06).

## Merchants (admin)

- **Order and refund alert emails** no longer go to Ebda's address. The invoice sent to your order-notification address (**Order invoice email** on the delivery settings page) is the new-order notice, and refund alerts go there too; with no address set, none is sent (FU46-1a).
- **Image uploads** are judged by their bytes: JPEG, PNG, GIF and WebP; a mislabelled photo is accepted and corrected, HEIC/AVIF get a clear refusal (FU46-5). Gallery uploads go in batches of 4 and keep every image that did upload, naming any refused file (FU46-6, FU46-6a).
- **PWA icon**: a square PNG of at least 512 px and at most 1 MB, used as sent (FU46-8).
- **Footer legal row** has its own settings (each link on/off, your own © line) under Legal row in Pages and the Page Builder's Footer card; saves and previews keep every setting (FU46-W1c-4, help: orders-and-cod).
- **Bulk edit** never writes stock or price onto a variant product; size pickers in manual orders and payment links list the real, active sizes (FU46-W1b-2, W1a).
- **Admin Arabic** writes numbers and the percent sign the Western way (NUMERALS-1, FU46-15).
- **Error messages** in the admin's language, including upload refusals and a ZodError from any zod copy answered as 400, not 500 (FU46-7, FU46-7a).
- **Signup**: two signup forms opened in the same millisecond both work (FU46-11); a guest page no longer logs a 400 on every load (FU46-2).

## Not in this PR

Money formatting and the receipt store name (`feat/b1-qamar`); F9/F11; the WhatsApp bridge tenant-context follow-up (flagged off); `npm audit` 9 high (pre-existing on main, own deps PR).
