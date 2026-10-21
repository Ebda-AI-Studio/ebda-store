# AI features plan — making "Ebda AI Studio" mean something

**Status:** plan, not yet built
**Product:** Ebda Store (the e-commerce platform)
**Company:** Ebda AI Studio (the parent brand that owns Ebda Store + Ebda AI Studio WhatsApp Business Platform)
**Goal:** ship three concrete AI features so the parent name describes real capabilities

The three features chosen, in priority order:

1. **Auto-translate EN ↔ AR** for product names + descriptions + meta
2. **AI-fill SEO meta** at every level — store, categories, products
3. **Smart category suggestions** when adding a product

Each feature ships independently. Phase 1 is the smallest demo that makes the brand truthful.

---

## Shared infrastructure

Built once, reused by all three features:

### Provider + SDK

- **Provider:** Anthropic (Claude Haiku 4.5) — cheapest tier with strong AR/EN handling, ~$0.80/M input tokens, ~$4/M output tokens.
- **SDK:** `@anthropic-ai/sdk` added to `apps/api/package.json`.
- **Env vars (Railway):**
  - `ANTHROPIC_API_KEY` — required
  - `AI_FEATURES_ENABLED` — kill switch, default `true`
  - `AI_DAILY_TOKEN_BUDGET_PER_STORE` — soft cap (e.g. `200000`) so a runaway script can't burn through credit

### Service layer

Single `apps/api/src/services/ai.service.ts` with three pure async methods:

```ts
export class AIService {
  static async translate(input: {
    text: string;
    from: 'en' | 'ar';
    to: 'en' | 'ar';
    kind: TranslationKind;
  }): Promise<string>;
  static async suggestSeo(input: {
    kind: 'store' | 'category' | 'product';
    entity: SeoSource;
  }): Promise<{
    title: string;
    titleAr: string;
    description: string;
    descriptionAr: string;
    keywords?: string[];
  }>;
  static async suggestCategories(input: {
    storeId: string;
    productName: string;
    productDescription?: string;
    existingCategories: Array<{ id: string; name: string; nameAr?: string | null }>;
  }): Promise<string[]>;
}
```

Each method:

- Builds a prompt with strict JSON output expectations
- Calls Claude Haiku
- Parses + validates with zod
- Logs tokens used to a new `AiUsage` table for billing/debugging
- Caches identical input by hash in Redis (7-day TTL)
- Throws `AppError(429)` if the store's daily token budget is exceeded

### Per-store budget tracking

New Prisma model:

```prisma
model AiUsage {
  id          String   @id @default(uuid())
  storeId     String   @map("store_id")
  feature     String   // 'translate' | 'seo' | 'categorize'
  inputTokens Int      @map("input_tokens")
  outputTokens Int     @map("output_tokens")
  cachedHit   Boolean  @default(false) @map("cached_hit")
  createdAt   DateTime @default(now()) @map("created_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([storeId, createdAt(sort: Desc)])
  @@map("ai_usage")
}
```

Aggregation query rolls up tokens per store per UTC day. The service checks the day's total before each call.

### Audit logging

Every AI call writes an audit log entry (`action: 'ai.translate' | 'ai.seo' | 'ai.categorize'`) so super_admins can see usage and trace any weird output back to the call that produced it.

### Rate limiting

Three layers:

1. **Daily token budget per store** (hard cap, returns 429)
2. **Per-minute call rate per user** (express-rate-limit, 30/min) — prevents accidental fan-out from buggy admin code
3. **Redis cache hit** — identical input within 7 days returns the cached result, no API call

---

## Feature 1: Auto-translate EN ↔ AR

**Why this first:** every store-admin currently writes Arabic copy by hand or skips it entirely. Auto-translate is the single biggest UX win — and the simplest model call.

### Trigger points

- **Product form** (`apps/admin/src/app/stores/[id]/products/[productId]/edit/`): when `name` is filled but `nameAr` is empty (or vice versa). Same for `description` ↔ `descriptionAr`, `metaTitle` ↔ `metaTitleAr`, `metaDescription` ↔ `metaDescriptionAr`.
- **Category form** (`apps/admin/src/app/stores/[id]/categories/[id]/`): same fields.
- **Store settings**: hero copy, store name, store description, store meta.

