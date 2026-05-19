'use client';

import { resolveColor, pickReadableForeground } from '@force/shared';
import type { StoreTheme, CardFrameWidth } from '@force/shared';

interface SectionPreviewProps {
  label: string;
  bgColor: string | undefined;
  cardFrameColor: string | undefined;
  cardFrameWidth: CardFrameWidth | undefined;
  headingZone: { color?: string; fontFamily?: string; fontWeight?: string } | undefined;
  theme: StoreTheme;
}

const WIDTH_CLASS: Record<CardFrameWidth, string> = {
  thin: 'border',
  normal: 'border-2',
  thick: 'border-4',
  xthick: 'border-8',
};

export function SectionPreview({
  label,
  bgColor,
  cardFrameColor,
  cardFrameWidth,
  headingZone,
  theme,
}: SectionPreviewProps) {
  const resolvedBg = resolveColor(bgColor, theme) ?? '#FFFFFF';
  const autoFg = pickReadableForeground(resolvedBg) ?? '#000000';
  const headingColor = resolveColor(headingZone?.color, theme) ?? autoFg;
  const resolvedFrame = resolveColor(cardFrameColor, theme) ?? '#E5E7EB';
  const widthClass = WIDTH_CLASS[cardFrameWidth ?? 'thin'];

  return (
    <div className="rounded-lg p-4 text-center" style={{ backgroundColor: resolvedBg }}>
      <p
        className="mb-2 text-xs font-semibold uppercase tracking-wider"
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
            className={`aspect-square rounded ${widthClass} bg-white/40`}
            style={{ borderColor: resolvedFrame }}
          />
        ))}
      </div>
    </div>
  );
}
