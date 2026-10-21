// Elegant template - Fashion-forward design with refined aesthetics
export { default as Header } from './Header';
export { default as Footer } from './Footer';
export { default as Hero } from './Hero';
export { default as ProductCard } from './ProductCard';
export { default as ProductGrid } from './ProductGrid';
export { default as CategoryCard } from './CategoryCard';
export { default as CategoryGrid } from './CategoryGrid';
export { default as AnnouncementBar } from './AnnouncementBar';
export { default as CartTable } from './CartTable';
export { default as OrderSummary } from './OrderSummary';
export { default as EmptyState } from './EmptyState';
export { default as FormCard } from './FormCard';

// Storefront-flow sections (Epic A) — shared shells, theme-token-styled so
// each pack inherits its own --primary, --foreground, font weights, etc.
// Replace per-pack later if a pack needs distinct visual treatment.
export { HeroBanner } from '../shared/HeroBanner';
export { HeroSlider } from '../shared/HeroSlider';
export { CategoryStrip } from '../shared/CategoryStrip';
export { ProductCarousel } from '../shared/ProductCarousel';
export { TestimonialRow } from '../shared/TestimonialRow';
