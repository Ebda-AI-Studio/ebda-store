# Bold Template Design System

## 1. Visual Theme & Atmosphere

The Bold template is the high-energy, brutalist-leaning storefront — built for streetwear, sneaker drops, gaming gear, energy drinks, sports merch, and any brand that wants to shout. The aesthetic is loud and direct: heavy 2px borders that don't soften, ALL CAPS `font-black` headlines, hard inversions (`bg-foreground text-background`), and punchy chromatic primary as a primary structural element rather than an accent. There's no subtlety here — every CTA looks pressable, every block has weight, every hover scales aggressively (`hover:scale-[1.02]` to `hover:scale-110`).

The header is an inversion of the rest: `bg-gray-950 text-white` sticky at the top, with the brand logo `brightness-0 invert`-treated to read as white on near-black. The hero takes a full `min-h-screen` block at `bg-gray-950` with a 65%-opacity overlay over a hero image, a 6xl-to-8xl `font-black uppercase` headline, and a CTA in `bg-primary` with a colored shadow (`shadow-2xl shadow-primary/30`). Product cards are `border-2 border-gray-950/10` square-cornered blocks that scale up and shift their border to `hover:border-primary` on hover. Cart and order summary panels use `border-2 border-foreground` with a header strip in `bg-foreground text-background`, like a labeled crate.

Animations are short and snappy (`duration-200`), with the cart count getting a 600ms `cartPulse` scale-up like Modern, but louder — the surface that holds it is `font-black`. The announcement bar carries a fire emoji, `font-black tracking-wide`, and a forward-arrow `→` glyph. Footer is `bg-gray-950 text-white` with `font-black uppercase tracking-[0.2em]` column titles and primary as the link hover.

**Key Characteristics:**

- Brutalist mood — streetwear, drops, sport, gaming
- `border-2 border-foreground` (or `border-2 border-gray-950/10` resting) — heavy 2px borders are signature
- `font-black` (900) on headlines, product names, CTAs, totals, badges, summary headers — the heaviest weight
- ALL CAPS plus `tracking-tight` (display) or `tracking-wider` / `tracking-widest` (labels) — Bold likes density, not airiness
- Hard inversions: `bg-foreground text-background` panel headers, `bg-gray-950 text-white` header + footer
- Hero is `min-h-screen bg-gray-950` with overlay'd image and a 6xl-8xl headline — biggest hero of all 5
- Brand `--primary` appears as a load-bearing color: hero CTA fill, summary CTA fill, announcement bar bg, hover-state borders, badge underline accent
- Square corners (`rounded-none` on CTAs, `rounded-2xl` on the product card frame for a chunky-but-soft look)
- Aggressive hover scale: `hover:scale-[1.02]` on CTAs and category cards, `hover:scale-[1.03]` on product cards, `hover:rotate-1`-style angle shifts on category cards
- Snappy 200ms transitions across the board — Bold doesn't linger
- Iconography: chevron arrows with `strokeWidth={3}` for visual weight

## 2. Color Palette & Roles

Bold consumes `globals.css` tokens and adds two intentional hardcoded surfaces: `bg-gray-950` (header, footer, hero, announcement-as-header overlay context) and `text-white` for content on those surfaces. Every tenant overrides `--primary`, and Bold uses primary aggressively — it's not a quiet accent, it's a structural color.

### Background Surfaces

- **Page** (`--background`): Default page surface for product grid, cart, summary, form, empty state.
- **Card** (`--background` / `--card`): Cards stand on the page background — separation comes from the heavy `border-2`.
- **Header / Footer / Hero** (`bg-gray-950`): Hardcoded near-black (`#030712`) — the dominant dark surface that frames the experience top and bottom.
- **Hero overlay** (`bg-gray-950/65`): 65% opacity over a hero image to keep `text-white` readable.
- **Inverted Header Strip** (`bg-foreground text-background`): Used on OrderSummary header (`bg-foreground` strip with `text-background`) and FormCard header — instant authority.
- **Muted** (`--muted`): Image placeholders, cart thumbs.

### Text & Content

- **Foreground** (`--foreground`): Body text on the page, totals, summary lines.
- **Foreground/70** etc are NOT used much — Bold prefers full opacity. Where a softer shade is needed, it goes to `text-muted-foreground` and stays full-opacity.
- **Muted Foreground**: Secondary labels in summary, "OUT OF STOCK"-style descriptions in empty state — used WITH `font-bold uppercase tracking-wider` to keep the weight.
- **White / Gray-300 / Gray-400** (footer/header): On dark surfaces, Bold uses Tailwind grays directly (`text-white`, `text-gray-300`, `text-gray-400`) to guarantee contrast.

