// Dahab template (دهب) — gold on night, jewellery and handmade goods.
// Builder Phase 3 pilot; design notes in ./DESIGN.md.
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

// Homepage sections: Dahab's own (the other packs share ../shared/*).
export { DahabHeroBanner as HeroBanner, DahabHeroSlider as HeroSlider } from './Hero';
export { DahabCategoryStrip as CategoryStrip } from './CategoryGrid';
export { DahabProductCarousel as ProductCarousel } from './ProductCarousel';
export { DahabTestimonialRow as TestimonialRow } from './TestimonialRow';
