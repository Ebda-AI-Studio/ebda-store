# Force AI Store — Feature Catalog

> **Who this is for:** Kuwait and GCC merchants evaluating Force AI Store as their online store platform.
> Force AI Store is built and operated by Force AI (Kuwait) — a platform designed from the ground up for the Gulf market.

---

## 1. Storefront Features (ما يراه زبائنك)

These are the features your shoppers experience the moment they land on your store.

### Themes and Visual Design

Choose from five professionally designed themes — Modern, Elegant, Classic, Minimal, and Bold — each tuned to work beautifully in both Arabic and English. Unlike other platforms where themes cost extra, all five are included and every improvement we make reaches all themes simultaneously.

Your homepage includes a full-width hero banner that supports a single striking image or a multi-slide carousel, a brand story section (BrandStoryBlock) that uses your store image and description, and a trust strip that shows your three key selling points above the footer. An announcement bar at the top of every page lets you run a promo strip in seconds.

> 📸 Screenshot: Homepage with Arabic hero banner, brand story block, and trust strip in a minimalist theme

### Product Discount Engine (Starter+)

Set a per-product discount directly on the product edit form. Choose from three modes:

- **None** — no discount; the product shows its base price
- **Percentage (%)** — e.g. 15% off; the discounted price previews live as you type
- **Fixed (KWD)** — e.g. 2 KWD off; same live preview

The discounted price is derived and displayed automatically on the storefront as a "Was / Now" strikethrough. The `compareAtPrice` field is no longer a manual entry — it is computed from the active discount so there is no risk of stale markup pricing on your storefront.

### Product Catalog and Product Pages

Products are organized in a nested category grid — main categories with subcategories underneath, displayed in sizes calibrated for how GCC merchants actually photograph products. On any product page, shoppers can:

- Pick a product variant (size, color, flavor, etc.)
- See "Frequently Bought Together" suggestions based on real co-purchase data from your orders
- Read verified-purchase reviews with star ratings in Arabic and English
- View cross-sell and upsell recommendations you configure

> 📸 Screenshot: Product page with variant picker, Arabic reviews, and "Frequently Bought Together" strip

### Search (البحث)

The search bar works in Arabic and English at the same time. A customer typing "عسل" will find products whose Arabic name matches, even if the English name is "Honey." Autocomplete suggestions appear as they type, so shoppers find what they need without completing a full query.

### Shopping Cart and Checkout (عربة التسوق والدفع)

Cart contents are saved whether the customer is logged in or browsing as a guest — and sync automatically when they sign in. Checkout is a guided multi-step flow: delivery address, then payment method selection. The checkout only shows payment options you have configured for your store.

At the delivery step the customer picks their **Governorate** (المحافظة) then their **Area** (المنطقة) from a searchable typeahead — only areas that fall under the selected governorate appear — and fills a full Kuwaiti address (block, street, avenue, house, floor, apartment). The delivery fee shown is the fee you set for that specific area. A **"Save my info"** option stores the customer's address and selection **on their own device** (browser local storage, nothing on our servers) and pre-fills it next visit. The customer can also tick an **SMS promo opt-in** (off by default) to receive promotional SMS such as cart reminders and back-in-stock alerts.

For stores that offer free shipping, the cart shows **"Calculated at checkout"** until the customer picks an area, then resolves to the real per-area fee.

### Wishlist (قائمة الأمنيات)

Logged-in shoppers can save products to a wishlist and return to them later. A dedicated wishlist tab appears in the mobile bottom navigation bar alongside Home, Cart, and Search.

### Reviews (آراء العملاء)

Only customers who actually purchased a product can leave a review — no spam or fake entries. Reviews support a star rating and a written comment in Arabic, English, or both. AI tools automatically detect spam, translate reviews between languages, and help you draft a professional owner response. A per-product AI summary gives new shoppers the highlight reel of what buyers said.

### Multi-Language and RTL (عربي + إنجليزي)

Arabic is the primary language — not an afterthought. Every page renders correctly in right-to-left layout. Shoppers can switch between Arabic and English on any page. Product names, descriptions, category names, and all storefront text are stored in both languages separately, so neither version is a machine-translated overlay.

Numbers (prices, counts, quantities, page numbers, loyalty points) render in Western digits (0-9) everywhere by default, in both languages. Merchants can opt in to **Arabic numerals (٠١٢٣)** in Branding → Theme so Arabic-locale shoppers see Eastern Arabic-Indic digits instead — off by default so existing stores are unaffected. Identifiers like order numbers and tracking numbers always stay Western digits regardless of this setting.

### Mobile-First Design

The storefront is built for mobile shoppers first. On phones, a persistent bottom tab bar gives instant access to Home, Wishlist, Cart, and Search. The tab bar hides on checkout and product pages so it never competes with the main action. Product images are sized for how GCC merchants actually shoot on phones — not the oversized luxury-brand assumptions most Western platforms use.