### Brand & Accent

- **Primary** (`--primary` / Force Orange `#ff6e00` default): A LOAD-BEARING color in Bold:
  - Hero CTA fill (`bg-primary text-primary-foreground`) with `shadow-2xl shadow-primary/30`
  - Order summary CTA fill (`bg-primary text-primary-foreground`)
  - Announcement bar fill (`bg-primary text-primary-foreground`)
  - Cart count badge fill (`bg-primary text-primary-foreground text-[10px] font-black`)
  - Header search submit button (`bg-primary text-primary-foreground font-black uppercase tracking-wider`)
  - Hover-state nav underline (`bg-primary scale-x-0 group-hover:scale-x-100`)
  - Product card hover border (`border-2 border-gray-950/10 hover:border-primary`)
  - Footer link hover (`hover:text-primary`)
  - Section divider accent (`w-24 h-2 bg-primary mx-auto rounded-full` under product grid heading)
- **Primary/30 / Primary/5**: Decorative blurred glow accents (e.g., `bg-primary/5 rounded-full blur-3xl` background ambience under product grid).

### Status Colors

- **Success** (`--success`): "FREE" shipping label in OrderSummary (`text-success` — kept short and ALL CAPS).
- **Destructive** (`--destructive`): Trash hover in CartTable (`hover:bg-destructive hover:text-destructive-foreground hover:border-destructive`) — full inversion, not subtle.

### Border & Divider

- **Border-2 + Foreground**: `border-2 border-foreground` on Cart rows, OrderSummary panel, EmptyState container, FormCard frame, Cart quantity selector, Cart remove `×` button. The 2px weight is mandatory.
- **Border-2 + gray-950/10** (resting product card): `border-2 border-gray-950/10` — a 10% black hairline that becomes `border-primary` on hover.
- **White/10** (header/footer dividers): `border-white/10` for dividers on the dark surfaces.

### Overlay

- **Hero image overlay**: `bg-gray-950/65` — 65% dark scrim.
- **Mobile menu scrim**: `bg-black/60` — heavier than Modern's `/40`.
- **Category card gradient**: `bg-gradient-to-t from-black via-black/20 to-transparent` — strong bottom-up gradient so the title sits in pure black.

## 3. Typography Rules

### Font Family

- **Display / Body**: `--font-sans` → Plus Jakarta Sans (the platform default). Bold uses Plus Jakarta exclusively — no `font-serif`.
- **Arabic**: IBM Plex Sans Arabic.
- **Font features**: `'cv11', 'ss01'` enabled globally on body.

### Hierarchy

| Role                      | Class                                                                         | Weight | Notes                                                         |
| ------------------------- | ----------------------------------------------------------------------------- | ------ | ------------------------------------------------------------- |
| Hero headline             | `text-6xl md:text-8xl font-black uppercase tracking-tight leading-[0.9]`      | 900    | Biggest type in the system                                    |
| Hero eyebrow ("New Drop") | `text-xs font-bold tracking-[0.2em] uppercase text-white/70`                  | 700    | Inside a `border border-white/20 rounded-full px-4 py-2` pill |
| Hero subtitle             | `text-lg md:text-xl text-white/60 font-medium leading-relaxed`                | 500    |                                                               |
| Section heading (grid)    | `text-4xl md:text-5xl lg:text-6xl font-black tracking-tight`                  | 900    | Followed by `w-24 h-2 bg-primary rounded-full` accent         |
| Form heading              | `text-xl font-black uppercase tracking-tight`                                 | 900    | On the inverted `bg-foreground` header strip                  |
| Order summary heading     | `text-sm font-black uppercase tracking-widest`                                | 900    | On `bg-foreground text-background` strip                      |
| Order summary total       | `text-2xl font-black tracking-tight`                                          | 900    |                                                               |
| Empty state title         | `text-2xl font-black uppercase tracking-tight`                                | 900    |                                                               |
| Product name              | `text-base font-black uppercase tracking-tight line-clamp-1`                  | 900    | Hover shifts to `text-primary`                                |
| Product price             | `font-black` (size from `<Price>` component, `lg`)                            | 900    |                                                               |
| Cart item name            | `font-black uppercase tracking-tight line-clamp-2`                            | 900    |                                                               |
| Nav link                  | `text-sm font-bold uppercase tracking-wider`                                  | 700    | With `bg-primary scale-x-0 group-hover:scale-x-100` underline |
| Footer column heading     | `text-xs font-black uppercase tracking-[0.2em] text-white`                    | 900    |                                                               |
| Announcement bar          | `font-black tracking-wide` (text-base default)                                | 900    | With 🔥 emoji and `→` arrow                                   |
| CTA label                 | `font-black uppercase tracking-wider` (most), `tracking-widest` (summary CTA) | 900    |                                                               |
| Badge                     | `font-black px-3 py-1.5 rounded-none`                                         | 900    | Square corners, heavy weight                                  |
| Cart count badge          | `text-[10px] font-black rounded-full`                                         | 900    |                                                               |

