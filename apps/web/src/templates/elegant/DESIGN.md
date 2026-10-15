# Elegant Template Design System

## 1. Visual Theme & Atmosphere

The Elegant template is the editorial / fashion-forward storefront — built for high-end fashion houses, jewellery, beauty, perfumery, and curated lifestyle. It pulls cues from Vogue layouts, COS / The Row e-commerce, and luxury hotel sites: enormous whitespace, hairline dividers, asymmetric hero compositions, italic accents, and ALL CAPS letter-spacing as a primary visual rhythm. The mood is quiet, confident, and unhurried — nothing competes for attention; instead, generous negative space and a strict tracking-driven label system create hierarchy.

Color is almost entirely neutral — light page surface (`bg-background`), `bg-muted` for the footer, and chromatic accent reserved for hover transitions and the announcement bar. Typography blends serif (`font-serif` Playfair Display for column eyebrows and brand wordmark) with very light sans (`font-light` / `font-extralight` Plus Jakarta Sans for hero headlines) — this hybrid creates a couture feel where the lightness of stroke matches the lightness of layout. The hero offers two modes: a 60/40 asymmetric image+text split, OR a centered editorial composition with subtle decorative concentric rings — both use a single italic word in the headline as a typographic flourish ("**_Exclusive_** Edit").

Hover states are ultra-subtle (`opacity-100` reveals, `transition-opacity duration-300/500`), product cards have NO borders or shadows in their resting state — image-on-light, image-on-light, image-on-light, with text below. Every CTA is bordered (`border border-foreground`), never filled by default, and inverts on hover. Tracking is the loudest visual language: `tracking-[0.2em]`, `tracking-[0.3em]`, even `tracking-[0.5em]` on the hero "New Collection" eyebrow. Aspect ratios trend portrait: `aspect-[3/4]` on product cards, `aspect-[2/3]` on category cards.

**Key Characteristics:**

- Editorial mood — luxury fashion / beauty / lifestyle
- No card chrome — product cards have no borders, no shadows, just `aspect-[3/4]` image on `bg-gray-50` with text below
- Hairline dividers everywhere: `divide-y divide-border/50`, `border-t border-foreground/20 pt-8`, `w-12 h-px bg-foreground/20`
- Tracking signature: `tracking-[0.15em]`, `tracking-[0.2em]`, `tracking-[0.25em]`, `tracking-[0.3em]`, `tracking-[0.4em]`, `tracking-[0.5em]` on labels and eyebrows
- Type weights stay 300–500: `font-extralight`, `font-light`, `font-normal`, `font-medium` — never `font-bold` and absolutely never `font-black`
- Hybrid serif + sans: `font-serif` (Playfair Display) for footer eyebrows, brand wordmarks; very light `font-sans` (Plus Jakarta Sans) for hero/heading display
- Italic accent on hero headlines: split first word with `<span className="italic font-normal">` over the rest in `font-extralight`
- Outlined CTAs that invert on hover: `border border-foreground hover:bg-foreground hover:text-background transition-all duration-500`
- Long transition durations (300ms / 500ms) — everything moves slowly and intentionally
- ALL CAPS for nav, eyebrows, buttons, card names — sentence-case reserved for body / hero subtitle / form headings

## 2. Color Palette & Roles

Elegant relies on a near-monochromatic palette dominated by `--foreground` and its opacity steps. The brand `--primary` token is mostly held in reserve — it only appears on the announcement bar (`bg-primary text-primary-foreground`), occasional headline accent ("italic font-normal text-primary"), focus rings, and the hover state of bottom-bar legal links.

### Background Surfaces