### Installable as a Mobile App (PWA — تطبيق قابل للتنزيل)

With the Progressive Web App feature enabled, shoppers on iOS and Android can add your store to their home screen as if it were a native app — no App Store required. The icon, name, and splash screen match your brand.

### Blog (المدونة)

A built-in blog section lets you publish content that drives search traffic. Blog posts appear in a carousel on your homepage when the blog is enabled. You manage posts directly from the admin panel.

### Locations (المواقع)

A dedicated Locations page shows your physical branches on a real embedded Google Map, with your addresses and hours. The page is fully brandable — its colors and fonts are editable in Page Builder like any other section — and a Locations link appears in your storefront navigation and in the mobile bottom-bar **"Menu"** drawer so customers can find you in one tap. Map embeds are restricted to an allow-list of trusted map hosts for safety.

---

## 2. Admin Features (لوحة التحكم)

The admin panel is organized into eight hubs. Each hub owns one domain of your business.

### Dashboard (لوحة المعلومات)

Your store's heartbeat at a glance: today's revenue, recent orders, and a store health overview. The first screen you see when you log in.

> 📸 Screenshot: Dashboard with revenue summary cards and recent orders list in Arabic

### Catalog (الكتالوج)

Everything related to what you sell:

- **Products** — Add, edit, or bulk-import products with Arabic and English names, descriptions, images, pricing, and variants. Import via Excel/CSV with Arabic column headers supported.
- **Categories** — Create a nested category tree. Assign products to multiple categories. A "Best Sellers" virtual category assembles itself automatically from products you mark as bestsellers.
- **Page Builder** — Control your entire storefront layout from one place: reorder and show/hide homepage sections, edit section headlines and subheadlines, manage your storefront Navigation links, configure Footer links, and set up Category pages — all consolidated inside the Page Builder (not separate settings screens). AI can generate section copy for you.
- **Blog** — Write and publish posts.
- **Floating Widget** — Configure the sticky contact button that appears on every storefront page (premium add-on — see Section 7).
- **AI Tools** — Bulk-fill translations, SEO tags, and content across your entire catalog in one click (covered in detail in Section 3).

### Sales (المبيعات)

Everything that happens after a customer places an order:

- **Orders** — Full order list with status tracking, order detail view, and the ability to create a manual order for phone/WhatsApp customers. The orders list supports a date filter, search, and **bulk "mark paid"**. Each order detail offers status changes, mark-paid, generate/copy a payment link, issue a refund, refresh payment/refund status with the gateway, view or email the invoice, and an **order activity timeline**.
- **Orders export (.xlsx)** — Export your orders as an Excel workbook with an Orders summary sheet and a per-line "Line Items" sheet; each line item includes the product's Arabic name and cost price (KWD) so the export doubles as a bookkeeping source, not just a picklist.
- **Orders app (PWA)** — a separate installable, focus-mode order app that now **mirrors the admin order UI with full read/write control** — the same status changes, mark-paid, payment links, refunds, refresh payment/refund, invoice view/email, bulk mark-paid, and activity timeline. Staff members with order permissions can view and manage the store's orders from it, so order handling isn't tied to a desktop login.
- **Customers** — A built-in CRM with every customer's order history, contact details, and lifetime value.
- **Returns and Refunds** — Accept and process return requests, log the reason, and record the refund.

### Stock (المخزون)

Full inventory management without needing a separate system. Features are tiered by plan:

**Starter plan and above:**