### Principles

- **`font-black` (900) is the workhorse.** Where Modern uses `font-semibold` (600) and Elegant uses `font-light` (300), Bold uses `font-black` (900). Even nav links sit at `font-bold` (700).
- **`uppercase` on display, headlines, badges, button text, product names, cart item names, summary labels** — only body subtitles, prices, and form-field copy stay sentence case.
- **`tracking-tight` on display** (`leading-[0.9]` to `leading-tight`), **`tracking-wider` / `tracking-widest` on labels** — Bold is dense at scale and spaced when small, opposite of Elegant.
- **No `font-light`, no `font-extralight`, no `font-thin`** — Bold's lightest weight is `font-medium` (500), used on hero subtitles only.
- **Display sizes go bigger than other templates**: `text-6xl md:text-8xl` for hero — Bold takes the whole screen.

## 4. Component Stylings

### Buttons

**Hero CTA (filled, glow, scale on hover)**

```
inline-flex items-center gap-3 px-10 py-5
bg-primary text-primary-foreground rounded-none
font-black text-base uppercase tracking-wider
hover:bg-primary/90 hover:scale-[1.02]
transition-all duration-200
shadow-2xl shadow-primary/30
```

**Order Summary CTA** (48px on every skin, one label "Checkout / إتمام الطلب" from `lib/checkout-cta.ts`, mirrored `ArrowIcon`; C-03)

```
flex h-12 w-full items-center justify-center gap-2
bg-primary px-5 text-sm font-black uppercase tracking-widest text-primary-foreground
hover:bg-primary/90
focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2
```

Suffix: ` →` rendered inline. Wrapped in a `border-t-2 border-foreground` block.

**Empty State CTA**

```
inline-flex h-12 items-center bg-primary px-8
text-sm font-black uppercase tracking-widest text-primary-foreground
hover:bg-primary/90
```

Suffix: ` →` arrow.

**Header Search Submit**

```
px-5 py-2.5 bg-primary text-primary-foreground rounded-lg
font-black uppercase tracking-wider text-sm
hover:bg-primary/80 transition-colors duration-200
```

This is the ONE button in Bold with `rounded-lg` (8px) — it sits inside the dark header where curves are okay.

**Quantity Control (cart)**

```
h-11 w-11 font-black text-foreground
hover:bg-foreground hover:text-background
disabled:opacity-30
```

Inside a `flex items-center border-2 border-foreground` parent with `border-x-2 border-foreground` separating each button.

**Cart Remove (`×` button)**

```
h-11 w-11 border-2 border-foreground bg-background font-black text-foreground
hover:bg-destructive hover:text-destructive-foreground hover:border-destructive
```

A flat `×` glyph, full color inversion on hover.

**Add-to-Cart (product card quick-add)**

```
w-full py-4 rounded-none font-black uppercase tracking-wider text-sm
bg-gray-950 text-white
hover:bg-primary hover:text-primary-foreground
transition-colors duration-200
```

Slides up from the bottom of the card, dark by default, lights up on hover.

### Cards & Containers

**Product Card**

```
group block relative overflow-hidden rounded-2xl
bg-background border-2 border-gray-950/10
hover:border-primary hover:scale-[1.03]
transition-all duration-200
```

Note: `rounded-2xl` here is intentional — it gives the chunky border a softer geometric quality, like a printed sticker. Inside, the image stays `aspect-square` with `rounded-none`.

**Cart Row**

```
flex gap-4 border-2 border-foreground bg-background p-4
```

No rounding — pure crate.

**Order Summary**

```
border-2 border-foreground bg-background
[heading strip] border-b-2 border-foreground bg-foreground px-5 py-3 text-sm font-black uppercase tracking-widest text-background
[content] space-y-3 p-5
[children divider] border-t-2 border-foreground p-5
[CTA strip] border-t-2 border-foreground (CTA fills full width)
```

