# Classic Template Design System

## 1. Visual Theme & Atmosphere

The Classic template is the formal, heritage-leaning storefront — a department-store / fine-goods aesthetic built around centered logos, hairline rules, square corners, and `Playfair Display` serif typography. It suits stores trading on craft, longevity, gifting, jewellery, watches, perfume, traditional menswear, and any brand whose voice is "established since…". The mood is restrained and dignified: nothing bounces, nothing rounds aggressively, hovers fade colors instead of lifting elements. Borders are crisp 1px solids (not opacity-softened like Modern) and the brand color appears sparingly — usually as a hover tint on text and a stripe under category labels.

Layout follows classic catalog conventions: a slim utility bar of italic copy ("Unmatched Quality Since Establishment") sits above a tall main header with left-nav / centered-logo / right-nav, then a thin centered search input below a hairline. The hero pairs a serif headline with a 12px accent rule and a "Est. 1990"-style date stamp. Product cards are square (`aspect-square`) with crisp borders, centered serif names, and a slide-up dark overlay that reveals the "Add to Bag" action — echoing how a luxury catalog would reveal pricing on flip cards. The footer uses a soft `bg-gray-50` with serif column titles, aligning with editorial print conventions.

**Key Characteristics:**

- Formal, heritage mood — luxury and traditional retail
- Centered logo with split left/right desktop navigation around it
- `font-serif` (Playfair Display) used everywhere for display, nav, prices, and even badge labels
- Square corners as default — `rounded-none` borders, `border border-border` (no opacity softening)
- Hairline accent rules: `w-12 h-px bg-foreground` or `bg-border` mark sections and CTAs
- Underline-on-hover navigation: `after:w-0 after:h-px after:bg-foreground hover:after:w-full transition duration-300`
- High-contrast solid CTAs: `border border-foreground bg-foreground text-background`, hover dampens to `bg-foreground/90`
- Tracking-widest uppercase for badges, button labels, footer headings: `tracking-widest uppercase text-xs`
- No card lift, no scale-105 on cards (only the image scales) — surfaces stay anchored
- Single chromatic accent allowed: brand `--primary` on hover ("Add to Bag" hover, "Pieces" count, category title)

## 2. Color Palette & Roles

Classic consumes the shared CSS tokens from `globals.css`. Tenants override `--primary` per-store through `StoreContext`; the template stays neutral and lets the brand color earn its appearance only on hover and on the announcement bar.

### Background Surfaces

