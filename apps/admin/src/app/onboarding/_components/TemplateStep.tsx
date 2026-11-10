'use client';

import { useState } from 'react';
import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { getLook, type LookId } from '@ebda/shared';
import { apiPut } from '../../../lib/api';
import { useT } from '@/i18n/useT';
import { LookPicker } from '../../../components/looks/LookPicker';

/**
 * Onboarding "pick a look". The look list lives in @ebda/shared (`LOOKS`), rendered by
 * `LookPicker`; this step only saves the choice. A brand-new store has nothing to lose, so the
 * look's design tokens replace the defaults (`design: 'reset'`).
 */
export function TemplateStep({
  storeId,
  initial,
  lookFailed = false,
  onBack,
  onDone,
}: {
  storeId: string;
  initial: string | null;
  /** The store was created but the look chosen at creation did not apply: ask for it again. */
  lookFailed?: boolean;
  onBack: () => void;
  onDone: (look: string | null) => void;
}) {
  const t = useT('onboarding.flow.template');
  const tFlow = useT('onboarding.flow');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const initialLook = getLook(initial)?.id ?? null;
  const [selected, setSelected] = useState<LookId | null>(initialLook);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleNext() {
    setError('');
    // Nothing picked (or unchanged): keep the store as it is, never send an empty choice.
    if (selected && selected !== initialLook) {
      setSaving(true);
      try {
        const { error: apiError } = await apiPut(`/api/v1/stores/${storeId}/look`, {
          lookId: selected,
          design: 'reset',
        });
        if (apiError) {
          setError(t('saveFailed'));
          return;
        }
      } catch {
        setError(t('saveFailed'));
        return;
      } finally {
        setSaving(false);
      }
    }
    onDone(selected ?? initial);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      {lookFailed && !initialLook && (
        <div role="status" className="rounded-lg bg-muted p-3 text-sm text-foreground">
          {t('lookNotApplied')}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive-ink">
          {error}
        </div>
      )}
      <LookPicker value={selected} onChange={setSelected} locale={locale} />
      <p className="text-xs leading-relaxed text-muted-foreground">{t('previewNote')}</p>
      <div className="flex gap-3">
        <Button type="button" variant="outline" onClick={onBack}>
          {tFlow('back')}
        </Button>
        <Button
          type="button"
          className="flex-1"
          disabled={saving}
          aria-busy={saving}
          onClick={handleNext}
        >
          {saving ? t('saving') : tFlow('next')}
        </Button>
      </div>
    </div>
  );
}