**Form Card**

```
border-2 border-foreground bg-background
[header] border-b-2 border-foreground bg-foreground px-6 py-4 text-center
[heading] text-xl font-black uppercase tracking-tight text-background
[body] p-6
```

**Empty State**

```
flex flex-col items-center justify-center
border-2 border-foreground bg-background py-16 px-6 text-center
```

**Category Card**

```
relative aspect-[3/4] rounded-3xl overflow-hidden bg-primary shadow-xl
group-hover:scale-[1.02] group-hover:-rotate-1 transition-transform duration-300
```

Bold's category card breaks the rounding rule with `rounded-3xl` AND adds a `-rotate-1` tilt on hover — playful, energetic.

### Inputs & Forms

**Header Search Input (on dark)**

```
flex-1 px-4 py-2.5 bg-white/10 text-white placeholder:text-white/40
rounded-lg border border-white/20
focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent
text-sm font-medium transition-colors duration-200
```

### Badges & Pills

`@ebda/ui` `ProductBadge` overrides:

```
font-black px-3 py-1.5 rounded-none
```

"NEW!" gets the literal exclamation: `label="NEW!"` (or `جديد!` in Arabic) — punctuation is part of the personality.

Cart count: `bg-primary text-primary-foreground text-[10px] font-black rounded-full min-w-[18px] h-[18px]`. Pulses on add-to-cart with the same `cartPulse` 600ms scale used in Modern.

### Navigation

- Header: `bg-gray-950 text-white sticky top-0 z-50 border-b border-white/10` — always dark, always visible.
- Logo: `h-14 max-h-14 w-auto brightness-0 invert` — color logos are inverted to white via CSS filter.
- Nav links: `relative px-4 py-2 text-sm font-bold uppercase tracking-wider text-white/70 hover:text-white` PLUS a primary underline that grows on hover: `absolute bottom-0 left-4 right-4 h-0.5 bg-primary scale-x-0 group-hover:scale-x-100 transition-transform duration-200 origin-left`.
- Action icons: `p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10` — small lifts on hover via `bg-white/10`.
- Mobile drawer: `w-72 bg-gray-950 border-l border-white/10` — same dark language.

### Image Treatment

- Product image aspect: `aspect-square` (1:1) on `bg-muted`.
- Category image aspect: `aspect-[3/4]` portrait inside the `rounded-3xl bg-primary` frame.
- Hero: full-bleed `<Image fill />` with `bg-gray-950/65` overlay — the image is nearly absorbed into the dark.
- Cart thumb: `h-28 w-28 sm:h-32 sm:w-32` — bigger than other templates.
- Hover behavior: `hover:scale-110` on category card image; `scale-110` on product card image when `isHovered` (state-driven via `useState`, not just CSS hover).
- Image fallback: `flex items-center justify-center text-muted-foreground` with `strokeWidth={1.5}` placeholder icon — heavier strokes than Elegant/Minimal.

### Announcement Bar

```
bg-primary text-primary-foreground py-3 px-4
[content] flex items-center justify-center gap-3
[fire emoji] 🔥 (text-xl)
[text] font-black tracking-wide
[arrow when link present] → font-black
```

The fire emoji is intentional — Bold leans into emoji as identity.

## 5. Layout Principles

### Spacing System

- Tailwind defaults. Bold uses `gap-6 md:gap-8` on grids, `gap-12` on the footer.
- Hero CTA padding: `px-10 py-5` — biggest CTA touch target of all templates.
- Product card content padding: `p-4`.
- Order summary panel: outer panel is `border-2 border-foreground`, inner sections use `p-5` for content and `px-5 py-3` for header strip.

### Grid & Container

- Container: `container mx-auto px-4` (1400px max).
- Hero: `container mx-auto px-4 min-h-screen flex flex-col justify-center py-24` — fills the viewport.
- Product grid: `getGridColsClass(columns)` default 4-up, `gap-6 md:gap-8`. Section vertical padding: `py-20 md:py-28`.
- Footer: `grid md:grid-cols-2 lg:grid-cols-4 gap-12` with brand column spanning `lg:col-span-2`.

### Whitespace Philosophy

- **Density at scale, breath at small**: hero packs an 8xl headline against a `min-h-screen` block — feels intentionally crowded. But individual labels use generous tracking (`tracking-wider`, `tracking-widest`) so small text breathes inside the noise.
- **Heavy borders create section weight** — 2px `border-foreground` makes each panel feel like a labeled crate. Sections don't need shadow elevation; the borders already shout.

