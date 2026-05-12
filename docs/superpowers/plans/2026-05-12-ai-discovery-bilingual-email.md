# AI-discoverability + bilingual email rollout — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Platform infrastructure note (Ahmad 2026-05-12):** This work targets the FWB platform code (apps/web, apps/api, packages/\*). Every existing AND future tenant inherits all features automatically — no per-store opt-in. Wady Aljuz is referenced only as the verification target; the same code paths serve every merchant. The /llms.txt files are dynamic Prisma-backed routes (Task 18) so new stores appear in AI indexes within the revalidate window with zero config.

**Goal:** Three independent tracks bundled because they all touch how Force properties surface to (a) search engines, (b) AI agents (Perplexity, Gemini, ChatGPT search), and (c) merchants' Arabic-speaking customers:

1. **Bilingual email** — language override at send time (Tier 1) + full Arabic translations of all 12 customer-facing templates (Tier 2). Stores with `defaultLanguage === 'ar'` finally send emails that are actually in Arabic, not just RTL-wrapped English.
2. **Storefront AI/SEO upgrade** — Product schema on category + store-home pages (already on /products/[slug]), BreadcrumbList everywhere, ItemList on listing pages, FAQPage when present, Store schema richer than just Organization. Semantic HTML upgrade — wrap product cards in `<article>`, ensure `<header>`/`<nav>`/`<footer>` on every layout.
3. **`/llms.txt` + landing audit** — `llms.txt` for both public domains (storefront + marketing landing). Landing page JSON-LD audit beyond the existing Organization. Schema for the agency services + LocalBusiness.

**Architecture:**

- **Email language**: `EmailService.sendForStore` gains optional `language?: 'en' | 'ar'` arg that overrides `store.settings.defaultLanguage`. Each public `sendX` method accepts the same param. Templates split into bilingual modules: every template exports `{ en: (data) => string; ar: (data) => string }` and the renderer picks the right key.
- **Storefront schemas**: `apps/web/src/lib/structured-data.ts` gains `breadcrumbList(items)`, `itemList(products)`, `store(store)` builders alongside the existing `product()`. Each page (`/[slug]`, `/[slug]/products`, `/[slug]/categories/[cat]`) renders the appropriate combination.
- **Semantic HTML**: `apps/web/src/components/ShopChrome.tsx` upgraded with `<header>` + `<nav>` + `<footer>` wrappers. Product cards in `apps/web/src/components/ProductCard.tsx` (or wherever they live) wrapped in `<article>`.
- **llms.txt**: static files at `apps/web/public/llms.txt` and `/Users/ahmadsharaf/Desktop/projects/force_media_landing_page/llms.txt`.

**Tech Stack:** Express + TypeScript + Prisma + Neon (api), Next.js 16 App Router (apps/web storefront, apps/admin admin), vanilla HTML/JS (force_media_landing_page), Resend SDK, next-intl (en/ar), Vercel + Railway.

**Cross-project scope:**

- `force-website-builder` repo: email service + templates + storefront pages + schema lib + llms.txt
- `force_media_landing_page` repo: llms.txt + JSON-LD enrichment

---

## File Structure

**Create (FWB):**

- `apps/api/src/services/email-templates/index.ts` — bilingual template registry; exports `welcomeTemplate.en/ar`, `orderConfirmationTemplate.en/ar`, etc.
- `apps/api/src/services/email-templates/welcome.ts` — `{ en, ar }` exports for welcome template
- `apps/api/src/services/email-templates/order-confirmation.ts` — same
- `apps/api/src/services/email-templates/payment-success.ts` — same
- `apps/api/src/services/email-templates/payment-failed.ts` — same
- `apps/api/src/services/email-templates/order-shipped.ts` — same
- `apps/api/src/services/email-templates/password-reset.ts` — same
- `apps/api/src/services/email-templates/email-verification.ts` — same
- `apps/api/src/services/email-templates/resend-verification.ts` — same
- `apps/api/src/services/email-templates/duplicate-registration.ts` — same
- `apps/api/src/services/email-templates/return-confirmation.ts` — same
- `apps/api/src/services/email-templates/return-status-update.ts` — same
- `tests/unit/email-templates-i18n.test.ts` — assertions per template that en + ar both render valid HTML with the right data interpolation
- `apps/web/public/llms.txt` — LLM-facing site index for store.forcemediakw.com
- `apps/web/src/lib/structured-data.ts` (extend) — add `breadcrumbList()`, `itemList()`, `store()`, `faqPage()` builders alongside existing `product()`
- `apps/web/src/components/BreadcrumbJsonLd.tsx` — client component that emits Breadcrumb JSON-LD from current route

**Modify (FWB):**

