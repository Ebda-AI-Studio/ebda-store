'use client';

import { useLanguage } from '../contexts/LanguageContext';
import { useStorePaymentConfig } from '../hooks/useStorePaymentConfig';
import { deriveAcceptedPaymentBadges } from '../lib/accepted-payment-badges';

/** Informational badges: fresh per mount/store; checkout revalidates availability.
 * No cross-page cache or merchant display override may claim a payment capability.
 */
export function AcceptedPaymentBadges({
  variant = 'cart',
  className,
}: {
  variant?: 'cart' | 'dahab';
  className?: string;
}) {
  const { t } = useLanguage();
  const config = useStorePaymentConfig();
  const badges = config ? deriveAcceptedPaymentBadges(config) : [];
  if (badges.length === 0) return null;
  const marks = (
    <ul
      aria-label={t('Ways to pay', 'طرق الدفع')}
      className={[
        'flex flex-wrap items-center',
        variant === 'dahab' ? 'gap-2' : 'justify-center gap-3',
        variant === 'dahab' ? className : undefined,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {badges.map((badge, i) => (
        <li
          key={`${badge.label}:${i}`}
          aria-label={t(badge.label, badge.labelAr)}
          className={
            variant === 'dahab'
              ? 'flex h-7 items-center rounded-[3px] border border-foreground/20 px-2.5 text-xs font-medium text-foreground/70'
              : 'flex h-8 items-center rounded-md bg-muted px-3 text-xs font-medium text-muted-foreground'
          }
        >
          {t(badge.label, badge.labelAr)}
        </li>
      ))}
    </ul>
  );
  if (variant === 'dahab') return marks;
  return (
    <div
      className={['rounded-2xl border border-border bg-card p-4', className]
        .filter(Boolean)
        .join(' ')}
    >
      <p className="mb-3 text-center text-xs font-medium text-muted-foreground">
        {t('We Accept', 'نقبل الدفع عبر')}
      </p>
      {marks}
    </div>
  );
}
