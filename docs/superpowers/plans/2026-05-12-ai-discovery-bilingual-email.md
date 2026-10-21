# AI-discoverability + bilingual email rollout — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Platform infrastructure note (Ahmad 2026-05-12):** This work targets the Ebda Store platform code (apps/web, apps/api, packages/\*). Every existing AND future tenant inherits all features automatically — no per-store opt-in. Wady Aljuz is referenced only as the verification target; the same code paths serve every merchant. The /llms.txt files are dynamic Prisma-backed routes (Task 18) so new stores appear in AI indexes within the revalidate window with zero config.

**Scope expansion (Ahmad 2026-05-12, second pass):** Three tracks added beyond the original SEO + bilingual email scope. Ebda AI Studio's positioning is "AI-native platform" so every discoverability surface gets AI tooling, not just visibility:

- **AEO + GEO** (Tasks 21-25): Answer Engine Optimization + Generative Engine Optimization. FAQ/HowTo schemas, conversational meta descriptions, knowledge-graph entity links (sameAs). Every signal piped through the existing Gemini bulk-sweep pattern so merchants don't author this content manually — AI drafts it from product data, merchant approves, bilingual (en/ar) by default.
- **Real-review collection infrastructure** (Tasks 26-31): Post-purchase review request flow + Schema.org `Review` + `AggregateRating` on product pages — **populated EXCLUSIVELY from verified-purchase real reviews**. Fake/AI-generated reviews were explicitly rejected (Egypt Law 39/2014 + FTC + EU UCPD violation, Google manual-action de-rank risk for the whole platform). AI tools assist merchants on REAL content: en↔ar translation, theme summarization, draft owner-response replies (merchant approves before sending), spam/fake-review detection. Sample/demo cards exist as labeled placeholders until real reviews arrive — never marked up as Review schema.
- **Existing-store backfill** (Tasks 32-33): One-time script populates the new AI-fillable fields (FAQ, HowTo, conversational meta, sameAs) across already-onboarded stores. Smoke + verify platform-wide. After this lands, the existing stores look identical to net-new stores from an AEO/GEO standpoint — no per-store catchup required.

**AI integration pattern (canonical for this plan):** every AEO/GEO/review field that can be AI-drafted hooks into the existing `apps/api/src/lib/ai/` infrastructure (Gemini Flash Lite, throttled at `AI_BULK_THROTTLE_MS`, capped at `AI_DAILY_REQUEST_CAP`/`AI_MONTHLY_REQUEST_CAP`, with smart-skip so it never overwrites filled fields). The same Inngest bulk-sweep pattern that fills SEO meta and AI category suggestions extends to FAQ, HowTo, conversational descriptions, review translation, review summary, and owner-response drafting. **One Gemini-Flash-Lite pipeline, one bulk-sweep UI, fifteen AI features.**

**Goal:** Three independent tracks bundled because they all touch how Force properties surface to (a) search engines, (b) AI agents (Perplexity, Gemini, ChatGPT search), and (c) merchants' Arabic-speaking customers:

1. **Bilingual email** — language override at send time (Tier 1) + full Arabic translations of all 12 customer-facing templates (Tier 2). Stores with `defaultLanguage === 'ar'` finally send emails that are actually in Arabic, not just RTL-wrapped English.
2. **Storefront AI/SEO upgrade** — Product schema on category + store-home pages (already on /products/[slug]), BreadcrumbList everywhere, ItemList on listing pages, FAQPage when present, Store schema richer than just Organization. Semantic HTML upgrade — wrap product cards in `<article>`, ensure `<header>`/`<nav>`/`<footer>` on every layout.
3. **`/llms.txt` + landing audit** — `llms.txt` for both public domains (storefront + marketing landing). Landing page JSON-LD audit beyond the existing Organization. Schema for the agency services + LocalBusiness.

**Architecture:**

- **Email language**: `EmailService.sendForStore` gains optional `language?: 'en' | 'ar'` arg that overrides `store.settings.defaultLanguage`. Each public `sendX` method accepts the same param. Templates split into bilingual modules: every template exports `{ en: (data) => string; ar: (data) => string }` and the renderer picks the right key.
- **Storefront schemas**: `apps/web/src/lib/structured-data.ts` gains `breadcrumbList(items)`, `itemList(products)`, `store(store)` builders alongside the existing `product()`. Each page (`/[slug]`, `/[slug]/products`, `/[slug]/categories/[cat]`) renders the appropriate combination.
- **Semantic HTML**: `apps/web/src/components/ShopChrome.tsx` upgraded with `<header>` + `<nav>` + `<footer>` wrappers. Product cards in `apps/web/src/components/ProductCard.tsx` (or wherever they live) wrapped in `<article>`.
- **llms.txt**: static files at `apps/web/public/llms.txt` and `/Users/ahmadsharaf/Desktop/projects/ebda-landing/llms.txt`.

**Tech Stack:** Express + TypeScript + Prisma + Neon (api), Next.js 16 App Router (apps/web storefront, apps/admin admin), vanilla HTML/JS (ebda-landing), Resend SDK, next-intl (en/ar), Vercel + Railway.

**Cross-project scope:**

- `ebda-store` repo: email service + templates + storefront pages + schema lib + llms.txt
- `ebda-landing` repo: llms.txt + JSON-LD enrichment

---

## File Structure