- `apps/api/src/services/email.service.ts` — `sendForStore` signature, all public `sendX` methods gain `language?: 'en' | 'ar'`. `renderTemplate` becomes language-aware. Per-template private statics deleted (moved to email-templates/ files).
- `apps/api/src/lib/inngest/functions/order-created.ts` — pass `language: order.locale` or read from buyer
- `apps/api/src/services/order.service.ts` — same
- `apps/api/src/services/auth.service.ts` — pass language from user preference
- `apps/api/src/routes/public.routes.ts` — newsletter subscribe passes `data.language`
- `apps/web/src/app/[slug]/page.tsx` (store home) — add Store + ItemList JSON-LD for featured products
- `apps/web/src/app/[slug]/products/page.tsx` (all products) — add ItemList + BreadcrumbList
- `apps/web/src/app/[slug]/categories/page.tsx` (or whatever the category index is) — add BreadcrumbList
- `apps/web/src/app/[slug]/categories/[cat]/page.tsx` (category detail) — ItemList + BreadcrumbList
- `apps/web/src/app/[slug]/about/page.tsx` — Organization or AboutPage schema
- `apps/web/src/app/[slug]/contact/page.tsx` — ContactPage schema with PostalAddress + ContactPoint
- `apps/web/src/components/ShopChrome.tsx` — wrap children in `<header>` + `<nav>` + `<main>` + `<footer>`
- `apps/web/src/components/ProductCard.tsx` (or product-card component, location TBD by Task 6 survey) — wrap card in `<article>` with `itemscope itemtype="https://schema.org/Product"` microdata for redundancy

**Create (landing):**

- `/Users/ahmadsharaf/Desktop/projects/force_media_landing_page/llms.txt`

**Modify (landing):**

- `/Users/ahmadsharaf/Desktop/projects/force_media_landing_page/index.html` — add `Service` schemas for the agency offerings (digital marketing, social media, SEO, etc.) + `LocalBusiness` schema to the existing Organization block, OR a second `application/ld+json` block.

---

## Task 1: EmailService language-override scaffold

**Files:**

- Modify: `apps/api/src/services/email.service.ts`
- Modify: `tests/unit/email-template.test.ts` (extend with language-override assertions)

- [ ] **Step 1.1: Add `language` to `sendForStore` signature**

Open `apps/api/src/services/email.service.ts`. Find `private static async sendForStore(`. Add the optional `language` field:

```ts
private static async sendForStore(
  storeId: string,
  args: {
    to: string | string[];
    subject: string;
    content: string;
    text?: string;
    language?: 'en' | 'ar';
  }
): Promise<void> {
```

And inside the body, change the language resolution:

```ts
// Before:
const defaultLanguage =
  (store.settings as Record<string, unknown> | null)?.defaultLanguage === 'ar' ? 'ar' : 'en';

// After:
const storeDefaultLang =
  (store.settings as Record<string, unknown> | null)?.defaultLanguage === 'ar' ? 'ar' : 'en';
const language = args.language ?? storeDefaultLang;
```

Then pass `defaultLanguage: language` to `renderBrandedShell` instead of `defaultLanguage`.

- [ ] **Step 1.2: Add `language` to every public `sendX` method**

Each customer-facing method gains an optional `language?: 'en' | 'ar'` arg after `data`:

```ts
static async sendOrderConfirmation(
  storeId: string,
  data: OrderEmailData,
  language?: 'en' | 'ar'
): Promise<void> {
  const content = this.renderTemplate('order-confirmation', data, language);
  await this.sendForStore(storeId, {
    to: data.customerEmail,
    subject: `Order Confirmed - #${data.orderNumber}`,  // localized in Task 2
    content,
    language,
  });
}
```

Apply to: `sendOrderConfirmation`, `sendPaymentSuccess`, `sendPaymentFailed`, `sendOrderShipped`, `sendPasswordReset`, `sendWelcome`, `sendEmailVerification`, `sendDuplicateRegistrationNotice`, `sendResendVerification`, `sendReturnConfirmation`, `sendReturnStatusUpdate`, `sendInvoice`.

Admin-facing methods (`sendAdminNewOrder`, `sendAdminRefund`, `sendContactForm`) stay English-only — no language param needed (the operator's language is platform default).

- [ ] **Step 1.3: Extend `renderTemplate` to take language**

```ts
private static renderTemplate(
  templateName: string,
  data: object,
  language: 'en' | 'ar' = 'en'
): string {
  const templates: Record<string, (data: object, lang: 'en' | 'ar') => string> = {
    'order-confirmation': (d, l) => this.orderConfirmationTemplate(d as OrderEmailData, l),
    // ... etc
  };
  // ...
}
```

Per-template private statics gain a `language: 'en' | 'ar' = 'en'` second arg. For Task 1, they ignore it (still render English). Task 2+ adds Arabic.

- [ ] **Step 1.4: Add tests**

Append to `tests/unit/email-template.test.ts`:

```ts
import { EmailService } from '@api/services/email.service';
// (mock prisma + ResendService — see existing setup)

