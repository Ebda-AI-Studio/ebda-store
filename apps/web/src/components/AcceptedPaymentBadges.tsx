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
        variant === 'dahab' ? 'gap-2' : 'gap-2',
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
              : // P2-6: plain text; a bordered chip read as a button that did nothing (S-04).
                'flex items-center gap-2 text-xs text-muted-foreground'
          }
        >
          {variant !== 'dahab' && i > 0 && <span aria-hidden="true">·</span>}
          {t(badge.label, badge.labelAr)}
        </li>
      ))}
    </ul>
  );
  if (variant === 'dahab') return marks;
  // IA-04 (W4): one inline row under the summary, not a second card; it names the methods once.
  return (
    <div className={['flex flex-wrap items-center gap-2', className].filter(Boolean).join(' ')}>
      <span className="text-xs text-muted-foreground">{t('We accept', 'طرق الدفع المتاحة')}</span>
      {marks}
    </div>
  );
}
