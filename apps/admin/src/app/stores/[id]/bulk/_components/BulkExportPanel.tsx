'use client';

import { useState } from 'react';
import { Input, Label } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import type { ExportFilters } from './types';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface BulkExportPanelProps {
  isExporting: boolean;
  onExport: (filters: ExportFilters) => Promise<void> | void;
  onExportXlsx: (filters: ExportFilters) => Promise<void> | void;
}

const INFO_KEYS = ['allFields', 'commaSeparated', 'reImport', 'pricesInFils'] as const;

/**
 * Export tab content: filter form (status/search/includeDeleted), the
 * export button, and the static informational panel that explains the
 * output format.
 */
export function BulkExportPanel({ isExporting, onExport, onExportXlsx }: BulkExportPanelProps) {
  const t = useT('bulk.export');

  const [filters, setFilters] = useState<ExportFilters>({
    status: '',
    search: '',
    includeDeleted: false,
  });

  return (
    <div className="space-y-6">
      {/* Export Options */}
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <h3 className="font-semibold text-foreground mb-4">{t('optionsTitle')}</h3>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label htmlFor="exportStatus">{t('statusLabel')}</Label>
            <select
              id="exportStatus"
              value={filters.status}
              onChange={e => setFilters(prev => ({ ...prev, status: e.target.value }))}
              className={`${FIELD_CLASSES} mt-1`}
            >
              <option value="">{t('statusAll')}</option>
              <option value="active">{t('statusActive')}</option>
              <option value="draft">{t('statusDraft')}</option>
              <option value="archived">{t('statusArchived')}</option>
            </select>
          </div>

          <div>
            <Label htmlFor="exportSearch">{t('searchLabel')}</Label>
            <Input
              id="exportSearch"
              value={filters.search}
              onChange={e => setFilters(prev => ({ ...prev, search: e.target.value }))}
              placeholder={t('searchPlaceholder')}
              className="mt-1"
            />
          </div>

          <div className="flex items-end">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="includeDeleted"
                checked={filters.includeDeleted}
                onChange={e => setFilters(prev => ({ ...prev, includeDeleted: e.target.checked }))}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
              />
              <Label htmlFor="includeDeleted" className="text-sm font-normal">
                {t('includeDeleted')}
              </Label>
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-2">
          <Button onClick={() => onExport(filters)} disabled={isExporting}>
            {isExporting ? (
              <span className="inline-flex items-center gap-2">
                <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                {t('exporting')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-2">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                  />
                </svg>
                {t('exportButton')}
              </span>
            )}
          </Button>
          <Button variant="outline" onClick={() => onExportXlsx(filters)} disabled={isExporting}>
            {isExporting ? (
              <span className="inline-flex items-center gap-2">
                <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                {t('exportingXlsx')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-2">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                {t('exportXlsx')}
              </span>
            )}
          </Button>
        </div>
      </div>

      {/* Export Info */}
      <div className="rounded-xl border bg-muted p-6">
        <h3 className="font-semibold text-foreground">{t('infoTitle')}</h3>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          {INFO_KEYS.map(key => (
            <li key={key} className="flex items-start gap-2">
              <svg
                className="h-5 w-5 text-success flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              <span>{t(`info.${key}`)}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
