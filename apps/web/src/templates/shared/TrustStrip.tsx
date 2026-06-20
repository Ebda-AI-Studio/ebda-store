'use client';

import React from 'react';
import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';
import type { TrustStripSettings } from '@force/shared';
import { resolveColor, pickReadableForeground } from '@force/shared';
import { sectionSpacingClasses } from './section-spacing';
import { sectionBgStyle } from './section-bg';

/**
 * Sprint 3 (2026-05-17): 3-up trust badge strip rendered on the homepage
 * above the footer. Observed in all 3 OSOSS references (Pecannbee 2x2
 * grid / SMEJ 3-up icons / Bank Alkahraman implied via empty space).
 * FWB had no equivalent before this — addresses the "no trust signal"
 * gap surfaced in the 2026-05-17 UI catalog.
 *
 * Platform default content: Fast Delivery / Quality Guarantee / 24/7
 * Support. Bilingual EN + AR. Per-merchant overrides will land in a
 * future admin editor commit (E2-style); for now every store gets
 * these three universal-trust items.
 *
 * Background uses --bg-page so the section participates in the
 * alternating rhythm — footer below it gets --bg-section-alt, so this
 * lands as the second-to-last band in the homepage flow.
 */

interface TrustItem {
  /** Lucide-style line icon SVG path data */
  iconPath: string;
  titleEn: string;
  titleAr: string;
  subEn: string;
  subAr: string;
}

const DEFAULT_TRUST_ITEMS: TrustItem[] = [
  {
    // Truck — fast delivery
    iconPath:
      'M9 17a2 2 0 11-4 0 2 2 0 014 0zM19 17a2 2 0 11-4 0 2 2 0 014 0zM13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.586a1 1 0 01.707.293l3.414 3.414a1 1 0 01.293.707V16a1 1 0 01-1 1h-1m-6-1a1 1 0 001 1h1M5 17a2 2 0 104 0m-4 0a2 2 0 114 0m6 0a2 2 0 104 0m-4 0a2 2 0 114 0',
    titleEn: 'Fast Delivery',
    titleAr: 'شحن سريع',
    subEn: 'Delivered to your door across Kuwait',
    subAr: 'يصلك إلى باب البيت في جميع أنحاء الكويت',
  },
  {
    // Shield-check — quality guarantee
    iconPath:
      'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
    titleEn: 'Quality Guarantee',
    titleAr: 'ضمان الجودة',
    subEn: 'Every product hand-selected for you',
    subAr: 'كل منتج يتم اختياره بعناية لك',
  },
  {
    // Chat-alt — 24/7 support
    iconPath:
      'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
    titleEn: '24/7 Support',
    titleAr: 'دعم على مدار الساعة',
    subEn: 'We are here whenever you need us',
    subAr: 'نحن هنا متى ما احتجت إلينا',
  },
];