describe('EmailService language override', () => {
  it('argues `language: ar` produces an RTL shell even when no store override', async () => {
    // mock prisma.store.findUnique to return defaultLanguage='en'
    // call EmailService.sendOrderConfirmation(storeId, data, 'ar')
    // assert the rendered HTML contains dir="rtl"
  });

  it('falls back to store.settings.defaultLanguage when language arg omitted', async () => {
    // mock prisma to return defaultLanguage='ar'
    // call without language arg
    // assert dir="rtl"
  });

  it('explicit "en" overrides Arabic store default', async () => {
    // mock prisma to return defaultLanguage='ar'
    // call with language: 'en'
    // assert dir="ltr"
  });
});
```

- [ ] **Step 1.5: Run tests, typecheck, commit**

```bash
npx vitest run tests/unit/email-template.test.ts tests/unit/email-sender.test.ts tests/unit/resend-service.test.ts tests/unit/email-queue.test.ts
cd apps/api && npx tsc --noEmit 2>&1 | grep -E "email\.service|template" | head
git add apps/api/src/services/email.service.ts tests/unit/email-template.test.ts
git commit -m "feat(api): email language override at send time (tier 1)

every sendX method takes optional language?: 'en' | 'ar' that
overrides store.settings.defaultLanguage. controls the shell
direction (rtl when ar, ltr when en). per-template content still
english only — task 2 adds arabic bodies."
```

---

## Task 2: Bilingual template registry — welcome.ts

**Files:**

- Create: `apps/api/src/services/email-templates/welcome.ts`
- Create: `apps/api/src/services/email-templates/index.ts`
- Modify: `apps/api/src/services/email.service.ts` (delegate to new module)

- [ ] **Step 2.1: Scaffold the template registry**

Create `apps/api/src/services/email-templates/index.ts`:

```ts
import { welcomeTemplate } from './welcome';
import { orderConfirmationTemplate } from './order-confirmation';
// ... import all 12

export type EmailLanguage = 'en' | 'ar';

export interface BilingualTemplate<T> {
  en: (data: T, storeName: string) => string;
  ar: (data: T, storeName: string) => string;
  subject: {
    en: (data: T, storeName: string) => string;
    ar: (data: T, storeName: string) => string;
  };
}

export {
  welcomeTemplate,
  orderConfirmationTemplate,
  // ... etc
};

export const TEMPLATES = {
  welcome: welcomeTemplate,
  'order-confirmation': orderConfirmationTemplate,
  // ... etc
} as const;
```

- [ ] **Step 2.2: Write welcome.ts**

Create `apps/api/src/services/email-templates/welcome.ts`:

```ts
import type { BilingualTemplate } from './index';

interface WelcomeData {
  email: string;
  name: string;
}

// Escape helper (copy from email.service.ts to keep the templates module
// dependency-free, or import). Match the existing implementation.
function escapeHtml(value: unknown): string {
  /* ... */
}

export const welcomeTemplate: BilingualTemplate<WelcomeData> = {
  subject: {
    en: (d, storeName) => `Welcome to ${storeName}`,
    ar: (d, storeName) => `مرحباً بك في ${storeName}`,
  },
  en: (d, storeName) => `
    <h2>Welcome${d.name ? ', ' + escapeHtml(d.name) : ''}!</h2>
    <p>Thanks for subscribing to ${escapeHtml(storeName)}.</p>
    <p>We'll send you updates about new products, special offers, and store news.</p>
    <p>You can unsubscribe at any time via the link in the footer of any of our emails.</p>
  `,
  ar: (d, storeName) => `
    <h2>أهلاً${d.name ? '، ' + escapeHtml(d.name) : ''}!</h2>
    <p>شكراً لاشتراكك في نشرة ${escapeHtml(storeName)} البريدية.</p>
    <p>سنرسل لك تحديثات عن المنتجات الجديدة والعروض الخاصة وأخبار المتجر.</p>
    <p>يمكنك إلغاء الاشتراك في أي وقت عبر الرابط الموجود في تذييل أي من رسائلنا.</p>
  `,
};
```

- [ ] **Step 2.3: Wire welcome into EmailService.sendWelcome**

In `email.service.ts`, replace the existing `welcomeTemplate` private static:

```ts
import { welcomeTemplate } from './email-templates/welcome';

static async sendWelcome(
  storeId: string,
  data: { email: string; name: string },
  language?: 'en' | 'ar'
): Promise<void> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { name: true, settings: true },
  });
  if (!store) throw new Error(`Store ${storeId} not found`);
  const lang: 'en' | 'ar' =
    language ??
    ((store.settings as { defaultLanguage?: string } | null)?.defaultLanguage === 'ar' ? 'ar' : 'en');
  const subject = welcomeTemplate.subject[lang](data, store.name);
  const content = welcomeTemplate[lang](data, store.name);
  await this.sendForStore(storeId, { to: data.email, subject, content, language: lang });
}
```

Note: sendForStore ALSO loads the store. Two loads is fine for a low-frequency welcome path; if order-confirmation fanout hits this it's worth threading the loaded store through.

Optimization (defer): refactor sendForStore to accept either a `storeId` OR a pre-loaded `store` object so callers that already loaded it (via the language-resolution step) don't double-fetch.

- [ ] **Step 2.4: Tests**

Create `tests/unit/email-templates-i18n.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { welcomeTemplate } from '@api/services/email-templates/welcome';