- **Page** (`--background` / white default): The dominant surface — hero, header, product grid, cart, form, empty state all sit on `--background`.
- **Footer / Newsletter** (`bg-muted`): A soft tint that distinguishes the footer block. Inside the newsletter row, individual fields go back to `bg-background`.
- **Product Image Background** (`bg-gray-50` hardcoded in ProductCard, `bg-muted/30` on cart thumbs): A near-white surface that lets shot-on-white product photography blend seamlessly. Elegant uses Tailwind's `bg-gray-50` here intentionally (not `bg-muted`) to keep image bg colors consistent across tenant theme overrides.
- **Subtle decorative rings** (no-image hero): Concentric `border border-primary/5` and plain `border` rings (the inner ring's old `border-primary/8` emitted no CSS — issue 2342) at 700px / 450px diameter, centered.

### Text & Content

- **Foreground** (`--foreground`): Hero headline (rendered at very light weights), product name on hover, total amount, form heading.
- **Foreground/80**: Resting product name color (`text-foreground/80 group-hover:text-foreground`).
- **Foreground/60**: Resting actions (search, account icons in header).
- **Foreground/50**: Action icons in header — even more subdued than Classic's `/60`.
- **Foreground/40 → /20**: Decorative outlines (`border-foreground/20` on dividers, `border-foreground/40` on small accents) — extreme subtlety.
- **Muted Foreground**: Subtitles, "Subscribe for exclusive offers" copy, cart prices.
- **Muted Foreground/60 → /50 → /40**: Tiny eyebrows ("New Collection", "Stay Informed", placeholder text).

### Brand & Accent

- **Primary** (`--primary`): Used ONLY on:
  - Announcement bar background (`bg-primary text-primary-foreground`)
  - Italic headline accent (`text-primary` on the first italic word in the no-image hero variant)
  - Focus rings (`focus-visible:ring-2 focus-visible:ring-primary`)
  - "Thank you for subscribing!" success message
  - Hover transition of empty-state CTA (`hover:border-primary hover:text-primary`)
- **Primary/30 → /10 → /8 → /5**: Decorative gradients and concentric rings in fallback hero, letter-avatar in CategoryCard fallback (`bg-primary/10 text-primary/60`).

### Status Colors

- **Success** (`--success`): "Complimentary" shipping label and "Discount" line in OrderSummary, "Thank you for subscribing" in footer. Used WITH tracking-widest uppercase styling: `text-success uppercase tracking-[0.2em] text-xs`.
- **Destructive** (`--destructive`): "Remove" hover in CartTable, with `underline underline-offset-4` decoration.

### Border & Divider

- **Border** (`--border`): Solid border on input fields, social tile outlines, top utility bar.
- **Border/50**: Most dividers (`border-b border-border/50`, `divide-y divide-border/50`) — slightly softened for elegance.
- **Foreground/20**: The strongest divider used in OrderSummary (`border-t border-foreground/20`) and FormCard (`border-y border-foreground/20`) — still extremely thin, but more present than `border-border/50`.

### Overlay

- **Image overlay (image hero)**: `bg-foreground/10` — a 10% scrim over the hero image.
- **Image hover overlay (category)**: `bg-foreground/0 group-hover:bg-foreground/10 transition-colors duration-500` — appears only on hover.
- **Quick-add overlay (product card)**: `bg-background/95 backdrop-blur-sm` — frosted near-white, the OPPOSITE of Classic's dark slide-up.

## 3. Typography Rules

### Font Family

- **Display sans** (hero, product names, form heading, totals): `--font-sans` → Plus Jakarta Sans via `font-sans` — but used at unusually light weights (`font-extralight`, `font-light`, `font-normal`).
- **Display serif** (column eyebrows, brand wordmarks): `--font-serif` → Playfair Display via `font-serif`.
- **Arabic**: `--font-arabic` → IBM Plex Sans Arabic.
- **Font features**: `'cv11', 'ss01'` enabled globally on body (default).

### Hierarchy

| Role                          | Class                                                                          | Weight | Notes                                                   |
| ----------------------------- | ------------------------------------------------------------------------------ | ------ | ------------------------------------------------------- |
| Hero headline (image variant) | `text-4xl md:text-5xl lg:text-6xl font-light leading-[1.1] tracking-[-0.02em]` | 300    | First word italic `font-normal`, rest `font-extralight` |
| Hero headline (no-image)      | `text-5xl md:text-6xl lg:text-7xl font-light leading-[1.1] tracking-[-0.02em]` | 300    | First word `italic font-normal text-primary`            |
| Hero eyebrow                  | `text-[10px] tracking-[0.5em] uppercase text-muted-foreground`                 | 400    | "New Collection"                                        |
| Hero subtitle                 | `text-sm font-light tracking-wide leading-loose`                               | 300    |                                                         |
| Hero CTA label                | `text-xs tracking-[0.25em] uppercase font-medium`                              | 500    |                                                         |
| Section heading (grid)        | `text-3xl md:text-4xl font-light tracking-wide`                                | 300    |                                                         |
| Section eyebrow               | `text-xs tracking-[0.4em] uppercase text-muted-foreground`                     | 400    | "Discover"                                              |
| Form heading                  | `text-3xl font-light tracking-wide`                                            | 300    |                                                         |
| Order summary heading         | `text-xs font-light uppercase tracking-[0.3em] text-muted-foreground`          | 300    |                                                         |
| Order summary total           | `text-xl font-light tracking-wide text-foreground`                             | 300    |                                                         |
| Empty state title             | `text-xs font-light uppercase tracking-[0.3em] text-muted-foreground`          | 300    |                                                         |
| Empty state body              | `text-sm font-light tracking-wide`                                             | 300    |                                                         |
| Product name                  | `text-xs tracking-[0.15em] uppercase text-foreground/80`                       | 400    | Centered, line-clamp-1                                  |
| Product price                 | `font-light text-muted-foreground`                                             | 300    | Centered                                                |
| Cart item name                | `text-base font-light tracking-wide`                                           | 300    |                                                         |
| Cart item price               | `text-xs uppercase tracking-[0.2em] text-muted-foreground`                     | 400    |                                                         |
| Nav link                      | `text-[11px] tracking-[0.2em] uppercase text-muted-foreground`                 | 400    |                                                         |
| Top utility bar               | `text-[11px] tracking-[0.15em] uppercase text-muted-foreground`                | 400    | "Complimentary shipping…"                               |
| Footer column heading         | `text-[10px] tracking-[0.3em] uppercase font-serif text-muted-foreground`      | 400    |                                                         |
| Footer link                   | `text-xs text-foreground/70 tracking-wide`                                     | 400    |                                                         |
| Announcement bar              | `text-xs tracking-[0.25em] uppercase font-light`                               | 300    |                                                         |

### Principles

- **The light-weight hero**: `font-light` (300) is the dominant heading weight. Reaching for `font-bold` would break the entire system.
- **Italic-as-accent**: Hero splits the first word of the headline into `italic font-normal` (slightly bolder, italic Playfair-feel through the Plus Jakarta italic), with the rest in `font-extralight`. This is the template's signature flourish.
- **Tracking is THE hierarchy tool**: A 10px label at `tracking-[0.5em]` reads with more authority than a 16px label at normal tracking. Categories of tracking:
  - `tracking-[0.15em]`: product names (light tracking + uppercase)
  - `tracking-[0.2em]` / `tracking-[0.25em]`: navigation, CTA labels, badges, "Discover" eyebrows
  - `tracking-[0.3em]`: section eyebrows, form headings, order summary headings, footer columns
  - `tracking-[0.4em]`: largest section eyebrows ("Discover")
  - `tracking-[0.5em]`: the rare ultra-eyebrow ("New Collection")
- **Hybrid serif/sans**: Footer column titles use `font-serif` Playfair Display in tiny tracking-widest uppercase — a couture detail. The body uses Plus Jakarta Sans throughout.
- **NO `font-bold`, NO `font-extrabold`, NO `font-black`** — maximum is `font-medium` (500), and only on CTAs.
- **Generous `leading-loose`** for body copy, `leading-[1.1]` only on display headlines.

## 4. Component Stylings

### Buttons

**Hero CTA (outlined → invert on hover, signature pattern)**

```
group inline-flex items-center gap-4 px-8 py-4 border border-foreground
text-foreground text-xs tracking-[0.25em] uppercase font-medium
hover:bg-foreground hover:text-background transition-all duration-500
```

**OrderSummary CTA (filled, but flat)**

```
flex h-12 w-full items-center justify-center
border border-foreground bg-foreground px-4 text-xs font-light uppercase tracking-[0.3em] text-background
hover:bg-foreground/80
```

**EmptyState CTA (text-link with hover bottom-border shift)**

```
inline-block border-b border-foreground pb-1 text-xs font-light uppercase tracking-[0.3em] text-foreground
hover:border-primary hover:text-primary
```

Suffix: `→` rendered inline as text.

**Newsletter Submit (footer)**

```
px-8 py-4 bg-foreground text-background text-[10px] tracking-[0.25em] uppercase
hover:bg-foreground/80 transition-colors duration-300
```

**Quantity Control (cart)**

```
inline-flex h-11 w-11 items-center justify-center text-lg
text-muted-foreground hover:text-foreground disabled:opacity-30
```

The buttons use the symbols `−` and `+` directly, in Plus Jakarta Sans at `text-lg` for visual mass.

**Cart Remove (text-link with underline)**

```
inline-flex min-h-[44px] items-center text-xs uppercase tracking-[0.2em]
text-muted-foreground hover:text-destructive
underline underline-offset-4
```

**Wishlist (heart icon, opacity reveal)**

```
absolute top-4 [end-edge]-4 p-2 transition-all duration-300
opacity-0 group-hover:opacity-100 (or 100 if isWishlisted)
```

Icon strokeWidth={1} — thin stroke matches the editorial language.

### Cards & Containers

**Product Card** — no chrome. Just an image and centered text:

```
group block cursor-pointer
[image] relative aspect-[3/4] overflow-hidden bg-gray-50 mb-4
[content] text-center space-y-1.5
```

Image hover crossfades two product images with `transition-opacity duration-500`. The first image also gets `brightness-95 scale-[1.02]` on hover.

**Cart Container**

```
divide-y divide-border/50
```

No outer border, no padding — items are separated by hairline dividers and `py-8` per row.

**Order Summary**

```
border-t border-foreground/20 pt-8
```

Just a top rule and content — no card frame.

**Form Card**

```
border-y border-foreground/20 py-10
```

Top + bottom hairlines bracket the form — no left/right borders, no card body color.

**Empty State**

```
flex flex-col items-center justify-center py-24 px-6 text-center
```

NO border or container — pure typographic empty state.

### Inputs & Forms

**Header Search (centered, expanding row)**

```
w-full px-0 py-3 bg-transparent border-0 border-b border-border
focus:outline-none focus:border-foreground
text-center text-sm tracking-[0.1em] placeholder:text-muted-foreground
transition-colors duration-500
```

**Newsletter Email (footer, bordered box)**

```
flex-1 px-6 py-4 bg-background border border-border
focus:border-foreground focus:outline-none
text-xs tracking-[0.1em] placeholder:text-muted-foreground
transition-colors duration-500
```

The email input is sharp-cornered (no rounding) and sits flush against the submit button (no gap, single visual unit).

### Badges & Pills

`@ebda/ui`'s `ProductBadge` is restyled per-instance:

```
text-[9px] tracking-[0.2em] uppercase rounded-none bg-foreground text-background font-normal
```

Square, ALL CAPS, near-black-on-near-white. "New" and "Sale" labels use this exact style.

### Navigation

- Top utility bar: hidden on mobile, `text-[11px] tracking-[0.15em] uppercase text-muted-foreground` with "Complimentary shipping on orders over 25 KD" on left, "Contact" / "Wishlist" links on right.
- Main row: logo centered with `flex-1` spacers on both sides.
- Logo height: `h-20 max-h-20 w-auto` (largest of the 5 templates) — luxury wordmark stature. Fallback wordmark: `text-3xl font-light tracking-[0.25em]`.
- Action icons (`strokeWidth={1}`): search / account / cart at `text-foreground/70 hover:text-foreground` — the most subdued action set across the templates.
- Desktop nav row sits BELOW the logo row: `hidden md:flex items-center justify-center gap-10 pb-5`, links at `text-[11px] tracking-[0.2em] uppercase`.
- Cart count badge: `bg-foreground text-background text-[9px] font-medium w-4 h-4 rounded-full` — tiny solid dark dot.

### Image Treatment

- Product image aspect: `aspect-[3/4]` on `bg-gray-50` (intentional Tailwind hardcode — image bg is consistent across tenants).
- Category image aspect: `aspect-[2/3]` (taller portrait) on `bg-muted`.
- Cart image aspect: `aspect-[3/4]` (`w-24 sm:w-28`) on `bg-muted/30`.
- Hero image (image variant): `60vw / 100vw` width on desktop, `min-h-[85vh]` block, with `bg-foreground/10` overlay.
- Image hover behavior on product cards: crossfade between `images[0]` and `images[1]` over 500ms, plus a subtle `brightness-95 scale-[1.02]` shift on `images[0]` while hovering.
- Category hover overlay: `bg-foreground/0 group-hover:bg-foreground/10` PLUS a "View" pill that fades in (`opacity-0 group-hover:opacity-100`) — `px-6 py-3 bg-background text-foreground text-xs tracking-[0.2em] uppercase`.

### Announcement Bar

```
bg-primary text-primary-foreground py-2.5 px-4 text-center
[content] text-xs tracking-[0.25em] uppercase font-light
```

The announcement bar is the ONE place chromatic primary appears proudly.

## 5. Layout Principles

### Spacing System

- Tailwind defaults but heavily padded — `py-16` is a typical section minimum, `py-20 md:py-28` on the product grid, `py-24` on the empty state.
- Hero block height: `min-h-[85vh]` (image variant) or `py-28 md:py-36 lg:py-44` (no-image).
- Footer newsletter block: `py-16` then a separate `py-16` for the main footer grid.

### Grid & Container

- Container: `container mx-auto px-4`, max 1400px.
- Hero: asymmetric flex `lg:w-[60%]` image + `lg:w-[40%]` text (image variant) or single centered column with concentric rings (no-image).
- Product grid: `getGridColsClass(columns)` default 4-up, `gap-8 md:gap-12` (the widest gap of all 5 templates) — letting each card breathe.
- Footer: `grid-cols-2 md:grid-cols-4 gap-12`. Brand spans 2 cols on mobile, 1 on desktop.

### Whitespace Philosophy

- **Whitespace IS the design**. Removing the borders, shadows, and card backgrounds means the white surface around each element does the structural work. A product grid in Elegant looks visually empty until you focus, which is exactly the point — like a curated gallery.
- **Vertical breathing room** is generous: `mb-16` between section eyebrow and grid, `mb-12` between hero text blocks, `space-y-10` for cart items, `py-8` for each cart row.
- **Tracking creates spatial weight even on small text** — `tracking-[0.5em]` on a 10px eyebrow makes it feel like a deliberate, gallery-label statement.

### Border Radius Scale

- `rounded-full`: cart counter (`w-4 h-4`).
- `rounded-none` everywhere else (default).
- Hero image: no rounding — full-bleed corners.
- CTAs: square corners — corners give the borders a precise, architectural quality.

## 6. Depth & Elevation

| Level                | Treatment                                                | Use                                                   |
| -------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| Flat                 | No border, no shadow                                     | Product cards, empty state — content sits on the page |
| Hairline             | `border-t border-foreground/20`                          | Order summary, divider above totals                   |
| Hairline (subtle)    | `divide-y divide-border/50`, `border-b border-border/50` | Cart rows, top utility bar separation                 |
| Bordered             | `border border-border`                                   | Social tiles (form fields: `border-input`, K-05)      |
| Subtle hover overlay | `bg-foreground/10`                                       | Hero image scrim, category hover                      |

**Shadow Philosophy**: Elegant uses NO box-shadows. Depth is communicated entirely through hairline dividers, generous whitespace, and image overlays. The most "elevation" any element gets is the `bg-background/95 backdrop-blur-sm` quick-add overlay sliding up from the bottom of a product card — and even then, the visual is a frosted glass blur, not a shadow drop.

## 7. Do's and Don'ts

### Do

- Use `font-light` (300), `font-extralight` (200), or `font-normal` (400) on all display type — Elegant's weight ceiling is `font-medium` (500).
- Use the italic-accent pattern on hero headlines: split the first word into `italic font-normal` and render the rest in `font-extralight`.
- Use `tracking-[0.2em]` to `tracking-[0.5em]` plus `uppercase` on labels, eyebrows, nav, badges, button text — tracking IS the hierarchy.
- Use `border border-foreground` outlined CTAs that invert with `hover:bg-foreground hover:text-background transition-all duration-500`.
- Use long transition durations: `duration-500` for hovers, `duration-300` for opacity reveals — nothing snaps.
- Use hairline dividers (`border-foreground/20`, `divide-border/50`) instead of borders or shadows.
- Center hero text and section eyebrows — Elegant is symmetric and editorial.
- Pair small eyebrow text with large light headline: `text-[10px] tracking-[0.5em] uppercase` over `text-6xl font-light`.
- Use `aspect-[3/4]` for product images and `aspect-[2/3]` for category images — portrait ratios match fashion photography.
- Use `font-serif` for footer column titles ONLY (`font-serif text-[10px] tracking-[0.3em] uppercase text-muted-foreground`).
- Use `text-success uppercase tracking-[0.2em] text-xs` for "Free" / "Complimentary" labels — keep success color WITH the elegant tracking treatment.

### Don't

- Don't use `font-bold`, `font-extrabold`, or `font-black` ANYWHERE — weight range is strictly 200–500.
- Don't add borders, shadows, or backgrounds to product cards — emptiness is the design. The card IS the image plus centered text below.
- Don't round corners on cards, inputs, badges, CTAs — `rounded-none` (default) preserves the architectural precision. The only rounding allowed is the `rounded-full` cart counter.
- Don't use `transition-* duration-200` or shorter — Elegant's tempo is 300–500ms.
- Don't fill CTAs with `bg-primary` — the brand accent appears on hover transitions and the announcement bar only. Primary CTAs are bordered and invert to `bg-foreground` on hover.
- Don't use sentence case for nav, eyebrows, or button text — UPPERCASE plus tracking is the language. Reserve sentence case for body copy and hero subtitles.
- Don't use `font-sans` for footer column eyebrows — those use `font-serif` Playfair Display intentionally.
- Don't use bouncy hover lifts (`hover:-translate-y-0.5`) — that's Modern. Elegant hovers crossfade or shift opacity.
- Don't use the `cartPulse` micro-interaction (Modern's brand) — Elegant's cart count is a quiet `text-[9px] font-medium` dot.
- Don't pack content tight — if a section feels sparse, leave it sparse. Add more `py-`, more `mb-`, never less.

