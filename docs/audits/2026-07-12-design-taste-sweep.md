# Design-taste sweep — all 5 templates + shared (2026-07-12)

Rubrics: emil-design-eng, apple-design, impeccable, design-taste-frontend, high-end-visual-design, gpt-taste, improve-animations (installed skill packs). Compact sizing per `design.md` treated as ground truth. Read-only audit.

**Headline: the craft is built but unwired.** The `[data-cta]` press/hover system (`globals.css:892-942`), `--transition-*` tokens, `.shimmer` skeleton, and `.stagger-animation` utilities all exist — and 4 of 5 themes consume none of them.

## Per-template verdicts

- **modern — 7/10** (closest to shipping-grade). Gaps: `AnnouncementBar.tsx:67` references a `marquee` keyframe that doesn't exist (dead motion); SectionHeading hairlines default ON against modern's documented "no hairlines"; ProductCard radius/shadow drift vs pack tokens (`ProductCard.tsx:212` vs `pack-styles.ts:54`).
- **elegant — 5/10** (biggest talk/behave gap). `ProductGrid.tsx:39-44` bypasses SectionHeading on its flagship section; documented border-t whisper CTAs + `tracking-[0.22em]` + `ease-in-out` appear nowhere; durations scattered 300/500/700ms.
- **classic — 5/10** (two documented signatures never built): circular category tiles (`CategoryCard.tsx:30-31`; helper already exists in `card-size.ts:104-105`) and border-y-only CTAs (`Hero.tsx:80` etc.); hovers still zoom (`scale-[1.04] ease-out`) on the documented "color-shift-only" theme; serif holes in cart controls.
- **minimal — 6/10** (drifting toward elegant): durations crept 200-300→500-700ms; announcement bar not inverted per spec (`AnnouncementBar.tsx:28`); `hover:text-primary` inconsistently replaced with `foreground/60`; missing focus-visible on ProductCard/Header (CategoryCard.tsx:33 is the correct pattern).
- **bold — 6/10** (right idea, borrowed softness): **hover translate inverted vs its own offset shadow** (`ProductCard.tsx:148` — one-character fix); CategoryCard borrows elegant's soft 700ms language; footer not inverted; literal `→` breaks RTL at 5 sites (Hero.tsx:101 has the correct SVG+rotate pattern).

## Cross-cutting top 10 (by user-perceived impact)

1. `data-cta` adoption: ~20 CTAs across 4 themes have zero press feedback while the system sits built in globals.css.
2. Touch targets 36-40px on wishlist heart/quick-add/share (`PecannbeeProductCard.tsx:238`, `ProductCarousel.tsx:481`, `ShareProductRow.tsx:83,94`) → `h-11 w-11` (carousel arrows already correct).
3. No `:active` on the highest-frequency micro-interactions → `active:scale-95` (FloatingWidget.tsx:435 is the exemplar).
4. `--transition-*` tokens consumed by nothing → promote a real duration/easing scale through pack-styles (root cause of all per-theme pacing drift).
5. `transition-all` on ~30 hot elements → name the properties.
6. `.shimmer` + `.stagger-animation` unused → wire to grids/carousels/image wrappers (all product render paths).
7. Nested-card chrome when `showCardFrame` on (`ProductCarousel.tsx:345+356`, `CategoryStrip.tsx:107+120`).
8. No `prefers-reduced-transparency` fallback for any backdrop-blur → one global rule.
9. Mobile menus mount with no enter/exit (3 themes fully bare) → shared 200-250ms pattern.
10. Hardcoded raw colors (`ProductCardCta.tsx:283`, rgba reds ×2) + 3 different focus-ring treatments → tokens + `ring-offset-2`.

## Quick wins (≤1h each)

bold translate sign flip · data-cta sweep · touch-target sweep · active:scale-95 ×2 · reduced-transparency rule · modern marquee (add keyframe or delete branch) · minimal hover:text-primary ×2 · destructive-token swap ×3 + ring standardization · bold RTL arrows ×5 · cart-stepper transitions ×3 themes.