### Border Radius Scale

- `rounded-none`: All CTAs, badges, cart rows, summary panel, form panel, empty state — the brutalist default.
- `rounded-lg`: Header search input + submit button (small utility).
- `rounded-full`: Cart count badge, hero "New Drop" pill, accent rule (`w-24 h-2 bg-primary mx-auto rounded-full`), category card icon button (`w-12 h-12 bg-white rounded-2xl`).
- `rounded-2xl`: Product card frame (the chunky-but-soft compromise).
- `rounded-3xl`: Category card frame (`rounded-3xl bg-primary`).

## 6. Depth & Elevation

| Level      | Treatment                                      | Use                                |
| ---------- | ---------------------------------------------- | ---------------------------------- |
| Flat       | `border-2 border-foreground` (2px solid black) | Default panel/card frame           |
| Subtle     | `border-2 border-gray-950/10`                  | Resting product card               |
| Sticky     | `bg-gray-950 sticky border-b border-white/10`  | Header                             |
| Hover      | `border-2 border-primary` + `scale-[1.03]`     | Product card hover                 |
| Floating   | `shadow-xl`                                    | Category card resting              |
| CTA Glow   | `shadow-2xl shadow-primary/30`                 | Hero CTA                           |
| Rotational | `group-hover:-rotate-1`                        | Category card hover (playful tilt) |

**Shadow Philosophy**: Shadows are used sparingly and ONLY on dark or chromatic surfaces (`shadow-2xl shadow-primary/30` on the hero CTA, `shadow-xl` on category cards). On regular page content, depth comes from heavy 2px borders and hard inversions (`bg-foreground text-background` strips). The signature elevation move is hover-scale (`hover:scale-[1.02]` to `hover:scale-[1.03]`) plus border-color-shift (`hover:border-primary`) — physical motion replaces shadow lift.

## 7. Do's and Don'ts

### Do

- Use `font-black` (900) on display headlines, product names, totals, CTAs, summary labels, badges — Bold's workhorse weight.
- Use `border-2 border-foreground` (2px solid) on panel frames, cart rows, summary, form, empty state — heavy borders are mandatory.
- Use ALL CAPS plus `tracking-tight` on display, `tracking-wider` / `tracking-widest` on labels and CTAs.
- Use the inverted header strip pattern: `border-b-2 border-foreground bg-foreground px-5 py-3 text-sm font-black uppercase tracking-widest text-background`.
- Use `bg-primary` aggressively as a structural fill — hero CTA, summary CTA, announcement bar, cart counter, header search submit. Bold doesn't whisper the brand color.
- Use snappy `transition-* duration-200` — Bold doesn't linger.
- Pair scale hovers (`hover:scale-[1.02]` to `hover:scale-[1.03]`) with border-color shifts (`hover:border-primary`) instead of shadow lifts.
- Use `bg-gray-950` for header AND footer AND the hero block — these dark surfaces frame the content.
- Apply `brightness-0 invert` to color logos on dark surfaces (header, footer) to render them as white.
- Use `→` arrow glyphs and 🔥 emoji in CTAs and announcement bars — emoji is part of the identity.
- Render the underline-on-hover with primary scaling: `absolute bottom-0 inset-x bg-primary scale-x-0 group-hover:scale-x-100 origin-left`.

### Don't

- Don't soften with `shadow-sm` on white surfaces — Bold's language is hard contrast and heavy borders, not soft elevation.
- Don't use `font-light`, `font-medium`, or `font-semibold` for headlines or product names — minimum is `font-bold` (700) on nav, `font-black` (900) everywhere else display.
- Don't use sentence case for nav, CTAs, headlines, badges, or product names — UPPERCASE is non-negotiable.
- Don't use `border-border/60` (Modern style) — Bold borders are 2px and full-color (`border-foreground` or `border-gray-950/10`).
- Don't use `font-serif` — that's Classic/Elegant. Bold is 100% Plus Jakarta Sans.
- Don't soften corners on CTAs, badges, cart rows, or summary panels — `rounded-none` is default. The `rounded-2xl` product card and `rounded-3xl` category card are deliberate exceptions.
- Don't use long transitions (`duration-500`, `duration-700`) — Bold moves at 200ms.
- Don't whisper-quiet the brand — `--primary` is a load-bearing structural color, not a hover accent.
- Don't drop the heavy header strip pattern when designing new panels — every panel deserves a `bg-foreground text-background` label strip on top.
- Don't replace `🔥` with subtle text on the announcement bar — emoji + `font-black tracking-wide` IS the announcement language.

