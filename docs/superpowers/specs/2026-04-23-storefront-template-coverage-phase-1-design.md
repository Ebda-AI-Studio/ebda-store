# Storefront Template Coverage — Phase 1 Design

**Date:** 2026-04-23
**Status:** approved, implementing
**Phase of:** 3 (Phase 2 = expand template contract; Phase 3 = admin surface audit)

## Problem

The storefront has 5 template packs (`modern, classic, elegant, bold, minimal`) under `apps/web/src/templates/*`. Each pack ships its own `Header, Footer, AnnouncementBar, Hero, ProductCard, ProductGrid, CategoryCard, CategoryGrid`.

**Only the home page (`app/page.tsx`) uses them.** Every other page imports the generic `components/Header.tsx` + `components/Footer.tsx` and renders its own (non-template) product/category markup. So when a tenant picks "Elegant" in admin, only the landing page looks Elegant — `/products`, `/cart`, `/checkout`, etc. stay generic. The storefront feels disconnected.

14 hardcoded color instances remain that ignore `store.theme` CSS variables.

## Goal for Phase 1

Make every non-auth, non-checkout page use the selected template's chrome + cards. Auth + checkout keep minimal chrome but pull colors/fonts/logo from `store.theme` (no hardcoded).

Success criteria:

- Flipping `store.template` in admin visibly changes every page (not just `/`).
- Zero imports of generic `components/Header.tsx` / `components/Footer.tsx` remain.
- No hardcoded `bg-(orange|red|green|blue|yellow|purple)-N` in storefront source.
- First paint on server-rendered pages includes template chrome (no post-hydration flash).

## Architecture

### Route groups

