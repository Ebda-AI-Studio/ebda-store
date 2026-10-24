import { normalizeLegacyTemplate, type TemplateId } from '@ebda/shared';

/**
 * Per-pack style tokens for the shared Storefront-flow sections
 * (HeroBanner, HeroSlider, CategoryStrip, ProductCarousel, TestimonialRow).
 *
 * Each pack inherits the same layout shape but applies its own border style,
 * radius, font, and weight. Driven from spec § 7 of the Storefront design doc.
 *
 * The tokens here are the single source of truth for "premium-boutique"
 * polish across the packs:
 *   - hover transitions are 500–700ms with `ease-out` (slow + intentional)
 *   - shadows are tinted to the foreground hue, not pure black
 *   - hover scale is gentle (1.01–1.03), never aggressive (1.05+)
 *   - section-heading typography is confident at desktop (text-3xl+)
 *
 * Adding a new pack: extend `TemplateId` in @ebda/shared and add a row here.
 * The shared components fall back to `base` when an id isn't found.
 */
export interface PackStyles {
  /** Class for cards (product carousel, testimonial). */
  card: string;
  /** Class for category card image wrapper (the square frame). */
  categoryFrame: string;
  /** Class for the caption under each category. */
  categoryCaption: string;
  /** Class for product carousel card name. */
  productCardName: string;
  /** Class for product carousel card price. */
  productCardPrice: string;
  /** Optional class applied to the product carousel text block (under image). */
  productCardBody?: string;
  /** Class for product carousel CTA button (the bottom pill). */
  productCardCta: string;
  /** Class for the section heading H2. */
  sectionHeading: string;
  /**
   * Default alignment of a `SectionHeading` title/kicker/subtitle when the merchant set none
   * (per-zone `textAlign` still wins). Unset = 'center' (every legacy skin, unchanged).
   */
  sectionHeadingAlign?: 'start' | 'center';
  /** Class for the "see all" link in section heading. */
  sectionSeeAll: string;
  /** Hero overlay tint + treatment. */
  heroOverlay: string;
  /** Hero headline class. */
  heroHeadline: string;
  /** Hero CTA button class. */
  heroCta: string;
  /** Testimonial card class. */
  testimonialCard: string;
  /** Testimonial author class. */
  testimonialAuthor: string;
}

/** A template id, or `base`: the shared storefront base's own style row. */
export type PackId = TemplateId | 'base';

