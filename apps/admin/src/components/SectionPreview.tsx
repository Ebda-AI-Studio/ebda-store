'use client';

import { resolveColor, pickReadableForeground } from '@force/shared';
import type { StoreTheme, CardFrameSize, CardFrameWidth } from '@force/shared';

interface SectionPreviewProps {
  label: string;
  bgColor: string | undefined;
  cardFrameColor: string | undefined;
  cardFrameWidth: CardFrameWidth | undefined;
  cardFrameSize?: CardFrameSize;
  headingZone: { color?: string; fontFamily?: string; fontWeight?: string } | undefined;
  /**
   * Optional per-section product-card typography overrides. When provided,
   * the mock product name + price inside each preview card adopt the
   * specified font + color so the merchant sees product-card typography
   * render alongside the section bg.
   */
  productNameZone?: { color?: string; fontFamily?: string; fontWeight?: string };
  productPriceZone?: { color?: string; fontFamily?: string; fontWeight?: string };
  productCtaZone?: { color?: string; fontFamily?: string; fontWeight?: string };
  theme: StoreTheme;
}

const WIDTH_CLASS: Record<CardFrameWidth, string> = {
  thin: 'border',
  normal: 'border-2',
  thick: 'border-4',
  xthick: 'border-8',
};

// Halved from storefront values so the small preview tile still fits 3 cards.
const SIZE_CLASS: Record<CardFrameSize, string> = {
  compact: 'p-1',
  normal: 'p-1.5',
  comfortable: 'p-2',
  spacious: 'p-3',
};

export function SectionPreview({
  label,
  bgColor,
  cardFrameColor,
  cardFrameWidth,
  cardFrameSize,
  headingZone,
  productNameZone,
  productPriceZone,
  productCtaZone,
  theme,
}: SectionPreviewProps) {
  const resolvedBg = resolveColor(bgColor, theme) ?? '#FFFFFF';
  const autoFg = pickReadableForeground(resolvedBg) ?? '#000000';
  const headingColor = resolveColor(headingZone?.color, theme) ?? autoFg;
  const resolvedFrame = resolveColor(cardFrameColor, theme) ?? '#E5E7EB';
  const widthClass = WIDTH_CLASS[cardFrameWidth ?? 'thin'];
  const sizeClass = SIZE_CLASS[cardFrameSize ?? 'normal'];

  // Mock product-card surface — always contrasts against the section bg so
  // the cards stay visible regardless of which bg the merchant picked. The
  // section bg may be brand primary (dark) OR a light neutral; pick the
  // mock surface that contrasts.
  const cardSurface = autoFg === '#000000' ? '#FFFFFF' : 'rgba(255,255,255,0.10)';
  const cardSurfaceFg = autoFg === '#000000' ? '#1f2937' : '#FFFFFF';

  const productNameColor = resolveColor(productNameZone?.color, theme) ?? cardSurfaceFg;
  const productPriceColor = resolveColor(productPriceZone?.color, theme) ?? cardSurfaceFg;

  return (
    <div className="rounded-lg p-4" style={{ backgroundColor: resolvedBg }}>
      <p
        className="mb-3 text-center text-xs font-semibold uppercase tracking-wider"
        style={{
          color: headingColor,
          fontFamily: headingZone?.fontFamily,
          fontWeight: headingZone?.fontWeight,
        }}
      >
        {label} heading
      </p>
      <div className="grid grid-cols-3 gap-2">
        {[1, 2, 3].map(i => (
          <div
            key={i}
            className={`flex flex-col items-stretch rounded ${widthClass} ${sizeClass} overflow-hidden`}
            style={{ borderColor: resolvedFrame, backgroundColor: cardSurface }}
          >
            {/* image placeholder — visible regardless of section bg */}
            <div className="aspect-square w-full" style={{ backgroundColor: 'rgba(0,0,0,0.06)' }} />
            <div className="px-1.5 py-1 text-[9px] leading-tight">
              <div
                className="truncate"
                style={{
                  color: productNameColor,
                  fontFamily: productNameZone?.fontFamily,
                  fontWeight: productNameZone?.fontWeight,
                }}
              >
                Product
              </div>
              <div
                className="font-semibold"
                style={{
                  color: productPriceColor,
                  fontFamily: productPriceZone?.fontFamily,
                  fontWeight: productPriceZone?.fontWeight,
                }}
              >
                5.000 KD
              </div>
              <div
                className="mt-0.5 rounded-sm py-0.5 text-center text-[8px] font-medium uppercase tracking-wider"
                style={{
                  backgroundColor: resolvedFrame,
                  color:
                    resolveColor(productCtaZone?.color, theme) ??
                    pickReadableForeground(resolvedFrame) ??
                    '#FFFFFF',
                  fontFamily: productCtaZone?.fontFamily,
                  fontWeight: productCtaZone?.fontWeight,
                }}
              >
                Add
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