describe('welcomeTemplate i18n', () => {
  const data = { email: 'a@b.c', name: 'Ahmad' };

  it('en renders the English welcome copy', () => {
    const html = welcomeTemplate.en(data, 'Wady Aljuz');
    expect(html).toContain('Welcome');
    expect(html).toContain('Wady Aljuz');
    expect(html).toContain('Ahmad');
  });

  it('ar renders the Arabic welcome copy with the store name', () => {
    const html = welcomeTemplate.ar(data, 'Wady Aljuz');
    expect(html).toContain('أهلاً');
    expect(html).toContain('Wady Aljuz');
  });

  it('subject.en interpolates store name', () => {
    expect(welcomeTemplate.subject.en(data, 'Wady Aljuz')).toBe('Welcome to Wady Aljuz');
  });

  it('subject.ar interpolates store name', () => {
    expect(welcomeTemplate.subject.ar(data, 'Wady Aljuz')).toBe('مرحباً بك في Wady Aljuz');
  });

  it('escapes XSS in customer name in en', () => {
    const html = welcomeTemplate.en({ email: 'x', name: '<script>alert(1)</script>' }, 'S');
    expect(html).not.toContain('<script>');
  });
});
```

- [ ] **Step 2.5: Commit**

```bash
git add apps/api/src/services/email-templates apps/api/src/services/email.service.ts tests/unit/email-templates-i18n.test.ts
git commit -m "feat(api): bilingual welcome template + email-templates module

new email-templates/ module hosts per-template {en, ar} pairs.
welcomeTemplate is the first migrated. sendWelcome routes through
the new module, picks language from store.settings.defaultLanguage
or explicit override. subject + body both localized."
```

---

## Task 3-13: Migrate remaining 11 templates (one per task)

For each of the following, apply the same pattern as Task 2 (create `email-templates/<name>.ts`, write `en` + `ar` + `subject.en` + `subject.ar`, wire from `email.service.ts`, add tests):

- [ ] **Task 3**: order-confirmation.ts — full receipt with items table, totals, shipping address. Largest template (~80 lines per language).
- [ ] **Task 4**: payment-success.ts
- [ ] **Task 5**: payment-failed.ts (include `reason` interpolation)
- [ ] **Task 6**: order-shipped.ts (tracking number link)
- [ ] **Task 7**: password-reset.ts (CTA button + expiry note)
- [ ] **Task 8**: email-verification.ts (CTA button)
- [ ] **Task 9**: resend-verification.ts
- [ ] **Task 10**: duplicate-registration.ts (includes the "account already exists at {storeName}" subject — already partially localized in en today)
- [ ] **Task 11**: return-confirmation.ts (typeLabel: Return/Exchange/Refund — need Arabic equivalents: مرتجع/استبدال/استرداد)
- [ ] **Task 12**: return-status-update.ts
- [ ] **Task 13**: invoice subject — `sendInvoice` just wraps pre-rendered HTML so only the subject needs localization (`Invoice ${orderNumber}` → `فاتورة ${orderNumber}`)

**Translation source-of-truth:** Use the same Arabic conventions as the storefront (`apps/web/src/i18n/messages/ar.json`). Where storefront has a corresponding string (e.g. "Your order has shipped"), copy from there to avoid divergent terminology. For purely email-specific copy (e.g. "Click below to verify your email"), invent and keep terse, formal Arabic.

Each task commits independently so a partial migration is rollback-safe. **After Task 13: full English-Arabic parity across all 12 customer-facing templates.**

---

## Task 14: Plumb language through call sites

**Files:**

- Modify: `apps/api/src/lib/inngest/functions/order-created.ts`
- Modify: `apps/api/src/services/order.service.ts`
- Modify: `apps/api/src/services/auth.service.ts`
- Modify: `apps/api/src/routes/public.routes.ts`
- Modify: `apps/api/src/services/return.service.ts`
- Modify: `packages/database/prisma/schema.prisma` (if `Order.locale` doesn't exist)

- [ ] **Step 14.1: Survey existing locale storage**

Run `grep -rn "locale\|preferredLanguage" packages/database/prisma/schema.prisma apps/api/src --include="*.ts" 2>/dev/null | head -20`. If `Order.locale` and `User.preferredLanguage` don't exist:

- Add `locale String? @default("en")` to `Order` model and write a migration.
- Add `preferredLanguage String? @default("en")` to `User` model.

If they DO exist, skip to Step 14.2.

- [ ] **Step 14.2: Pass language at each send site**

Order-created Inngest fn:

```ts
step.run('send-customer-confirmation', () =>
  EmailService.sendOrderConfirmation(storeId, emailData, order.locale === 'ar' ? 'ar' : 'en')),