## Structural (plan-mode)

Duration/easing token system through pack-styles · per-theme persona-completion pass (needs Ahmad sign-off — changes merchant-visible chrome) · skeleton+stagger wiring · showCardFrame chrome suppression · shared mobile-menu transition · transition-all class sweep.

## Already good — do NOT "fix" away

The `[data-cta]` system itself · layered reduced-motion coverage (global + motion-safe + JS autoplay checks) · genuinely excellent RTL discipline (mirrored badges/drawers/swipe, logical properties) · `tabular-nums` prices · `md:hover:` scoping on cards · sane z-index scale · null-returning empty states · bold's scale-x nav underline + interruptible badge pulse · elegant hero's optical tracking · modern's interruptible image crossfade.

---

## BINDING CONSTRAINT — live client stores (added 2026-07-12, Ahmad-explicit)

**wady-aljuz and Pecannbee (store id `359afc1f-ea5b-4f8d-b372-c038c6c057f7`) are LIVE CLIENT STORES on `elegant`, tuned via Page Builder. Their rendered output must NOT change.** Consequences for every item above:

1. **The elegant persona-completion pass is OFF THE TABLE as a default change.** If ever built, it ships behind new theme flags defaulting OFF (platform rule #2), and both stores' resolved layouts must be byte-identical before/after (`verify-baseline-nodrift.mjs` — now gates Pecannbee too).
2. Behavior-only additions (press states via `data-cta`, `:active` scale, focus rings, touch-target enlargements, `prefers-reduced-transparency` fallback) are additive and permitted — but every PR touching elegant or shared card paths MUST state a check against both stores' rendered pages in its test plan.
3. **Audit caveat**: this sweep reviewed TEMPLATE DEFAULTS. Saved Page Builder values override defaults (`resolveLayoutSettings` — saved wins), so per-theme findings may not manifest on these stores. See the page-builder reality addendum below before acting on any elegant finding.

## Page-builder reality addendum — wadyaljuz.com live render (2026-07-12)

Live HTML cross-check of `/`, `/products`, and a PDP (evidence = exact rendered class strings):

**Real on the live store (safe to act on, additive-only):**

- Card CTAs carry `data-cta="button"` but ZERO `active:` classes — the press-feedback gap is live (the PDP's add-to-cart has proper `active:scale-[0.98]`; cards don't).
- Wishlist heart is `h-10 w-10` (40px) on /products + PDP grids. NOTE: enlarging to h-11 changes the visible button size on client stores — ship the fix as an expanded HITBOX (padding/pseudo-element), not visual growth, per the no-touch rule.
- `transition-all duration-500/700` on every card/CTA — property-naming sweep is safe (no visual change).
- Shimmer skeletons already render on /products + PDP (48/42 occurrences) but NOT the homepage scroller.

**Template-default-only (page builder strips them here — do NOT "fix" against these stores):**

- The hairline kicker/subtitle heading pattern — this store renders bare `<h2>`; zones exist only as CSS rules.
- `animate-marquee` + literal RTL `→` — zero live occurrences.

**Audit correction:** elegant's live CTA is a top-hairline ghost button (`border-t border-foreground/15`, `tracking-[0.32em]`) inverting to solid on hover — the "solid-fill/4-side border" characterization was wrong for this store; the tracking observation was right.

**NEW live finding:** every /products card renders duplicated concatenated Tailwind classes (`rounded-2xl`×2, `bg-card`×2, stacked border fragments) — the page-builder card-frame layer is string-concatenated onto the base card class without `cn()`/tailwind-merge. Same defect class as the 2026-06-24 `ctaShape` lesson (`feedback-card-cta-ai-balancer-plp-filters-batch`): harmless today (later classes win) but one Tailwind source-order change from a visual bug on live client stores. Worth a source fix: run the frame-layer classes through `cn()`.