export function TrustStrip({ settings }: { settings?: TrustStripSettings } = {}) {
  const { isRtl } = useLanguage();
  const { store } = useStore();
  // Layout + size: page-builder layout.trustStrip wins; legacy theme.*
  // fallback covers stores saved before the page-builder section landed.
  const layout = settings?.layout ?? store.theme?.trustStripLayout ?? 'horizontal';
  const size = settings?.size ?? store.theme?.trustStripSize ?? 'md';
  // `settings` already extends SectionPaddingMaxWidthVisibility — read spacing directly.
  const { wrapperClass, innerContainerClass } = sectionSpacingClasses(settings);
  const listClass =
    layout === 'vertical' ? 'grid grid-cols-1 gap-6' : 'grid grid-cols-3 gap-2 sm:gap-8';

  // Per-size token table — single source of truth so all 4 elements
  // scale in proportion. Vertical mode uses the unprefixed desktop
  // classes at every breakpoint; horizontal mode adds explicit sm:
  // breakpoints so 3-up packs tighter on mobile + comfortable on
  // desktop. Classes are pre-composed strings (not runtime split/join)
  // because Tailwind v4's JIT scanner can't follow dynamic class
  // construction — every literal class must appear in source.
  const SIZE_TOKENS = {
    sm: {
      iconWrapVertical: 'h-8 w-8',
      iconWrapHorizontal: 'h-7 w-7 sm:h-8 sm:w-8',
      iconSvgVertical: 'h-4 w-4',
      iconSvgHorizontal: 'h-3.5 w-3.5 sm:h-4 sm:w-4',
      title: 'text-xs font-bold text-foreground',
      sub: 'text-xs text-foreground/65 max-w-[20ch]',
    },
    md: {
      iconWrapVertical: 'h-12 w-12',
      iconWrapHorizontal: 'h-9 w-9 sm:h-12 sm:w-12',
      iconSvgVertical: 'h-6 w-6',
      iconSvgHorizontal: 'h-4 w-4 sm:h-6 sm:w-6',
      title: 'text-xs sm:text-sm font-bold text-foreground',
      sub: 'text-xs text-foreground/65 max-w-[20ch]',
    },
    lg: {
      iconWrapVertical: 'h-16 w-16',
      iconWrapHorizontal: 'h-12 w-12 sm:h-16 sm:w-16',
      iconSvgVertical: 'h-8 w-8',
      iconSvgHorizontal: 'h-6 w-6 sm:h-8 sm:w-8',
      title: 'text-sm sm:text-base font-bold text-foreground',
      sub: 'text-sm text-foreground/65 max-w-[24ch]',
    },
  } as const;
  const tokens = SIZE_TOKENS[size];

  const iconWrapClass = layout === 'vertical' ? tokens.iconWrapVertical : tokens.iconWrapHorizontal;
  const iconSvgClass = layout === 'vertical' ? tokens.iconSvgVertical : tokens.iconSvgHorizontal;
  const titleClass = tokens.title;
  const subClass = layout === 'vertical' ? tokens.sub : `hidden sm:block ${tokens.sub}`;

  // Auto-contrast: when the merchant sets a custom bgColor, the icon, title,
  // and subtitle tokens (--primary, --foreground) may become unreadable against
  // that background. Resolve the effective bg to a hex/hsl value and pick a
  // readable black or white foreground to override inline. When bgColor is
  // unset, `autoFg` stays undefined and the existing token-based classes win —
  // no regression for stores that never set a custom bg.
  const resolvedBg = settings?.bgColor ? resolveColor(settings.bgColor, store.theme) : undefined;
  const autoFg: string | undefined = resolvedBg
    ? (pickReadableForeground(resolvedBg) ?? undefined)
    : undefined;
  const autoFgStyle = autoFg ? ({ color: autoFg } as React.CSSProperties) : undefined;

  // Merchant-editable icon colors (page-builder Trust strip card). An explicit
  // pick always wins over the auto-contrast fallback; an explicit icon glyph
  // color also drives the title/subtitle so the badge reads as one unit. When
  // only the glyph color is set, the circle defaults to a 10%-opacity tint of
  // it; when only the circle color is set, the glyph keeps the readable
  // default. Precedence: explicit > auto-contrast > brand-token classes.
  const iconColor = settings?.iconColor ? resolveColor(settings.iconColor, store.theme) : undefined;
  const iconBgColor = settings?.iconBgColor
    ? resolveColor(settings.iconBgColor, store.theme)
    : undefined;
  const effectiveIconFg = iconColor ?? autoFg;
  // When no explicit circle color is given, derive a translucent tint of the
  // glyph color. `color-mix` works for ANY valid CSS color (hex, hsl, and
  // `hsl(var(--token))`) — unlike the old `${color}1a` hex-suffix hack, which
  // produced invalid CSS for token/hsl values. On browsers without color-mix
  // (pre-2023 Safari) the declaration is dropped and the `bg-[…]/10` class wins.
  const iconWrapStyle: React.CSSProperties | undefined =
    iconColor || iconBgColor || autoFg
      ? {
          ...(iconBgColor
            ? { backgroundColor: iconBgColor }
            : effectiveIconFg
              ? { backgroundColor: `color-mix(in srgb, ${effectiveIconFg} 10%, transparent)` }
              : {}),
          ...(effectiveIconFg ? { color: effectiveIconFg } : {}),
        }
      : undefined;

  return (
    <section
      aria-label={isRtl ? 'لماذا تتسوق معنا' : 'Why shop with us'}
      dir={isRtl ? 'rtl' : 'ltr'}
      className={`bg-[hsl(var(--bg-page))] ${wrapperClass}`}
      style={sectionBgStyle(settings?.bgColor, store.theme)}
    >
      <div className={innerContainerClass}>
        <ul className={listClass}>
          {DEFAULT_TRUST_ITEMS.map(item => (
            <li
              key={item.titleEn}
              className="flex flex-col items-center text-center gap-2 px-1 sm:px-2"
            >
              <span
                className={`inline-flex items-center justify-center rounded-full bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))] ${iconWrapClass}`}
                style={iconWrapStyle}
                aria-hidden
              >
                <svg className={iconSvgClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.7}
                    d={item.iconPath}
                  />
                </svg>
              </span>
              <h3 className={titleClass} style={autoFgStyle}>
                {isRtl ? item.titleAr : item.titleEn}
              </h3>
              <p className={subClass} style={autoFgStyle}>
                {isRtl ? item.subAr : item.subEn}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
