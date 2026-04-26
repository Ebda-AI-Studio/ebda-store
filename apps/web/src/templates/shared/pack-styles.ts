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
    card: 'rounded-2xl border border-border/60 bg-card hover:shadow-lg hover:-translate-y-0.5 transition-all duration-300',
    categoryFrame: 'rounded-2xl bg-muted shadow-sm',
    categoryCaption: 'text-base font-semibold text-foreground tracking-tight',
    productCardName: 'text-base font-semibold text-foreground tracking-tight',
    productCardCta:
      'rounded-full bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors',
    sectionHeading: 'text-3xl sm:text-4xl font-bold tracking-tight text-foreground leading-tight',
    sectionSeeAll: 'text-sm font-semibold text-primary hover:underline underline-offset-4',
    heroOverlay: 'bg-gradient-to-b from-foreground/0 via-foreground/10 to-foreground/40',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight text-white drop-shadow-xl leading-[1.05]',
    heroCta:
      'rounded-full bg-primary px-8 py-4 text-base font-semibold text-primary-foreground hover:bg-primary/90 shadow-lg shadow-primary/30 transition-all',
    testimonialCard:
      'rounded-2xl border border-border bg-card p-6 hover:shadow-md transition-shadow',
    testimonialAuthor: 'text-base font-semibold text-foreground',
  },
  classic: {
    card: 'border border-border bg-card hover:border-foreground/40 hover:shadow-md transition-all duration-300',
    categoryFrame: 'border border-border bg-muted',
    categoryCaption: 'text-base font-serif font-bold text-foreground tracking-tight',
    productCardName: 'text-base font-serif font-medium text-foreground tracking-tight',
    productCardCta:
      'border-y border-foreground bg-foreground px-4 py-3 text-sm font-serif uppercase tracking-[0.2em] text-background hover:bg-foreground/90 transition-colors',
    sectionHeading:
      'text-3xl sm:text-4xl font-serif font-normal tracking-tight text-foreground leading-tight',
    sectionSeeAll:
      'text-sm font-serif uppercase tracking-[0.2em] text-foreground hover:text-primary',
    heroOverlay: 'bg-gradient-to-b from-foreground/10 via-foreground/15 to-foreground/40',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-serif font-normal tracking-tight text-white drop-shadow-xl leading-[1.05]',
    heroCta:
      'border-2 border-white bg-transparent px-10 py-4 font-serif text-base tracking-[0.25em] uppercase text-white hover:bg-white hover:text-foreground transition-colors duration-300',
    testimonialCard: 'border border-border bg-background p-6',
    testimonialAuthor: 'text-sm font-serif uppercase tracking-[0.2em] text-foreground',
  },
  minimal: {
    card: 'bg-transparent',
    categoryFrame: 'bg-muted',
    categoryCaption: 'text-base font-light text-foreground tracking-wide',
    productCardName: 'text-base font-light text-foreground tracking-wide',
    productCardCta:
      'mx-auto inline-block border-b-2 border-foreground pb-1 text-sm font-medium uppercase tracking-[0.2em] text-foreground hover:text-primary hover:border-primary bg-transparent transition-colors',
    sectionHeading: 'text-3xl sm:text-4xl font-light tracking-tight text-foreground leading-tight',
    sectionSeeAll:
      'text-sm font-light uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground',
    heroOverlay: 'bg-gradient-to-b from-transparent via-transparent to-foreground/30',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extralight tracking-tight text-white drop-shadow-xl leading-[1.05]',
    heroCta:
      'inline-block border-b-2 border-white pb-2 text-base font-medium uppercase tracking-[0.2em] text-white hover:border-primary hover:text-primary transition-colors',
    testimonialCard: 'border-t border-border bg-transparent py-8',
    testimonialAuthor: 'text-sm font-light text-foreground tracking-wide',
  },
  bold: {
    card: 'border-2 border-foreground bg-card hover:translate-x-1 hover:-translate-y-1 hover:shadow-[6px_6px_0_0_hsl(var(--foreground))] transition-all duration-200',
    categoryFrame: 'border-2 border-foreground bg-muted',
    categoryCaption: 'text-base font-black uppercase tracking-wider text-foreground',
    productCardName: 'text-base font-black uppercase tracking-wide text-foreground',
    productCardCta:
      'border-t-2 border-foreground bg-foreground px-4 py-3 text-sm font-black uppercase tracking-[0.15em] text-background hover:bg-primary hover:text-primary-foreground transition-colors',
    sectionHeading:
      'text-4xl sm:text-5xl font-black uppercase tracking-tight text-foreground leading-[0.95]',
    sectionSeeAll:
      'text-sm font-black uppercase tracking-[0.15em] text-foreground hover:text-primary',
    heroOverlay: 'bg-gradient-to-b from-foreground/20 via-foreground/30 to-foreground/60',
    heroHeadline:
      'text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black uppercase tracking-tight text-white drop-shadow-2xl leading-[0.9]',
    heroCta:
      'border-2 border-white bg-transparent px-8 py-4 text-base font-black uppercase tracking-[0.2em] text-white hover:bg-white hover:text-foreground transition-colors',
    testimonialCard: 'border-2 border-foreground bg-card p-6',
    testimonialAuthor: 'text-base font-black uppercase tracking-wide text-foreground',
  },
  elegant: {
    card: 'border border-border/50 bg-card hover:border-foreground/30 transition-colors duration-500',
    categoryFrame: 'border border-border/50 bg-muted',
    categoryCaption: 'text-sm font-light uppercase tracking-[0.2em] text-foreground/80',
    productCardName: 'text-sm font-light uppercase tracking-[0.2em] text-foreground/80',
    productCardCta:
      'border-t border-foreground/30 bg-transparent px-4 py-3 text-xs font-medium uppercase tracking-[0.3em] text-foreground hover:bg-foreground hover:text-background transition-all duration-500',
    sectionHeading:
      'text-3xl sm:text-4xl font-extralight tracking-wide text-foreground leading-tight',
    sectionSeeAll:
      'text-xs font-light uppercase tracking-[0.3em] text-muted-foreground hover:text-foreground',
    heroOverlay: 'bg-gradient-to-b from-foreground/5 via-foreground/10 to-foreground/30',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extralight tracking-tight text-white drop-shadow-xl leading-[1.05]',
    heroCta:
      'border border-white bg-transparent px-10 py-4 text-sm font-medium uppercase tracking-[0.3em] text-white hover:bg-white hover:text-foreground transition-all duration-500',
    testimonialCard: 'border-t border-foreground/20 bg-transparent py-8',
    testimonialAuthor: 'text-sm font-light uppercase tracking-[0.2em] text-foreground/80',
  },
};

export function getPackStyles(pack: TemplateId | undefined): PackStyles {
  return PACK_STYLES[pack ?? 'modern'] ?? PACK_STYLES.modern;
}
