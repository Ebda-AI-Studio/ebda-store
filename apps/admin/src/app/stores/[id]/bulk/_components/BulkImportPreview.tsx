'use client';

import { useLocale } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { formatMoney } from '@ebda/shared';
import { useT } from '@/i18n/useT';
import type { ImportPreview } from './types';

interface BulkImportPreviewProps {
  preview: ImportPreview;
  isImporting: boolean;
  onConfirm: () => void;
  onBack: () => void;
}

const KNOWN_PRICE_CODES = new Set([
  'PRICE_REQUIRED',
  'PRICE_INVALID',
  'PRICE_NEGATIVE',
  'PRICE_AMBIGUOUS_DECIMALS',
  'PRICE_TOO_MANY_DECIMALS',
]);

/**
 * Dry-run result: every price is shown as EGP (the server returns piastres) so
 * the merchant sees what will be written before confirming. Rows with errors
 * are listed and skipped by the import.
 */
export function BulkImportPreview({
  preview,
  isImporting,
  onConfirm,
  onBack,
}: BulkImportPreviewProps) {
  const t = useT('bulk.preview');
  const tPrice = useT('bulk.priceErrors');
  const locale = useLocale() === 'ar' ? 'ar' : 'en';
  const money = (minor: number | null) =>
    minor === null ? '' : formatMoney(minor, locale, { fixedDecimals: true });

  return (
    <div className="rounded-md border bg-card p-6 shadow-sm space-y-4">
      <h3 className="font-semibold text-foreground">{t('title')}</h3>
      <p className="text-sm text-muted-foreground">
        {t('summary', {
          valid: preview.validRows,
          total: preview.totalRows,
          invalid: preview.invalidRows,
        })}
      </p>

      {preview.warnings.map(w => (
        <div
          key={w.code}
          role="alert"
          className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-ink"
        >
          {t('warnPiastres', {
            file: money(w.fileMedianMinor),
            store: money(w.storeMedianMinor),
          })}
        </div>
      ))}

      <div className="max-h-80 overflow-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-start">{t('colRow')}</th>
              <th className="px-3 py-2 text-start">{t('colName')}</th>
              <th className="px-3 py-2 text-start">{t('colSku')}</th>
              <th className="px-3 py-2 text-end">{t('colPrice')}</th>
              <th className="px-3 py-2 text-end">{t('colCompare')}</th>
              <th className="px-3 py-2 text-end">{t('colCost')}</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map(r => (
              <tr
                key={r.row}
                className={r.error ? 'bg-destructive/10' : 'border-t'}
                aria-invalid={r.error ? true : undefined}
              >
                <td className="px-3 py-2 tabular-nums">{r.row}</td>
                <td className="px-3 py-2">
                  {r.name || (r.parentSku ? t('variantOf', { sku: r.parentSku }) : '')}
                </td>
                <td className="px-3 py-2">{r.sku}</td>
                <td className="px-3 py-2 text-end tabular-nums" dir="ltr">
                  {money(r.price)}
                </td>
                <td className="px-3 py-2 text-end tabular-nums" dir="ltr">
                  {money(r.compareAtPrice)}
                </td>
                <td className="px-3 py-2 text-end tabular-nums" dir="ltr">
                  {money(r.costPrice)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {preview.truncated && (
        <p className="text-xs text-muted-foreground">
          {t('truncated', { shown: preview.rows.length })}
        </p>
      )}

      {preview.errors.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-destructive-ink mb-2">{t('errorsHeading')}</h4>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-destructive/20 bg-destructive/10">
            {preview.errors.map((e, i) => (
              <div
                key={`${e.row}-${i}`}
                className="px-4 py-2 border-b border-destructive/20 last:border-0 text-sm text-destructive-ink"
              >
                <span className="font-medium">
                  {t('errorRow', { row: e.row, column: e.column ?? '' })}
                </span>{' '}
                {e.code && KNOWN_PRICE_CODES.has(e.code) ? tPrice(e.code) : e.error}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2">
        <Button
          onClick={onConfirm}
          disabled={isImporting || preview.validRows === 0}
          className="flex-1"
        >
          {t('confirm', { count: preview.validRows })}
        </Button>
        <Button variant="outline" onClick={onBack} disabled={isImporting}>
          {t('back')}
        </Button>
      </div>
      {preview.validRows === 0 && (
        <p className="text-sm text-destructive-ink">{t('noValidRows')}</p>
      )}
    </div>
  );
}
