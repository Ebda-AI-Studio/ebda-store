# Remaining Refactors — Master Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan phase-by-phase. Each phase is independently shippable. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining 6 items that were marked intentionally out-of-scope across previous sessions — ship each as its own shippable unit, not as a monolithic big-bang.

**Architecture:** Six sequential phases. Each phase produces working, testable, deployable software on its own. No phase depends on a later phase. Approve each phase before starting it.

**Tech Stack:** TypeScript, Next.js 16 App Router (apps/admin + apps/web), Express (apps/api), Prisma + Neon Postgres, Tailwind CSS, tsx / tsc, eslint.

---

## Ordering rationale

Ordered by **(risk × size) ÷ user value** so quick wins land first, multi-week features go last:

| #   | Phase                                  | User value                                     | Effort         | Risk                         | Files touched                                    |
| --- | -------------------------------------- | ---------------------------------------------- | -------------- | ---------------------------- | ------------------------------------------------ |
| 1   | **globals.css `@apply` cleanup**       | Low                                            | S (1h)         | Low                          | 2 files, 110 rules                               |
| 2   | **Admin `fetchStore` consolidation**   | Low                                            | M (3h)         | Low-Med                      | ~8 pages + 1 new hook                            |
| 3   | **`isRtl` → `useIsRtl()` context**     | Low (dev quality)                              | M (4h)         | **High** (visual regression) | 45 template files                                |
| 4   | **Admin page extraction (>500 lines)** | Low (dev quality)                              | L (1–2 days)   | Med                          | 17 pages                                         |
| 5   | **New template surfaces**              | Med (templates feel more bespoke)              | L+ (2–3 days)  | Med                          | 5 templates × 5 new surfaces = 25 new components |
| 6   | **Admin i18n**                         | High (RTL-native stores can't use admin today) | XL (1–2 weeks) | Med                          | ~80 admin files + new i18n infra                 |

**Approve Phases 1–3 first** (they're quick and mechanical). Phases 4–6 are big enough to deserve their own brainstorming+spec session each; treat the scoping here as preliminary.

---

## Phase 1 — `globals.css` `@apply` rule cleanup

**Goal:** Migrate the 110 remaining hardcoded semantic colors inside `@apply` rules (admin: 45, web: 65) to the token classes (`bg-success`, `bg-destructive`, `text-info`, etc.) added in commit `936ee29`. Closes the last 41 admin eslint warnings without shifting the visual meaning of any utility class.

**Why it was deferred:** Touching utility-class CSS rules can subtly shift anything that uses them. Needed a stable-baseline session.

### Files

- Modify: `apps/admin/src/styles/globals.css` (45 rules)
- Modify: `apps/web/src/styles/globals.css` (65 rules)

### Approach

- [ ] **Step 1: Snapshot current `@apply` usage**
  - Run: `grep -n "@apply" apps/admin/src/styles/globals.css apps/web/src/styles/globals.css > /tmp/apply-before.txt`
  - Expected: 110 lines listing every `@apply` rule with line number.

- [ ] **Step 2: Classify each rule by semantic intent**
  - For each `@apply` rule, write the intent next to it in a scratch list:
    - `bg-red-100 text-red-600` → destructive
    - `bg-green-100 text-green-800` → success
    - `bg-blue-100 text-blue-800` → info
    - `bg-yellow-100 text-yellow-800` → warning
    - `bg-purple-100 text-purple-800` → info (shipped convention)

- [ ] **Step 3: Run the same substitution script used in `936ee29`**
  - Apply the perl substitutions from commit `936ee29` to the two CSS files directly.
  - Extra care: `@apply` strings sit inside `{…}` blocks, so the regex boundary conditions are slightly different from TSX class attributes. Grep each file for any residual `bg-(red|green|blue|yellow|purple)-\d+` after the pass.

- [ ] **Step 4: Verify visual integrity via a CSS diff**
  - Run: `git diff --stat apps/admin/src/styles/globals.css apps/web/src/styles/globals.css`
  - Expected: two files changed, only color tokens altered.
  - Run: `grep -c "bg-\(red\|green\|blue\|yellow\|purple\)-[0-9]" apps/admin/src/styles/globals.css apps/web/src/styles/globals.css`
  - Expected: both return 0.

- [ ] **Step 5: Typecheck + lint**
  - Run: `cd apps/admin && npx tsc --noEmit && npx eslint src/ 2>&1 | tail -3`
  - Expected: tsc clean, eslint warning count drops from 42 to ≤ 1.
  - Run: `cd apps/web && npx tsc --noEmit && npx eslint src/ 2>&1 | tail -3`

- [ ] **Step 6: Commit**

  ```bash
  git add apps/admin/src/styles/globals.css apps/web/src/styles/globals.css
  git commit -m "refactor(css): migrate @apply rules in globals.css to semantic tokens

  closes the last 41 admin eslint warnings from the phase 1.6 token
  rule. utility classes (.badge-error, .status-shipped, etc.) keep
  their visual meaning — just rerouted through the theme tokens
  introduced in 936ee29, so they now re-color when a tenant flips
  their theme."
  ```

### Verification

- No page should look different in preview — these are utility classes, not specific components.
- Browser spot-check: admin orders list (status badges), admin loyalty page (tier chips), storefront account page (order-status pills).
- **Rollback criterion:** if any page's status badge looks washed-out or invisible in dark mode, revert. The semantic CSS vars might produce insufficient contrast for some shades.

### Risk

**Low.** Pure CSS token rename. Typecheck doesn't help here since CSS isn't type-checked — browser verification is the only real gate.

---

## Phase 2 — Admin `fetchStore` consolidation

**Goal:** Replace the 8 independent `apiGet('/api/v1/stores/${storeId}')` calls scattered across admin pages with a shared `useCurrentStore()` hook. Eliminates duplicated fetch logic, cuts API traffic on navigation, and gives Phase 4 a cleaner per-page surface to refactor.

### Files

- Create: `apps/admin/src/hooks/useCurrentStore.ts`
- Modify: 8 admin pages (`stores/[id]/{page,navigation,tax,loyalty,coupons,marketing-pixels,inventory,affiliates,hero}/page.tsx`)

### Approach

- [ ] **Step 1: Write a failing test for the hook**

  ```ts
  // apps/admin/src/hooks/__tests__/useCurrentStore.test.tsx
  import { renderHook, waitFor } from '@testing-library/react';
  import { useCurrentStore } from '../useCurrentStore';

  // Mock the apiGet
  vi.mock('@/lib/api', () => ({
    apiGet: vi.fn().mockResolvedValue({
      data: { store: { id: 'abc', name: 'Test Store' } },
      error: null,
    }),
  }));

  test('fetches + caches store by id', async () => {
    const { result } = renderHook(() => useCurrentStore('abc'));
    await waitFor(() => expect(result.current.store).not.toBeNull());
    expect(result.current.store?.name).toBe('Test Store');
    expect(result.current.isLoading).toBe(false);
  });

  test('dedupes concurrent calls for same storeId', async () => {
    const { apiGet } = await import('@/lib/api');
    renderHook(() => useCurrentStore('abc'));
    renderHook(() => useCurrentStore('abc'));
    expect((apiGet as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
  ```

- [ ] **Step 2: Run test, confirm fail**
  - Run: `cd apps/admin && npx vitest run src/hooks/__tests__/useCurrentStore.test.tsx`
  - Expected: FAIL — `useCurrentStore` not defined.

- [ ] **Step 3: Implement the hook**

  ```ts
  // apps/admin/src/hooks/useCurrentStore.ts
  'use client';
  import { useEffect, useState } from 'react';
  import { apiGet } from '@/lib/api';

  export interface Store {
    id: string;
    name: string;
    nameAr?: string;
    slug: string;
    logo?: string;
    theme?: Record<string, unknown>;
    settings?: Record<string, unknown>;
    // (superset of all fields any caller currently uses — add as needed)
  }

  // Simple in-memory dedupe: one in-flight promise per storeId.
  const inFlight = new Map<string, Promise<Store | null>>();
  const cache = new Map<string, Store>();

  export function useCurrentStore(storeId: string) {
    const [store, setStore] = useState<Store | null>(() => cache.get(storeId) ?? null);
    const [isLoading, setIsLoading] = useState(() => !cache.has(storeId));
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
      if (!storeId) return;
      if (cache.has(storeId)) {
        setStore(cache.get(storeId)!);
        setIsLoading(false);
        return;
      }

      let cancelled = false;
      const existing = inFlight.get(storeId);
      const promise =
        existing ??
        apiGet<{ store: Store }>(`/api/v1/stores/${storeId}`).then(res => {
          if (res.error || !res.data?.store) return null;
          cache.set(storeId, res.data.store);
          return res.data.store;
        });
      if (!existing) inFlight.set(storeId, promise);

      promise
        .then(s => {
          if (cancelled) return;
          if (s) setStore(s);
          else setError(new Error('store not found'));
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false);
          inFlight.delete(storeId);
        });

      return () => {
        cancelled = true;
      };
    }, [storeId]);

    const refetch = async () => {
      cache.delete(storeId);
      inFlight.delete(storeId);
      setIsLoading(true);
      // Re-runs the effect via state change? No — effect depends only on storeId.
      // Manually re-fetch:
      const res = await apiGet<{ store: Store }>(`/api/v1/stores/${storeId}`);
      if (!res.error && res.data?.store) {
        cache.set(storeId, res.data.store);
        setStore(res.data.store);
      }
      setIsLoading(false);
    };

    return { store, isLoading, error, refetch };
  }
  ```

- [ ] **Step 4: Tests pass**
  - Run: `npx vitest run src/hooks/__tests__/useCurrentStore.test.tsx`
  - Expected: PASS.

- [ ] **Step 5: Migrate each consumer page (8 edits)**
  - For each of `stores/[id]/page.tsx`, `navigation/page.tsx`, `tax/page.tsx`, `loyalty/page.tsx`, `coupons/page.tsx`, `marketing-pixels/page.tsx`, `inventory/page.tsx`, `affiliates/page.tsx`, `hero/page.tsx`:
    - Replace `useState<Store | null>` + `useEffect(() => { apiGet(...) }, [storeId])` block with `const { store, isLoading } = useCurrentStore(storeId);`
    - Remove now-unused imports.

- [ ] **Step 6: Typecheck**
  - Run: `cd apps/admin && npx tsc --noEmit`
  - Expected: clean.

- [ ] **Step 7: Commit**

  ```bash
  git add apps/admin/src/hooks/useCurrentStore.ts \
          apps/admin/src/hooks/__tests__/useCurrentStore.test.tsx \
          apps/admin/src/app/stores/[id]/
  git commit -m "refactor(admin): consolidate per-page store fetches behind useCurrentStore"
  ```

### Risk

- **`branding/page.tsx` is the outlier** — it uses 5 parallel endpoint writes (`/branding`, `/theme`, `/contact`, `/social`). Keep its bespoke save flow; only the initial fetch moves to the hook.
- **No automated preview** — relies on engineer clicking through each of the 8 admin pages to confirm data still renders.

---

## Phase 3 — `isRtl` → `useIsRtl()` context

**Goal:** Stop drilling the `isRtl` prop through 45 template files. Every component that needs RTL info should read it from a single context hook — matching how `useStore()`, `useLanguage()`, `useCart()` already work.

**Why it was deferred:** Every template has its own visual language. Changing RTL wiring mid-session without per-template visual regression testing is how you ship broken Bold-template Arabic stores.

### Files

- Create: `apps/web/src/hooks/useIsRtl.ts` (or extend `LanguageContext` — see Step 1)
- Modify: 45 files in `apps/web/src/templates/**/*.tsx` + `apps/web/src/templates/types.ts`
- Modify: `apps/web/src/components/ShopChrome.tsx`, `MinimalChrome.tsx`, and any other caller passing `isRtl` as a prop

### Approach

- [ ] **Step 1: Decide — new hook or extend `useLanguage()`**
  - `LanguageContext` already exposes `{ language, t }`. Derive `isRtl` from `language === 'ar'` and export as part of the same context.
  - **Decision: extend `useLanguage()`**. Avoids a second context for the same source of truth.

- [ ] **Step 2: Add `isRtl` to `LanguageContext`**
  - Modify `apps/web/src/contexts/LanguageContext.tsx`:

  ```ts
  // inside the provider's value object, add:
  isRtl: language === 'ar',
  ```

  ```ts
  // update the context type:
  interface LanguageContextValue {
    language: 'en' | 'ar';
    isRtl: boolean;
    t: (en: string, ar: string) => string;
  }
  ```

- [ ] **Step 3: Make `isRtl` OPTIONAL in the template contract**
  - `apps/web/src/templates/types.ts`: confirm `isRtl?: boolean` (it already is on every Props interface).
  - Each template component should **read `useLanguage().isRtl` when the prop is not passed** — fallback behavior lets us migrate callers one at a time without breaking the props API.

- [ ] **Step 4: Migrate per template (5 packs × ~9 files each)**
  - For each of `modern`, `classic`, `elegant`, `bold`, `minimal`:
    - For each `*.tsx` file in the template:
      - Replace `isRtl = false,` in props destructure with a top-of-body derivation:
        ```ts
        const { isRtl: ctxIsRtl } = useLanguage();
        const isRtl = props.isRtl ?? ctxIsRtl;
        ```
      - **Important:** don't break prop overrides — some callers may still pass `isRtl={false}` deliberately (e.g., testing). The `??` preserves that.
    - Typecheck the template after each pack: `cd apps/web && npx tsc --noEmit`

- [ ] **Step 5: Remove `isRtl` from call sites that were drilling it**
  - `ShopChrome.tsx`, `MinimalChrome.tsx`, `ProductDetailClient.tsx`, each product-grid consumer — remove the `isRtl={isRtl}` prop from template component invocations. Templates now read it from context.
  - Keep `isRtl` as an optional prop on the component API — outside callers (docs, tests) can still pass it.

- [ ] **Step 6: Per-template visual regression gate**
  - Start the web dev server: `npm run dev:web`
  - For each template (flip `store.template` in DB or via admin):
    - Visit `/`, `/products`, `/products/[any]`, `/cart`, `/checkout` with `?lang=ar`
    - Confirm RTL layout renders correctly
    - Confirm no console errors
  - **Do not skip this.** Without it, you'll ship broken Arabic for at least one template.

- [ ] **Step 7: Commit per template pack**
  - `git commit -m "refactor(web/templates/modern): read isRtl from useLanguage context"`
  - One commit per pack = atomic rollback if one template breaks.

### Risk

**High.** Per-template visual regression. Mitigate with:

- One template pack per commit (atomic rollback).
- Mandatory browser check at `?lang=ar` before committing each pack.
- Keep `isRtl` as an optional prop so any escape-hatch caller (tests, Storybook) still works.

---

## Phase 4 — Admin page extraction (>500 lines)

**Goal:** Break up the 17 admin pages over 500 lines into feature-scoped subcomponents so each file has one clear responsibility. Improves reviewability + enables incremental work on big pages without having to re-read 800 lines.

### Files (priority-ordered)

Top 5 offenders (biggest wins):

| Lines | File                                     |
| ----- | ---------------------------------------- |
| 951   | `stores/[id]/shipping-carriers/page.tsx` |
| 927   | `stores/[id]/notifications/page.tsx`     |
| 829   | `stores/[id]/loyalty/page.tsx`           |
| 796   | `stores/[id]/tax/page.tsx`               |
| 788   | `stores/[id]/inventory/page.tsx`         |

Remaining 12 pages (all 500–760 lines): `pwa`, `coupons`, `branding`, `affiliates`, `bulk`, `shipping`, `analytics`, `abandoned-carts`, `products`, `orders`, `returns`, `marketing-pixels`.

### Approach (per page)

- [ ] **Step 1: Read the page and inventory logical blocks**
  - Each big page usually has 3–6 logical sections: header/stats, a filter bar, a table, a detail modal, a settings form. Write them down.

- [ ] **Step 2: Extract one subcomponent at a time**
  - `stores/[id]/loyalty/components/LoyaltySettingsPanel.tsx` — settings form, ~150 lines.
  - `stores/[id]/loyalty/components/LoyaltyMembersTable.tsx` — members table, ~200 lines.
  - Keep props explicit — don't thread 20 props when a typed data object + 2 handlers will do.

- [ ] **Step 3: After each extraction, typecheck + visual check**
  - Run: `cd apps/admin && npx tsc --noEmit`
  - Open the page in dev, confirm still works.

- [ ] **Step 4: Commit each page separately**
  - One commit per page = one atomic unit of review.

### Risk

**Medium.** Mechanical, but touching many files means chances for typos. Per-page commits make rollback surgical.

### Scoping note

**Do not force this to happen all in one PR.** Ship one big page per commit; the 17-page queue becomes 17 small reviewable diffs over a week of background work.

---

## Phase 5 — New template surfaces (`CartTable`, `OrderSummary`, `FormCard`, `EmptyState`)

**Goal:** Extend the 8-surface template contract to include 4 new surfaces so cart/checkout/auth/empty-states _also_ take on the tenant's chosen template aesthetic, not just chrome + cards.

**Why it was deferred:** Each new surface = 5× template implementations with coherent per-template design decisions. Each one is ~1–2 days of work. Total 4–8 days.

### Files

- Modify: `apps/web/src/templates/types.ts` (extend `TemplateComponents` with 4 new optional components)
- Create: `apps/web/src/templates/{modern,classic,elegant,bold,minimal}/{CartTable,OrderSummary,FormCard,EmptyState}.tsx` — **20 new files**
- Modify: `apps/web/src/app/cart/CartClient.tsx`, `checkout/CheckoutClient.tsx`, auth pages (consume the new surfaces)

### Approach

- [ ] **Step 1: Spec the data model for each surface**
  - `CartTable`: rows of cart items with quantity controls + totals panel.
  - `OrderSummary`: subtotal + discount + shipping + tax + total, with optional coupon input slot.
  - `FormCard`: standardized auth-style card wrapper with title + optional footer link.
  - `EmptyState`: title + description + CTA button + optional icon.
  - Write explicit TypeScript `Props` interfaces in `templates/types.ts`.

- [ ] **Step 2: Modern template first (the design baseline)**
  - Implement all 4 new components in `templates/modern/`.
  - Migrate `CartClient` to use `T.CartTable`, `CheckoutClient` to use `T.OrderSummary`, `LoginClient` to use `T.FormCard`.
  - **Gate:** tsc clean + browser spot-check on Modern template.

- [ ] **Step 3: Each remaining template pack (classic → elegant → bold → minimal)**
  - Per pack: implement all 4 surfaces with that template's aesthetic.
  - After each pack: browser preview the migrated consumers on that template.

- [ ] **Step 4: `useTemplateComponents` returns the new surfaces**
  - Each `templates/*/index.ts` exports the 4 new components.
  - The dynamic loader in `templates/index.ts` adds them to the `TemplateComponents` type + every template's export object.

- [ ] **Step 5: Commit per pack**
  - 5 commits, one per template. Atomic rollback if one looks off.

### Risk

**Medium, slow to verify.** Requires browsing every template × every consuming page. Budget 2–3 days minimum.

### Scoping note

**Consider deferring `FormCard` and `EmptyState`.** They're the lowest-value surfaces (auth pages are already minimal, empty states are rarely seen). Phase 5a (CartTable + OrderSummary only) is ~60% of the value for 50% of the effort.

---

## Phase 6 — Admin i18n

**Goal:** Admin app supports English + Arabic, matching the storefront. Today store owners speaking Arabic natively can't navigate the admin tooling.

**Why it was deferred:** Multi-week feature. Needs its own scoping session + product-design input on which Arabic terms to use for commerce concepts (e.g., "Storefront" / "Loyalty Tier" / "Abandoned Cart").

### Files (estimate)

- Create: `apps/admin/src/i18n/` directory with locale files + provider
- Modify: ~80 admin TSX files (every user-facing string wrapped in `t()`)
- Create: `apps/admin/src/components/LanguageSwitcher.tsx`
- Modify: Admin header/sidebar components to show the language switcher

### High-level approach

- [ ] **Step 1: Pick an i18n library**
  - Recommendation: **`next-intl`** (Next.js-native, Arabic RTL support built in). Rejected alternatives: `i18next` (more boilerplate), custom `t()` wrapper (not scalable).

- [ ] **Step 2: Set up `next-intl` infrastructure**
  - Install: `npm install next-intl --workspace apps/admin`
  - Create `messages/en.json` + `messages/ar.json` (empty objects initially)
  - Wrap admin root layout in `NextIntlClientProvider`
  - Add middleware for locale routing (`/en/stores/…`, `/ar/stores/…`) or cookie-based locale

- [ ] **Step 3: Extract strings page-by-page**
  - For each admin page/component, replace `"Dashboard"` etc. with `t('dashboard.title')`
  - Add the string to both locale files in parallel
  - **Critical:** don't translate yet — use English in both `en.json` and `ar.json` as placeholder. Real Arabic translations happen in Step 5.

- [ ] **Step 4: Ship infrastructure without translations**
  - Commit + deploy with English-only locale files.
  - Verifies the rewiring didn't break any UI.

- [ ] **Step 5: Arabic translations**
  - Hire a translator or use a review service.
  - Update `messages/ar.json` with real translations.
  - Enable the language switcher.
  - **Scoping call: who is the product-design authority on Arabic terminology?** Don't guess at banking/commerce terms.

- [ ] **Step 6: RTL layout pass**
  - Swap all `ml-*` → `ms-*` (logical properties), `mr-*` → `me-*`, `left-*` → `start-*`, etc.
  - Add `dir={isRtl ? 'rtl' : 'ltr'}` to the root admin layout.
  - Visual regression on every admin page in Arabic mode.

### Risk

**Medium technically, high in scope.** RTL layout bugs are easy to ship and hard to catch without browser review. Arabic translation quality requires a native speaker reviewer.

### Scoping note

**This should be its own brainstorming + spec session.** This phase outline is a placeholder to sequence it after the others, not a substitute for a real design doc. Before starting, answer:

- Who owns the Arabic translations (in-house vs. contracted)?
- Cookie-based locale or URL-prefix routing?
- Do we need per-tenant admin language (owner chooses) or per-user (admin logs in with their preferred language)?

---

## Cross-cutting verification

After every phase:

- [ ] `tsc --noEmit` clean on every affected app.
- [ ] `eslint` no new errors.
- [ ] Commit message includes explicit verification line + browser-check reminder where applicable.
- [ ] Push to `origin/main`.
- [ ] Update `MEMORY.md` project.md with the new commit SHA + architectural note.

## Execution preference

**Recommend: phase-by-phase, approve-before-start.**

Do **not** run all 6 phases back-to-back without approval checkpoints. Each phase has its own risk profile and deserves a fresh eye before the next one starts.

**Likely realistic calendar:**

- Phase 1 (CSS @apply): 1 hour, same session.
- Phase 2 (fetchStore): 3 hours, same day.
- Phase 3 (isRtl): half-day with browser regression gate.
- Phase 4 (page extraction): 1-2 days, can run incrementally.
- Phase 5 (template surfaces): 2-3 days.
- Phase 6 (admin i18n): its own 1-2 week project with its own spec.