**Create (Ebda Store):**

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
- `apps/web/public/llms.txt` — LLM-facing site index for store.ebda.app
- `apps/web/src/lib/structured-data.ts` (extend) — add `breadcrumbList()`, `itemList()`, `store()`, `faqPage()` builders alongside existing `product()`
- `apps/web/src/components/BreadcrumbJsonLd.tsx` — client component that emits Breadcrumb JSON-LD from current route

**Modify (Ebda Store):**

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

- `/Users/ahmadsharaf/Desktop/projects/ebda-landing/llms.txt`

**Modify (landing):**

- `/Users/ahmadsharaf/Desktop/projects/ebda-landing/index.html` — add `Service` schemas for the agency offerings (digital marketing, social media, SEO, etc.) + `LocalBusiness` schema to the existing Organization block, OR a second `application/ld+json` block.

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
          ? { offers: { '@type': 'Offer', price: p.price, priceCurrency: p.currency ?? 'EGP' } }
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
    <meta itemProp="priceCurrency" content="EGP" />
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

- Create: `apps/web/src/app/llms.txt/route.ts` — platform-level dynamic route at `store.ebda.app/llms.txt` listing every active store
- Create: `apps/web/src/app/[slug]/llms.txt/route.ts` — per-store dynamic route at `store.ebda.app/<slug>/llms.txt` listing that store's products + categories

- [ ] **Step 18.1: Platform-level /llms.txt route**

Create `apps/web/src/app/llms.txt/route.ts`:

```ts
import { prisma } from '@ebda/database';

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
      const desc = s.description?.trim() || 'Egypt-based merchant on Ebda Store.';
      return `- [${s.name}](https://store.ebda.app/${s.slug}): ${desc}`;
    })
    .join('\n');

  const body = `# Ebda Store — Multi-tenant Storefront Platform

> Ebda Store is the per-merchant e-commerce platform run by Ebda AI Studio Egypt.
> Each merchant gets a path-based storefront at \`store.ebda.app/<slug>\`
> with their own products, branding, and contact info. Customers in Egypt,
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
- Sitemap: https://store.ebda.app/sitemap.xml (lists every URL for every active store)
- Languages: bilingual (English + Arabic). Store default in \`Store.inLanguage\`. Customer can browse either.
- Currency: EGP (Egyptian Dinar) unless individual store overrides
- Real-time inventory in \`Product.offers.availability\` (InStock / OutOfStock)
- All product data is publicly accessible — no auth or scraping protection on /<slug>/* pages
- Rate limit: 100 req/min per IP for catalogue scrape. Contact demo-merchantkw@gmail.com or platform admin for higher quota.

## Sitemap

https://store.ebda.app/sitemap.xml
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
import { prisma } from '@ebda/database';
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
    : `https://store.ebda.app/${store.slug}`;

  const catLines = categories.map(c => `- [${c.name}](${base}/categories/${c.slug})`).join('\n');

  const prodLines = products
    .map(p => `- [${p.name}](${base}/products/${p.slug}) — ${(p.price / 1000).toFixed(3)} EGP`)
    .join('\n');

  const body = `# ${store.name}${store.nameAr ? ` (${store.nameAr})` : ''}

> ${store.description || `${store.name} on Ebda Store — Egypt-based merchant.`}

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

- Each product page has full JSON-LD \`Product\` schema with name, image, description, price, availability, currency (EGP)
- Each category page has \`ItemList\` schema enumerating products
- Sitemap for this store: ${base}/sitemap.xml (subset of the platform sitemap)
- Inventory updates in real time — re-crawl daily for fresh availability

## Platform

This store is hosted on Ebda Store, a multi-tenant e-commerce platform by
Ebda AI Studio Egypt. See https://store.ebda.app/llms.txt for the
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
curl -s https://store.ebda.app/llms.txt | head -30
curl -s https://store.ebda.app/wady-aljuz/llms.txt | head -50
```

Both should return markdown listing the current active stores / wady-aljuz products. Re-curl after a store launches → new store appears within the revalidate window (1h platform, 10min per-store).

- [ ] **Step 18.5: Commit**

```bash
git add apps/web/src/app/llms.txt apps/web/src/app/\[slug\]/llms.txt
git commit -m "feat(web): dynamic /llms.txt + per-store /<slug>/llms.txt

ai-agent index files generated from prisma on each request. platform-
wide file at store.ebda.app/llms.txt enumerates every active
store. per-store file at /<slug>/llms.txt lists that store's
categories + products with prices + per-store contact info.

new stores appear automatically — revalidate windows of 1h
(platform-level) and 10min (per-store). future stores get full
ai discoverability with zero per-store config."
```

---

## Task 19: Landing page llms.txt + JSON-LD audit

**Files:**

- Create: `/Users/ahmadsharaf/Desktop/projects/ebda-landing/llms.txt`
- Modify: `/Users/ahmadsharaf/Desktop/projects/ebda-landing/index.html`

- [ ] **Step 19.1: llms.txt for the landing**

Create `ebda-landing/llms.txt`:

