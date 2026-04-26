import type { TemplateId } from '@force/shared';

/**
 * Per-pack style tokens for the 5 shared Pecannbee-flow sections
 * (HeroBanner, HeroSlider, CategoryStrip, ProductCarousel, TestimonialRow).
 *
 * Each pack inherits the same layout shape but applies its own border style,
 * radius, font, and weight. Driven from spec § 7 of the Pecannbee design doc.
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
    card: 'rounded-2xl border border-border/60 bg-card hover:shadow-md transition-shadow',
    categoryFrame: 'rounded-2xl bg-muted',
    categoryCaption: 'text-sm font-semibold text-foreground',
    productCardName: 'text-sm font-medium text-foreground',
    productCardCta:
      'rounded-full bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90',
    sectionHeading: 'text-2xl font-semibold tracking-tight text-foreground',
    sectionSeeAll: 'text-sm font-medium text-primary hover:underline',
    heroOverlay: 'bg-foreground/10',
    heroHeadline:
      'text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-semibold tracking-tight text-white drop-shadow-lg',
    heroCta:
      'rounded-full bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90',
    testimonialCard:
      'rounded-2xl border border-border bg-card p-5 hover:shadow-sm transition-shadow',
    testimonialAuthor: 'text-sm font-medium text-foreground',
  },
  classic: {
    card: 'border border-border bg-card',
    categoryFrame: 'border border-border bg-muted',
    categoryCaption: 'text-sm font-serif font-bold text-foreground',
    productCardName: 'text-sm font-serif text-foreground',
    productCardCta:
      'border border-foreground bg-foreground px-3 py-2 text-xs font-serif uppercase tracking-widest text-background hover:bg-foreground/90',
    sectionHeading: 'text-2xl font-serif font-normal tracking-tight text-foreground',
    sectionSeeAll:
      'text-xs font-serif uppercase tracking-widest text-foreground hover:text-primary',
    heroOverlay: 'bg-foreground/15',
    heroHeadline:
      'text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-serif font-normal tracking-tight text-white drop-shadow-lg',
    heroCta:
      'border border-white bg-transparent px-8 py-3 font-serif text-sm tracking-widest uppercase text-white hover:bg-white hover:text-foreground transition-colors duration-300',
    testimonialCard: 'border border-border bg-background p-6',
    testimonialAuthor: 'text-xs font-serif uppercase tracking-widest text-foreground',
  },
  minimal: {
    card: 'bg-transparent',
    categoryFrame: 'bg-muted',
    categoryCaption: 'text-sm font-light text-foreground',
    productCardName: 'text-sm font-light text-foreground',
    productCardCta:
      'border-b border-foreground pb-1 text-xs font-light uppercase tracking-widest text-foreground hover:text-primary bg-transparent',
    sectionHeading: 'text-2xl font-light tracking-tight text-foreground',
    sectionSeeAll:
      'text-xs font-light uppercase tracking-widest text-muted-foreground hover:text-foreground',
    heroOverlay: '',
    heroHeadline:
      'text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-extralight tracking-tight text-white drop-shadow-lg',
    heroCta:
      'inline-block border-b border-white pb-1 text-xs font-light uppercase tracking-widest text-white hover:border-primary hover:text-primary',
    testimonialCard: 'border-t border-border bg-transparent py-6',
    testimonialAuthor: 'text-xs font-light text-foreground',
  },
  bold: {
    card: 'border-2 border-foreground bg-card',
    categoryFrame: 'border-2 border-foreground bg-muted',
    categoryCaption: 'text-sm font-black uppercase tracking-wider text-foreground',
    productCardName: 'text-sm font-black uppercase tracking-wide text-foreground',
    productCardCta:
      'border-2 border-foreground bg-foreground px-3 py-2 text-xs font-black uppercase tracking-widest text-background hover:bg-background hover:text-foreground transition-colors',
    sectionHeading: 'text-3xl font-black uppercase tracking-tight text-foreground',
    sectionSeeAll:
      'text-xs font-black uppercase tracking-widest text-foreground hover:text-primary',
    heroOverlay: 'bg-foreground/30',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-black uppercase tracking-tight text-white drop-shadow-lg',
    heroCta:
      'border-2 border-white bg-transparent px-6 py-3 text-sm font-black uppercase tracking-widest text-white hover:bg-white hover:text-foreground transition-colors',
    testimonialCard: 'border-2 border-foreground bg-card p-5',
    testimonialAuthor: 'text-sm font-black uppercase tracking-wide text-foreground',
  },
  elegant: {
    card: 'border border-border/50 bg-card',
    categoryFrame: 'border border-border/50 bg-muted',
    categoryCaption: 'text-xs font-light uppercase tracking-[0.15em] text-foreground/80',
    productCardName: 'text-xs font-light uppercase tracking-[0.15em] text-foreground/80',
    productCardCta:
      'border border-foreground bg-transparent px-3 py-2 text-[10px] font-light uppercase tracking-[0.25em] text-foreground hover:bg-foreground hover:text-background transition-all duration-500',
    sectionHeading: 'text-2xl font-light tracking-wide text-foreground',
    sectionSeeAll:
      'text-xs font-light uppercase tracking-[0.3em] text-muted-foreground hover:text-foreground',
    heroOverlay: 'bg-foreground/10',
    heroHeadline:
      'text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-extralight tracking-tight text-white drop-shadow-lg',
    heroCta:
      'border border-white bg-transparent px-8 py-4 text-xs font-medium uppercase tracking-[0.25em] text-white hover:bg-white hover:text-foreground transition-all duration-500',
    testimonialCard: 'border-t border-foreground/20 bg-transparent py-8',
    testimonialAuthor: 'text-xs font-light uppercase tracking-[0.2em] text-foreground/80',
  },
};

export function getPackStyles(pack: TemplateId | undefined): PackStyles {
  return PACK_STYLES[pack ?? 'modern'] ?? PACK_STYLES.modern;
}
