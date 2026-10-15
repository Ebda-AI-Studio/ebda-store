'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useStore } from '../contexts/StoreContext';
import { useLanguage } from '../contexts/LanguageContext';
import { api } from '../lib/api';
import {
  deriveAcceptedPaymentBadges,
  type PaymentBadge,
  type PaymentConfigResponse,
} from '../lib/accepted-payment-badges';

const manualMethod = z
  .object({
    displayName: z.string().nullable().optional(),
    displayNameAr: z.string().nullable().optional(),
  })
  .nullable()
  .optional();
const paymentConfig = z.object({
  methods: z.record(z.string(), z.array(z.object({ code: z.string() }))).optional(),
  cod: manualMethod,
  instapay: manualMethod,
});

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
  const { store } = useStore();
  const { t } = useLanguage();
  const storeId = store.id;
  const [loaded, setLoaded] = useState<{ storeId: string; badges: PaymentBadge[] } | null>(null);

  useEffect(() => {
    if (!storeId || storeId === 'demo') return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setLoaded(null);
    async function attempt(canRetry: boolean) {
      try {
        const result = await api.get<PaymentConfigResponse>('/payments/config');
        if (cancelled) return;
        const parsed = result.success ? paymentConfig.safeParse(result.data) : null;
        if (parsed?.success) {
          setLoaded({ storeId, badges: deriveAcceptedPaymentBadges(parsed.data) });
          return;
        }
      } catch {
        // Unknown availability must never render a guessed payment method.
      }
      if (!cancelled && canRetry) retry = setTimeout(() => void attempt(false), 1500);
    }
    void attempt(true);
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [storeId]);

  // A tenant change must hide the old tenant's badges before effects run.
  const badges = loaded?.storeId === storeId ? loaded.badges : [];
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