```md
# Ebda AI Studio Egypt — Marketing Agency

> Expert marketing solutions in Egypt, Saudi Arabia, and Qatar. 250+ clients
> served. Services: digital marketing, social media, content production,
> SEO, web/app development.

## Products under Ebda AI Studio

- [Ebda Store](https://store.ebda.app): Multi-tenant e-commerce
  storefronts for Egypt merchants. Each merchant gets a branded subdomain
  path, full catalogue + checkout, EGP/USD/SAR pricing.

## Services

- Digital marketing — campaign strategy, paid media, attribution
- Social media management — Instagram, TikTok, Snapchat focus
- Content production — video, photography, graphic design
- SEO — local + regional search optimization
- Web/app development — custom builds + Ebda Store deployments

## Contact

- Website: https://www.ebda.app
- Email: see Contact section on the homepage
- Phone: +965-6674-0311
- Address: Sanam Tower, Fahad Al-Salem Street, Cairo

## Sitemap

https://www.ebda.app/sitemap.xml
```

- [ ] **Step 19.2: Enrich index.html JSON-LD**

Find the existing `<script type="application/ld+json">` block. ADD a second block (or extend the existing one) with:

```html
<script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "ProfessionalService",
    "name": "Ebda AI Studio Egypt",
    "url": "https://www.ebda.app",
    "image": "https://www.ebda.app/logo.svg",
    "areaServed": [
      { "@type": "Country", "name": "Egypt" },
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
curl -s https://store.ebda.app/wady-aljuz | grep -oE '"@type":"[^"]+"'
# Expected: Store, BreadcrumbList, ItemList (if featured products), Organization
```

Repeat for `/wady-aljuz/products`, `/wady-aljuz/categories/<cat>`, `/wady-aljuz/products/<slug>`.

Google's Rich Results Test (https://search.google.com/test/rich-results) — paste the URL, expect all schemas valid.

- [ ] **Step 20.3: llms.txt verify**

```bash
curl -s https://store.ebda.app/llms.txt
curl -s https://www.ebda.app/llms.txt
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
5. `/llms.txt` returns 200 with valid markdown on both `store.ebda.app` and `www.ebda.app`.
6. ShopChrome renders `<header>`/`<nav>`/`<main>`/`<footer>` — verify with browser devtools accessibility tree.
7. Smoke test confirms: same store, language='ar' arg → Arabic email, language='en' arg → English email.
8. Wady Aljuz default-language='ar' → customers browsing in Arabic get Arabic emails automatically (after Task 14 wires Order.locale through).
9. Google Rich Results Test passes for `/wady-aljuz`, `/wady-aljuz/products`, `/wady-aljuz/products/<slug>`.

---

## Track B — AEO / GEO infrastructure

Tasks 21-25 add Answer Engine + Generative Engine Optimization. Every signal is platform-level (renders for all stores) and AI-fillable via Gemini bulk sweep (extends the existing `apps/api/src/lib/ai/` pipeline).

## Task 21: FAQ + HowTo data model + admin UI

**Files:**

- Modify: `packages/database/prisma/schema.prisma` — add `StoreFaq` + `StoreHowto` + `ProductFaq` tables
- Create: `packages/database/prisma/migrations/<TS>_add_faq_howto_tables/migration.sql`
- Modify: `apps/api/src/routes/store.routes.ts` — CRUD endpoints for FAQ + HowTo
- Modify: `apps/admin/src/app/stores/[id]/seo/page.tsx` — FAQ/HowTo editor section
- Create: `apps/admin/src/i18n/messages/{en,ar}.json` — new keys for the editor

- [ ] **Step 21.1: Schema additions**

```prisma
model StoreFaq {
  id            String   @id @default(cuid())
  storeId       String   @map("store_id")
  store         Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)
  question      String   @map("question")
  questionAr    String?  @map("question_ar")
  answer        String   @db.Text @map("answer")
  answerAr      String?  @db.Text @map("answer_ar")
  // AI-draft state — same pattern as SEO meta. Smart-skip respects this:
  // never overwrites a manually-edited entry.
  aiDrafted     Boolean  @default(false) @map("ai_drafted")
  manuallyEdited Boolean @default(false) @map("manually_edited")
  orderIndex    Int      @default(0) @map("order_index")
  isActive      Boolean  @default(true) @map("is_active")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@index([storeId, isActive, orderIndex])
  @@map("store_faqs")
}

model StoreHowto {
  id            String   @id @default(cuid())
  storeId       String   @map("store_id")
  store         Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)
  title         String   @map("title")
  titleAr       String?  @map("title_ar")
  description   String   @db.Text @map("description")
  descriptionAr String?  @db.Text @map("description_ar")
  // HowTo.step is an array of HowToStep — store as JSON
  steps         Json     @map("steps")
  // Format: [{ name, nameAr, text, textAr, image? }, ...]
  stepsAr       Json?    @map("steps_ar")
  aiDrafted     Boolean  @default(false) @map("ai_drafted")
  manuallyEdited Boolean @default(false) @map("manually_edited")
  orderIndex    Int      @default(0) @map("order_index")
  isActive      Boolean  @default(true) @map("is_active")
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@index([storeId, isActive, orderIndex])
  @@map("store_howtos")
}

