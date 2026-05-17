import type { ReactNode } from 'react';

/**
 * Product data for template components
 */
export interface TemplateProduct {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  price: number;
  compareAtPrice?: number;
  images: Array<{ id: string; url: string; alt?: string }>;
  rating?: number;
  reviewCount?: number;
  isNew?: boolean;
  isFeatured?: boolean;
  inStock?: boolean;
  /**
   * Variant pricing snapshot — propagated from the API so listing
   * cards can render `From <min>` instead of the parent's stale
   * standalone price. Each entry is just enough to compute min/max +
   * detect a per-variant discount; the full ProductVariant shape
   * lives behind the detail page.
   */
  variants?: Array<{ price?: number | null; compareAtPrice?: number | null }>;
}

/**
 * Category data for template components
 */
export interface TemplateCategory {
  id: string;
  name: string;
  nameAr?: string;
  slug: string;
  image?: string;
  productCount?: number;
}

/**
 * Store branding data
 */
export interface StoreBranding {
  name: string;
  nameAr?: string;
  logo?: string;
  logoAr?: string;
  description?: string;
  descriptionAr?: string;
}

/**
 * Store contact info
 */
export interface StoreContact {
  email?: string;
  phone?: string;
  phoneAr?: string;
  whatsapp?: string;
  address?: string;
  addressAr?: string;
  /**
   * Optional explicit map URL the merchant pastes from Google Maps / Apple
   * Maps / etc. When present (and `addressLink !== false`) the footer wraps
   * the address text in `<a href={addressUrl}>` instead of synthesising a
   * Google Maps search URL from the address string. Saved at
   * `store.settings.contact.addressUrl`.
   */
  addressUrl?: string;
  /**
   * Whether the address should render as a clickable hyperlink. `true`
   * (default when undefined) means the footer renders an `<a>` either to
   * `addressUrl` (when set) or a synthesised Google Maps search URL. `false`
   * keeps the address as plain text. Saved at
   * `store.settings.contact.addressLink`.
   */
  addressLink?: boolean;
}

/**
 * Social links
 */
export interface StoreSocials {
  instagram?: string;
  twitter?: string;
  facebook?: string;
  tiktok?: string;
  youtube?: string;
  snapchat?: string;
  linkedin?: string;
  whatsapp?: string;
  telegram?: string;
  pinterest?: string;
}

/**
 * Navigation item
 */
export interface NavItem {
  label: string;
  labelAr?: string;
  href: string;
  children?: NavItem[];
}

/**
 * Header component props
 */
export interface HeaderProps {
  branding: StoreBranding;
  navigation?: NavItem[];
  isRtl?: boolean;
  cartItemCount?: number;
  isLoggedIn?: boolean;
  onSearch?: (query: string) => void;
  urlPrefix?: string;
  /**
   * Resolved pre-header utility bar config. Only consumed by packs that
   * render a utility bar (Elegant + Classic). When undefined, the pack
   * falls back to its built-in defaults so legacy stores don't lose
   * their bar; when `enabled === false`, the pack hides the bar entirely
   * without adding compensating padding to the main header row below.
   */
  utilityBar?: ResolvedUtilityBar;
}

/**
 * A single link inside a footer column. Saved per-tenant in
 * `store.settings.footerLinks` via the admin's footer-settings page. The
 * `enabled` flag lets owners toggle items off without deleting them; absent
 * or `true` means the link renders.
 */
export interface FooterLinkSection {
  name: string;
  nameAr?: string;
  href: string;
  enabled?: boolean;
}

/**
 * Per-store bottom-bar configuration. Saved at
 * `store.settings.footerLinks.bottomBar`. Lets owners hide the entire bar,
 * override the copyright string, or toggle individual legal links off
 * without rewriting paths in code.
 */
export interface FooterBottomBarConfig {
  enabled?: boolean;
  copyrightOverride?: string;
  copyrightOverrideAr?: string;
  privacyEnabled?: boolean;
  termsEnabled?: boolean;
  shippingEnabled?: boolean;
}

/**
 * Per-store footer configuration sourced from `store.settings.footerLinks`.
 * Each section is independently optional — the template falls back to its
 * own default column layout when the whole config (or every section) is
 * missing/empty. `newsletterEnabled` defaults to `true` when undefined so
 * stores that haven't touched the setting keep showing the form.
 */
export interface FooterLinksConfig {
  shop?: FooterLinkSection[];
  company?: FooterLinkSection[];
  support?: FooterLinkSection[];
  newsletterEnabled?: boolean;
  bottomBar?: FooterBottomBarConfig;
}

