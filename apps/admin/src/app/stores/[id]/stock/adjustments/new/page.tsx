'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { AdminLayout } from '@/components/AdminLayout';
import { HelpTip } from '@/components/HelpTip';
import { DataTable, type DataTableColumn } from '@/components/mobile/DataTable';
import { useT } from '@/i18n/useT';
import { apiGet, apiPost } from '@/lib/api';
import { parseStockAdjustCsv, generateStockAdjustCsvTemplate } from '@ebda/shared';
import type { StockAdjustParseResult, StockAdjustParsedRow } from '@ebda/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProductOption {
  id: string;
  name: string;
  sku: string | null;
}

interface ProductsResponse {
  products: ProductOption[];
  meta: { total: number };
}

interface ItemDraft {
  productId: string;
  newQty: string;
}

interface AdjustmentCreated {
  id: string;
  adjustmentNumber: string;
  status: string;
}

interface CsvImportResult {
  adjustmentId: string;
  adjustmentNumber: string;
  posted: boolean;
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  errors?: Record<number, string[]>;
  /** True when the server answered a retry with the first import's result (#226). */
  replayed?: boolean;
}

/**
 * One idempotency key per loaded file (#226). A double-click or a network
 * retry re-sends the same key and the server replays the first import instead
 * of posting the stock and GL movement twice; loading a file (even the same
 * one again) mints a new key, so a deliberate re-import still works.
 */
function newImportKey(): string {
  return crypto.randomUUID();
}

type TabMode = 'manual' | 'csv';

// ─── Constants ────────────────────────────────────────────────────────────────

const ADJUSTMENT_TYPES = [
  'cycle_count',
  'damage',
  'theft',
  'loss',
  'write_off',
  'found',
  'return_to_supplier',
] as const;

const EMPTY_ITEM: ItemDraft = { productId: '', newQty: '' };

// ─── CSV Upload Component ─────────────────────────────────────────────────────

interface CsvUploadTabProps {
  storeId: string;
  onSuccess: () => void;
}