- **Inventory Dashboard** — See current stock levels across all products at a glance. Variant products show a **variant stock total** (the sum of every variant's stock) on both the products list and the inventory page, so a multi-variant product reads one true number. The inventory page **paginates** across your whole catalog — there is no product-count cap. (`inventory.basic`)
- **Stock Adjustments** — Log any stock movement: received goods, damaged items, corrections. Each adjustment type carries a short plain-language explanation so staff pick the right one.
- **Deadstock Reports** — See which products haven't moved in a defined period so you can act on them. (AI-powered via Gemini)

**Professional plan and above:**

- **Low-Stock Alert Emails** — Set a minimum stock threshold per product; when a product's inventory drops below the threshold an automatic bilingual digest email is sent to the store owner. The alert fires once per drop event (deduplicated via Redis sentinel) and re-arms when the product is restocked above the threshold. Powered by the `stock-low-stock-alert` Inngest cron (every 6 hours). (`inventory.stock_alerts`)
- **Backorders** — Accept orders for out-of-stock products and fulfill them when stock arrives. (`inventory.backorder`)
- **Reorder AI** — AI-driven reorder suggestions based on sales velocity and current stock levels.

**Enterprise plan only:**

- **Multi-Warehouse** ✅ — Track stock counts per warehouse location and route orders to the closest or highest-priority warehouse with sufficient stock. Warehouse CRUD (name, code, priority, lat/lng), per-warehouse stock view with inline edit and delta adjustments (audit trail in InventoryHistory), and an order-routing API (priority rule or Haversine proximity rule). Existing single-warehouse stores are unaffected when this flag is off. (`inventory.multi_warehouse`)
- **Barcode Scanning** — Scan barcodes from mobile to receive stock, pick orders, and audit inventory counts. (`inventory.barcode`) — **Implemented 2026-06-15**: barcode lookup (GET /inventory/lookup), scan-to-receive, scan-to-pick, cycle-count sessions + reconcile. Admin UI at Stock → Scan. BarcodeDetector Web API with manual-entry fallback.
- **Purchase Orders** — Supplier purchase-order workflow with cost capture, receive-against-PO, and supplier ledger. (`inventory.purchase_orders`)
- **Bulk Adjustments** — CSV import for stock reconciliation across hundreds of products at once. Upload a file with SKU or Barcode + **New Quantity** (absolute cycle-count) or **Delta** (signed +/− for found/damaged units). Arabic column headers are supported. The admin previews parsed rows and per-row validation errors before applying; the import posts as a single auditable Stock Adjustment with a GL journal entry. (`inventory.bulk_adjustments`)

**Available on all plans:**

- **Suppliers** — Maintain a supplier list linked to your products.

> 📸 Screenshot: Stock dashboard with reorder alerts highlighted in Arabic

### Finance (المالية) — Accounting module

Most e-commerce platforms make you connect QuickBooks or Xero for proper accounting. Force AI Store includes a full Finance hub — no third-party integration required.

**Professional plan and above:**

- **Chart of Accounts** — A real double-entry bookkeeping system organized by account categories (27 default accounts seeded on onboarding; system accounts are read-only — merchants may add custom child accounts under them).
- **Journal Entries** — Double-entry journal auto-posted on every paid order (sales revenue, cost of goods, refunds). Manual journal entry UI for non-order financial events.
- **Profit & Loss** — A live P&L report that reflects your actual store activity over any date range.
- **Expense Tracking** — Log operating expenses with category tagging and receipt attachment. Monthly summary by expense category. (`accounting.expenses`)
- **Invoicing** — Kuwait-compliant invoice generation: tax line, bilingual Arabic/English layout, PDF export. (`accounting.invoicing`)

**Enterprise plan only:**

- **Tax Reports** — VAT/sales-tax export per reporting period with full transaction-level breakdown. Sourced directly from the double-entry ledger (account 2100 — Tax Payable): each row shows date, order number, customer, taxable base, effective tax rate, and tax collected. Summary by tax rate with XLSX export. (`accounting.tax_reports`) **[SHIPPED]**
- **Multi-Currency** — Track non-KWD transactions with FX rates and automatic KWD conversion at the bookkeeping level. Supports USD, EUR, GBP, SAR, AED, QAR, BHD, OMR, EGP, TRY, INR, CNY. Every non-KWD line stores the original foreign-currency amount alongside the KWD-converted fils (half-up rounding, exact Decimal arithmetic — no float drift). FX rate registry lets merchants record the day's rate; all P&L and balance-sheet reports stay in KWD. (`accounting.multi_currency`) **[SHIPPED 2026-06-15]**
- **Profit Anomaly Watch** — Runs a daily AI scan of margins (06:30 KWT); flags unusual margin drops and cost-volume spikes vs a 28-day rolling baseline. (`accounting.profit_anomaly`)
- **Bank Reconciliation** — Bank statement import (CSV/OFX) with automated ledger matching and manual override. (`accounting.bank_reconcile`)

**Available on all plans:**

- **Payment Audit Trail** — Every payment has an append-only event log: the initial intent, every webhook from Tap / MyFatoorah / Hesabe / UPayments, every refund, every admin action — all preserved with the raw provider payload. If a dispute is raised 6 months later, the full sequence (with proof from the provider) is one click away. Most platforms only show you the latest payment status; we keep the full lineage.

This is the depth of accounting software typically found in platforms that cost ten times more.

### Analytics (التحليلات)

Five analytical views to understand how your store is actually performing:

- **Overview** — Revenue, orders, and visitor trends over any date range.
- **Cohort Analysis** — See how customer groups acquired in different months behave over time — which months brought loyal buyers vs. one-time shoppers.
- **Conversion Funnel** — Where are shoppers dropping off between landing and paying?
- **Customer Segments** — Group your customers by spend, frequency, and recency.
- **Product Analytics** — Which products are driving revenue and which are underperforming?

### Marketing (التسويق)

Everything you need to bring customers back and reach new ones:

- AI Bulk Sweeps (translation, SEO, AEO content — covered in Section 3)
- WhatsApp order notifications via the Force AI WhatsApp Business Platform bridge
- Push notifications to subscribed shoppers
- Abandoned cart recovery — automatic reminders to shoppers who left items behind
- Newsletter tools
- Marketing pixels (Meta/Facebook, Google, TikTok) with server-side Conversions API (CAPI) for Meta and TikTok — fires on every order even when browser ad-blockers suppress the client-side pixel
- Affiliate program management

### Settings (الإعدادات)

Full control over how your store looks and behaves:

- **Identity** — Store name in Arabic and English, logo (separate Arabic and English variants), contact details.
- **Theme and Branding** — Choose your theme, toggle visual features (brand badges, quick-add, brand story, trust strip, blog). Brand colors and fonts are set in **Page Builder → Smart Palette** and **Page Builder → Typography** — the Branding tab now shows read-only swatches with a direct link to the canonical editor.
- **Page Builder** — The single destination for all design decisions: brand color palette (Smart Palette), fonts (Typography), hero banner, per-section backgrounds, section order, and layout config.
- **Custom Domain** — Connect your own domain (e.g. mystore.com). The platform handles provisioning automatically.
- **Payment Providers** — Connect your KNET gateway credentials (see Section 4).
- **Feature Toggles** — Enable or disable individual features for your store.

> **Design system note (2026-06-09):** Page Builder is the canonical editor for all color, font, and hero controls. The Branding tab's standalone color pickers and font-family selector from prior versions have been retired in favour of Page Builder's Smart Palette and Typography library. All existing hero content was migrated to Page Builder slides; the legacy Hero page (`/hero`) now redirects to Page Builder.

---

## 3. AI Features (ما يميّزنا — الذكاء الاصطناعي)

Force AI Store ships AI assistance on every content-heavy task. There is no separate AI subscription — it is part of the platform. Every AI feature has a "smart skip" rule: if you already filled a field, the AI will not overwrite it.

**AI Autopilot (AI-first, ON by default).** You don't have to click anything. When you add or edit a product, the platform automatically fills the missing pieces — within about a minute — and a 3-day background sweep keeps the whole catalog complete. It's **bilingual both ways**: write the product in Arabic and the English fills in; write it in English and the Arabic fills in. Empty SEO tags are written in both languages, and new products get "frequently bought together" recommendations. The guarantee runs the other way too: **anything you type yourself — in either language — is marked yours and the AI never overwrites it** (your existing products are never touched without your edit). A small "✨ AI" badge shows which fields the AI wrote; next to any field you wrote, a "✨ Switch to AI" button hands it back to the engine on demand. You can pause Autopilot per store in Settings → Branding; the manual one-click "Generate" and bulk-sweep buttons keep working either way.

| Feature                                     | What it does                                                                                                                                                                            | Concrete example                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Auto-translate products** (ترجمة تلقائية) | Translates your product name and description between Arabic and English                                                                                                                 | You write "قهوة عربية أصيلة — خلطة فاخرة" and the AI fills in the English description for you                    |
| **Bulk translate entire catalog**           | One click translates all unfilled Arabic/English fields across your entire product list                                                                                                 | 200 products, 200 Arabic descriptions — filled in minutes                                                        |
| **SEO title + description generation**      | Writes search-optimized page titles and meta descriptions for your store, every category, and every product — in both languages                                                         | Generates "Buy Authentic Arabic Coffee Online in Kuwait — Free Delivery" and the Arabic equivalent automatically |
| **Bulk SEO sweep**                          | Runs the SEO generator across your entire catalog — store, all categories, all products — in one sweep                                                                                  | Launch-day shortcut: arrive with a full SEO footprint without writing a single meta tag manually                 |
| **Category suggestion**                     | Suggests which categories a product belongs to based on its name and description                                                                                                        | You add a new product; the AI chips suggest "Coffee," "Gifts," and "Ramadan Specials"                            |
| **Bulk product FAQ sweep**                  | Drafts up to 3 bilingual FAQ pairs for every product across the whole catalogue — skips products that already have FAQs; the PDP shows at most 3 FAQs regardless of how many are stored | Launch a 300-product catalogue with product-specific FAQs already in place                                       |
| **Bulk category assignment sweep**          | For every uncategorized product, assigns the single best-matching category from your OWN category list — never invents a new one, never re-sorts a product that already has one         | Bulk-imported products with no category get slotted in automatically                                             |
| **Bulk image alt-text sweep**               | Uses Gemini Vision to write concise, descriptive alt-text for product images missing one — improves SEO and screen-reader accessibility                                                 | 300 product photos get real, image-aware alt-text instead of blank or generic labels                             |
| **Bulk product excerpt sweep**              | Summarizes each product's full description into a punchy 1-2 sentence bilingual excerpt — skips products that already have one                                                          | Compact summaries ready for search results and share cards without writing them by hand                          |
| **Bulk product tag sweep**                  | Suggests up to 5 tags per product from its name and description, reusing your store's existing tags wherever they fit                                                                   | A new seasonal product picks up "summer" and "best-seller" automatically instead of starting untagged            |
| **Section copy generation**                 | Writes the headline and subheadline for any homepage section                                                                                                                            | Click "Generate" next to your Featured Products section headline; get bilingual copy in seconds                  |
| **FAQ generation**                          | Writes 8 frequently-asked questions and answers for your store — in Arabic and English                                                                                                  | Covers shipping, returns, payment methods, and product care without you writing a single line                    |
| **How-To guide generation**                 | Writes 3 practical guides relevant to your products — bilingual                                                                                                                         | A coffee store gets brewing guides; a skincare store gets application instructions                               |
| **AEO meta rewrite**                        | Rewrites your existing meta descriptions in a conversational style that AI search engines (Google SGE, Perplexity, ChatGPT) prefer                                                      | Your keyword-stuffed description becomes a natural answer to "where can I buy X in Kuwait?"                      |
| **Review spam detection**                   | Scores every submitted review for authenticity before it appears                                                                                                                        | A fake 5-star review from a competitor scores 0.94 and is held for your review                                   |
| **Review auto-translation**                 | Translates customer reviews into the other language automatically on submit                                                                                                             | An Arabic review appears with an English translation below it for English-browsing shoppers                      |
| **Review summarization**                    | Generates a one-paragraph summary of all reviews for a product                                                                                                                          | "Customers consistently praise the rich flavor and fast delivery. A few noted the packaging could be sturdier."  |
| **Owner response drafting**                 | Drafts a professional reply to any customer review — one click per review                                                                                                               | Respond to 20 reviews in 5 minutes instead of 40                                                                 |

> 📸 Screenshot: Product edit form showing AI auto-fill buttons next to the Arabic and English description fields

**Note on reviews:** Force AI Store does not generate fake reviews. AI assists with translation, summarization, and response drafting only. All published reviews come from real verified purchases.

---

## 4. Kuwait/GCC-Specific Features (مخصص للكويت والخليج)

Force AI Store was built in Kuwait for Kuwait — not adapted from a Western platform.

### KNET and Local Payment Gateways

KNET (the Kuwaiti national debit network) is accessible through four fully integrated gateways. You connect the one you already have a contract with — or connect multiple and let the customer choose at checkout.

| Gateway        | What it supports                                   |
| -------------- | -------------------------------------------------- |
| **Tap**        | KNET + credit/debit cards — primary Kuwait gateway |
| **MyFatoorah** | KNET + cards + Apple Pay — widely used across GCC  |
| **Hesabe**     | KNET + Visa/Mastercard — Kuwait-specific           |
| **UPayments**  | KNET + digital wallets — Kuwait fintech            |

Your payment credentials are stored encrypted. No other merchant can see your gateway configuration.

Stripe is not available in Kuwait. Platforms built for the US and UK market add KNET as an afterthought through third-party plugins. On Force AI Store, KNET is native.

> 📸 Screenshot: Checkout payment step showing KNET option alongside card payment

### Arabic-First, Not Arabic-Supported

Every field in the database stores both Arabic and English content separately. The admin panel itself is bilingual — you switch between Arabic and English in one click without losing any data or formatting. Arabic text renders correctly in right-to-left without any plugins or workarounds, including product names, prices, categories, and the checkout flow.

### Kuwait Delivery Areas & Fees (مناطق التوصيل والرسوم)

Delivery is configured around Kuwait's real **governorate → area** structure — not a generic "country/state/city" hierarchy that doesn't match how Kuwaiti delivery works. The platform ships a canonical list of all six governorates and their areas.

From **Settings → Shipping → "Delivery areas & fees"**, each governorate is a collapsible accordion; you set a delivery fee per area, or use **"Apply to all areas in this governorate"** to set one fee across a whole governorate at once and tweak individual areas afterwards. **Hide unpriced areas:** once you price at least one area, customers only see the areas you priced. A store that has set no area rates yet falls back to its legacy shipping zones with all areas visible.

You can **export** your current rates as an Excel file (or, if you have none yet, an empty template of every Kuwait area) and **import** a filled-in Excel or CSV back — with a dry-run preview that shows exactly which rows will change before anything is saved. This replaces the old per-zone "Shipping Zones" editor; the zone API remains only as a fallback.

> This is the dedicated merchant how-to: `docs/merchant/shipping-areas.md`.

---

## 5. Multi-Tenant Capabilities (كل متجر مستقل بذاته)

Force AI Store runs multiple stores on one platform, but each store is completely isolated and independently configurable. Everything below is per-store, not shared:

| What you can configure          | Per store                                       |
| ------------------------------- | ----------------------------------------------- |
| Custom domain                   | Your own domain, auto-provisioned               |
| Theme                           | One of 5 themes, independently selected         |
| Logo                            | Separate Arabic and English logo variants       |
| Brand colors and fonts          | Full palette and typography per store           |
| Per-section typography          | Each homepage section independently styled      |
| Payment gateway + credentials   | Your gateway, your credentials, encrypted       |
| Branded email sender            | Order confirmations arrive from @yourdomain     |
| Push notification app           | Your store's push subscribers, not shared       |
| WhatsApp notification templates | Your WABA, your approved Meta templates         |
| Product images and media        | Stored in isolated storage — not shared         |
| Feature flags                   | Enable/disable features per store independently |
| AI content quota                | Daily AI budget per store                       |

When the platform ships a new feature or design improvement, all stores receive it at once — no manual upgrades.

---

## 6. WhatsApp Customer Ordering — واتساب التسوّق المباشر (Phase 6 + Phase 8)

Force AI Store connects to the **Force AI WhatsApp Business Platform** to turn every customer DM into a complete order — without any human agent typing it out.

### One-click Meta catalog setup — إعداد كتالوج Meta بضغطة واحدة

Connecting your store to WhatsApp's Native Catalog feature usually requires merchants to navigate Meta Business Manager — create a Business account, create a Commerce Catalog, generate a system-user token, copy 3 IDs into the admin panel. We removed all of that.

From Admin → WhatsApp Bot → Meta Commerce Catalog, click **Provision automatically**. The Force AI backend calls the Meta Graph API on your behalf to:

1. Create a new Commerce Catalog under the Force AI parent Business Manager (your store appears as a named catalog inside our umbrella account).
2. Assign the long-lived access token automatically.
3. Save the catalog ID + business ID + token (encrypted at rest) back to your store.

Then the existing product-sync pipeline pushes your full catalog to Meta within ~60 seconds. The only manual step left is submitting the catalog for Meta's 24-48-hour review — and we'll send you a Telegram alert as soon as the cutover is safe.

### How it works for the customer

1. Customer DMs your business WhatsApp number — even "hi" is enough.
2. Within 1 second they receive a category list (interactive tap-menu, not plain text).
3. Tap a category → product list. Tap a product → quantity picker. Tap quantity → cart summary.
4. Tap **Checkout** → receives a checkout link valid for 30 minutes.
5. Tap the link → lands on your Force AI Store checkout with their cart and phone number already filled in.
6. Pays via KNET, Tap, MyFatoorah, or their preferred gateway — the same checkout your website customers use.
7. Receives a WhatsApp thank-you message automatically after successful payment.

Bilingual from end-to-end: Arabic-speaking customers get the full Arabic flow; English customers get English. Language is detected automatically from their first message — no setup required.

### Bot intelligence — الذكاء الاصطناعي في المحادثة

The bot is not a rigid keyword-matching system. It understands natural language:

| Customer types             | Bot understands                                                   |
| -------------------------- | ----------------------------------------------------------------- |
| "بغيت أطلب قهوة بدون سكر"  | Finds coffee products, asks for quantity                          |
| "شو عندكم من حلويات؟"      | Shows the Sweets category                                         |
| "same as last time please" | Recognizes returning customer, offers to re-order their last cart |
| Sends a voice note         | Transcribes it, processes as text                                 |
| Sends a product photo      | Matches it against your catalog, suggests the closest product     |

**How it works:** powered by Google Gemini AI running inside the Force AI WhatsApp Business Platform. All AI cost is absorbed by the platform — there is no per-message or per-AI-call charge to merchants. No API key required on your side.

**Returning-customer greeting:** for any customer who has completed an order before, the bot opens with a personalized message offering to repeat their last order. This alone increases conversion for repeat buyers.

### Bot Copy — تخصيص رسائل البوت

Your bot's messages use your brand voice. From Force AI Store admin → Settings → WhatsApp Integration → Bot Copy, you can edit:

- The welcome greeting (Arabic + English)
- Category and product prompts
- Cart summary phrasing
- Checkout confirmation message

Changes apply immediately — no code deployment needed.

### Bot Analytics — تحليلات البوت

A dedicated analytics dashboard (Admin → WhatsApp Integration → Bot Analytics) shows:

- **Funnel**: how many conversations reached each stage (welcome → category → product → cart → checkout → paid)
- **Intent breakdown**: what customers asked for (ordering, browsing, support, unknown)
- **LLM stats**: how often Gemini classified intent vs. fell back to keyword mode
- **Input breakdown**: text vs. voice vs. image inputs over any date range

---

## 7. Order Notifications — إشعارات الطلبات

### Per-event, per-channel notification toggles

For every order lifecycle event, you choose whether the notification fires by email, WhatsApp, or both. Configure from Admin → Settings → WhatsApp Integration → Order Updates.

| Event               | What triggers it             | Channels available |
| ------------------- | ---------------------------- | ------------------ |
| **Order Placed**    | Customer completes checkout  | Email, WhatsApp    |
| **Order Confirmed** | You mark the order confirmed | Email, WhatsApp    |
| **Order Shipped**   | You add a tracking number    | Email, WhatsApp    |
| **Order Delivered** | You mark delivered           | Email, WhatsApp    |

Turning off either toggle for an event means notifications for that event are completely silent on that channel. For example: turning off WhatsApp for "Order Shipped" still sends the email shipping confirmation.

### Payment lifecycle alerts & auto-cancel — تنبيهات الدفع والإلغاء التلقائي

Beyond the per-event order notifications above, the platform watches the **payment** state of online orders and keeps it honest:

- **No false refund on unpaid cancel.** Cancelling an order that was never paid restores its inventory but **does not** tell the customer a refund was issued. A refund notification only fires when the order had actually been paid.
- **"Payment received."** When an online order moves from pending to paid — including when a customer finally pays a resent payment link — you get a "Payment received" alert so you know to fulfil it.
- **"Payment pending — follow up."** If an online order sits unpaid too long (default 60 minutes, configurable per deployment), you get a one-time "follow up" alert so it doesn't get forgotten. Cash-on-delivery orders never trigger this.
- **Auto-cancel stale unpaid orders.** Online orders left unpaid beyond a configurable window (default 2 days, matching the payment-link validity) are cancelled automatically. The customer gets the standard order-cancelled notice; no refund is attempted because nothing was ever captured.

**Origin-aware delivery:** orders placed on your website send via the configured channels (email + WhatsApp). Orders placed through WhatsApp DM ordering send **WhatsApp-only** — no synthetic placeholder email goes to the customer's inbox, because WhatsApp customers never registered an email address.

### Abandoned cart recovery — استرداد السلات المتروكة

Customers who leave items in their cart without completing checkout receive automated recovery reminders. As of Phase 8, the recovery sweep covers **both** website carts and WhatsApp DM carts — if a customer started ordering via WhatsApp but didn't tap Checkout, they receive a recovery reminder on WhatsApp too.

---

## 8. Smart Payment Links — روابط الدفع الذكية

Merchants can generate a payment link from any order in **Admin → Orders** and send it directly to a customer on WhatsApp. The feature:

- **Typeahead product picker** — search your catalog by name and add products directly to the link without leaving the admin
- **Custom amount** — set any amount for a payment link not tied to a specific product (service fees, deposits, etc.)
- **Multi-provider** — the link uses your store's configured payment gateway (Tap, MyFatoorah, Hesabe, or UPayments). No hardcoded provider.
- **Re-use existing URL** — if a payment link was already minted for an order, the Copy + Open buttons surface it inline without generating a new one.

This replaces the need to call customers back to re-do checkout. Send a link, customer pays in one tap.

---

## 9. Integrations (الاتصالات والتكاملات)

### WhatsApp Integration — التكامل مع واتساب

The WhatsApp integration is a single consolidated page in your admin: **Settings → WhatsApp Integration**. It covers six areas via tabs:

1. **Connection** — connect your Force AI WhatsApp Business Platform account with one API key. The card shows live status: "Connected / Not connected" + "DM ordering: ON/OFF" at a glance — you can see both states without clicking into the tab.
2. **Templates** — view all your Meta-approved templates. If Meta rejects a template, use the **Reset to Draft** button to rename it (e.g. `order_paid` → `order_paid_v2`) and resubmit. **Version-agnostic lookup:** dropdowns across the admin always resolve to the latest approved version automatically — you never need to re-select a template after a rename. This means a rejection auto-recovers once the new version is approved.
3. **Order Updates** — per-event, per-channel toggles + language picker (see Section 7 above).
4. **Payment Link** — generate and send payment links from any order (see Section 8 above).
5. **Bot Copy** — edit your bot's greeting and flow messages in Arabic and English.
6. **Bot Analytics** — funnel + intent + LLM stats (see Section 6 above).

### Transactional Email (البريد الإلكتروني)

Order confirmations, password resets, and other transactional emails are sent with your store's branded sender name and domain — not a generic "noreply@forcestore" address. Email works out of the box; no third-party email account required.

### Push Notifications (الإشعارات الفورية)

Browser and mobile push notifications let you reach subscribed customers directly on their phone or desktop — without an app and without their email address. Use push to announce new arrivals, flash sales, or back-in-stock alerts.

### Marketing Pixels (بكسلات التتبع)

Connect Meta (Facebook/Instagram), Google, and TikTok tracking pixels to your store. Pixel events fire only after a visitor has accepted your cookie consent banner — the platform handles this automatically so you stay on the right side of advertising platform policies.

**Server-side conversions (Conversions API):** In addition to the browser pixel, the platform now sends Purchase events server-to-server via the Meta Conversions API and TikTok Events API the moment an order is confirmed. These server events reach Meta and TikTok even when the browser pixel is blocked by an ad-blocker or iOS Intelligent Tracking Prevention (ITP). Both signals are automatically deduplicated by the platforms using the order ID — you do not get double-counted conversions. To activate, enter your CAPI access token in **Admin → Marketing Pixels → Meta → Access Token** (and/or TikTok → Access Token). Use the "Test event code" field to verify delivery in Meta Events Manager before going live.

### Analytics (التحليلات السلوكية)

Visitor behavior tracking is built in to power the Analytics hub's conversion funnel, cohort, and segment reports. Date range pickers appear across Finance, Orders, Stock, Bot Analytics, and the Analytics Overview — every report can be filtered to any custom time period.

---

## 10. Marketing Tools — أدوات التسويق

### Newsletter Broadcast (إرسال النشرات)

Send promotional email campaigns to your subscriber list directly from **Admin → Marketing → Newsletter**. Draft, preview, and send to all opted-in customers. Export your subscriber list as Excel (.xlsx) or CSV for use in external tools.

### Affiliate Program (برنامج التسويق بالعمولة)

The affiliate program is available as a premium add-on. Affiliates, influencers, or loyal customers each get a unique referral link. Every completed order through their link earns the affiliate their configured commission. Invite new affiliates directly from the admin with the **Invite** button — sends a branded onboarding email automatically.

---

## 11. Plan-Gated Features — What Each Tier Unlocks

Force AI Store uses four plan tiers: **Starter**, **Professional**, **Enterprise**, plus a `free` grace state (not sold — only used for lapsed/demo stores). Every tier is a strict superset of the one below it.

When a merchant tries to access a feature above their current plan, they see an on-brand **upgrade page** — "Available on the Professional plan and above" — with a prompt to contact their Force AI account manager. There are no silent redirects.

### Loyalty Program — برنامج الولاء (Professional+)

Reward repeat customers automatically. Customers earn points on every purchase and redeem them for discounts on future orders. A loyalty program is one of the most effective tools for increasing repeat purchase rates — typical e-commerce stores see 20–30% of revenue come from repeat buyers once a loyalty program is active.

Redemption happens right at checkout: a logged-in customer sees their points balance and its cash value in the order summary, chooses how many points to apply (respecting your configured minimum and maximum-percentage caps), and the discount comes off the order total instantly. If an order is refunded or cancelled, the redeemed points are automatically returned to the customer's balance.

**Example:** A customer who spends KD 50 earns 500 points. At your configured redemption rate, they spend those points on their next order — bringing them back rather than shopping elsewhere.

### Push Notifications — الإشعارات الفورية (Professional+)

Browser and mobile push notifications let you reach subscribed customers directly on their phone or desktop — without an app and without their email address. Use push to announce new arrivals, flash sales, or back-in-stock alerts.

### Upsell and Cross-sell — البيع الإضافي والمتقاطع (Professional+)

Show related or upgraded products at key moments in the shopping journey — on the product page and in the cart. Powered by co-purchase signal from your actual order data, so recommendations are based on what your customers actually buy together.

**Example:** A customer viewing a 250g coffee bag sees a "You might also like" strip with your 500g bag and your branded mug — increasing average order value without any extra ad spend.

### Affiliate Program — برنامج التسويق بالعمولة (Enterprise+)

Let influencers, partners, or loyal customers earn a commission for every order they refer. Each affiliate gets a unique tracking link. You set the commission rate and payout rules. Invite new affiliates directly from the admin with the **Invite** button — sends a branded onboarding email automatically.

**Example:** A Kuwaiti food blogger shares their affiliate link. Every purchase through that link earns the blogger a 10% commission — and you a new customer who came through trusted word-of-mouth.

### SMS Notifications — الرسائل القصيرة (Enterprise+)

Send transactional SMS messages to customers (order confirmed, shipped, delivered, cancelled, refunded) via Unifonic. Customers who tick the SMS opt-in checkbox at checkout also receive promotional SMS messages (cart reminders, back-in-stock alerts). Consent is captured per-order at checkout and stored on the order record — customers are never opted in silently.

### Floating Widget — الزر العائم (Enterprise+)

A sticky button that sits on every page of your storefront. It collapses to a single circle and expands to show your chosen contact and engagement options: WhatsApp chat, Instagram link, phone number, email, background music toggle, or any custom link. Position, expand direction, button colors, and labels are all configurable.

**Example:** A merchant running a Ramadan campaign adds a floating WhatsApp button so shoppers can ask about gift sets without leaving the product page.

> 📸 Screenshot: Floating widget expanded on a storefront page showing WhatsApp and Instagram buttons

### WhatsApp Notifications — إشعارات واتساب (baseline, all plans — activation required)

WhatsApp admin access is baseline-included on every plan tier (Starter, Professional, Enterprise, even the `free` grace state) — it is not sold as a plan upgrade. What requires a separate activation step is turning on live WhatsApp ordering: an active Force AI WhatsApp Business Platform account and a connected Meta-approved WABA. The bot intelligence features (natural language ordering, voice, photo matching, returning-customer personalization) are included in that activation at no extra charge — they run on the free Google Gemini tier.

---

_Force AI Store is a product of Force AI — a Kuwait company. For pricing and activation, contact your Force AI account manager._