- **Page** (`--background` / white default): The canvas for hero, header, product grid, cart.
- **Card** (`--card` / white): Implicit — Classic places content directly on `--background` with a `border border-border` to outline cards rather than using `bg-card` color shifts.
- **Muted** (`--muted` / `210 20% 96%`): Image placeholders only. Never used as a card surface.
- **Footer** (`bg-gray-50 dark:bg-muted/30`): Lightly tinted neutral, the only background that varies from page color, anchoring the bottom of the page editorially rather than dramatically (compare to Modern's `bg-gray-950`).
- **Top utility bar** (`bg-foreground text-background`): The thin top strip above the main header — a hard inversion that signals authority.

### Text & Content

- **Foreground** (`--foreground`): Headings, prices, navigation hover, logo wordmark.
- **Foreground/70**: Resting nav links — subdued so hover-to-100% feels like an editorial reveal.
- **Foreground/60**: Action icons (search, account, cart) — even more subdued.
- **Muted Foreground**: Subtitles, "Est. 1990" date stamp, prices in card grid, "pieces" count, footer copyright.
- **Border** (`--border`): Solid 1px borders on cards, inputs, summary panels.

### Brand & Accent

- **Primary** (`--primary` / Force Orange `#ff6e00` default): Used sparingly — `hover:text-primary` on product names and add-to-cart, focus rings (`focus-visible:ring-2 focus-visible:ring-primary`), the hairline `w-12 h-px bg-primary group-hover:w-12` underline animation under category names. Default-state primary appears only on the announcement bar (which uses `bg-primary` from `globals.css`'s shared `.product-badge` system, not in this template's bar — see Section 4).
- **Primary/20** in fallback states: `bg-primary/20` for letter-avatar in CategoryCard placeholder (`text-3xl font-light text-primary tracking-wide`).

### Status Colors

- **Success** (`--success`): "Free" shipping label in OrderSummary, "Discount" line.
- **Destructive** (`--destructive`): "Remove" link hover in CartTable.

### Border & Divider

- **Border** (`--border`): Solid throughout — `border border-border`, `border-y border-border`, `divide-y divide-border`. Classic does NOT soften borders to `border-border/60` (that's Modern). Hairline rules use `h-px bg-border` (1px tall, full color) or `h-px bg-foreground` (for the formal accent above the hero CTA).

### Overlay

- **Hover wash on category image**: `bg-foreground/0 group-hover:bg-foreground/5 transition-colors duration-500` — almost imperceptible.
- **Quick-add overlay on product card**: `bg-foreground/90 py-3 translate-y-full group-hover:translate-y-0` — 90% opacity dark band slides up from bottom.

## 3. Typography Rules

### Font Family

- **Display / Nav / Prices / Badges**: `--font-serif` → `'Playfair Display', Georgia, serif`. Applied via Tailwind's `font-serif` utility.
- **Body**: Default body uses `--font-sans` (Plus Jakarta Sans) inherited from `<body>`, but Classic overrides on most visible text with `font-serif`.
- **Arabic**: `--font-arabic` → IBM Plex Sans Arabic (auto-applied via `[dir="rtl"]`).
- **Font features**: `'cv11', 'ss01'` enabled globally on body — but Classic primarily uses Playfair Display, where these features have no effect.

### Hierarchy

| Role                   | Class                                                                                                              | Weight    | Notes                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------ |
| Hero headline          | `text-4xl md:text-5xl lg:text-6xl font-serif font-normal leading-[1.1] tracking-tight`                             | 400       | Restrained — no bold. Serif elegance over weight.      |
| Hero subtitle          | `text-base md:text-lg font-light leading-relaxed text-muted-foreground`                                            | 300       |                                                        |
| Section heading (grid) | `text-2xl md:text-3xl lg:text-4xl font-serif font-normal`                                                          | 400       | Flanked by `w-12 h-px bg-border` rules above and below |
| Form heading           | `text-2xl font-semibold tracking-tight`                                                                            | 600       | Sans here — exception                                  |
| Product name           | `font-serif text-sm md:text-base leading-snug`                                                                     | 400       | Centered, hover shifts to `text-primary`               |
| Product price          | `font-serif text-muted-foreground`                                                                                 | 400       | Centered                                               |
| Order summary heading  | `text-xs font-semibold uppercase tracking-widest text-muted-foreground`                                            | 600       | Tiny eyebrow                                           |
| Order summary total    | `text-lg font-semibold tracking-tight text-foreground`                                                             | 600       |                                                        |
| Nav link               | `text-sm font-serif tracking-widest uppercase text-foreground/70`                                                  | 400       | Underline reveals on hover                             |
| Footer column heading  | `font-serif text-xs uppercase tracking-[0.2em] text-foreground`                                                    | 400       |                                                        |
| Top utility bar copy   | `text-xs tracking-wide font-serif italic`                                                                          | 400       | "Unmatched Quality Since Establishment"                |
| CTA label              | `font-serif text-sm tracking-widest uppercase` (hero), `text-xs font-semibold uppercase tracking-widest` (summary) | 400 / 600 |                                                        |
| Badge label            | `font-serif tracking-widest uppercase text-[10px]`                                                                 | 400       | `rounded-none bg-foreground text-background`           |
| "Est. 1990" stamp      | `text-xs tracking-[0.3em] uppercase text-muted-foreground`                                                         | 400       |                                                        |

### Principles

- **Serif first**: When in doubt, reach for `font-serif`. The exceptions are utility text (form fields, OrderSummary numerics) and explicit sans choices for stronger hierarchy (FormCard heading, summary heading).
- **Tracking is wide and uppercase for labels**: `tracking-widest uppercase` (or `tracking-[0.2em]` / `tracking-[0.3em]`) is the signature — used on nav, badges, button labels, eyebrows.
- **Weight stays light**: 300–400 dominates. The only reach into 600+ is the OrderSummary total, the form heading, and the tracking-widest summary eyebrow.
- **Hero headline is `font-normal` (400) — never `font-bold`**: Elegance comes from the serif glyphs and the `tracking-tight leading-[1.1]` compression, not weight.
- **Italic is reserved for the top utility line** ("Unmatched Quality Since Establishment") — a single tasteful flourish.

## 4. Component Stylings

### Buttons

**Hero CTA (outlined → fill on hover)**

```
group inline-flex items-center gap-3 border border-foreground px-8 py-3
font-serif text-sm tracking-widest uppercase text-foreground
hover:bg-foreground hover:text-background transition-colors duration-300
```

**OrderSummary CTA / EmptyState CTA (solid)**

```
flex h-12 w-full items-center justify-center
border border-foreground bg-foreground px-4 text-xs font-semibold uppercase tracking-widest text-background
hover:bg-foreground/90
focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2
```

**Cart Quantity Control**

```
h-11 w-11 text-muted-foreground hover:bg-muted disabled:opacity-40
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground
```

Wrapped in a parent: `flex items-center border border-border` (square corners, divider via box-shadow effect of adjacent `border-x`).

**Cart Remove (text link, not a button)**

```
inline-flex min-h-[44px] items-center text-sm uppercase tracking-widest
text-muted-foreground hover:text-destructive
```

**Quick-Add Overlay (slides up from product card bottom)**

```
absolute bottom-0 inset-x-0 bg-foreground/90 py-3
translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out
[child label] text-background font-serif text-xs tracking-widest uppercase
hover:text-primary hover:bg-transparent
```

### Cards & Containers

**Product Card** — `Link` wrapping a `group block`. The image is the visual frame:

```
relative aspect-square overflow-hidden bg-muted
border border-border group-hover:border-foreground/30 group-hover:shadow-md
transition duration-300 mb-4
```

Below the image, content centers in a `text-center` column with the serif name and centered price.

**Cart Container**

```
divide-y divide-border border border-border bg-background
```

A single bordered block with horizontal dividers — like a printed table.

**Order Summary**

```
border border-border bg-background p-6
```

**Form Card**

```
border border-border bg-background p-8
```

**Empty State**

```
flex flex-col items-center justify-center border border-border bg-background py-16 px-6 text-center
```

### Inputs & Forms

**Header Search (centered, underline-only)**

```
w-full py-1.5 px-0 border-b border-border bg-transparent
font-serif text-sm text-center text-foreground placeholder:text-muted-foreground
focus:outline-none focus:border-foreground transition-colors duration-200
```

There is no rounded box — the entire field is a hairline underline, evoking a department-store directory.

### Badges & Pills

Classic overrides `@ebda/ui`'s `ProductBadge` styling per-instance:

```
font-serif tracking-widest uppercase rounded-none text-[10px]
bg-foreground text-background
```

Square corners (`rounded-none`) and serif uppercase — a crisp tag.

### Navigation

- Top utility bar: `bg-foreground text-background py-2`, italic serif copy on the left, "Contact" / "About" links on the right.
- Main header: `bg-background shadow-sm` with `py-5` for tall stature.
- Logo centered: `mx-auto md:mx-0`, image height `h-14 max-h-14`, fallback wordmark `text-2xl font-serif font-bold tracking-wider`.
- Desktop nav split left/right around the centered logo, each item: `text-sm font-serif tracking-widest uppercase text-foreground/70 hover:text-foreground` with a `after:w-0 after:h-px after:bg-foreground hover:after:w-full transition duration-300` underline.
- Action icons (search/account/cart): `text-foreground/70 hover:text-foreground` with thin-stroke (`strokeWidth={1.5}`) outline icons.
- Cart count: `bg-foreground text-background text-[10px] font-serif w-4 h-4 rounded-full` — small circular counter, not the brand color.
- Below-header search row: `border-t border-border/40 py-3` with the underlined input centered in a `max-w-md`.

### Image Treatment

- Product image aspect: `aspect-square` (1:1) — formal catalog grid.
- Category image aspect: `aspect-[3/4]` (portrait) with `border border-border/50`.
- Hero image: full-bleed inside a `m-6` margin from its column edge, no border-radius.
- Hover: `group-hover:scale-105 transition-transform duration-500 ease-out` — gentle zoom only.
- Image fallback: `border border-border` square wrapper around a thin-stroke icon, or letter-avatar `w-20 h-20 rounded-full bg-primary/20 text-3xl font-light text-primary`.

### Announcement Bar

```
bg-foreground text-background py-3 px-4
[content] text-sm tracking-wide flanked by hidden sm:inline em-dashes "—"
```

No icons or pulse — just centered serif copy in white-on-near-black.

## 5. Layout Principles

### Spacing System

- Tailwind defaults. Classic uses generous vertical breathing — `py-16 md:py-24` for the product grid section, `py-14 lg:py-24` for hero text column.
- Component-internal: cards use `p-6` (summary) or `p-8` (form), padding-rich.
- Product card content: `mb-4` between image and text block; tight `mb-1.5` between name and price.

### Grid & Container

- Container: `container mx-auto px-4` (1400px max).
- Hero: 2-column `grid lg:grid-cols-2 min-h-[560px] lg:min-h-[640px] gap-0` — taller than Modern, no gap (image meets text seamlessly via the `m-6` inset).
- Product grid columns: from shared `getGridColsClass(columns)` helper, default 4-up. Grid gap: `gap-8 md:gap-10` — wider than Modern's `gap-4 md:gap-6` to give serif type room to breathe.
- Footer: `grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-10 lg:gap-12` with the brand column spanning `lg:col-span-2`.

### Whitespace Philosophy

- **Editorial breathing room**: Each section is bracketed with vertical air; the hero text block has a `mb-14` "Est. 1990" stamp far below the CTA, signalling restraint.
- **Section dividers are hairline rules** (`w-12 h-px bg-border`) above and below grid headings — never bold dividers.
- **Cards stand apart** via the gap, not via shadow lift. Shadows appear only on product card hover (`group-hover:shadow-md`).

### Border Radius Scale

- `rounded-full`: cart badge counter only.
- `rounded-none` (default): everything else. Classic's design language is square.
- `rounded-md` / `rounded-lg`: avoid; if used, only on incidental utility elements that don't carry visual weight.

## 6. Depth & Elevation

| Level      | Treatment                                                | Use                                                             |
| ---------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| Flat       | No shadow, `border border-border`                        | Cards, summary, form, empty state — default state               |
| Header     | `shadow-sm` (always-on)                                  | Main header has a constant `shadow-sm` for separation from page |
| Hover Card | `group-hover:shadow-md group-hover:border-foreground/30` | Product card hover — gentle shadow + slightly darker border     |

**Shadow Philosophy**: Classic almost ignores shadow as a design tool. Depth comes from solid 1px borders, hairline rules, and the inversion of the announcement / utility bars. The only resting `shadow-sm` is on the header (subtle separation), and the only hover shadow is on product cards. There is no "lift" — surfaces stay anchored, dignified, like display cases in a department store.

## 7. Do's and Don'ts

### Do

- Use `font-serif` (Playfair Display) for display, navigation, product names, prices, badges, footer headings — it's the template's defining typeface.
- Use `tracking-widest uppercase` (or explicit `tracking-[0.2em]` / `tracking-[0.3em]`) for labels, buttons, badges, eyebrows.
- Use `border border-border` (solid 1px) — don't soften with `/60` opacity.
- Use square corners (`rounded-none` or omit `rounded-*` entirely) for cards, badges, buttons, inputs.
- Use the underline-reveal hover on nav: `after:w-0 hover:after:w-full after:h-px after:bg-foreground transition duration-300`.
- Use the outlined CTA → solid-fill-on-hover pattern: `border border-foreground hover:bg-foreground hover:text-background`.
- Center logos and section headings — Classic is symmetric.
- Pair section headings with `w-12 h-px bg-border` accent rules above and below.
- Reach for `font-normal` (400) on the hero headline — let the serif do the work, not weight.
- Keep `text-foreground/70` as the resting nav link color so hover-to-100% feels like a deliberate brightening.

### Don't

- Don't use `font-sans` for product names or display — that's the Modern signal.
- Don't use `rounded-xl`, `rounded-2xl`, `rounded-full` (except cart counter) — softness undermines the formality.
- Don't use `border-border/60` or any opacity-softened borders — Classic borders are crisp and solid.
- Don't use `font-extrabold` or `font-black` anywhere — maximum weight is `font-semibold` (600), and only on summary totals / form headings.
- Don't use bouncy hover lifts (`hover:-translate-y-0.5`) — surfaces stay put. Only the image inside scales (`group-hover:scale-105`).
- Don't add color to the body text — chromatic primary appears ONLY on hover (text and underline) and on letter-avatar fallbacks.
- Don't use ALL CAPS sentence body — uppercase is reserved for nav labels, badges, buttons, footer eyebrows.
- Don't apply `shadow-xl` or colored shadows — Classic uses `shadow-sm` (header) and `shadow-md` (card hover) only.
- Don't fill the announcement bar with the brand color — Classic's bar is `bg-foreground text-background`, asserting authority over brand.
- Don't render category cards as overlay-on-image — Classic puts the category title BELOW the bordered image, with an underline that grows on hover (`w-0 group-hover:w-12 h-px bg-primary`).

## 8. Responsive Behavior

### Breakpoints (Tailwind defaults)

| Name    | Min Width | Use                                                                                  |
| ------- | --------- | ------------------------------------------------------------------------------------ |
| Default | 0         | Single column, mobile menu hidden, search hidden                                     |
| `sm`    | 640px     | Em-dashes flanking announcement bar reveal                                           |
| `md`    | 768px     | Top utility bar, desktop nav split, search-below-header reveal                       |
| `lg`    | 1024px    | Hero gains image column, product grid → 4-up, footer 5-col, hero headline `text-6xl` |

### Touch Targets

- Quantity controls in CartTable: `h-11 w-11` (44px) — meets WCAG.
- Remove link: `min-h-[44px] inline-flex items-center` — text-as-button with adequate hit.
- Action icons: 5×5 (20px) inside a parent `<a>` — should ideally be wrapped in `p-2` for touch (existing Header uses bare icons, which is borderline; agents extending the template should add `p-2` wrappers for new icon links).

### Collapsing Strategy

- Hero: `text-4xl → md:text-5xl → lg:text-6xl`. Image hidden below `lg:` (`hidden lg:block self-stretch`). Text column gets `lg:pe-12` padding on the side opposite the image.
- Header: utility bar hidden below `md:`. Logo always centered. Action icons split — desktop has full set inside the right-nav cluster; mobile shows account + cart only.
- Search: hidden until `md:` for desktop persistent search; mobile reveals search inside the menu drawer.
- Product grid: `gap-8 md:gap-10` (constant gap; columns from `getGridColsClass` helper).
- Footer: stacks `grid-cols-1 → md:grid-cols-2 → lg:grid-cols-5`, brand column `lg:col-span-2`. Bottom bar `flex-col → sm:flex-row`.
- CartTable rows: same layout at all breakpoints; image `h-28 w-28` flex-shrink-0.

### Image Behavior

- Hero `<Image>` uses `priority` and `sizes="(min-width: 1024px) 50vw, 100vw"` inside an `m-6` inset.
- Product cards: `sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"`, `loading="lazy"`.
- Category cards: portrait `aspect-[3/4]` with hover `group-hover:scale-105`.

## 9. Agent Prompt Guide

When generating new components for the Classic template, treat `Header.tsx`, `Hero.tsx`, and `ProductCard.tsx` as canon. Default typeface to `font-serif` (Playfair Display via `--font-serif`); use `font-sans` only for utility numerics and form fields. Default button/card corners to `rounded-none` (square). Default borders to `border border-border` (solid 1px) — never soften with `/60` opacity. Use `tracking-widest uppercase` plus `font-serif text-xs` for labels, buttons, and badges; use `tracking-[0.3em] uppercase text-xs` for eyebrows ("Est. 1990"-style stamps). Hero headlines use `font-serif font-normal text-4xl md:text-5xl lg:text-6xl tracking-tight leading-[1.1]` — never bold. CTAs: outlined `border border-foreground` that fills to `bg-foreground text-background` on hover with `transition-colors duration-300`. Section headings center inside `w-12 h-px bg-border` accent rules. Brand color flows through `hsl(var(--primary))` and appears only on hover (`hover:text-primary`) and focus rings (`focus-visible:ring-primary`) — never on resting CTAs (those use `bg-foreground`). Cart count badges use `bg-foreground text-background`, not primary. Pair every animated reveal with `transition-* duration-300` (or `duration-500` for image scale). RTL is supported via `dir={isRtl ? 'rtl' : 'ltr'}`, mirrored chevrons (`rotate-180`), and Arabic strings (`isRtl && nameAr ? nameAr : name`). The footer is `bg-gray-50 dark:bg-muted/30` — a soft tint, not a hard dark slab. Above all, restraint: no lifts, no glows, no scale-105 except inside images.

### Quick Token Reference

- Primary CTA (outlined): `border border-foreground px-8 py-3 font-serif text-sm tracking-widest uppercase text-foreground hover:bg-foreground hover:text-background transition-colors duration-300`
- Solid CTA (summary, empty state): `border border-foreground bg-foreground px-4 text-xs font-semibold uppercase tracking-widest text-background h-12 hover:bg-foreground/90`
- Card frame: `border border-border bg-background` (rest), `group-hover:border-foreground/30 group-hover:shadow-md transition duration-300`
- Heading text: `font-serif font-normal text-foreground tracking-tight leading-[1.1]` (display), `text-xs font-semibold uppercase tracking-widest text-muted-foreground` (eyebrows)
- Body text: `text-foreground` (primary), `text-muted-foreground` (secondary), `text-foreground/70` (resting nav)
- Underline reveal: `relative after:absolute after:bottom-0 after:left-0 after:w-0 after:h-px after:bg-foreground after:transition-[width] after:duration-300 hover:after:w-full`
- Section accent rule: `w-12 h-px bg-border mx-auto mb-6` (and same after the heading)

### Example Component Prompts

- "Create a Classic press-quote block: centered, `font-serif font-normal text-2xl md:text-3xl text-foreground leading-snug` quote text, `w-12 h-px bg-border mx-auto my-6` divider, attribution in `text-xs uppercase tracking-widest text-muted-foreground`."
- "Build a feature row: 3 columns at `lg:`, each with a thin-stroke icon (`strokeWidth={1}`), serif heading `font-serif text-lg`, body in `text-sm text-muted-foreground leading-relaxed`. Container has `border-y border-border py-12`."
- "Make an editorial breadcrumb: `text-xs uppercase tracking-widest text-muted-foreground` separated by `·` middle-dots in `text-foreground/70`. Current item is `text-foreground` (no underline)."
- "Design a testimonial card: NO border-radius. `border border-border bg-background p-8`. Quote in `font-serif italic text-foreground leading-relaxed`. Five-star rating in `text-warning` at thin stroke. Attribution in `text-xs uppercase tracking-widest text-muted-foreground` with `mt-6` and a `w-8 h-px bg-border mb-3` rule above."

### Component Patterns to Inherit

- Top utility bar: `hidden md:block bg-foreground text-background py-2` with italic serif copy on the left and right-aligned utility links — extend this for "Free shipping" / locale switcher.
- Centered logo with split nav: `mid = Math.ceil(navigation.length / 2)`; `leftNav` / `rightNav` slices flank the logo.
- Underline-reveal pattern: copy the `after:` pseudo-element technique exactly — Classic does NOT use border-bottom transitions, it uses absolute pseudo-elements so width animates without affecting layout.
