> **INTERNAL — Force AI / Force Media team. This document names competitors and includes market analysis for sales preparation. Not for client distribution.**

# Force AI Store — What Merchants Get (and How We're Positioned)

_Last updated: 2026-06-15. Pricing figures are sourced from live provider pages and third-party
research; check linked sources before making a purchase decision._

---

## What This Document Is For

Kuwait's e-commerce market has a structural profile that generic platforms weren't designed for.
KNET — the national debit network backed by Kuwait's major banks — accounts for more than 70% of
digital transactions in the country ([Adyen, 2026](https://www.adyen.com/payment-methods/knet)). A
merchant who can't accept KNET is effectively invisible to the majority of Kuwaiti shoppers. On top
of that, Kuwait's new Decree 10/2026 requires that customer-facing communications, product
information, and terms be available in Arabic
([Zelicra, 2026](https://zelicra.com/blog-decree-10-2026-complete-guide)), making bilingual
storefronts a legal baseline, not a nice-to-have. Add the regional expectation of WhatsApp-based
order communication, and the picture becomes clear: most platforms on the market were built for
Western markets first and treat the Gulf as a retrofit.

This document captures what merchants get from Force AI Store, what the market alternatives offer,
and where the real gaps are — so Force AI sales conversations are grounded in facts.

---

## The 4 Pillars Force AI Store Is Built Around

**1. AI as default, not an upsell.** Every content task a merchant would normally do by hand —
translating product names into Arabic, writing SEO meta descriptions, suggesting categories, filling
FAQ sections — has a one-click AI button. Bulk sweeps let a merchant translate or generate SEO copy
for an entire catalogue in a single action. This is built into the platform at no per-use cost to
the merchant; it is not a third-party add-on or a higher-tier feature. The practical effect: a
merchant adding 50 new products doesn't need to write 50 Arabic descriptions manually.

Beyond content generation, AI runs the **WhatsApp DM ordering bot** — a natural-language commerce
assistant that turns customer DMs into completed orders without any human agent. The bot understands
Arabic and English in the same conversation, transcribes voice notes, matches product photos against
the catalog, and greets returning customers with a personalized "want the same as last time?"
message.

**2. Arabic-first, not Arabic-as-afterthought.** Every database field that holds text has both an
English and an Arabic column — product names, descriptions, category labels, SEO fields, FAQ
content, review body. The admin dashboard is fully bilingual with RTL layout. Checkout and
storefront search work in both languages simultaneously. This is a data-model decision made at the
start of the platform's design; it cannot be added later by flipping a setting.

**3. Kuwait payment stack, native.** Force AI Store integrates with Tap, MyFatoorah, Hesabe, and
UPayments — all four of the main Kuwait-licensed payment processors, all of which provide KNET
access. Per-store payment credentials are stored encrypted. No third-party app install is required.
For GCC merchants who need Apple Pay or regional card schemes, MyFatoorah covers that too.

**4. Customization granularity without a developer.** Merchants can adjust typography per section
of their storefront, choose a background colour preset for the entire site, control card frame shape
and size, manage section-level copy, and generate a matched palette from a single brand colour.
These are dials that exist in the admin panel. On most competing platforms, reaching this level of
visual control requires either buying a premium theme or hiring a developer to edit theme code.

---

## Detailed Comparison Matrix

| Dimension                           | Force AI Store                                                                                            | Shopify                                                                                                                      | Salla                                                         | Wix                                                           | Magento Open Source         | WooCommerce                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------- | ----------------------------- |
| Bilingual EN/AR out of the box      | Native — every field has AR + EN columns, RTL admin                                                       | Free Translate & Adapt app (2-language auto, 100k char/yr limit)                                                             | Native AR; EN storefront limited                              | Plugin-based; partial RTL                                     | Extension required          | WPML plugin (~$99/yr)         |
| AI translation (EN↔AR)              | Built-in, free, per-field + bulk sweep                                                                    | Shopify Magic — partial, limited to higher plans, no AR bulk                                                                 | Not available                                                 | Not available                                                 | Not available               | Not available                 |
| AI SEO (meta titles + descriptions) | Built-in free — store, categories, products, bilingual                                                    | Shopify Magic — English only, partial coverage                                                                               | Not available                                                 | Not available                                                 | Not available               | Via third-party plugin        |
| AI bulk content fill                | Full sweep: translate, SEO, AEO FAQ/HowTo in one job                                                      | Not available as bulk                                                                                                        | Not available                                                 | Not available                                                 | Not available               | Not available                 |
| KNET (Kuwait national debit)        | Native via Tap, MyFatoorah, Hesabe, UPayments                                                             | Via third-party app; app install + separate merchant agreement required ([Shopify App Store](https://apps.shopify.com/knet)) | Not available — Saudi-first (Mada, STC Pay)                   | Via third-party integration                                   | Via extension               | Via extension                 |
| Tap Payments                        | Native                                                                                                    | Via app                                                                                                                      | Not primary                                                   | Via app                                                       | Via extension               | Via plugin                    |
| MyFatoorah                          | Native                                                                                                    | Via app                                                                                                                      | Supported in SA/KW                                            | Via app                                                       | Via extension               | Via plugin                    |
| Hesabe                              | Native                                                                                                    | Not in app store                                                                                                             | Not available                                                 | Not available                                                 | Custom integration          | Custom integration            |
| UPayments                           | Native                                                                                                    | Not in app store                                                                                                             | Not available                                                 | Not available                                                 | Custom integration          | Custom integration            |
| WhatsApp order notifications        | Built-in via WBS bridge (4 lifecycle templates, per-event toggles)                                        | Via third-party app ($15–$50/mo typical)                                                                                     | Via third-party                                               | Via third-party                                               | Via extension               | Via plugin                    |
| WhatsApp DM ordering bot            | Built-in — NLU + voice + photo + returning-customer personalization                                       | Not available                                                                                                                | Not available                                                 | Not available                                                 | Not available               | Not available                 |
| Merchant-initiated payment links    | Built-in — typeahead product picker + custom amount, all 4 gateways                                       | Via third-party app                                                                                                          | Via third-party                                               | Via third-party                                               | Via extension               | Via plugin                    |
| Custom domain per store             | Auto-provisioned via Vercel API                                                                           | Yes                                                                                                                          | Yes                                                           | Yes (Business plan+)                                          | Yes (self-managed)          | Yes (self-managed)            |
| Storefront themes                   | 5 themes, all fully configurable                                                                          | 100+ (most premium themes $150–$350 one-time) ([Shopify](https://www.shopify.com/pricing))                                   | ~30 themes                                                    | Hundreds (generic, Western-oriented)                          | Thousands via marketplace   | Thousands via marketplace     |
| Per-section typography control      | Yes — merchant-controlled per zone, no dev required                                                       | Theme Liquid edit (developer access needed)                                                                                  | Limited                                                       | Limited (Business plan)                                       | Full (developer required)   | Full (developer required)     |
| Per-product discount engine         | Yes — dropdown (None / Percentage / Fixed KWD) with live preview; replaces manual compare-at-price        | Compare-at-price only (manual field, no dropdown or live preview)                                                            | Compare-at-price only                                         | Compare-at-price only                                         | Via extension               | Via plugin                    |
| Full accounting (Chart of Accounts) | Yes — Finance hub with journal, P&L, expense approval, invoicing (Professional+); advanced on Enterprise+ | No — requires external accounting software                                                                                   | No                                                            | No                                                            | Via extension               | Via extension                 |
| Multi-currency bookkeeping          | Yes — FX capture + automatic KWD conversion (Enterprise+)                                                 | Requires Plus plan or app                                                                                                    | Limited                                                       | Limited                                                       | Via extension               | Via plugin                    |
| Bank reconciliation                 | Yes — CSV/OFX import + ledger matching (Enterprise+)                                                      | Via third-party app                                                                                                          | No                                                            | No                                                            | Via extension               | Via plugin                    |
| Barcode scanning                    | Yes — mobile receive / pick / cycle-count (Enterprise+)                                                   | Via app ($20–$50/mo)                                                                                                         | No                                                            | No                                                            | Via extension               | Via plugin                    |
| Multi-warehouse                     | Yes — per-location stock + routing (Enterprise+)                                                          | Shopify Plus only                                                                                                            | No                                                            | No                                                            | Via extension               | Via plugin                    |
| Inventory management                | Full module — stock dashboard, suppliers, purchase orders, reorder alerts, barcode, multi-warehouse       | Built-in (strong)                                                                                                            | Basic                                                         | Basic                                                         | Full (developer-maintained) | Via WooCommerce Stock Manager |
| Abandoned cart recovery             | Built-in, core feature                                                                                    | Built-in (Basic plan+)                                                                                                       | Built-in                                                      | Built-in (Core plan+)                                         | Via extension               | Via plugin                    |
| Server-side CAPI (Meta + TikTok)    | Yes — fires on order even when browser pixel is blocked by ad-blockers                                    | Via Shopify Audiences (Plus) or app                                                                                          | Not available                                                 | Not available                                                 | Via extension               | Via plugin                    |
| Multi-tenant / agency model         | Yes — one codebase, N merchant stores                                                                     | No                                                                                                                           | No                                                            | No                                                            | Possible but complex        | No                            |
| PWA (installable on phone)          | Per-store feature flag, built-in                                                                          | No (requires headless setup or app)                                                                                          | Yes                                                           | No                                                            | Via extension               | Via plugin                    |
| App marketplace                     | No — everything is first-party                                                                            | ~8,000 apps ([Shopify App Store](https://apps.shopify.com))                                                                  | Limited                                                       | ~700 apps                                                     | Large extension marketplace | Large plugin marketplace      |
| Monthly cost (entry)                | Agency-priced, no public self-serve signup                                                                | $39/mo (Basic) ([Shopify Pricing](https://www.shopify.com/pricing))                                                          | ~$27/mo (SAR 99) ([Salla Plans](https://salla.com/en/plans/)) | $29/mo annual (Core) ([Wix Plans](https://www.wix.com/plans)) | Free + $50–200/mo hosting   | Free + $10–50/mo hosting      |

---

## Per-Platform Context

### Shopify

Shopify is the most mature general-purpose e-commerce platform available to Kuwait merchants, and
its strengths are real. The Basic plan ($39/mo) gives you a solid foundation with inventory
management, abandoned cart, and good mobile checkout. The app ecosystem — roughly 8,000 apps —
means almost any integration you need exists. Shopify's Translate & Adapt app is now free and
supports auto-translation for up to two languages (100,000 characters per year limit), which covers
the EN/AR use case for smaller catalogues.

Where it falls short for Kuwait specifically: KNET is not natively supported. WhatsApp order
notifications require a separate app at $15–50/mo. The Translate & Adapt 100k-character annual
limit becomes a real constraint for a merchant with 200+ products with full descriptions in both
languages. Shopify Magic AI content is English-only and not available on the Basic plan. Accounting
requires an external integration. Multi-warehouse and barcode scanning are Shopify Plus features.
The net effect: a Kuwait merchant on Shopify Basic ends up layering several apps to reach parity
with what Force AI Store includes natively.

### Salla

Salla is a legitimate force in Saudi Arabia and has a meaningful user base in the Gulf. Its pricing
is accessible — the Advanced plan at roughly SAR 99/month (~$26) makes it one of the most
affordable hosted options in the region, and the platform is genuinely Arabic-native. If your
business is primarily targeting Saudi Arabia and you sell in SAR, Salla is a strong choice: it
integrates natively with Mada and STC Pay.

The Kuwait-specific issue is the payment stack. KNET is not natively supported — Salla is
architected around the Saudi payment ecosystem. A Kuwait merchant on Salla faces the same
third-party-app overhead as on Shopify for KNET acceptance. AI-assisted content tools are not
currently a core Salla feature.

### Wix

Wix is a capable website builder with e-commerce added on. For a merchant who primarily needs a
visual presence with a small product catalogue and doesn't require deep stock management or
Kuwait-specific payments, the Core plan ($29/mo annual) is an honest entry point.

The limits show quickly for serious e-commerce in Kuwait. Arabic support requires plugins; RTL
layout is partial and inconsistent across third-party templates. KNET requires a third-party
integration. The platform's e-commerce depth — inventory, accounting, order management — does not
match what dedicated commerce platforms provide. Wix is a good fit for a service business or a
brand-first site that happens to sell a few products. It is not a fit for a merchant whose entire
business runs through their online store.

### Magento Open Source

Magento Open Source is free to download. For a developer or a business with in-house technical
staff, it offers the most configuration depth of any platform on this list.

The caveat is total cost of ownership. Realistic annual running costs for a production Magento Open
Source store — hosting, a developer for maintenance and updates, security patches, extensions for
missing features — range from roughly $5,000 to $90,000 per year depending on store complexity
([Elogic, 2026](https://elogic.co/blog/magento-pricing-explained/)). Magento makes sense at
significant scale (millions in GMV) or when a business has engineering staff on payroll.

### WooCommerce

WooCommerce is the WordPress-native e-commerce plugin and is, in principle, free. Its appeal is
full control over code and a massive ecosystem of themes and plugins.

In practice, a production WooCommerce store for a Kuwait merchant accumulates costs quickly:
quality hosting ($10–50/mo), an Arabic-capable theme or RTL plugin, WPML for bilingual content
(~$99/yr), a KNET payment extension, security updates, and ongoing maintenance. Estimates for a
credible mid-sized WooCommerce setup range from $1,400 to $6,500/yr in direct costs, plus the time
cost of managing WordPress core + WooCommerce + plugin updates. The platform is honest value for a
merchant with developer skills. It is not an appropriate choice for a merchant who wants to focus
on their products and customers rather than platform maintenance.

---

## Where Force AI Store Is NOT the Right Fit

Being honest about this matters.

**Very large catalogues (100,000+ SKUs).** Force AI Store's current architecture runs a shared API
instance. At extreme catalogue scale — think a distributor with 100,000+ products — the platform
hasn't been load-tested for that volume. Magento or a custom Shopify Plus build would be more
appropriate.

**B2B with complex contract pricing.** If your business sells wholesale with per-customer
negotiated price lists, tiered volume discounts, net-30 payment terms, and purchase-order
workflows, Force AI Store does not have those features built out. Platforms with dedicated B2B
modules are a better match.

**Dropshipping with AliExpress or Oberlo-style supplier sync.** Force AI Store does not have an
automated product-import pipeline from dropshipping supplier catalogues.

**Merchants who need a large theme gallery before deciding.** If choosing from dozens of visual
styles is important, other platforms offer far more variety than Force AI Store's 5 themes. Each
Force AI Store theme is deeply configurable, but the starting-point variety is narrower.

**Self-hosted / full data sovereignty requirements.** Force AI Store is a managed SaaS platform.
If regulatory or legal requirements mandate that all merchant data reside on self-owned
infrastructure, WooCommerce or self-hosted Magento are the appropriate answer.

---

## Total Cost of Ownership — Typical Kuwait Merchant, $50,000/yr GMV

This is an estimate for a merchant selling physical goods in Kuwait, needing bilingual EN/AR
content, KNET payment acceptance, and WhatsApp order notifications. All figures are annual at
current list prices.

| Cost Item                     | Force AI Store                       | Shopify Basic                        | Salla Advanced                  | Wix Business                   | WooCommerce (managed hosting)      |
| ----------------------------- | ------------------------------------ | ------------------------------------ | ------------------------------- | ------------------------------ | ---------------------------------- |
| Platform subscription         | Agency-priced (contact Force Media)  | $468/yr ($39/mo)                     | ~$324/yr (SAR 99/mo × 12)       | $468/yr ($39/mo annual)        | $0 (plugin is free)                |
| Hosting / infrastructure      | Included                             | Included                             | Included                        | Included                       | $120–$600/yr                       |
| Arabic bilingual              | Included                             | Included (free app, 100k char limit) | Included (AR native)            | ~$0–$120/yr (plugin or manual) | $99/yr (WPML)                      |
| AI translation + AI SEO       | Included                             | Not available on Basic               | Not available                   | Not available                  | Not available                      |
| KNET payment acceptance       | Included (via Tap/MyFatoorah)        | ~$120–$240/yr (third-party app)      | Not natively available          | ~$120–$240/yr                  | ~$100–$200/yr (extension)          |
| WhatsApp order notifications  | Included (WBS bridge)                | ~$180–$600/yr (WhatsApp app)         | ~$180–$600/yr (third-party)     | ~$180–$600/yr (third-party)    | ~$180–$600/yr (plugin)             |
| Payment transaction fees      | ~2–3% (gateway fee, no platform cut) | 2.9% online + any gateway fee        | Gateway fee varies              | 0–2.9% depending on plan       | 2.9% (gateway, no WooCommerce cut) |
| On $50k GMV transaction fees  | ~$1,000–$1,500                       | ~$1,450+ (Basic rate + gateway)      | Gateway-only (~$1,000–$1,500)   | ~$1,000–$1,450                 | ~$1,000–$1,500                     |
| **Approximate annual all-in** | **Contact Force Media**              | **~$2,220–$2,800**                   | **~$1,600–$2,400 (SA-focused)** | **~$2,000–$3,000**             | **~$1,500–$3,000**                 |

**Notes on this table:** Force AI Store is sold as a **managed e-commerce service** — every client
gets a custom proposal, not a self-serve subscription. The comparison above shows what the
equivalent capability basket costs on other platforms. Transaction fees on competitor platforms are
gateway fees paid to the merchant's chosen processor. Under Force AI Store, your KNET/card payment
provider (Tap, MyFatoorah, Hesabe, or UPayments) charges its standard 2-3.5% directly to you —
Force AI Store doesn't take a cut. Shopify's 2.9% rate applies when using Shopify Payments, which
is not available in Kuwait; actual rates depend on third-party gateway terms. WooCommerce totals
vary heavily based on hosting choice and required plugins; the range above reflects a credible
managed-hosting setup, not a discount shared host.

---

_Sources referenced in this document:_

- [Shopify Pricing](https://www.shopify.com/pricing) — verified 2026-05-22
- [Shopify Translate & Adapt app](https://apps.shopify.com/translate-and-adapt) — free, 100k
  char/yr auto-translation limit
- [KNET on Shopify App Store](https://apps.shopify.com/knet) — third-party app required
- [Salla Pricing Plans](https://salla.com/en/plans/) — verified 2026-05-22
- [Wix Plans](https://www.wix.com/plans) — verified 2026-05-22
- [Magento / Adobe Commerce Pricing 2026 — Elogic](https://elogic.co/blog/magento-pricing-explained/)
- [Adobe Commerce Pricing — CostBench](https://costbench.com/software/enterprise-ecommerce/adobe-commerce/)
- [WooCommerce Pricing 2026 — Omnisend](https://www.omnisend.com/blog/woocommerce-pricing/)
- [KNET payment method — Adyen](https://www.adyen.com/payment-methods/knet)
- [Kuwait Decree 10/2026 — Zelicra](https://zelicra.com/blog-decree-10-2026-complete-guide)
- [Selling on Shopify in Kuwait — EasyApps](https://easyappsecom.com/guides/selling-on-shopify-kuwait)