```

Same pattern in:

- `order.service.ts:sendOrderShipped` — read `order.locale`
- `order.service.ts:sendPaymentSuccess` — same
- `auth.service.ts:sendEmailVerification` — read from `req.body.language` or `user.preferredLanguage`
- `auth.service.ts:sendWelcome` — same
- `auth.service.ts:sendPasswordReset` — same
- `public.routes.ts:newsletter/subscribe` — already accepts `data.language`, pass it through
- `return.service.ts` — read from `order.locale`

- [ ] **Step 14.3: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations apps/api/src
git commit -m "feat(api): plumb language through every customer email site

reads Order.locale (orders) / User.preferredLanguage (auth) /
req body language (newsletter) at every sendX call. arabic-default
stores now send arabic emails when the buying customer was browsing
in arabic, english when english. tier 2 fully wired."
```

---

## Task 15: Storefront — extend structured-data.ts with new builders

**Files:**

- Modify: `apps/web/src/lib/structured-data.ts`
- Create: `tests/unit/structured-data.test.ts` (storefront repo)

- [ ] **Step 15.1: Read existing structured-data.ts**

```bash
cat apps/web/src/lib/structured-data.ts
```

Understand the existing `product()` builder so the new builders match style.

- [ ] **Step 15.2: Add builders**

Append to the file:

```ts
export function breadcrumbList(items: Array<{ name: string; url: string }>): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function itemList(
  products: Array<{ name: string; url: string; image?: string; price?: number; currency?: string }>,
  listName?: string
): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    ...(listName ? { name: listName } : {}),
    itemListElement: products.map((p, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      item: {
        '@type': 'Product',
        name: p.name,
        url: p.url,
        ...(p.image ? { image: p.image } : {}),
        ...(p.price !== undefined
          ? { offers: { '@type': 'Offer', price: p.price, priceCurrency: p.currency ?? 'KWD' } }
          : {}),
      },
    })),
  };
}

interface StoreData {
  name: string;
  url: string;
  logo?: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  description?: string | null;
  social?: string[];
}

export function store(s: StoreData): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'Store',
    name: s.name,
    url: s.url,
    ...(s.logo ? { logo: s.logo } : {}),
    ...(s.description ? { description: s.description } : {}),
    ...(s.email ? { email: s.email } : {}),
    ...(s.phone ? { telephone: s.phone } : {}),
    ...(s.address ? { address: { '@type': 'PostalAddress', streetAddress: s.address } } : {}),
    ...(s.social && s.social.length > 0 ? { sameAs: s.social } : {}),
  };
}

export function faqPage(faqs: Array<{ question: string; answer: string }>): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(f => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: f.answer,
      },
    })),
  };
}
```

- [ ] **Step 15.3: Tests** — pure functions, easy to unit-test. Each builder gets 2-3 tests asserting structure + edge cases (empty arrays, missing optional fields).

- [ ] **Step 15.4: Commit**

---

## Task 16: Storefront — render new schemas on store-home + listing pages

**Files:**

- Modify: `apps/web/src/app/[slug]/page.tsx` (store home)
- Modify: `apps/web/src/app/[slug]/products/page.tsx`
- Modify: `apps/web/src/app/[slug]/categories/page.tsx` (if exists)
- Modify: `apps/web/src/app/[slug]/categories/[cat]/page.tsx` (if exists — survey first)

- [ ] **Step 16.1: Store home page**

Add to the page (after existing Organization JSON-LD):

- `store({ name, url, logo, email, phone, address, social, description })`
- `breadcrumbList([{ name: 'Home', url: storeUrl }])`
- `itemList(featuredProducts, 'Featured products')` if the page renders any

- [ ] **Step 16.2: All-products listing**

Add:

- `breadcrumbList([{ Home }, { All Products }])`
- `itemList(allProducts.slice(0, 50), 'All products')` — cap at 50 to keep payload reasonable
- One `product()` schema per product is overkill on a listing page; Google reads `ItemList > Product` fine.

- [ ] **Step 16.3: Category page**

- `breadcrumbList([{ Home }, { Categories }, { CategoryName }])`
- `itemList(categoryProducts.slice(0, 50), categoryName)`

- [ ] **Step 16.4: About + Contact pages**

- About: `AboutPage` schema + `Organization`
- Contact: `ContactPage` + `PostalAddress` + `ContactPoint`

- [ ] **Step 16.5: Commit per page**

---

## Task 17: Storefront — semantic HTML upgrade

**Files:**

- Modify: `apps/web/src/components/ShopChrome.tsx`
- Modify: product card components (location TBD via `grep -rn "ProductCard\|product-card" apps/web/src --include="*.tsx" | head`)

- [ ] **Step 17.1: ShopChrome wrapper**

Replace the current `<main>` wrap with:

```tsx
<>
  <header role="banner">
    {/* top utility bar + main nav */}
    <nav aria-label="Primary navigation">{/* nav items */}</nav>
  </header>
  <main className="flex-1" role="main">
    {children}
  </main>
  <footer role="contentinfo">{/* contact + links + copyright */}</footer>
</>
```

- [ ] **Step 17.2: Product card semantic upgrade**

Wrap each product card in `<article>`:

