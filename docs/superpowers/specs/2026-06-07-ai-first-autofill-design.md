# AI-first autofill for the product catalogue — design

- **Date:** 2026-06-07
- **Status:** Approved (brainstorming) — pending implementation plan
- **Scope:** Catalogue-wide AI assist features (translation, SEO, AEO, categorization,
  recommendations) flip from manual-only to **AI-first / default-on**, with manual edits
  always winning. Storefront + admin.
- **Strategic fit:** Directly strengthens FWB Pillar 2 (AI-as-default) and Pillar 3
  (Arabic-first locality). See repo `CLAUDE.md` → "Strategic positioning".

## 1. Problem

Every AI feature in FWB exists but is **manual**: a merchant opens a product, clicks
"Generate" (translate / SEO / AEO / FAQs), or runs a catalogue-wide bulk sweep from a
button. Most merchants never click. Result: Arabic fields empty, SEO blank, products with
no recommendations — the AI-as-default promise is unrealized.

We want the AI to run **automatically** as products are created and edited, and on a
periodic safety-net sweep — while **guaranteeing a merchant's manual edit is never
overwritten**.

## 2. Core principle — provenance

Every AI-writable field has exactly one owner at any time:

| Owner   | Meaning                                              | AI behavior          |
| ------- | ---------------------------------------------------- | -------------------- |
| `empty` | never set (no value, no record)                      | **fills** it         |
| `ai`    | last written by the autofill engine, human untouched | **may refresh** it   |
| `human` | a merchant edited this field in admin                | **never touches** it |

This is the override guarantee, enforced at the **data layer** — not by convention or by
hoping the prompt behaves. The moment a merchant edits a field it becomes `human` forever
(until they clear it back to empty).

## 3. Components

### 3.1 Provenance store (1 migration)

A single JSON column on `Product`:

```prisma
aiFieldSources Json @default("{}") @map("ai_field_sources")
// e.g. { "nameAr": "ai", "metaTitle": "human", "metaDescriptionAr": "ai" }
```

- One column, no per-field columns, additive + defaulted → forward-compatible with old
  code (it simply ignores the column). Safe to migrate against the prod-serving DB per the
  expand-first rule.
- Absent key = `empty` (unknown) → AI may fill.

### 3.2 AI-writable field registry (`@force/shared`)

One exported constant is the single source of truth for **which** Product fields the AI
manages and **what source field(s)** each derives from. Both the provenance diff (§3.4) and
the fill logic (§3.5) read it, so they can never disagree.

**Bidirectional (Arabic-first).** The en/ar content pairs source **each other**, so the
engine fills whichever language is empty from the one that's filled (EN→AR _and_ AR→EN) and
refreshes SEO from a change in **either** language. The fill core only translates when
exactly one side of a pair has content (smart-skip), so the mutual sourcing never loops.

```ts
// packages/shared/src/types/ai-autofill.ts
export const AI_AUTOFILL_FIELDS = [
  // en/ar content pairs — each fills from the other when empty
  { field: 'name', sources: ['nameAr'] },
  { field: 'nameAr', sources: ['name'] },
  { field: 'description', sources: ['descriptionAr'] },
  { field: 'descriptionAr', sources: ['description'] },
  // SEO/meta — derive from product content in EITHER language
  { field: 'metaTitle', sources: ['name', 'nameAr'] },
  { field: 'metaTitleAr', sources: ['nameAr', 'name'] },
  { field: 'metaDescription', sources: ['name', 'description', 'nameAr', 'descriptionAr'] },
  { field: 'metaDescriptionAr', sources: ['nameAr', 'descriptionAr', 'name', 'description'] },
  // category is special-cased: filled only when the product has zero categories
] as const;
```

**Never overwrite existing content.** A field with a value but no provenance entry (every
**legacy** product predating this feature has `aiFieldSources = {}`) is treated as human-owned:
the fill core's `canWrite` guard only writes a field that is empty OR explicitly `ai`-owned,
so the rollout can never clobber pre-existing human/legacy content. AEO fields stay on their
existing bulk path (fast-follow).

### 3.3 Product lifecycle events (new)

