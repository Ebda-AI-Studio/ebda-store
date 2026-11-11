'use client';

import { useRef, useState } from 'react';
import { Input, Label } from '@ebda/ui';
import { Button } from '@/components/ui/Button';
import { useT } from '@/i18n/useT';
import type {
  DefaultStatus,
  FileKind,
  ImportJob,
  ImportOptions,
  ImportPreview,
  ImportResult,
} from './types';
import { BulkImportPreview } from './BulkImportPreview';
import { BulkImportResults } from './BulkImportResults';
import { FIELD_CLASSES } from '@/components/ui/tokens';

interface ImportArgs {
  fileKind: FileKind;
  csvContent: string;
  xlsxBase64: string;
  options: ImportOptions;
}

interface BulkImportWizardProps {
  isImporting: boolean;
  importResult: ImportResult | null;
  importProgress: ImportJob | null;
  onDownloadTemplate: () => void;
  preview: ImportPreview | null;
  isPreviewing: boolean;
  previewError: string | null;
  onPreview: (args: ImportArgs) => Promise<void> | void;
  onClearPreview: () => void;
  onImport: (args: ImportArgs) => Promise<void> | void;
  onClearResult: () => void;
  onViewProducts: () => void;
}

/**
 * Full import experience: instructions, CSV/XLSX uploader, advanced
 * XLSX options and the result summary. Owns the local file + option
 * state so the parent page stays composition-only.
 */
