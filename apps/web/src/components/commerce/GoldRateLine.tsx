'use client';
import { useEffect, useState } from 'react';
import type { PublicGoldPricing } from '@ebda/shared';
import { useLanguage } from '@/contexts/LanguageContext';
import { useLocalePrice } from '@/hooks/useLocalePrice';
import { useNumerals } from '@/hooks/useNumerals';
import { goldLineParts, goldRateIsStale, goldRateTime } from '@/lib/gold-display';

/**
 * True once the browser clock says the rate is past the store's limit. Computed after mount so the server
 * render and the first client render agree (the page is cached; time moves on without a rebuild).
 */
export function useGoldRateStale(gold: PublicGoldPricing | null | undefined): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (!gold) {
      setStale(false);
      return;
    }
    const check = () => setStale(goldRateIsStale(gold, Date.now()));
    check();
    const id = window.setInterval(check, 60_000);
    return () => window.clearInterval(id);
  }, [gold]);
  return stale;
}

/**
 * Under the price of a gold piece: karat, weight, today's rate per gram and when it was recorded, plus the
 * gold / making split when the merchant turned it on. Past the limit it says the piece cannot be ordered yet.
 * Never the margin, the making settings or where the rate came from (the payload does not carry them).
 */
export function GoldRateLine({
  gold,
  className,
}: {
  gold: PublicGoldPricing | null | undefined;
  className?: string;
}) {
  const { language, t } = useLanguage();
  const money = useLocalePrice();
  const { localize } = useNumerals();
  const stale = useGoldRateStale(gold);
  if (!gold) return null;
  const lang = language === 'ar' ? 'ar' : 'en';
  const { karat, grams } = goldLineParts(gold);
  const when = goldRateTime(gold.rateAppliedAt, lang);
  return (
    <div className={className} data-testid="gold-rate-line" data-part="gold-rate">
      <p className="text-xs text-muted-foreground">
        {t(
          `${localize(karat)} karat · ${localize(grams)} g · today's rate ${money(gold.ratePerGram)} per gram · updated ${when}`,
          `عيار ${localize(karat)} · ${localize(grams)} جم · سعر الجرام النهارده ${money(gold.ratePerGram)} · اتحدّث ${when}`
        )}
      </p>
      {gold.breakdown && (
        <p className="text-xs text-muted-foreground" data-testid="gold-breakdown">
          {t(
            `Gold ${money(gold.breakdown.metalValue)} + making ${money(gold.breakdown.makingValue)}`,
            `دهب ${money(gold.breakdown.metalValue)} + مصنعية ${money(gold.breakdown.makingValue)}`
          )}
        </p>
      )}
      {stale && (
        <p
          role="status"
          className="mt-1 text-xs font-medium text-foreground"
          data-testid="gold-stale"
        >
          {t(
            'The gold rate is being updated, so this piece cannot be ordered right now.',
            'سعر الدهب بيتحدّث دلوقتي، فمش هنقدر نكمّل طلب القطعة دي قبل ما يتحدّث.'
          )}
        </p>
      )}
    </div>
  );
}
