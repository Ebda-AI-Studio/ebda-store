import type {
  StoreLayoutSettings,
  CardSize,
  CardFrameWidth,
  CardFrameSize,
  CardGap,
  CardShape,
  CardAspect,
  CategoriesCaption,
  SizingContract,
} from './store-layout';
import { DEFAULT_LAYOUT_SETTINGS } from './store-layout';
import type { TemplateId } from './store-theme';

/**
 * The shared structural baseline — demo-shop's real (already-tokenized) layout
 * with CONTENT stripped (hero images, marketing copy) and content-gating flags
 * reset to the safe new-store defaults (testimonials/reviews OFF — KW Law
 * 39/2014 fake-reviews posture). This IS the `elegant` baseline; the other four
 * templates derive from it via `buildTemplateBaseline` (see below).
 *
 * Every color is a `token:*` ref so the Phase-1 brand engine paints it.
 */
export const BASE_BRANDED_LAYOUT: StoreLayoutSettings = {
  hero: {
    enabled: true,
    mode: 'slider',
    autoplayMs: 5000,
    slides: [],
    bgColor: 'token:primary',
    presentation: 'full-bleed',
    typography: { heading: { fontSize: '18px', textAlign: 'start' } },
  },
  categories: {
    enabled: true,
    layout: 'grid',
    captionPosition: 'below',
    desktopColumns: 3,
    mobileColumns: 2,
    bgColor: 'token:primary',
    cardGap: 'tight',
    cardSize: 'xxs',
    cardShape: 'rounded-square',
    showCardFrame: true,
    cardFrameColor: 'token:card',
    cardFrameStyle: 'shadow',
    cardFrameWidth: 'normal',
    cardFrameSize: 'normal',
    typography: {
      kicker: { color: 'token:card' },
      seeAll: { color: 'token:card', fontSize: '16px' },
      heading: { color: 'token:card', textAlign: 'center' },
      subtitle: { color: 'token:card', fontSize: '16px', textAlign: 'start' },
    },
  },
  newArrivals: {
    enabled: true,
    limit: 16,
    bgColor: 'token:card',
    cardGap: 'tight',
    cardSize: 'xs',
    cardShape: 'rounded-square',
    cardAspect: 'theme',
    showCardFrame: true,
    cardFrameColor: 'token:primary',
    cardFrameStyle: 'soft',
    cardFrameWidth: 'normal',
    cardFrameSize: 'normal',
    typography: {
      seeAll: { color: 'token:primary', textDecoration: 'none' },
      heading: { color: 'token:primary', textAlign: 'start' },
      subtitle: { color: 'token:primary' },
      productName: { color: 'token:primary' },
      productPrice: { color: 'token:primary' },
    },
  },
  bestSellers: {
    enabled: true,
    limit: 12,
    bgColor: 'token:primary',
    cardGap: 'tight',
    cardSize: 'xs',
    cardShape: 'rounded-square',
    cardAspect: 'theme',
    showCardFrame: true,
    cardFrameColor: 'token:card',
    cardFrameStyle: 'soft',
    cardFrameWidth: 'normal',
    cardFrameSize: 'normal',
    typography: {
      seeAll: { color: 'token:card' },
      heading: { color: 'token:card', textAlign: 'start' },
      productCta: { color: 'token:foreground' },
    },
  },
  filterSidebar: { enabled: true, defaultOpen: true },
  testimonials: {
    enabled: false, // reset from demo-shop's `true` — new stores start off
    minRating: 4,
    verifiedOnly: true,
    bgColor: 'token:primary',
    typography: { heading: { color: 'token:secondary', textAlign: 'start' } },
  },
  reviewSection: { enabled: false },
  trustStrip: { bgColor: 'token:card' },
  footer: { bgColor: 'token:primary' },
  productsPage: {},
  productDetailPage: {},
  categoriesPage: {},
  checkoutPage: {},
  cartPage: {},
  productCardDefaults: {
    cardSize: 'xxs',
    cardShape: 'rounded-square',
    cardFrameSize: 'compact',
    showCardFrame: true,
    cardFrameColor: 'token:primary',
  },
  sizing: {
    heroAspect: '2.45:1',
    productImageAspect: '1:1',
    categoryImageAspect: '1:1',
  },
};

/** The per-template identity — distinct numbers on the shared scale. */
export interface TemplateIdentity {
  productCardSize: CardSize; // newArrivals + bestSellers + productCardDefaults
  categoryCardSize: CardSize;
  frameWidth: CardFrameWidth;
  frameSize: CardFrameSize;
  cardGap: CardGap;
  desktopColumns: 2 | 3 | 4;
  mobileColumns: 1 | 2 | 3;
  cardShape: CardShape;
  productAspect: CardAspect; // newArrivals/bestSellers cardAspect
  productImageAspect: SizingContract['productImageAspect'];
  // Category-card identity — kept SEPARATE from the product cardShape so each
  // template's category grid reads distinctly (circle / square / overlay / …)
  // without turning product cards into circles. Amplified 2026-06-06 so the
  // demos + every store on a template show a genuinely different category look.
  categoryShape: CardShape;
  categoryCaption: CategoriesCaption; // 'below' | 'overlay'
  categoryShowFrame: boolean;
}

