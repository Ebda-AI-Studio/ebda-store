'use client';

import {
  contrastRatioOrNull,
  pickReadableForeground,
  readVerdict,
  resolveColorForMeasure,
} from '@ebda/shared';
import type { StoreTheme } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import { Disclosure } from './ui/Disclosure';

interface ColorContrastPreviewProps {
  /** Current ColorField value: hex, 'token:<name>', or empty. */
  bg: string | undefined;
  /** Store theme to resolve tokens against. */
  theme: StoreTheme | undefined;
  /** Optional merchant-picked foreground from the corresponding typography zone. */
  pickedFg?: string;
  /** Optional name of the colour shown in the heading line (plain words, never CSS). */
  name?: string;
}

/**
 * A real mini preview of a heading, a line under it, body text and a button on the chosen background, with a
 * plain verdict ("Easy to read"). The number and the hex live under Details. When the colour cannot be resolved the
 * preview says so instead of inventing a ratio (Ruling EPUX-2): a fake 1.0 : 1 used to be shown here.
 */
export function ColorContrastPreview({ bg, theme, pickedFg, name }: ColorContrastPreviewProps) {
  const t = useT('components.colorContrastPreview');
  const resolved = resolveColorForMeasure(bg, theme);
  if (!bg) return null;
  if (!resolved) {
    return (
      <p
        className="rounded-md border border-dashed border-border p-3 text-sm text-muted-ink"
        data-testid="contrast-unknown"
      >
        {t('cannotCheck')}
      </p>
    );
  }

  const pickedResolved = pickedFg ? resolveColorForMeasure(pickedFg, theme) : null;
  const fg = pickedResolved ?? pickReadableForeground(resolved) ?? '#000000';
  const ratio = contrastRatioOrNull(resolved, fg);
  const verdict = ratio === null ? null : readVerdict(ratio);
  const bad = pickedResolved !== null && verdict !== null && verdict !== 'easy';

  return (
    <div className="space-y-2" data-testid="contrast-preview">
      <div
        className="space-y-1 rounded-md border border-border p-3"
        style={{ backgroundColor: resolved, color: fg }}
      >
        <p className="text-base font-semibold">{t('preview.heading')}</p>
        <p className="text-sm">{t('preview.subtitle')}</p>
        <p className="text-sm">{t('preview.body')}</p>
        <span
          className="mt-1 inline-flex h-8 items-center rounded-md px-3 text-sm font-medium"
          style={{ backgroundColor: fg, color: resolved }}
        >
          {t('preview.button')}
        </span>
      </div>
      {verdict && (
        <p
          role="status"
          className={`flex items-center gap-2 text-sm ${verdict === 'easy' ? 'text-success-ink' : verdict === 'large' ? 'text-warning-ink' : 'text-destructive-ink'}`}
          data-verdict={verdict}
        >
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-current" />
          {t(`verdict.${verdict}`)}
          {bad ? ` · ${t('pickedTextWarning')}` : ''}
        </p>
      )}
      <Disclosure title={t('details')} testId="contrast-details">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-ink">
          {name && (
            <>
              <dt>{t('colourName')}</dt>
              <dd className="text-foreground">{name}</dd>
            </>
          )}
          <dt>{t('background')}</dt>
          <dd dir="ltr" className="text-foreground">
            {resolved}
          </dd>
          <dt>{t('text')}</dt>
          <dd dir="ltr" className="text-foreground">
            {fg}
          </dd>
          {ratio !== null && (
            <>
              <dt>{t('ratioLabel')}</dt>
              <dd dir="ltr" className="text-foreground">
                {t('ratio', { ratio: ratio.toFixed(1) })}
              </dd>
            </>
          )}
        </dl>
      </Disclosure>
    </div>
  );
}
