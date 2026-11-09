'use client';

import React from 'react';
import type { Product, Category, PublicTag } from '@/lib/api';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useCart } from '../../contexts/CartContext';
import { SectionErrorBoundary } from '../../components';
import { BrandStoryBlock } from '../../templates/shared/BrandStoryBlock';
import { TrustStrip, resolveTrustStripItems } from '../../templates/shared/TrustStrip';
import { HomeBlogCarousel } from '../../templates/shared/HomeBlogCarousel';
import { SectionDivider, resolveSlotDividerSettings } from '../../templates/shared/SectionDivider';
import { toTemplateProduct, toTemplateCategory } from '../../templates/adapters';
import { getHomepageTemplate } from '../../lib/serverTemplate';
import type { TemplateId, PageDefinition, SectionNode } from '@ebda/shared';
import {
  sanitizeUrl,
  definitionToLayout,
  documentForLook,
  getLook,
  getSectionDefinition,
  INVERSE_SURFACE,
  renderableSections,
  resolveColor,
  sectionToLegacy,
} from '@ebda/shared';
import { EmptyHeroSlideHint, EmptySectionHint, type EmptySectionKind } from './EmptySectionHint';
import { ImageTextSection, type ImageTextSettings } from '../sections/ImageTextSection';
import { NewsletterSection, type NewsletterSettings } from '../sections/NewsletterSection';
import {
  FeaturedCollectionSection,
  type FeaturedCollectionSettings,
} from '../sections/FeaturedCollectionSection';
import {
  CollectionListSection,
  type CollectionListSettings,
} from '../sections/CollectionListSection';
import {
  ProductSpotlightSection,
  type ProductSpotlightSettings,
} from '../sections/ProductSpotlightSection';
import { TrustBadgesSection, type TrustBadgesSettings } from '../sections/TrustBadgesSection';
import { ShopTheLookSection, type ShopTheLookSettings } from '../sections/ShopTheLookSection';
import { StepsSection, type StepsSettings } from '../sections/StepsSection';
import { MenuSection } from '../sections/MenuSection';
import { ReorderRow } from '../sections/ReorderRow';
import { MakerProfileSection, type MakerProfileSettings } from '../sections/MakerProfileSection';
import { GiftFinderSection, type GiftFinderSettings } from '../sections/GiftFinderSection';
import {
  SIGNATURE_TYPES,
  SignatureSection,
  isSignatureType,
  type SignatureSettings,
} from '../sections/SignatureSection';
import { SectionHeader } from '../sections/SectionHeader';
import { EditorModeProvider } from './editor-mode';
import { TagChips } from '../../templates/shared/TagChips';
import { HeroCollage } from '../../templates/shared/HeroCollage';
import { resolveSectionProducts, onSaleProducts } from '../sections/section-products';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { CategoryChips } from '../../templates/shared/CategoryChips';
import { CategoryRail } from '../../templates/shared/CategoryRail';
import { CategoryTiles } from '../../templates/shared/CategoryTiles';
import { CompactHeroBand } from '../../templates/shared/CompactHeroBand';
import {
  sectionMarginClasses,
  sectionSpacingClasses,
  sectionVisibilityClass,
} from '../../templates/shared/section-spacing';
import { resolveSectionZone } from '../../templates/shared/section-typography';

/**
 * Renders a `PageDefinition` (visual builder Phase 1) with the storefront's
 * existing section components — there is no second style path.
 *
 * The section bodies below are the pre-builder `HomePageContent` code, moved
 * here unchanged except for two things:
 *   1. `layout` is the document projected back onto the legacy shape
 *      (`definitionToLayout`), so every cross-section rule (dividers hidden
 *      next to a coloured neighbour, the featured fallback) reads exactly
 *      what it read before;
 *   2. ORDER comes from `definition.sections` instead of
 *      `layout.sectionOrder` + "extras last".
 * Unknown section types (a document from a newer editor) are skipped, never
 * thrown. The header and footer section groups are rendered by
 * `ShopChrome` around this component, not here.
 *
 * Output equivalence with the pre-builder renderer is pinned by
 * `tests/unit/builder-homepage-characterization.test.tsx` (byte-identical
 * HTML over 6 golden layouts x 2 stores x 5 templates x en/ar).
 */
interface HomepageTestimonial {
  id: string;
  rating: number;
  title: string | null;
  comment: string;
  authorName: string | null;
  authorCity: string | null;
  createdAt: string;
}

export interface PageRendererProps {
  definition: PageDefinition;
  templateId: TemplateId;
  featuredProducts: Product[];
  newArrivals: Product[];
  bestSellers: Product[];
  categories: Category[];
  testimonials: HomepageTestimonial[];
  /** Additional products server-fetched for layout.extracarousels entries
   *  (category-slug and manual-ids sources). Merged into the union the
   *  storefront filters against. */
  extraProducts?: Product[];
  /** The API's `sort=on_sale` result in its own order; the deals row reads it as-is. Absent (the
   *  editor canvas, a page that fetched none) = the client derivation over the loaded pools. */
  onSalePool?: Product[];
  /**
   * The skin-type / concern chips (`GET /public/tags`, Phase B3): tags that carry at least one
   * published product. Read only by a `category-grid` whose `source` is `tags`.
   */
  tags?: PublicTag[];
  /**
   * Editor canvas only (token-gated preview): wrap each section in a
   * `display: contents` marker carrying its id so the overlay can select it,
   * and mark inline-editable text. Never set on a public render, so public
   * markup is unchanged (characterization snapshots).
   */
  editorMode?: boolean;
}

/**
 * `HeroSlide.image` is optional on the TYPE only so a draft can hold a
 * just-added slide with no image chosen yet (`validatePublishReadiness`
 * refuses to publish any visible slide without one, so a live render should
 * never actually see this filter remove anything — it's defense in depth
 * against a document published before that gate existed).
 */
function heroSlidesWithImage<T extends { image?: string }>(
  slides: readonly T[]
): Array<T & { image: string }> {
  return slides.filter((s): s is T & { image: string } => !!s.image);
}

const NO_PRODUCTS: Product[] = [];

/** The document-only section types `DocumentSectionBody` draws (every other type draws nothing). */
const DOCUMENT_SECTION_TYPES = new Set([
  'featured-collection',
  'gift-finder',
  'maker-profile',
  'collection-list',
  'product-spotlight',
  'shop-the-look',
  'steps',
  'trust-badges',
  'image-text',
  'newsletter',
  // T7 signature sections (one per template)
  ...SIGNATURE_TYPES,
]);

/** A function with a forever-stable identity that always calls the latest one passed in. */
function useLatestCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = React.useRef(fn);
  ref.current = fn;
  return React.useCallback((...args: A) => ref.current(...args), []);
}

/** The previous object while the new one is structurally equal (JSON), so memoized children skip. */
function useStableValue<T>(value: T): T {
  const ref = React.useRef<{ json: string; value: T } | null>(null);
  const json = JSON.stringify(value);
  if (!ref.current || ref.current.json !== json) ref.current = { json, value };
  return ref.current.value;
}

interface DocumentSectionBodyProps {
  section: SectionNode;
  newArrivals: Product[];
  bestSellers: Product[];
  featured: Product[];
  extra: Product[];
  onSale?: Product[];
  categories: Category[];
  templateId: TemplateId;
  editorMode: boolean;
  showPrice: boolean;
  layout: ReturnType<typeof definitionToLayout>;
  stagePriority: boolean;
  onAddToCart: (productId: string) => Promise<void>;
}

/**
 * One document-only section. Memoized: the parsed document keeps the identity of every section a
 * `render` message did not change (`shareStructure`), so typing in one text re-renders this body
 * for that section only. Every other prop is a stable reference or a primitive.
 */
