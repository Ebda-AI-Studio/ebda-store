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
    // Tinted shadow (foreground-hued via /5) instead of pure black; gentle
    // 0.5px lift kept (Modern's signature) but slowed to 500ms ease-out.
    card: 'rounded-2xl border border-border/60 bg-card hover:shadow-[0_24px_48px_-20px_hsl(var(--foreground)/0.12)] hover:border-foreground/15 hover:-translate-y-0.5 transition-all duration-500 ease-out',
    categoryFrame:
      'rounded-2xl bg-muted shadow-[0_10px_30px_-18px_hsl(var(--foreground)/0.10)] group-hover:shadow-[0_24px_48px_-20px_hsl(var(--foreground)/0.14)] transition-shadow duration-700 ease-out',
    categoryCaption: 'text-base sm:text-lg font-semibold text-foreground tracking-tight',
    productCardName: 'text-sm font-semibold text-foreground tracking-tight leading-snug',
    productCardPrice: 'text-base font-bold text-foreground tracking-tight',
    productCardCta:
      'rounded-full bg-foreground px-5 py-3.5 text-sm font-semibold text-background hover:bg-foreground/90 transition-colors duration-300 ease-out min-h-[44px]',
    sectionHeading:
      'text-3xl sm:text-4xl lg:text-[2.75rem] font-bold tracking-tight text-foreground leading-[1.1]',
    sectionSeeAll:
      'text-sm font-semibold text-foreground/70 hover:text-foreground transition-colors duration-300 underline-offset-4 hover:underline',
    heroOverlay: 'bg-gradient-to-b from-foreground/0 via-foreground/5 to-foreground/35',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight text-white drop-shadow-xl leading-[1.05]',
    heroCta:
      'rounded-full bg-white px-8 py-4 text-base font-semibold text-foreground hover:bg-white/95 hover:-translate-y-0.5 shadow-[0_18px_40px_-18px_rgba(255,255,255,0.45)] transition-all duration-500 ease-out min-h-[44px]',
    testimonialCard:
      'rounded-2xl border border-border/60 bg-card p-7 hover:shadow-[0_24px_48px_-20px_hsl(var(--foreground)/0.10)] hover:border-foreground/15 transition-all duration-500 ease-out',
    testimonialAuthor: 'text-base font-semibold text-foreground tracking-tight',
  },
  classic: {
    // Sharp corners, solid borders, slow restrained hovers (500ms).
    card: 'border border-border bg-card hover:border-foreground/40 hover:shadow-[0_18px_36px_-22px_hsl(var(--foreground)/0.18)] transition-all duration-500 ease-out',
    categoryFrame:
      'border border-border bg-muted group-hover:border-foreground/35 transition-colors duration-700 ease-out',
    categoryCaption: 'text-base sm:text-lg font-serif font-normal text-foreground tracking-tight',
    productCardName: 'text-sm font-serif font-normal text-foreground tracking-tight leading-snug',
    productCardPrice: 'text-base font-serif font-medium text-foreground tracking-tight',
    productCardBody: 'text-center',
    productCardCta:
      'border-y border-foreground bg-foreground px-5 py-3.5 text-xs font-serif uppercase tracking-[0.22em] text-background hover:bg-foreground/85 transition-colors duration-500 ease-out min-h-[44px]',
    sectionHeading:
      'text-3xl sm:text-4xl lg:text-5xl font-serif font-normal tracking-tight text-foreground leading-[1.1]',
    sectionSeeAll:
      'text-xs font-serif uppercase tracking-[0.22em] text-foreground/70 hover:text-foreground transition-colors duration-500',
    heroOverlay: 'bg-gradient-to-b from-foreground/10 via-foreground/15 to-foreground/40',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-serif font-normal tracking-tight text-white drop-shadow-xl leading-[1.05]',
    heroCta:
      'border border-white bg-transparent px-10 py-4 font-serif text-sm tracking-[0.22em] uppercase text-white hover:bg-white hover:text-foreground transition-colors duration-500 ease-out min-h-[44px]',
    testimonialCard: 'border border-border bg-background p-7',
    testimonialAuthor: 'text-xs font-serif uppercase tracking-[0.22em] text-foreground',
  },
  minimal: {
    // No chrome — whitespace IS the design. Slow restrained color shifts only.
    card: 'bg-transparent',
    categoryFrame: 'bg-muted/40',
    categoryCaption:
      'text-xs sm:text-sm font-light tracking-[0.22em] uppercase text-muted-foreground group-hover:text-foreground transition-colors duration-500',
    productCardName:
      'text-xs tracking-[0.18em] uppercase font-light text-muted-foreground group-hover:text-foreground transition-colors duration-500',
    productCardPrice: 'text-[11px] tracking-wide font-light text-muted-foreground',
    productCardBody: 'text-center',
    productCardCta:
      'mx-auto inline-block border-b border-foreground/70 pb-1 text-[11px] font-medium uppercase tracking-[0.28em] text-foreground hover:text-foreground/70 hover:border-foreground/40 bg-transparent transition-colors duration-500 ease-out min-h-[44px]',
    sectionHeading:
      'text-3xl sm:text-4xl lg:text-5xl font-light tracking-tight text-foreground leading-[1.1]',
    sectionSeeAll:
      'text-[11px] font-light uppercase tracking-[0.28em] text-muted-foreground hover:text-foreground transition-colors duration-500',
    heroOverlay: 'bg-gradient-to-b from-transparent via-transparent to-foreground/30',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extralight tracking-tight text-white drop-shadow-xl leading-[1.05]',
    heroCta:
      'inline-block border-b border-white pb-2 text-sm font-medium uppercase tracking-[0.22em] text-white hover:border-white/50 hover:text-white/80 transition-colors duration-500 ease-out min-h-[44px]',
    testimonialCard: 'border-t border-border/40 bg-transparent py-10',
    testimonialAuthor: 'text-sm font-light text-foreground tracking-wide',
  },
  bold: {
    // Brutalist core preserved: 2px borders + offset shadow on hover.
    // Offset shadow tinted to foreground (token-driven) so it adapts to
    // light/dark theme — not a flat black drop. Bold's voice keeps 200ms.
    card: 'border-2 border-foreground bg-card hover:translate-x-1 hover:-translate-y-1 hover:shadow-[6px_6px_0_0_hsl(var(--foreground)/0.92)] transition-all duration-200 ease-out',
    categoryFrame:
      'border-2 border-foreground bg-muted group-hover:shadow-[6px_6px_0_0_hsl(var(--foreground)/0.92)] transition-shadow duration-200 ease-out',
    categoryCaption: 'text-sm sm:text-base font-black uppercase tracking-[0.05em] text-foreground',
    productCardName: 'text-sm font-black uppercase tracking-[0.02em] text-foreground leading-tight',
    productCardPrice: 'text-base font-black text-foreground tracking-tight',
    productCardCta:
      'border-t-2 border-foreground bg-foreground px-5 py-3.5 text-sm font-black uppercase tracking-[0.18em] text-background hover:bg-primary hover:text-primary-foreground transition-colors duration-200 ease-out min-h-[44px]',
    sectionHeading:
      'text-3xl sm:text-4xl lg:text-5xl font-black uppercase tracking-tight text-foreground leading-[0.95]',
    sectionSeeAll:
      'text-xs font-black uppercase tracking-[0.18em] text-foreground hover:text-primary transition-colors duration-200',
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
      'border border-foreground/10 bg-muted group-hover:border-foreground/25 transition-colors duration-700 ease-out',
    categoryCaption:
      'text-xs sm:text-sm font-extralight uppercase tracking-[0.28em] text-foreground/75 group-hover:text-foreground transition-colors duration-700',
    productCardName:
      'text-xs font-light uppercase tracking-[0.22em] text-foreground/75 group-hover:text-foreground transition-colors duration-700',
    productCardPrice: 'text-sm font-light tracking-wide text-foreground',
    productCardBody: 'text-center',
    productCardCta:
      'border-t border-foreground/15 bg-transparent px-5 py-3.5 text-[11px] font-medium uppercase tracking-[0.32em] text-foreground hover:bg-foreground hover:text-background transition-all duration-700 ease-out min-h-[44px]',
    sectionHeading:
      'text-3xl sm:text-4xl lg:text-5xl font-extralight tracking-[-0.01em] text-foreground leading-[1.1]',
    sectionSeeAll:
      'text-[11px] font-light uppercase tracking-[0.32em] text-foreground/60 hover:text-foreground transition-colors duration-700',
    heroOverlay: 'bg-gradient-to-b from-foreground/0 via-foreground/10 to-foreground/30',
    heroHeadline:
      'text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extralight tracking-[-0.01em] text-white drop-shadow-xl leading-[1.05]',
    heroCta:
      'border border-white bg-transparent px-10 py-4 text-xs font-medium uppercase tracking-[0.32em] text-white hover:bg-white hover:text-foreground transition-all duration-700 ease-out min-h-[44px]',
    testimonialCard: 'border-t border-foreground/15 bg-transparent py-10',
    testimonialAuthor: 'text-xs font-light uppercase tracking-[0.22em] text-foreground/80',
  },
};

export function getPackStyles(pack: TemplateId | undefined): PackStyles {
  return PACK_STYLES[pack ?? 'modern'] ?? PACK_STYLES.modern;
}