function CsvUploadTab({ storeId, onSuccess }: CsvUploadTabProps) {
  const tNew = useT('stock.adjustments.new');
  const t = useT('stock.adjustments');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [csvContent, setCsvContent] = useState('');
  const [selectedFileName, setSelectedFileName] = useState('');
  const [parseResult, setParseResult] = useState<StockAdjustParseResult | null>(null);
  const [type, setType] = useState<string>('cycle_count');
  const [reason, setReason] = useState('');
  const [reasonAr, setReasonAr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null);
  const [importKey, setImportKey] = useState(newImportKey);
  const [error, setError] = useState<string | null>(null);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFileName(file.name);
    setImportKey(newImportKey());
    setImportResult(null);
    setError(null);
    const reader = new FileReader();
    reader.onload = event => {
      const content = event.target?.result as string;
      setCsvContent(content);
      const result = parseStockAdjustCsv(content);
      setParseResult(result);
    };
    reader.readAsText(file);
  }

  function handleClear() {
    setCsvContent('');
    setSelectedFileName('');
    setParseResult(null);
    setImportKey(newImportKey());
    setImportResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function downloadTemplate() {
    const csv = generateStockAdjustCsvTemplate();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stock-adjustment-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleSubmit() {
    if (!csvContent || !parseResult?.hasValidRows) return;
    setError(null);
    setSubmitting(true);
    try {
      // apiPost already unwraps the `{ data }` envelope, so `data` IS the
      // CsvImportResult. Reading `data.data` (#202) was always undefined: a
      // successful import showed no result panel and invited a second click.
      const { data, error: apiError } = await apiPost<CsvImportResult>(
        `/api/v1/stores/${storeId}/stock-adjustments/csv-import`,
        {
          csvContent,
          type,
          reason: reason || undefined,
          reasonAr: reasonAr || undefined,
          postImmediately: true,
          idempotencyKey: importKey,
        }
      );
      if (apiError) {
        setError(apiError.message);
        return;
      }
      if (data) {
        setImportResult(data);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const validRowCount = parseResult
    ? parseResult.rows.filter(r => !parseResult.errors[r.rowNumber]).length
    : 0;
  const errorRowCount = parseResult ? Object.keys(parseResult.errors).length : 0;

  const previewColumns: DataTableColumn<StockAdjustParsedRow>[] = parseResult
    ? [
        {
          header: '#',
          hideOnMobile: true,
          cell: row => <span className="text-muted-foreground">{row.rowNumber}</span>,
        },
        {
          header: tNew('colSku'),
          primaryOnMobile: true,
          cell: row => <span className="font-mono">{row.sku ?? '—'}</span>,
        },
        {
          header: tNew('colBarcode'),
          cell: row => <span className="font-mono">{row.barcode ?? '—'}</span>,
        },
        {
          header: tNew('colNewQty'),
          alignEnd: true,
          cell: row => (
            <span className="font-mono">{row.newQuantity !== null ? row.newQuantity : '—'}</span>
          ),
        },
        {
          header: tNew('colDelta'),
          alignEnd: true,
          cell: row => (
            <span className="font-mono">
              {row.delta !== null ? (row.delta >= 0 ? `+${row.delta}` : row.delta) : '—'}
            </span>
          ),
        },
        {
          header: tNew('colReason'),
          hideOnMobile: true,
          cell: row => <span className="truncate max-w-[120px] block">{row.reason ?? '—'}</span>,
        },
        {
          header: tNew('colStatus'),
          mobileBadge: true,
          cell: row => {
            const rowErrors = parseResult.errors[row.rowNumber];
            const isError = Boolean(rowErrors?.length);
            return isError ? (
              <span className="text-destructive-ink font-medium" title={rowErrors?.join('; ')}>
                {tNew('csvStatusError')}
              </span>
            ) : (
              <span className="text-success-ink">{tNew('csvStatusOk')}</span>
            );
          },
        },
      ]
    : [];

  return (
    <div className="space-y-5">
      {/* Instructions card */}
      <div className="rounded-xl border bg-info/5 p-5">
        <h3 className="font-semibold text-info-ink text-sm">{tNew('csvHelpTitle')}</h3>
        <ol className="mt-2 list-decimal list-inside space-y-1 text-sm text-info-ink">
          <li>{tNew('csvHelpStep1')}</li>
          <li>{tNew.rich('csvHelpStep2', { b: chunks => <strong>{chunks}</strong> })}</li>
          <li>{tNew.rich('csvHelpStep3', { b: chunks => <strong>{chunks}</strong> })}</li>
          <li>{tNew('csvHelpStep4')}</li>
        </ol>
        <button
          type="button"
          onClick={downloadTemplate}
          className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 border border-info/40 rounded text-xs text-info-ink hover:bg-info/10"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
          {tNew('csvDownloadTemplate')}
        </button>
      </div>

      {/* Adjustment type */}
      <div className="space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{tNew('typeLabel')}</span>
          <HelpTip text={tNew('typeTip')} />
        </div>
        <select
          value={type}
          onChange={e => setType(e.target.value)}
          className="w-full max-w-xs border border-border rounded px-3 py-2 text-base sm:text-sm"
        >
          {ADJUSTMENT_TYPES.map(at => (
            <option key={at} value={at}>
              {t(`types.${at}`)}
            </option>
          ))}
        </select>
        {/* One-line explanation of the currently-selected type. */}
        <p className="text-xs text-muted-foreground mt-1">{t(`types.${type}_desc`)}</p>
      </div>

      {/* Reason */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="space-y-1">
          <span className="text-sm font-medium">{tNew('reasonLabel')}</span>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={2}
            className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm resize-none"
            placeholder={t('reasonEnPlaceholder')}
          />
        </label>
        <label className="space-y-1" dir="rtl">
          <span className="text-sm font-medium">{tNew('reasonArLabel')}</span>
          <textarea
            value={reasonAr}
            onChange={e => setReasonAr(e.target.value)}
            rows={2}
            dir="rtl"
            className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm resize-none"
            placeholder={t('reasonArPlaceholder')}
          />
        </label>
      </div>

      {/* File upload */}
      <div
        className="border-2 border-dashed rounded-xl p-8 text-center hover:border-primary transition cursor-pointer"
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={handleFileSelect}
          className="hidden"
        />
        <svg
          className="mx-auto h-10 w-10 text-muted-foreground"
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
          {selectedFileName ? (
            <span className="font-medium text-foreground">{selectedFileName}</span>
          ) : (
            tNew('csvDropzoneHint')
          )}
        </p>
        {parseResult && (
          <p className="mt-1 text-xs text-muted-foreground">
            {tNew('csvParsedTotal', { count: parseResult.totalRows })}{' '}
            <span className="text-success-ink">
              {tNew('csvParsedValid', { count: validRowCount })}
            </span>
            {errorRowCount > 0 && (
              <span className="text-destructive-ink">
                {tNew('csvParsedErrors', { count: errorRowCount })}
              </span>
            )}
          </p>
        )}
      </div>

      {/* Parse preview */}
      {parseResult && parseResult.rows.length > 0 && (
        <div className="space-y-2">
          <div className="px-1 text-xs font-medium text-muted-foreground">
            {tNew('csvPreviewHeading', { count: Math.min(parseResult.rows.length, 50) })}
            {parseResult.rows.length > 50 &&
              ` ${tNew('csvPreviewOfTotal', { total: parseResult.rows.length })}`}
          </div>
          <DataTable<StockAdjustParsedRow>
            ariaLabel={tNew('csvPreviewHeading', {
              count: Math.min(parseResult.rows.length, 50),
            })}
            columns={previewColumns}
            rows={parseResult.rows.slice(0, 50)}
            rowKey={row => String(row.rowNumber)}
          />
          {/* Row-level errors */}
          {errorRowCount > 0 && (
            <div className="rounded-xl border border-border p-3 bg-destructive/5">
              <p className="text-xs font-medium text-destructive-ink mb-1">
                {tNew('csvRowErrorsLabel')}
              </p>
              <ul className="text-xs text-destructive-ink space-y-0.5 max-h-36 overflow-y-auto">
                {Object.entries(parseResult.errors).map(([rn, msgs]) => (
                  <li key={rn}>
                    <span className="font-mono">{tNew('csvRowPrefix', { row: rn })}</span>{' '}
                    {(msgs as string[]).join('; ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Import result */}
      {importResult && (
        <div className="rounded-xl border border-border p-4 bg-muted/20 space-y-2">
          <p className="text-sm font-semibold text-foreground">
            {tNew('csvImportComplete', { number: importResult.adjustmentNumber })}
          </p>
          <ul className="text-sm space-y-1 text-muted-foreground">
            <li>
              {tNew('csvTotalRows')}{' '}
              <span className="text-foreground font-medium">{importResult.totalRows}</span>
            </li>
            <li>
              {tNew('csvImported')}{' '}
              <span className="text-success-ink font-medium">{importResult.importedRows}</span>
            </li>
            {importResult.skippedRows > 0 && (
              <li>
                {tNew('csvSkipped')}{' '}
                <span className="text-destructive-ink font-medium">{importResult.skippedRows}</span>
              </li>
            )}
            <li>
              {tNew('csvStatus')}{' '}
              <span className="font-medium">
                {importResult.posted ? tNew('csvStatusPosted') : tNew('csvStatusDraft')}
              </span>
            </li>
          </ul>
          {importResult.errors && Object.keys(importResult.errors).length > 0 && (
            <details className="text-xs text-destructive-ink">
              <summary className="cursor-pointer">{tNew('csvShowRowErrors')}</summary>
              <ul className="mt-1 space-y-0.5 pl-2">
                {Object.entries(importResult.errors).map(([rn, msgs]) => (
                  <li key={rn}>
                    {tNew('csvRowPrefix', { row: rn })} {(msgs as string[]).join('; ')}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button
            type="button"
            onClick={onSuccess}
            className="mt-1 px-4 py-2 bg-primary text-primary-foreground rounded text-sm"
          >
            {tNew('csvViewAllAdjustments')}
          </button>
        </div>
      )}

      {error && <div className="text-red-600 text-sm">{error}</div>}

      {/* Actions */}
      {!importResult && (
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !parseResult?.hasValidRows}
            className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm disabled:opacity-50"
          >
            {submitting ? tNew('csvImporting') : tNew('csvSubmit', { count: validRowCount })}
          </button>
          {selectedFileName && (
            <button
              type="button"
              onClick={handleClear}
              className="px-4 py-2 border border-border rounded text-sm"
            >
              {tNew('csvClear')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function NewStockAdjustmentPage() {
  const params = useParams();
  const storeId = params?.id as string;
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useT('stock.adjustments');
  const tNew = useT('stock.adjustments.new');
  const tc = useT('common');

  // Pre-fill from query params (linked from inventory page)
  const prefillProductId = searchParams?.get('productId') ?? '';
  const prefillNewQty = searchParams?.get('newQty') ?? '';

  // Tab state — default to CSV if no pre-fill
  const [activeTab, setActiveTab] = useState<TabMode>(prefillProductId ? 'manual' : 'csv');

  const [products, setProducts] = useState<ProductOption[]>([]);
  const [type, setType] = useState<string>('cycle_count');
  const [reason, setReason] = useState('');
  const [reasonAr, setReasonAr] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [items, setItems] = useState<ItemDraft[]>([
    prefillProductId ? { productId: prefillProductId, newQty: prefillNewQty } : { ...EMPTY_ITEM },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storeId) return;
    apiGet<ProductsResponse>(`/api/v1/stores/${storeId}/products?limit=200`).then(({ data }) => {
      if (data) setProducts(data.products ?? []);
    });
  }, [storeId]);

  function updateItem(i: number, patch: Partial<ItemDraft>) {
    setItems(cur => cur.map((item, idx) => (idx === i ? { ...item, ...patch } : item)));
  }

  function addItem() {
    setItems(cur => [...cur, { ...EMPTY_ITEM }]);
  }

  function removeItem(i: number) {
    setItems(cur => (cur.length <= 1 ? cur : cur.filter((_, idx) => idx !== i)));
  }

  const itemColumns: DataTableColumn<ItemDraft>[] = [
    {
      header: tNew('selectProduct'),
      primaryOnMobile: true,
      cell: (item, i) => (
        <select
          value={item.productId}
          onChange={e => updateItem(i, { productId: e.target.value })}
          className="w-full border border-border rounded px-2 py-1 text-base sm:text-sm"
        >
          <option value="">— {tNew('selectProduct')} —</option>
          {products.map(p => (
            <option key={p.id} value={p.id}>
              {p.sku ? `[${p.sku}] ` : ''}
              {p.name}
            </option>
          ))}
        </select>
      ),
    },
    {
      header: tNew('newQty'),
      alignEnd: true,
      className: 'w-36',
      cell: (item, i) => (
        <input
          type="number"
          min="0"
          step="1"
          value={item.newQty}
          onChange={e => updateItem(i, { newQty: e.target.value })}
          className="w-full border border-border rounded px-2 py-1 text-end font-mono text-base sm:text-sm"
        />
      ),
    },
    {
      header: '',
      alignEnd: true,
      mobileActions: true,
      className: 'w-12 text-center',
      cell: (_item, i) => (
        <button
          type="button"
          onClick={() => removeItem(i)}
          disabled={items.length <= 1}
          className="text-red-600 disabled:opacity-30 hover:underline text-xs max-sm:inline-flex max-sm:min-h-11 max-sm:items-center max-sm:px-2"
        >
          ✕
        </button>
      ),
    },
  ];

  async function submitDraft() {
    setError(null);
    const validItems = items.filter(it => it.productId && it.newQty !== '');
    if (validItems.length === 0) {
      setError('Add at least one product with a quantity.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        type,
        reason: reason || undefined,
        reasonAr: reasonAr || undefined,
        evidenceUrl: evidenceUrl || undefined,
        items: validItems.map(it => ({
          productId: it.productId,
          newQty: Math.max(0, parseInt(it.newQty) || 0),
        })),
      };
      const { error: apiError } = await apiPost<AdjustmentCreated>(
        `/api/v1/stores/${storeId}/stock-adjustments`,
        payload
      );
      if (apiError) {
        setError(apiError.message);
        return;
      }
      // invalidate App Router cache so the destination list re-fetches the saved row
      router.refresh();
      router.push(`/stores/${storeId}/stock/adjustments`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitPost() {
    setError(null);
    const validItems = items.filter(it => it.productId && it.newQty !== '');
    if (validItems.length === 0) {
      setError('Add at least one product with a quantity.');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        type,
        reason: reason || undefined,
        reasonAr: reasonAr || undefined,
        evidenceUrl: evidenceUrl || undefined,
        items: validItems.map(it => ({
          productId: it.productId,
          newQty: Math.max(0, parseInt(it.newQty) || 0),
        })),
      };
      const { data, error: createError } = await apiPost<AdjustmentCreated>(
        `/api/v1/stores/${storeId}/stock-adjustments`,
        payload
      );
      if (createError) {
        setError(createError.message);
        return;
      }
      if (!data?.id) {
        setError('Unexpected response from server.');
        return;
      }
      const { error: postError } = await apiPost(
        `/api/v1/stores/${storeId}/stock-adjustments/${data.id}/post`,
        {}
      );
      if (postError) {
        setError(`Created draft ${data.id} but posting failed: ${postError.message}`);
        return;
      }
      // invalidate App Router cache so the destination list re-fetches the saved row
      router.refresh();
      router.push(`/stores/${storeId}/stock/adjustments`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AdminLayout title={tNew('title')} subtitle={tNew('description')}>
      <div className="max-w-4xl space-y-5">
        {/* Tab switcher */}
        <div className="flex gap-1 rounded-lg border border-border bg-muted/30 p-1 w-fit">
          <button
            type="button"
            onClick={() => setActiveTab('csv')}
            className={`px-4 py-1.5 rounded text-sm font-medium transition ${
              activeTab === 'csv'
                ? 'bg-background shadow text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tNew('tabCsv')}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('manual')}
            className={`px-4 py-1.5 rounded text-sm font-medium transition ${
              activeTab === 'manual'
                ? 'bg-background shadow text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tNew('tabManual')}
          </button>
        </div>

        {/* CSV Import tab */}
        {activeTab === 'csv' && (
          <CsvUploadTab
            storeId={storeId}
            onSuccess={() => {
              // invalidate App Router cache so the destination list re-fetches the saved row
              router.refresh();
              router.push(`/stores/${storeId}/stock/adjustments`);
            }}
          />
        )}

        {/* Manual entry tab */}
        {activeTab === 'manual' && (
          <div className="space-y-5">
            {/* Type */}
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="text-sm font-medium">{tNew('typeLabel')}</span>
                <HelpTip text={tNew('typeTip')} />
              </div>
              <select
                value={type}
                onChange={e => setType(e.target.value)}
                className="w-full max-w-xs border border-border rounded px-3 py-2 text-base sm:text-sm"
              >
                {ADJUSTMENT_TYPES.map(at => (
                  <option key={at} value={at}>
                    {t(`types.${at}`)}
                  </option>
                ))}
              </select>
              {/* One-line explanation of the currently-selected type. */}
              <p className="text-xs text-muted-foreground mt-1">{t(`types.${type}_desc`)}</p>
            </div>

            {/* Reason + ReasonAr */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="space-y-1">
                <span className="text-sm font-medium">{tNew('reasonLabel')}</span>
                <textarea
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  rows={3}
                  className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm resize-none"
                  placeholder={t('reasonEnPlaceholder')}
                />
              </label>
              <label className="space-y-1" dir="rtl">
                <span className="text-sm font-medium">{tNew('reasonArLabel')}</span>
                <textarea
                  value={reasonAr}
                  onChange={e => setReasonAr(e.target.value)}
                  rows={3}
                  dir="rtl"
                  className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm resize-none"
                  placeholder={t('reasonArPlaceholder')}
                />
              </label>
            </div>

            {/* Evidence URL */}
            <label className="block space-y-1">
              <span className="text-sm font-medium">{tNew('evidenceLabel')}</span>
              <input
                type="url"
                value={evidenceUrl}
                onChange={e => setEvidenceUrl(e.target.value)}
                className="w-full border border-border rounded px-3 py-2 text-base sm:text-sm"
                placeholder="https://… (paste R2 upload URL)"
              />
            </label>

            {/* Items table */}
            <DataTable<ItemDraft>
              ariaLabel={tNew('itemsTableLabel')}
              columns={itemColumns}
              rows={items}
              rowKey={(_it, i) => String(i)}
            />

            {/* Add product row */}
            <div>
              <button
                type="button"
                onClick={addItem}
                className="px-3 py-1.5 border border-border rounded text-sm"
              >
                {tNew('addItem')}
              </button>
            </div>

            {error && <div className="text-red-600 text-sm">{error}</div>}

            {/* Submit buttons */}
            <div className="flex gap-2 flex-wrap">
              <button
                type="button"
                onClick={submitDraft}
                disabled={submitting}
                className="px-4 py-2 border border-border rounded text-sm disabled:opacity-50"
              >
                {submitting ? tc('saving') : tNew('submitDraft')}
              </button>
              <button
                type="button"
                onClick={submitPost}
                disabled={submitting}
                className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm disabled:opacity-50"
              >
                {submitting ? tc('saving') : tNew('submitPost')}
              </button>
              <button
                type="button"
                onClick={() => router.push(`/stores/${storeId}/stock/adjustments`)}
                className="px-4 py-2 border border-border rounded text-sm"
              >
                {tc('cancel')}
              </button>
            </div>

            <div className="flex items-start gap-1.5">
              <p className="text-xs text-muted-foreground">{tNew('irreversibleNote')}</p>
              <HelpTip text={tNew('glJournalTip')} />
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