// Per-product FAQs (e.g. "Does this ring come in size 7?") — separate
// from store-level FAQs so Product schema can include them inline.
model ProductFaq {
  id            String   @id @default(cuid())
  productId     String   @map("product_id")
  product       Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  question      String
  questionAr    String?  @map("question_ar")
  answer        String   @db.Text
  answerAr      String?  @db.Text @map("answer_ar")
  aiDrafted     Boolean  @default(false) @map("ai_drafted")
  manuallyEdited Boolean @default(false) @map("manually_edited")
  createdAt     DateTime @default(now()) @map("created_at")

  @@index([productId])
  @@map("product_faqs")
}
```

Also add relations on `Store` and `Product` (`faqs: StoreFaq[]`, `howtos: StoreHowto[]`, `faqs: ProductFaq[]`).

- [ ] **Step 21.2: Migration SQL** — standard `CREATE TABLE` with FK + indexes. Run via `prisma migrate dev`.

- [ ] **Step 21.3: API CRUD** — append to `store.routes.ts`:
  - `GET /stores/:id/faqs`, `POST /stores/:id/faqs`, `PUT /stores/:id/faqs/:faqId`, `DELETE /stores/:id/faqs/:faqId`
  - Same for howtos
  - Same for products/:productId/faqs

  Each handler follows the existing auth chain (`authenticate → authorize → requireStoreAccess`). Zod schemas: `{ question, questionAr?, answer, answerAr?, orderIndex? }` for FAQ; HowTo adds `title, steps[]`.

- [ ] **Step 21.4: Admin UI editor**

In `apps/admin/src/app/stores/[id]/seo/page.tsx`, add two new collapsible sections after the sender-prefix input:

- "Frequently Asked Questions" — sortable list of Q/A pairs, "AI draft from products" button (triggers Task 24 bulk sweep)
- "How-To Guides" — sortable list with title, description, step-by-step builder

Both sections show the en/ar tabs the storefront uses. Toggle `isActive` per entry.

- [ ] **Step 21.5: Commit**

## Task 22: FAQ + HowTo storefront rendering

**Files:**

- Modify: `apps/web/src/app/[slug]/page.tsx` — store-home renders FAQPage JSON-LD when faqs exist + a visible "FAQs" section
- Modify: `apps/web/src/app/[slug]/products/[productSlug]/page.tsx` — Product schema gains inline `mainEntity` `Question` entries from ProductFaq
- Create: `apps/web/src/app/[slug]/help/page.tsx` (or `/faq` per locale) — dedicated FAQ + HowTo page rendering all entries
- Modify: `apps/web/src/lib/structured-data.ts` — add `howTo()` builder

- [ ] **Step 22.1: Add `faqPage` + `howTo` JSON-LD builders**

`faqPage` is in Task 15 already. Add:

```ts
export function howTo(data: {
  name: string;
  description: string;
  steps: Array<{ name: string; text: string; image?: string }>;
}): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: data.name,
    description: data.description,
    step: data.steps.map((s, idx) => ({
      '@type': 'HowToStep',
      position: idx + 1,
      name: s.name,
      text: s.text,
      ...(s.image ? { image: s.image } : {}),
    })),
  };
}
```

- [ ] **Step 22.2: Store-home renders FAQPage JSON-LD + visible FAQ accordion**

When `store.faqs.length > 0`:

1. Inject `<script type="application/ld+json">` with `faqPage(store.faqs.map(f => ({ question, answer })))`
2. Visible `<section aria-labelledby="faq-heading">` with accordion of Q/A pairs (existing UI patterns in storefront)

Bilingual: pick `f.question` vs `f.questionAr` based on the current storefront locale (storefront already routes by locale).

- [ ] **Step 22.3: Product-detail FAQ embeds**

In product detail JSON-LD, extend the `Product` schema's `mainEntity` with inline FAQs:

```ts
const productLd = {
  ...product(productData),
  ...(product.faqs.length > 0
    ? {
        mainEntity: product.faqs.map(f => ({
          '@type': 'Question',
          name: f.question,
          acceptedAnswer: { '@type': 'Answer', text: f.answer },
        })),
      }
    : {}),
};
```

- [ ] **Step 22.4: Dedicated /<slug>/help page**

Rendering: all store FAQs grouped first, then all HowTos. Both with their own JSON-LD blocks.

URL: `/[slug]/help` (English), `/[slug]/help` (Arabic — same path, locale via cookie/header). Sitemap auto-picks this up.

- [ ] **Step 22.5: Commit**

## Task 23: Knowledge entity links (sameAs management)

**Files:**

- Modify: `packages/database/prisma/schema.prisma` — add `Store.socialLinks Json?` column (or use existing if present)
- Modify: `apps/admin/src/app/stores/[id]/social/page.tsx` (or extend an existing settings page) — UI to enter Wikidata/Wikipedia/Instagram/TikTok/LinkedIn URLs
- Modify: `apps/web/src/app/[slug]/page.tsx` + structured-data.ts `store()` builder — emit `sameAs: [...]` from the saved links

- [ ] **Step 23.1: Schema column**

If a column already exists for social links, extend it. Otherwise:

```prisma
socialLinks  Json?  @map("social_links")
// Format: { wikidata?: string, wikipedia?: string, instagram?: string,
//          tiktok?: string, linkedin?: string, facebook?: string,
//          youtube?: string, twitter?: string }
```

- [ ] **Step 23.2: Admin UI section "Social & Knowledge Graph"**

In the store settings page, new section: 8 input fields (one per platform), with placeholders + format hints (e.g. "Full URL: https://www.wikidata.org/wiki/Q12345"). Validation: must be valid URL on save.

- [ ] **Step 23.3: Emit `sameAs` in store JSON-LD**

Update `store()` builder in `structured-data.ts`:

```ts
export function store(s: StoreData & { social?: string[] }): object {
  return {
    // ... existing
    ...(s.social && s.social.length > 0 ? { sameAs: s.social } : {}),
  };
}
```

Page renders this from `store.socialLinks` — flatten into an array of URLs, drop empties.

- [ ] **Step 23.4: Commit**

## Task 24: AI bulk sweep — FAQ + HowTo + conversational meta

**Files:**

- Create: `apps/api/src/lib/ai/aeo-sweep.ts` — Gemini-backed FAQ/HowTo/meta draft generator
- Modify: `apps/api/src/lib/inngest/functions/bulk-ai-jobs.ts` — register new bulk job types `draft-store-faqs`, `draft-store-howtos`, `rewrite-meta-conversational`
- Modify: `apps/admin/src/app/stores/[id]/ai/page.tsx` (or whatever the AI sweep dashboard is) — new buttons to trigger the sweeps

- [ ] **Step 24.1: Survey existing AI infrastructure**

```bash
ls apps/api/src/lib/ai/
grep -rn "gemini\|Generative" apps/api/src/lib/ai/ | head
```

Read 2-3 existing AI sweep functions (the SEO one + the category-suggestion one) to learn the throttle pattern, smart-skip logic, and Inngest job shape.

- [ ] **Step 24.2: Draft FAQ generator (Gemini)**

`apps/api/src/lib/ai/aeo-sweep.ts`:

```ts
export async function draftFaqsForStore(storeId: string): Promise<StoreFaq[]> {
  // 1. Load store + product catalogue + categories
  // 2. Call Gemini with a prompt like:
  //    "Given this store sells X products in Y categories, draft the 8
  //     most likely FAQs a customer would ask. Return JSON array of
  //     { question, questionAr, answer, answerAr }. Tone: concise,
  //     direct, customer-focused. Use store's actual products in
  //     answers where relevant."
  // 3. Throttle via AI_BULK_THROTTLE_MS
  // 4. Cap via AI_DAILY_REQUEST_CAP
  // 5. Smart-skip: read existing FAQs; only insert new ones (where
  //    none with similar `question` exist OR existing has aiDrafted=true
  //    && manuallyEdited=false)
  // 6. Insert with aiDrafted: true, manuallyEdited: false so future
  //    sweeps can replace them but a merchant edit locks them
}

