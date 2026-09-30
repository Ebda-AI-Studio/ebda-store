# Modern Template Design System

## 1. Visual Theme & Atmosphere

The Modern template is the friendly, contemporary default of the Force storefront family — a soft, approachable surface language built on rounded corners, gentle elevation, and a single warm gradient lift on the hero. It suits general-purpose retail (lifestyle, electronics, home goods, food, casual fashion) where the goal is conversion clarity rather than editorial mood. Cards lift on hover (`hover:-translate-y-0.5`), images zoom subtly (`group-hover:scale-105`), and the brand accent (Force Orange by default) appears as a soft halo behind the hero image, on the gradient headline text, and as a glowing CTA shadow (`shadow-primary/20`).

Surfaces are predominantly `bg-background` and `bg-card` with translucent `border-border/60` hairlines. The header uses `bg-background/85 backdrop-blur-lg` (theme-token, not hardcoded white/slate) so it sits on top of content and always matches the store's surface colour — no clash when the OS prefers dark mode. The footer flips to `bg-gray-950 text-gray-300` to ground the page, with social tiles on `bg-white/8` and the brand color reserved for the newsletter CTA. Motion is consistent and bouncy: `transition-all duration-300`, the staggered grid fade-in (`fadeUp` keyframe with `--i` delay), and the `cartPulse` 700ms scale on cart count change.

**Key Characteristics:**

- Soft, friendly mood — modern e-commerce default, not editorial
- Card surfaces use `rounded-xl` (12px) for product cards and `rounded-2xl` (16px) for hero, summary, form panels
- Subtle elevation: `shadow-sm` resting → `shadow-xl` on hover with a `-translate-y-0.5` lift
- Hero headline rendered with `bg-gradient-to-r from-primary via-primary/80 to-primary/60 bg-clip-text text-transparent`
- Translucent header (`bg-white/80 backdrop-blur-lg`) becomes opaque-bordered on scroll
- Bouncy animations: `transition-all duration-300`, `hover:scale-105` on product images, `cartPulse` 125% scale on add-to-cart
- Footer is `bg-gray-950` — the only dark surface in the template, used for visual grounding
- Plus Jakarta Sans body, semibold weight as the workhorse, no serif anywhere
- Border weight is whisper-thin: `border border-border/60` (1px at 60% opacity)

## 2. Color Palette & Roles

All colors flow through `globals.css` CSS variables. Each tenant overrides `--primary` (and optionally other tokens) at runtime via `StoreContext`, so the template MUST consume `hsl(var(--primary))` rather than hardcode any chromatic value. The defaults below describe the unbranded baseline.

### Background Surfaces

- **Page** (`--background` / `0 0% 100%` / `#ffffff`): Default page canvas. The hero, product grid, and most sections render directly on this.
- **Card** (`--card` / `0 0% 100%`): Product cards, order summary, form card, empty state. In Modern, card and page share the same hue — separation is created by `border-border/60` and `shadow-sm`.
- **Muted** (`--muted` / `210 20% 96%`): Image placeholders, search input background (`bg-muted`), hover backgrounds for icon buttons (`hover:bg-muted`).
- **Footer Dark** (`bg-gray-950` / Tailwind `#030712`): Hardcoded — the footer is the only fixed-dark surface; it does NOT respond to tenant primary.

### Text & Content

- **Foreground** (`--foreground` / `222.2 47.4% 11.2%`): Headings, product names, totals.
- **Foreground/70–80** (opacity utility): Nav links resting state (`text-foreground/70 hover:text-foreground`).
- **Muted Foreground** (`--muted-foreground` / `215.4 16.3% 46.9%`): Subtitles, placeholder, metadata, secondary text.
- **Footer text** (`text-gray-300` / `text-gray-400` / `text-gray-500`): Hardcoded gray scale on the dark footer because `--muted-foreground` would not have enough contrast on `bg-gray-950`.

### Brand & Accent

