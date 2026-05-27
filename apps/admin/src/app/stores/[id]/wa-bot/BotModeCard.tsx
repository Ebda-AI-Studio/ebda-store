'use client';

/**
 * BotModeCard — lets merchant choose between legacy chat bot, native Meta
 * Commerce Catalog, or native catalog + Gemini AI Agent.
 *
 * Saves via PUT /api/v1/stores/:id/integrations/wbs { botMode }.
 */

import { useState } from 'react';
import { Button, useToast } from '@force/ui';
import { apiPut } from '../../../../lib/api';
import type { BotMode } from '../../../../lib/types/wa-bot';
import { BOT_MODE_LABELS } from '../../../../lib/types/wa-bot';

const BOT_MODE_DESCRIPTIONS: Record<BotMode, string> = {
  legacy_chat: 'Customers browse and order via text messages. No Meta Commerce account required.',
  native_catalog:
    'WhatsApp opens your Meta Commerce catalog directly. Requires a configured Meta catalog ID below.',
  native_catalog_with_gemini_agent:
    'Native catalog + Gemini AI answers customer questions and assists with ordering.',
};

interface BotModeCardProps {
  storeId: string;
  initialMode: BotMode;
}

export function BotModeCard({ storeId, initialMode }: BotModeCardProps) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [mode, setMode] = useState<BotMode>(initialMode);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    const { error } = await apiPut(`/api/v1/stores/${storeId}/integrations/wbs`, {
      botMode: mode,
    });
    setSaving(false);
    if (error) {
      toastError(error.message || 'Failed to save bot mode');
    } else {
      toastSuccess('Bot mode saved');
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-base font-semibold text-foreground mb-1">Bot Mode</h2>
      <p className="text-sm text-muted-foreground mb-5">
        Choose how the WhatsApp bot handles customer product browsing and ordering.
      </p>

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
              <p className="text-sm font-medium text-foreground">{BOT_MODE_LABELS[key]}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{BOT_MODE_DESCRIPTIONS[key]}</p>
            </div>
          </label>
        ))}
      </div>

      <div className="mt-5 flex justify-end">
        <Button onClick={handleSave} disabled={saving || mode === initialMode} size="sm">
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
