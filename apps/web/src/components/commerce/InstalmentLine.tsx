'use client';
import { useLanguage } from '@/contexts/LanguageContext';
import { useStore } from '@/contexts/StoreContext';
import { useNumerals } from '@/hooks/useNumerals';
import { useLocalePrice } from '@/hooks/useLocalePrice';
import { instalmentText, resolveInstalment } from '@/lib/instalment';

/**
 * The PDP instalment estimate (Ruling B2-9). Renders NOTHING unless the merchant enabled it, the
 * displayed price (the selected variant's sale price, never the struck compare-at) is at least
 * their minimum, and the product can be bought now. Inline in the price row, muted, 12px+: the
 * fold does not move. PDP ONLY: the static scan in tests/unit/instalment-line-render.test.tsx
 * pins that this component has exactly one importer (never a card path, the cart or checkout).
 */
export function InstalmentLine({ priceMinor, buyable }: { priceMinor: number; buyable: boolean }) {
  const { store } = useStore();
  const { language } = useLanguage();
  const { localize } = useNumerals();
  const money = useLocalePrice();
  const r = resolveInstalment(
    (store?.settings as Record<string, unknown> | undefined)?.instalments,
    priceMinor,
    buyable
  );
  if (!r) return null;
  return (
    <span
      data-testid="instalment-line"
      className="inline-block max-w-full text-balance text-xs text-muted-foreground"
    >
      {instalmentText(language === 'ar' ? 'ar' : 'en', r, money, localize)}
    </span>
  );
}