export async function draftHowtosForStore(storeId: string): Promise<StoreHowto[]> {
  // Similar pattern: prompt asks for 3-5 HowTo guides relevant to the
  // store's product mix (e.g. "How to choose the right size", "How to
  // care for leather", "How we ship to GCC"). Steps array, bilingual.
}

export async function rewriteMetaConversational(storeId: string): Promise<void> {
  // Re-runs the existing SEO meta sweep but with an AEO-flavored prompt:
  // "Rewrite this meta description to directly answer 'What is X?' style
  //  questions. Avoid keyword stuffing. Conversational, 140-160 chars,
  //  bilingual."
  // Skip if metaDescription was manuallyEdited.
}
```

- [ ] **Step 24.3: Inngest job + admin trigger**

Each becomes an Inngest function that runs over all active stores OR a single store. Admin UI button "Draft AEO content for this store" fires the single-store job; super-admin button "Draft AEO content for all stores" fires the platform-wide sweep.

- [ ] **Step 24.4: Tests + commit**

Mocks Gemini SDK, asserts smart-skip logic, asserts bilingual output, asserts cap+throttle.

## Task 25: Storefront — conversational meta descriptions render

**Files:**

- Modify: `apps/web/src/app/[slug]/page.tsx` + product/category pages — read `store.metaDescription` (or category/product equivalent) verbatim. No code change if these already read from DB; just verify the new AI-rewritten values flow through.

This is mostly a verification task — Task 24 wrote AI-drafted conversational descriptions to existing columns, so the storefront automatically renders them.

- [ ] **Step 25.1: Verify**

Trigger the AI sweep on a test store. Curl the store homepage. Confirm `<meta name="description" content="...">` reflects the new conversational copy.

- [ ] **Step 25.2: Commit (if any code change needed)**

---

## Track C — Real-review collection infrastructure

Tasks 26-31. Schema.org `Review` + `AggregateRating` populated EXCLUSIVELY from real verified-purchase reviews. AI tools assist merchants on REAL content; never generates reviews.

## Task 26: Review data model + Order.deliveredAt

**Files:**

- Modify: `packages/database/prisma/schema.prisma` — add `Review` model, `Order.deliveredAt`
- Create: `packages/database/prisma/migrations/<TS>_add_reviews/migration.sql`

- [ ] **Step 26.1: Schema**

```prisma
model Review {
  id            String   @id @default(cuid())
  productId     String   @map("product_id")
  product       Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  storeId       String   @map("store_id")
  store         Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)
  orderId       String   @map("order_id")
  order         Order    @relation(fields: [orderId], references: [id], onDelete: Restrict)
  customerId    String?  @map("customer_id")
  customer      User?    @relation(fields: [customerId], references: [id], onDelete: SetNull)

  // The review content itself
  rating        Int      // 1-5
  title         String?
  body          String   @db.Text
  language      String   @default("en") // 'en' | 'ar'
  bodyTranslated String? @db.Text @map("body_translated") // AI translation of body
  bodyTranslatedAt DateTime? @map("body_translated_at")

  // Verification + moderation
  verifiedPurchase Boolean @default(true) @map("verified_purchase") // always true via this flow
  status        String   @default("pending") // 'pending' | 'published' | 'rejected' | 'spam'
  rejectionReason String? @map("rejection_reason")
  spamScore     Float?   @map("spam_score") // 0-1, AI-flagged
  spamReasons   Json?    @map("spam_reasons")

  // Merchant response (optional)
  ownerResponse    String?  @db.Text @map("owner_response")
  ownerResponseAr  String?  @db.Text @map("owner_response_ar")
  ownerResponseAt  DateTime? @map("owner_response_at")

  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@unique([orderId, productId])  // one review per buyer-product pair
  @@index([productId, status])
  @@index([storeId, status])
  @@map("reviews")
}
```

And on Order:

```prisma
deliveredAt   DateTime? @map("delivered_at")
reviewRequestSentAt DateTime? @map("review_request_sent_at")
```

- [ ] **Step 26.2: Backfill `deliveredAt` for existing orders**

For orders with `status = 'delivered'` but no `deliveredAt`, set `deliveredAt = updatedAt` as best estimate.

```sql
UPDATE orders SET delivered_at = updated_at
WHERE status = 'delivered' AND delivered_at IS NULL;
```

- [ ] **Step 26.3: Commit**

## Task 27: Post-purchase review-request Inngest job

**Files:**

- Create: `apps/api/src/lib/inngest/functions/review-request.ts`
- Modify: `apps/api/src/lib/inngest/client.ts` — register the new function
- Modify: `apps/api/src/services/order.service.ts` — call `inngest.send('order.delivered', ...)` when an order status changes to delivered
- Create: `apps/api/src/services/email-templates/review-request.ts` — bilingual review-request email template (extends Task 2 pattern)

- [ ] **Step 27.1: Inngest function**

Listens for `order.delivered`, schedules a 7-day-delayed step that:

1. Re-checks the order is still `delivered` (not refunded/cancelled in the meantime)
2. Iterates over `order.items`, sends ONE email per item (or one consolidated email — pick during implementation)
3. Email contains a token-signed deep link to `/<slug>/review/<orderId>/<productId>?token=<hmac>` (token = HMAC of orderId+productId+secret, expires in 90 days)
4. Sets `order.reviewRequestSentAt = now()` so a re-trigger doesn't double-send

- [ ] **Step 27.2: Bilingual review-request template**

```ts
export const reviewRequestTemplate: BilingualTemplate<{
  customerName: string;
  productName: string;
  reviewLink: string;
}> = {
  subject: {
    en: (d, s) => `How was your ${d.productName}?`,
    ar: (d, s) => `كيف كانت تجربتك مع ${d.productName}؟`,
  },
  en: (d, s) => `
    <h2>How was it, ${escapeHtml(d.customerName)}?</h2>
    <p>You received your ${escapeHtml(d.productName)} from ${escapeHtml(s)} a week ago.
       Mind sharing a quick review? It helps other shoppers and helps us improve.</p>
    <p><a href="${escapeHtml(d.reviewLink)}" class="button">Leave a review</a></p>
    <p style="color:#94a3b8;font-size:12px;">Takes 30 seconds. Only verified buyers can review.</p>
  `,
  ar: (d, s) => `
    <h2>كيف كانت تجربتك يا ${escapeHtml(d.customerName)}؟</h2>
    <p>وصلك ${escapeHtml(d.productName)} من ${escapeHtml(s)} قبل أسبوع. هل تشاركنا تقييمك القصير؟
       يساعد العملاء الآخرين ويساعدنا على التحسين.</p>
    <p><a href="${escapeHtml(d.reviewLink)}" class="button">اترك تقييمك</a></p>
    <p style="color:#94a3b8;font-size:12px;">يستغرق 30 ثانية. فقط المشترون الموثقون يمكنهم التقييم.</p>
  `,
};
```

- [ ] **Step 27.3: Wire `order.delivered` event**

In `order.service.ts`, when status transitions to `delivered` and `deliveredAt` is being set, fire:

```ts
await inngest.send({
  name: 'order.delivered',
  data: { orderId, storeId: order.storeId },
});
```

- [ ] **Step 27.4: Tests + commit**

Mock inngest, mock prisma, mock template. Assert: send fires once per order, doesn't fire on refunded orders, doesn't double-send.

## Task 28: Public review submission flow (token-gated)

**Files:**

- Create: `apps/web/src/app/[slug]/review/[orderId]/[productId]/page.tsx` — public review form (token-validated server-side)
- Create: `apps/api/src/routes/public.routes.ts` (extend) — `POST /public/reviews/submit` with token validation

- [ ] **Step 28.1: Review form page (server component)**

Validates the `token` query param against HMAC. If valid + order is delivered + no existing review for this orderId+productId → renders the form. Otherwise → error page.

Form: 5-star rating, optional title, required body (min 20 chars), language radio (en/ar).

- [ ] **Step 28.2: API endpoint**

`POST /public/reviews/submit` validates token again, creates Review row with `status: 'pending'`, fires `inngest.send('review.submitted', ...)` which triggers Task 30's AI spam check.

- [ ] **Step 28.3: Tests + commit**

## Task 29: Review JSON-LD on product pages + AggregateRating

**Files:**

- Modify: `apps/web/src/app/[slug]/products/[productSlug]/page.tsx` — emit `Review[]` + `AggregateRating` in Product JSON-LD ONLY when `verifiedPurchase: true && status: 'published'`
- Modify: `apps/web/src/lib/structured-data.ts` — add `review()` + `aggregateRating()` builders

- [ ] **Step 29.1: Schema builders**

```ts
export function review(r: {
  author: string;
  rating: number;
  body: string;
  datePublished: string;
}): object {
  return {
    '@type': 'Review',
    author: { '@type': 'Person', name: r.author },
    reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5 },
    reviewBody: r.body,
    datePublished: r.datePublished,
  };
}

