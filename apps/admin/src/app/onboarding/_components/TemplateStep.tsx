'use client';

import { useState } from 'react';
import { Button } from '@force/ui';
import { apiPut } from '../../../lib/api';
import { useT } from '@/i18n/useT';
import { TEMPLATE_IDS, type TemplateId } from './types';

// Illustrative composition only; merchant imagery and palette remain configurable.
const PREVIEW: Record<TemplateId, string> = {
  modern: 'rounded-md',
  classic: 'rounded-none',
  minimal: 'rounded-sm',
  bold: 'rounded-lg',
  elegant: 'rounded-t-xl',
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
              <span
                aria-hidden="true"
                className={`block overflow-hidden border border-border bg-background p-2 ${PREVIEW[id]}`}
              >
                <span className="flex items-center justify-between border-b border-border pb-1.5">
                  <span className="h-1.5 w-7 rounded-sm bg-foreground/60" />
                  <span className="flex gap-1">
                    <span className="h-1 w-3 bg-muted-foreground/40" />
                    <span className="h-1 w-3 bg-muted-foreground/40" />
                  </span>
                </span>
                <span
                  className={`mt-2 flex h-12 items-center gap-2 bg-primary/10 p-2 ${id === 'minimal' ? 'justify-center' : ''}`}
                >
                  <span className="space-y-1">
                    <span className="block h-1.5 w-10 bg-primary/50" />
                    <span className="block h-1 w-7 bg-muted-foreground/40" />
                  </span>
                  {id !== 'minimal' && (
                    <span
                      className={`h-8 w-8 bg-primary/20 ${id === 'elegant' ? 'rounded-t-full' : 'rounded-sm'}`}
                    />
                  )}
                </span>
                <span
                  className={`mt-2 grid gap-1.5 ${id === 'bold' ? 'grid-cols-2' : 'grid-cols-3'}`}
                >
                  {[0, 1, 2].slice(0, id === 'bold' ? 2 : 3).map(n => (
                    <span key={n} className="h-7 rounded-sm bg-muted" />
                  ))}
                </span>
              </span>
              <span className="mt-2 block text-sm font-medium text-foreground">
                {t(id)}
                {on && <span className="ms-2 text-xs text-primary-ink">{t('selected')}</span>}
              </span>
              <span className="block text-xs text-muted-foreground">{t(`${id}Desc`)}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{t('previewNote')}</p>
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
