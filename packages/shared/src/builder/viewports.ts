/**
 * The three editing/preview viewports (BUILDER-PREVIEW-1, Ahmad 2026-10-07:
 * desktop + tablet + mobile) and the widths the storefront maps responsive
 * overrides onto (Tailwind defaults; `md` = 768 is the storefront's existing
 * mobile/desktop line, so legacy two-way visibility is unchanged).
 */
export type Viewport = 'desktop' | 'tablet' | 'mobile';
export const VIEWPORTS: readonly Viewport[] = ['desktop', 'tablet', 'mobile'];

export const VIEWPORT_RANGES: Record<
  Viewport,
  { minPx: number; maxPx: number | null; previewPx: number }
> = {
  mobile: { minPx: 0, maxPx: 767, previewPx: 390 },
  tablet: { minPx: 768, maxPx: 1023, previewPx: 820 },
  desktop: { minPx: 1024, maxPx: null, previewPx: 1280 },
};
