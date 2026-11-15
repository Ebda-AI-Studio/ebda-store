'use client';

import { useCallback, useEffect, useState } from 'react';
import { Modal, Select } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import { useAuth } from '../../../../lib/auth';
import { apiGet, apiPut } from '../../../../lib/api';
import { formatDateTime } from '../../../../lib/format';

export const ASSISTANT_MODES = ['off', 'answer-only', 'suggest', 'act'] as const;
export type AssistantMode = (typeof ASSISTANT_MODES)[number];

interface ModeState {
  mode: AssistantMode;
  lastChange: { by: string | null; at: string } | null;
}

/**
 * Super-admin only: the per-store rollout mode of the Ebda assistant (`settings.assistantMode`, default off).
 * Backed by GET/PUT /api/v1/admin/assistant/stores/:storeId/mode, both behind authenticate + requireMfaEnrolled +
 * authorize('super_admin'); the PUT is audited as `assistant.mode`. This card renders nothing for any other role, which is
 * defence in depth, not the gate. Any mode above "off" needs an explicit confirmation.
 */
export function AssistantModeCard({ storeId }: { storeId: string }) {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const t = useT('stores.dashboard.assistantMode');
  const [state, setState] = useState<ModeState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [choice, setChoice] = useState<AssistantMode>('off');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const endpoint = `/api/v1/admin/assistant/stores/${storeId}/mode`;

  const load = useCallback(async () => {
    setLoadFailed(false);
    const { data, error } = await apiGet<ModeState>(endpoint);
    if (error || !data) {
      setLoadFailed(true);
      return;
    }
    setState(data);
    setChoice(data.mode);
  }, [endpoint]);

  useEffect(() => {
    if (isSuperAdmin) void load();
  }, [isSuperAdmin, load]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    const { error } = await apiPut(endpoint, { mode: choice });
    setSaving(false);
    if (error) {
      setSaveError(error.message || t('saveFailed'));
      return;
    }
    setConfirming(false);
    await load();
  }, [endpoint, choice, load, t]);

  if (!isSuperAdmin) return null;

  const changed = state !== null && choice !== state.mode;
  const options = ASSISTANT_MODES.map(m => ({ value: m, label: t(`modes.${m}.label`) }));
  const onSave = () => (choice === 'off' ? void save() : setConfirming(true));

  return (
    <div className="rounded-xl border bg-card shadow-sm" data-testid="assistant-mode-card">
      <div className="border-b p-4">
        <h2 className="font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <div className="space-y-4 p-6">
        {loadFailed ? (
          <div role="alert" className="space-y-3">
            <p className="text-sm text-destructive-ink">{t('loadFailed')}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t('retry')}
            </Button>
          </div>
        ) : state === null ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : (
          <>
            <Select
              label={t('modeLabel')}
              value={choice}
              options={options}
              onChange={e => setChoice(e.target.value as AssistantMode)}
              disabled={saving}
            />
            <p className="text-sm text-muted-foreground" data-testid="assistant-mode-meaning">
              {t(`modes.${choice}.meaning`)}
            </p>
            <p className="text-xs text-muted-foreground" data-testid="assistant-mode-trail">
              {state.lastChange
                ? t('lastChanged', {
                    by: state.lastChange.by ?? t('unknownActor'),
                    at: formatDateTime(state.lastChange.at),
                  })
                : t('neverChanged')}
            </p>
            {saveError && (
              <p role="alert" className="text-sm text-destructive-ink">
                {saveError}
              </p>
            )}
            <Button
              onClick={onSave}
              disabled={!changed || saving}
              isLoading={saving && !confirming}
            >
              {t('save')}
            </Button>
          </>
        )}
      </div>
      <Modal
        isOpen={confirming}
        onClose={() => !saving && setConfirming(false)}
        title={t('confirmTitle')}
        size="sm"
      >
        <div className="space-y-4 p-6">
          <p className="text-sm text-foreground">
            {t('confirmBody', { mode: t(`modes.${choice}.label`) })}
          </p>
          <p className="text-sm text-muted-foreground">{t(`modes.${choice}.meaning`)}</p>
          {saveError && (
            <p role="alert" className="text-sm text-destructive-ink">
              {saveError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={saving}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void save()} isLoading={saving} disabled={saving}>
              {t('confirm')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
