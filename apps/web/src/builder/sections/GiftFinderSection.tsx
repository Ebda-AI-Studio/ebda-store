'use client';

/**
 * `gift-finder` (Phase B5, Dahab Gift box; Ruling B5-7): who is it for, and how much. Two chip
 * rows over the product list's own URL filters, so there is no facet and no new API:
 *
 *  - occasions are buttons (`aria-pressed`) that pick ONE category;
 *  - budgets are links to `/products?[category=<slug>&]maxPrice=<minor>`;
 *  - once an occasion is picked, one more link ("Show gifts") opens that category on its own.
 *
 * Every target is 44px, boundaries use the look's input border (never the decorative line), and the
 * section is server-rendered with nothing picked, so the budget links are real hrefs before any
 * script runs. A block that names a category the store does not have is hidden (the validator
 * warns the editor). With no occasion and no budget it renders nothing; the editor canvas shows a
 * hint instead.
 */
import React from 'react';
import Link from 'next/link';
import { toMinor, type BlockNode, type SectionPaddingMaxWidthVisibility } from '@ebda/shared';
import type { Category } from '@/lib/api';
import { useStore, useStoreUrl } from '../../contexts/StoreContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { useLocalePrice } from '../../hooks/useLocalePrice';
import { sectionBgStyle } from '../../templates/shared/section-bg';
import { sectionSpacingClasses } from '../../templates/shared/section-spacing';
import { EmptySectionHint } from '../render/EmptySectionHint';
import { SectionHeader } from './SectionHeader';

export interface GiftFinderSettings extends SectionPaddingMaxWidthVisibility {
  heading?: string;
  headingAr?: string;
  occasionsLabel?: string;
  occasionsLabelAr?: string;
  budgetsLabel?: string;
  budgetsLabelAr?: string;
  buttonText?: string;
  buttonTextAr?: string;
  bgColor?: string;
}

const CHIP =
  'inline-flex min-h-[44px] items-center justify-center rounded-[var(--radius)] border border-input px-4 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';
const CHIP_IDLE = 'bg-background text-foreground hover:border-primary';
const CHIP_ON = 'border-primary bg-primary text-primary-foreground';

export function GiftFinderSection({
  settings,
  blocks,
  categories,
  editorMode = false,
}: {
  settings: GiftFinderSettings;
  blocks: BlockNode[];
  categories: Category[];
  editorMode?: boolean;
}) {
  const { store } = useStore();
  const { language, t } = useLanguage();
  const storeUrl = useStoreUrl();
  const formatPrice = useLocalePrice();
  const ar = language === 'ar';
  const pick = (en?: unknown, a?: unknown) =>
    ((ar ? (a as string) || (en as string) : (en as string) || (a as string)) ?? '').trim();
  const spacing = sectionSpacingClasses(settings, store.look);
  const bySlug = new Map(categories.map(c => [c.slug, c]));
  const [picked, setPicked] = React.useState<string | null>(null);

  const occasions = blocks
    .filter(b => b.type === 'occasion' && b.hidden !== true)
    .map(b => {
      const slug = typeof b.settings.categorySlug === 'string' ? b.settings.categorySlug : '';
      const cat = slug ? bySlug.get(slug) : undefined;
      return {
        id: b.id,
        slug: cat?.slug ?? '',
        label: pick(b.settings.label, b.settings.labelAr) || pick(cat?.name, cat?.nameAr),
      };
    })
    // An occasion needs a category the store really has, and a name to show.
    .filter(o => o.slug && o.label);

  const budgets = blocks
    .filter(b => b.type === 'budget' && b.hidden !== true)
    .map(b => {
      const cap = typeof b.settings.maxPrice === 'number' ? b.settings.maxPrice : 0;
      if (!Number.isSafeInteger(cap) || cap < 1) return null;
      return {
        id: b.id,
        minor: toMinor(cap),
        label:
          pick(b.settings.label, b.settings.labelAr) ||
          `${t('Up to', 'لحد')} ${formatPrice(toMinor(cap))}`,
      };
    })
    .filter((b): b is { id: string; minor: number; label: string } => !!b);

  if (occasions.length === 0 && budgets.length === 0)
    return editorMode ? <EmptySectionHint kind="giftFinder" /> : null;

  const title = pick(settings.heading, settings.headingAr);
  const editTitle = editorMode
    ? { 'data-builder-setting': ar ? 'headingAr' : 'heading' }
    : undefined;
  const occasionsLabel =
    pick(settings.occasionsLabel, settings.occasionsLabelAr) || t('Who is it for?', 'الهدية لمين؟');
  const budgetsLabel =
    pick(settings.budgetsLabel, settings.budgetsLabelAr) || t('How much?', 'بكام؟');
  const showText =
    pick(settings.buttonText, settings.buttonTextAr) || t('Show gifts', 'عرض الهدايا');
  const query = (maxMinor?: number) => {
    const q = new URLSearchParams();
    if (picked) q.set('category', picked);
    if (maxMinor) q.set('maxPrice', String(maxMinor));
    const s = q.toString();
    return storeUrl(s ? `/products?${s}` : '/products');
  };

  return (
    <section
      data-section="gift-finder"
      className={`bg-[hsl(var(--bg-page))] ${spacing.wrapperClass}`}
      style={sectionBgStyle(settings.bgColor, store.theme)}
    >
      <div className={spacing.innerContainerClass}>
        {title && <SectionHeader title={title} center editTitle={editTitle} />}
        <div className="mx-auto max-w-3xl space-y-6">
          {occasions.length > 0 && (
            <div role="group" aria-labelledby="gift-occasions">
              <p id="gift-occasions" className="mb-3 text-sm text-muted-foreground">
                {occasionsLabel}
              </p>
              <ul className="flex flex-wrap gap-2">
                {occasions.map(o => (
                  <li key={o.id}>
                    <button
                      type="button"
                      aria-pressed={picked === o.slug}
                      onClick={() => setPicked(p => (p === o.slug ? null : o.slug))}
                      className={`${CHIP} ${picked === o.slug ? CHIP_ON : CHIP_IDLE}`}
                    >
                      {o.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {budgets.length > 0 && (
            <div role="group" aria-labelledby="gift-budgets">
              <p id="gift-budgets" className="mb-3 text-sm text-muted-foreground">
                {budgetsLabel}
              </p>
              <ul className="flex flex-wrap gap-2">
                {budgets.map(b => (
                  <li key={b.id}>
                    <Link href={query(b.minor)} prefetch={false} className={`${CHIP} ${CHIP_IDLE}`}>
                      {b.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {picked && (
            <Link
              href={query()}
              prefetch={false}
              data-gift-show=""
              className={`${CHIP} ${CHIP_ON}`}
            >
              {showText}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}