/**
 * A single link inside the pre-header utility bar (Elegant + Classic packs).
 * Saved per-tenant in `store.settings.utilityBar.links` via the admin's
 * pages settings page. The `enabled` flag lets owners toggle items off
 * without deleting them; absent or `true` means the link renders.
 */
export interface UtilityBarLink {
  label: string;
  labelAr?: string;
  href: string;
  enabled?: boolean;
}

/**
 * Per-store pre-header utility bar config saved at
 * `store.settings.utilityBar`. Only the Elegant + Classic packs render a
 * utility bar; the other packs (Modern, Minimal, Bold) ignore this
 * setting because they don't have a top bar to begin with.
 *
 * `enabled` defaults to `true` when undefined so legacy stores that
 * haven't touched the setting keep showing the bar with their pack's
 * built-in defaults. When set to `false` the entire bar is hidden and
 * the main header row sits flush against the announcement bar (or the
 * top of the page) — no compensating padding is added.
 */
export interface UtilityBarConfig {
  enabled?: boolean;
  links?: UtilityBarLink[];
}

/**
 * Resolved utility bar config forwarded from ShopChrome to each pack's
 * Header. Same shape as the raw config but with relative `href` values
 * already rewritten through `storeUrl()` so multi-tenant platform URLs
 * get the correct slug prefix. Each link's `enabled` flag is normalized
 * to a boolean (defaulting to `true`).
 */
export interface ResolvedUtilityBar {
  enabled: boolean;
  links: Array<Required<Pick<UtilityBarLink, 'label' | 'href' | 'enabled'>> & { labelAr?: string }>;
}

/**
 * Footer component props
 */
export interface FooterProps {
  branding: StoreBranding;
  contact: StoreContact;
  socials: StoreSocials;
  navigation?: NavItem[];
  /**
   * Per-store footer columns (shop / company / support) and newsletter
   * toggle. When undefined or every section is empty, the template renders
   * its built-in default layout instead.
   */
  footerLinks?: FooterLinksConfig;
  /**
   * CMS pages the merchant explicitly disabled in `/content/<slug>`
   * (`isPublished=false`). The bottom-bar legal links automatically
   * hide for any slug listed here so the merchant doesn't have to flip
   * both the page-level toggle AND the per-link toggle. Slugs are
   * bare ("privacy", "terms", "shipping").
   */
  disabledCmsSlugs?: string[];
  isRtl?: boolean;
  urlPrefix?: string;
}

/**
 * Hero section props
 */
export interface HeroProps {
  title?: string;
  titleAr?: string;
  subtitle?: string;
  subtitleAr?: string;
  image?: string;
  ctaText?: string;
  ctaTextAr?: string;
  ctaLink?: string;
  isRtl?: boolean;
  urlPrefix?: string;
}

/**
 * Single hero banner — used when layout.hero.mode === 'single'. One image,
 * one optional headline + CTA, no autoplay. Storefronts that don't supply
 * any slides at all fall back to the per-store hero text in T.Hero.
 */
export interface HeroBannerProps {
  image: string;
  imageAr?: string;
  /**
   * Optional mobile-specific image. Recommended 1080×1440 (3:4 aspect)
   * so the hero stays subject-prominent on phones. Falls back to `image`
   * with a center-crop when unset.
   */
  imageMobile?: string;
  imageMobileAr?: string;
  alt?: string;
  headline?: string;
  headlineAr?: string;
  subtitle?: string;
  subtitleAr?: string;
  ctaText?: string;
  ctaTextAr?: string;
  ctaHref?: string;
  isRtl?: boolean;
  /**
   * Active template id, used by shared section components to pick per-pack
   * style tokens (see `templates/shared/pack-styles.ts`). When omitted the
   * components fall back to the Modern style.
   */
  pack?: import('@force/shared').TemplateId;
  /**
   * Pass `priority` to the underlying next/image so the LCP banner preloads.
   * Default true for the standalone single banner; set false from HeroSlider
   * for non-active slides so we don't burn the priority budget on 6 images.
   */
  priority?: boolean;
  /**
   * Presentation mode:
   *   - `'full-bleed'` (default) — section spans 100vw, image fills via
   *     object-cover (may crop if image aspect ≠ container aspect).
   *   - `'framed'` — section sits inside a max-w-7xl container with
   *     horizontal padding + rounded-2xl + neutral bg, image renders with
   *     object-contain (whole image always shows, may letterbox).
   * Merchants pick via Admin → Layout → Hero. Default preserves the
   * existing edge-to-edge look for stores that already shipped that way.
   */
  presentation?: 'full-bleed' | 'framed';
}