export function aggregateRating(data: { ratingValue: number; reviewCount: number }): object {
  return {
    '@type': 'AggregateRating',
    ratingValue: data.ratingValue.toFixed(1),
    reviewCount: data.reviewCount,
    bestRating: 5,
    worstRating: 1,
  };
}
```

- [ ] **Step 29.2: Wire into Product JSON-LD**

On product detail page:

1. Query `Review.findMany({ where: { productId, status: 'published', verifiedPurchase: true }, take: 20, orderBy: { createdAt: 'desc' } })`
2. Compute `aggregateRating` from `avg(rating)` + `count(*)`
3. Inject both into the Product JSON-LD `review` + `aggregateRating` fields

**Critical:** `verifiedPurchase: true` filter is non-negotiable. Reviews that didn't come from the token-gated post-purchase flow can't be marked as such.

- [ ] **Step 29.3: Visible review section**

Renders the same reviews in a visible section on the product page. Includes owner response when present.

- [ ] **Step 29.4: Commit**

## Task 30: AI tools for reviews (translation, summary, owner-response, spam detection)

**Files:**

- Modify: `apps/api/src/lib/ai/aeo-sweep.ts` (extend) — `translateReview`, `summarizeReviews`, `draftOwnerResponse`, `detectSpamReview`
- Modify: `apps/api/src/lib/inngest/functions/bulk-ai-jobs.ts` — new job types
- Modify: `apps/admin/src/app/stores/[id]/reviews/page.tsx` (new page) — merchant review dashboard with the AI assist buttons

- [ ] **Step 30.1: Translate**

Fires automatically on review submission. Gemini translates `body` between en/ar; stores in `bodyTranslated`. Customers viewing the product in either language see the translation alongside the original. Both forms get distinct `inLanguage` tags in JSON-LD.

- [ ] **Step 30.2: Spam detection**

On review submission, Gemini scores `body` for: profanity, off-topic content, copy-paste from other sites, marketing spam, bot patterns. Score >0.7 → auto-set `status: 'spam'`; 0.3-0.7 → `status: 'pending'` flagged for merchant review; <0.3 → `status: 'published'`.

Smart: if a merchant manually approves a review the AI flagged, the spam-detector learns to weight that store's content differently (small per-store calibration via stored examples — keep it simple at first, just exact-match overrides).

- [ ] **Step 30.3: Summarize themes (merchant dashboard)**

Merchant clicks "Summarize this product's reviews" → Gemini reads all published reviews and outputs: top 3 positive themes, top 3 negative themes, sentiment trend over time. Displayed in the review dashboard.

- [ ] **Step 30.4: Draft owner response**

Merchant clicks "Draft a response" on a specific review → Gemini drafts a polite, on-brand reply (en + ar versions). Merchant EDITS + APPROVES before it's published. The merchant is always the final author per Schema.org `Review.publisher` semantics.

- [ ] **Step 30.5: Tests + commit**

## Task 31: Sample/demo cards (labeled placeholders, NO JSON-LD)

**Files:**

- Modify: `apps/web/src/app/[slug]/products/[productSlug]/page.tsx` — when zero published reviews, render labeled placeholder cards
- NEVER inject `Review` JSON-LD for these

- [ ] **Step 31.1: Placeholder UI**

When a product has zero reviews, show:

```tsx
<section aria-labelledby="reviews-heading">
  <h2 id="reviews-heading">Reviews</h2>
  <p className="text-muted-foreground italic">
    {t('reviews.beFirstToReview')} {/* "Be the first to review this product" */}
  </p>
  {/* Optional: example/demo cards visibly labeled */}
  <div className="opacity-50 pointer-events-none" aria-hidden="true">
    <p className="text-xs uppercase">{t('reviews.sampleLabel')}</p>
    {/* sample cards with clearly-labeled fictitious content */}
  </div>
