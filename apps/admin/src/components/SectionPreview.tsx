'use client';

import { resolveColor, pickReadableForeground, DEFAULT_THEME } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import type {
  StoreTheme,
  CardFrameSize,
  CardFrameWidth,
  SectionDividers,
  DividerSettings,
} from '@ebda/shared';

type ZoneStyle = {
  color?: string;
  fontFamily?: string;
  fontWeight?: string;
  textAlign?: 'start' | 'center' | 'end';
};

interface SectionPreviewProps {
  label: string;
  bgColor: string | undefined;
  cardFrameColor: string | undefined;
  cardFrameWidth: CardFrameWidth | undefined;
  cardFrameSize?: CardFrameSize;
  headingZone: ZoneStyle | undefined;
  kickerZone?: ZoneStyle;
  subtitleZone?: ZoneStyle;
  /** Title text to display in the preview (defaults to "{label} heading"). */
  titleText?: string;
  /** Kicker text to display in the preview (defaults to "EXPLORE"). */
  kickerText?: string;
  /** Subtitle text to display in the preview (defaults to descriptor). */
  subtitleText?: string;
  /**
   * Optional per-section product-card typography overrides. When provided,
   * the mock product name + price inside each preview card adopt the
   * specified font + color so the merchant sees product-card typography
   * render alongside the section bg.
   */
  productNameZone?: ZoneStyle;
  productPriceZone?: ZoneStyle;
  productCtaZone?: ZoneStyle;
  /**
   * Per-section divider settings. Each slot rendered in the preview when its
   * `enabled` field is true — matches storefront behavior 1:1 so merchants
   * see exactly what they'll get.
   */
  dividers?: SectionDividers;
  /**
   * Suppress the mock 3-product-card grid below the heading. Use for sections
   * that don't render product cards on the storefront (Header / Footer /
   * Announcement / Brand Story / Trust Strip / Blog Carousel) — showing them
   * here would be decorative. Audit fix Ahmad 2026-05-20.
   */
  hideCards?: boolean;
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

// Resolve the preview color for a divider per its `color` mode. Mirrors the
// runtime resolver in apps/web/src/templates/shared/SectionDivider.tsx so the
// preview and the storefront stay in lockstep.
function resolveDividerColor(
  settings: Partial<DividerSettings> | undefined,
  theme: StoreTheme,
  autoFg: string
): string {
  if (!settings) return 'rgba(0,0,0,0.20)';
  switch (settings.color) {
    case 'foreground':
      return `${autoFg}4D`; // ~30% alpha matching bg-foreground/30
    case 'accent':
      return `hsl(${theme.primaryColor || DEFAULT_THEME.primaryColor})`;
    case 'custom':
      return settings.customColor || 'rgba(0,0,0,0.20)';
    case 'auto':
    default:
      return 'rgba(0,0,0,0.20)';
  }
}

/** Render a horizontal divider line scaled for the small preview tile. */
function PreviewHorizontalDivider({
  settings,
  theme,
  autoFg,
}: {
  settings: Partial<DividerSettings>;
  theme: StoreTheme;
  autoFg: string;
}) {
  const color = resolveDividerColor(settings, theme, autoFg);
  const style = settings.style ?? 'solid';
  const thickness = settings.thickness ?? 1;
  const width = settings.width ?? 'short';
  const spacing = settings.spacing ?? 'normal';

  const widthClass =
    width === 'full' ? 'w-full' : width === 'contained' ? 'w-[80%] mx-auto' : 'w-[40%] mx-auto';
  const spacingClass = spacing === 'tight' ? 'my-1' : spacing === 'loose' ? 'my-3' : 'my-2';

  return (
    <hr
      className={`m-0 border-0 border-t ${widthClass} ${spacingClass}`}
      style={{ borderTopStyle: style, borderTopWidth: thickness, borderTopColor: color }}
    />
  );
}

/** Render flanking lines around a text element (kicker/title/subtitle). */
function PreviewFlankingLines({
  text,
  align,
  textStyle,
  settings,
  theme,
  autoFg,
}: {
  text: string;
  align: 'start' | 'center' | 'end';
  textStyle: React.CSSProperties;
  settings: Partial<DividerSettings> | undefined;
  theme: StoreTheme;
  autoFg: string;
}) {
  // 2026-05-20: dropped `align === 'center'` gate (parity with storefront
  // SectionHeading). Lines render whenever the merchant explicitly enabled
  // the toggle, regardless of alignment.
  const showLines = settings?.enabled === true;
  const color = resolveDividerColor(settings, theme, autoFg);
  const thickness = settings?.thickness ?? 1;
  return (
    <div
      className={`flex items-center gap-1.5 ${align === 'start' ? 'justify-start' : align === 'end' ? 'justify-end' : 'justify-center'}`}
    >
      {showLines && (
        <span
          aria-hidden
          className="flex-1 max-w-[30px]"
          style={{ borderTopStyle: 'solid', borderTopWidth: thickness, borderTopColor: color }}
        />
      )}
      <span style={textStyle}>{text}</span>
      {showLines && (
        <span
          aria-hidden
          className="flex-1 max-w-[30px]"
          style={{ borderTopStyle: 'solid', borderTopWidth: thickness, borderTopColor: color }}
        />
      )}
    </div>
  );
}

export function SectionPreview({
  label,
  bgColor,
  cardFrameColor,
  cardFrameWidth,
  cardFrameSize,
  headingZone,
  kickerZone,
  subtitleZone,
  titleText,
  kickerText,
  subtitleText,
  productNameZone,
  productPriceZone,
  productCtaZone,
  dividers,
  hideCards,
  theme,
}: SectionPreviewProps) {
  const t = useT('components.sectionPreview');
  const resolvedBg = resolveColor(bgColor, theme) ?? '#FFFFFF';
  const autoFg = pickReadableForeground(resolvedBg) ?? '#000000';
  const headingColor = resolveColor(headingZone?.color, theme) ?? autoFg;
  const kickerColor = resolveColor(kickerZone?.color, theme) ?? autoFg;
  const subtitleColor = resolveColor(subtitleZone?.color, theme) ?? autoFg;
  const resolvedFrame = resolveColor(cardFrameColor, theme) ?? '#E5E7EB';
  const widthClass = WIDTH_CLASS[cardFrameWidth ?? 'thin'];
  const sizeClass = SIZE_CLASS[cardFrameSize ?? 'normal'];

  // Mock product-card surface — always contrasts against the section bg.
  const cardSurface = autoFg === '#000000' ? '#FFFFFF' : 'rgba(255,255,255,0.10)';
  const cardSurfaceFg = autoFg === '#000000' ? '#1f2937' : '#FFFFFF';
  const productNameColor = resolveColor(productNameZone?.color, theme) ?? cardSurfaceFg;
  const productPriceColor = resolveColor(productPriceZone?.color, theme) ?? cardSurfaceFg;

  const headingAlign = headingZone?.textAlign ?? 'center';
  const kickerAlign = kickerZone?.textAlign ?? 'center';
  const subtitleAlign = subtitleZone?.textAlign ?? 'center';
  const titleShowLines = dividers?.title?.enabled === true && headingAlign === 'center';

  // Mirror the storefront SectionHeading shared-pick fallback (2026-06-04): the
  // admin's single shared colour/style control is meant to apply to every
  // enabled slot, but a slot enabled after the colour was picked can be saved
  // as `{ enabled: true }` only. Resolve one shared pick and let each slot
  // inherit it (without leaking its `enabled`) so the preview paints the same
  // colour the storefront does — otherwise the title hairlines previewed grey.
  const dividerStylePick = [
    dividers?.above,
    dividers?.kicker,
    dividers?.title,
    dividers?.subtitle,
    dividers?.belowHeading,
  ].find(s => s && (s.color !== undefined || s.customColor || s.thickness || s.style));
  // A slot with customColor but no `color` mode is custom by intent (the admin
  // only writes customColor via the custom ColorField). Without this, color
  // falls back to 'foreground' and the preview ignores the pick — same trap
  // fixed on the storefront in SectionDivider.resolveSlotDividerSettings.
  const normalizeCustom = (
    s: Partial<DividerSettings> | undefined
  ): Partial<DividerSettings> | undefined =>
    s && s.customColor && s.color === undefined ? { ...s, color: 'custom' } : s;
  const withSharedStyle = (
    slot: Partial<DividerSettings> | undefined
  ): Partial<DividerSettings> | undefined => {
    if (!slot || !dividerStylePick || slot === dividerStylePick) return normalizeCustom(slot);
    const hasOwn =
      slot.color !== undefined || !!slot.customColor || !!slot.thickness || !!slot.style;
    if (hasOwn) return normalizeCustom(slot);
    return normalizeCustom({
      style: dividerStylePick.style,
      thickness: dividerStylePick.thickness,
      width: dividerStylePick.width,
      color: dividerStylePick.color,
      customColor: dividerStylePick.customColor,
      spacing: dividerStylePick.spacing,
      ...slot,
    });
  };

  const titleDisplayText = titleText || t('headingSuffix', { label });
  const kickerDisplayText = kickerText || t('kickerDefault');
  const subtitleDisplayText = subtitleText || t('subtitleDefault');

  return (
    <div className="overflow-hidden rounded-lg">
      {/* `above` divider — renders OUTSIDE the bg-colored section, mirroring
          how HomePageContent positions <SectionDivider> between sections. */}
      {dividers?.above?.enabled === true && (
        <PreviewHorizontalDivider
          settings={withSharedStyle(dividers.above) ?? dividers.above}
          theme={theme}
          autoFg={autoFg}
        />
      )}
      <div className="p-4" style={{ backgroundColor: resolvedBg }}>
        {/* Kicker — flanked by hairlines when dividers.kicker.enabled */}
        {dividers?.kicker?.enabled !== false && (
          <PreviewFlankingLines
            text={kickerDisplayText}
            align={kickerAlign}
            textStyle={{
              color: kickerColor,
              fontFamily: kickerZone?.fontFamily,
              fontWeight: kickerZone?.fontWeight,
              fontSize: '9px',
              letterSpacing: '0.15em',
              textTransform: 'uppercase',
            }}
            settings={withSharedStyle(dividers?.kicker)}
            theme={theme}
            autoFg={autoFg}
          />
        )}
        {/* Title — flanked by hairlines when dividers.title.enabled */}
        <div className="mt-1.5">
          {titleShowLines ? (
            <PreviewFlankingLines
              text={titleDisplayText}
              align="center"
              textStyle={{
                color: headingColor,
                fontFamily: headingZone?.fontFamily,
                fontWeight: headingZone?.fontWeight,
                fontSize: '12px',
              }}
              settings={withSharedStyle(dividers?.title)}
              theme={theme}
              autoFg={autoFg}
            />
          ) : (
            <p
              className={`text-xs font-semibold ${headingAlign === 'start' ? 'text-start' : headingAlign === 'end' ? 'text-end' : 'text-center'}`}
              style={{
                color: headingColor,
                fontFamily: headingZone?.fontFamily,
                fontWeight: headingZone?.fontWeight,
              }}
            >
              {titleDisplayText}
            </p>
          )}
        </div>
        {/* Subtitle — flanked by hairlines when dividers.subtitle.enabled */}
        {dividers?.subtitle?.enabled !== false && (
          <div className="mt-1">
            <PreviewFlankingLines
              text={subtitleDisplayText}
              align={subtitleAlign}
              textStyle={{
                color: subtitleColor,
                fontFamily: subtitleZone?.fontFamily,
                fontWeight: subtitleZone?.fontWeight,
                fontSize: '9px',
                opacity: 0.85,
              }}
              settings={withSharedStyle(dividers?.subtitle)}
              theme={theme}
              autoFg={autoFg}
            />
          </div>
        )}
        {/* belowHeading divider — between heading block and product grid */}
        {dividers?.belowHeading?.enabled === true && (
          <PreviewHorizontalDivider
            settings={withSharedStyle(dividers.belowHeading) ?? dividers.belowHeading}
            theme={theme}
            autoFg={autoFg}
          />
        )}
        {/* Mock product grid — suppressed for sections without product cards
            (header/footer/announcement/brand-story/trust-strip/blog). Audit
            fix Ahmad 2026-05-20: showing them was decorative for those. */}
        {!hideCards && (
          <div
            className={`grid grid-cols-3 gap-2 ${dividers?.belowHeading?.enabled ? 'mt-1' : 'mt-3'}`}
          >
            {[1, 2, 3].map(i => (
              <div
                key={i}
                className={`flex flex-col items-stretch rounded ${widthClass} ${sizeClass} overflow-hidden`}
                style={{ borderColor: resolvedFrame, backgroundColor: cardSurface }}
              >
                <div
                  className="aspect-square w-full"
                  style={{ backgroundColor: 'rgba(0,0,0,0.06)' }}
                />
                <div className="px-1.5 py-1 text-[9px] leading-tight">
                  <div
                    className="truncate"
                    style={{
                      color: productNameColor,
                      fontFamily: productNameZone?.fontFamily,
                      fontWeight: productNameZone?.fontWeight,
                    }}
                  >
                    {t('productNamePlaceholder')}
                  </div>
                  <div
                    className="font-semibold"
                    style={{
                      color: productPriceColor,
                      fontFamily: productPriceZone?.fontFamily,
                      fontWeight: productPriceZone?.fontWeight,
                    }}
                  >
                    {t('samplePrice')}
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
                    {t('addToCartLabel')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
