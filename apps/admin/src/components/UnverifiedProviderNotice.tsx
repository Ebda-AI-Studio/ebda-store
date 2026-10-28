'use client';

import { useT } from '@/i18n/useT';

/**
 * Ruling PROVIDERS-3: a provider that has not been run against a real account yet connects like any
 * other. This line says so honestly: the check on save tells the merchant whether their credentials
 * work, and the first real order is what confirms the whole flow (Ebda is told about it at once).
 */
/**
 * `pending`: Ebda cannot confirm this provider's payments yet (GEIDEA-2), so buyers are not offered it.
 */
export function UnverifiedProviderNotice({ pending = false }: { pending?: boolean }) {
  const t = useT('providerUnverified');
  return (
    <p className="text-sm text-muted-foreground" data-testid="unverified-provider-notice">
      <span className="me-2 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-ink">
        {pending ? t('pendingChip') : t('chip')}
      </span>
      {pending ? t('pendingNote') : t('note')}
    </p>
  );
}