Split `app/` into two route groups (Next.js route groups don't affect URLs):

```
app/
├── layout.tsx                 # root (unchanged): providers, theme CSS vars, <html>
├── (shop)/                    # full template chrome
│   ├── layout.tsx             # server: <AnnouncementBar><Header><main>{children}</main><Footer>
│   └── ...(18 pages moved in)
└── (minimal)/                 # minimal chrome — logo only, no nav, no footer
    ├── layout.tsx
    └── ...(auth + checkout + shared-wishlist moved in)
```

### Server-side template loader

`useTemplateComponents` (client-only, setState-on-mount) causes a blank-chrome flash. Replace with a server-only loader for layouts:

```ts
// apps/web/src/templates/server.ts
export async function getServerTemplate(id: TemplateId): Promise<TemplateComponents> {
  switch (id) {
    case 'modern':  return (await import('./modern')).default; // re-export bundle
    case 'classic': return (await import('./classic')).default;
    ...
  }
}
```

Each template's `index.ts` exports a default object with all 8 components. Dynamic imports in RSC are SSR-capable and still code-split.

The client `useTemplateComponents` stays for interactive subtrees that truly need client-side template resolution. Nothing on the critical path uses it after Phase 1.

### Header variant prop

Each template's `Header` gains:

```ts
interface HeaderProps {
  branding: StoreBranding;
  navItems?: NavItem[];
  variant?: 'full' | 'minimal'; // default 'full'
  children?: ReactNode; // slot for 'minimal' extras like "Secure Checkout"
}
```

`(minimal)/layout.tsx` passes `variant="minimal"`. Implementation per template: when `minimal`, render only the logo (and any `children` slot); no nav, no search, no cart icon.

### Adapter module

Extract the home page's existing inline adapters into a reusable module:

```ts
// apps/web/src/templates/adapters.ts
export function toTemplateProduct(p: Product): TemplateProduct { ... }
export function toTemplateCategory(c: Category): TemplateCategory { ... }
export function toStoreBranding(s: StoreData): StoreBranding { ... }
```

Every surface that today renders a custom `ProductCard` or `CategoryCard` will map to `TemplateProduct`/`TemplateCategory` via these and render `T.ProductCard` / `T.ProductGrid` / `T.CategoryCard` / `T.CategoryGrid`.

## Surfaces migrated in Phase 1

### Chrome swap (shop group)

All 18 pages that currently use `components/Header.tsx` + `components/Footer.tsx`:
`/about, /account/*, /affiliate, /cart, /categories, /compare, /contact, /faq, /privacy, /products, /products/[slug], /returns, /search, /shipping, /terms, /wishlist`.

After the move, pages no longer import Header/Footer — the `(shop)/layout.tsx` provides it.

### Chrome swap (minimal group)

`/auth/*` (login, register, forgot-password, reset-password, verify-email), `/checkout` + `/checkout/success` + `/checkout/error`, `/wishlist/shared/[userId]`.

Their existing inline "logo + Secure Checkout" chrome is replaced with `<T.Header variant="minimal">`.

### Product/category card swaps

| File                                                  | Currently                               | After                                      |
| ----------------------------------------------------- | --------------------------------------- | ------------------------------------------ |
| `app/products/ProductsClient.tsx`                     | custom `ProductGridCard`                | `T.ProductGrid` + `T.ProductCard`          |
| `app/products/ProductGridCard.tsx`                    | custom                                  | **deleted**                                |
| `app/products/loading.tsx`                            | custom skeleton                         | template-agnostic skeleton (stays)         |
| `app/products/[slug]/ProductDetailClient.tsx` related | inline or `components/YouMightAlsoLike` | `T.ProductGrid`                            |
| `app/cart/CartClient.tsx` recommendations             | `components/CartRecommendations`        | refactor to use `T.ProductCard` internally |
| `app/compare/CompareClient.tsx`                       | custom card markup                      | `T.ProductCard`                            |
| `app/search/SearchClient.tsx`                         | custom                                  | `T.ProductGrid`                            |
| `app/wishlist/WishlistClient.tsx`                     | custom                                  | `T.ProductCard`                            |
| `app/categories/CategoriesClient.tsx`                 | custom                                  | `T.CategoryGrid` + `T.CategoryCard`        |

### Deletions (Phase 1.5)

After all migrations compile and pass lint:

- `apps/web/src/components/Header.tsx`
- `apps/web/src/components/Footer.tsx`
- `apps/web/src/app/products/ProductGridCard.tsx`

Keep `components/YouMightAlsoLike.tsx` / `components/CartRecommendations.tsx` — they own data-fetching logic; internals swap to `T.ProductCard`.

### Token sweep (Phase 1.6)

14 instances of `bg-(orange|red|green|blue|yellow|purple)-\d+` in storefront source → design tokens (`bg-primary`, `bg-destructive`, `bg-success`, `bg-info`, etc.). Add an eslint rule:

```js
// .eslintrc addition
'no-restricted-syntax': [
  'warn',
  {
    selector: 'Literal[value=/(bg|text|border)-(orange|red|green|blue|yellow|purple)-\\d+/]',
    message: 'Use design tokens (bg-primary / bg-destructive / etc.) instead of hardcoded Tailwind colors.',
  },
],
```

## Out of scope for Phase 1

- Adding new template surfaces beyond the current 8 (CartTable, OrderSummary per template, etc.) — that's Phase 2.
- New admin knobs (per-template hero alignment, card radius, font pairing selector) — Phase 3.
- Per-template checkout/auth body styling (we only template the chrome this phase).
- A11y / responsive polish beyond what templates already ship.

## Risks

1. **Prop shape drift** — custom cards pass properties template cards don't accept. Audit each swap; extend the template's ProductCard contract if a property is universal and valuable (e.g., `onQuickAdd`); drop the property otherwise.
2. **Template parity** — one template's ProductCard may not render `compareAtPrice` / `rating`. Noted in Section F; fixes go into Phase 2 with an explicit "template contract parity" task.
3. **First-paint flash on existing home** — home still uses the client-only hook. Migrate home to the new `(shop)/layout.tsx` at the end of Phase 1.3 so it benefits too.
4. **Route group moves = 30+ git renames** — use `git mv` so blame is preserved.

## Verification

- `npx tsc --noEmit` clean on `apps/web`.
- `npx eslint src/` clean (or warnings only on the new rule, fixed inline).
- `grep -r "components/Header\|components/Footer\|components/YouMightAlsoLike.*tsx\|ProductGridCard" src/app` returns zero unexpected hits.
- Manual preview: flip `store.template` to each of the 5 values via admin and navigate to `/`, `/products`, `/products/[any]`, `/cart`, `/checkout`, `/account`, `/compare`. Every chrome + card reflects the template.

## Out-of-session verification required

I cannot run the dev server + browser-test 5 templates × 31 pages. User must preview-deploy and spot-check before merging to prod.
