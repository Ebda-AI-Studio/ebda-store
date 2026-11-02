'use client';
import { swatchOf } from '@ebda/shared';
import { SignedAmount } from '@/lib/bidi';
import { useLanguage } from '@/contexts/LanguageContext';
import { countText, COLOURS } from '@/lib/plural';

type V = {
  id?: string;
  value: string;
  valueAr?: string | null;
  swatchHex?: string | null;
  swatchImageUrl?: string | null;
};
type P = {
  options?: Array<{ name: string; _count?: { values: number }; values: V[] }> | null;
};

/**
 * Colour dots for a product card. Uses the FIRST option that has any swatch.
 * Renders nothing when no value carries a swatch (feature is off until the
 * merchant enters data). The dots are decorative (aria-hidden); the colour COUNT is information,
 * so screen readers get it as one sr-only line (R-14).
 */
/** The page language; Arabic-first when the dots render outside a LanguageProvider (isolated
 *  renders). `useLanguage` is one useContext, so the call order never changes. */
function useLanguageOrArabic(): string {
  try {
    return useLanguage().language;
  } catch {
    return 'ar';
  }
}

export function SwatchDots({
  product,
  max = 5,
  className = '',
}: {
  product: P;
  max?: number;
  className?: string;
}) {
  const language = useLanguageOrArabic();
  const opt = product.options?.find(o => o.values.some(v => swatchOf(v)));
  if (!opt) return null;
  const vals = opt.values.filter(v => swatchOf(v));
  const shown = vals.slice(0, max);
  // The API caps the shipped rows; `_count` carries the real total.
  const total = Math.max(opt._count?.values ?? 0, vals.length);
  return (
    <>
      <span data-card-chrome="swatches" className="sr-only">
        {countText(language === 'ar' ? 'ar' : 'en', total, COLOURS)}
      </span>
      <div
        data-card-chrome="swatches"
        className={`flex items-center gap-1 ${className}`.trim()}
        aria-hidden="true"
      >
        {shown.map(v => {
          const s = swatchOf(v)!;
          return (
            <span
              key={v.id ?? v.value}
              data-testid="swatch-dot"
              className="inline-block h-3 w-3 overflow-hidden rounded-full border border-foreground"
              style={s.imageUrl ? undefined : { backgroundColor: s.hex ?? undefined }}
            >
              {s.imageUrl && (
                <img
                  src={s.imageUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              )}
            </span>
          );
        })}
        {total > max && (
          <span className="text-xs text-muted-foreground">
            <SignedAmount sign="+" value={total - max} />
          </span>
        )}
      </div>
    </>
  );
}