There are **no** product lifecycle Inngest events today (only `order/*`). We add three,
emitted from `apps/api/src/services/product.service.ts` after the DB write commits:

- `product/created  { storeId, productId }`
- `product/updated  { storeId, productId, changedFields: string[] }`
- `product/deleted  { storeId, productId }`

Emission is best-effort (wrapped, never blocks the user's save); a dropped event is caught
by the next sweep.

### 3.4 Provenance stamping (in `product.service.ts`)

On every admin update, before persisting, diff the incoming AI-writable fields against the
stored values:

- A field whose incoming value **differs** from the stored value **and** was not written by
  the AI engine in this same operation → stamp `aiFieldSources[field] = 'human'`.
- A field cleared to empty → delete its key (back to `empty`).

This is the only place `human` is ever set, and it is centralized so every admin write
path (single edit, inline edit, bulk edit) inherits it.

### 3.5 Inngest functions (new)

All three reuse one shared `fillProductFields(storeId, productId, opts)` core so behavior
is identical across event-driven and swept paths.

**`ai-autofill-product`** — handles `product/created` + `product/updated`:

- Inngest `debounce` keyed on `event.data.productId` (~60s) so rapid saves collapse to one
  run.
- Loads product + `aiFieldSources`. Computes the fill set:
  - `empty` fields → fill.
  - `ai` fields whose **source changed** (for `updated`, intersect `changedFields` with each
    field's `sources`) → refresh.
  - `human` fields → never.
- **One batched Gemini structured call** returns all needed text fields at once (cheapest
  path — see §5).
- Categorize **only if** the product has zero categories.
- On `created`, also enqueue `bulk-ai/recommendations-requested` scoped to the new product
  so it has complements before it has order history.
- Writes fields, stamps `aiFieldSources[field] = 'ai'`, invalidates recommendation +
  storefront caches.
- Honors `assertAiQuota`, the 2.5s throttle, smart-skip, Inngest `retries: 2`.

**`ai-autofill-cleanup`** — handles `product/deleted`:

- Deletes `ai_recommendation` rows where the product is **target** (source rows cascade via
  FK), `frequently_bought_together` pairs on either side, and `product_relation` targets.
- Invalidates the recommendation cache of every product that referenced it.
- Note: the storefront already filters `status:'active', deletedAt:null` at read time, so a
  deleted product can never be recommended even before cleanup runs — cleanup keeps the
  tables + caches tidy and correct.

**`ai-autofill-sweep`** — cron, **every 3 days**, leader-locked (`withLeaderLock`, like the
FBT cron):

- Per store (respecting the `aiAutopilot` toggle): fill gaps, refresh `ai` text fields
  older than `staleTtl` (default **30 days** → rarely fires, keeps cost near zero), and
  refresh recommendations every run (they genuinely drift — see §4).
- Reuses `fillProductFields`. Smart-skip means a settled catalogue costs almost nothing.

### 3.6 Governance — `aiAutopilot` toggle

- Per-store master switch on `StoreTheme` JSON (`aiAutopilot`, default **`true`** = AI-first;
  Theme JSON passes through with zero migration per the theme-flag rule).
- When `false`: lifecycle events + sweep no-op for that store; manual buttons still work.
- A **status chip** on the Settings overview ("AI Autopilot: ON · last sweep 2d ago") per the
  discoverability status-chip rule.

### 3.7 Admin visibility — the ✨ AI badge (in scope for MVP)

- In the product editor, each AI-writable field renders a subtle **"✨ AI"** badge when its
  `aiFieldSources[field] === 'ai'`.
- The badge **disappears the moment the merchant edits the field** (optimistic: on first
  change the field is treated as `human`; confirmed on save) — visual proof that the
  override took.
- Bilingual label ("✨ AI" / "✨ ذكاء اصطناعي"), RTL-correct.
- **Hand-back-to-AI button (the inverse):** beside every **`human`-owned** field, a small
  "✨ Switch to AI" button. Clicking it clears the field value, removes the `human` lock
  (provenance → empty), and immediately regenerates that single field via the AI
  (`POST .../products/:id/ai/reset-field`). This lets a merchant give any field they typed
  back to the engine without hunting for a setting. Bilingual, RTL-correct.

## 4. Recommendations: real order-data-driven engine

The AI recommendation job **already** consumes real order history:
`computeCoPurchasePairs()` in `bulk-ai-recommendations.ts` self-joins `order_items` over a
180-day window (excluding cancelled/refunded), counts distinct co-purchase orders per
product pair, and feeds the strongest pairs into the Gemini prompt so the model prioritizes
**genuine complements customers actually buy together** over merely-similar products.

This design **hardens and makes that explicit**:

- The 3-day sweep recomputes co-purchase pairs **before** regenerating recommendations, so
  the AI picks always reflect current buying behavior.
- The runtime cascade is unchanged and already correct: **manual cross-sell → AI
  recommendation (order-anchored) → FBT co-occurrence → same-category**. Manual wins; AI is
  data-driven; FBT is the statistical floor; category guarantees a non-empty strip.
- New products (no order history yet) get AI complements immediately on `created` from
  catalogue reasoning, then transition to order-anchored picks as real co-purchases
  accumulate and the sweep refreshes them.

No change to the override semantics: AI recommendations live in their own
`ai_recommendation` table, separate from merchant `product_relation` rows, so manual
cross-sells always take priority.

## 5. Cost

On `gemini-flash-lite-latest`, all text fields batched into **one** structured call per
product:

| Catalogue      | One-time full fill | Ongoing per edit    |
| -------------- | ------------------ | ------------------- |
| 100 products   | ~$0.10             | fractions of a cent |
| 1,000 products | ~$1                | fractions of a cent |

The dollar cost is noise. The real ceiling is the **request cap**, not money: the
account-wide `assertAiQuota` (1000/day, 20k/month; cached calls don't count) plus the 2.5s
throttle rate-limit any large fill, and **smart-skip** means the 3-day sweep only touches
genuine gaps. Most Kuwait catalogues fit entirely inside Gemini's free tier.

Cost controls in effect: batched text call · debounced updates · smart-skip · conservative
`staleTtl` · account-wide cap + throttle (unchanged) · 3-day cadence.

## 6. What must NOT break (regression guards)

- **All existing manual buttons keep working unchanged** — per-product Generate
  (translate / SEO / AEO / FAQs) and the catalogue-wide bulk sweep buttons. They share the
  same `fillProductFields` core but remain independently triggerable, and a manual run
  stamps provenance `ai` exactly like the auto path.
- The recommendation runtime cascade and its public endpoints are unchanged.
- The migration is additive + defaulted (old code ignores `ai_field_sources`).
- Storefront read-time filtering (`deletedAt:null`, `status:'active'`) is untouched.

## 7. Testing

- **Unit:** provenance diff (human vs ai detection), field registry source-mapping,
  source-changed → refresh decision, staleness threshold, `aiAutopilot` gating.
- **Integration:** `created` → fill writes Arabic/SEO + marks `ai`; edit-Arabic-then-update
  → AI skips that field but refreshes the derived SEO (either-language source); legacy
  content with empty provenance is never overwritten; `deleted` → cleanup removes
  `ai_recommendation`/FBT/relation rows; sweep gaps-only vs stale-refresh.
- **Existing** bulk-job + recommendation tests stay green.

## 8. Data flow summary

```
create/update product
  → product.service stamps human-edits, emits product/created|updated
  → ai-autofill-product (debounced) → assertAiQuota → batched Gemini call
  → write fields + stamp 'ai' → invalidate caches → storefront serves

delete product
  → product/deleted → ai-autofill-cleanup → purge reco/FBT/relation refs + invalidate

every 3 days
  → ai-autofill-sweep (leader-locked) → recompute co-purchase pairs
  → fillProductFields(gaps + stale-refresh + recos) per store where aiAutopilot=ON
```

## 9. Open knobs (defaults chosen, configurable)

- `staleTtl` for text refresh — default 30 days.
- Sweep cadence — default 3 days.
- Debounce window — default 60s.
- `aiAutopilot` default — **ON** (AI-first).
