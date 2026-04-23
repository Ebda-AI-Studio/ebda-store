# Phase 2 — Template Contract Extension + Remaining Card Swaps

**Date:** 2026-04-23
**Status:** approved (user said "accept all changes"), implementing
**Phase of:** 3 (Phase 1 shipped in `00d0c6d`, `b47ca5c`; Phase 3 = admin surface audit)

## Scope (tight)

Close the remaining Phase 1 deferrals:

- `/products` listing still uses the custom `ProductGridCard` because the compare-toggle isn't in the template contract.
- `/wishlist` still renders custom cards because each item needs a remove action.
- `/compare` still renders custom cards because each item needs a remove-from-compare action.

Extending `ProductCardProps` (and `ProductGridProps`) with a few **optional** action callbacks closes all three in one go. When a prop is provided, every template's ProductCard renders a small corresponding button; when omitted, nothing is added.

## Out of scope

- New template surfaces (`CartTable`, `OrderSummary`, `FormCard`, `EmptyState`, per-template `Button` variants). These need 5× implementations per surface and can wait until a real requirement forces them.
- `FrequentlyBoughtTogether` — has a bespoke upsell layout that doesn't map to a grid; defer indefinitely.
- The ~10 hardcoded-semantic-badge warnings from the Phase 1.6 eslint rule. Those encode real meaning (shipped / partial / cancelled) and a color swap would fight the visual language users already learned.

## Contract extension

`apps/web/src/templates/types.ts`:

```ts
export interface ProductCardProps {
  product: TemplateProduct;
  isRtl?: boolean;
  currency?: string;
  quantityInCart?: number;
  onAddToCart?: (productId: string) => Promise<void> | void;
  onAddToWishlist?: (productId: string) => void;

  // NEW (Phase 2): optional per-item actions. When provided, the template
  // renders the corresponding UI; when omitted, no button is shown.
  isInCompare?: boolean;
  onToggleCompare?: (productId: string) => void;
  onRemoveFromWishlist?: (productId: string) => void;

  urlPrefix?: string;
}
```

`ProductGridProps` gains the same three props and forwards them to each child card.

## Per-template UI addition

Every template's `ProductCard` picks up:

- **Compare toggle** — small pill/icon button top-left of the image. Filled state when `isInCompare`. Only renders if `onToggleCompare` is provided.
- **Wishlist remove** — X icon top-right. Only renders if `onRemoveFromWishlist` is provided, and _replaces_ the "add to wishlist" heart when present (a card on the wishlist page doesn't need both).

Each template stays visually distinctive (bold = hard geometric, elegant = thin outlines, etc.); the icons just use each template's own button language.

## Surfaces migrated

| File                               | From                     | To                                                                            |
| ---------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `app/products/ProductsClient.tsx`  | custom `ProductGridCard` | `T.ProductGrid` with `isInCompare` + `onToggleCompare`                        |
| `app/products/ProductGridCard.tsx` | custom                   | **deleted**                                                                   |
| `app/wishlist/WishlistClient.tsx`  | custom card markup       | `T.ProductCard` with `onRemoveFromWishlist` + `onAddToCart`                   |
| `app/compare/CompareClient.tsx`    | custom cards             | `T.ProductCard` with `onToggleCompare`; keep the specs-comparison table below |

## Verification

- `tsc --noEmit` clean.
- `eslint` no new errors.
- Each of 5 templates implements the optional action UI (visual spot-check needed per template).
- ProductsClient's compare-toggle functional end-to-end (click in list, visit `/compare`, item appears).
- Wishlist remove works on each template.