const PACK_STYLES: Record<PackId, PackStyles> = {
  // Dahab (jewellery; three looks, Phase B5): its homepage sections and cards are its own
  // components (templates/dahab); this row styles the shared surfaces that remain (section
  // headings on CMS pages, the list-view row, brand story). Token colours only: the look decides.
  // The shared storefront base's own voice (Ruling SKIN-DEL-7): whitespace, tiny tracking and an
  // ultra-light weight. It was the row of the first Force skin; the base category grid and the
  // unknown-pack fallback use it.
  base: {
    // No-chrome: NO border, NO radius, NO shadow on cards; the page background shows through.
    // The CTA is an underlined link, never a button frame.
    card: 'border border-primary/15 bg-transparent hover:border-primary/30 transition-colors duration-[var(--duration-slow)] ease-[var(--ease-out)]',
    categoryFrame: 'bg-transparent',
    // Minimal's identity is whitespace + tiny tracking + ULTRA-light weight.
    // Main text still hits 16px floor for legibility (Ahmad standing rule).
    categoryCaption:
      'text-base font-extralight tracking-[0.22em] ui-caps-toggle text-muted-foreground group-hover:text-foreground transition-colors duration-[var(--duration-slow)]',
    productCardName:
      'tracking-normal sm:tracking-[0.18em] [overflow-wrap:anywhere] font-extralight text-muted-foreground group-hover:text-foreground transition-colors duration-[var(--duration-slow)]',
    productCardPrice: 'tracking-wide font-extralight text-muted-foreground',
    productCardBody: 'text-center',
    productCardCta:
      'whitespace-nowrap max-w-full overflow-hidden text-ellipsis mx-auto inline-block border-b border-foreground/70 pb-1 text-xs sm:text-sm font-medium tracking-[0.14em] text-foreground hover:text-foreground/70 hover:border-foreground/40 bg-transparent transition-colors duration-[var(--duration-slow)] ease-[var(--ease-out)] min-h-[44px]',
    sectionHeading:
      'text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-extralight tracking-tight text-foreground leading-[1.1] text-balance',
    sectionSeeAll:
      'text-sm font-extralight ui-caps-toggle tracking-[0.28em] text-muted-foreground hover:text-foreground transition-colors duration-[var(--duration-slow)]',
    heroOverlay: 'bg-gradient-to-b from-transparent via-transparent to-foreground/30',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extralight tracking-tight drop-shadow-xl leading-[1.05]',
    heroCta:
      'inline-block border-b border-white pb-2 text-sm font-medium ui-caps-toggle tracking-[0.22em] text-white hover:border-white/50 hover:text-white/80 transition-colors duration-[var(--duration-slow)] ease-[var(--ease-out)] min-h-[44px]',
    testimonialCard: 'border-t border-border/40 bg-transparent py-10',
    testimonialAuthor: 'text-sm font-extralight text-foreground tracking-wide',
  },
  dahab: {
    card: 'rounded-[var(--radius)] bg-card ring-1 ring-inset ring-foreground/[0.06] transition-colors duration-300 hover:ring-primary/40',
    categoryFrame: 'rounded-[var(--radius)] bg-card ring-1 ring-inset ring-primary/25',
    categoryCaption:
      'font-display text-lg text-foreground group-hover:text-primary transition-colors',
    productCardName: 'text-foreground leading-snug [overflow-wrap:anywhere]',
    productCardPrice: 'text-primary tabular-nums',
    productCardCta:
      'whitespace-nowrap max-w-full overflow-hidden text-ellipsis rounded-[var(--radius)] bg-primary px-2 sm:px-5 py-3 text-xs sm:text-sm font-medium text-primary-foreground hover:bg-accent transition-colors duration-300 min-h-[44px]',
    sectionHeading:
      'font-display text-[clamp(1.6rem,1.15rem+1.5vw,2.4rem)] leading-[1.15] text-foreground text-balance',
    sectionSeeAll: 'text-sm text-primary hover:text-accent transition-colors',
    heroOverlay: 'bg-gradient-to-t from-background via-background/30 to-transparent',
    heroHeadline: 'font-display text-4xl sm:text-5xl md:text-6xl leading-[1.08]',
    heroCta:
      'rounded-[var(--radius)] bg-primary px-7 py-3.5 text-sm font-medium text-primary-foreground hover:bg-accent transition-colors min-h-[48px]',
    testimonialCard: 'border-t border-primary/40 bg-transparent pt-6',
    testimonialAuthor: 'text-sm text-muted-foreground',
  },
  qamar: {
    // Phase B1 (Ruling B1-1): the clothes are the interface. No card surface, no
    // border, no lift: the 3:4 photo carries the card. Type voice comes from the
    // look's --font-display/--font-body (looks.md), so these classes carry weight
    // and colour only.
    card: 'bg-transparent',
    categoryFrame: 'bg-transparent',
    categoryCaption: 'text-sm font-medium text-foreground',
    productCardName: 'font-normal text-foreground leading-snug',
    productCardPrice: 'font-medium text-foreground',
    productCardCta:
      'whitespace-nowrap rounded-[var(--radius)] bg-primary px-5 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors duration-[var(--motion-duration,150ms)] min-h-[44px]',
    // AT-1: one section-title style per Qamar page; the builder SectionHeader renders this too.
    sectionHeading:
      'font-display text-2xl sm:text-3xl md:text-4xl font-normal text-foreground leading-[1.25] text-balance',
    sectionSeeAll:
      'text-sm font-medium text-foreground/70 hover:text-foreground underline-offset-4 hover:underline',
    // Quality bar T-03: one heading alignment per page. The builder sections (SectionHeader:
    // shop-the-look, new in) start-align, so the layout sections' headings do too.
    sectionHeadingAlign: 'start',
    // White headline over ANY photo (light Atelier walls included): a dark ink scrim, densest
    // where the centred text sits. Not a token: the text is white on every look, so the scrim
    // is dark on every look (a `foreground` scrim is LIGHT on Lookbook). Pinned by
    // tests/unit/qamar-looks-contrast.test.ts through QAMAR_HERO_SCRIM.
    heroOverlay:
      'bg-[radial-gradient(ellipse_at_center,rgb(20_20_20/0.65)_0%,rgb(20_20_20/0.65)_60%,rgb(20_20_20/0.3)_100%)]',
    heroHeadline: 'font-display text-3xl sm:text-5xl md:text-6xl font-bold leading-[1.2]',
    heroCta:
      'rounded-[var(--radius)] bg-background px-8 py-3.5 text-sm font-medium text-foreground hover:bg-background/90 min-h-[44px]',
    testimonialCard: 'bg-transparent p-0',
    testimonialAuthor: 'text-sm font-medium text-muted-foreground',
  },
  souq: {
    // Phase B2 (Ruling B2-1): a catalogue of many SKUs. A framed tile (surface + hairline,
    // radius from the look), a name that reads at a glance in two lines, a firm price (600; the
    // struck compare-at price is already muted in the shared card), and ONE always-visible quick
    // add (a >= 44px target; the card keeps its single action, never a second control).
    // Everything is a look token, so the orange gate stays true; compact spacing comes from the
    // look's density, the square photo from its image ratio.
    // h-full: cards in a row share one height and the CTA (mt-auto) sits on the same baseline.
    card: 'h-full rounded-[var(--radius)] border border-border bg-card',
    categoryFrame: 'rounded-[var(--radius)] bg-muted',
    categoryCaption: 'text-sm font-medium text-foreground',
    // hyphens-none: a title never breaks inside a word unless one word is wider than the card.
    productCardName: 'line-clamp-2 font-medium text-foreground leading-snug [hyphens:none]',
    productCardPrice: 'font-semibold text-foreground',
    productCardBody: 'text-start',
    productCardCta:
      'whitespace-nowrap rounded-[var(--radius)] bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors duration-[var(--motion-duration,150ms)] min-h-[44px]',
    sectionHeading:
      'font-display text-xl sm:text-2xl md:text-3xl font-semibold text-foreground leading-[1.25] text-balance',
    // Ink text with a primary underline: the literal primary is only ~5:1 on a light page.
    sectionSeeAll:
      'text-sm font-medium text-foreground underline decoration-primary underline-offset-4 hover:decoration-2',
    sectionHeadingAlign: 'start',
    heroOverlay: 'bg-gradient-to-b from-foreground/0 via-foreground/0 to-foreground/35',
    heroHeadline: 'font-display text-3xl sm:text-5xl md:text-6xl font-bold leading-[1.2]',
    heroCta:
      'rounded-[var(--radius)] bg-background px-8 py-3.5 text-sm font-medium text-foreground hover:bg-background/90 min-h-[44px]',
    testimonialCard: 'rounded-[var(--radius)] border border-border bg-card p-5',
    testimonialAuthor: 'text-sm font-medium text-muted-foreground',
  },
  jasmine: {
    // Phase B3 (Ruling B3-1): a rounded, photo-led card in the look's own radius (Apothecary 6,
    // Bloom 12, Clinic 8 via var(--radius)), one always-visible >= 44px quick add, the shade dots
    // and the two fact chips come from the shared card. Token colours only (the orange gate).
    // h-full: cards in a row share one height and the CTA (mt-auto) sits on the same baseline.
    card: 'h-full rounded-[var(--radius)] border border-border bg-card',
    categoryFrame: 'rounded-[var(--radius)] bg-muted',
    categoryCaption: 'text-sm font-medium text-foreground',
    // hyphens-none: a title never breaks inside a word unless one word is wider than the card.
    productCardName: 'line-clamp-3 font-medium text-foreground leading-snug [hyphens:none]',
    productCardPrice: 'font-semibold text-foreground',
    productCardBody: 'text-start',
    productCardCta:
      'whitespace-nowrap rounded-[var(--radius)] bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors duration-[var(--motion-duration,150ms)] min-h-[44px]',
    sectionHeading:
      'font-display text-xl sm:text-2xl md:text-3xl font-semibold text-foreground leading-[1.25] text-balance',
    // Ink text with a primary underline: the literal primary is only ~5:1 on a light page.
    sectionSeeAll:
      'text-sm font-medium text-foreground underline decoration-primary underline-offset-4 hover:decoration-2',
    sectionHeadingAlign: 'start',
    heroOverlay: 'bg-gradient-to-b from-foreground/0 via-foreground/0 to-foreground/35',
    heroHeadline: 'font-display text-3xl sm:text-5xl md:text-6xl font-bold leading-[1.2]',
    heroCta:
      'rounded-[var(--radius)] bg-background px-8 py-3.5 text-sm font-medium text-foreground hover:bg-background/90 min-h-[44px]',
    testimonialCard: 'rounded-[var(--radius)] border border-border bg-card p-5',
    testimonialAuthor: 'text-sm font-medium text-muted-foreground',
  },
  lamma: {
    // Phase B4 (Ruling B4-1): a home-kitchen card in the look's own radius (Family table 8,
    // Notebook 4, Market 16 via var(--radius)). Photo-led; one always-visible >= 44px add control
    // (the card CTA turns into the stepper in place, Ruling B4-4); two fact chips come from the
    // shared card. Token colours only, so the orange gate stays true.
    card: 'h-full rounded-[var(--radius)] border border-border bg-card',
    categoryFrame: 'rounded-[var(--radius)] bg-muted',
    categoryCaption: 'text-sm font-semibold text-foreground',
    productCardName: 'line-clamp-2 font-semibold text-foreground leading-snug [hyphens:none]',
    productCardPrice: 'font-bold text-foreground',
    productCardBody: 'text-start',
    productCardCta:
      'whitespace-nowrap rounded-[var(--radius)] bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors duration-[var(--motion-duration,150ms)] min-h-[44px]',
    sectionHeading:
      'font-display text-xl sm:text-2xl md:text-3xl font-bold text-foreground leading-[1.25] text-balance',
    sectionSeeAll:
      'text-sm font-medium text-foreground underline decoration-primary underline-offset-4 hover:decoration-2',
    sectionHeadingAlign: 'start',
    heroOverlay: 'bg-gradient-to-b from-foreground/0 via-foreground/0 to-foreground/35',
    heroHeadline: 'font-display text-3xl sm:text-5xl md:text-6xl font-bold leading-[1.2]',
    heroCta:
      'rounded-[var(--radius)] bg-background px-8 py-3.5 text-sm font-semibold text-foreground hover:bg-background/90 min-h-[44px]',
    testimonialCard: 'rounded-[var(--radius)] border border-border bg-card p-5',
    testimonialAuthor: 'text-sm font-medium text-muted-foreground',
  },
};