```tsx
<article itemScope itemType="https://schema.org/Product" className="product-card">
  <h3 itemProp="name">{product.name}</h3>
  <img itemProp="image" src={product.image} alt={product.name} />
  <span itemProp="offers" itemScope itemType="https://schema.org/Offer">
    <meta itemProp="priceCurrency" content="KWD" />
    <span itemProp="price">{product.price}</span>
  </span>
</article>
```

Microdata is redundant with JSON-LD but Google reads both; cheap belt-and-suspenders.

- [ ] **Step 17.3: Commit**

---

## Task 18: Storefront /llms.txt — DYNAMIC, platform-level

**Platform-infrastructure requirement (per Ahmad 2026-05-12):** new stores automatically appear in `llms.txt` without code changes. Implement as a Next.js dynamic route, NOT a static file.

**Files:**

- Create: `apps/web/src/app/llms.txt/route.ts` — platform-level dynamic route at `store.forcemediakw.com/llms.txt` listing every active store
- Create: `apps/web/src/app/[slug]/llms.txt/route.ts` — per-store dynamic route at `store.forcemediakw.com/<slug>/llms.txt` listing that store's products + categories

- [ ] **Step 18.1: Platform-level /llms.txt route**

Create `apps/web/src/app/llms.txt/route.ts`:

```ts
import { prisma } from '@force/database';

export const revalidate = 3600; // 1h — new stores show up within an hour

export async function GET() {
  const stores = await prisma.store.findMany({
    where: { status: 'active' },
    select: {
      slug: true,
      name: true,
      nameAr: true,
      description: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const storeLines = stores
    .map(s => {
      const desc = s.description?.trim() || 'Kuwait-based merchant on Force Store.';
      return `- [${s.name}](https://store.forcemediakw.com/${s.slug}): ${desc}`;
    })
    .join('\n');

  const body = `# Force Store — Multi-tenant Storefront Platform

> Force Store is the per-merchant e-commerce platform run by Force Media Kuwait.
> Each merchant gets a path-based storefront at \`store.forcemediakw.com/<slug>\`
> with their own products, branding, and contact info. Customers in Kuwait,
> Saudi Arabia, and Qatar can browse + buy across multiple merchants from one
> platform.

## Active stores

${storeLines || '_No active stores yet._'}

## Per-store structure

Every store follows the same URL pattern:

- \`/<slug>\` — store homepage (JSON-LD: Store, ItemList of featured products, BreadcrumbList)
- \`/<slug>/products\` — full catalogue (JSON-LD: ItemList, BreadcrumbList)
- \`/<slug>/categories\` — category browse
- \`/<slug>/categories/<cat>\` — products in a category (JSON-LD: ItemList, BreadcrumbList)
- \`/<slug>/products/<product-slug>\` — product detail (JSON-LD: Product with price, availability, image)
- \`/<slug>/about\` — about the merchant (JSON-LD: AboutPage, Organization)
- \`/<slug>/contact\` — contact info (JSON-LD: ContactPage, PostalAddress, ContactPoint)
- \`/<slug>/llms.txt\` — per-store LLM index with all products + categories enumerated

## For AI agents

- Schema.org structured data on every page (JSON-LD blocks in <head>)
- Sitemap: https://store.forcemediakw.com/sitemap.xml (lists every URL for every active store)
- Languages: bilingual (English + Arabic). Store default in \`Store.inLanguage\`. Customer can browse either.
- Currency: KWD (Kuwaiti Dinar) unless individual store overrides
- Real-time inventory in \`Product.offers.availability\` (InStock / OutOfStock)
- All product data is publicly accessible — no auth or scraping protection on /<slug>/* pages
- Rate limit: 100 req/min per IP for catalogue scrape. Contact wadyaljuzkw@gmail.com or platform admin for higher quota.

## Sitemap

https://store.forcemediakw.com/sitemap.xml
`;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
}
```

- [ ] **Step 18.2: Per-store /<slug>/llms.txt route**

Create `apps/web/src/app/[slug]/llms.txt/route.ts`:

```ts
import { prisma } from '@force/database';
import { notFound } from 'next/navigation';

