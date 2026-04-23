# Final Push — Plan

**Goal:** Finish Phase 4 (more admin extractions), Phase 5 (OrderSummary + FormCard + EmptyState × 5 templates), Phase 6 (admin i18n scoping), and polish the UX in one session.

**Honest constraints:**

- Phase 6 (admin i18n) is genuinely a multi-week feature (translator sourcing, RTL audit across ~80 admin files). I'll scope it with a standalone design doc — not execute.
- Phase 4's remaining 15 admin pages don't have clean inline seams. I'll do opportunistic extractions only where components have duplicates across pages (like `Toggle` was).
- Polish pass = a11y + spacing + interaction audit on the **new template surfaces** and the cart/checkout flow using Web Interface Guidelines principles (focus states, min-44px tap targets, aria-labels on icon buttons, aria-live for status badges, semantic HTML, keyboard navigation, RTL parity).

**Execution order (ships per step = atomic rollback):**

### Step A — Phase 5.2: OrderSummary × 5 templates

Highest-value remaining surface. Appears on cart + checkout sidebars, so a tenant's chosen template now flavors the totals panel too.

- `templates/types.ts` → add `OrderSummaryProps` + `OrderSummary?: ComponentType` on `TemplateComponents`
- 5 × `templates/{pack}/OrderSummary.tsx` — row layout: subtotal, discount (if > 0), shipping (or "Free"), tax (if > 0), total, with a coupon input slot
- Each pack's `index.ts` + root loader updated
- `cart/CartClient.tsx` + `checkout/CheckoutClient.tsx` opt in via `T.OrderSummary ??` fallback
- Typecheck + commit

### Step B — Phase 5.3: EmptyState × 5 templates

- `templates/types.ts` → add `EmptyStateProps` (icon, title, description, ctaHref, ctaLabel) + optional component
- 5 × `templates/{pack}/EmptyState.tsx`
- Consumers: cart empty, wishlist empty, search no-results, orders empty
- Typecheck + commit

### Step C — Phase 5.4: FormCard × 5 templates

- Wraps auth + password-reset cards with template-appropriate chrome
- 5 × implementations
- Auth pages opt in via `T.FormCard ?? <div>` fallback
- Commit

### Step D — Phase 4 opportunistic extraction

Scan the remaining 15 admin pages for cross-page duplication (status badges, filter bars, empty states). Promote any duplicates to `apps/admin/src/components/`. Ship whatever turns up as shared. Don't force per-page splits that have no cross-page value.

### Step E — Polish pass (Web Interface Guidelines)

Audit the new template surfaces + cart/checkout for:

1. **Tap targets ≥ 44×44 px** on mobile (quantity +/- buttons, remove X).
2. **Keyboard nav** — all interactive elements reachable via Tab; focus ring visible.
3. **aria-labels** on every icon-only button; `role="status"` or `aria-live="polite"` on dynamic totals so screen readers announce updates.
4. **Semantic HTML** — cart rows are `<li>` inside `<ol>`, not `<div>` soup.
5. **RTL parity** — `dir`, `ms-*`/`me-*` logical props, verified via the same Chrome preview already used for Phase 3.
6. **Loading states** — skeleton parity with template aesthetic.
7. **Color contrast** ≥ 4.5:1 for body text, 3:1 for large text — spot-check via Chrome DevTools (or assume tokens hit this since they're already the product's palette).

Fix issues inline; commit the polish pass separately from the feature commits.

### Step F — Phase 6: spec only (no execution)

Write `docs/superpowers/specs/2026-04-23-admin-i18n-design.md` with:

- Scoping questions (translator, routing, per-tenant vs per-user)
- Recommended library (`next-intl`)
- Migration order (ship infra → wrap strings → translate → RTL sweep)
- Risk + effort estimate

This doc + the master plan doc are enough for someone else (or a future session) to execute Phase 6 without re-scoping.

**Verification:** `tsc --noEmit` clean; `eslint` 0 new errors; Chrome quick-check on the deployed storefront after each feature commit.

**Commit cadence:** one commit per step (A, B, C, D, E, F) = 6 commits max. Smaller if a step produces nothing useful.