export const DocumentSectionBody = React.memo(function DocumentSectionBody({
  section,
  newArrivals,
  bestSellers,
  featured: featuredProducts,
  extra,
  onSale: onSalePool,
  categories,
  templateId,
  editorMode,
  showPrice,
  layout,
  stagePriority,
  onAddToCart,
}: DocumentSectionBodyProps) {
  const { store } = useStore();
  const def = getSectionDefinition(section.type)!;
  const settings = sectionToLegacy(section, '') as Record<string, unknown>;
  const pools = { newArrivals, bestSellers, featured: featuredProducts, extra, onSale: onSalePool };
  return def.type === 'featured-collection' &&
    (settings as { productSource?: string }).productSource === 'reorder' ? (
    <ReorderRow
      title={(settings as FeaturedCollectionSettings).heading}
      titleAr={(settings as FeaturedCollectionSettings).headingAr}
      limit={(settings as FeaturedCollectionSettings).limit}
      pack={templateId}
      onAddToCart={onAddToCart}
      sectionProps={{
        className: `bg-[hsl(var(--bg-page))] ${sectionSpacingClasses(settings as FeaturedCollectionSettings, store.look).wrapperClass}`,
        style: sectionBgStyle((settings as FeaturedCollectionSettings).bgColor, store.theme),
      }}
    />
  ) : def.type === 'featured-collection' &&
    (settings as FeaturedCollectionSettings).layout === 'menu' ? (
    <MenuSection
      sectionId={section.id}
      settings={settings as FeaturedCollectionSettings}
      products={resolveSectionProducts(settings as FeaturedCollectionSettings, pools, 24)}
      categories={categories}
      pack={templateId}
      onAddToCart={onAddToCart}
      editorMode={editorMode}
    />
  ) : isSignatureType(def.type) ? (
    <SignatureSection
      type={def.type}
      settings={settings as SignatureSettings}
      blocks={section.blocks ?? []}
      pack={templateId}
      editorMode={editorMode}
    />
  ) : def.type === 'gift-finder' ? (
    <GiftFinderSection
      settings={settings as GiftFinderSettings}
      blocks={section.blocks ?? []}
      categories={categories}
      editorMode={editorMode}
    />
  ) : def.type === 'maker-profile' ? (
    <MakerProfileSection settings={settings as MakerProfileSettings} editorMode={editorMode} />
  ) : def.type === 'featured-collection' ? (
    <FeaturedCollectionSection
      settings={settings as FeaturedCollectionSettings}
      products={resolveSectionProducts(settings as FeaturedCollectionSettings, pools, 8).map(
        toTemplateProduct
      )}
      pack={templateId}
      onAddToCart={onAddToCart}
      editorMode={editorMode}
    />
  ) : def.type === 'collection-list' ? (
    <CollectionListSection
      settings={settings as CollectionListSettings}
      blocks={section.blocks ?? []}
      categories={categories}
      editorMode={editorMode}
    />
  ) : def.type === 'product-spotlight' ? (
    <ProductSpotlightSection
      settings={settings as ProductSpotlightSettings}
      products={resolveSectionProducts(
        settings as ProductSpotlightSettings,
        pools,
        // A stage shows exactly one product; the list shows up to three.
        (settings as ProductSpotlightSettings).layout === 'stage' ? 1 : 3
      ).map(toTemplateProduct)}
      editorMode={editorMode}
      onAddToCart={onAddToCart}
      priority={stagePriority}
      showPrice={showPrice}
    />
  ) : def.type === 'shop-the-look' ? (
    <ShopTheLookSection
      sectionId={section.id}
      settings={settings as ShopTheLookSettings}
      blocks={section.blocks ?? []}
      // Store-scoped pools only: an unknown or foreign id is absent, never rendered (C11).
      products={[...pools.newArrivals, ...pools.bestSellers, ...pools.featured, ...pools.extra]}
      editorMode={editorMode}
      showPrice={showPrice}
      cardLayout={layout}
    />
  ) : def.type === 'steps' ? (
    <StepsSection
      settings={settings as StepsSettings}
      blocks={section.blocks ?? []}
      // Store-scoped pools only: an unknown or foreign id is absent (C11).
      products={[...pools.newArrivals, ...pools.bestSellers, ...pools.featured, ...pools.extra]}
      editorMode={editorMode}
      showPrice={showPrice}
      cardLayout={layout}
    />
  ) : def.type === 'trust-badges' ? (
    <TrustBadgesSection
      settings={settings as TrustBadgesSettings}
      blocks={section.blocks ?? []}
      editorMode={editorMode}
    />
  ) : def.type === 'image-text' ? (
    <ImageTextSection settings={settings as ImageTextSettings} editorMode={editorMode} />
  ) : def.type === 'newsletter' ? (
    <NewsletterSection settings={settings as NewsletterSettings} editorMode={editorMode} />
  ) : null;
});