/**
 * Autoplay hero slider — used when layout.hero.mode === 'slider'. Pagination
 * dots, no arrows, full-bleed image, optional overlay headline. RTL flips
 * direction automatically via the parent's `dir` attribute.
 */
export interface HeroSliderProps {
  slides: HeroBannerProps[];
  /** Autoplay interval in ms; 0 disables autoplay (manual swipe only). */
  autoplayMs?: number;
  isRtl?: boolean;
  pack?: import('@force/shared').TemplateId;
  /** See HeroBannerProps.presentation — same semantics, applies to every slide. */
  presentation?: 'full-bleed' | 'framed';
}

/**
 * Horizontal-scroll product strip used for "New Arrivals" / "Best Sellers".
 * Square 146px cards on desktop, 6 visible at 1440 / 4 at tablet / 2.5 at
 * mobile (the half hint signals scrollability). Snap-scroll engaged.
 */
export interface ProductCarouselProps {
  products: TemplateProduct[];
  title?: string;
  titleAr?: string;
  /** Small uppercase eyebrow badge above the title. */
  kicker?: string;
  kickerAr?: string;
  /** Tagline rendered below the title. */
  subtitle?: string;
  subtitleAr?: string;
  /** Toggle the flanking editorial hairlines around the kicker. Default true. */
  showKickerLines?: boolean;
  /** Toggle the flanking editorial hairlines around the subtitle. Default true. */
  showSubtitleLines?: boolean;
  /** Optional href for the "See all" link. Hidden when omitted. */
  seeAllHref?: string;
  isRtl?: boolean;
  currency?: string;
  onAddToCart?: (productId: string) => Promise<void> | void;
  urlPrefix?: string;
  pack?: import('@force/shared').TemplateId;
  // Per-store card customisation — 2026-05-16. Mirrors CategoryGridProps so
  // newArrivals + bestSellers admin forms expose the same controls
  // (size + aspect + named shape + spacing + label/hover toggles).
  cardSize?: import('@force/shared').CardSize;
  cardAspect?: import('@force/shared').CardAspect;
  cardShape?: import('@force/shared').CardShape;
  cardGap?: import('@force/shared').CardGap;
  showLabel?: boolean;
  showHover?: boolean;
  /** Wrap each card in a rounded-2xl bg-card border + shadow frame. Default false. */
  showCardFrame?: boolean;
}

/**
 * Horizontal-scroll category strip — alternative to CategoryGrid. Used when
 * layout.categories.layout === 'horizontal'. Same card recipe (1:1 image +
 * caption-below) but laid out with snap-scroll instead of a grid.
 */
export interface CategoryStripProps {
  categories: TemplateCategory[];
  title?: string;
  titleAr?: string;
  kicker?: string;
  kickerAr?: string;
  subtitle?: string;
  subtitleAr?: string;
  /** Toggle flanking hairlines around the kicker. Default true. */
  showKickerLines?: boolean;
  /** Toggle flanking hairlines around the subtitle. Default true. */
  showSubtitleLines?: boolean;
  seeAllHref?: string;
  isRtl?: boolean;
  urlPrefix?: string;
  pack?: import('@force/shared').TemplateId;
  // Per-store card customisation — 2026-05-17. Same controls as the
  // CategoryGrid path so swapping a store from grid → horizontal in
  // admin keeps every visual tuning the merchant already applied.
  cardSize?: import('@force/shared').CardSize;
  cardAspect?: import('@force/shared').CardAspect;
  cardShape?: import('@force/shared').CardShape;
  cardGap?: import('@force/shared').CardGap;
  showLabel?: boolean;
  showHover?: boolean;
  /** Wrap each card in a rounded-2xl bg-card border + shadow frame. Default false. */
  showCardFrame?: boolean;
}

/**
 * 5-star testimonial / review row. Hides itself when no testimonials exist
 * so empty data never leaks an empty section to the storefront.
 */
export interface TestimonialItem {
  id: string;
  rating: number;
  title?: string | null;
  comment: string;
  authorName: string;
  authorCity?: string | null;
  createdAt: string;
}
export interface TestimonialRowProps {
  testimonials: TestimonialItem[];
  title?: string;
  titleAr?: string;
  isRtl?: boolean;
  pack?: import('@force/shared').TemplateId;
}

/**
 * Product card props
 */
