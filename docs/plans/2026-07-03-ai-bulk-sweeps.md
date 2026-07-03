# AI Bulk Sweeps — fix Product FAQs + add 4 new catalogue sweeps

**Date:** 2026-07-03 · **Scope:** fix the broken Product-FAQ bulk sweep + add bulk sweeps for category, image alt-text, excerpt, and product tags.

## Problem

The AI-tools page has a **"Draft Product FAQs"** card that POSTs to `/bulk/product-faqs`, but that route was never implemented and `BulkAiJobKind` has no `product_faqs` value — so the button 404s and nothing runs. The Inngest function (`bulkAiProductFaqs`), the generator (`generateProductFaqs`), the per-product endpoint, and the results panel already exist. Separately, four product fields AI _could_ fill catalogue-wide have no bulk sweep at all: **category, image alt-text, excerpt/short-description, product tags.**

## Design — one established pattern, applied 5×

Every sweep mirrors the canonical `bulk-ai-product-faqs` + `/bulk/faq-aeo` shape:

1. **`BulkAiJobKind` enum value** (migration: `ALTER TYPE ... ADD VALUE`; additive-only, values not used in the same migration → no PG transaction trap).
2. **`/bulk/<x>` route** in `ai.routes.ts` — `requireFeature('bulk_operations')` + `writeLimiter`, creates a `BulkAiJob` with the kind, sends the Inngest event, `markJobFailedIfEnqueueFailed` on enqueue error, `202`.
3. **Inngest function** in `lib/inngest/functions/bulk-ai-<x>.ts` — concurrency key on `storeId` (limit 1), retries 2, `AI_BULK_THROTTLE_MS` throttle, `assertAiQuota` before each Gemini call, error cap 50, cooperative cancellation every 5 items, progress writes, `filled/skipped/failed` counters. Registered in `functions/index.ts` + event type in `client.ts`.
4. **AI generator** in `lib/ai/<x>-generator.ts` — the shared core, reused by any per-product button.
5. **AI-tools UI card** + results-panel `case` + bilingual i18n strings.

**Shared behaviour (all 5):** write directly, **skip products that already have the field** (smart-skip → counts as `skipped`), `force:true` re-does AI-owned values only and never clobbers manual edits (via `aiFieldSources`/`manuallyEdited`). Bilingual EN+AR where the field is bilingual.

## The five sweeps

| Kind              | Field written                         | Skip-when                       | Notes                                                                                                                                           |
| ----------------- | ------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_faqs`    | `ProductFaq` rows                     | product has ≥1 FAQ              | **FIX** — route+enum only; everything else exists                                                                                               |
| `category_assign` | `ProductCategory` join                | product already has ≥1 category | **uncategorized-only** (Ahmad's call); reuse `/suggest-categories` logic; assign top match from the store's own categories; never re-categorize |
| `image_alt`       | `ProductImage.alt`                    | image already has `alt`         | Gemini vision on each image lacking alt; concise descriptive alt (SEO + a11y)                                                                   |
| `excerpt`         | `Product.excerpt` / `excerptAr`       | product has an excerpt          | derive a 1–2 sentence short description from the full description; EN+AR; stamp `aiFieldSources`                                                |
| `product_tags`    | `ProductTag` join (create/link `Tag`) | product has ≥1 tag              | suggest ≤5 tags from name+description; dedupe against the store's existing tags; create missing `Tag` rows                                      |

## Guardrails / correctness

- **Category:** only fill products with **zero** categories; pick from the store's existing categories (don't invent). If no confident match → skip (not fail).
- **Tags:** cap 5/product; reuse existing store tags by case-insensitive name before creating; never delete tags.
- **Alt-text:** vision call per image without alt; cap images/product to avoid quota blowups; alt ≤160 chars.
- **Quota/throttle:** identical to FAQ sweep — `assertAiQuota` + 2.5s throttle + daily/monthly caps apply, so a big catalogue can't brick the day's Gemini budget.
- **Feature gate:** all under `requireFeature('bulk_operations')` (same as existing sweeps), on the `ai_tools`-gated page.

## Files touched

- `packages/database/prisma/schema.prisma` + one migration (5 enum values)
- `apps/api/src/lib/inngest/client.ts` (4 new events), `functions/index.ts` (4 new registrations)
- `apps/api/src/routes/ai.routes.ts` (5 new `/bulk/*` routes)
- `apps/api/src/lib/ai/{product-category-suggester,product-alt-text-generator,product-excerpt-generator,product-tag-suggester}.ts` (4 new)
- `apps/api/src/lib/inngest/functions/bulk-ai-{categorize,image-alt,excerpt,tags}.ts` (4 new)
- `apps/admin/src/app/stores/[id]/ai-tools/page.tsx` + `_components/AiSweepResultsPanels.tsx` (4 cards + panels) + i18n
- `tests/unit/` per generator + route; docs (`ROADMAP`/AI feature catalogue) in the same PR (documentation-parity)

## Testing

Unit: each generator (mock Gemini) + each route (job created + event sent). Follow existing `bulk-ai` test patterns. `npm run typecheck` + `lint` + unit green before PR. CI runs the full gate.

## Rollout

Single PR (or FAQ-fix first, then the 4 new sweeps) → CI → merge. All sweeps default-invisible unless the store has `bulk_operations` (existing gate). No storefront visual change; category is the only storefront-visible effect and is gap-fill only.