export function PageRenderer({
  definition: storedDefinition,
  editorMode = false,
  templateId,
  featuredProducts,
  newArrivals,
  bestSellers,
  categories,
  testimonials,
  extraProducts,
  onSalePool,
  tags = [],
}: PageRendererProps) {
  // The legacy-shaped view of the document: section props plus the
  // cross-section lookups the dividers and the featured fallback need.
  const { store } = useStore();
  // Under a look with a section mix, sections tagged for another look are left out (C10).
  const definition = documentForLook(storedDefinition, getLook(store.look));
  const layout = definitionToLayout(definition);
  const { language } = useLanguage();
  const { addItem } = useCart();
  const storeUrl = useStoreUrl();

  const isRtl = language === 'ar';
  const T = getHomepageTemplate(templateId);
  // The "Featured products" fallback exists so a page never ends without
  // products; a document that already shows products in a builder product
  // section (or a carousel) does not need it.
  const documentShowsProducts = definition.sections.some(
    n =>
      n.hidden !== true &&
      (n.type === 'featured-collection' ||
        n.type === 'product-spotlight' ||
        n.type === 'shop-the-look' ||
        n.type === 'product-carousel')
  );

  // Effective card-price visibility: the store-level master toggle
  // (theme.showPriceOnCards) composes with the per-card default
  // (productCardDefaults.showCardPrice) — either being false hides the price.
  // The master toggle's read was dropped in the 2026-06 consolidation; this
  // restores it so a store that hid prices store-wide stays hidden on EVERY
  // card surface, not just whichever one happened to read showCardPrice.
  const showCardPriceEff =
    store.theme?.showPriceOnCards === false ? false : layout.productCardDefaults?.showCardPrice;

  // Per-section typography zones. Global zones are not accessible client-side
  // here (they're applied via CSS injection in layout.tsx), so we pass
  // undefined for the global zone — resolveSectionZone returns just the
  // section-level override values. When no per-section override is set,
  // resolveSectionZone returns undefined and SectionHeading uses its
  // default CSS class styling (no inline style applied).
  // Hero heading typography zone — wires the merchant's per-section heading
  // override to the HeroBanner / HeroSlider headline h1.
  const heroHeadingZone = resolveSectionZone(
    layout.hero.typography?.heading,
    undefined,
    store.theme
  );

  const categoriesHeadingZone = resolveSectionZone(
    layout.categories.typography?.heading,
    undefined,
    store.theme
  );
  const categoriesKickerZone = resolveSectionZone(
    layout.categories.typography?.kicker,
    undefined,
    store.theme
  );
  const categoriesSubtitleZone = resolveSectionZone(
    layout.categories.typography?.subtitle,
    undefined,
    store.theme
  );
  const categoriesSeeAllZone = resolveSectionZone(
    layout.categories.typography?.seeAll,
    undefined,
    store.theme
  );
  const categoriesLabelZone = resolveSectionZone(
    layout.categories.typography?.categoryLabel,
    undefined,
    store.theme
  );

  const newArrivalsHeadingZone = resolveSectionZone(
    layout.newArrivals.typography?.heading,
    undefined,
    store.theme
  );
  const newArrivalsKickerZone = resolveSectionZone(
    layout.newArrivals.typography?.kicker,
    undefined,
    store.theme
  );
  const newArrivalsSubtitleZone = resolveSectionZone(
    layout.newArrivals.typography?.subtitle,
    undefined,
    store.theme
  );
  const newArrivalsSeeAllZone = resolveSectionZone(
    layout.newArrivals.typography?.seeAll,
    undefined,
    store.theme
  );
  const newArrivalsProductNameZone = resolveSectionZone(
    layout.newArrivals.typography?.productName,
    undefined,
    store.theme
  );
  const newArrivalsProductPriceZone = resolveSectionZone(
    layout.newArrivals.typography?.productPrice,
    undefined,
    store.theme
  );
  const newArrivalsProductCtaZone = resolveSectionZone(
    layout.newArrivals.typography?.productCta,
    undefined,
    store.theme
  );

  const bestSellersHeadingZone = resolveSectionZone(
    layout.bestSellers.typography?.heading,
    undefined,
    store.theme
  );
  const bestSellersKickerZone = resolveSectionZone(
    layout.bestSellers.typography?.kicker,
    undefined,
    store.theme
  );
  const bestSellersSubtitleZone = resolveSectionZone(
    layout.bestSellers.typography?.subtitle,
    undefined,
    store.theme
  );
  const bestSellersSeeAllZone = resolveSectionZone(
    layout.bestSellers.typography?.seeAll,
    undefined,
    store.theme
  );
  const bestSellersProductNameZone = resolveSectionZone(
    layout.bestSellers.typography?.productName,
    undefined,
    store.theme
  );
  const bestSellersProductPriceZone = resolveSectionZone(
    layout.bestSellers.typography?.productPrice,
    undefined,
    store.theme
  );
  const bestSellersProductCtaZone = resolveSectionZone(
    layout.bestSellers.typography?.productCta,
    undefined,
    store.theme
  );

  const testimonialsHeadingZone = resolveSectionZone(
    layout.testimonials.typography?.heading,
    undefined,
    store.theme
  );
  const testimonialsKickerZone = resolveSectionZone(
    layout.testimonials.typography?.kicker,
    undefined,
    store.theme
  );
  const testimonialsSubtitleZone = resolveSectionZone(
    layout.testimonials.typography?.subtitle,
    undefined,
    store.theme
  );

  // Build a single lookup so the cart-add handler works for products from any
  // of the three sources (featured, new arrivals, best sellers).
  const allProducts = [...featuredProducts, ...newArrivals, ...bestSellers];
  const productById = new Map(allProducts.map(p => [p.id, p]));

  const handleAddToCart = async (productId: string) => {
    const product = productById.get(productId);
    if (!product) return;
    addItem(
      {
        id: product.id,
        name: product.name,
        nameAr: product.nameAr ?? undefined,
        price: product.price,
        slug: product.slug,
        image: product.images?.[0]?.url,
      },
      1
    );
  };

  // Task 13: the document-only sections are memoized by node identity, so a text edit re-renders
  // ONE section. Their handler and layout props must not change identity while their value is the
  // same, or every edit would still repaint the whole page.
  const stableAddToCart = useLatestCallback(handleAddToCart);
  const stableLayout = useStableValue(layout);

  const templateProducts = featuredProducts.map(toTemplateProduct);
  const templateNewArrivals = newArrivals.map(toTemplateProduct);
  const templateBestSellers = bestSellers.map(toTemplateProduct);
  // Homepage category strip: only categories the merchant left visible
  // (showOnHomeStrip !== false). Hiding a category here never affects its
  // collection page, nav, or product filters — those use the full list.
  // The virtual "Best Sellers" tile (slug 'best-sellers', synthesized by the
  // API) has no Category row, so it can't carry showOnHomeStrip — gate it on
  // the store-level `showBestSellersTile` theme flag instead (default true).
  // Hiding it here leaves the Best Sellers carousel + listing page untouched.
  const hideBestSellersTile = store.theme?.showBestSellersTile === false;
  const templateCategories = categories
    .filter(c => c.showOnHomeStrip !== false)
    .filter(c => !(hideBestSellersTile && c.slug === 'best-sellers'))
    .map(toTemplateCategory);

  // Hero customization. Read from the StoreContext store — single source of
  // truth on the client. The fallback for an empty headline is the store's
  // own name (per locale), not a marketing demo string. Subtitle stays empty
  // when the merchant hasn't written one — better to show nothing than a
  // generic "Premium products, fast delivery..." strapline that's not true
  // for every tenant. CTA text + link have safe generic defaults because
  // they're functional UI, not content.
  const heroTitleEn = store.heroTitle || store.name || '';
  const heroTitleArVal = store.heroTitleAr || store.nameAr || store.name || '';
  const heroSubtitleEn = store.heroSubtitle || '';
  const heroSubtitleArVal = store.heroSubtitleAr || '';
  const heroCtaEn = store.heroCtaText || 'Shop Now';
  const heroCtaArVal = store.heroCtaTextAr || 'تسوق الآن';
  // Defensive: sanitize the merchant-supplied CTA link scheme before it reaches
  // an `<a href>`. The server schema rejects unsafe values, but legacy rows
  // saved before that shipped (or a direct DB write) could still carry a
  // `javascript:` link — `sanitizeUrl` degrades those to '#'.
  const heroCtaLink = store.heroCtaLink
    ? storeUrl(sanitizeUrl(store.heroCtaLink, '/products'))
    : storeUrl('/products');
  const heroImage = store.heroImage || undefined;

  // Hero rendering: prefer the new HeroSlider/HeroBanner shells when the
  // store has supplied slides via layout.hero. When no slides exist we fall
  // back to the legacy T.Hero (which uses the per-store hero text fields).
  // Canvas only: each slide carries its document block id so a click on it selects
  // the slide. The legacy layout drops hidden slides in order, so the ids line up
  // one to one; when they do not (a stale legacy fallback) no slide is marked.
  const heroBlockIds = editorMode
    ? (definition.sections
        .find(n => n.type === 'hero')
        ?.blocks?.filter(b => b.type === 'slide' && b.hidden !== true)
        .map(b => b.id) ?? [])
    : [];
  const heroSlides: Array<(typeof layout.hero.slides)[number] & { builderBlockId?: string }> =
    heroBlockIds.length === layout.hero.slides.length
      ? layout.hero.slides.map((sl, i) => ({ ...sl, builderBlockId: heroBlockIds[i] }))
      : layout.hero.slides;
  // Collage (Ruling B1-2): needs three slides with a photo (`image`; HeroCollage shows `imageAr` in Arabic when set); with fewer, the
  // hero renders as the banner / slider below in full-bleed.
  const collageEligible =
    layout.hero.enabled &&
    layout.hero.presentation === 'collage' &&
    heroSlidesWithImage(heroSlides).length >= 3;
  // Opt-in hero design key (Ruling B1-41): only a hero set to `frame: 'line'` (Vitrine's mix, or a
  // merchant's pick) draws the hairline and fills its frame; every other framed hero is unchanged.
  const heroFrameLine = layout.hero.frame === 'line';
  const bannerPresentation =
    layout.hero.presentation === 'collage' ? 'full-bleed' : layout.hero.presentation;
  const sliderEligible =
    !collageEligible &&
    layout.hero.mode === 'slider' &&
    layout.hero.slides.length > 0 &&
    !!T.HeroSlider;
  const bannerEligible =
    !collageEligible &&
    layout.hero.mode === 'single' &&
    layout.hero.slides.length > 0 &&
    !!T.HeroBanner;
  // The legacy T.Hero is only useful when the merchant has supplied at
  // least one piece of content for it (title, subtitle, or image). With
  // all three empty we'd render a hero with nothing in it, which is
  // worse than just skipping the section.
  const legacyHeroHasContent = !!(
    heroTitleEn ||
    heroTitleArVal ||
    heroSubtitleEn ||
    heroSubtitleArVal ||
    heroImage
  );

  // a11y P2-2: a home with no hero section (Catalogue, Showroom) still opens with an h1, the
  // store's name. A document hero (any presentation) emits its own.
  const homeHasHero =
    definition.sections.some(n => n.type === 'hero' && n.hidden !== true) &&
    layout.hero.enabled &&
    (collageEligible ||
      sliderEligible ||
      (bannerEligible && !!heroSlidesWithImage(heroSlides)[0]) ||
      legacyHeroHasContent);

  // Data-driven sections render nothing publicly when they have nothing to
  // show (never an empty shell, never a stray divider). In the editor canvas
  // they show a dashed hint instead, so the merchant can still see and select
  // them. A section the merchant switched off shows neither.
  // A tag-sourced row (Phase B3, Ruling B3-5) lists the store's tags instead of its categories; a
  // tag with no published product never reaches `tags`, so an empty list means no section.
  const tagSource = layout.categories.source === 'tags';
  const categoriesVisible =
    layout.categories.enabled && (tagSource ? tags.length > 0 : templateCategories.length > 0);
  const newArrivalsVisible = layout.newArrivals.enabled && templateNewArrivals.length > 0;
  const bestSellersVisible = layout.bestSellers.enabled && templateBestSellers.length > 0;
  const testimonialsVisible =
    layout.testimonials.enabled && testimonials.length > 0 && !!T.TestimonialRow;
  const brandStoryEnabled = layout.brandStory?.enabled ?? store.theme?.showBrandStory !== false;
  const brandStoryVisible =
    brandStoryEnabled &&
    !!(store.heroImage || store.description?.trim() || store.descriptionAr?.trim());
  // Trust strip: `items` absent = legacy store (fixed defaults, always something
  // to show); present = merchant-owned, hidden while it has no usable item.
  const trustStripEnabled = layout.trustStrip?.enabled ?? store.theme?.showTrustStrip !== false;
  const trustStripVisible =
    trustStripEnabled && resolveTrustStripItems(layout.trustStrip?.items, isRtl).length > 0;
  const emptyHint = (kind: EmptySectionKind, enabled: boolean, visible: boolean) =>
    editorMode && enabled && !visible ? <EmptySectionHint kind={kind} /> : null;
  // A divider only separates two rendered sections.
  const dividerOk = (visible: boolean) => visible || editorMode;

  const body = (
    <>
      {/* Section titles. Each section settings type extends
          SectionTitleOverride, so the merchant can change the heading
          via the admin Layout page. Empty / unset falls back to the
          platform default.
          Order comes from the document (`definition.sections`). */}
      {(() => {
        // ── Section title locals ──────────────────────────────────────────
        const categoriesTitle = layout.categories.title || 'Shop by Category';
        const categoriesTitleAr = layout.categories.titleAr || 'تسوق حسب الفئة';
        const newArrivalsTitle = layout.newArrivals.title || 'New Arrivals';
        const newArrivalsTitleAr = layout.newArrivals.titleAr || 'أحدث المنتجات';
        const bestSellersTitle = layout.bestSellers.title || 'Best Sellers';
        const bestSellersTitleAr = layout.bestSellers.titleAr || 'الأكثر مبيعاً';
        const testimonialsTitle = layout.testimonials.title || 'Customer Reviews';
        const testimonialsTitleAr = layout.testimonials.titleAr || 'آراء العملاء';

        // ── Per-section JSX nodes ─────────────────────────────────────────

        // Hero — toggleable + mode-aware. bgColor overrides the theme bg when set.
        // Spacing: the hero manages its own aspect-driven height, so Top / Bottom spacing is an
        // OUTER margin on this wrapper (Ruling SP-3), never padding; unset adds nothing.
        const heroVisClass =
          [sectionVisibilityClass(layout.hero), sectionMarginClasses(layout.hero)]
            .filter(Boolean)
            .join(' ') || undefined;
        const heroJSX = (
          <div
            data-section="hero"
            style={sectionBgStyle(layout.hero.bgColor, store.theme)}
            className={heroVisClass}
          >
            {editorMode &&
              layout.hero.enabled &&
              heroSlides.length > 0 &&
              heroSlidesWithImage(heroSlides).length === 0 && (
                <EmptyHeroSlideHint blockId={heroBlockIds[0]} />
              )}
            {collageEligible && (
              <HeroCollage
                slides={heroSlidesWithImage(heroSlides)}
                isRtl={isRtl}
                urlPrefix={storeUrl('')}
                headingZone={heroHeadingZone}
              />
            )}
            {layout.hero.enabled && sliderEligible && T.HeroSlider && (
              <T.HeroSlider
                // `image` is optional on HeroSlide only so a DRAFT can hold a
                // just-added slide with no image yet; `validatePublishReadiness`
                // refuses to publish one without it, so every slide reaching a
                // live render is guaranteed to have one — filter is defense in
                // depth against a document from before that gate existed.
                slides={heroSlidesWithImage(heroSlides)}
                autoplayMs={layout.hero.autoplayMs}
                isRtl={isRtl}
                pack={templateId}
                presentation={bannerPresentation}
                frameLine={heroFrameLine}
                textAnchor={layout.hero.textAnchor}
                headingZone={heroHeadingZone}
                urlPrefix={storeUrl('')}
              />
            )}
            {layout.hero.enabled &&
              bannerEligible &&
              T.HeroBanner &&
              heroSlidesWithImage(heroSlides)[0] && (
                <T.HeroBanner
                  {...heroSlidesWithImage(heroSlides)[0]}
                  isRtl={isRtl}
                  pack={templateId}
                  presentation={bannerPresentation}
                  frameLine={heroFrameLine}
                  textAnchor={layout.hero.textAnchor}
                  headingZone={heroHeadingZone}
                  urlPrefix={storeUrl('')}
                />
              )}
            {layout.hero.enabled &&
              !collageEligible &&
              !sliderEligible &&
              !bannerEligible &&
              legacyHeroHasContent &&
              (!heroImage && getLook(store.look) ? (
                // A look store with no hero photo gets a compact title band, never an empty block.
                <CompactHeroBand
                  title={(isRtl ? heroTitleArVal : heroTitleEn) || heroTitleEn || heroTitleArVal}
                  subtitle={isRtl ? heroSubtitleArVal || heroSubtitleEn : heroSubtitleEn}
                  ctaText={isRtl ? heroCtaArVal : heroCtaEn}
                  ctaLink={heroCtaLink}
                  bg={
                    layout.hero.bgColor === INVERSE_SURFACE
                      ? undefined
                      : resolveColor(layout.hero.bgColor, store.theme)
                  }
                />
              ) : (
                <T.Hero
                  title={heroTitleEn}
                  titleAr={heroTitleArVal}
                  subtitle={heroSubtitleEn}
                  subtitleAr={heroSubtitleArVal}
                  image={heroImage}
                  ctaText={heroCtaEn}
                  ctaTextAr={heroCtaArVal}
                  ctaLink={heroCtaLink}
                  isRtl={isRtl}
                  urlPrefix={storeUrl('')}
                />
              ))}
          </div>
        );

        // Categories — grid or horizontal strip. Top padding kept
        // small (pt-6/pt-8) so the section sits right under the
        // hero with no awkward white gap — Ahmad 2026-05-16
        // 'close the white gap between it and the hero banner'.
        // Bottom padding stays generous so the rhythm into "New
        // Arrivals" below feels balanced.
        // Sprint 1 (2026-05-17): bg-[hsl(var(--bg-page))] = first
        // of the alternating section-background pair. When the
        // merchant's backgroundPreset is `none`, both tokens
        // resolve to the same color and the rhythm comes from
        // padding alone; when a preset is picked, adjacent
        // sections alternate visibly.
        const categoriesJSX = (
          <>
            {/* Per-section `above` divider (opt-in) — renders before categories. */}
            {dividerOk(categoriesVisible) && layout.categories.dividers?.above?.enabled && (
              <SectionDivider
                settings={resolveSlotDividerSettings(layout.categories.dividers, 'above')}
                hideForExplicitBg={!!(layout.hero.bgColor || layout.categories.bgColor)}
              />
            )}
            {categoriesVisible && (
              <section
                data-section="categories"
                className={`bg-[hsl(var(--bg-page))] ${sectionSpacingClasses(layout.categories, store.look).wrapperClass}`}
                style={sectionBgStyle(layout.categories.bgColor, store.theme)}
              >
                {tagSource ? (
                  <div
                    className={
                      sectionSpacingClasses(layout.categories, store.look).innerContainerClass
                    }
                  >
                    <SectionHeader
                      title={
                        isRtl
                          ? layout.categories.titleAr || layout.categories.title
                          : layout.categories.title || layout.categories.titleAr
                      }
                    />
                    <TagChips
                      tags={tags}
                      urlPrefix={storeUrl('')}
                      isRtl={isRtl}
                      label={
                        (isRtl
                          ? layout.categories.titleAr || layout.categories.title
                          : layout.categories.title || layout.categories.titleAr) || undefined
                      }
                    />
                  </div>
                ) : (
                  (() => {
                    // Desktop + mobile layout are INDEPENDENT (Ahmad 2026-06-04):
                    // `layout` is the desktop choice, `layoutMobile` the mobile one
                    // (falls back to desktop when unset). When both resolve to the
                    // same kind we render ONE component (zero change for existing
                    // stores); when they differ we render both and toggle with
                    // md: visibility so e.g. mobile=grid + desktop=horizontal works.
                    // md (768px) is the platform mobile/desktop boundary.
                    const categoriesInnerClass = sectionSpacingClasses(
                      layout.categories,
                      store.look
                    ).innerContainerClass;
                    const common = {
                      categories: templateCategories,
                      title: categoriesTitle,
                      titleAr: categoriesTitleAr,
                      kicker: layout.categories.kicker,
                      kickerAr: layout.categories.kickerAr,
                      subtitle: layout.categories.subtitle,
                      subtitleAr: layout.categories.subtitleAr,
                      showKickerLines: layout.categories.showKickerLines,
                      showSubtitleLines: layout.categories.showSubtitleLines,
                      dividers: layout.categories.dividers,
                      seeAllHref: storeUrl('/products'),
                      urlPrefix: storeUrl(''),
                      isRtl,
                      cardSize: layout.categories.cardSize,
                      cardAspect: layout.categories.cardAspect,
                      cardShape: layout.categories.cardShape,
                      cardGap: layout.categories.cardGap,
                      showLabel: layout.categories.showLabel,
                      showHover: layout.categories.showHover,
                      showCardFrame: layout.categories.showCardFrame,
                      cardFrameStyle: layout.categories.cardFrameStyle,
                      cardFrameWidth: layout.categories.cardFrameWidth,
                      cardFrameSize: layout.categories.cardFrameSize,
                      cardFrameColor: layout.categories.cardFrameColor,
                      headingZone: categoriesHeadingZone,
                      kickerZone: categoriesKickerZone,
                      subtitleZone: categoriesSubtitleZone,
                      seeAllZone: categoriesSeeAllZone,
                      categoryLabelZone: categoriesLabelZone,
                      sectionBgColor: layout.categories.bgColor,
                    };
                    type Caption = typeof layout.categories.captionPosition;
                    const renderGrid = (caption: Caption, vis?: string) => (
                      <div className={`${categoriesInnerClass} ${vis ?? ''}`.trim()}>
                        <T.CategoryGrid
                          {...common}
                          captionPosition={caption}
                          mobileColumns={layout.categories.mobileColumns}
                          desktopColumns={layout.categories.desktopColumns}
                        />
                      </div>
                    );
                    const renderStrip = (caption: Caption, vis?: string) =>
                      T.CategoryStrip ? (
                        <div className={vis}>
                          <T.CategoryStrip
                            {...common}
                            captionPosition={caption}
                            pack={templateId}
                          />
                        </div>
                      ) : (
                        renderGrid(caption, vis)
                      );
                    const kindFor = (lay: typeof layout.categories.layout) =>
                      lay === 'chips' || lay === 'rail' || lay === 'tiles'
                        ? lay
                        : lay === 'horizontal' && T.CategoryStrip
                          ? 'strip'
                          : 'grid';
                    const desktopKind = kindFor(layout.categories.layout);
                    const mobileKind = kindFor(
                      layout.categories.layoutMobile ?? layout.categories.layout
                    );
                    const desktopCaption = layout.categories.captionPosition;
                    const mobileCaption =
                      layout.categories.captionPositionMobile ?? layout.categories.captionPosition;
                    const renderKind = (
                      kind: 'strip' | 'grid' | 'chips' | 'rail' | 'tiles',
                      caption: Caption,
                      vis?: string
                    ) =>
                      kind === 'rail' ? (
                        <div className={vis}>
                          <CategoryRail {...common} captionPosition={caption} pack={templateId} />
                        </div>
                      ) : kind === 'tiles' ? (
                        <div className={vis}>
                          <CategoryTiles
                            {...common}
                            captionPosition={caption}
                            pack={templateId}
                            mobileColumns={layout.categories.mobileColumns}
                            desktopColumns={layout.categories.desktopColumns}
                            tint={layout.categories.tint}
                            aisles={getLook(store.look)?.chrome?.aisles}
                          />
                        </div>
                      ) : kind === 'chips' ? (
                        <div className={vis}>
                          <CategoryChips
                            categories={common.categories}
                            urlPrefix={common.urlPrefix}
                            isRtl={isRtl}
                          />
                        </div>
                      ) : kind === 'strip' ? (
                        renderStrip(caption, vis)
                      ) : (
                        renderGrid(caption, vis)
                      );
                    // Render once when desktop + mobile resolve to the SAME layout AND
                    // caption; otherwise render both trees + toggle with md: so each
                    // breakpoint gets its own layout + caption independently.
                    if (desktopKind === mobileKind && desktopCaption === mobileCaption)
                      return renderKind(desktopKind, desktopCaption);
                    return (
                      <>
                        {renderKind(mobileKind, mobileCaption, 'md:hidden')}
                        {renderKind(desktopKind, desktopCaption, 'hidden md:block')}
                      </>
                    );
                  })()
                )}
              </section>
            )}
            {emptyHint('categories', layout.categories.enabled, categoriesVisible)}
          </>
        );

        // New Arrivals — pack ProductCarousel or ProductGrid fallback.
        // Divider between categories and new-arrivals. Suppressed when
        // either flanking section has an explicit per-section bgColor —
        // the color shift already acts as the visual separator. Per-section
        // `newArrivals.dividers.above` wins over the legacy theme.dividers
        // fallback when set.
        // Sprint 1: bg-[hsl(var(--bg-section-alt))] alternates with
        // the categories section above.
        const newArrivalsJSX = (
          <SectionErrorBoundary section="newArrivals">
            {dividerOk(newArrivalsVisible) && (
              <SectionDivider
                settings={resolveSlotDividerSettings(layout.newArrivals.dividers, 'above')}
                hideForExplicitBg={!!(layout.categories.bgColor || layout.newArrivals.bgColor)}
              />
            )}
            {newArrivalsVisible && (
              <section
                data-section="newArrivals"
                className={`bg-[hsl(var(--bg-section-alt))] ${sectionSpacingClasses(layout.newArrivals, store.look).wrapperClass}`}
                style={sectionBgStyle(layout.newArrivals.bgColor, store.theme)}
              >
                {T.ProductCarousel ? (
                  <T.ProductCarousel
                    urlPrefix={storeUrl('')}
                    products={templateNewArrivals}
                    title={newArrivalsTitle}
                    titleAr={newArrivalsTitleAr}
                    kicker={layout.newArrivals.kicker}
                    kickerAr={layout.newArrivals.kickerAr}
                    subtitle={layout.newArrivals.subtitle}
                    subtitleAr={layout.newArrivals.subtitleAr}
                    showKickerLines={layout.newArrivals.showKickerLines}
                    showSubtitleLines={layout.newArrivals.showSubtitleLines}
                    dividers={layout.newArrivals.dividers}
                    seeAllHref={storeUrl('/products?sort=newest')}
                    isRtl={isRtl}
                    currency={store.currency}
                    onAddToCart={handleAddToCart}
                    pack={templateId}
                    cardSize={layout.newArrivals.cardSize}
                    cardAspect={layout.newArrivals.cardAspect}
                    cardShape={layout.newArrivals.cardShape}
                    cardGap={layout.newArrivals.cardGap}
                    showLabel={layout.newArrivals.showLabel}
                    showHover={layout.newArrivals.showHover}
                    showCardFrame={layout.newArrivals.showCardFrame}
                    cardFrameStyle={layout.newArrivals.cardFrameStyle}
                    cardFrameWidth={
                      layout.newArrivals.cardFrameWidth ||
                      layout.productCardDefaults?.cardFrameWidth
                    }
                    cardFrameSize={
                      layout.newArrivals.cardFrameSize || layout.productCardDefaults?.cardFrameSize
                    }
                    cardFrameColor={
                      layout.newArrivals.cardFrameColor ||
                      layout.productCardDefaults?.cardFrameColor
                    }
                    cardImageAspect={layout.productCardDefaults?.cardImageAspect}
                    cardImageRadius={layout.productCardDefaults?.cardImageRadius}
                    showCardName={layout.productCardDefaults?.showCardName}
                    showCardPrice={showCardPriceEff}
                    headingZone={newArrivalsHeadingZone}
                    kickerZone={newArrivalsKickerZone}
                    subtitleZone={newArrivalsSubtitleZone}
                    seeAllZone={newArrivalsSeeAllZone}
                    productNameZone={newArrivalsProductNameZone}
                    productPriceZone={newArrivalsProductPriceZone}
                    productCtaZone={newArrivalsProductCtaZone}
                    sectionBgColor={layout.newArrivals.bgColor}
                  />
                ) : (
                  <div
                    className={
                      sectionSpacingClasses(layout.newArrivals, store.look).innerContainerClass
                    }
                  >
                    <T.ProductGrid
                      urlPrefix={storeUrl('')}
                      products={templateNewArrivals}
                      title={newArrivalsTitle}
                      titleAr={newArrivalsTitleAr}
                      isRtl={isRtl}
                      currency={store.currency}
                      columns={4}
                      onAddToCart={handleAddToCart}
                    />
                  </div>
                )}
              </section>
            )}
            {emptyHint('newArrivals', layout.newArrivals.enabled, newArrivalsVisible)}
          </SectionErrorBoundary>
        );

        // Best Sellers carousel.
        // Divider between new-arrivals and best-sellers. Per-section
        // `bestSellers.dividers.above` wins over the legacy theme.dividers
        // fallback when set.
        // Sprint 1: was `bg-muted/30` (a hardcoded muted tone);
        // now `bg-[hsl(var(--bg-page))]` so it alternates with
        // the section above. The previous muted-grey is preserved
        // when the merchant picks the `coolGrey` preset and is
        // the new default visual under `none`.
        const bestSellersJSX = (
          <SectionErrorBoundary section="bestSellers">
            {dividerOk(bestSellersVisible) && (
              <SectionDivider
                settings={resolveSlotDividerSettings(layout.bestSellers.dividers, 'above')}
                hideForExplicitBg={!!(layout.newArrivals.bgColor || layout.bestSellers.bgColor)}
              />
            )}
            {bestSellersVisible && (
              <section
                data-section="bestSellers"
                className={`bg-[hsl(var(--bg-page))] ${sectionSpacingClasses(layout.bestSellers, store.look).wrapperClass}`}
                style={sectionBgStyle(layout.bestSellers.bgColor, store.theme)}
              >
                {T.ProductCarousel ? (
                  <T.ProductCarousel
                    urlPrefix={storeUrl('')}
                    products={templateBestSellers}
                    title={bestSellersTitle}
                    titleAr={bestSellersTitleAr}
                    kicker={layout.bestSellers.kicker}
                    kickerAr={layout.bestSellers.kickerAr}
                    subtitle={layout.bestSellers.subtitle}
                    subtitleAr={layout.bestSellers.subtitleAr}
                    showKickerLines={layout.bestSellers.showKickerLines}
                    showSubtitleLines={layout.bestSellers.showSubtitleLines}
                    dividers={layout.bestSellers.dividers}
                    seeAllHref={storeUrl('/products?sort=best_seller')}
                    isRtl={isRtl}
                    currency={store.currency}
                    onAddToCart={handleAddToCart}
                    pack={templateId}
                    cardSize={layout.bestSellers.cardSize}
                    cardAspect={layout.bestSellers.cardAspect}
                    cardShape={layout.bestSellers.cardShape}
                    cardGap={layout.bestSellers.cardGap}
                    showLabel={layout.bestSellers.showLabel}
                    showHover={layout.bestSellers.showHover}
                    showCardFrame={layout.bestSellers.showCardFrame}
                    cardFrameStyle={layout.bestSellers.cardFrameStyle}
                    cardFrameWidth={
                      layout.bestSellers.cardFrameWidth ||
                      layout.productCardDefaults?.cardFrameWidth
                    }
                    cardFrameSize={
                      layout.bestSellers.cardFrameSize || layout.productCardDefaults?.cardFrameSize
                    }
                    cardFrameColor={
                      layout.bestSellers.cardFrameColor ||
                      layout.productCardDefaults?.cardFrameColor
                    }
                    cardImageAspect={layout.productCardDefaults?.cardImageAspect}
                    cardImageRadius={layout.productCardDefaults?.cardImageRadius}
                    showCardName={layout.productCardDefaults?.showCardName}
                    showCardPrice={showCardPriceEff}
                    headingZone={bestSellersHeadingZone}
                    kickerZone={bestSellersKickerZone}
                    subtitleZone={bestSellersSubtitleZone}
                    seeAllZone={bestSellersSeeAllZone}
                    productNameZone={bestSellersProductNameZone}
                    productPriceZone={bestSellersProductPriceZone}
                    productCtaZone={bestSellersProductCtaZone}
                    sectionBgColor={layout.bestSellers.bgColor}
                  />
                ) : (
                  <div
                    className={
                      sectionSpacingClasses(layout.bestSellers, store.look).innerContainerClass
                    }
                  >
                    <T.ProductGrid
                      urlPrefix={storeUrl('')}
                      products={templateBestSellers}
                      title={bestSellersTitle}
                      titleAr={bestSellersTitleAr}
                      isRtl={isRtl}
                      currency={store.currency}
                      columns={4}
                      onAddToCart={handleAddToCart}
                    />
                  </div>
                )}
              </section>
            )}
            {emptyHint('bestSellers', layout.bestSellers.enabled, bestSellersVisible)}
          </SectionErrorBoundary>
        );

        // Sprint 3 + Bucket E (2026-05-17): brand story band.
        // Brand story uses store.heroImage + store.description
        // as platform defaults — null-safe via internal guard.
        // Brand Story — folded into page-builder 2026-05-20.
        // Legacy fallback: `theme.showBrandStory`.
        const brandStoryJSX = (
          <SectionErrorBoundary section="brandStory">
            {brandStoryVisible || (brandStoryEnabled && editorMode) ? (
              <>
                {dividerOk(brandStoryVisible) && (
                  <SectionDivider
                    settings={resolveSlotDividerSettings(layout.brandStory?.dividers, 'above')}
                    hideForExplicitBg={!!(layout.bestSellers.bgColor || layout.brandStory?.bgColor)}
                  />
                )}
                {emptyHint('brandStory', brandStoryEnabled, brandStoryVisible)}
                <BrandStoryBlock
                  image={store.heroImage ?? undefined}
                  body={store.description ?? undefined}
                  bodyAr={store.descriptionAr ?? undefined}
                  spacingSettings={layout.brandStory}
                />
              </>
            ) : null}
          </SectionErrorBoundary>
        );

        // Blog Carousel — folded into page-builder 2026-05-20.
        // Legacy fallback: `store.blogEnabled`.
        const blogCarouselJSX = (
          <SectionErrorBoundary section="blogCarousel">
            {(layout.blogCarousel?.enabled ?? store.blogEnabled !== false) ? (
              <>
                {/* The divider and the editor hint ride inside HomeBlogCarousel:
                    whether there are posts is only known after its client fetch. */}
                <HomeBlogCarousel
                  spacingSettings={layout.blogCarousel}
                  before={
                    <SectionDivider
                      settings={resolveSlotDividerSettings(layout.blogCarousel?.dividers, 'above')}
                      // Suppress when EITHER flanking section is colored. The
                      // preceding section (default order) is brandStory or
                      // bestSellers — checking only blogCarousel's own bgColor let a
                      // white divider band show over the white page bg between two
                      // brown sections (demo-store). Mirrors the bestSellers/brandStory
                      // dividers which already check both sides.
                      hideForExplicitBg={
                        !!(
                          layout.bestSellers.bgColor ||
                          layout.brandStory?.bgColor ||
                          layout.blogCarousel?.bgColor
                        )
                      }
                    />
                  }
                  emptyFallback={editorMode ? <EmptySectionHint kind="blogCarousel" /> : undefined}
                />
              </>
            ) : null}
          </SectionErrorBoundary>
        );

        // Trust Strip — folded into page-builder 2026-05-20.
        // Merchant-written items (`trustStrip.items`). A store saved before
        // items existed has no `items` key and keeps the 3 fixed legacy items
        // (Fast Delivery / Quality / Support); new stores are provisioned with
        // `items: []` and show nothing until the merchant adds some.
        // Auto-hides when disabled or empty. Legacy fallback: `theme.showTrustStrip`.
        const trustStripJSX = (
          <SectionErrorBoundary section="trustStrip">
            {trustStripVisible ? (
              <>
                <SectionDivider
                  settings={resolveSlotDividerSettings(layout.trustStrip?.dividers, 'above')}
                  // Suppress when EITHER flanking section is colored. The trust
                  // strip's preceding section (default order) is blogCarousel /
                  // brandStory / bestSellers — checking only the trust strip's own
                  // bgColor left a white divider band between the brown
                  // best-sellers and the trust strip (demo-store, 2026-06-20).
                  hideForExplicitBg={
                    !!(
                      layout.bestSellers.bgColor ||
                      layout.brandStory?.bgColor ||
                      layout.blogCarousel?.bgColor ||
                      layout.trustStrip?.bgColor
                    )
                  }
                />
                <TrustStrip settings={layout.trustStrip} />
              </>
            ) : (
              emptyHint('trustStrip', trustStripEnabled, false)
            )}
          </SectionErrorBoundary>
        );

        // Testimonials — auto-hides when no qualifying reviews.
        // Sprint 1: bg-[hsl(var(--bg-section-alt))] alternates
        // with Best Sellers above. Divider before testimonials.
        // Suppressed when testimonials section has an explicit
        // per-section bgColor. Per-section `testimonials.dividers.above`
        // wins over the legacy fallback.
        const testimonialsJSX = (
          <SectionErrorBoundary section="testimonials">
            {dividerOk(testimonialsVisible) && (
              <SectionDivider
                settings={resolveSlotDividerSettings(layout.testimonials.dividers, 'above')}
                hideForExplicitBg={
                  !!(
                    layout.bestSellers.bgColor ||
                    layout.brandStory?.bgColor ||
                    layout.blogCarousel?.bgColor ||
                    layout.trustStrip?.bgColor ||
                    layout.testimonials.bgColor
                  )
                }
              />
            )}
            {testimonialsVisible && T.TestimonialRow && (
              <section
                data-section="testimonials"
                className={`bg-[hsl(var(--bg-section-alt))] ${sectionSpacingClasses(layout.testimonials, store.look).wrapperClass}`}
                style={sectionBgStyle(layout.testimonials.bgColor, store.theme)}
              >
                <T.TestimonialRow
                  testimonials={testimonials}
                  title={testimonialsTitle}
                  titleAr={testimonialsTitleAr}
                  isRtl={isRtl}
                  pack={templateId}
                  headingZone={testimonialsHeadingZone}
                  kickerZone={testimonialsKickerZone}
                  subtitleZone={testimonialsSubtitleZone}
                  dividers={layout.testimonials.dividers}
                  sectionBgColor={layout.testimonials.bgColor}
                  layout={layout.testimonials.layout}
                />
              </section>
            )}
            {emptyHint('testimonials', layout.testimonials.enabled, testimonialsVisible)}
          </SectionErrorBoundary>
        );

        // ── Section map + ordered render ──────────────────────────────────
        const sectionMap: Record<string, React.ReactNode> = {
          hero: heroJSX,
          categories: categoriesJSX,
          newArrivals: newArrivalsJSX,
          bestSellers: bestSellersJSX,
          brandStory: brandStoryJSX,
          blogCarousel: blogCarouselJSX,
          trustStrip: trustStripJSX,
          testimonials: testimonialsJSX,
        };

        // Extra duplicated carousels (section duplication 2026-05-20). Each
        // entry is a ProductCarousel with its own product source. v1 renders
        // them in array order AFTER the static section loop; v2 will integrate
        // with sectionOrder via 'extra:<id>' keys.
        const extras = layout.extraCarousels ?? [];
        // Union of all server-fetched RAW products (not template adapters) so
        // 'category' filter can read raw.categories[].slug. Includes
        // extraProducts which were fetched specifically for layout.extracarousels
        // entries that use 'category' or 'manual' productSource — without this
        // merge the storefront would only see products already in newArrivals/
        // bestSellers/featured and miss any merchant-configured category that
        // doesn't overlap with those lists.
        const allRawProducts = (() => {
          const map = new Map<string, Product>();
          for (const p of [
            ...newArrivals,
            ...bestSellers,
            ...featuredProducts,
            ...(extraProducts ?? []),
          ]) {
            map.set(p.id, p);
          }
          return Array.from(map.values());
        })();
        const extraJSX = extras.map((extra, extraIdx) => {
          if (extra.enabled === false) return null;
          // "Order again" (Ruling B4-8): per customer, resolved in the browser; renders nothing
          // for an anonymous or first-time shopper, so it cannot leave an empty padded band.
          if (extra.productSource === 'reorder')
            return (
              <SectionErrorBoundary key={`extra:${extra.id}`} section={`extra:${extra.id}`}>
                <ReorderRow
                  title={extra.title}
                  titleAr={extra.titleAr}
                  limit={extra.limit}
                  pack={templateId}
                  onAddToCart={handleAddToCart}
                  sectionProps={{
                    className: `bg-[hsl(var(--bg-page))] ${sectionSpacingClasses(extra, store.look).wrapperClass}`,
                    style: sectionBgStyle(extra.bgColor, store.theme),
                  }}
                />
              </SectionErrorBoundary>
            );
          let sourceProducts: typeof templateNewArrivals;
          if (extra.productSource === 'best_seller') {
            sourceProducts = templateBestSellers;
          } else if (extra.productSource === 'featured') {
            sourceProducts = templateProducts;
          } else if (extra.productSource === 'on_sale') {
            // Deals row: biggest drop first; an empty match renders nothing (below), never a
            // fallback to unrelated products.
            sourceProducts = (onSalePool ?? onSaleProducts(allRawProducts)).map(toTemplateProduct);
          } else if (extra.productSource === 'category' && extra.categorySlug) {
            const slug = extra.categorySlug.toLowerCase();
            const matched = allRawProducts.filter(p =>
              (p.categories ?? []).some(c => (c?.category?.slug ?? '').toLowerCase() === slug)
            );
            sourceProducts = matched.map(toTemplateProduct);
            // Empty match → fall back to newest so the carousel never renders
            // as a confusing 0-product block once a merchant configures it.
            if (sourceProducts.length === 0) sourceProducts = templateNewArrivals;
          } else if (extra.productSource === 'manual' && extra.manualProductIds?.length) {
            const productMap = new Map(allRawProducts.map(p => [p.id, p]));
            const matched = extra.manualProductIds
              .map(id => productMap.get(id))
              .filter((p): p is Product => !!p);
            sourceProducts = matched.map(toTemplateProduct);
            if (sourceProducts.length === 0) sourceProducts = templateNewArrivals;
          } else {
            sourceProducts = templateNewArrivals;
          }
          const capped = sourceProducts.slice(0, extra.limit ?? 12);
          if (capped.length === 0) return null;
          if (!T.ProductCarousel) return null;
          return (
            <SectionErrorBoundary key={`extra:${extra.id}`} section={`extra:${extra.id}`}>
              {extra.dividers?.above?.enabled && (
                <SectionDivider
                  settings={resolveSlotDividerSettings(extra.dividers, 'above')}
                  // Suppress when the preceding rendered section is colored:
                  // the previous extra carousel (extra-after-extra) or, for the
                  // first extra, the tail named sections (testimonials/trust
                  // strip). Plus the extra's own bgColor. Same one-sided→both-
                  // sided fix as the named-section dividers above.
                  hideForExplicitBg={
                    !!(
                      (extraIdx > 0
                        ? extras[extraIdx - 1]?.bgColor
                        : layout.testimonials.bgColor || layout.trustStrip?.bgColor) ||
                      extra.bgColor
                    )
                  }
                />
              )}
              <section
                data-section={`extra:${extra.id}`}
                className={`bg-[hsl(var(--bg-page))] ${sectionSpacingClasses(extra, store.look).wrapperClass}`}
                style={sectionBgStyle(extra.bgColor, store.theme)}
              >
                <T.ProductCarousel
                  urlPrefix={storeUrl('')}
                  products={capped}
                  title={extra.title}
                  titleAr={extra.titleAr}
                  kicker={extra.kicker}
                  kickerAr={extra.kickerAr}
                  subtitle={extra.subtitle}
                  subtitleAr={extra.subtitleAr}
                  showKickerLines={extra.showKickerLines}
                  showSubtitleLines={extra.showSubtitleLines}
                  dividers={extra.dividers}
                  isRtl={isRtl}
                  currency={store.currency}
                  onAddToCart={handleAddToCart}
                  pack={templateId}
                  cardSize={extra.cardSize}
                  cardAspect={extra.cardAspect}
                  cardShape={extra.cardShape}
                  cardGap={extra.cardGap}
                  showLabel={extra.showLabel}
                  showHover={extra.showHover}
                  showCardFrame={extra.showCardFrame}
                  cardFrameStyle={extra.cardFrameStyle}
                  cardFrameWidth={extra.cardFrameWidth}
                  cardFrameSize={extra.cardFrameSize}
                  cardFrameColor={extra.cardFrameColor}
                  cardImageAspect={layout.productCardDefaults?.cardImageAspect}
                  cardImageRadius={layout.productCardDefaults?.cardImageRadius}
                  showCardName={layout.productCardDefaults?.showCardName}
                  showCardPrice={showCardPriceEff}
                  sectionBgColor={extra.bgColor}
                />
              </section>
            </SectionErrorBoundary>
          );
        });

        // ── Ordered render from the document ──────────────────────────────
        // Body sections in document order. A fixed section (cardinality one)
        // renders once, at its first position; product carousels map onto
        // `layout.extraCarousels` in the same order `definitionToLayout`
        // projected them.
        const rendered = new Set<string>();
        let extraIdx = 0;
        const body: React.ReactNode[] = [];
        const mark = (id: string, node: React.ReactNode) =>
          editorMode ? (
            <div key={`builder:${id}`} data-builder-id={id} style={{ display: 'contents' }}>
              {node}
            </div>
          ) : (
            node
          );
        let stagesSeen = 0;
        for (const section of renderableSections(definition).sections) {
          const def = getSectionDefinition(section.type);
          if (!def || def.group !== 'template') continue;
          if (def.legacyKey === null) {
            // Document-only sections render straight from the document.
            if (section.hidden === true) continue;
            const settings = sectionToLegacy(section, '') as Record<string, unknown>;
            const stagePriority =
              def.type === 'product-spotlight' &&
              (settings as ProductSpotlightSettings).layout === 'stage' &&
              stagesSeen++ === 0;
            if (!DOCUMENT_SECTION_TYPES.has(def.type)) continue;
            const node = (
              <DocumentSectionBody
                section={section}
                newArrivals={newArrivals}
                bestSellers={bestSellers}
                featured={featuredProducts}
                extra={extraProducts ?? NO_PRODUCTS}
                onSale={onSalePool}
                categories={categories}
                templateId={templateId}
                editorMode={editorMode}
                showPrice={showCardPriceEff !== false}
                layout={stableLayout}
                stagePriority={stagePriority}
                onAddToCart={stableAddToCart}
              />
            );
            body.push(
              <SectionErrorBoundary key={section.id} section={section.id}>
                {mark(section.id, node)}
              </SectionErrorBoundary>
            );
            continue;
          }
          if (def.legacyKey === 'extraCarousels') {
            body.push(mark(section.id, extraJSX[extraIdx++]));
            continue;
          }
          if (rendered.has(def.legacyKey)) continue;
          rendered.add(def.legacyKey);
          body.push(
            editorMode ? (
              mark(section.id, sectionMap[def.legacyKey])
            ) : (
              <React.Fragment key={def.legacyKey}>{sectionMap[def.legacyKey]}</React.Fragment>
            )
          );
        }
        return <>{body}</>;
      })()}

      {/* Featured products fallback when both carousels are disabled OR empty.
          Sprint 1: was `bg-muted/30`; now uses the section-alt token. */}
      {!layout.newArrivals.enabled &&
        !layout.bestSellers.enabled &&
        !documentShowsProducts &&
        templateProducts.length > 0 && (
          <section className="bg-[hsl(var(--bg-section-alt))] py-12 sm:py-16 lg:py-20">
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <T.ProductGrid
                urlPrefix={storeUrl('')}
                products={templateProducts}
                title="Featured Products"
                titleAr="منتجات مميزة"
                isRtl={isRtl}
                currency={store.currency}
                columns={4}
                onAddToCart={handleAddToCart}
              />
            </div>
          </section>
        )}

      {/* "Ready to Start Shopping? / Join thousands of satisfied customers"
          banner removed — was hardcoded marketing copy that competed with
          merchant content. Stores that want a closing CTA can use the
          AnnouncementBar or surface it through their hero / categories. */}
    </>
  );
  // a11y P2-2: a look home with no hero opens with an h1, the store's name. The wrapper exists only
  // then, so every other tree (legacy stores, pinned fixtures) keeps its exact shape and ids.
  return !editorMode && !homeHasHero && getLook(store.look) ? (
    <>
      <h1 className="sr-only">{(isRtl ? store.nameAr || store.name : store.name) || ''}</h1>
      {body}
    </>
  ) : editorMode ? (
    <EditorModeProvider value>{body}</EditorModeProvider>
  ) : (
    body
  );
}
