# Force Store — Frequently Asked Questions

> Public-facing FAQ for prospective Kuwait/GCC merchants evaluating Force Store. Customer-facing language, bilingual where helpful, no engineering jargon.

---

## Getting started

### How quickly can I launch my store?

**4 hours, end-to-end**, if you have your products + images ready:

1. **15 min** — sign up + pick a theme (5 themes available, all configurable)
2. **30 min** — set your store name, logo, brand colors, contact info
3. **2 hours** — import products via CSV OR add them manually with our AI-assist (auto-translate, auto-SEO, auto-categorize)
4. **30 min** — configure your KNET payment provider (Tap, MyFatoorah, Hesabe, or UPayments) using credentials they provide you
5. **15 min** — connect your custom domain (e.g. yourshop.com) — automated through our setup wizard
6. **30 min** — final visual polish + test order

Then you're live. Most merchants we've onboarded are taking real orders the same day.

### Do I need to be technical?

No. If you can use Google Docs, you can use Force Store admin. The page builder is drag-and-drop. The product editor has AI buttons for translation and SEO. The payment provider setup is "paste your API key here."

We don't sell to developers — we sell to merchants who want to sell, not configure.

### Can I import my existing Shopify / WooCommerce store?

**Products + categories + customers + orders:** yes, via CSV import. Most platforms can export to CSV; we provide a template that maps standard fields (name, name_ar, price, category, stock, etc.).

**Themes + storefront design:** no automatic migration. You'll pick from our 5 themes and re-build your visual identity. This usually takes 1–3 hours; we offer a free migration consultation for paid plans.

**Apps + plugins:** any third-party Shopify or WooCommerce app needs to be re-evaluated. Many of those apps exist to fill gaps that Force Store already covers natively (translation, SEO, inventory, accounting, reviews).

---

## Bilingual + Arabic

### How does the Arabic + English support actually work?

Every text field in our system has an Arabic version and an English version. Examples:

- `name` + `name_ar` on products
- `metaTitle` + `metaTitleAr` on SEO
- `question` + `question_ar` on FAQs
- Even customer reviews — when a customer writes a review in Arabic, our AI automatically generates an English version (and vice versa)

When a visitor lands on your store, we detect their language preference (from browser settings or a manual EN/AR toggle in the header). Every page renders in the chosen language with right-to-left (RTL) layout for Arabic.

**The admin interface** also flips RTL when you switch your admin language to Arabic. Buttons move, text aligns right, even icons mirror where it makes sense.

### Do I have to write everything twice?

No. Use our **AI translate button** — one click and we fill the other language for you. You can edit the AI output before saving if you want. Our AI is tuned for Gulf Arabic specifically (not Modern Standard Arabic), so the output sounds like a Kuwaiti merchant, not a textbook.

You can also run a **bulk translate sweep** that goes through your entire product catalog at once. Translates 200 products in about 15 minutes.

### What if I only want English (or only Arabic)?

Both languages are always available on the storefront, but you can choose which one is the **default** (per store). Customers see the default first; they can switch with the language toggle in your header.

If you have 100% Arabic-speaking customers, set Arabic as default. The English fields stay populated (AI fills them) for SEO purposes — Google indexes both versions so you appear in both Arabic and English searches.

---

## Payments + KNET

### Do you support KNET?

Yes. KNET works through any of these 4 Kuwait payment providers, all configured per-store:

- **Tap Payments** — most popular GCC choice, KNET + Visa + Mastercard + Apple Pay
- **MyFatoorah** — widely used, KNET + cards + Apple Pay + STC Pay
- **Hesabe** — Kuwait-specific, KNET + Visa/Mastercard
- **UPayments** — Kuwait fintech, KNET + digital wallets

You pick **one** provider for your store, paste their API credentials into your Force Store admin, and KNET starts working immediately. No 3rd-party plugin.

If you don't have an account with any of these providers yet, we recommend **Tap** for new merchants (easiest signup, best documentation, GCC-wide).

### How much do payment providers charge?

Provider fees are paid by you to your provider (not to Force Store). Typical 2026 rates:

| Provider   | KNET  | Visa/MC domestic | International |
| ---------- | ----- | ---------------- | ------------- |
| MyFatoorah | 2.0%  | 3.5%             | 3.5%+         |
| Tap        | 2.75% | 2.75%            | 3.25% + FX    |
| Hesabe     | ~2.5% | ~3.5%            | —             |
| UPayments  | ~2.5% | ~3.0%            | —             |

Whether Force Store takes a cut of GMV is a launch-time decision pending — see [04-pricing-tiers.md §1d](04-pricing-tiers.md). Subscription is the primary revenue model regardless.

### Can I use Stripe?

