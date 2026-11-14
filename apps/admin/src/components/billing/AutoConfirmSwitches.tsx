'use client';

import { useState } from 'react';
import { Input } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { apiPut } from '../../lib/api';
import { useT } from '../../i18n/useT';

export type AutoMode = 'off' | 'shadow' | 'live';
export interface DisabledStore {
  storeId: string;
  reason: string | null;
  at: string | null;
}

const MODES: readonly AutoMode[] = ['off', 'shadow', 'live'];

/**
 * The two InstaPay auto-confirm kill switches (Ruling INSTAPAY-AUTO-1): the global mode (off / shadow / live) and the per-store
 * switch. Every change needs a reason (5+ characters), takes effect on the very next decision (no deploy, no cache) and is audited by the API.
 */
export function AutoConfirmSwitches({
  mode,
  disabledStores,
  onChanged,
}: {
  mode: AutoMode;
  disabledStores: DisabledStore[];
  onChanged: (message: string) => void;
}) {
  const t = useT('billingEvents.autoConfirm');
  const [modeReason, setModeReason] = useState('');
  const [modeError, setModeError] = useState('');
  const [storeId, setStoreId] = useState('');
  const [storeReason, setStoreReason] = useState('');
  const [storeError, setStoreError] = useState('');
  const [busy, setBusy] = useState(false);

  async function setMode(next: AutoMode) {
    if (modeReason.trim().length < 5) {
      setModeError(t('mode.reasonRequired'));
      return;
    }
    setBusy(true);
    const { error } = await apiPut('/api/v1/admin/billing/auto-confirm/mode', {
      mode: next,
      reason: modeReason.trim(),
    });
    setBusy(false);
    if (error) {
      setModeError(t('mode.failed'));
      return;
    }
    setModeReason('');
    setModeError('');
    onChanged(t('mode.changed'));
  }

  async function setStore(id: string, enabled: boolean, reason: string): Promise<boolean> {
    if (reason.trim().length < 5) {
      setStoreError(t('mode.reasonRequired'));
      return false;
    }
    setBusy(true);
    const { error } = await apiPut(`/api/v1/admin/stores/${id}/auto-confirm`, {
      enabled,
      reason: reason.trim(),
    });
    setBusy(false);
    if (error) {
      setStoreError(t('stores.failed'));
      return false;
    }
    setStoreError('');
    onChanged(t('stores.changed'));
    return true;
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="auto-mode-title" className="space-y-2">
        <h3 id="auto-mode-title" className="font-medium">
          {t('mode.title')}
        </h3>
        <p className="text-sm text-muted-foreground" data-testid="auto-mode-current">
          {t('mode.current', { mode: t(`mode.${mode}`) })}
        </p>
        <Input
          id="auto-mode-reason"
          label={t('mode.reason')}
          value={modeReason}
          onChange={e => setModeReason(e.target.value)}
          error={modeError || undefined}
        />
        <div className="flex flex-wrap gap-2">
          {MODES.map(m => (
            <Button
              key={m}
              type="button"
              size="sm"
              variant={m === mode ? 'soft' : 'outline'}
              aria-pressed={m === mode}
              disabled={busy || m === mode}
              onClick={() => void setMode(m)}
            >
              {t(`mode.${m}`)}
            </Button>
          ))}
        </div>
      </section>

      <section aria-labelledby="auto-stores-title" className="space-y-2">
        <h3 id="auto-stores-title" className="font-medium">
          {t('stores.title')}
        </h3>
        {disabledStores.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('stores.none')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {disabledStores.map(s => (
              <li key={s.storeId} className="flex flex-wrap items-center gap-2">
                <span dir="ltr" className="break-all">
                  {s.storeId}
                </span>
                {s.reason && <span className="text-muted-foreground">{s.reason}</span>}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void setStore(s.storeId, true, storeReason)}
                >
                  {t('stores.enable')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Input
          id="auto-store-id"
          label={t('stores.storeId')}
          dir="ltr"
          value={storeId}
          onChange={e => setStoreId(e.target.value)}
        />
        <Input
          id="auto-store-reason"
          label={t('stores.reason')}
          value={storeReason}
          onChange={e => setStoreReason(e.target.value)}
          error={storeError || undefined}
        />
        <Button
          type="button"
          size="sm"
          disabled={busy || storeId.trim().length === 0}
          onClick={() => void setStore(storeId.trim(), false, storeReason)}
        >
          {t('stores.disable')}
        </Button>
      </section>
    </div>
  );
}
