'use client';
import { swatchOf } from '@ebda/shared';

type V = {
  id?: string;
  value: string;
  valueAr?: string | null;
  swatchHex?: string | null;
  swatchImageUrl?: string | null;
};
type P = { options?: Array<{ name: string; values: V[] }> | null };

/**
 * Colour dots for a product card. Uses the FIRST option that has any swatch.
 * Renders nothing when no value carries a swatch (feature is off until the
 * merchant enters data). Decorative: the card link already names the product.
 */
export function SwatchDots({
  product,
  max = 5,
  className = '',
}: {
  product: P;
  max?: number;
  className?: string;
}) {
  const opt = product.options?.find(o => o.values.some(v => swatchOf(v)));
  if (!opt) return null;
  const vals = opt.values.filter(v => swatchOf(v));
  const shown = vals.slice(0, max);
  return (
    <div className={`flex items-center gap-1 ${className}`.trim()} aria-hidden="true">
      {shown.map(v => {
        const s = swatchOf(v)!;
        return (
          <span
            key={v.id ?? v.value}
            data-testid="swatch-dot"
            className="inline-block h-3 w-3 overflow-hidden rounded-full border border-foreground/15"
            style={s.imageUrl ? undefined : { backgroundColor: s.hex ?? undefined }}
          >
            {s.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
            )}
          </span>
        );
      })}
      {vals.length > max && (
        <span className="text-[10px] text-muted-foreground">+{vals.length - max}</span>
      )}
    </div>
  );
}
