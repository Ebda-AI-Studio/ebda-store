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
}

/**
 * Footer component props
 */
export interface FooterProps {
  branding: StoreBranding;
  contact: StoreContact;
  socials: StoreSocials;
  navigation?: NavItem[];
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
  urlPrefix?: string;
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
  ProductCard: React.ComponentType<ProductCardProps>;
  ProductGrid: React.ComponentType<ProductGridProps>;
  CategoryCard: React.ComponentType<CategoryCardProps>;
  CategoryGrid: React.ComponentType<CategoryGridProps>;
  AnnouncementBar: React.ComponentType<AnnouncementBarProps>;
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
