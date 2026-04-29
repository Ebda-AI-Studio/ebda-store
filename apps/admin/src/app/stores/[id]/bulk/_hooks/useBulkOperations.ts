'use client';

import { useCallback, useState } from 'react';
import { apiPost, apiFetch } from '../../../../../lib/api';
import type { ExportFilters, FileKind, ImportOptions, ImportResult } from '../_components/types';

interface UseBulkOperationsArgs {
  storeId: string;
  networkErrorMessage: string;
  importFailedMessage: string;
}

/**
 * Groups the import/export network calls so the page component can
 * stay focused on composition and the slices stay purely presentational.
 */
export function useBulkOperations({
  storeId,
  networkErrorMessage,
  importFailedMessage,
}: UseBulkOperationsArgs) {
  const [isImporting, setIsImporting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  const downloadTemplate = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/v1/stores/${storeId}/bulk/template`);

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'product_import_template.csv';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }
    } catch (error) {
      console.error('Failed to download template:', error);
    }
  }, [storeId]);

  const importFile = useCallback(
    async (args: {
      fileKind: FileKind;
      csvContent: string;
      xlsxBase64: string;
      options: ImportOptions;
    }) => {
      const { fileKind, csvContent, xlsxBase64, options } = args;
      if (fileKind === 'xlsx' ? !xlsxBase64 : !csvContent) return;

      setIsImporting(true);
      setImportResult(null);

      try {
        const isXlsx = fileKind === 'xlsx';
        const endpoint = isXlsx
          ? `/api/v1/stores/${storeId}/bulk/import-xlsx`
          : `/api/v1/stores/${storeId}/bulk/import`;
        const body = isXlsx
          ? {
              xlsxBase64,
              options: {
                updateExisting: options.updateExisting,
                skuPrefix: options.skuPrefix.trim() || undefined,
                defaultInventory: options.defaultInventory,
                defaultStatus: options.defaultStatus,
                trackInventory: options.trackInventory,
              },
            }
          : { csvData: csvContent, options: { updateExisting: options.updateExisting } };

        const { data, error } = await apiPost<{ result: ImportResult }>(endpoint, body);

        if (data) {
          setImportResult(data.result);
        } else {
          setImportResult({
            total: 0,
            created: 0,
            updated: 0,
            failed: 1,
            errors: [{ row: 0, error: error?.message || importFailedMessage }],
          });
        }
      } catch {
        setImportResult({
          total: 0,
          created: 0,
          updated: 0,
          failed: 1,
          errors: [{ row: 0, error: networkErrorMessage }],
        });
      } finally {
        setIsImporting(false);
      }
    },
    [storeId, importFailedMessage, networkErrorMessage]
  );

  const exportProducts = useCallback(
    async (filters: ExportFilters) => {
      setIsExporting(true);

      try {
        const queryParams = new URLSearchParams();
        if (filters.status) queryParams.append('status', filters.status);
        if (filters.search) queryParams.append('search', filters.search);
        if (filters.includeDeleted) queryParams.append('includeDeleted', 'true');

        const response = await apiFetch(`/api/v1/stores/${storeId}/bulk/export?${queryParams}`);

        if (response.ok) {
          const blob = await response.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `products_${storeId}_${Date.now()}.csv`;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          document.body.removeChild(a);
        }
      } catch (error) {
        console.error('Failed to export products:', error);
      } finally {
        setIsExporting(false);
      }
    },
    [storeId]
  );

  const clearImportResult = useCallback(() => setImportResult(null), []);

  return {
    isImporting,
    isExporting,
    importResult,
    downloadTemplate,
    importFile,
    exportProducts,
    clearImportResult,
  };
}