## 8. Responsive Behavior

### Breakpoints

| Name    | Min Width | Use                                                                                                     |
| ------- | --------- | ------------------------------------------------------------------------------------------------------- |
| Default | 0         | Single column hero (no asymmetry), mobile menu hidden                                                   |
| `sm`    | 640px     | Cart image bumps `w-24 → sm:w-28`                                                                       |
| `md`    | 768px     | Top utility bar reveals, desktop nav row reveals, footer 4-col grid, "White Glove Service" copy reveals |
| `lg`    | 1024px    | Hero asymmetric 60/40 split engages, headline `text-6xl`, product grid full columns from helper         |

### Touch Targets

- Quantity controls: `h-11 w-11` (44px) — meets WCAG.
- Remove link: `min-h-[44px] inline-flex items-center` — text-as-button with adequate hit.
- Action icons: `p-2.5` (~36px hit area) — borderline; agents adding new icon links should preserve `p-2.5` minimum.
- Wishlist heart: `p-2` — only revealed on hover, used by mouse users primarily.

### Collapsing Strategy

- Hero: image-variant collapses 60/40 split to stacked `flex flex-col lg:flex-row`. Text scales `text-4xl → text-5xl → text-6xl`.
- No-image hero: same content, scales `text-5xl → text-6xl → text-7xl`.
- Header: top utility bar `hidden md:flex`, nav row `hidden md:flex` — mobile relies on hamburger drawer that exposes the same nav vertically (`space-y-5 text-center`).
- Product grid: `gap-8 md:gap-12`, columns from helper.
- Footer: `grid-cols-2 md:grid-cols-4 gap-12`. Brand column spans 2 on mobile (`col-span-2 md:col-span-1`).
- Cart rows: stay full-width at all breakpoints; image `w-24 → sm:w-28`.

