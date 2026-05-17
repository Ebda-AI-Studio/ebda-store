'use client';

import { useLanguage } from '../../contexts/LanguageContext';
import { useStore } from '../../contexts/StoreContext';

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

export function TrustStrip() {
  const { isRtl } = useLanguage();
  const { store } = useStore();
  // Layout direction per merchant choice. 'horizontal' (default) = 3-up
  // grid (compact mobile, comfortable desktop). 'vertical' = stacked
  // single column regardless of viewport. Ahmad 2026-05-17 evening.
  const layout = store.theme?.trustStripLayout ?? 'horizontal';
  const listClass =
    layout === 'vertical' ? 'grid grid-cols-1 gap-6' : 'grid grid-cols-3 gap-2 sm:gap-8';
  // Mobile-horizontal shrinks the icon + drops the subtitle so 3 items
  // fit comfortably without wrapping the title to a third line. Desktop
  // restores the full treatment in both modes.
  const iconWrapClass = layout === 'vertical' ? 'h-12 w-12' : 'h-9 w-9 sm:h-12 sm:w-12';
  const iconSvgClass = layout === 'vertical' ? 'h-6 w-6' : 'h-4 w-4 sm:h-6 sm:w-6';
  const titleClass =
    layout === 'vertical'
      ? 'text-sm font-bold text-foreground'
      : 'text-[11px] sm:text-sm font-bold text-foreground';
  const subClass =
    layout === 'vertical'
      ? 'text-xs text-foreground/65 max-w-[20ch]'
      : 'hidden sm:block text-xs text-foreground/65 max-w-[20ch]';

  return (
    <section
      aria-label={isRtl ? 'لماذا تتسوق معنا' : 'Why shop with us'}
      dir={isRtl ? 'rtl' : 'ltr'}
      className="bg-[hsl(var(--bg-page))] py-12 sm:py-16 lg:py-20"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <ul className={listClass}>
          {DEFAULT_TRUST_ITEMS.map(item => (
            <li
              key={item.titleEn}
              className="flex flex-col items-center text-center gap-2 px-1 sm:px-2"
            >
              <span
                className={`inline-flex items-center justify-center rounded-full bg-[hsl(var(--primary))]/10 text-[hsl(var(--primary))] ${iconWrapClass}`}
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
              <h3 className={titleClass}>{isRtl ? item.titleAr : item.titleEn}</h3>
              <p className={subClass}>{isRtl ? item.subAr : item.subEn}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
