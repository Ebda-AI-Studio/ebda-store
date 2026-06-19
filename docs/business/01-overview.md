> **INTERNAL — Force AI / Force Media team. Safe to share externally (no cost floors, no margins, no provider names).**

# Force AI Store — One-Pager

> **Force AI Store** is a multi-tenant e-commerce platform built in Kuwait for Kuwait and the GCC. Bilingual Arabic + English from the ground up, AI-assisted from day one, KNET-native, and priced for SMB merchants.

---

## The 30-second pitch

You're a Kuwait merchant who sells products online. You want a store that speaks Arabic and English equally, accepts KNET without a plugin, and handles your translations, SEO, and category tags automatically — without hiring a developer.

Force AI Store gives you all of that in one managed service. **Arabic and English are equal**, not afterthoughts. **KNET works on day one** with your choice of four Kuwait-licensed payment providers. **AI fills in your product translations, SEO, and category tags automatically**, included in your subscription, not as a paid add-on.

You launch in hours, not weeks. You pay in Kuwaiti Dinars. Your customers check out with the payment method 80% of Kuwaitis already use.

---

## The 4 pillars

### 1. AI-as-default

Every manual content task that drains merchant time has an AI auto-fill button:

- **Translate** product names, descriptions, categories, and meta tags between Arabic and English with one click
- **Generate SEO** titles + meta descriptions for your store, every category, and every product — bilingual
- **Categorize** new products automatically with AI-suggested category chips
- **Write FAQs and how-to guides** for every product page so Google and AI search engines (ChatGPT, Perplexity, Gemini) actually find your store
- **Detect spam reviews** automatically
- **Draft owner-responses** to customer reviews in either language
- **Reorder + dead-stock recommendations** — AI flags which products need restocking and which are dead inventory, so you act before you lose sales or tie up cash

Beyond content, AI powers the **WhatsApp DM ordering bot**: customers message your business number in natural Arabic or English, the bot understands what they want, walks them through your catalog, and hands them a checkout link — all without an agent. Voice notes are transcribed. Product photos are matched against your catalog. Returning customers are greeted by name and offered their last order. All powered by our AI engine, **included free** in the WhatsApp integration at no per-message or per-AI-call cost.

### 2. Arabic-first locality

This is not "a platform with an Arabic theme." Every database field has an Arabic and English version. The admin interface flips right-to-left when your team works in Arabic. Search hits both languages simultaneously — a customer searching for "زيت زيتون" and "olive oil" find the same product.

Other locality details that matter:

- **Phone numbers** display correctly LTR even when the surrounding page is RTL
- **Currency** defaults to KWD
- **Tax** rules pre-configured for Kuwait's 0% VAT
- **Delivery areas & fees** — checkout cascades governorate → area against the canonical Kuwait 6-governorate area list; the merchant sets a per-area delivery fee (governorate accordion in admin, bulk import/export) and can hide areas they don't price. KNET-native couriers (iCarry, Aramex) for rated shipping
- **Bilingual customer-facing content** including reviews, FAQs, how-to guides, all translated by AI on submit

### 3. Kuwait payment stack as first-party

Choose from the four real Kuwait payment gateways — all KNET-compatible, all configured per-store with encrypted credentials, all webhook-verified:

- **Tap Payments** — the GCC default. KNET + Visa + Mastercard + Apple Pay.
- **MyFatoorah** — widely used. KNET + cards + Apple Pay + STC Pay.
- **Hesabe** — Kuwait-specific. KNET + cards.
- **UPayments** — Kuwait fintech. KNET + digital wallets.

Each merchant picks their preferred provider. Switching is a configuration change, not a re-integration.

### 4. Customization granularity

Most platforms give you a theme picker and call it customization. Force AI Store gives you:

- **5 themes** (modern / elegant / classic / minimal / bold) — every store starts from one of these
- **Per-section typography** — change font size, weight, family on any page section without touching code
- **Per-section background colors** — section-by-section, not just global
- **Smart Palette** — pick 1-3 seed colors, get a full WCAG-compliant palette applied across the whole store automatically; the canonical brand-color editor (lives in Page Builder)
- **Page Builder** — the single destination for all design decisions: brand colors (Smart Palette), fonts (Typography library), hero banner slides, per-section backgrounds, section order, Navigation links, Footer links, and Category page config
- **7 visual toggles** — brand badges on product cards, quick-add buttons, brand story block, trust strip, dividers, mobile floating widget, blog
- **Per-store custom domain** — your-shop.com, auto-provisioned through our Vercel integration
- **Per-store branded email** — order confirmations come from your domain, not ours