Stripe doesn't work in Kuwait — they don't have a Kuwait merchant program. If your customers are GCC-based, the 4 providers above cover everything Stripe would (KNET is the missing piece Stripe can't deliver).

### What about cash on delivery?

Yes — toggle COD on per store. We track it as a payment method and your delivery partner collects on your behalf.

---

## Pricing + plans

### How much does it cost?

See [04-pricing-tiers.md](04-pricing-tiers.md) for the full breakdown. Quick summary:

- **Free** — for testing (1 store, 10 products)
- **Starter** — [TBD] — single-merchant, custom domain, KNET, all 5 themes
- **Professional** — [TBD] — adds AI bulk sweeps, WhatsApp orders, loyalty, affiliates
- **Enterprise** — [TBD] — multi-store, white-label, dedicated support, custom integrations

Final prices announced at launch — contact us for current pricing.

Annual prepay gets 2 months free.

### Are there any hidden fees?

No. The subscription covers:

- Hosting + bandwidth
- All AI features (within generous monthly quotas)
- Custom domain (auto-provisioned)
- SSL certificate
- Email sending (transactional — order confirmations, password resets)
- Updates + new features as we ship them

You pay separately for:

- Your KNET payment provider (Tap/MyFatoorah/etc.) — their fees, paid to them
- Your domain registration (e.g. $12/yr at GoDaddy for yourshop.com)

That's it.

### Can I switch plans later?

Yes. Upgrade any time. Downgrade at the end of your current billing period (we pro-rate annual plans). No long-term contracts.

### Do you offer discounts?

- **Annual prepay:** 2 months free (effectively ~17% discount)
- **Migration discount:** 50% off first 3 months if you migrate from Shopify, Wix, Salla, or WooCommerce (we ask for the prior platform's billing screenshot as proof)
- **Multiple stores:** progressive discount on Enterprise tier for 2+ stores
- **Non-profit / educational:** contact us for case-by-case pricing

---

## Features

### Does Force Store have [feature X]?

Probably. The full feature catalog is in [02-feature-catalog.md](02-feature-catalog.md). Most-asked:

- ✅ **Multi-language (EN + AR)** — yes, native
- ✅ **Inventory management** — yes, full module (suppliers, POs, backorders, deadstock)
- ✅ **Accounting** — yes, Chart-of-Accounts + journal entries + P&L (no QuickBooks needed)
- ✅ **AI translation + SEO + content fill** — yes, included
- ✅ **WhatsApp order notifications** — yes (via our WBS integration)
- ✅ **Push notifications** — yes (web push + browser)
- ✅ **Custom domain** — yes, auto-provisioned
- ✅ **Customer reviews** — yes, verified-purchase, with AI spam detection + auto-translation
- ✅ **Discount codes / coupons** — yes
- ✅ **Loyalty program** — yes, on Professional+
- ✅ **Affiliate program** — yes, on Professional+
- ✅ **Email marketing** — basic transactional emails yes; campaign builder is on our roadmap
- ✅ **PWA (installable as app)** — yes
- ⚠️ **Subscriptions / recurring billing** — not yet
- ⚠️ **Multi-vendor marketplace** — not yet (each Force Store tenant is a single merchant)
- ⚠️ **Dropshipping integration** — not on roadmap

### Can I customize the design?

Yes, deeply. You can change:

- Per-section typography (font size, weight, family) — without touching code
- Per-section background colors
- Brand palette (we'll generate a WCAG-compliant palette from 1–3 seed colors)
- Card sizes, shapes, corner radius
- 7 visual toggles (brand badges, quick-add buttons, brand story block, etc.)
- Theme — pick from 5 (modern / elegant / classic / minimal / bold)
- Page builder — drag-and-drop section ordering
- Custom CSS for advanced users (Professional+ tier)

You **cannot** edit raw HTML or change the underlying templates — that level of customization isn't supported. If you need that, you'll outgrow Force Store and need a custom build.

### What if I want a feature that doesn't exist?

Tell us. Per CLAUDE.md (our internal positioning doc), **every storefront string is tenant-editable** by design. Many "features" merchants ask for are really configuration toggles we can add quickly. We typically ship requested features within 1–4 weeks if they fit the platform direction.

---

## Compliance + privacy

### Where is my data stored?

- **Database (Neon Postgres):** AWS region `ap-southeast-1` (Singapore) — closest GCC-available AWS region with Postgres serverless support
- **Storage (Cloudflare R2):** global CDN — content served from the closest edge to your customer
- **API (Railway):** US East (planned migration to ME region as Railway adds it)

**Data sovereignty for Kuwait:** Kuwait Law 13/2023 (PDPL) doesn't require data residency for SaaS providers but does require erasure capability — which we provide (`/auth/me/erase` endpoint, irreversible PII anonymization).

### Are you GDPR / Kuwait Law 13/2023 compliant?

Yes:

- **Art. 17 (erasure / right to be forgotten):** implemented via our customer profile page → "Delete my account"
- **Art. 20 (data portability):** customers can export their data as JSON
- **Cookie consent:** every storefront has a consent banner; tracking pixels (Facebook/Google/TikTok) only fire after consent
- **Audit trail:** every admin action is logged with user + timestamp + IP

### Is my customer data shared with anyone?

No. We don't sell or share customer data. The only third parties that see customer data are:

- **Your payment provider** (Tap/MyFatoorah/etc.) — they need it to process payments
- **Resend** — our email-sending partner, sees only the order confirmation content
- **Cloudflare** — our CDN, sees encrypted traffic only

We never feed customer data to our AI features (we only translate product catalog content, never customer info).

### Where's your privacy policy?

Generated per-store at `/privacy` on your storefront. Edit it from the admin → Content → Privacy Policy. We provide a Kuwait-compliant template (bilingual EN/AR) as the default.

---

## Migrating from another platform

### Coming from Shopify

**You're going to save money** — most Shopify Kuwait merchants pay $30–80/mo + $20/mo translation + $0–20/mo for Arabic apps. Force Store includes all of that.

**What you keep:** product catalog (CSV export → import), customer list, order history (CSV).

**What changes:** your storefront design (5 themes to pick from). Shopify themes don't migrate; you'll re-build with our page builder. Usually takes 1–3 hours.

**KNET:** if you were using a Shopify plugin for KNET, you'll set up direct KNET via Tap or MyFatoorah inside Force Store admin. Easier, faster, no plugin maintenance.

### Coming from Salla

Salla is Saudi-first. If you're a Kuwait merchant on Salla, you've probably been frustrated by:

- Mada/STC Pay being the default (not KNET)
- Saudi shipping zones / couriers (not Kuwait districts)
- Salla's UI being Arabic-only (limiting your English-speaking audience)

Force Store gives you the same admin power but Kuwait-tuned. Product import is CSV-based.

### Coming from WooCommerce

You'll lose some flexibility (no raw PHP, no plugins) but gain peace of mind (no maintenance, no security patching, no "developer quit, what now?").

If your WooCommerce site has heavy custom code, Force Store may not be a fit — talk to us first.

### Coming from Wix / Squarespace

These are great for static brochure sites but weak for transactional e-commerce in Kuwait (no native KNET, limited multi-language, no inventory module). Force Store is purpose-built for what they're not.

---

## Support + help

### What if I get stuck?

- **Documentation:** the public-facing docs at [forcemediakw.com/docs](https://forcemediakw.com/docs) (coming soon — until then, contact us)
- **Email:** [hello@forcemediakw.com](mailto:hello@forcemediakw.com) — typical response under 4 hours during Kuwait business hours
- **WhatsApp:** business hours, KW timezone
- **In-admin chat widget** (Professional+ tier)

### Do you offer onboarding help?

- **Free tier:** docs + email only
- **Starter:** docs + email + WhatsApp
- **Professional:** dedicated onboarding call (1 hour, includes catalog migration walkthrough)
- **Enterprise:** white-glove migration done by our team — you provide the data, we build the store

### Is there a community / Discord / forum?

Not yet. As we grow, we'll launch a Kuwait merchant community (likely Telegram or Discord, in Arabic + English).

### What if I have a bug or issue?

- **Status page:** [stats.uptimerobot.com/23nuarbz3h](https://stats.uptimerobot.com/23nuarbz3h) — live uptime monitoring
- **Email us:** any bug report gets triaged within 24 hours; P0 issues alert our team via Telegram within 30 seconds (our internal incident response)
- **Refund:** we offer pro-rated refunds for outages exceeding 4 hours in a single billing period

### Can I cancel anytime?

Yes. Cancel from the admin → Settings → Billing → Cancel subscription. You keep access until the end of your current billing period. We delete your store data 30 days after cancellation (configurable — contact us if you need it kept longer).

---

## Technical (for the technically curious)

### What's your tech stack?

- **Backend:** Express.js + Prisma + PostgreSQL (Neon serverless)
- **Frontend:** Next.js 16 (App Router) on Vercel
- **Storage:** Cloudflare R2 (S3-compatible)
- **Async jobs:** Inngest
- **AI:** Google Gemini Flash Lite
- **Email:** Resend
- **Push:** OneSignal + Web Push (VAPID)

If those words mean nothing to you, that's fine — they're not your concern. We pick the boring, reliable, well-supported tools so you don't have to think about them.

### Do you have an API?

Internal API exists; public-facing API is on the roadmap (currently used by our Vercel storefronts only). If you have a specific integration need, contact us.

### Is the code open source?

No. Force Store source code is proprietary (`license: UNLICENSED`). The platform is operated as a SaaS — you rent it, we run it.

### Where can I see what's been recently shipped?

Our internal changelog is in `docs/`. We'll publish a public changelog with major releases — TBD.

---

## Still have questions?

Email [hello@forcemediakw.com](mailto:hello@forcemediakw.com) or message us on WhatsApp. Most questions get answered within 4 hours during Kuwait business hours.