/** The qamar hero scrim, as painted by `PACK_STYLES.qamar.heroOverlay` (centre = under the text). */
export const QAMAR_HERO_SCRIM = {
  color: '#141414',
  /** held flat from the centre to `plateau` (the headline + subheadline block), then fades */
  centre: 0.65,
  plateau: 60,
  edge: 0.3,
} as const;

/**
 * The anchored hero copy scrim (W2a, quality bar L-04): a band behind the bottom-start text block
 * only, solid at `alpha` behind the text and fading to clear over `fade` above it, on every skin
 * (the copy on the photo is white whatever the look). Pinned by tests/unit/hero-text-anchor.test.tsx
 * BY IMPORT: white text over this scrim over a white photo is >= 4.5:1.
 */
export const HERO_TEXT_SCRIM = {
  /** #141414 as an rgb() channel list */
  rgb: '20 20 20',
  hex: '#141414',
  alpha: 0.72,
  fade: '2rem',
  /** Inline mask: solid under the copy column (max-w-xl + padding), clear past `reach`. Tightened 2026-10-23 (polish): the old 40/60rem band ran across the subject's hem on a 1280 hero; the copy column is max-w-xl (36rem) + px-10, so 39rem keeps the text on solid scrim. */
  solidTo: 'min(100%, 39rem)',
  reach: 'min(100%, 46rem)',
} as const;

export function getPackStyles(pack: PackId | string | null | undefined): PackStyles {
  // A retired Force skin name (Ruling SKIN-DEL-8) maps to its Ebda template; anything else
  // unknown or missing uses the shared base row.
  if (pack === 'base') return PACK_STYLES.base;
  const id = typeof pack === 'string' ? normalizeLegacyTemplate(pack) : undefined;
  return (id && PACK_STYLES[id]) || PACK_STYLES.base;
}
