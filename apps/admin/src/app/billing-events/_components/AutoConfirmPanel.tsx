'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../../../lib/api';
import { useT } from '../../../i18n/useT';
import { useLatestRequest } from '../../../hooks/useLatestRequest';
import { AutoConfirmList, type AutoConfirmRow } from '../../../components/billing/AutoConfirmList';
import {
  AutoConfirmSwitches,
  type AutoMode,
  type DisabledStore,
} from '../../../components/billing/AutoConfirmSwitches';

/** Super-admin "Auto-confirm" tab: the kill switches and what the AI decided for each InstaPay receipt (Ruling INSTAPAY-AUTO-1). */
export function AutoConfirmPanel({
  refreshKey,
  onChanged,
}: {
  refreshKey: number;
  onChanged: (message: string) => void;
}) {
  const t = useT('billingEvents.autoConfirm');
  const [mode, setMode] = useState<AutoMode>('off');
  const [disabled, setDisabled] = useState<DisabledStore[]>([]);
  const [rows, setRows] = useState<AutoConfirmRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const beginRequest = useLatestRequest();

  const load = useCallback(async () => {
    const isLatest = beginRequest();
    setLoading(true);
    const { data, error } = await apiGet<{
      confirmations: AutoConfirmRow[];
      mode: AutoMode;
      disabledStores: DisabledStore[];
    }>('/api/v1/admin/billing/auto-confirmations');
    if (!isLatest()) return;
    setLoadError(!!error);
    // an outage is never rendered as "mode off, nothing here": the error state replaces the controls
    if (data) {
      setMode(data.mode);
      setDisabled(data.disabledStores);
      setRows(data.confirmations);
    }
    setLoading(false);
  }, [beginRequest]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (loading) {
    return (
      <div className="rounded-lg border border-border px-3 py-6 text-center text-muted-foreground">
        {t('loading')}
      </div>
    );
  }
  if (loadError) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-6 text-center text-destructive-ink"
      >
        {t('failedToLoad')}
      </div>
    );
  }
  const changed = (m: string) => {
    onChanged(m);
    void load();
  };
  return (
    <div className="space-y-8">
      <AutoConfirmSwitches mode={mode} disabledStores={disabled} onChanged={changed} />
      <AutoConfirmList rows={rows} onChanged={changed} />
    </div>
  );
}
