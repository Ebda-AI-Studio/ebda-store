'use client';

import { useState } from 'react';
import { Button } from '@force/ui';
import { apiPut } from '../../../lib/api';
import { useT } from '@/i18n/useT';
import { TEMPLATE_IDS, type TemplateId } from './types';

// The same five storefront templates as the Template settings page
// (stores/[id]/template). Preview gradients mirror that page.
const PREVIEW: Record<TemplateId, string> = {
  modern: 'from-primary to-primary/90',
  classic: 'from-amber-700 to-amber-800',
  minimal: 'from-neutral-800 to-neutral-900',
  bold: 'from-purple-500 to-purple-600',
  elegant: 'from-rose-500 to-rose-600',
};

export function TemplateStep({
  storeId,
  initial,
  onBack,
  onDone,
}: {
  storeId: string;
  initial: TemplateId;
  onBack: () => void;
  onDone: (template: TemplateId) => void;
}) {
  const t = useT('onboarding.flow.template');
  const tFlow = useT('onboarding.flow');
  const [selected, setSelected] = useState<TemplateId>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleNext() {
    setError('');
    if (selected !== initial) {
      setSaving(true);
      const { error: apiError } = await apiPut(`/api/v1/stores/${storeId}/template`, {
        template: selected,
      });
      setSaving(false);
      if (apiError) {
        setError(t('saveFailed'));
        return;
      }
    }
    onDone(selected);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      {error && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
          {error}
        </div>
      )}
      <div
        role="radiogroup"
        aria-label={t('title')}
        className="grid grid-cols-2 gap-3 md:grid-cols-3"
      >
        {TEMPLATE_IDS.map(id => {
          const on = selected === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setSelected(id)}
              className={`rounded-lg border p-2 text-start transition-colors ${
                on ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:bg-muted/40'
              }`}
            >
              <span className={`block h-16 rounded-md bg-gradient-to-br ${PREVIEW[id]}`} />
              <span className="mt-2 block text-sm font-medium text-foreground">
                {t(id)}
                {on && <span className="ms-2 text-xs text-primary-ink">{t('selected')}</span>}
              </span>
              <span className="block text-xs text-muted-foreground">{t(`${id}Desc`)}</span>
            </button>
          );
        })}
      </div>
      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onBack}>
          {tFlow('back')}
        </Button>
        <Button type="button" className="flex-1" disabled={saving} onClick={handleNext}>
          {tFlow('next')}
        </Button>
      </div>
    </div>
  );
}
