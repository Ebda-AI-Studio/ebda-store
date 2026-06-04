import type { TemplateId } from '@force/shared';

/**
 * Per-pack style tokens for the 5 shared Pecannbee-flow sections
 * (HeroBanner, HeroSlider, CategoryStrip, ProductCarousel, TestimonialRow).
 *
 * Each pack inherits the same layout shape but applies its own border style,
 * radius, font, and weight. Driven from spec § 7 of the Pecannbee design doc.
 *
 * The tokens here are the single source of truth for "premium-boutique"
 * polish across the 5 packs:
 *   - hover transitions are 500–700ms with `ease-out` (slow + intentional)
 *     except Bold which intentionally moves at 200ms (its voice)
 *   - shadows are tinted to the foreground hue, not pure black
 *   - hover scale is gentle (1.01–1.03), never aggressive (1.05+)
 *   - section-heading typography is confident at desktop (text-3xl+)
 *
 * Adding a new pack: extend `TemplateId` in @force/shared and add a row here.
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

export const PACK_STYLES: Record<TemplateId, PackStyles> = {
  modern: {
    // 2026-05-17 night persona refresh: tech / SaaS / DTC software-y target.
    // Changes from baseline: (1) card hover shadow 0.12→0.18 (more lift),
    // (2) productCardPrice text-foreground→text-primary (modern is the ONLY
    // theme that puts accent on price), (3) productCardCta rounded-full→
    // rounded-2xl + brand fill (unifies CTA radius with card radius),
    // (4) sectionHeading font-bold→font-semibold (introduces mid-weight
    // hierarchy), (5) heroCta rounded-full→rounded-2xl + brand fill (matches
    // in-page cards). See design.md "Theme 1 — Modern" persona spec.
    card: 'rounded-2xl border border-border/60 bg-card hover:shadow-[0_24px_48px_-20px_hsl(var(--foreground)/0.18)] hover:border-foreground/15 hover:-translate-y-0.5 transition-all duration-500 ease-out',
    categoryFrame:
      'rounded-2xl bg-muted shadow-[0_10px_30px_-18px_hsl(var(--foreground)/0.10)] group-hover:shadow-[0_24px_48px_-20px_hsl(var(--foreground)/0.14)] transition-shadow duration-700 ease-out',
    categoryCaption: 'text-base sm:text-lg font-semibold text-foreground tracking-tight',
    // 2026-05-16: Ahmad standing rule — main reading text minimum 16px
    // across all themes for legibility. Theme identity stays via weight
    // and tracking, not size shrinking.
    // Sprint 1 (2026-05-17): text-size tokens removed from pack-styles so
    // they can be driven by `cardSize` via getProductCardTextSizes(). Each
    // card consumer (PecannbeeProductCard + ProductCarousel inline cards)
    // concatenates the size class. Pack-styles now carries flavor only:
    // weight, color, tracking, leading, font-family.
    productCardName: 'font-semibold text-foreground tracking-tight leading-snug',
    productCardPrice: 'font-bold text-primary tracking-tight',
    productCardCta:
      'whitespace-nowrap rounded-2xl bg-primary px-5 py-3.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors duration-300 ease-out min-h-[44px]',
    sectionHeading:
      'text-[22px] sm:text-3xl md:text-4xl lg:text-5xl font-semibold tracking-tight text-foreground leading-[1.1]',
    sectionSeeAll:
      'text-xl font-semibold text-foreground/70 hover:text-foreground transition-colors duration-300',
    heroOverlay: 'bg-gradient-to-b from-foreground/0 via-foreground/5 to-foreground/35',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight text-white drop-shadow-xl leading-[1.05]',
    heroCta:
      'rounded-2xl bg-primary px-8 py-4 text-base font-semibold text-primary-foreground hover:bg-primary/90 hover:-translate-y-0.5 shadow-[0_18px_40px_-18px_hsl(var(--primary)/0.45)] transition-all duration-500 ease-out min-h-[44px]',
    testimonialCard:
      'rounded-2xl border border-border/60 bg-card p-7 hover:shadow-[0_24px_48px_-20px_hsl(var(--foreground)/0.10)] hover:border-foreground/15 transition-all duration-500 ease-out',
    testimonialAuthor: 'text-base font-semibold text-foreground tracking-tight',
  },
  classic: {
    // Sharp corners, solid borders, slow restrained hovers (500ms).
    card: 'border border-border bg-card hover:border-foreground/40 hover:shadow-[0_18px_36px_-22px_hsl(var(--foreground)/0.18)] transition-all duration-500 ease-out',
    categoryFrame:
      'rounded-sm border border-border bg-muted group-hover:border-foreground/35 transition-colors duration-700 ease-out',
    categoryCaption: 'text-base sm:text-lg font-serif font-normal text-foreground tracking-tight',
    productCardName: 'font-serif font-normal text-foreground tracking-tight leading-snug',
    productCardPrice: 'font-serif font-medium text-foreground tracking-tight',
    productCardBody: 'text-center',
    productCardCta:
      'whitespace-nowrap border-y border-foreground bg-foreground px-5 py-3.5 text-sm font-serif uppercase tracking-[0.22em] text-background hover:bg-foreground/85 transition-colors duration-500 ease-out min-h-[44px]',
    sectionHeading:
      'text-[22px] sm:text-3xl md:text-4xl lg:text-5xl font-serif font-normal tracking-tight text-foreground leading-[1.1]',
    sectionSeeAll:
      'text-xl font-serif uppercase tracking-[0.22em] text-foreground/70 hover:text-foreground transition-colors duration-500',
    heroOverlay: 'bg-gradient-to-b from-foreground/10 via-foreground/15 to-foreground/40',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-serif font-normal tracking-tight text-white drop-shadow-xl leading-[1.05]',
    heroCta:
      'border border-white bg-transparent px-10 py-4 font-serif text-sm tracking-[0.22em] uppercase text-white hover:bg-white hover:text-foreground transition-colors duration-500 ease-out min-h-[44px]',
    testimonialCard: 'border border-border bg-background p-7',
    testimonialAuthor: 'text-sm font-serif uppercase tracking-[0.22em] text-foreground',
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
    card: 'bg-transparent',
    categoryFrame: 'bg-transparent',
    // Minimal's identity is whitespace + tiny tracking + ULTRA-light weight.
    // Main text still hits 16px floor for legibility (Ahmad standing rule).
    categoryCaption:
      'text-base font-extralight tracking-[0.22em] uppercase text-muted-foreground group-hover:text-foreground transition-colors duration-500',
    productCardName:
      'tracking-[0.18em] uppercase font-extralight text-muted-foreground group-hover:text-foreground transition-colors duration-500',
    productCardPrice: 'tracking-wide font-extralight text-muted-foreground',
    productCardBody: 'text-center',
    productCardCta:
      'whitespace-nowrap mx-auto inline-block border-b border-foreground/70 pb-1 text-sm font-medium uppercase tracking-[0.28em] text-foreground hover:text-foreground/70 hover:border-foreground/40 bg-transparent transition-colors duration-500 ease-out min-h-[44px]',
    sectionHeading:
      'text-[22px] sm:text-3xl md:text-4xl lg:text-5xl font-extralight tracking-tight text-foreground leading-[1.1]',
    sectionSeeAll:
      'text-xl font-extralight uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground transition-colors duration-500',
    heroOverlay: 'bg-gradient-to-b from-transparent via-transparent to-foreground/30',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extralight tracking-tight text-white drop-shadow-xl leading-[1.05]',
    heroCta:
      'inline-block border-b border-white pb-2 text-sm font-medium uppercase tracking-[0.22em] text-white hover:border-white/50 hover:text-white/80 transition-colors duration-500 ease-out min-h-[44px]',
    testimonialCard: 'border-t border-border/40 bg-transparent py-10',
    testimonialAuthor: 'text-sm font-extralight text-foreground tracking-wide',
  },
  bold: {
    // Brutalist core preserved: 2px borders + offset shadow on hover.
    // Offset shadow tinted to foreground (token-driven) so it adapts to
    // light/dark theme — not a flat black drop. Bold's voice keeps 200ms.
    card: 'border-2 border-foreground bg-card hover:translate-x-1 hover:-translate-y-1 hover:shadow-[6px_6px_0_0_hsl(var(--foreground)/0.92)] transition-all duration-200 ease-out',
    categoryFrame:
      'rounded-2xl border-2 border-foreground bg-muted group-hover:shadow-[6px_6px_0_0_hsl(var(--foreground)/0.92)] transition-shadow duration-200 ease-out',
    categoryCaption: 'text-base font-black uppercase tracking-[0.05em] text-foreground',
    productCardName: 'font-black uppercase tracking-[0.02em] text-foreground leading-tight',
    productCardPrice: 'font-black text-foreground tracking-tight',
    productCardCta:
      'whitespace-nowrap border-t-2 border-foreground bg-foreground px-5 py-3.5 text-sm font-black uppercase tracking-[0.18em] text-background hover:bg-primary hover:text-primary-foreground transition-colors duration-200 ease-out min-h-[44px]',
    sectionHeading:
      'text-[22px] sm:text-3xl md:text-4xl lg:text-5xl font-black uppercase tracking-tight text-foreground leading-[0.95]',
    sectionSeeAll:
      'text-xl font-black uppercase tracking-[0.18em] text-foreground hover:text-primary transition-colors duration-200',
    heroOverlay: 'bg-gradient-to-b from-foreground/20 via-foreground/30 to-foreground/65',
    heroHeadline:
      'text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black uppercase tracking-tight text-white drop-shadow-2xl leading-[0.9]',
    heroCta:
      'border-2 border-white bg-transparent px-8 py-4 text-base font-black uppercase tracking-[0.18em] text-white hover:bg-white hover:text-foreground transition-colors duration-200 ease-out min-h-[44px]',
    testimonialCard: 'border-2 border-foreground bg-card p-7',
    testimonialAuthor: 'text-base font-black uppercase tracking-[0.05em] text-foreground',
  },
  elegant: {
    // Hairline borders only — `border-foreground/10` to /20. Strict 200–500
    // weight range. Long 500–700ms transitions for unhurried hovers.
    card: 'border border-foreground/10 bg-card hover:border-foreground/25 transition-colors duration-700 ease-out',
    categoryFrame:
      'rounded-md border border-foreground/10 bg-muted group-hover:border-foreground/25 transition-colors duration-700 ease-out',
    // Elegant's identity is hairline weight + wide tracking — but main
    // text still hits 16px floor. Tracking + extralight weight carry
    // the elegant voice; size carries the legibility.
    categoryCaption:
      'text-base font-extralight uppercase tracking-[0.28em] text-foreground/75 group-hover:text-foreground transition-colors duration-700',
    productCardName:
      'font-light uppercase tracking-[0.22em] text-foreground/75 group-hover:text-foreground transition-colors duration-700',
    productCardPrice: 'font-light tracking-wide text-foreground',
    productCardBody: 'text-center',
    productCardCta:
      'whitespace-nowrap border-t border-foreground/15 bg-transparent px-5 py-3.5 text-sm font-medium uppercase tracking-[0.32em] text-foreground hover:bg-foreground hover:text-background transition-all duration-700 ease-out min-h-[44px]',
    sectionHeading:
      'text-[22px] sm:text-3xl md:text-4xl lg:text-5xl font-extralight tracking-[-0.01em] text-foreground leading-[1.1]',
    sectionSeeAll:
      'text-xl font-light uppercase tracking-[0.32em] text-foreground/60 hover:text-foreground transition-colors duration-700',
    heroOverlay: 'bg-gradient-to-b from-foreground/0 via-foreground/10 to-foreground/30',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extralight tracking-[-0.01em] text-white drop-shadow-xl leading-[1.05]',
    heroCta:
      'border border-white bg-transparent px-10 py-4 text-sm font-medium uppercase tracking-[0.32em] text-white hover:bg-white hover:text-foreground transition-all duration-700 ease-out min-h-[44px]',
    testimonialCard: 'border-t border-foreground/15 bg-transparent py-10',
    testimonialAuthor: 'text-sm font-light uppercase tracking-[0.22em] text-foreground/80',
  },
};

export function getPackStyles(pack: TemplateId | undefined): PackStyles {
  return PACK_STYLES[pack ?? 'modern'] ?? PACK_STYLES.modern;
}