### UX

A small "Translate from English ↔" button next to each empty AR field (and vice versa for empty EN). Click → loading spinner → fills the field with the suggestion. User can edit before saving.

A bulk option in the product list: "Translate missing Arabic for visible products" — fires an Inngest job, polling progress.

### API

```
POST /api/v1/admin/stores/:storeId/ai/translate
Body: { text: string, from: 'en' | 'ar', to: 'en' | 'ar', kind: 'product-name' | 'product-description' | 'meta-title' | 'meta-description' | 'category-name' | 'store-name' | 'free' }
Response: { translation: string, cached: boolean }
```

Auth: store_admin or super_admin.

### Prompt design

System prompt:

> You translate Egyptian e-commerce content between English and Arabic. Preserve brand names, product codes, sizes, units, and numbers exactly. Keep the same tone (formal/casual) as the source. Output only the translation as plain text — no quotes, no labels, no commentary.

User prompt:

> Translate from {from} to {to}. Kind: {kind}.\n\nSource:\n{text}

For meta-title and meta-description specifically, append: "Stay under {N} characters."

### Bulk translation job

New Inngest function `bulk-translate-missing` triggered by `translation/bulk-requested` event. Streams products page-by-page, translates each missing field, writes back to DB, increments a `BulkTranslationJob` row that the admin polls.

### Effort estimate

- Service layer + endpoint: half day
- Admin form buttons: half day
- Bulk Inngest job + UI: 1 day
- **Total: 2 days**

---

## Feature 2: AI-fill SEO meta — store, categories, products

**Scope clarification:** runs at three levels, not just products. Store homepage, every category, every product.

### Trigger points

- **Per-entity button** on the SEO section of each form: "Suggest SEO" → generates EN+AR title and description in one call → user reviews and saves.
- **Bulk sweep** from store admin → "AI tools" → "Generate SEO for everything missing meta". Fires Inngest job.

### What gets generated, per kind

| Kind       | Generated fields                                                                   |
| ---------- | ---------------------------------------------------------------------------------- |
| `store`    | `metaTitle`, `metaTitleAr`, `metaDescription`, `metaDescriptionAr`, `metaKeywords` |
| `category` | `metaTitle`, `metaTitleAr`, `metaDescription`, `metaDescriptionAr`                 |
| `product`  | `metaTitle`, `metaTitleAr`, `metaDescription`, `metaDescriptionAr`                 |

(Schema check: `Store`, `Category`, `Product` already have these columns; nothing to migrate.)

### API

```
POST /api/v1/admin/stores/:storeId/ai/seo
Body: { kind: 'store' | 'category' | 'product', id: string, overwriteExisting?: boolean }
Response: { suggestion: { title, titleAr, description, descriptionAr, keywords? }, cached: boolean }
```

`overwriteExisting=false` (default) only fills empty fields. `=true` regenerates everything.

### Prompt design

System prompt:

> You write SEO meta for Egyptian e-commerce stores. Output only valid JSON: `{ "title": string, "titleAr": string, "description": string, "descriptionAr": string, "keywords": string[] }`. Title under 60 chars. Description under 160 chars. Keywords: 5-10 short phrases. Match Egypt + GCC search behaviour. Don't mention prices.

User prompt for `product`:

> Store name: {storeName}. Product: {name} (AR: {nameAr}). Description: {description} (AR: {descriptionAr}). Categories: {categoryNames}. Generate SEO meta.

Equivalent variants for `category` and `store`.

### Bulk sweep

New Inngest function `seo-bulk-generate` triggered by `seo/bulk-requested` event. Iterates the store's entities (store row → categories → products with missing meta), calls the AI service per entity, writes back. Reports progress on a `SeoBulkJob` row the admin polls.

### Concurrency control

- **Inngest function concurrency:** `{ key: 'event.data.storeId', limit: 1 }` so a store can't run two bulk jobs in parallel
- **Per-call rate limit:** the AI service's daily token budget already covers this

### Effort estimate