export const revalidate = 600; // 10 min — product/category churn is faster than store-list churn

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const store = await prisma.store.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      nameAr: true,
      description: true,
      email: true,
      phone: true,
      address: true,
      domain: true,
      _count: { select: { products: true } },
    },
  });

  if (!store || /* check active */ false) {
    notFound();
  }

  const [categories, products] = await Promise.all([
    prisma.category.findMany({
      where: { storeId: store.id, isActive: true },
      select: { slug: true, name: true, nameAr: true },
      orderBy: { name: 'asc' },
    }),
    prisma.product.findMany({
      where: { storeId: store.id, isActive: true },
      select: { slug: true, name: true, nameAr: true, price: true },
      orderBy: { name: 'asc' },
      take: 500, // cap to keep llms.txt readable
    }),
  ]);

  const base = store.domain
    ? `https://${store.domain}`
    : `https://store.forcemediakw.com/${store.slug}`;

  const catLines = categories.map(c => `- [${c.name}](${base}/categories/${c.slug})`).join('\n');

  const prodLines = products
    .map(p => `- [${p.name}](${base}/products/${p.slug}) — ${(p.price / 1000).toFixed(3)} KWD`)
    .join('\n');

  const body = `# ${store.name}${store.nameAr ? ` (${store.nameAr})` : ''}

> ${store.description || `${store.name} on Force Store — Kuwait-based merchant.`}

## Contact

- Website: ${base}
- ${store.email ? `Email: ${store.email}` : ''}
- ${store.phone ? `Phone: ${store.phone}` : ''}
- ${store.address ? `Address: ${store.address}` : ''}

## Categories (${categories.length})

${catLines || '_No active categories._'}

## Products (${store._count.products} total, showing ${products.length})

${prodLines || '_No active products._'}

## For AI agents

- Each product page has full JSON-LD \`Product\` schema with name, image, description, price, availability, currency (KWD)
- Each category page has \`ItemList\` schema enumerating products
- Sitemap for this store: ${base}/sitemap.xml (subset of the platform sitemap)
- Inventory updates in real time — re-crawl daily for fresh availability

## Platform

This store is hosted on Force Store, a multi-tenant e-commerce platform by
Force Media Kuwait. See https://store.forcemediakw.com/llms.txt for the
platform-wide index.
`;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=86400',
    },
  });
}
```

- [ ] **Step 18.3: Wire llms.txt into each store's robots.txt + sitemap**

In `apps/web/src/app/robots.ts` (existing), add the per-store llms.txt URLs OR add a `LLM-Index` line. Since `llms.txt` doesn't have a robots.txt standard yet, the convention is to list it in a comment + serve `/llms.txt` at the root. The dynamic route at Step 18.1 already does that.

Optional: add a `<link rel="alternate" type="text/markdown" href="/llms.txt" />` to the storefront layout `<head>` so LLMs that crawl HTML discover the markdown version.

- [ ] **Step 18.4: Verify cold-cache + warm-cache**

```bash
curl -s https://store.forcemediakw.com/llms.txt | head -30
curl -s https://store.forcemediakw.com/wady-aljuz/llms.txt | head -50
```

Both should return markdown listing the current active stores / wady-aljuz products. Re-curl after a store launches → new store appears within the revalidate window (1h platform, 10min per-store).

- [ ] **Step 18.5: Commit**

```bash
git add apps/web/src/app/llms.txt apps/web/src/app/\[slug\]/llms.txt
git commit -m "feat(web): dynamic /llms.txt + per-store /<slug>/llms.txt

ai-agent index files generated from prisma on each request. platform-
wide file at store.forcemediakw.com/llms.txt enumerates every active
store. per-store file at /<slug>/llms.txt lists that store's
categories + products with prices + per-store contact info.

new stores appear automatically — revalidate windows of 1h
(platform-level) and 10min (per-store). future stores get full
ai discoverability with zero per-store config."
```

---

## Task 19: Landing page llms.txt + JSON-LD audit

**Files:**

- Create: `/Users/ahmadsharaf/Desktop/projects/force_media_landing_page/llms.txt`
- Modify: `/Users/ahmadsharaf/Desktop/projects/force_media_landing_page/index.html`

- [ ] **Step 19.1: llms.txt for the landing**

Create `force_media_landing_page/llms.txt`:

```md
# Force Media Kuwait — Marketing Agency

> Expert marketing solutions in Kuwait, Saudi Arabia, and Qatar. 250+ clients
> served. Services: digital marketing, social media, content production,
> SEO, web/app development.

## Products under Force Media