- **Primary** (`--primary` / Force Orange `26 100% 50%` / `#ff6e00` default): CTAs, hero gradient, cart badge, focus rings, social hover, newsletter button.
- **Primary Foreground** (`--primary-foreground` / `0 0% 100%`): Always paired with primary for contrast.
- **Primary/5–30** (opacity utility): Used for ambient effects — `bg-primary/5` for icon halos in empty states, `shadow-primary/20` on hero CTA, `from-primary/15 to-muted` for image fallback gradients (two-stop: the old `via-primary/8` emitted no CSS — issue 2342).

### Status Colors

- **Success** (`--success` / `142 76% 36%`): "Free" shipping label, discount line in OrderSummary, "Thank you for subscribing" confirmation.
- **Destructive** (`--destructive` / `0 84.2% 60.2%`): Wishlist toggle "active" state (`bg-destructive text-destructive-foreground`), trash icon hover (`hover:bg-destructive/10 hover:text-destructive`).

### Border & Divider

- **Border** (`--border` / `220 13% 91%`): Used at 60% opacity throughout — `border-border/60`. Hairline, almost imperceptible. Modern never uses solid 1px `border-border` on cards — always softened.
- **White/8 & 10** (footer): `border-white/8` and `border-white/10` for footer dividers and social tile borders on the dark surface.

### Overlay

- **Mobile drawer scrim**: `bg-black/40 backdrop-blur-sm`.
- **Image gradient overlay**: `bg-gradient-to-t from-black/20 via-transparent to-transparent` on hero image, `bg-gradient-to-t from-black/50 via-black/20 to-transparent` behind the quick-add button on product cards.

## 3. Typography Rules

### Font Family

- **Body / Display**: `--font-sans` → `'Plus Jakarta Sans', system-ui, sans-serif` (loaded via `next/font/google` in `app/layout.tsx`, exposed as `--font-sans` and `font-sans` Tailwind class).
- **Arabic**: `--font-arabic` → `'IBM Plex Sans Arabic'` (auto-applied via `[dir="rtl"]` selector in `globals.css`).
- **Font features**: `'cv11', 'ss01'` enabled globally on `body`. Modern does NOT use `font-serif` (`Playfair Display`) anywhere — that's reserved for Classic/Elegant.

### Hierarchy

| Role                   | Class                                                                                                       | Weight | Notes                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------ |
| Hero headline          | `text-4xl md:text-5xl lg:text-6xl font-extrabold leading-[1.1] tracking-tight` (`letterSpacing: '-0.02em'`) | 800    | Wrapped in primary gradient `bg-clip-text` |
| Hero subtitle          | `text-lg md:text-xl text-muted-foreground leading-relaxed`                                                  | 400    | `max-w-md`                                 |
| Section heading (form) | `text-3xl font-bold tracking-tight`                                                                         | 700    | FormCard title                             |
| Order summary heading  | `text-lg font-semibold`                                                                                     | 600    |                                            |
| Empty state title      | `text-xl font-semibold`                                                                                     | 600    |                                            |
| Product name           | `text-sm font-semibold leading-snug line-clamp-2`                                                           | 600    | Hover shifts to `text-primary`             |
| Cart item name         | `font-semibold` (text-base default)                                                                         | 600    |                                            |
| Total (order summary)  | `text-xl font-bold text-primary`                                                                            | 700    |                                            |
| Nav link               | `text-sm font-medium`                                                                                       | 500    |                                            |
| Footer heading         | `text-sm font-semibold uppercase tracking-wider text-white`                                                 | 600    |                                            |
| Body / metadata        | `text-sm text-muted-foreground`                                                                             | 400    |                                            |
| Cart badge             | `text-[10px] font-bold`                                                                                     | 700    | Tabular feel via tight container           |
| Announcement bar       | `text-sm font-medium tracking-wide`                                                                         | 500    |                                            |

### Principles

