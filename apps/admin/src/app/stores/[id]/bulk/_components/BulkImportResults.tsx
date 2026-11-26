'use client';

import { useT } from '@/i18n/useT';
import type { ImportResult } from './types';

interface BulkImportResultsProps {
  result: ImportResult;
  onViewProducts: () => void;
}

/**
 * Displays the import summary: four KPI cards, row-level errors (if any),
 * and a success banner with a link to the products list when rows changed.
 */
export function BulkImportResults({ result, onViewProducts }: BulkImportResultsProps) {
  const t = useT('bulk.results');
  const hasChanges = result.created > 0 || result.updated > 0;

  return (
    <div className="rounded-md border bg-card p-6 shadow-sm">
      <h3 className="font-semibold text-foreground mb-4">{t('title')}</h3>

      <div className="grid gap-4 sm:grid-cols-4 mb-4">
        <div className="text-center p-4 bg-muted rounded-lg">
          <p className="text-2xl font-bold text-foreground">{result.total}</p>
          <p className="text-xs text-muted-foreground">{t('totalRows')}</p>
        </div>
        <div className="text-center p-4 bg-success/10 rounded-lg">
          <p className="text-2xl font-bold text-success-ink">{result.created}</p>
          <p className="text-xs text-muted-foreground">{t('created')}</p>
        </div>
        <div className="text-center p-4 bg-info/5 rounded-lg">
          <p className="text-2xl font-bold text-info-ink">{result.updated}</p>
          <p className="text-xs text-muted-foreground">{t('updated')}</p>
        </div>
        <div className="text-center p-4 bg-destructive/10 rounded-lg">
          <p className="text-2xl font-bold text-destructive-ink">{result.failed}</p>
          <p className="text-xs text-muted-foreground">{t('failed')}</p>
        </div>
      </div>

      {result.errors.length > 0 && (
        <div className="mt-4">
          <h4 className="text-sm font-medium text-destructive-ink mb-2">{t('errorsHeading')}</h4>
          <div className="max-h-48 overflow-y-auto rounded-lg border border-destructive/20 bg-destructive/10">
            {result.errors.map((error, i) => (
              <div
                key={i}
                className="px-4 py-2 border-b border-destructive/20 last:border-0 text-sm"
              >
                <span className="font-medium text-destructive-ink">
                  {t('rowLabel', { row: error.row })}
                </span>{' '}
                <span className="text-destructive-ink">{error.error}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasChanges && (
        <div className="mt-4 p-3 bg-success/10 rounded-lg text-center">
          <p className="text-sm text-success-ink">
            {t.rich('successMessage', {
              link: chunks => (
                <button
                  type="button"
                  onClick={onViewProducts}
                  className="underline hover:no-underline"
                >
                  {chunks}
                </button>
              ),
            })}
          </p>
        </div>
      )}
    </div>
  );
}
