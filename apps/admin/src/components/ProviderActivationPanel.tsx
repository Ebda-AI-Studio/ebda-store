'use client';

import { Button } from '@/components/ui/Button';
import { useState } from 'react';
import { useLocale } from 'next-intl';
import { ACTIVATION_HOURS, withNumerals } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { Alert } from './Alert';
import { apiPost } from '../lib/api';
import type { ActivationRequest } from '../lib/provider-activation';

interface Props {
  provider: string;
  storeId: string;
  /** This provider's request for the store, if any. */
  activation: ActivationRequest | undefined;
  /** Refetch the activation requests (and the card's configs) after a write. */
  onChanged: () => Promise<void> | void;
}

/**
 * Activation state of an unverified provider on a merchant card: the request button, the
 * "about 5 hours" line, and Ebda's note after a rejection. An activated provider shows nothing
 * here (the card behaves like a verified one and wears the chip).
 */
export function ProviderActivationPanel({ provider, storeId, activation, onChanged }: Props) {
  const t = useT('providerActivation');
  const locale = useLocale() === 'ar' ? 'ar-EG' : 'en-GB';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (activation?.status === 'activated') return null;

  async function request() {
    setBusy(true);
    setError(null);
    const { error: apiErr } = await apiPost(
      `/api/v1/provider-activation/store/${storeId}/${provider}/request`
    );
    setBusy(false);
    if (apiErr) {
      setError(
        apiErr.code === 'CREDENTIALS_REQUIRED'
          ? t('credentialsRequired')
          : apiErr.message || t('failed')
      );
      return;
    }
    await onChanged();
  }

  const requested = activation?.status === 'requested';
  const rejected = activation?.status === 'rejected';

  return (
    <div className="space-y-2" data-testid={`activation-${provider}`}>
      {requested && (
        <Alert
          compact
          variant="info"
          description={
            <div>
              <p>{t('requestedLine', { hours: ACTIVATION_HOURS })}</p>
              <p className="mt-1 text-xs opacity-80">
                {t('requestedAt', {
                  time: new Date(activation.requestedAt).toLocaleString(locale, withNumerals()),
                })}
              </p>
            </div>
          }
        />
      )}
      {rejected && (
        <Alert
          compact
          variant="warning"
          description={
            <div>
              <p className="font-medium">{t('rejectedTitle')}</p>
              {activation.note && <p className="mt-1">{activation.note}</p>}
            </div>
          }
        />
      )}
      {!requested && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={request} disabled={busy}>
            {busy ? t('requesting') : rejected ? t('requestAgain') : t('request')}
          </Button>
          {!rejected && (
            <span className="text-xs text-muted-foreground">
              {t('hint', { hours: ACTIVATION_HOURS })}
            </span>
          )}
        </div>
      )}
      {error && <Alert compact variant="destructive" description={error} />}
    </div>
  );
}

/** Small chip on an activated card header. */
export function ActivatedChip() {
  const t = useT('providerActivation');
  return (
    <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success-ink">
      {t('activatedChip')}
    </span>
  );
}
