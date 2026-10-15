'use client';

import { DELIVERY_WEEK_ORDER } from '../lib/checkout-delivery-payload';
import { useT } from '@/i18n/useT';

/**
 * "Days with no delivery": seven toggle chips, Saturday first (Egyptian week). The storefront
 * delivery estimate skips the selected days. All seven selected is not savable (the page
 * disables Save and this field says why).
 */
export function DeliveryOffDaysField({
  value,
  onChange,
}: {
  value: number[];
  onChange: (next: number[]) => void;
}) {
  const t = useT('checkoutDelivery.page');
  const allOff = value.length === DELIVERY_WEEK_ORDER.length;
  const toggle = (d: number) =>
    onChange(value.includes(d) ? value.filter(x => x !== d) : [...value, d]);
  return (
    <div>
      <div role="group" aria-label={t('deliveryOffDaysTitle')} className="flex flex-wrap gap-2">
        {DELIVERY_WEEK_ORDER.map(d => {
          const on = value.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(d)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                on
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:bg-muted'
              }`}
            >
              {t(`deliveryOffDay${d}`)}
            </button>
          );
        })}
      </div>
      {allOff && (
        <p role="alert" className="mt-2 text-xs text-destructive-ink">
          {t('deliveryOffDaysAllOff')}
        </p>
      )}
    </div>
  );
}
