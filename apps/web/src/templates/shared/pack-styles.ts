import type { TemplateId } from '@ebda/shared';

/**
 * Per-pack style tokens for the 5 shared Storefront-flow sections
 * (HeroBanner, HeroSlider, CategoryStrip, ProductCarousel, TestimonialRow).
 *
 * Each pack inherits the same layout shape but applies its own border style,
 * radius, font, and weight. Driven from spec § 7 of the Storefront design doc.
 *
 * The tokens here are the single source of truth for "premium-boutique"
 * polish across the 5 packs:
 *   - hover transitions are 500–700ms with `ease-out` (slow + intentional)
 *     except Bold which intentionally moves at 200ms (its voice)
 *   - shadows are tinted to the foreground hue, not pure black
 *   - hover scale is gentle (1.01–1.03), never aggressive (1.05+)
 *   - section-heading typography is confident at desktop (text-3xl+)
 *
 * Adding a new pack: extend `TemplateId` in @ebda/shared and add a row here.
 * The shared components fall back to `modern` when an id isn't found.
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

const PACK_STYLES: Record<TemplateId, PackStyles> = {
  modern: {
    // 2026-05-17 night persona refresh: tech / SaaS / DTC software-y target.
    // Changes from baseline: (1) card hover shadow 0.12→0.18 (more lift),
    // (2) productCardPrice text-foreground→text-primary (modern is the ONLY
    // theme that puts accent on price), (3) productCardCta rounded-full→
    // rounded-2xl + brand fill (unifies CTA radius with card radius),
    // (4) sectionHeading font-bold→font-semibold (introduces mid-weight
    // hierarchy), (5) heroCta rounded-full→rounded-2xl + brand fill (matches
    // in-page cards). See design.md "Theme 1 — Modern" persona spec.
    card: 'rounded-2xl border border-primary/15 bg-card hover:shadow-[0_24px_48px_-20px_hsl(var(--foreground)/0.18)] hover:border-primary/35 hover:-translate-y-0.5 transition-[box-shadow,border-color,transform] duration-[var(--duration-slow)] ease-[var(--ease-out)]',
    categoryFrame:
      'rounded-2xl bg-muted shadow-[0_10px_30px_-18px_hsl(var(--foreground)/0.10)] group-hover:shadow-[0_24px_48px_-20px_hsl(var(--foreground)/0.14)] transition-shadow duration-[var(--duration-slower)] ease-[var(--ease-out)]',
    categoryCaption: 'text-base sm:text-lg font-semibold text-foreground tracking-tight',
    // 2026-05-16: Ahmad standing rule — main reading text minimum 16px
    // across all themes for legibility. Theme identity stays via weight
    // and tracking, not size shrinking.
    // Sprint 1 (2026-05-17): text-size tokens removed from pack-styles so
    // they can be driven by `cardSize` via getProductCardTextSizes(). Each
    // card consumer (StorefrontProductCard + ProductCarousel inline cards)
    // concatenates the size class. Pack-styles now carries flavor only:
    // weight, color, tracking, leading, font-family.
    productCardName:
      'font-semibold text-foreground tracking-tight leading-snug [overflow-wrap:anywhere]',
    productCardPrice: 'font-bold text-primary tracking-tight',
    productCardCta:
      'whitespace-nowrap max-w-full overflow-hidden text-ellipsis rounded-2xl bg-primary px-2 sm:px-5 py-3.5 text-xs sm:text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors duration-[var(--duration-base)] ease-[var(--ease-out)] min-h-[44px]',
    sectionHeading:
      'text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tight text-foreground leading-[1.1] text-balance',
    sectionSeeAll:
      'text-sm font-semibold text-foreground/70 hover:text-foreground transition-colors duration-[var(--duration-base)]',
    heroOverlay: 'bg-gradient-to-b from-foreground/0 via-foreground/5 to-foreground/35',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight drop-shadow-xl leading-[1.05]',
    heroCta:
      'rounded-2xl bg-primary px-8 py-4 text-base font-semibold text-primary-foreground hover:bg-primary/90 hover:-translate-y-0.5 shadow-[0_18px_40px_-18px_hsl(var(--primary)/0.45)] transition-[background-color,transform] duration-[var(--duration-slow)] ease-[var(--ease-out)] min-h-[44px]',
    testimonialCard:
      'rounded-2xl border border-border/60 bg-card p-7 hover:shadow-[0_24px_48px_-20px_hsl(var(--foreground)/0.10)] hover:border-foreground/15 transition-[box-shadow,border-color] duration-[var(--duration-slow)] ease-[var(--ease-out)]',
    testimonialAuthor: 'text-base font-semibold text-foreground tracking-tight',
  },
  classic: {
    // Sharp corners, solid borders, slow restrained hovers (500ms).
    card: 'border border-primary/25 bg-card hover:border-primary/55 hover:shadow-[0_18px_36px_-22px_hsl(var(--foreground)/0.18)] transition-[border-color,box-shadow] duration-[var(--duration-slow)] ease-[var(--ease-out)]',
    categoryFrame:
      'rounded-sm border border-border bg-muted group-hover:border-foreground/35 transition-colors duration-[var(--duration-slower)] ease-[var(--ease-out)]',
    categoryCaption: 'text-base sm:text-lg font-serif font-normal text-foreground tracking-tight',
    productCardName:
      'font-serif font-normal text-foreground tracking-tight leading-snug [overflow-wrap:anywhere]',
    productCardPrice: 'font-serif font-medium text-foreground tracking-tight',
    productCardBody: 'text-center',
    productCardCta:
      'whitespace-nowrap max-w-full overflow-hidden text-ellipsis border-y border-foreground bg-foreground px-2 sm:px-5 py-3.5 text-xs sm:text-sm font-serif tracking-[0.08em] sm:tracking-[0.22em] text-background hover:bg-foreground/85 transition-colors duration-[var(--duration-slow)] ease-[var(--ease-out)] min-h-[44px]',
    sectionHeading:
      'text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-serif font-normal tracking-tight text-foreground leading-[1.1] text-balance',
    sectionSeeAll:
      'text-sm font-serif ui-caps-toggle tracking-[0.22em] text-foreground/70 hover:text-foreground transition-colors duration-[var(--duration-slow)]',
    heroOverlay: 'bg-gradient-to-b from-foreground/10 via-foreground/15 to-foreground/40',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-serif font-normal tracking-tight drop-shadow-xl leading-[1.05]',
    heroCta:
      'border border-white bg-transparent px-10 py-4 font-serif text-sm tracking-[0.22em] ui-caps-toggle text-white hover:bg-white hover:text-foreground transition-colors duration-[var(--duration-slow)] ease-[var(--ease-out)] min-h-[44px]',
    testimonialCard: 'border border-border bg-background p-7',
    testimonialAuthor: 'text-sm font-serif ui-caps-toggle tracking-[0.22em] text-foreground',
  },
  minimal: {
    // 2026-05-17 night persona refresh: editorial / fashion / magazine
    // target. Push HARDER apart from Modern (the biggest overlap pair per
    // the audit). Changes from baseline: (1) categoryFrame drops bg-muted/40
    // → bg-transparent (zero chrome, the page bg shows through — minimal is
    // the ONLY theme with NO surface fill on category cards), (2) productCardName
    // weight font-light → font-extralight (true ultralight identity, stronger
    // contrast vs Modern's font-semibold), (3) sectionHeading font-light →
    // font-extralight to match. Hero overlay kept at /30 (already minimal
    // among the 5; pure transparent makes white headline illegible on bright
    // images). See design.md "Theme 3 — Minimal" persona spec.
    // No-chrome philosophy: NO border, NO radius, NO shadow on cards. Page
    // bg shows through. CTA is an underlined link, never a button frame.
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
  bold: {
    // Brutalist core preserved: 2px borders + offset shadow on hover.
    // Offset shadow tinted to foreground (token-driven) so it adapts to
    // light/dark theme — not a flat black drop. Bold's voice keeps 200ms.
    // Hover drops the card ONTO the +6px/+6px offset shadow (down-right),
    // per design.md "Card hover translate-x-1 translate-y-1 (shadow appears
    // to fall behind)" — the previous -translate-y-1 lifted AWAY from it.
    card: 'border-2 border-primary bg-card hover:translate-x-1 hover:translate-y-1 hover:shadow-[6px_6px_0_0_hsl(var(--primary)/0.92)] transition-[transform,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
    categoryFrame:
      'rounded-2xl border-2 border-foreground bg-muted group-hover:shadow-[6px_6px_0_0_hsl(var(--foreground)/0.92)] transition-shadow duration-[var(--duration-fast)] ease-[var(--ease-out)]',
    categoryCaption: 'text-base font-black ui-caps-toggle tracking-[0.05em] text-foreground',
    productCardName:
      'font-black tracking-[0.02em] text-foreground leading-tight [overflow-wrap:anywhere]',
    productCardPrice: 'font-black text-foreground tracking-tight',
    productCardCta:
      'whitespace-nowrap max-w-full overflow-hidden text-ellipsis border-t-2 border-foreground bg-foreground px-2 sm:px-5 py-3.5 text-xs sm:text-sm font-black tracking-[0.06em] sm:tracking-[0.18em] text-background hover:bg-primary hover:text-primary-foreground transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] min-h-[44px]',
    sectionHeading:
      'text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-black ui-caps-toggle tracking-tight text-foreground leading-[1.1] text-balance',
    sectionSeeAll:
      'text-sm font-black ui-caps-toggle tracking-[0.18em] text-foreground hover:text-primary transition-colors duration-[var(--duration-fast)]',
    heroOverlay: 'bg-gradient-to-b from-foreground/20 via-foreground/30 to-foreground/65',
    heroHeadline:
      'text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black ui-caps-toggle tracking-tight drop-shadow-2xl leading-[0.9]',
    heroCta:
      'border-2 border-white bg-transparent px-8 py-4 text-base font-black ui-caps-toggle tracking-[0.18em] text-white hover:bg-white hover:text-foreground transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)] min-h-[44px]',
    testimonialCard: 'border-2 border-foreground bg-card p-7',
    testimonialAuthor: 'text-base font-black ui-caps-toggle tracking-[0.05em] text-foreground',
  },
  elegant: {
    // Hairline borders only — `border-foreground/10` to /20. Strict 200–500
    // weight range. Long 500–700ms transitions for unhurried hovers.
    card: 'border border-primary/20 bg-card hover:border-primary/40 transition-colors duration-[var(--duration-slower)] ease-[var(--ease-out)]',
    categoryFrame:
      'rounded-md border border-foreground/10 bg-muted group-hover:border-foreground/25 transition-colors duration-[var(--duration-slower)] ease-[var(--ease-out)]',
    // Elegant's identity is hairline weight + wide tracking — but main
    // text still hits 16px floor. Tracking + extralight weight carry
    // the elegant voice; size carries the legibility.
    categoryCaption:
      'text-base font-extralight ui-caps-toggle tracking-[0.28em] text-foreground/75 group-hover:text-foreground transition-colors duration-[var(--duration-slower)]',
    productCardName:
      'font-light tracking-normal sm:tracking-[0.22em] [overflow-wrap:anywhere] text-foreground/75 group-hover:text-foreground transition-colors duration-[var(--duration-slower)]',
    productCardPrice: 'font-light tracking-wide text-foreground',
    productCardBody: 'text-center',
    productCardCta:
      'whitespace-nowrap max-w-full overflow-hidden text-ellipsis border-t border-foreground/15 bg-transparent px-2 sm:px-5 py-3.5 text-xs sm:text-sm font-medium tracking-[0.06em] sm:tracking-[0.32em] text-foreground hover:bg-foreground hover:text-background transition-colors duration-[var(--duration-slower)] ease-[var(--ease-out)] min-h-[44px]',
    sectionHeading:
      'text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-extralight tracking-[-0.01em] text-foreground leading-[1.1] text-balance',
    sectionSeeAll:
      'text-sm font-light ui-caps-toggle tracking-[0.32em] text-foreground/70 hover:text-foreground transition-colors duration-[var(--duration-slower)]',
    heroOverlay: 'bg-gradient-to-b from-foreground/0 via-foreground/10 to-foreground/30',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extralight tracking-[-0.01em] drop-shadow-xl leading-[1.05]',
    heroCta:
      'border border-white bg-transparent px-10 py-4 text-sm font-medium ui-caps-toggle tracking-[0.32em] text-white hover:bg-white hover:text-foreground transition-colors duration-[var(--duration-slower)] ease-[var(--ease-out)] min-h-[44px]',
    testimonialCard: 'border-t border-foreground/15 bg-transparent py-10',
    testimonialAuthor: 'text-sm font-light ui-caps-toggle tracking-[0.22em] text-foreground/80',
  },
  // Dahab (builder Phase 3 pilot): its homepage sections and cards are its own
  // components (templates/dahab); this row styles the shared surfaces that
  // remain (section headings on CMS pages, the list-view row, brand story).
  dahab: {
    card: 'rounded-[var(--radius)] bg-card ring-1 ring-inset ring-foreground/[0.06] transition-colors duration-300 hover:ring-primary/40',
    categoryFrame:
      'rounded-t-[999px] rounded-b-[var(--radius)] bg-card ring-1 ring-inset ring-primary/25',
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
  /** Inline mask: solid under the copy column (max-w-xl + padding), clear past `reach`. */
  solidTo: 'min(100%, 40rem)',
  reach: 'min(100%, 60rem)',
} as const;

export function getPackStyles(pack: TemplateId | undefined): PackStyles {
  return PACK_STYLES[pack ?? 'modern'] ?? PACK_STYLES.modern;
}
