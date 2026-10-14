'use client';

/**
 * BotModeCard — lets merchant choose between legacy chat bot, native Meta
 * Commerce Catalog, or native catalog + Gemini AI Agent.
 *
 * Saves via PUT /api/v1/stores/:id/integrations/wbs { botMode }.
 */

import { useState } from 'react';
import { Button, useToast } from '@ebda/ui';
import { apiPut } from '../../../../lib/api';
import type { BotMode } from '../../../../lib/types/wa-bot';
import { BOT_MODE_LABELS } from '../../../../lib/types/wa-bot';
import { useT } from '../../../../i18n/useT';

interface BotModeCardProps {
  storeId: string;
  initialMode: BotMode;
}

export function BotModeCard({ storeId, initialMode }: BotModeCardProps) {
  const { success: toastSuccess, error: toastError } = useToast();
  const t = useT('whatsappIntegration.botMode');
  const [mode, setMode] = useState<BotMode>(initialMode);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, {
      botMode: mode,
    });
    setSaving(false);
    if (error) {
      toastError(error.message || t('saveError'));
    } else {
      toastSuccess(t('saveSuccess'));
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-base font-semibold text-foreground mb-1">{t('title')}</h2>
      <p className="text-sm text-muted-foreground mb-5">{t('subtitle')}</p>

      <div className="space-y-3">
        {(Object.keys(BOT_MODE_LABELS) as BotMode[]).map(key => (
          <label
            key={key}
            className={`flex cursor-pointer rounded-lg border p-4 gap-3 transition-colors ${
              mode === key ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
            }`}
          >
            <input
              type="radio"
              name="botMode"
              value={key}
              checked={mode === key}
              onChange={() => setMode(key)}
              className="mt-0.5 shrink-0 accent-primary"
            />
            <div>
              <p className="text-sm font-medium text-foreground">
                {t(`label_${key}` as Parameters<typeof t>[0])}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t(`desc_${key}` as Parameters<typeof t>[0])}
              </p>
            </div>
          </label>
        ))}
      </div>

      <div className="mt-5 flex justify-end">
        <Button onClick={handleSave} disabled={saving || mode === initialMode} size="sm">
          {saving ? t('saving') : t('save')}
        </Button>
      </div>
    </div>
  );
}