- Service layer (shared with #1) + endpoint: half day
- Per-form "Suggest SEO" button: half day
- Inngest bulk job + admin polling UI: 1 day
- **Total: 2 days**

---

## Feature 3: Smart category suggestions

**Scope:** when adding or editing a product, suggest 1–3 categories the merchant probably wants.

### Trigger

In the product form, watch the `name` and `description` fields. When both are filled and the user hasn't selected any category yet, show a "Suggested categories" row of clickable chips below the category picker.

Debounce input by 800ms so we don't fire a call per keystroke. Cache the result keyed by `name + description + storeId` so an idle user doesn't burn calls.

### API

```
POST /api/v1/admin/stores/:storeId/ai/suggest-categories
Body: { name: string, description?: string }
Response: { suggestions: Array<{ id: string, name: string, nameAr: string | null, confidence: 'high' | 'medium' | 'low' }> }
```

Server fetches the store's existing categories, gives them to the model along with the product name + description, asks for the top 3 matches with confidence levels.

### Prompt design

System prompt:

> You categorise products for a Egyptian e-commerce store. Given a product and a list of available categories, pick the 1-3 best matches. If none of the categories fit well, return an empty array. Output only valid JSON: `{ "matches": [{ "id": "...", "confidence": "high"|"medium"|"low" }] }`.

User prompt:

> Available categories:\n{categories as id+name+nameAr list}\n\nProduct: {name}\nDescription: {description ?? '(none)'}

### UX edge cases

- **No categories exist yet** → suggest the first 3 the merchant should create. Different code path; might defer to phase 2 or skip.
- **Empty result** → don't show the chips at all (silently no-op).
- **User already picked categories manually** → don't show suggestions (respect their choice).

### Effort estimate

- Service layer (shared) + endpoint: half day
- Admin chips UI + debounce: half day
- **Total: 1 day**

---

## Phased rollout

| Phase | Scope                                                                             | Time   | Outcome                                 |
| ----- | --------------------------------------------------------------------------------- | ------ | --------------------------------------- |
| 0     | Shared infra: SDK, env vars, AiUsage model, ai.service.ts skeleton, audit logging | 1 day  | Foundation, no user-visible feature yet |
| 1     | Feature 1 — translation (per-field + bulk)                                        | 2 days | "Ebda AI Studio" becomes truthful             |
| 2     | Feature 2 — SEO at all three levels (per-entity + bulk)                           | 2 days | Real SEO ranking lift                   |
| 3     | Feature 3 — category suggestions                                                  | 1 day  | Polish; faster product entry            |

**Total: 6 days of focused work.**

After Phase 1 ships, the landing copy can honestly add an "AI assistance" section listing translation as live and SEO + categorisation as coming soon. After Phase 2, all three features are live and the brand name describes shipped reality.

---

## Cost projection

Claude Haiku 4.5 pricing as of writing: $0.80/M input, $4/M output.

| Operation              | Tokens (in / out) | Cost per call |
| ---------------------- | ----------------- | ------------- |
| Translate product name | 100 / 50          | $0.0003       |
| Translate description  | 600 / 600         | $0.0029       |
| Generate SEO meta      | 600 / 300         | $0.0017       |
| Suggest categories     | 800 / 100         | $0.0010       |

A merchant adding 100 products with full translation + SEO + categorisation = ~100 × $0.006 = **$0.60 one-time**.

Bulk SEO sweep over 500 existing products = 500 × $0.0017 = **$0.85**.

Daily ongoing per active store: maybe 30 product edits × $0.005 = **$0.15/day = ~$5/month**.

Conclusion: budget is not a constraint. Could even charge merchants $10/month "AI add-on" with 95%+ margin.

---

## Open decisions for the operator

- **AI add-on as a paid tier?** Charge $10-25/month per store, or include free?
- **Show "AI-generated" badge** next to AI-filled fields, or hide the source?
- **Allow merchants to disable AI** entirely from store settings?
- **Default behaviour on new product save:** auto-translate without asking, or always require a button click?
- **Anthropic vs OpenAI vs Google** — Haiku is the cheapest with strong AR; if you have an OpenAI account already we can use that instead. Doesn't change the architecture.

Decide these before phase 1 starts; the rest is pure engineering.
