'use client';

/**
 * What applying the previewed look would change (Task 9, Ruling EP-3), in the right pane while the proposal is
 * shown in the canvas: a plain list, then Apply or Keep editing. Choosing the look happens in the template gallery
 * (`TemplateGallery`); nothing is written until Apply, and Apply is refused by the server when the page moved
 * since the preview.
 */
import { Button } from '@/components/ui/Button';
import { useLocale } from 'next-intl';
import { getSectionDefinition, type LookChangeReport } from '@ebda/shared';
import { useT } from '@/i18n/useT';

export type LookDesignChoice = 'keep' | 'reset';

export interface LookPreviewResult {
  look: string;
  report: LookChangeReport;
  revisionToken: string;
  willPublish: boolean;
  skinChange: { from: string; to: string } | null;
}

export function LookSwitchPane({
  preview,
  busy,
  onApply,
  onCancelPreview,
}: {
  /** The proposal being shown in the canvas. */
  preview: LookPreviewResult;
  busy: 'preview' | 'apply' | null;
  onApply: () => void;
  onCancelPreview: () => void;
}) {
  const t = useT('builder.look');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const typeName = (type: string) => {
    const d = getSectionDefinition(type);
    return d ? (locale === 'ar' ? d.labelAr : d.labelEn) : type;
  };
  const list = (xs: Array<{ type: string }>) =>
    [...new Set(xs.map(x => typeName(x.type)))].join(locale === 'ar' ? '، ' : ', ');

  return (
    <div className="flex h-full flex-col" data-testid="look-report-pane">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t('reportTitle')}</h2>
      </div>
      <section
        aria-label={t('reportTitle')}
        data-testid="look-report"
        className="flex-1 space-y-3 overflow-y-auto p-4 text-sm"
      >
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
        {preview.skinChange && <p className="text-xs text-muted-ink">{t('skin')}</p>}
        <p className="text-xs text-muted-ink">
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
    </div>
  );
}
