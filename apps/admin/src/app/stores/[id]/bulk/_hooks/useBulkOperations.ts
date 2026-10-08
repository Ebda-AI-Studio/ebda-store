'use client';

import { useCallback, useState } from 'react';
import { apiPost, apiGet, apiFetch } from '../../../../../lib/api';
import type {
  ExportFilters,
  FileKind,
  ImportJob,
  ImportOptions,
  ImportPreview,
  ImportResult,
} from '../_components/types';

interface UseBulkOperationsArgs {
  storeId: string;
  networkErrorMessage: string;
  importFailedMessage: string;
}

const POLL_INTERVAL_MS = 1500;
const POLL_MAX_ATTEMPTS = 600; // 15 min cap

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Request body shared by the preview and the real import, so what is previewed is what is imported. */
const buildBody = (args: {
  fileKind: FileKind;
  csvContent: string;
  xlsxBase64: string;
  options: ImportOptions;
}) =>
  args.fileKind === 'xlsx'
    ? {
        xlsxBase64: args.xlsxBase64,
        options: {
          updateExisting: args.options.updateExisting,
          skuPrefix: args.options.skuPrefix.trim() || undefined,
          defaultInventory: args.options.defaultInventory,
          defaultStatus: args.options.defaultStatus,
          trackInventory: args.options.trackInventory,
        },
      }
    : { csvData: args.csvContent, options: { updateExisting: args.options.updateExisting } };

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
  const [importProgress, setImportProgress] = useState<ImportJob | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

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

  /** Dry run: the server parses the file and returns what WOULD be imported. Nothing is saved. */
  const previewFile = useCallback(
    async (args: {
      fileKind: FileKind;
      csvContent: string;
      xlsxBase64: string;
      options: ImportOptions;
    }) => {
      if (args.fileKind === 'xlsx' ? !args.xlsxBase64 : !args.csvContent) return;
      setIsPreviewing(true);
      setPreview(null);
      setPreviewError(null);
      try {
        const res = await apiPost<{ preview: ImportPreview }>(
          `/api/v1/stores/${storeId}/bulk/import-preview`,
          buildBody(args)
        );
        if (res.data) setPreview(res.data.preview);
        else setPreviewError(res.error?.message || importFailedMessage);
      } catch {
        setPreviewError(networkErrorMessage);
      } finally {
        setIsPreviewing(false);
      }
    },
    [storeId, importFailedMessage, networkErrorMessage]
  );

  const clearPreview = useCallback(() => {
    setPreview(null);
    setPreviewError(null);
  }, []);

  const importFile = useCallback(
    async (args: {
      fileKind: FileKind;
      csvContent: string;
      xlsxBase64: string;
      options: ImportOptions;
    }) => {
      const { fileKind, csvContent, xlsxBase64 } = args;
      if (fileKind === 'xlsx' ? !xlsxBase64 : !csvContent) return;

      setIsImporting(true);
      setPreview(null);
      setImportResult(null);
      setImportProgress(null);

      try {
        const isXlsx = fileKind === 'xlsx';
        const endpoint = isXlsx
          ? `/api/v1/stores/${storeId}/bulk/import-xlsx`
          : `/api/v1/stores/${storeId}/bulk/import`;
        const body = buildBody(args);

        const enqueue = await apiPost<{ job: ImportJob }>(endpoint, body);

        if (!enqueue.data) {
          setImportResult({
            total: 0,
            created: 0,
            updated: 0,
            failed: 1,
            errors: [{ row: 0, error: enqueue.error?.message || importFailedMessage }],
          });
          return;
        }

        const jobId = enqueue.data.job.id;
        for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
          await wait(POLL_INTERVAL_MS);
          const poll = await apiGet<{ job: ImportJob }>(
            `/api/v1/stores/${storeId}/bulk/import-jobs/${jobId}`
          );
          if (!poll.data) continue;

          setImportProgress(poll.data.job);
          const status = poll.data.job.status;
          if (status === 'completed' || status === 'failed') {
            const job = poll.data.job;
            setImportResult({
              total: job.total,
              created: job.created,
              updated: job.updated,
              failed: status === 'failed' && job.errorMessage ? job.failed + 1 : job.failed,
              errors:
                status === 'failed' && job.errorMessage
                  ? [{ row: 0, error: job.errorMessage }, ...(job.errors ?? [])]
                  : (job.errors ?? []),
            });
            return;
          }
        }

        setImportResult({
          total: 0,
          created: 0,
          updated: 0,
          failed: 1,
          errors: [{ row: 0, error: importFailedMessage }],
        });
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

  const exportProductsXlsx = useCallback(
    async (filters: ExportFilters) => {
      setIsExporting(true);

      try {
        const queryParams = new URLSearchParams();
        if (filters.status) queryParams.append('status', filters.status);
        if (filters.search) queryParams.append('search', filters.search);
        if (filters.includeDeleted) queryParams.append('includeDeleted', 'true');

        const response = await apiFetch(
          `/api/v1/stores/${storeId}/bulk/export.xlsx?${queryParams}`
        );

        if (response.ok) {
          const blob = await response.blob();
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `products-${storeId}-${new Date().toISOString().slice(0, 10)}.xlsx`;
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          document.body.removeChild(a);
        }
      } catch (error) {
        console.error('Failed to export products as xlsx:', error);
      } finally {
        setIsExporting(false);
      }
    },
    [storeId]
  );

  const clearImportResult = useCallback(() => {
    setImportResult(null);
    setImportProgress(null);
  }, []);

  return {
    isImporting,
    isExporting,
    importResult,
    importProgress,
    downloadTemplate,
    importFile,
    preview,
    isPreviewing,
    previewError,
    previewFile,
    clearPreview,
    exportProducts,
    exportProductsXlsx,
    clearImportResult,
  };
}
