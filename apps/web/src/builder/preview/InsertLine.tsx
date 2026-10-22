'use client';

/**
 * The "+" between two sections (storefront side, builder canvas only). The
 * overlay marks the gap nearest the pointer `on`; that reveals a line with a
 * "+" (150 ms ease-out, instant under reduced motion), as does keyboard focus
 * on its button. On touch devices every "+" is visible. The strip never
 * intercepts a click unless it is revealed, so the page underneath stays
 * clickable. The click asks the parent to open the section picker at this
 * index (`request-add`).
 */
import { BRAND } from '@ebda/shared';

const COPY = { en: 'Add section here', ar: 'أضف قسم هنا' } as const;

/** Class names are namespaced so they can never collide with a theme's CSS. */
const CSS_RULES = `
.eb-gap{opacity:0;transition:opacity 150ms ease-out;pointer-events:none}
.eb-gap button{pointer-events:none}
.eb-gap[data-on="true"],.eb-gap:focus-within{opacity:1}
.eb-gap[data-on="true"] button,.eb-gap:focus-within button{pointer-events:auto}
@media (hover:none){.eb-gap{opacity:1}.eb-gap button{pointer-events:auto}}
@media (prefers-reduced-motion:reduce){.eb-gap{transition:none}}
`;

export function InsertLineStyles() {
  return <style data-builder-style>{CSS_RULES}</style>;
}

export function InsertLine({
  locale,
  y,
  pageWidth,
  on,
  onAdd,
}: {
  locale: 'en' | 'ar';
  y: number;
  pageWidth: number;
  /** The pointer is near this gap. */
  on: boolean;
  onAdd: () => void;
}) {
  const label = COPY[locale];
  return (
    <div
      className="eb-gap"
      data-builder-insert
      data-on={on ? 'true' : 'false'}
      style={{
        position: 'absolute',
        top: y - 14,
        insetInlineStart: 0,
        width: pageWidth,
        height: 28,
        zIndex: 2147483002,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          insetInline: 0,
          top: 13,
          height: 2,
          background: BRAND.colors.gold,
          pointerEvents: 'none',
        }}
      />
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={onAdd}
        style={{
          position: 'relative',
          width: 28,
          height: 28,
          borderRadius: 14,
          border: `2px solid ${BRAND.colors.gold}`,
          background: '#1c1917',
          color: '#ffffff',
          fontSize: 18,
          lineHeight: '22px',
          fontWeight: 700,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        +
      </button>
    </div>
  );
}
