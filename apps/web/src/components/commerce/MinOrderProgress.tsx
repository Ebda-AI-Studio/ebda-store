'use client';

import { checkMinimumOrder } from '@ebda/shared';
import { useLanguage } from '../../contexts/LanguageContext';
import { useLocalePrice } from '../../hooks/useLocalePrice';

/**
 * Minimum-order progress (Ruling B4-6, quality bar: text, not colour alone). Shows what is left to
 * reach the store's minimum order as one sentence plus a determinate bar. Renders NOTHING when the
 * store sets no minimum or the cart already meets it (an unfilled feature renders nothing).
 * This is advice only: the API's `MINIMUM_ORDER_NOT_MET` and the cart's blocked checkout are the
 * rule and are unchanged.
 */
export function MinOrderProgress({
  subtotalFils,
  minimumOrderFils,
  className,
}: {
  subtotalFils: number;
  minimumOrderFils: number | null | undefined;
  className?: string;
}) {
  const { t } = useLanguage();
  const formatPrice = useLocalePrice();
  const check = checkMinimumOrder(subtotalFils, minimumOrderFils);
  if (check.met || !minimumOrderFils) return null;
  const left = formatPrice(check.shortfallFils);
  const message = t(
    `Add ${left} to reach the minimum order`,
    `ضيف ${left} وتوصل للحد الأدنى للطلب`
  );
  return (
    <div data-testid="min-order-progress" className={className}>
      <p className="text-xs font-medium text-foreground">{message}</p>
      <div
        role="progressbar"
        aria-label={message}
        aria-valuemin={0}
        aria-valuemax={minimumOrderFils}
        aria-valuenow={Math.max(0, Math.min(subtotalFils, minimumOrderFils))}
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary"
          style={{
            width: `${Math.max(0, Math.min(100, (subtotalFils / minimumOrderFils) * 100))}%`,
          }}
        />
      </div>
    </div>
  );
}
