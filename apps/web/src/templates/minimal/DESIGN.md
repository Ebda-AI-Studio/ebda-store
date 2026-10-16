# Minimal Template Design System

## 1. Visual Theme & Atmosphere

The Minimal template is the typography-first, no-chrome storefront — Apple, MUJI, Aesop, Everlane in spirit. There are no card frames, no shadows, no badges, no panel headers, no decorative rules; what's left is type, image, and whitespace. The mood is calm, confident, and ego-less. Where Bold shouts and Elegant whispers, Minimal simply states. It suits beauty essentials, stationery, ceramics, books, premium hardware, and any brand whose product photography can carry the page on its own.

The header auto-hides on scroll-down and re-appears on scroll-up — a courtesy gesture that defers to the content underneath. Logos render at `h-9` (the smallest in the system), nav links sit at `text-[11px] tracking-[0.18em] uppercase`, and even the cart count is a tiny `text-[9px]` superscript without a colored bubble. The hero is a single centered headline at `text-5xl md:text-6xl lg:text-7xl xl:text-8xl font-light`, a one-line subtitle, and a text-link CTA — followed by a `aspect-[21/9]` full-bleed cinematic image. No splits, no overlays, no italic flourishes.

Product cards have no borders and no shadows; they're an `aspect-[3/4]` image on `bg-muted/30` with the name and price below in tracking-wide uppercase whisper-text. Hover only fades the image (`group-hover:opacity-80`) and shifts the name color (`text-muted-foreground group-hover:text-foreground`). Cart rows are separated by raw whitespace (`space-y-10`), the order summary is just a `dl` of lines with a hairline divider above the total, and the form is type only — no rounded card, no bordered box, no shadow.

**Key Characteristics:**

- Typography-first, no chrome — products earn the page
- No borders, no shadows, no card backgrounds on resting cards/panels
- Header auto-hides on scroll-down, re-appears on scroll-up (`translate-y-0` ↔ `-translate-y-full`)
- Smallest type system in the family: nav at `text-[11px]`, product names at `text-xs`, price at `text-[11px]`, cart counter at `text-[9px]`
- `tracking-[0.15em]` to `tracking-[0.3em]` plus `uppercase` is the identity rhythm
- Type weights stay 300–400 — `font-light` and `font-normal` (and the unstyled default for prices)
- Hero headline reaches `text-8xl` at `xl:` — bigger than Modern's hero, but at `font-light` instead of Bold's `font-black`
- Hero image is `aspect-[21/9]` full-bleed cinematic — the only chrome the template offers
- CTAs are TEXT LINKS with hover-shift (`hover:text-primary` or `hover:border-primary`) — no button shapes, except the cart's checkout action (a filled button, C-03)
- `transition-colors duration-200` to `duration-300` — quick but unhurried
- Cart counter is a numeric superscript (`text-[9px]` next to the cart icon) — no colored badge
- All corners default to `rounded-none` — the few exceptions (cart-counter implied position, image rounding) are also unrounded

## 2. Color Palette & Roles

Minimal uses the smallest slice of the token palette of any template. Most surfaces are `--background`. Most text is `--muted-foreground` resting and `--foreground` on hover. The brand `--primary` color appears ONLY on hover transitions and focus rings — never as a default fill, never as a structural element.

### Background Surfaces

- **Page** (`--background`): The dominant surface — header, hero, product grid, cart, summary, form, footer all sit on `--background`. Footer is also `bg-background` (no tint), distinguished only by `border-t border-border/20` and `mt-auto`.
- **Image Backgrounds** (`bg-muted/30` on product cards, `bg-muted` on hero fallback): A near-imperceptible tint that gives image edges definition before they load.
- **Category fallback gradient** (`bg-gradient-to-br from-primary/10 to-primary/5`): The only place the brand color appears in resting state — and even then it's a 5–10% tint behind a letter-avatar.

### Text & Content