- **Weight workhorse is 600** (`font-semibold`). Body sits at 400, key emphasis at 700 (`font-bold`), hero peak at 800 (`font-extrabold`).
- **Tracking is tight or normal**, never expanded — only the footer headings and announcement use `tracking-wider`/`tracking-wide`.
- **Hero uses an explicit `letterSpacing: '-0.02em'`** inline style on top of `tracking-tight` to push the gradient headline into a confident, modern compression.
- **Line-height stays generous on body** (`leading-relaxed`) and tight on display (`leading-[1.1]`).
- **No uppercase except in footer column titles and announcement** — Modern is sentence-case forward.

## 4. Component Stylings

### Buttons

**Primary CTA (Hero Shop Now)**

```
inline-flex items-center gap-2.5 px-8 py-4 bg-primary text-primary-foreground rounded-xl
hover:bg-primary/90 font-semibold text-base
shadow-lg shadow-primary/20 hover:shadow-xl hover:shadow-primary/30
hover:-translate-y-0.5 transition-all duration-300
```

**Order Summary CTA (Checkout)**

```
flex h-12 w-full items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold
text-primary-foreground transition-colors hover:bg-primary/90
focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2
```

**Empty State CTA**

```
inline-flex h-11 items-center rounded-xl bg-primary px-6 text-sm font-semibold text-primary-foreground
hover:bg-primary/90
```

**Icon Button (header)**

```
p-2 rounded-lg hover:bg-muted transition-colors duration-200
```

**Quantity Control (cart)**

```
flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground
transition-colors hover:bg-muted hover:text-foreground
disabled:opacity-40
focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1
```

**Wishlist Heart (active)**

```
bg-destructive text-destructive-foreground scale-110
```

### Cards & Containers

**Product Card**

```
group relative bg-background rounded-xl overflow-hidden border border-border/60
hover:border-primary/20 hover:shadow-xl hover:shadow-black/5 hover:-translate-y-0.5
transition-all duration-300 flex flex-col
```

**Cart Item Card**

```
flex gap-4 rounded-xl border border-border/60 bg-card p-4
transition-shadow hover:shadow-md sm:p-5
```

**Order Summary**

```
rounded-2xl border border-border/60 bg-card p-6 shadow-sm
```

**Form Card**

```
rounded-2xl border border-border/60 bg-card p-8 shadow-sm
```

**Empty State**

```
flex flex-col items-center justify-center rounded-2xl border border-border/60 bg-card py-16 px-6 text-center
```

### Inputs & Forms

**Search input (header)**

```
flex-1 px-4 py-2.5 bg-muted rounded-lg border border-border
focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary
text-sm transition-colors duration-200
```

**Newsletter input (footer, on dark surface)**

```
w-full px-4 py-2.5 bg-white/8 rounded-lg border border-white/10
focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20
text-sm text-white placeholder:text-gray-500
```

### Badges & Pills

Modern uses `@force/ui`'s `ProductBadge` with default styling — `rounded-full`, `text-[10px]` to `text-xs`, `font-bold`. Sale and "new" badges sit `top-3 start-3` (RTL-aware via `start-*`). The cart count badge is a circle `min-w-[18px] h-[18px] rounded-full bg-primary text-primary-foreground text-[10px] font-bold`.

### Navigation

- Sticky, translucent: `sticky top-0 z-50 bg-background/85 backdrop-blur-lg border-b border-border/60`
- Adds `shadow-sm` once `window.scrollY > 8` (state-driven, not CSS-only)
- Links: `px-3 py-2 text-sm font-medium text-foreground/70 hover:text-foreground hover:bg-muted rounded-lg transition-colors duration-200`
- Logo height: `h-14 max-h-14 w-auto`
- Mobile drawer: `w-72 bg-background shadow-2xl` sliding from right (or left in RTL)

### Image Treatment

