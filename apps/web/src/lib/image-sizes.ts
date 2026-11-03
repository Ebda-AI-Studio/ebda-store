/**
 * `sizes` for storefront images (audit 2026-11-03 #2, Ruling PREMIUM-2). A card's real width is
 * never 100vw: the grid is 2-up on phones (a card is ~46vw after the page gutter and gap), 3-up on
 * tablets, 4-up on desktop where the 1280px container caps a card near 300px. The old
 * `100vw / 50vw / 25vw` told the browser to fetch a 390px-wide file for a 178px thumb.
 * One constant per placement so every card path (4 core + Dahab + the 4 mappers) agrees.
 */
export const CARD_GRID_SIZES = '(max-width: 640px) 46vw, (max-width: 1024px) 31vw, 300px';
/** Carousel slides peek the next card: ~60vw on phones, 30vw on tablets. */
export const CARD_CAROUSEL_SIZES = '(max-width: 640px) 60vw, (max-width: 1024px) 30vw, 300px';
/** Category tiles share the grid arithmetic of product cards. */
export const CATEGORY_TILE_SIZES = '(max-width: 640px) 46vw, (max-width: 1024px) 31vw, 300px';
/** A full-bleed hero spans the viewport. */
export const HERO_SIZES = '100vw';
/** PDP main gallery: full width on phones, 5/12 of the 1280px container on desktop. */
export const PDP_GALLERY_SIZES = '(max-width: 768px) 100vw, 520px';