// Structured-clone-free deep clone good enough for plain JSON layout objects.
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * Apply a template identity to a deep clone of BASE_BRANDED_LAYOUT. Only the
 * size/frame/column/aspect knobs change; all token colors + typography +
 * section toggles stay from the base, so every template stays on-brand and
 * internally consistent while reading proportionally distinct.
 */
export function buildTemplateBaseline(identity: TemplateIdentity): StoreLayoutSettings {
  const b = clone(BASE_BRANDED_LAYOUT);

  b.categories.cardSize = identity.categoryCardSize;
  b.categories.desktopColumns = identity.desktopColumns;
  b.categories.mobileColumns = identity.mobileColumns;
  b.categories.cardFrameWidth = identity.frameWidth;
  b.categories.cardFrameSize = identity.frameSize;
  b.categories.cardGap = identity.cardGap;
  // Category-specific identity (distinct from product cardShape).
  b.categories.cardShape = identity.categoryShape;
  b.categories.captionPosition = identity.categoryCaption;
  b.categories.showCardFrame = identity.categoryShowFrame;

  for (const carousel of [b.newArrivals, b.bestSellers]) {
    carousel.cardSize = identity.productCardSize;
    carousel.cardFrameWidth = identity.frameWidth;
    carousel.cardFrameSize = identity.frameSize;
    carousel.cardGap = identity.cardGap;
    carousel.cardShape = identity.cardShape;
    carousel.cardAspect = identity.productAspect;
  }

  if (b.productCardDefaults) {
    b.productCardDefaults.cardSize = identity.productCardSize;
    b.productCardDefaults.cardFrameSize = identity.frameSize;
    b.productCardDefaults.cardShape = identity.cardShape;
  }

  b.sizing.productImageAspect = identity.productImageAspect;

  return b;
}

/** Per-template identities. elegant = the calibrated base (no delta). */
export const TEMPLATE_IDENTITIES: Record<Exclude<TemplateId, 'elegant'>, TemplateIdentity> = {
  // Modern — clean airy grid: rounded-square category tiles, caption below, framed.
  modern: {
    productCardSize: 'sm',
    categoryCardSize: 'xs',
    frameWidth: 'normal',
    frameSize: 'normal',
    cardGap: 'normal',
    desktopColumns: 4,
    mobileColumns: 2,
    cardShape: 'rounded-square',
    productAspect: 'square',
    productImageAspect: '1:1',
    categoryShape: 'rounded-square',
    categoryCaption: 'below',
    categoryShowFrame: true,
  },
  // Classic — heritage/boutique: CIRCLE category bubbles, caption below, no frame.
  classic: {
    productCardSize: 'md',
    categoryCardSize: 'sm',
    frameWidth: 'thin',
    frameSize: 'comfortable',
    cardGap: 'normal',
    desktopColumns: 3,
    mobileColumns: 3,
    cardShape: 'soft',
    productAspect: 'portrait',
    productImageAspect: '3:4',
    categoryShape: 'circle',
    categoryCaption: 'below',
    categoryShowFrame: false,
  },
  // Minimal — stark catalog: bare SQUARE tiles, no frame, caption below.
  minimal: {
    productCardSize: 'sm',
    categoryCardSize: 'xs',
    frameWidth: 'thin',
    frameSize: 'spacious',
    cardGap: 'loose',
    desktopColumns: 4,
    mobileColumns: 3,
    cardShape: 'square',
    productAspect: 'square',
    productImageAspect: '1:1',
    categoryShape: 'square',
    categoryCaption: 'below',
    categoryShowFrame: false,
  },
  // Bold — editorial poster: large 2-up tiles, caption OVERLAY on the image.
  bold: {
    productCardSize: 'lg',
    categoryCardSize: 'lg',
    frameWidth: 'thick',
    frameSize: 'compact',
    cardGap: 'tight',
    desktopColumns: 2,
    mobileColumns: 2,
    cardShape: 'rounded-square',
    productAspect: 'square',
    productImageAspect: '1:1',
    categoryShape: 'rounded-square',
    categoryCaption: 'overlay',
    categoryShowFrame: false,
  },
};

/** The packaged per-template baselines. Stores with empty layout inherit by template. */
export const TEMPLATE_LAYOUT_BASELINES: Record<TemplateId, StoreLayoutSettings> = {
  elegant: BASE_BRANDED_LAYOUT,
  modern: buildTemplateBaseline(TEMPLATE_IDENTITIES.modern),
  classic: buildTemplateBaseline(TEMPLATE_IDENTITIES.classic),
  minimal: buildTemplateBaseline(TEMPLATE_IDENTITIES.minimal),
  bold: buildTemplateBaseline(TEMPLATE_IDENTITIES.bold),
};

/** Safe lookup. Unknown id → the bare global default (back-compat behavior). */
export function getTemplateBaseline(templateId: TemplateId): StoreLayoutSettings {
  return TEMPLATE_LAYOUT_BASELINES[templateId] ?? DEFAULT_LAYOUT_SETTINGS;
}