- Product image aspect ratio: `aspect-[3/4]` (portrait, fashion-leaning but works for any product)
- Hero image aspect ratio: `aspect-[4/3] lg:aspect-[5/4]`, wrapped in `rounded-2xl overflow-hidden shadow-2xl shadow-black/10`
- Category image aspect ratio: `aspect-[4/3]`, `rounded-xl overflow-hidden`
- Hover behavior: `group-hover:scale-105 transition-transform duration-500 ease-out`
- Two-image swap on product cards: second image fades in on hover with `transition-opacity duration-500`
- Decorative glow behind hero image: `absolute -inset-4 -z-10 bg-primary/5 rounded-3xl blur-3xl`

## 5. Layout Principles

### Spacing System

- Tailwind defaults (4px base). Modern uses `gap-1`, `gap-2`, `gap-4`, `gap-6` for component-internal rhythm.
- Product grid: `gap-4 md:gap-6`.
- Hero vertical padding: `py-14 lg:py-24`.
- Section vertical rhythm: `py-16 md:py-20` typical.

### Grid & Container

- Container: `container mx-auto px-4` — Tailwind's container, `--container-max: 1400px`, `--container-padding: 1rem`.
- Product grid columns: `grid-cols-2 md:grid-cols-3 lg:grid-cols-4` (default 4-up).
- Hero: 2-column `grid lg:grid-cols-2 gap-8 lg:gap-12 items-center min-h-[540px]`.
- Footer: `grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-10 lg:gap-12`.

### Whitespace Philosophy

- Friendly density — Modern is tighter than Elegant or Minimal but more breathable than Bold or Classic. The card content has `p-4` padding (not 6 or 8), but the hero and form panels use `p-8`.
- Hover lift (`-translate-y-0.5`) requires breathing room above each card; the grid `gap-6` on desktop accommodates this without clipping.

### Border Radius Scale

- Pill / badge / circle: `rounded-full`
- Small (icon buttons, search input): `rounded-lg` (8px)
- Standard (product card, hero CTA): `rounded-xl` (12px)
- Featured (hero image, order summary, form card, empty state): `rounded-2xl` (16px)
- XL (decorative blur halo): `rounded-3xl` (24px)

## 6. Depth & Elevation

| Level    | Treatment                                                                   | Use                                       |
| -------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| Flat     | No shadow, `border-border/60`                                               | Resting product card, cart row            |
| Subtle   | `shadow-sm`                                                                 | Order summary, form card, scrolled header |
| Standard | `shadow-md`                                                                 | Cart row hover (`hover:shadow-md`)        |
| Lifted   | `shadow-xl shadow-black/5` + `-translate-y-0.5`                             | Product card hover                        |
| CTA Glow | `shadow-lg shadow-primary/20` resting → `shadow-xl shadow-primary/30` hover | Hero primary button                       |
| Drawer   | `shadow-2xl`                                                                | Mobile menu drawer                        |

**Shadow Philosophy**: Modern uses shadows as a primary depth language alongside hairline borders. Hover always combines a shadow shift with a small `-translate-y-0.5` lift and a 300ms `transition-all`. The hero CTA has a colored shadow (`shadow-primary/20`) — this is the only place where the brand color enters the shadow system.

## 7. Do's and Don'ts

### Do

- Use `rounded-xl` for product/cart cards and `rounded-2xl` for larger panels (hero image, summary, form, empty state).
- Pair every hover with a `transition-all duration-300` (or `duration-200` for color-only changes) — no instant snaps.
- Lift surfaces with `hover:-translate-y-0.5` paired with `hover:shadow-xl` for the signature bouncy feel.
- Use `border-border/60` as the default hairline — never solid `border-border`.
- Use `hsl(var(--primary))` (via `bg-primary`, `text-primary`, etc.) for ALL CTAs and brand accents — every tenant ships its own primary.
- Use `font-semibold` (600) as the default emphasis weight; reserve `font-extrabold` (800) for the hero headline only.
- Use the gradient text technique (`bg-gradient-to-r from-primary via-primary/80 to-primary/60 bg-clip-text text-transparent`) on the hero headline.
- Use `bg-gray-950` for the footer — it's the only fixed-dark surface, intentional for visual grounding.
- Apply `aspect-[3/4]` for product images, `aspect-[4/3]` for hero/category, `aspect-square` for cart thumbs.