---

## Who Force AI Store is for

**Ideal fit:**

- Kuwait/GCC SMB merchant with 10–500 products
- Self-shooting product photos on a phone, writing their own copy
- Needs to sell to both Arabic-speaking and English-speaking customers
- Wants KNET as a primary payment method (not buried behind a plugin)
- Doesn't have a developer on staff and doesn't want to hire one
- Wants to take orders via WhatsApp DM (not just notifications — actual orders from customers DMing the business number)
- Cares about WhatsApp order updates because that's how their customers communicate
- Values built-in inventory, suppliers, purchase orders, and full accounting (Chart of Accounts, journal, P&L — no third-party accounting software needed)
- Needs per-product discount pricing (percentage or fixed KWD) that shows a live "Was / Now" preview in the admin

**Strong fit:**

- Kuwait restaurant / food brand with delivery — full menu management + KNET checkout
- Local fashion / beauty / lifestyle brands — visual customization granularity matters here
- Wholesale / B2C hybrid where storefront-facing simplicity is key
- Multi-location stores using the per-store custom domain feature

**Not the right fit (yet):**

- **Enterprise catalogs > 5,000 products** — works, but our query optimization is tuned for SMB sizes. Performance at 50k products is unproven.
- **B2B with contract pricing per customer** — no per-customer-tier price lists today
- **Dropshipping with AliExpress-style supplier integration** — not on the roadmap
- **Subscription products** (recurring billing for the same product monthly) — not yet supported
- **Marketplace (multi-vendor)** — Force AI Store is multi-tenant, but each tenant is one merchant, not a marketplace of vendors

---

## Where we run

- **Kuwait & GCC focus** — Tap, MyFatoorah, Hesabe, UPayments. KNET-native. Arabic-primary. KWD-default.
- **Hosted infrastructure** — Vercel (CDN + serverless), Railway (API), Neon Postgres (database), Cloudflare R2 (storage). Multi-region read latency under 200ms across the GCC.
- **Service availability** — we monitor uptime publicly at our status page. P0 incidents alert our team within 30 seconds via Telegram.

---

## Who we are

Force AI Store is built by **Force AI**, a Kuwait company owned by Ahmad Sharaf. We're a sister company to Force Media Kuwait, the agency that's been building websites and brand identities for Kuwaiti businesses for years. The same team that ships marketing campaigns also ships product code, so the gap between "what we sell" and "what we build" is small.

We're not VC-backed. We don't have a 50-person team. We ship every day, and every merchant on the platform inherits every improvement automatically.

---

## One-click WhatsApp Meta-catalog setup

Connecting a store to WhatsApp's Native Catalog feature normally requires merchants to navigate Meta Business Manager, create a Commerce Catalog, generate a system-user token, and copy multiple IDs. Force AI Store removes all of that.

From Admin → WhatsApp Bot → Meta Commerce Catalog, click **Provision automatically**. The Force AI backend calls the Meta Graph API on your behalf to create the catalog, assign the long-lived access token, and save everything encrypted — in under 60 seconds. Your product catalog syncs to Meta automatically after that.

---

## Get started

Force AI Store is sold as a **managed e-commerce service** — every client gets a custom proposal based on the features they need, not a self-serve subscription. To start:

- **See it live:** [wadyaljuz.com](https://wadyaljuz.com) (our flagship Kuwait merchant — 235 products, 8 categories, full bilingual)
- **Talk to us:** [forcemediakw.com/contact](https://forcemediakw.com/contact) — we'll schedule a 30-minute call to understand your needs and send you a written proposal within 2-3 business days
- **Feature catalog:** [02-feature-catalog.md](02-feature-catalog.md) — the full list of what's available before we talk

Typical onboarding from contract signing to live store: **2-4 weeks** depending on catalog size and brand readiness.