## 8. Responsive Behavior

### Breakpoints

| Name    | Min Width | Use                                                                   |
| ------- | --------- | --------------------------------------------------------------------- |
| Default | 0         | Single column, hero at `text-6xl`, mobile drawer hidden               |
| `sm`    | 640px     | Account icon shows in header (`hidden sm:flex`), cart thumbnails grow |
| `md`    | 768px     | Desktop nav, hero `text-8xl`, footer 2-col, product grid full columns |
| `lg`    | 1024px    | Footer 4-col with brand column spanning 2, full layout                |

### Touch Targets

- Hero CTA: `px-10 py-5` (~52px tall) — comfortably above WCAG.
- Quantity controls: `h-11 w-11` (44px) inside a `border-2 border-foreground` container.
- Cart `×` remove: `h-11 w-11 border-2 border-foreground` — extra-confident hit target.
- Header icon buttons: `p-2 rounded-lg` (~36px hit area).
- Order summary CTA: `h-14` (56px) — biggest button across all templates.

### Collapsing Strategy

- Hero: `text-6xl md:text-8xl` headline — biggest jump in the system. Subtitle scales `text-lg md:text-xl`. Hero stays `min-h-screen` at all breakpoints.
- Header: nav `hidden md:flex`, mobile drawer slides from right (or left in RTL) at `w-72 bg-gray-950`.
- Search bar: expands inline below header on click (max-h transition over 200ms).
- Product grid: `gap-6 md:gap-8`, columns from `getGridColsClass`.
- Footer: `md:grid-cols-2 lg:grid-cols-4 gap-12`, brand spans 2 on lg.
- Cart row: image scales `h-28 w-28 → sm:h-32 sm:w-32`. Layout stays consistent.

### Image Behavior

- Hero `<Image fill />` with `priority` and `sizes="100vw"`, full-bleed. The 65% overlay handles contrast.
- Product cards: `sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 25vw"`, `loading="lazy"`. Hover triggers `state.isHovered → scale-110` (state-driven, not pure CSS).
- Category cards: `aspect-[3/4] rounded-3xl bg-primary` — the brand color shows through even when the image is loading, signaling the brand color from the very first paint.
- Background ambience: `absolute bottom-0 right-0 w-1/2 h-1/2 bg-primary/5 rounded-full blur-3xl translate-x-1/2 translate-y-1/2` under the product grid section — a subtle primary glow.

## 9. Agent Prompt Guide

When generating new components for the Bold template, treat `Hero.tsx`, `ProductCard.tsx`, and `OrderSummary.tsx` as canon. Default typography weight to `font-black` (900) for display, headlines, product names, totals, CTAs, summary labels, badges; use `font-bold` (700) for nav links; use `font-medium` (500) only on subtitles. Default text case to UPPERCASE on display, headlines, button labels, badges, summary labels, product names — sentence case is reserved for body subtitles. Default tracking to `tracking-tight` on display headlines (`leading-[0.9]`) and `tracking-wider` / `tracking-widest` on small labels. Default panel frames to `border-2 border-foreground` (2px solid) — never soften. Default corners to `rounded-none` on CTAs / badges / panels; the only exceptions are the `rounded-2xl` product card frame and `rounded-3xl` category card frame. Use the inverted-strip header pattern on every panel: `border-b-2 border-foreground bg-foreground px-5 py-3 text-sm font-black uppercase tracking-widest text-background`. Brand `--primary` is load-bearing — fill hero CTA, summary CTA, announcement bar, cart counter, header search submit with `bg-primary text-primary-foreground`. Pair every hover with `transition-* duration-200` (snappy) and `hover:scale-[1.02]` to `hover:scale-[1.03]` plus `hover:border-primary` (where applicable) — depth comes from motion, not shadow. The header AND footer AND hero block use hardcoded `bg-gray-950` (NOT a token) — these dark surfaces frame the content; do not lighten them. Apply `brightness-0 invert` on color logos on dark surfaces. Use `→` arrows and 🔥 emoji on CTAs and announcement bars — punctuation and emoji are part of the personality. RTL is supported via `dir`, mirrored chevrons (`rotate-180`), Arabic strings, and `cartPulse` micro-interaction (600ms scale on add-to-cart). When in doubt: more weight, more border, more uppercase, less duration.