### Don't

- Don't use `rounded-none` or `rounded-sm` — softness is a core cue; sharp corners belong to Bold and Classic.
- Don't use `font-serif` anywhere — that's the Classic/Elegant signal. Modern is 100% Plus Jakarta Sans.
- Don't use `border-2` — Modern's borders are always 1px and softened to 60% opacity. Heavy borders read as Bold.
- Don't hardcode `#ff6e00` or any hex — always go through `--primary`. Tenants ship their own brand color.
- Don't use `uppercase tracking-widest` on body or product names — only on footer column titles. Excess uppercase reads as Elegant/Bold.
- Don't add solid drop shadows like `shadow-black/40` — Modern's shadows are soft (`shadow-black/5`, `shadow-primary/20`).
- Don't skip the `motion-reduce:` fallback on hero/grid animations — `motion-safe:[animation:fadeUp_…]` paired with `motion-reduce:opacity-100` is the convention.
- Don't use `text-foreground` at 100% on muted contexts — secondary text always uses `text-muted-foreground` or `text-foreground/70`.
- Don't render the cart count without the `cartPulse` 700ms scale-up — it's the brand's micro-delight signal.

## 8. Responsive Behavior

### Breakpoints (Tailwind defaults)

| Name    | Min Width | Use                                                                   |
| ------- | --------- | --------------------------------------------------------------------- |
| Default | 0         | Single column, mobile drawer nav                                      |
| `sm`    | 640px     | Optional flex-row on small CTAs                                       |
| `md`    | 768px     | Header desktop nav appears, hero gains `text-5xl`, grid → 3-up        |
| `lg`    | 1024px    | Hero 2-column layout, grid → 4-up, hero text `text-6xl`, footer 4-col |
| `xl`    | 1280px    | (rarely used)                                                         |

### Touch Targets

- All buttons / quantity controls are `h-11 w-11` (44px) minimum — meets WCAG.
- Header icon buttons: `p-2` with 20px icons → ~36px hit area; mobile-acceptable but increased to `p-2.5` in some components.
- Mobile menu items: `px-4 py-3` (~44px tall).

### Collapsing Strategy

- Hero: `text-4xl → md:text-5xl → lg:text-6xl`; image and text re-stack via `lg:order-1` / `lg:order-2`.
- Header: full nav at `md:`, hamburger drawer below. Search expands inline (max-h transition).
- Product grid: `grid-cols-2 → md:grid-cols-3 → lg:grid-cols-4`.
- Footer: `grid-cols-1 → md:grid-cols-2 → lg:grid-cols-4`. Bottom bar restacks `flex-col → md:flex-row`.
- Cart row: image `h-24 w-24 → sm:h-28 sm:w-28`; row padding `p-4 → sm:p-5`.
- Announcement bar: marquee animation auto-engages when text width > 70% of container width (state-driven).

### Image Behavior

- Hero `<Image>` uses `priority` and `sizes="(min-width: 1024px) 50vw, 100vw"`.
- Product cards use `sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"` and `loading="lazy"`.
- Hero falls back to a `bg-gradient-to-br from-primary/15 to-muted` placeholder with a centered icon.
- Two-image swap on product cards is opt-in: when `product.images[1]?.url` exists, the second image fades in on hover via `cn('object-cover transition-opacity duration-500', isHovered ? 'opacity-100' : 'opacity-0')`. Single-image products skip the layer entirely.

### Motion Conventions