### Image Behavior

- Hero `<Image>` uses `priority`, `sizes="(min-width: 1024px) 60vw, 100vw"`, fills its 60% column.
- Product cards: dual-image crossfade on hover via two `<Image fill />` components stacked, both with `loading="lazy"` and `sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"`.
- Image fallback: `flex items-center justify-center text-muted-foreground` with a thin `strokeWidth={0.5}` placeholder icon at `w-16 h-16`.

## 9. Agent Prompt Guide

When generating new components for the Elegant template, treat `Hero.tsx`, `ProductCard.tsx`, and `Footer.tsx` as canon. Default typography weight to `font-light` (300) for display, `font-normal` (400) for labels, `font-medium` (500) at maximum on CTAs — NEVER reach `font-bold` or higher. Default labels to ALL CAPS with `tracking-[0.2em]` to `tracking-[0.3em]`; reserve `tracking-[0.4em]` and `tracking-[0.5em]` for the smallest eyebrows (10–11px). Default corners to `rounded-none` — sharp corners are signature. Default to NO borders, NO shadows, NO card backgrounds; let images sit directly on `bg-background` (or `bg-gray-50` for product image bg) with text below. CTAs use the outlined-invert pattern: `border border-foreground text-foreground hover:bg-foreground hover:text-background transition-all duration-500`. All transitions take `duration-300` or `duration-500` — never `duration-150` or `duration-200`. The brand `--primary` color is reserved for the announcement bar (`bg-primary`), focus rings, hero italic-accent (no-image variant), and select hover transitions on text links — it does NOT fill resting CTAs. Hero headlines use the italic-split pattern: `<span className="italic font-normal">{firstWord}</span><span className="block font-extralight">{rest}</span>`. Footer column eyebrows use `font-serif` Playfair Display at `text-[10px] tracking-[0.3em] uppercase text-muted-foreground`. Image aspect ratios are portrait by default — `aspect-[3/4]` (products), `aspect-[2/3]` (categories). RTL is supported via `dir`, mirrored chevrons (`rotate-180`), and Arabic strings (`isRtl && nameAr ? nameAr : name`). When in doubt, add more whitespace, lighten the type weight, and lengthen the transition.
