'use client';

/**
 * Change the look from inside the editor (Task 9, Ruling EP-3). Pick a look, choose whether the
 * merchant's colour and font edits stay, preview: the proposed page renders in the SAME canvas, over the
 * merchant's own content, with a plain list of what changes. Nothing is written until Apply, and Apply is
 * refused by the server when the page moved since the preview.
 */
import { Button } from '@/components/ui/Button';
import { useState } from 'react';
import { useLocale } from 'next-intl';
import { getLook, getSectionDefinition, type LookChangeReport, type LookId } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { LookPicker } from '../../../../../components/looks/LookPicker';

export type LookDesignChoice = 'keep' | 'reset';

export interface LookPreviewResult {
  look: string;
  report: LookChangeReport;
  revisionToken: string;
  willPublish: boolean;
  skinChange: { from: string; to: string } | null;
}

export function LookSwitchPane({
  currentLook,
  preview,
  busy,
  onPreview,
  onApply,
  onCancelPreview,
}: {
  currentLook: LookId | null;
  /** The proposal being shown in the canvas, if any. */
  preview: LookPreviewResult | null;
  busy: 'preview' | 'apply' | null;
  onPreview: (lookId: string, design: LookDesignChoice) => void;
  onApply: () => void;
  onCancelPreview: () => void;
}) {
  const t = useT('builder.look');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const [picked, setPicked] = useState<LookId | null>(currentLook);
  const [design, setDesign] = useState<LookDesignChoice>('keep');
  const name = (id: string | null) => {
    const l = getLook(id);
    return l ? l.name[locale] : '';
  };
  const typeName = (type: string) => {
    const d = getSectionDefinition(type);
    return d ? (locale === 'ar' ? d.labelAr : d.labelEn) : type;
  };
  const list = (xs: Array<{ type: string }>) =>
    [...new Set(xs.map(x => typeName(x.type)))].join(locale === 'ar' ? '، ' : ', ');

  return (
    <div className="flex h-full flex-col" data-testid="look-switch-pane">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('intro')}</p>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {currentLook && (
          <p className="text-xs text-muted-foreground">
            {t('current')}:{' '}
            <span className="font-semibold text-foreground">{name(currentLook)}</span>
          </p>
        )}
        {preview ? (
          <section
            aria-label={t('reportTitle')}
            data-testid="look-report"
            className="space-y-2 text-sm"
          >
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('reportTitle')}
            </h3>
            <ul className="list-disc space-y-1 ps-5">
              <li>{t('kept', { count: preview.report.keptContent.length })}</li>
              {preview.report.designChanged.length > 0 && (
                <li>{t('designChanged', { count: preview.report.designChanged.length })}</li>
              )}
              {preview.report.added.length > 0 && (
                <li>{t('added', { names: list(preview.report.added) })}</li>
              )}
              {preview.report.droppedFromDraft.length > 0 && (
                <li>{t('dropped', { names: list(preview.report.droppedFromDraft) })}</li>
              )}
              {preview.report.themeKeysReset.length > 0 && <li>{t('themeReset')}</li>}
            </ul>
            {preview.skinChange && <p className="text-xs text-muted-foreground">{t('skin')}</p>}
            <p className="text-xs text-muted-foreground">
              {preview.willPublish ? t('publishNote') : t('draftNote')}
            </p>
            <div className="flex gap-2 pt-1">
              <Button
                size="sm"
                type="button"
                onClick={onApply}
                disabled={busy !== null}
                className="font-semibold"
                data-testid="look-apply"
              >
                {busy === 'apply' ? t('applying') : t('apply')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={onCancelPreview}
                disabled={busy !== null}
                data-testid="look-keep-editing"
              >
                {t('keepEditing')}
              </Button>
            </div>
          </section>
        ) : (
          <>
            <LookPicker value={picked} onChange={setPicked} locale={locale} />
            <fieldset className="space-y-1" disabled={busy !== null}>
              <legend className="mb-1 text-xs font-semibold text-foreground">{t('design')}</legend>
              {(['keep', 'reset'] as const).map(k => (
                <label
                  key={k}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"
                >
                  <input
                    type="radio"
                    name="look-design"
                    checked={design === k}
                    onChange={() => setDesign(k)}
                  />
                  <span>{t(k)}</span>
                </label>
              ))}
            </fieldset>
            <Button
              size="sm"
              type="button"
              onClick={() => picked && onPreview(picked, design)}
              disabled={!picked || picked === currentLook || busy !== null}
              className="font-semibold"
              data-testid="look-preview"
            >
              {busy === 'preview' ? t('previewing') : t('preview')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
