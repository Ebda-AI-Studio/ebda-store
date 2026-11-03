'use client';

import { useState } from 'react';
import { Button } from '@ebda/ui';
import { useT } from '@/i18n/useT';
import { useAuth } from '../lib/auth';
import { useStore } from '../contexts/StoreContext';
import { enableOrderAlerts, type EnableAlertsResult } from '../lib/push-opt-in';

/**
 * "Turn on order alerts on this device". The ONLY thing that loads the push SDK: a click, never a page load.
 * Arabic-first copy lives in `components.orderAlerts`; layout uses logical properties so it mirrors under RTL.
 */
export function EnableOrderAlertsButton({ onDone }: { onDone?: (r: EnableAlertsResult) => void }) {
  const t = useT('components.orderAlerts');
  const { user } = useAuth();
  const { selectedStoreId } = useStore();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EnableAlertsResult | 'error' | null>(null);

  if (!user || user.role === 'customer') return null;

  async function enable() {
    if (!user || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await enableOrderAlerts({
        userId: user.id,
        role: user.role,
        storeId: selectedStoreId,
      });
      setResult(r);
      onDone?.(r);
    } catch {
      setResult('error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="order-alerts-title"
      className="rounded-2xl border border-border bg-card p-5"
    >
      <h2 id="order-alerts-title" className="text-base font-semibold text-foreground">
        {t('title')}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t('body')}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" onClick={enable} disabled={busy || result === 'enabled'}>
          {busy ? t('enabling') : result === 'enabled' ? t('enabled') : t('cta')}
        </Button>
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {result === 'enabled' && t('doneHint')}
          {result === 'denied' && t('denied')}
          {result === 'unavailable' && t('unavailable')}
          {result === 'error' && t('error')}
        </p>
      </div>
    </section>
  );
}