- [Force Store](https://store.forcemediakw.com): Multi-tenant e-commerce
  storefronts for Kuwait merchants. Each merchant gets a branded subdomain
  path, full catalogue + checkout, KWD/USD/SAR pricing.

## Services

- Digital marketing — campaign strategy, paid media, attribution
- Social media management — Instagram, TikTok, Snapchat focus
- Content production — video, photography, graphic design
- SEO — local + regional search optimization
- Web/app development — custom builds + Force Store deployments

## Contact

- Website: https://www.forcemediakw.com
- Email: see Contact section on the homepage
- Phone: +965-6674-0311
- Address: Sanam Tower, Fahad Al-Salem Street, Kuwait City

## Sitemap

https://www.forcemediakw.com/sitemap.xml
```

- [ ] **Step 19.2: Enrich index.html JSON-LD**

Find the existing `<script type="application/ld+json">` block. ADD a second block (or extend the existing one) with:

```html
<script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "ProfessionalService",
    "name": "Force Media Kuwait",
    "url": "https://www.forcemediakw.com",
    "image": "https://www.forcemediakw.com/logo.svg",
    "areaServed": [
      { "@type": "Country", "name": "Kuwait" },
      { "@type": "Country", "name": "Saudi Arabia" },
      { "@type": "Country", "name": "Qatar" }
    ],
    "hasOfferCatalog": {
      "@type": "OfferCatalog",
      "name": "Services",
      "itemListElement": [
        { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Digital Marketing" } },
        {
          "@type": "Offer",
          "itemOffered": { "@type": "Service", "name": "Social Media Management" }
        },
        { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Content Production" } },
        { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "SEO" } },
        {
          "@type": "Offer",
          "itemOffered": { "@type": "Service", "name": "Web and App Development" }
        }
      ]
    }
  }
</script>
```

- [ ] **Step 19.3: Commit (landing repo)**

```bash
git add llms.txt index.html
git commit -m "feat: llms.txt + ProfessionalService schema for AI agents

llms.txt summarizes the agency for LLMs (perplexity, gemini, chatgpt
search). second JSON-LD block adds ProfessionalService schema with
hasOfferCatalog enumerating the 5 service lines, areaServed listing
the 3 GCC countries we operate in."
```

---

## Task 20: Smoke + verify

- [ ] **Step 20.1: Email smoke**

Re-run `scripts/smoke-real-pipeline.mjs` with `language: 'ar'` override:

```bash
# Edit the script to add a language override OR add a second smoke script
RESEND_API_KEY=re_xxx SMOKE_LANGUAGE=ar node scripts/smoke-real-pipeline.mjs
```

Confirm: email arrives in **Arabic** with RTL layout. All content (subject, body, footer attribution) localized.

Then:

```bash
SMOKE_LANGUAGE=en node scripts/smoke-real-pipeline.mjs
```

Confirm: same store, but email arrives in **English** with LTR layout.

- [ ] **Step 20.2: Storefront JSON-LD verify**

```bash
curl -s https://store.forcemediakw.com/wady-aljuz | grep -oE '"@type":"[^"]+"'
# Expected: Store, BreadcrumbList, ItemList (if featured products), Organization
```

Repeat for `/wady-aljuz/products`, `/wady-aljuz/categories/<cat>`, `/wady-aljuz/products/<slug>`.

Google's Rich Results Test (https://search.google.com/test/rich-results) — paste the URL, expect all schemas valid.

- [ ] **Step 20.3: llms.txt verify**

```bash
curl -s https://store.forcemediakw.com/llms.txt
curl -s https://www.forcemediakw.com/llms.txt
```

Both should return the markdown content.

- [ ] **Step 20.4: GSC sitemap recrawl**

In Google Search Console, sitemap status should re-pull the new schemas within 1-3 days. After 7 days, the "Pages" tab should show the new pages with structured data indicator.

---

## Acceptance criteria

All of the following must be true before claiming complete:

1. `npx vitest run tests/unit/email-template.test.ts tests/unit/email-templates-i18n.test.ts tests/unit/email-sender.test.ts tests/unit/resend-service.test.ts tests/unit/email-queue.test.ts` → all green. Adds ~50 new tests across the 12 template files.
2. `cd apps/api && npx tsc --noEmit` → no NEW errors in email/email-templates files.
3. `grep -rn "EmailService.welcomeTemplate\|EmailService.orderConfirmationTemplate" apps/api/src` → empty. All callers go through the new email-templates module.
4. Storefront pages have JSON-LD: probe with `curl … | grep '@type'` per Task 20.2.
5. `/llms.txt` returns 200 with valid markdown on both `store.forcemediakw.com` and `www.forcemediakw.com`.
6. ShopChrome renders `<header>`/`<nav>`/`<main>`/`<footer>` — verify with browser devtools accessibility tree.
7. Smoke test confirms: same store, language='ar' arg → Arabic email, language='en' arg → English email.
8. Wady Aljuz default-language='ar' → customers browsing in Arabic get Arabic emails automatically (after Task 14 wires Order.locale through).
9. Google Rich Results Test passes for `/wady-aljuz`, `/wady-aljuz/products`, `/wady-aljuz/products/<slug>`.

---

## Estimated effort

| Track                                 | Tasks | Estimate                        |
| ------------------------------------- | ----- | ------------------------------- |
| Tier 1 (override scaffold)            | 1     | 30 min                          |
| Tier 2 (12 bilingual templates)       | 2-13  | 3-4 h (mostly translation work) |
| Plumbing language through call sites  | 14    | 30 min                          |
| Storefront schema builders            | 15    | 30 min                          |
| Storefront pages — render new schemas | 16    | 1 h (4 page types)              |
| Storefront semantic HTML              | 17    | 30 min                          |
| Storefront /llms.txt                  | 18    | 15 min                          |
| Landing /llms.txt + schema            | 19    | 20 min                          |
| Smoke + verify                        | 20    | 30 min                          |
| **Total**                             |       | **~7-8 h**                      |

Subagent-driven-development is recommended — each task is independent and can dispatch in sequence to a fresh implementer with full task context. Tier 2 is the bulk of the time; if scope needs trimming, ship Tasks 1 + 14-20 (language override + storefront/llms upgrade) and defer the 12 Arabic translations until after a UX review of the smoke email at language='ar' with the existing English-content shell.
