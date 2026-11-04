# Admin fix pass, T4 store setup pages (2026-11-04)

Judged on what lives where, which buttons exist and where, outcome-verb Egyptian labels, and the fewest decisions before the first useful click (Ahmad's scope, plan section 0.1).

Pages

- Shipping and delivery: one "الشحن والتوصيل" page as four tabs (`ShippingTabs` on `/shipping`, `/shipping-carriers`, `/delivery`, `/cod-reconciliation`; URLs unchanged). Rates tab: first-run card "سعر واحد لكل مصر؟", "أسعار مختلفة لكل محافظة" below, one sticky Save for rates + return policy, export/import in the overflow. Delivery tab: sticky Save, toasts instead of a bottom banner, no "back to settings".
- Branding: one Save (sticky, dirty only) sending one `PUT /stores/:id/branding-bundle`; `settings` carries only `contact`. The theme tab keeps colours, logo size and the advanced looks; the blog switch moved to the blog page, the web-push switch to notifications, the Arabic-irrelevant uppercase switch is gone.
- SEO: no header actions; AI helper sits above the fields, the language block and the Google preview follow the store's default language, AEO ("الإجابات اللي بتظهر في ChatGPT"), card image, verification and the Wikipedia links are under "متقدم", one Save. Arabic text in an English field is refused (naming the fields) and a swapped AI answer is swapped back (`language-guard.ts`). FAQs and how-to guides moved to `content/faqs` ("أسئلة وأجوبة"); old `#faqs` / `#howtos` links redirect.
- Payments: "شغّال دلوقتي" strip with a switch per method on top, "ضيف وسيلة دفع" provider cards below (per-card Save kept only for provider connections), no back button.
- Notifications: events table first, web-push switch, channel credentials collapsed in "إعداد القنوات", broadcast composer collapsed with a link to campaigns.
- Tax: steps strip (register, e-invoicing, rates), delete asks through `useConfirm`, time zone moved to the language page. Domain: separate "waiting" / "wrong pointing" / "email records" states, copy-all and email-instructions, remove asks first. Codes: cross-links only (decision D5). PWA ("تطبيق على موبايل العميل"), floating WhatsApp button, announcement, language: sticky Save, toasts, manifest under "متقدم".
- Native `confirm()` swapped for `useConfirm()` in blog, SEO redirects, size charts, tax documents; `backTo*` removed from agent keys, merchant keys, webhooks, SEO redirects and the pages above. Both entries removed from `admin-action-placement-known-debt.json`.

Data and API

- BE:F-2 client: `buildCheckoutDeliverySettings` no longer takes `existingSettings`; the delivery page, language page and branding send only their own `settings` keys (the server merges against the live row).

Rulings

- Ruling T4-1 - D2 is delivered as one shared tab strip over the four existing routes, not one merged route. Plan section 0 forbids changing existing page URLs and the admin search anchors are per route directory. Cost if wrong: four URLs instead of one; no data or link change.
- Ruling T4-2 - D3: brand colours stay on the branding page (defaults taken). The logo size keeps the "تلقائي" option beside صغير/وسط/كبير so a store with the stored default shows a selected choice. Cost if wrong: one extra button.
- Ruling T4-3 - the three seldom-used looks (card frame, footer logo, social icon colours) stay in a collapsed "متقدم" group on the theme tab instead of being deleted, because the editor has no control that edits them yet. Cost if wrong: they stay one click deeper than the editor would.
- Ruling T4-4 - `apps/admin/src/lib/settings-registry.ts` and its generated index were edited outside the T4 file list: the moved anchors (`branding.blog`, `branding.web-push`, `seo.faqs`, `seo.how-tos`) and `/content/faqs` must be registered or `settings-registry.test.ts` fails. Cost if wrong: a merge conflict with another track editing the same file.

i18n

- All copy is in `apps/admin/src/i18n/fragments/t4.{ar,en}.json` (new keys and Egyptian overrides for shippingHub, shipping, checkoutDelivery, branding, blog, seo, paymentSettings, notifications, tax, domain, language, pwa, floatingWidget, announcement). `ar.json` / `en.json` are untouched; the integrator runs `scripts/merge-i18n-fragments.mjs`.

Tests

- New: `branding-bundle-save`, `delivery-payload-only-own-keys`, `shipping-first-run`, `payment-settings-active-strip`, `notifications-events-first`, `seo-language-guard`. Updated: delivery page, COD reconciliation, tax page, SEO redirects, checkout-delivery payload.