export function BulkImportWizard({
  isImporting,
  importResult,
  importProgress,
  preview,
  isPreviewing,
  previewError,
  onPreview,
  onClearPreview,
  onDownloadTemplate,
  onImport,
  onClearResult,
  onViewProducts,
}: BulkImportWizardProps) {
  const t = useT('bulk.import');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [csvContent, setCsvContent] = useState('');
  const [xlsxBase64, setXlsxBase64] = useState('');
  const [selectedFileName, setSelectedFileName] = useState('');
  const [fileKind, setFileKind] = useState<FileKind | null>(null);
  const [updateExisting, setUpdateExisting] = useState(true);
  const [skuPrefix, setSkuPrefix] = useState('');
  const [defaultInventory, setDefaultInventory] = useState(100);
  const [defaultStatus, setDefaultStatus] = useState<DefaultStatus>('active');
  const [trackInventory, setTrackInventory] = useState(false);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFileName(file.name);
    onClearPreview();
    const isXlsx = /\.xlsx$/i.test(file.name) || file.type.includes('sheet');

    if (isXlsx) {
      setFileKind('xlsx');
      setCsvContent('');
      const buf = await file.arrayBuffer();
      // Chunked base64 encode so we don't blow the stack on large files.
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      setXlsxBase64(btoa(binary));
    } else {
      setFileKind('csv');
      setXlsxBase64('');
      const reader = new FileReader();
      reader.onload = event => {
        const content = event.target?.result as string;
        setCsvContent(content);
      };
      reader.readAsText(file);
    }
  }

  function handleClear() {
    setCsvContent('');
    setXlsxBase64('');
    setSelectedFileName('');
    setFileKind(null);
    onClearPreview();
    onClearResult();
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  function currentArgs(): ImportArgs | null {
    if (!fileKind) return null;
    return {
      fileKind,
      csvContent,
      xlsxBase64,
      options: {
        updateExisting,
        skuPrefix,
        defaultInventory,
        defaultStatus,
        trackInventory,
      },
    };
  }

  // Step 1: dry run. Nothing is saved until the merchant confirms the preview.
  async function handlePreviewClick() {
    const args = currentArgs();
    if (args) await onPreview(args);
  }

  async function handleConfirmClick() {
    const args = currentArgs();
    if (args) await onImport(args);
  }

  const previewDisabled =
    isPreviewing || isImporting || (fileKind === 'xlsx' ? !xlsxBase64 : !csvContent);
  const hasFile = fileKind === 'csv' ? Boolean(csvContent) : Boolean(xlsxBase64);

  return (
    <div className="space-y-6">
      {/* Instructions */}
      <div className="rounded-md border bg-info/5 p-6">
        <h3 className="font-semibold text-info-ink">{t('instructionsTitle')}</h3>
        <ol className="mt-3 list-decimal list-inside space-y-2 text-sm text-info-ink">
          <li>{t('step1')}</li>
          <li>{t('step2')}</li>
          <li>{t('step3')}</li>
          <li>{t('step4')}</li>
          <li>{t('step5')}</li>
          <li>{t('step6')}</li>
        </ol>
        <div className="mt-4">
          <Button variant="outline" size="sm" onClick={onDownloadTemplate}>
            <span className="inline-flex items-center gap-2">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
              {t('downloadTemplate')}
            </span>
          </Button>
        </div>
      </div>

      {/* File Upload */}
      <div className="rounded-md border bg-card p-6 shadow-sm">
        <h3 className="font-semibold text-foreground mb-4">{t('uploadTitle')}</h3>

        <div className="space-y-4">
          <div
            className="border-2 border-dashed rounded-lg p-8 text-center hover:border-primary transition cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={handleFileSelect}
              className="hidden"
            />
            <svg
              className="mx-auto h-12 w-12 text-muted-foreground"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <p className="mt-2 text-sm text-muted-foreground">
              {selectedFileName ? t('fileLoaded', { name: selectedFileName }) : t('uploadPrompt')}
            </p>
            {fileKind === 'csv' && csvContent && (
              <p className="mt-1 text-xs text-success-ink">
                {t('csvReady', {
                  count: csvContent.split('\n').filter(l => l.trim()).length - 1,
                })}
              </p>
            )}
            {fileKind === 'xlsx' && xlsxBase64 && (
              <p className="mt-1 text-xs text-success-ink">{t('xlsxReady')}</p>
            )}
          </div>

          {/* Options */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="updateExisting"
              checked={updateExisting}
              onChange={e => setUpdateExisting(e.target.checked)}
              className="h-4 w-4 rounded-md border-border text-primary focus:ring-primary"
            />
            <Label htmlFor="updateExisting" className="text-sm font-normal">
              {t('updateExisting')}
            </Label>
          </div>

          {fileKind === 'xlsx' && (
            <div className="rounded-lg border border-border bg-muted/40 p-4 space-y-3">
              <p className="text-xs text-muted-foreground">{t('xlsxOptionsHint')}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="skuPrefix" className="text-xs">
                    {t.rich('skuPrefixLabel', {
                      code: chunks => <code>{chunks}</code>,
                    })}
                  </Label>
                  <Input
                    id="skuPrefix"
                    value={skuPrefix}
                    onChange={e => setSkuPrefix(e.target.value)}
                    placeholder={t('skuPrefixPlaceholder')}
                    maxLength={16}
                  />
                </div>
                <div>
                  <Label htmlFor="defaultInventory" className="text-xs">
                    {t('defaultInventoryLabel')}
                  </Label>
                  <Input
                    id="defaultInventory"
                    type="number"
                    min={0}
                    value={defaultInventory}
                    onChange={e =>
                      setDefaultInventory(Math.max(0, parseInt(e.target.value, 10) || 0))
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="defaultStatus" className="text-xs">
                    {t('defaultStatusLabel')}
                  </Label>
                  <select
                    id="defaultStatus"
                    value={defaultStatus}
                    onChange={e => setDefaultStatus(e.target.value as DefaultStatus)}
                    className={`${FIELD_CLASSES} mt-2 block`}
                  >
                    <option value="active">{t('statusActive')}</option>
                    <option value="draft">{t('statusDraft')}</option>
                  </select>
                </div>
                <div className="flex items-end gap-2">
                  <input
                    type="checkbox"
                    id="trackInventory"
                    checked={trackInventory}
                    onChange={e => setTrackInventory(e.target.checked)}
                    className="h-4 w-4 rounded-md border-border text-primary focus:ring-primary"
                  />
                  <Label htmlFor="trackInventory" className="text-sm font-normal">
                    {t('trackInventory')}
                  </Label>
                </div>
              </div>
            </div>
          )}

          {/* Import Button */}
          <div className="flex gap-2">
            <Button onClick={handlePreviewClick} disabled={previewDisabled} className="flex-1">
              {isPreviewing || isImporting ? (
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
                  {isImporting ? t('importing') : t('previewing')}
                </span>
              ) : (
                <span className="inline-flex items-center gap-2">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                    />
                  </svg>
                  {t('previewButton')}
                </span>
              )}
            </Button>
            {hasFile && (
              <Button variant="outline" onClick={handleClear}>
                {t('clear')}
              </Button>
            )}
          </div>

          {previewError && (
            <p role="alert" className="text-sm text-destructive-ink">
              {previewError}
            </p>
          )}

          {isImporting && importProgress && importProgress.total > 0 && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
              {`${importProgress.processed}/${importProgress.total} (${importProgress.status})`}
            </div>
          )}
        </div>
      </div>

      {preview && !importResult && (
        <BulkImportPreview
          preview={preview}
          isImporting={isImporting}
          onConfirm={handleConfirmClick}
          onBack={onClearPreview}
        />
      )}

      {importResult && <BulkImportResults result={importResult} onViewProducts={onViewProducts} />}
    </div>
  );
}
