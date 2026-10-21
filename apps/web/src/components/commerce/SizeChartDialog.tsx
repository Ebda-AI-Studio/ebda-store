'use client';

/**
 * Size guide (B0 Task 9). `SizeChartDialog` is one quiet text button ("دليل المقاسات", a ruler
 * icon, ink/muted tokens, no accent) that opens the chart in a native <dialog>: Esc and a
 * backdrop click close it, the table scrolls sideways INSIDE the dialog with the size column
 * sticky, and the caption names the unit. Nothing moves (the B0 taste bar keeps motion to three
 * moments), and it renders nothing at all without a chart.
 *
 * Text falls back across languages (review focus #3): an Arabic-only chart shows its Arabic
 * headers on the English storefront, never a blank cell. Measurement digits follow the store's
 * numeral setting through `localize`.
 */
import { useEffect, useId, useRef, type MouseEvent } from 'react';
import {
  sizeChartColumnLabel,
  sizeChartName,
  sizeChartNote,
  type PublicSizeChart,
} from '@ebda/shared';
import { useLanguage } from '@/contexts/LanguageContext';
import { useNumerals } from '@/hooks/useNumerals';

function RulerIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3 15.5 15.5 3 21 8.5 8.5 21z" />
      <path d="m7 12 1.5 1.5M10 9l2 2M13 6l1.5 1.5" />
    </svg>
  );
}

/** The chart as a table: localized headers, sticky first column, unit in the caption. */
export function SizeChartTable({ chart }: { chart: PublicSizeChart }) {
  const { language, t } = useLanguage();
  const { localize } = useNumerals();
  const lang = language === 'ar' ? 'ar' : 'en';
  const note = sizeChartNote(chart, lang);
  const unit =
    chart.unit === 'in'
      ? t('Measurements in inches', 'القياسات بالبوصة')
      : t('Measurements in cm', 'القياسات بالسنتيمتر');
  return (
    <div>
      {/* A scrollable region must be keyboard-focusable (axe scrollable-region-focusable). */}
      <div
        className="overflow-x-auto overscroll-x-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
        role="region"
        aria-label={unit}
        tabIndex={0}
      >
        <table className="w-full border-collapse text-sm">
          <caption className="caption-bottom pt-3 text-start text-xs text-muted-foreground">
            {unit}
          </caption>
          <thead>
            <tr className="border-b border-border">
              {chart.columns.map((col, i) => (
                <th
                  key={i}
                  scope="col"
                  className={`whitespace-nowrap px-3 py-2 text-start font-medium text-muted-foreground ${
                    i === 0 ? 'sticky start-0 z-[1] bg-background' : ''
                  }`}
                >
                  {sizeChartColumnLabel(col, lang)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {chart.rows.map((row, r) => (
              <tr key={r} className="border-b border-border last:border-0">
                {row.map((cell, i) =>
                  i === 0 ? (
                    <th
                      key={i}
                      scope="row"
                      className="sticky start-0 z-[1] whitespace-nowrap bg-background px-3 py-2 text-start font-medium text-foreground"
                    >
                      {localize(cell)}
                    </th>
                  ) : (
                    <td
                      key={i}
                      className="whitespace-nowrap px-3 py-2 tabular-nums text-foreground"
                    >
                      {localize(cell)}
                    </td>
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

export function SizeChartDialog({
  chart,
  className = '',
}: {
  chart: PublicSizeChart | null | undefined;
  className?: string;
}) {
  const { language, t } = useLanguage();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // A modal <dialog> does not stop the page behind it scrolling on iOS: lock html/body while it
  // is open and put back exactly what was there before. `unlock` is idempotent and runs on every
  // way out (the dialog's close event covers Esc and backdrop, plus unmount).
  const restore = useRef<(() => void) | null>(null);
  const unlock = () => {
    restore.current?.();
    restore.current = null;
  };
  useEffect(
    () => () => {
      restore.current?.();
      restore.current = null;
    },
    []
  );
  if (!chart) return null;
  const lang = language === 'ar' ? 'ar' : 'en';

  const lock = () => {
    if (restore.current) return;
    const { documentElement: html, body } = document;
    const prev = [html.style.overflow, body.style.overflow];
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    restore.current = () => {
      html.style.overflow = prev[0];
      body.style.overflow = prev[1];
    };
  };
  const open = () => {
    const d = ref.current;
    if (!d || d.open) return;
    if (typeof d.showModal === 'function') d.showModal();
    else d.setAttribute('open', '');
    lock();
  };
  const close = () => {
    const d = ref.current;
    if (!d) return;
    if (typeof d.close === 'function') d.close();
    else d.removeAttribute('open');
    unlock();
  };
  // A click on the dialog element itself (not its content box) is a click on the backdrop.
  const onDialogClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) close();
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        className={`inline-flex min-h-[44px] items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
      >
        <RulerIcon />
        {t('Size guide', 'دليل المقاسات')}
      </button>
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        onClick={onDialogClick}
        onClose={unlock}
        className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-[var(--radius)] border border-border bg-background p-0 text-foreground shadow-xl backdrop:bg-foreground/40"
      >
        <div className="p-5">
          <div className="mb-3 flex items-start justify-between gap-3">
            <h2 id={titleId} className="text-base font-semibold text-foreground">
              {sizeChartName(chart, lang)}
            </h2>
            <button
              type="button"
              onClick={close}
              aria-label={t('Close', 'إغلاق')}
              className="-m-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <SizeChartTable chart={chart} />
        </div>
      </dialog>
    </>
  );
}