export interface ProductCardProps {
  product: TemplateProduct;
  isRtl?: boolean;
  currency?: string;
  /** Current quantity in cart (for showing badge) */
  quantityInCart?: number;
  onAddToCart?: (productId: string) => Promise<void> | void;
  onAddToWishlist?: (productId: string) => void;
  /** True if this product is currently in the compare list. */
  isInCompare?: boolean;
  /**
   * When provided, the template renders a compare-toggle button on the
   * card. Omit to hide. Used by the /products listing and /compare pages.
   */
  onToggleCompare?: (productId: string) => void;
  /**
   * When provided, the template renders a "remove" button on the card (an
   * X icon, replacing the add-to-wishlist heart when present). Used by the
   * /wishlist page so a user can drop an item without opening it.
   */
  onRemoveFromWishlist?: (productId: string) => void;
  urlPrefix?: string;
}

/**
 * Product grid props
 */
export interface ProductGridProps {
  products: TemplateProduct[];
  isRtl?: boolean;
  currency?: string;
  columns?: 2 | 3 | 4;
  /** Section title */
  title?: string;
  titleAr?: string;
  /** Show filter sidebar */
  showFilters?: boolean;
  /** Map of product IDs to cart quantities */
  cartQuantities?: Record<string, number>;
  onAddToCart?: (productId: string) => Promise<void> | void;
  onAddToWishlist?: (productId: string) => void;
  /** Set of product IDs currently in the compare list. Forwarded per-card. */
  compareIds?: Set<string>;
  onToggleCompare?: (productId: string) => void;
  onRemoveFromWishlist?: (productId: string) => void;
  urlPrefix?: string;
}

/**
 * Category card props
 */
export interface CategoryCardProps {
  category: TemplateCategory;
  isRtl?: boolean;
  /** Per-store card size — admin-controlled. */
  cardSize?: import('@force/shared').CardSize;
  /** Per-store card aspect — admin-controlled. */
  cardAspect?: import('@force/shared').CardAspect;
  /** Per-store named shape — when set (not 'theme'), bundles aspect +
   *  rounding so the merchant doesn't tune each axis separately. */
  cardShape?: import('@force/shared').CardShape;
  /** Show label below image. */
  showLabel?: boolean;
  /** Enable hover/zoom effects. */
  showHover?: boolean;
  urlPrefix?: string;
}

/**
 * Category grid props
 */
export interface CategoryGridProps {
  categories: TemplateCategory[];
  isRtl?: boolean;
  /** Section title */
  title?: string;
  titleAr?: string;
  /** Small uppercase eyebrow badge above the title (e.g. "EXPLORE"). */
  kicker?: string;
  kickerAr?: string;
  /** Tagline rendered below the title. */
  subtitle?: string;
  subtitleAr?: string;
  /** Toggle flanking hairlines around the kicker. Default true. */
  showKickerLines?: boolean;
  /** Toggle flanking hairlines around the subtitle. Default true. */
  showSubtitleLines?: boolean;
  /** Per-store card size override. */
  cardSize?: import('@force/shared').CardSize;
  /** Per-store card aspect override. */
  cardAspect?: import('@force/shared').CardAspect;
  /** Per-store named shape override (circle/rounded-square/square/soft/portrait/landscape/pill).
   *  When set, bundles aspect + rounding so merchant doesn't tune each axis. */
  cardShape?: import('@force/shared').CardShape;
  /** Per-store spacing between cards (tight/normal/loose/xloose). Default 'normal'. */
  cardGap?: import('@force/shared').CardGap;
  /** Show label below image (default true). */
  showLabel?: boolean;
  /** Enable hover/zoom (default true). */
  showHover?: boolean;
  /** Wrap each card in a rounded-2xl bg-card border + shadow frame. Default false. */
  showCardFrame?: boolean;
  /** Merchant-picked column counts from admin Layout page. */
  mobileColumns?: 1 | 2 | 3;
  desktopColumns?: 2 | 3 | 4;
  urlPrefix?: string;
}

/**
 * Cart line item as rendered inside a template CartTable.
 */
export interface CartTableItem {
  id: string;
  productId: string;
  name: string;
  nameAr?: string;
  slug: string;
  price: number;
  quantity: number;
  image?: string;
}

/**
 * CartTable is the line-item list the storefront shows on /cart. Each
 * template can present the same cart with its own aesthetic — one pack
 * might favor a clean table grid, another a card-per-row layout. The
 * parent (CartClient) still owns state + handlers; the template is
 * purely presentational.
 */
export interface CartTableProps {
  items: CartTableItem[];
  isRtl?: boolean;
  currency?: string;
  urlPrefix?: string;
  /** Called with the *new* quantity (clamped by the template to >= 1). */
  onUpdateQuantity?: (itemId: string, quantity: number) => void;
  onRemove?: (itemId: string) => void;
}