</section>
```

The sample cards exist purely as visual templates so merchants understand what their review section will look like once real reviews arrive. Wrapped in `opacity-50 pointer-events-none aria-hidden` and explicitly labeled `Sample / تمهيد`. **Never marked up as Review schema, never appears in JSON-LD.**

- [ ] **Step 31.2: Commit**

---

## Track D — Existing-store backfill

## Task 32: One-time AI backfill script for existing stores

**Files:**

- Create: `scripts/backfill-aeo-content.mjs`

Script iterates every active store and queues the Inngest sweeps from Task 24 — sequentially with throttle to respect the Gemini cap. Dry-run by default; `--apply` actually runs.

- [ ] **Step 32.1: Script**

```js
import { PrismaClient } from '@prisma/client';
import { inngest } from '../apps/api/src/lib/inngest/client.js';

const apply = process.argv.includes('--apply');
const prisma = new PrismaClient();
const stores = await prisma.store.findMany({
  where: { status: 'active' },
  select: { id: true, name: true },
});

for (const s of stores) {
  console.log(`Queueing AEO sweep for ${s.name} (${s.id})`);
  if (apply) {
    await inngest.send([
      { name: 'ai.draft-store-faqs', data: { storeId: s.id } },
      { name: 'ai.draft-store-howtos', data: { storeId: s.id } },
      { name: 'ai.rewrite-meta-conversational', data: { storeId: s.id } },
    ]);
    await new Promise(r => setTimeout(r, 3000)); // 3s between stores so Inngest's queue smooths the Gemini load
  }
}
console.log(`Done. ${apply ? 'Applied' : 'Dry-run'} for ${stores.length} stores.`);
```

- [ ] **Step 32.2: Run on prod**

```bash
node scripts/backfill-aeo-content.mjs              # dry-run, prints plan
node scripts/backfill-aeo-content.mjs --apply      # fires the sweeps
```

Inngest dashboard shows progress. Expect 3-5 min per store given Gemini throttle.

- [ ] **Step 32.3: Verify**

After sweeps complete, spot-check 3-5 random stores: do they have FAQ entries? Conversational meta descriptions? HowTos? Run Google Rich Results Test on their homepage.

## Task 33: Smoke + verify platform-wide

- [ ] **Step 33.1: Cross-store smoke**

For each of: Wady Aljuz + 2-3 other active stores:

- `curl /<slug>` → has Store + ItemList + FAQPage (if FAQs filled) JSON-LD
- `curl /<slug>/products/<a-product>` → has Product + Review + AggregateRating (if real reviews) + ProductFaq (if filled) JSON-LD
- `curl /<slug>/help` → has FAQPage + HowTo JSON-LD
- `curl /<slug>/llms.txt` → up-to-date markdown index
- `curl /llms.txt` → platform-level index lists every active store

- [ ] **Step 33.2: AEO tooling test**

Open https://www.perplexity.ai → search "Where to buy [product type] in Egypt". Within 1-2 weeks of indexing, the store should appear in Perplexity's sources for relevant queries.

- [ ] **Step 33.3: Update memory**

Per `~/.claude/CLAUDE.md` rule "Update memory per commit during multi-step work", capture:

- `feedback-aeo-geo-pattern.md` — the FAQ/HowTo/sameAs/conversational-meta pattern as a reusable architecture
- `reference-ebda-review-infra.md` — the real-review pipeline (token-gated, AI-assisted-merchant-not-AI-author)
- `feedback-fake-reviews-never.md` — the explicit "never generate fake reviews" rule with the regulatory citations + the legitimate alternative

---

## Updated estimated effort

| Track                                      | Tasks | Estimate                        |
| ------------------------------------------ | ----- | ------------------------------- |
| Tier 1 (override scaffold)                 | 1     | 30 min                          |
| Tier 2 (12 bilingual templates)            | 2-13  | 3-4 h                           |
| Plumbing language through call sites       | 14    | 30 min                          |
| Storefront schema builders                 | 15    | 30 min                          |
| Storefront pages — render new schemas      | 16    | 1 h                             |
| Storefront semantic HTML                   | 17    | 30 min                          |
| Storefront + per-store /llms.txt (dynamic) | 18    | 45 min                          |
| Landing /llms.txt + schema                 | 19    | 20 min                          |
| Initial smoke + verify                     | 20    | 30 min                          |
| **Track B — AEO/GEO**                      |       |                                 |
| FAQ + HowTo data model + admin UI          | 21    | 2 h                             |
| FAQ + HowTo storefront rendering           | 22    | 1.5 h                           |
| Knowledge entity links (sameAs)            | 23    | 1 h                             |
| AI bulk sweep for FAQ/HowTo/meta           | 24    | 2-3 h                           |
| Conversational meta verification           | 25    | 15 min                          |
| **Track C — Real reviews**                 |       |                                 |
| Review data model + Order.deliveredAt      | 26    | 1 h                             |
| Post-purchase review-request Inngest       | 27    | 1.5 h                           |
| Public review submission flow              | 28    | 1.5 h                           |
| Review JSON-LD + AggregateRating           | 29    | 1 h                             |
| AI review tools (4 sub-features)           | 30    | 3-4 h                           |
| Sample/demo placeholder UI                 | 31    | 30 min                          |
| **Track D — Backfill**                     |       |                                 |
| AI backfill script for existing stores     | 32    | 45 min                          |
| Cross-store smoke + memory updates         | 33    | 1 h                             |
| **Total**                                  | 33    | **~24-28 h** (vs original 7-8h) |

Track A (Tasks 1-20) ships first — bilingual email + SEO base layer is foundational. Tracks B/C/D can ship in any order after; they don't depend on each other directly though Track D depends on B existing.

**Suggested execution waves:**

1. **Wave 1** (Track A, ~7-8h): Tasks 1-20. Wady Aljuz visibly improves. Baseline ships.
2. **Wave 2** (Track B, ~6-8h): Tasks 21-25. FAQ/HowTo + AI auto-fill goes live. AEO/GEO baseline ships.
3. **Wave 3** (Track C, ~9-12h): Tasks 26-31. Real reviews start collecting. Aggregate ratings appear once first reviews land (7-14 days after deliveries).
4. **Wave 4** (Track D, ~2h): Tasks 32-33. Existing stores catch up; smoke verifies platform-wide.

If scope must trim, drop Track C (real reviews) to a follow-up plan — it's the most independent piece and reviews infrastructure benefits from a few weeks of platform usage before you have enough deliveries to seed it.