- **Foreground** (`--foreground`): Hero headline, hero CTA resting, total amount, form heading, cart item name resting, navigation hover.
- **Foreground (default body)**: Cart total, summary total, "Total" label.
- **Muted Foreground** (`--muted-foreground`): Product name resting, price, hero subtitle, nav link resting, cart row metadata, footer copyright, social labels, all secondary text. Minimal leans heavily on muted-foreground — most copy lives there.

### Brand & Accent

- **Primary** (`--primary`): Used ONLY on:
  - `hover:text-primary` on hero CTA, empty state link, OrderSummary text-link
  - `hover:border-primary` on the bottom-border CTA bar (`border-b border-foreground hover:border-primary`)
  - `focus-visible:ring-2 focus-visible:ring-primary` rings
  - Letter-avatar on category fallback (`bg-primary/20 text-primary` for the first character)
  - Decorative gradient backgrounds on category fallback (`bg-gradient-to-br from-primary/10 to-primary/5`)
- The brand color does NOT appear on the announcement bar (Minimal's bar is `bg-foreground text-background`), CTAs, badges (there are none), or counters.

### Status Colors

- **Success** (`--success`): "Free" shipping label and "Discount" line in OrderSummary — used at full color, no uppercase tracking treatment.
- **Destructive** (`--destructive`): "Remove" hover in CartTable (`hover:text-destructive`), focus-visible ring on remove (`focus-visible:ring-destructive`).

### Border & Divider

- **Border/20** (`border-border/20`): Footer top divider — the most subdued divider in the system.
- **Border** (`--border`): Search underline (`border-b border-border`), cart counter implicit alignment, summary total divider (`border-t border-border pt-5`), form field underlines (when used).
- **Foreground** (`--foreground`): The one strong divider/border in Minimal — the bottom-border CTA underline (`border-b border-foreground pb-1`). This single hairline is the only "button" Minimal acknowledges.

### Overlay

- None. Minimal does NOT use overlays. There are no scrims, no `bg-foreground/10` tints on hover, no backdrop-blur frosted-glass quick-add overlays. The image fades from 100% to 80% opacity on hover (`group-hover:opacity-80`) — and that's the entirety of the hover language.

## 3. Typography Rules

### Font Family

- **Display / Body**: `--font-sans` → Plus Jakarta Sans (`font-sans` Tailwind class — but Minimal rarely needs it explicitly because the body inherits sans).
- **Arabic**: IBM Plex Sans Arabic.
- **Font features**: `'cv11', 'ss01'` enabled globally on body.
- **No `font-serif` anywhere** — that's Classic / partial Elegant.

### Hierarchy

| Role                       | Class                                                                                   | Weight        | Notes                                      |
| -------------------------- | --------------------------------------------------------------------------------------- | ------------- | ------------------------------------------ |
| Hero headline              | `text-5xl md:text-6xl lg:text-7xl xl:text-8xl font-light tracking-tight leading-[1.05]` | 300           | Centered, single block                     |
| Hero subtitle              | `text-base md:text-lg font-light leading-relaxed text-muted-foreground`                 | 300           | `max-w-sm mx-auto`                         |
| Hero CTA                   | `text-[11px] tracking-[0.2em] uppercase text-foreground hover:text-primary`             | 400           | Text link with arrow chevron               |
| Section heading (grid)     | `text-sm tracking-[0.2em] uppercase text-muted-foreground`                              | 400           | Centered eyebrow, `mb-16` below            |
| Form heading               | `text-2xl text-foreground`                                                              | 400 (default) | No bold, no uppercase                      |
| Form subtitle              | `text-sm text-muted-foreground`                                                         | 400           |                                            |
| Order summary total label  | `text-foreground`                                                                       | 400           | No uppercase, no tracking                  |
| Order summary total amount | `text-lg text-foreground`                                                               | 400           |                                            |
| Empty state title          | `text-2xl text-foreground`                                                              | 400           |                                            |
| Empty state body           | `text-sm text-muted-foreground`                                                         | 400           |                                            |
| Product name               | `text-xs tracking-wide uppercase font-light text-muted-foreground`                      | 300           | Hover shifts to `text-foreground`          |
| Product price              | `text-[11px] tracking-wide font-light text-muted-foreground`                            | 300           |                                            |
| Cart item name             | `text-sm font-medium text-foreground`                                                   | 500           | Slightly bolder for legibility on cart row |
| Cart item price            | `text-sm text-muted-foreground`                                                         | 400           |                                            |
| Nav link                   | `text-[11px] tracking-[0.18em] uppercase font-light text-muted-foreground`              | 300           |                                            |
| Logo wordmark fallback     | `text-xs tracking-[0.3em] uppercase font-light text-foreground`                         | 300           |                                            |
| Footer link                | `text-[11px] tracking-wide text-muted-foreground`                                       | 400           |                                            |
| Footer social label        | `text-[10px] tracking-widest uppercase text-muted-foreground`                           | 400           | Plain text, no icon                        |
| Footer copyright           | `text-[10px] text-muted-foreground`                                                     | 400           |                                            |
| Cart counter               | `text-[9px] font-light text-foreground`                                                 | 300           | Tiny number, no bubble                     |
| Announcement bar           | `text-xs tracking-[0.15em] uppercase`                                                   | 400 (default) |                                            |

### Principles

- **Type weights stay 300–500.** `font-light` (300) is the dominant heading weight; `font-normal` (400, default) handles body and labels; `font-medium` (500) appears only on cart item names for legibility on a small thumbnail row. NO `font-semibold`, NO `font-bold`, NO `font-black`.
- **Tiny labels with letter-spacing**: 10–11px text at `tracking-[0.15em]` to `tracking-[0.3em]` is the small-end identity. Headlines balance with `tracking-tight`.
- **Hero is a single block**: NO eyebrow, NO italic-accent split, NO accent rule. Just the headline, subtitle, and CTA — three lines centered.
- **Body styles inherit defaults** more often than other templates. Form headings, empty-state titles, summary totals are unstyled with weight — relying on size and color alone.
- **No uppercase on prose** — only on nav, eyebrows, product names, social labels, announcement, footer link tracking. Hero headline, subtitles, cart item names, summary totals, form headings stay sentence case.

## 4. Component Stylings

### Buttons / Links

Minimal does NOT have buttons in the conventional sense. It has TEXT LINKS that hover to primary or shift their bottom-border to primary. The one exception is the cart's checkout action (C-03, 2026-10-16): the money step must be the heaviest element on the cart, so the OrderSummary CTA is a filled button.

**Hero CTA**

```
group inline-flex items-center gap-2
text-[11px] tracking-[0.2em] uppercase text-foreground hover:text-primary
transition-colors duration-200
```

Followed by an inline chevron icon (`w-4 h-4 strokeWidth={1}`) that translates `0.5px` on hover.

**OrderSummary CTA (filled, C-03)**

```
flex h-12 w-full items-center justify-center gap-2 rounded-[var(--radius)] bg-primary px-4
text-sm font-medium text-primary-foreground hover:bg-primary/90
focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground
```

Label from `lib/checkout-cta.ts` ("Checkout / إتمام الطلب", the sticky bar's key), followed by the mirrored `ArrowIcon`.

**EmptyState CTA (bottom-border underline)**

```
border-b border-foreground pb-1 text-sm text-foreground
hover:border-primary hover:text-primary
focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-foreground
```

Suffix: ` →` rendered as text. Always shown as `block` or `block w-fit`.

**Header Icon Button**

```
p-2.5 text-muted-foreground hover:text-foreground transition-colors duration-200
```

Outline icons at `strokeWidth={1}` — the thinnest stroke in the system.

**Cart Quantity Control**

```
inline-flex h-11 w-11 items-center justify-center text-muted-foreground
hover:text-foreground disabled:opacity-30
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
```

Plain `−` and `+` symbols, no border around them.

**Cart Remove**

```
inline-flex min-h-[44px] items-center text-xs
hover:text-destructive
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive
```

Plain text "Remove", no underline, color-shift only.

### Cards & Containers

**Product Card** — pure image + text:

```
group block cursor-pointer
[image] relative aspect-[3/4] overflow-hidden bg-muted/30 mb-5
[content] space-y-1 (text-left or text-right per RTL)
```

NO border, NO shadow, NO badges, NO quick-add overlay. Hover only fades the image (`group-hover:opacity-80 transition-opacity duration-300`) and lifts the name color from muted to foreground.

**Cart Container**

```
space-y-10
```

Just space — items are separated by `gap-5` flex internally and `space-y-10` vertical whitespace between rows. NO borders, NO dividers, NO backgrounds.

**Order Summary**

```
[no outer container]
[content] dl with space-y-4 text-sm
[total divider] border-t border-border pt-5
```

The summary is essentially a `<dl>` floating on the page.

**Form Card**

```
[no outer container]
w-full max-w-md space-y-8
[header] (just an h1 + p, no card wrap)
```

**Empty State**

```
flex flex-col items-start py-20
```

Left-aligned, no container, no border. The icon (if provided) sits on top with no decorative wrap.

**Category Card**

```
[image] aspect-square bg-gradient-to-br from-primary/10 to-primary/5 overflow-hidden mb-4
[title] text-sm font-normal text-foreground group-hover:text-primary transition-colors
```

Square (1:1) image on a soft primary gradient when there's no image.

### Inputs & Forms

**Header Search (centered, underline-only, expandable)**

```
w-full text-center text-xs tracking-wide bg-transparent
border-b border-border text-foreground placeholder:text-muted-foreground
focus:outline-none focus:border-foreground pb-2 transition-colors duration-200
```

Wrapped in `max-w-xs mx-auto` — narrow, centered, no submit button (Enter to submit).

### Badges & Pills

**There are NO badges in Minimal.** The product card does not render `ProductBadge` at all. No "New", no "Sale", no "Sold Out" overlays. If a product is sold out, the card simply doesn't render an add-to-cart action (which it never does anyway — Minimal has no quick-add overlay). Pricing speaks for itself.

The only "pill" is the cart counter, which isn't actually a pill: `text-[9px] font-light text-foreground` positioned `-top-1.5 -right-1.5` next to the cart icon — a numeric superscript with no background.

### Navigation

- Header: `sticky top-0 z-50 bg-background transition-transform duration-300 ease-in-out` with state-driven `translate-y-0` ↔ `-translate-y-full` for scroll-direction hide/reveal.
- Logo: `h-9 max-h-9 w-auto` — smallest of the 5 templates. Fallback wordmark: `text-xs tracking-[0.3em] uppercase font-light`.
- Nav: absolutely centered (`absolute left-1/2 -translate-x-1/2`) at `lg:` and up. Each link `text-[11px] tracking-[0.18em] uppercase font-light text-muted-foreground hover:text-foreground transition-colors duration-200`.
- Action icons: `p-2.5 text-muted-foreground hover:text-foreground` with `strokeWidth={1}` outline icons.
- Cart counter: `text-[9px] font-light text-foreground` superscript — no badge, no color.
- Mobile menu: collapse to a vertical centered `space-y-5` list, no drawer slide-in.

### Image Treatment

- Product image aspect: `aspect-[3/4]` on `bg-muted/30`.
- Category image aspect: `aspect-square` on `bg-gradient-to-br from-primary/10 to-primary/5`.
- Hero image aspect: `aspect-[21/9]` cinematic full-bleed below the centered text block.
- Cart image: `aspect-[3/4] w-20` on `bg-muted/30` — small, portrait.
- Hover behavior on product card: `group-hover:opacity-80 transition-opacity duration-300 ease-out` — opacity-only, no scale.
- Hover on category card: `group-hover:scale-102 transition-transform duration-500` — gentle 1.02× scale on the image only.
- Image fallback (product): `flex items-center justify-center text-muted-foreground` with `strokeWidth={0.5}` icon at `w-10 h-10` — even thinner stroke than Elegant.

### Announcement Bar

```
bg-foreground text-background py-2 px-4 text-center
[content] text-xs tracking-[0.15em] uppercase
```

Minimal's announcement is `bg-foreground` (near-black on light theme), NOT `bg-primary`. No emoji, no arrow, no marquee — just centered tracking-uppercase copy. If a link is provided, the entire bar becomes a link with `hover:opacity-70`.

## 5. Layout Principles

### Spacing System

- Tailwind defaults — but Minimal pushes vertical breathing room: `py-24 md:py-32` for the product grid section, `py-20` for the empty state, `mt-auto py-12 md:py-16` for the footer.
- Cart row spacing: `space-y-10` between rows — rows aren't separated by dividers, only by raw whitespace.
- Hero text-block padding: `pt-20 pb-14` — generous on top, lighter on bottom because the hero image sits flush below.
- Container padding: `container mx-auto px-6` — Minimal uses `px-6` (24px) on most pages, slightly wider than the `px-4` of Modern/Bold/Classic — giving small text more rest at viewport edges.

### Grid & Container

- Container: `container mx-auto` with `px-6` (Minimal) or `px-4` (rare). Max 1400px from `--container-max`.
- Hero: text block `text-center` inside `container`, then the cinematic image `aspect-[21/9]` full-bleed (NO container constraint on the image).
- Product grid: `getGridColsClass(columns)` default 4-up, `gap-6 md:gap-8`. Section: `py-24 md:py-32`.
- Footer: single horizontal row at `md:` and up — `flex flex-col md:flex-row items-start md:items-center justify-between gap-8`. Links flow as a flat horizontal list, not a grid.

### Whitespace Philosophy

- **Whitespace is the system.** With no borders, shadows, or card backgrounds, every separation is achieved through space. `space-y-10` cart rows, `mb-16` between section eyebrow and grid, `py-24` section padding — these aren't decorations, they're the entire visual structure.
- **Small type, big rest**: 11px nav links breathe inside `gap-10` flex spacing; 9px cart counters earn their tiny size by having `space-y-` air around them.
- **Single-block hero**: The hero text block is centered in `text-center` with `max-w-sm mx-auto` for the subtitle — Minimal trusts the user to scan a single block, not a grid of features.

### Border Radius Scale

- `rounded-none` everywhere by default.
- The few rounded elements are intentional fallback affordances: the category fallback letter-avatar uses `rounded-full bg-primary/20`, but only when an image is missing.
- No buttons have radius (because there are no buttons).
- No badges have radius (because there are no badges).

## 6. Depth & Elevation

| Level             | Treatment                                                  | Use                         |
| ----------------- | ---------------------------------------------------------- | --------------------------- |
| Flat              | No border, no shadow, no background                        | Default for everything      |
| Hairline          | `border-t border-border`                                   | Order summary total divider |
| Hairline (subtle) | `border-t border-border/20`                                | Footer top divider          |
| Hairline (CTA)    | `border-b border-foreground pb-1`                          | Bottom-border text-link CTA |
| Color shift       | `hover:opacity-80` on images, `hover:text-primary` on CTAs | Hover language              |
| Sticky retract    | `translate-y-0` ↔ `-translate-y-full`                      | Header on scroll            |

**Shadow Philosophy**: Minimal uses ZERO box-shadows. There are no `shadow-sm`, `shadow-md`, `shadow-xl`, `shadow-2xl`, no colored shadows, no inset shadows. Depth is communicated entirely through hairline dividers (`border-t border-border`) and intentional whitespace. The most "elevation" the template offers is the header itself, which lives at `z-50` and animates `translate-y` on scroll-direction change. Even product cards on hover do NOT shadow — they fade.

## 7. Do's and Don'ts

### Do

- Use `font-light` (300) on display headlines, nav links, product names, prices, logo wordmark.
- Use `font-normal` (400, default) for body, labels, eyebrows, cart item prices, summary totals.
- Use `tracking-[0.15em]` to `tracking-[0.3em]` plus `uppercase` for nav, eyebrows, product names, social labels, announcement.
- Use `tracking-tight` only on the hero headline; everything else is normal or wide-tracked.
- Use TEXT LINKS instead of buttons — `text-[11px] tracking-[0.2em] uppercase hover:text-primary` for top-level CTAs, `border-b border-foreground pb-1 hover:border-primary` for primary actions.
- Use `text-muted-foreground` as the resting color for nav links, product names, prices, secondary copy — `hover:text-foreground` is the brightening reveal.
- Use `aspect-[3/4]` for products, `aspect-square` for categories, `aspect-[21/9]` for the hero image.
- Use `bg-muted/30` (not `bg-muted`) under product images — the lighter tint is more invisible.
- Use the auto-hide header pattern (`translate-y-0` ↔ `-translate-y-full` on scroll direction) — it's the template's signature courtesy.
- Use `space-y-10` between cart rows instead of dividers — whitespace IS the structure.
- Use `text-[9px] font-light text-foreground` cart counters as superscripts, not badges.
- Use `border-b border-foreground pb-1` text-link CTAs on the OrderSummary and EmptyState — the bottom-border IS the button.
- Use `strokeWidth={1}` on header icons (`{1}` for header, `{0.5}` for empty product fallback).

### Don't

- Don't add backgrounds, borders, or shadows to product cards, summary panels, form panels, or empty-state containers — emptiness is the design.
- Don't use `font-bold`, `font-extrabold`, or `font-black` anywhere — weight ceiling is `font-medium` (500), and only for cart item names. Headlines stay `font-light` (300).
- Don't use `bg-primary` as a default fill on CTAs, buttons, or panels — primary appears ONLY on hover transitions and focus rings (and on category fallback gradients at `/10` and `/5`).
- Don't add `ProductBadge`s — Minimal renders no "New" / "Sale" / "Sold Out" labels. Pricing carries the message.
- Don't use box-shadows of any kind — `shadow-sm`, `shadow-md`, `shadow-xl` are all forbidden. Depth is hairline + whitespace only.
- Don't soften corners — `rounded-none` is default. The `rounded-full` letter-avatar is the ONLY rounded element, and it's a fallback.
- Don't fill the announcement bar with `bg-primary` — Minimal's announcement is `bg-foreground text-background`, not chromatic.
- Don't use long display sizes at heavy weights — Minimal's `text-8xl` works because it's `font-light`. A `font-black` 8xl headline is Bold's territory.
- Don't add `cartPulse` or any micro-animation to the cart counter — Minimal's counter is silent.
- Don't use sentence case for nav, eyebrows, product names, social labels — UPPERCASE plus tracking is the small-text language.
- Don't render quick-add overlays on product cards — Minimal's product card has zero overlays. Click leads to PDP; no in-grid actions.
- Don't reduce whitespace to "fit more" — Minimal is intentionally sparse. Trim copy before trimming space.

## 8. Responsive Behavior

### Breakpoints

| Name    | Min Width | Use                                                                                         |
| ------- | --------- | ------------------------------------------------------------------------------------------- |
| Default | 0         | Single column, mobile menu hidden, hero `text-5xl`                                          |
| `sm`    | 640px     | Account icon shows in header (`hidden sm:block`), footer `flex-row` partial                 |
| `md`    | 768px     | Hero `text-6xl`, footer single-row layout, `px-6` consistent                                |
| `lg`    | 1024px    | Hero `text-7xl`, full nav (`hidden lg:flex` absolutely centered), product grid full columns |
| `xl`    | 1280px    | Hero `text-8xl` — biggest jump                                                              |

### Touch Targets

- All clickable elements use `h-11`/`w-11` (44px) where space allows: quantity controls, remove links.
- Header icons: `p-2.5` (~36px hit area). Borderline; agents adding new icon links should preserve `p-2.5` minimum.
- Nav links: `text-[11px]` is small but `gap-10` between links keeps tap targets separated by ~40px.
- Bottom-border CTAs: `block` or `block w-fit` plus `min-h-[44px]` is implicit via the `pb-1` plus surrounding `space-y-` — agents should explicitly add `min-h-[44px]` if creating new ones.

### Collapsing Strategy

- Hero: `text-5xl → md:text-6xl → lg:text-7xl → xl:text-8xl` — gradual escalation. Hero image stays `aspect-[21/9]` at all breakpoints.
- Header: nav `hidden lg:flex` (later breakpoint than other templates — Minimal's nav is absolutely centered and needs the room). Mobile reveals a vertical centered menu without a drawer.
- Header auto-hide: works at all breakpoints based on `lastScrollY` state.
- Product grid: `gap-6 md:gap-8`, columns from `getGridColsClass`.
- Footer: `flex-col md:flex-row` — mobile stacks brand / nav / social vertically; desktop is a single horizontal row.
- Cart rows: stay full-width with `gap-5` flex; image `w-20` constant.

### Image Behavior

- Hero `<Image fill />` with `priority` and `sizes="100vw"`, full-bleed cinematic.
- Product cards: `sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"`, `loading="lazy"`. Hover: `group-hover:opacity-80 transition-opacity duration-300`.
- Category cards: hover `group-hover:scale-102 transition-transform duration-500` — Tailwind's `scale-102` (102%) is unusual; agents should preserve this exact value.
- Image fallback (product): `strokeWidth={0.5}` icon at `w-10 h-10` — the thinnest stroke in the template family.

## 9. Agent Prompt Guide

When generating new components for the Minimal template, treat `Hero.tsx`, `ProductCard.tsx`, and `Header.tsx` as canon. Default to NO border, NO shadow, NO background — emptiness is the visual structure. Default typography to `font-light` (300) for display, `font-normal` (400, default) for body and labels — NEVER reach `font-bold` or higher; the ceiling is `font-medium` (500), used only on cart item names. Default labels to ALL CAPS with `tracking-[0.15em]` to `tracking-[0.3em]` and tiny sizes (10–12px); display headlines stay sentence case at `text-5xl md:text-6xl lg:text-7xl xl:text-8xl font-light tracking-tight`. Default CTAs to TEXT LINKS — either inline text (`text-[11px] tracking-[0.2em] uppercase hover:text-primary`) or bottom-border underline (`border-b border-foreground pb-1 hover:border-primary`). Brand `--primary` is reserved for hover transitions, focus rings, and category fallback gradients ONLY — never use as a default fill. Image aspect ratios: `aspect-[3/4]` for products on `bg-muted/30`, `aspect-square` for categories on a primary gradient, `aspect-[21/9]` for hero cinematic full-bleed. Hover language is opacity-only on images (`group-hover:opacity-80`) and color-shift on text (`group-hover:text-foreground`) — no scale, no shadow, no lift. Use `transition-colors duration-200` for color shifts and `transition-opacity duration-300` for image fades. Container padding is `px-6` on most surfaces (slightly wider than other templates) to give small type breathing room. The header auto-hides on scroll-down and re-appears on scroll-up via state-driven `translate-y-0` ↔ `-translate-y-full` — preserve this courtesy when modifying the header. There are NO badges in the template; do not add `ProductBadge`. There are NO panel headers, NO label strips, NO inverted-strip patterns. The announcement bar is `bg-foreground text-background` (not primary). Cart counters are `text-[9px] font-light text-foreground` superscripts, never colored badges. RTL is supported via `dir`, mirrored chevrons (`rotate-180`), and Arabic strings (`isRtl && nameAr ? nameAr : name`). When in doubt: remove a border, lighten a weight, add more whitespace.