/**
 * Totals panel rendered beside the cart or checkout. Each template can
 * present the breakdown (subtotal / discount / shipping / tax / total) in
 * its own aesthetic. The parent owns the math; the template is purely
 * presentational + provides a slot for consumer UI (coupon input on cart).
 */
export interface OrderSummaryProps {
  /** All amounts are in the smallest currency unit (fils for KWD). */
  subtotal: number;
  discount?: number;
  discountLabel?: string;
  shipping?: number;
  /** If true, render shipping row as "Free" regardless of the shipping value. */
  freeShipping?: boolean;
  tax?: number;
  total: number;
  currency?: string;
  isRtl?: boolean;
  /** Optional slot below totals — cart uses it for the coupon input. */
  children?: ReactNode;
  /** Primary CTA (e.g. "Proceed to Checkout"). Omit on pages where the CTA lives elsewhere. */
  ctaLabel?: string;
  ctaLabelAr?: string;
  ctaHref?: string;
  onCtaClick?: () => void;
  ctaDisabled?: boolean;
  ctaLoading?: boolean;
}

/**
 * Blank-state shown when a collection is empty (empty cart, wishlist, search
 * no-results, etc.). The template chooses icon, typography, and action-button
 * treatment; the consumer provides the copy and link.
 */
export interface EmptyStateProps {
  title: string;
  titleAr?: string;
  description?: string;
  descriptionAr?: string;
  ctaLabel?: string;
  ctaLabelAr?: string;
  ctaHref?: string;
  onCtaClick?: () => void;
  /** Optional render-prop for a custom icon. Default: each template's own empty icon. */
  icon?: ReactNode;
  isRtl?: boolean;
}

/**
 * Auth/profile form wrapper — replaces the bespoke card wrappers around
 * login/register/reset/verify forms with a template-appropriate shell.
 * Receives a `title` + optional `subtitle` + children (the form itself).
 */
export interface FormCardProps {
  title: string;
  titleAr?: string;
  subtitle?: string;
  subtitleAr?: string;
  /** Form body. */
  children: ReactNode;
  /** Optional footer row (e.g. "Don't have an account? Sign up"). */
  footer?: ReactNode;
  isRtl?: boolean;
}

/**
 * Announcement bar props
 */
export interface AnnouncementBarProps {
  text: string;
  textAr?: string;
  link?: string;
  linkText?: string;
  linkTextAr?: string;
  bgColor?: string;
  textColor?: string;
  dismissible?: boolean;
  isRtl?: boolean;
  onDismiss?: () => void;
}

/**
 * Template component exports
 */
export interface TemplateComponents {
  Header: React.ComponentType<HeaderProps>;
  Footer: React.ComponentType<FooterProps>;
  Hero: React.ComponentType<HeroProps>;
  /** Optional new-style single hero banner. Falls back to Hero when missing. */
  HeroBanner?: React.ComponentType<HeroBannerProps>;
  /** Optional autoplay slider. Falls back to first slide rendered as banner. */
  HeroSlider?: React.ComponentType<HeroSliderProps>;
  ProductCard: React.ComponentType<ProductCardProps>;
  ProductGrid: React.ComponentType<ProductGridProps>;
  /** Horizontal product strip. Falls back to ProductGrid (4-up) when missing. */
  ProductCarousel?: React.ComponentType<ProductCarouselProps>;
  CategoryCard: React.ComponentType<CategoryCardProps>;
  CategoryGrid: React.ComponentType<CategoryGridProps>;
  /** Horizontal category strip. Falls back to CategoryGrid when missing. */
  CategoryStrip?: React.ComponentType<CategoryStripProps>;
  /** 3-up testimonial row. Hidden by orchestrator when no data. */
  TestimonialRow?: React.ComponentType<TestimonialRowProps>;
  AnnouncementBar: React.ComponentType<AnnouncementBarProps>;
  /**
   * Optional — templates that haven't implemented CartTable yet fall back
   * to the generic inline cart-row layout in CartClient.tsx. Remove the
   * `?` once all 5 templates ship it.
   */
  CartTable?: React.ComponentType<CartTableProps>;
  /** Totals panel (cart + checkout). Optional during rollout. */
  OrderSummary?: React.ComponentType<OrderSummaryProps>;
  /** Blank-state for empty collections. Optional during rollout. */
  EmptyState?: React.ComponentType<EmptyStateProps>;
  /** Auth/profile form shell. Optional during rollout. */
  FormCard?: React.ComponentType<FormCardProps>;
}

/**
 * Template layout wrapper props
 */
export interface TemplateLayoutProps {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  announcementBar?: ReactNode;
}