- Hero text: `motion-safe:[animation:heroFadeIn_0.7s_ease-out_both]`, image lags by 150ms with `motion-safe:[animation:heroFadeIn_0.7s_ease-out_0.15s_both]`.
- Product grid stagger: each card is wrapped in a div with `style={{ '--i': index }}` and `motion-safe:[animation:fadeUp_0.5s_ease-out_calc(var(--i)*60ms)_both]`. The keyframe and stagger logic lives in `globals.css` — do not re-declare.
- Cart pulse: `setCartPulse(true)` on `cartItemCount > prevCartCount`, then `setTimeout(700)` to clear. The badge gets `transition-transform duration-200 ${cartPulse ? 'scale-125' : 'scale-100'}`.
- Search expand: `overflow-hidden transition-all duration-300 ${isSearchOpen ? 'max-h-20 opacity-100 py-3 border-t border-border/60' : 'max-h-0 opacity-0 py-0'}` — max-height + opacity combo.
- ALWAYS pair with `motion-reduce:opacity-100` (or equivalent reset) so reduced-motion users see content without animation.

## 9. Agent Prompt Guide

When generating new components for the Modern template, treat the existing `Header.tsx`, `Hero.tsx`, and `ProductCard.tsx` as the canonical reference. Use `rounded-xl` for compact surfaces and `rounded-2xl` for featured panels. Default the resting border to `border border-border/60` (1px hairline). Default the elevation to `shadow-sm` and lift to `shadow-xl shadow-black/5` plus `hover:-translate-y-0.5` on hover, transitioning with `transition-all duration-300 ease-out`. Type uses Plus Jakarta Sans (`font-sans` / `--font-sans`) — never `font-serif`. Workhorse weight is `font-semibold` (600); reserve `font-extrabold` for the hero headline (`text-4xl md:text-5xl lg:text-6xl tracking-tight letterSpacing:-0.02em` plus the `bg-gradient-to-r from-primary` clip-text treatment). All chromatic color flows through `hsl(var(--primary))` and friends — never hardcode hex. Status colors use `text-success`, `text-destructive`, `text-warning`, `text-info`. RTL is supported via `dir={isRtl ? 'rtl' : 'ltr'}` and `start-*`/`end-*` logical properties; mirror chevrons with `rotate-180` and arabic strings via `isRtl && nameAr ? nameAr : name`. Animations must respect `prefers-reduced-motion` — pair `motion-safe:[animation:…]` with `motion-reduce:opacity-100`. The footer is the ONE intentionally dark surface (`bg-gray-950 text-gray-300`) — do not lighten it.

### Quick Token Reference

- Primary CTA: `bg-primary text-primary-foreground rounded-xl shadow-lg shadow-primary/20 hover:bg-primary/90 hover:shadow-xl hover:shadow-primary/30 hover:-translate-y-0.5`
- Card frame: `bg-background rounded-xl border border-border/60 hover:border-primary/20 hover:shadow-xl hover:shadow-black/5 hover:-translate-y-0.5 transition-all duration-300`
- Heading text: `text-foreground font-semibold` (cards/panels), `font-extrabold tracking-tight letterSpacing:-0.02em` (hero only)
- Body text: `text-muted-foreground` (default secondary), `text-foreground/70 hover:text-foreground` (interactive nav)
- Border (default): `border-border/60` — never solid `border-border`
- Focus ring: `focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`
- Status: `text-success` (free shipping, discount), `text-destructive` (wishlist active, trash hover)

### Example Component Prompts

- "Create a Modern product preview card on `bg-background` with `rounded-xl border border-border/60`, `aspect-[3/4]` image inside, `font-semibold` product name, `Price` component below, `hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/5 transition-all duration-300 ease-out`."
- "Add a notification toast: `fixed bottom-4 right-4 rounded-xl border border-border/60 bg-card p-4 shadow-lg`, animation `animate-slide-in-right`, body in `text-sm`."
- "Build a filter pill row: each pill is `rounded-full border border-border/60 bg-card px-3 py-1.5 text-sm font-medium text-foreground/70 hover:text-foreground hover:bg-muted`. Active state adds `bg-primary text-primary-foreground border-transparent`."
