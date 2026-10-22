'use client';

/**
 * PDP rating line (Phase B3, Ruling B3-6): one inline "★ 4.7 · 212 تقييم" under the title that
 * links to the reviews section. PDP only; a card never carries a rating (B0-4 taste bar).
 *
 * Renders NOTHING without a rating, so a product with no published review leaves the PDP markup
 * exactly as it was. CACHE CLASS: BOUNDED-stale. `ratingStats` rides the cached public product
 * payload (120 s Redis + 60 s edge); review moderation purges it (`refreshRatingCaches`).
 */
import { useLanguage, translations } from '../../contexts/LanguageContext';
import { countText, RATINGS } from '../../lib/plural';

/** The id of the reviews block on the PDP (the `ReviewSection` root; client-only, so SSR markup is unchanged). */
export const REVIEWS_ANCHOR_ID = 'reviews';

export function RatingSummary({
  average,
  count,
}: {
  average: number | null | undefined;
  count: number | null | undefined;
}) {
  const { language, t } = useLanguage();
  if (!count || count < 1 || !average || average <= 0) return null;
  const lang = language === 'ar' ? 'ar' : 'en';
  const avg = average.toFixed(1);
  const counted = countText(lang, count, RATINGS);
  const label = t(
    'Rated {avg} out of 5 from {count}. Read the reviews',
    translations['Rated {avg} out of 5 from {count}. Read the reviews']
  )
    .replace('{avg}', avg)
    .replace('{count}', counted);
  return (
    <a
      href={`#${REVIEWS_ANCHOR_ID}`}
      data-zone="ratingSummary"
      aria-label={label}
      className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 text-sm text-foreground underline decoration-primary underline-offset-4 hover:decoration-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span aria-hidden="true" className="text-primary">
        ★
      </span>
      <span aria-hidden="true" className="font-medium">
        {avg}
      </span>
      <span aria-hidden="true" className="text-muted-foreground">
        · {counted}
      </span>
    </a>
  );
}
